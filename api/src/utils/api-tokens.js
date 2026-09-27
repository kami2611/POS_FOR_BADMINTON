'use strict';
/*
 * Scoped API tokens (INTEGRATION_PLATFORM_ARCHITECTURE step 2).
 *
 * A token is a headless caller with EXACTLY the permissions it was minted
 * with - the same ACL matrix shape the whole API already enforces, so
 * checkPermission and every route gate work unchanged. Least privilege by
 * construction: scopes are whitelisted per module, till actions
 * (access.pos) can never be granted to a token, and the plaintext is shown
 * once at mint and stored only as a SHA-256 hash.
 *
 * The token principal carries the minting admin's license and branch
 * access, so tenant context resolves exactly as it does for a signed-in
 * user - one authentication join point (continueWithTenant), audited once.
 */

const crypto = require('crypto');

const COLLECTION = 'api_tokens';
const PREFIX = 'posnic_';

/* The ACL modules a token may be scoped to. Deliberately NOT including
   pos (till actions), plan, or setting - integrations read and write
   business records; they do not approve refunds or rewire the shop. */
const MODULES = Object.freeze([
  'sales',
  'item',
  'customer',
  'supplier',
  'category',
  'receiving',
  'expense',
  'branch',
  'user',
  'report',
  'dashboard',
]);
const PERMS = Object.freeze(['read', 'write', 'delete']);

function generateToken() {
  return PREFIX + crypto.randomBytes(24).toString('hex');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenHint(token) {
  return String(token).slice(0, PREFIX.length + 6) + '…';
}

/**
 * Whitelist in, matrix out. Unknown modules and unknown permissions are
 * dropped silently; a scope set that grants nothing is refused - a token
 * that can do nothing is a mistake, not a credential.
 */
function sanitizeScopes(input) {
  const out = {};
  let granted = 0;
  if (input && typeof input === 'object') {
    for (const module of MODULES) {
      const src = input[module];
      if (!src || typeof src !== 'object') continue;
      const entry = {};
      for (const perm of PERMS) {
        entry[perm] = src[perm] === true;
        if (entry[perm]) granted++;
      }
      out[module] = entry;
    }
  }
  return granted > 0 ? out : null;
}

/** Mint. Returns the plaintext exactly once; the store keeps the hash. */
async function createToken(db, { name, scopes, creator }) {
  const clean = sanitizeScopes(scopes);
  if (!clean) return { ok: false, reason: 'scopes must grant at least one permission' };
  if (!creator || !creator.license) return { ok: false, reason: 'no shop context' };

  const token = generateToken();
  const row = {
    name: String(name || 'API token').slice(0, 80),
    token_hash: hashToken(token),
    token_hint: tokenHint(token),
    access: clean,
    usertype: 'api',
    license: creator.license,
    branch_access: creator.branch_access || [],
    created_by: String(creator._id || ''),
    createdAt: new Date(),
    last_used_at: null,
    active: true,
  };
  const r = await db.collection(COLLECTION).insertOne(row);
  return { ok: true, id: r.insertedId, token, hint: row.token_hint };
}

/*
 * A token the SHOP was shipped with, rather than one a person clicked for.
 *
 * `createToken` above always invents its own plaintext, which is right for the
 * Integrations screen and useless for an installer: the website has to know the
 * value before the shop exists, and the shop has to accept the value the
 * website already holds. So this takes the plaintext as an argument.
 *
 * Everything else is deliberately identical - the same hash, the same scope
 * whitelist, the same ACL matrix shape - so a provisioned token is not a
 * second kind of credential with its own rules. It is an ordinary token that
 * happened to be minted at build time.
 *
 * RE-PAIRING REPLACES, AND REVOKES. `source` identifies the provisioning
 * channel, so there is at most one live token per channel and per shop. When
 * the same channel provisions a DIFFERENT value - a rebuilt installer with a
 * rotated secret - the new row is inserted first and every other live row for
 * that channel is then revoked. Insert-before-revoke, not the reverse: a
 * failure between the two steps leaves a shop with a working token rather than
 * with none. The old value stops authenticating the moment the revoke lands,
 * which is the point - a leaked installer must not keep pulling the catalogue
 * after you have issued a replacement.
 *
 * Idempotent by design: provisioning the same value twice is a read and
 * nothing else. That matters because the caller is a timer, not a person.
 */
const MIN_PROVISIONED_CHARS = 32;

async function provisionToken(
  db,
  {
    plaintext,
    name,
    scopes,
    license,
    branchAccess = [],
    createdBy = '',
    source = 'provisioned',
  } = {}
) {
  if (!db) return { ok: false, reason: 'no_database' };

  const value = String(plaintext || '').trim();
  if (!value) return { ok: false, reason: 'no token value' };
  /* `resolveScopedToken` only ever looks at prefixed values, so an unprefixed
     one would be stored, listed, and silently unable to authenticate. Refuse
     it here where the build can still be fixed. */
  if (!value.startsWith(PREFIX))
    return { ok: false, reason: `the token must start with ${PREFIX}` };
  if (value.length < PREFIX.length + MIN_PROVISIONED_CHARS) {
    return {
      ok: false,
      reason: `the token is shorter than ${PREFIX.length + MIN_PROVISIONED_CHARS} characters`,
    };
  }

  const clean = sanitizeScopes(scopes);
  if (!clean) return { ok: false, reason: 'scopes must grant at least one permission' };

  const { ObjectId } = require('mongodb');
  const licenseId =
    license instanceof ObjectId
      ? license
      : ObjectId.isValid(String(license || ''))
        ? new ObjectId(String(license))
        : null;
  if (!licenseId) return { ok: false, reason: 'no shop context' };

  const access = (Array.isArray(branchAccess) ? branchAccess : []).filter((b) => b && b.branch_id);

  const col = db.collection(COLLECTION);
  const hash = hashToken(value);
  const hint = tokenHint(value);

  const current = await col.findOne(
    { source, active: true },
    { projection: { _id: 1, token_hash: 1 } }
  );
  if (current && current.token_hash === hash) {
    return { ok: true, unchanged: true, id: current._id, hint, revoked: 0 };
  }

  const inserted = await col.insertOne({
    name: String(name || 'Provisioned token').slice(0, 80),
    token_hash: hash,
    token_hint: hint,
    access: clean,
    usertype: 'api',
    license: licenseId,
    branch_access: access,
    created_by: String(createdBy || ''),
    createdAt: new Date(),
    last_used_at: null,
    active: true,
    source,
  });

  /* Revoke every other live row for this channel at once, not just the one we
     read: a database that has been restored or hand-edited can hold more than
     one, and leaving any of them live defeats the rotation. */
  const revoked = await col.updateMany(
    { source, active: true, _id: { $ne: inserted.insertedId } },
    { $set: { active: false, revokedAt: new Date(), revokedReason: 'replaced' } }
  );

  return {
    ok: true,
    created: true,
    id: inserted.insertedId,
    hint,
    revoked: revoked.modifiedCount || 0,
  };
}

async function listTokens(db) {
  return db
    .collection(COLLECTION)
    .find({}, { projection: { token_hash: 0 } })
    .sort({ createdAt: 1 })
    .toArray();
}

async function revokeToken(db, id) {
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(String(id))) return { ok: false };
  const r = await db
    .collection(COLLECTION)
    .updateOne(
      { _id: new ObjectId(String(id)) },
      { $set: { active: false, revokedAt: new Date() } }
    );
  return { ok: r.matchedCount === 1 };
}

const LAST_USED_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Bearer token -> principal, or null. Fail closed: anything short of an
 * active row with a matching hash is null, and the caller must 401.
 * The principal is shaped like a lean user document so continueWithTenant
 * and every downstream consumer treat it as any other authenticated caller.
 */
async function resolveScopedToken(db, token) {
  if (!db || typeof token !== 'string' || !token.startsWith(PREFIX)) return null;
  const row = await db
    .collection(COLLECTION)
    .findOne({ token_hash: hashToken(token), active: true });
  if (!row) return null;

  const now = Date.now();
  if (!row.last_used_at || now - new Date(row.last_used_at).getTime() > LAST_USED_THROTTLE_MS) {
    db.collection(COLLECTION)
      .updateOne({ _id: row._id }, { $set: { last_used_at: new Date() } })
      .catch(() => {});
  }

  return {
    _id: row._id,
    id: String(row._id),
    username: 'token:' + row.name,
    usertype: 'api',
    access: row.access,
    license: row.license,
    branch_access: row.branch_access || [],
    active: 'yes',
    api_token: true,
  };
}

module.exports = {
  COLLECTION,
  PREFIX,
  MODULES,
  PERMS,
  MIN_PROVISIONED_CHARS,
  generateToken,
  hashToken,
  tokenHint,
  sanitizeScopes,
  createToken,
  provisionToken,
  listTokens,
  revokeToken,
  resolveScopedToken,
};
