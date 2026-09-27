'use strict';

/**
 * Unit tests for src/utils/api-tokens.js (integration platform step 2).
 *
 * A token is a standing credential, so the properties under test are the
 * security ones: hashed at rest and never listed, whitelisted scopes with
 * till actions impossible, empty grants refused, revocation immediate,
 * resolution fail-closed, and the principal shaped exactly like a lean
 * user so the one authentication join point stays the only one.
 */

const tokens = require('../../../src/utils/api-tokens');

function fakeDb() {
  const rows = [];
  const matches = (row, q) =>
    Object.entries(q).every(([k, v]) => {
      if (v && typeof v === 'object' && v.$ne !== undefined)
        return String(row[k]) !== String(v.$ne);
      return String(row[k]) === String(v);
    });
  return {
    rows,
    collection: () => ({
      insertOne: async (doc) => {
        doc._id = 'id_' + rows.length;
        rows.push(doc);
        return { insertedId: doc._id };
      },
      findOne: async (q) => rows.find((r) => matches(r, q)) || null,
      find: () => ({
        sort: function () {
          return this;
        },
        toArray: async () => rows.slice(),
      }),
      updateOne: async (q, u) => {
        const { ObjectId } = require('mongodb');
        const row = rows.find((r) =>
          Object.entries(q).every(
            ([k, v]) => String(r[k]) === String(v instanceof ObjectId ? v : v)
          )
        );
        if (row && u.$set) Object.assign(row, u.$set);
        return { matchedCount: row ? 1 : 0 };
      },
      updateMany: async (q, u) => {
        let n = 0;
        for (const row of rows) {
          if (!matches(row, q)) continue;
          if (u.$set) Object.assign(row, u.$set);
          n += 1;
        }
        return { matchedCount: n, modifiedCount: n };
      },
    }),
  };
}

const CREATOR = { _id: 'admin1', license: 'lic1', branch_access: [{ branch_id: 'b1' }] };

describe('sanitizeScopes', () => {
  test('whitelists modules and perms; pos can never be granted', () => {
    const out = tokens.sanitizeScopes({
      sales: { read: true, write: true, delete: 'yes' },
      pos: { void_sale: true },
      nonsense: { read: true },
      item: { read: true },
    });
    expect(out.sales).toEqual({ read: true, write: true, delete: false });
    expect(out.item).toEqual({ read: true, write: false, delete: false });
    expect(out.pos).toBeUndefined();
    expect(out.nonsense).toBeUndefined();
  });

  test('a grantless scope set is refused', () => {
    expect(tokens.sanitizeScopes({ sales: { read: false } })).toBe(null);
    expect(tokens.sanitizeScopes({})).toBe(null);
    expect(tokens.sanitizeScopes(null)).toBe(null);
  });
});

describe('createToken / listTokens', () => {
  test('plaintext returned once, only the hash stored, list never exposes it', async () => {
    const db = fakeDb();
    const r = await tokens.createToken(db, {
      name: 'Accounting sync',
      scopes: { sales: { read: true } },
      creator: CREATOR,
    });
    expect(r.ok).toBe(true);
    expect(r.token.startsWith('posnic_')).toBe(true);
    expect(db.rows[0].token_hash).toBe(tokens.hashToken(r.token));
    expect(db.rows[0].token).toBeUndefined();
    expect(db.rows[0].license).toBe('lic1');
    expect(db.rows[0].usertype).toBe('api');
  });

  test('no shop context refuses the mint', async () => {
    const db = fakeDb();
    const r = await tokens.createToken(db, {
      name: 'x',
      scopes: { sales: { read: true } },
      creator: { _id: 'a' },
    });
    expect(r.ok).toBe(false);
  });
});

describe('resolveScopedToken', () => {
  test('a valid token resolves to a lean-user-shaped principal with ONLY its scopes', async () => {
    const db = fakeDb();
    const minted = await tokens.createToken(db, {
      name: 'Sync',
      scopes: { sales: { read: true }, item: { read: true, write: true } },
      creator: CREATOR,
    });
    const principal = await tokens.resolveScopedToken(db, minted.token);
    expect(principal).not.toBe(null);
    expect(principal.usertype).toBe('api');
    expect(principal.api_token).toBe(true);
    expect(principal.license).toBe('lic1');
    expect(principal.branch_access).toEqual([{ branch_id: 'b1' }]);
    expect(principal.access.item.write).toBe(true);
    expect(principal.access.sales.write).toBe(false);
    expect(principal.access.pos).toBeUndefined();
  });

  test('wrong token, wrong prefix, and revoked all fail closed', async () => {
    const db = fakeDb();
    const minted = await tokens.createToken(db, {
      name: 'Sync',
      scopes: { sales: { read: true } },
      creator: CREATOR,
    });
    expect(await tokens.resolveScopedToken(db, 'posnic_' + 'f'.repeat(48))).toBe(null);
    expect(await tokens.resolveScopedToken(db, 'not-a-token')).toBe(null);

    db.rows[0].active = false;
    expect(await tokens.resolveScopedToken(db, minted.token)).toBe(null);
  });

  test('resolution stamps last_used_at, throttled', async () => {
    const db = fakeDb();
    const minted = await tokens.createToken(db, {
      name: 'Sync',
      scopes: { sales: { read: true } },
      creator: CREATOR,
    });
    await tokens.resolveScopedToken(db, minted.token);
    await new Promise((r) => setTimeout(r, 10));
    expect(db.rows[0].last_used_at).not.toBe(null);
  });
});

/*
 * A token the shop was SHIPPED with, rather than one a person clicked for.
 *
 * The security properties are the same ones, plus two that only matter because
 * the value is chosen by whoever builds the installer: the value must be one the
 * resolver will actually accept, and issuing a replacement must kill the old one.
 */
describe('provisionToken', () => {
  const VALUE = 'posnic_' + 'a'.repeat(48);
  /* Real ids are ObjectIds, and `provisionToken` insists on a licence it could
     actually store - a placeholder string is refused, which is the point. */
  const LICENSE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  const BRANCH = 'b1b2c3d4e5f6a1b2c3d4e5f6';
  const args = (over = {}) => ({
    plaintext: VALUE,
    name: 'ShuttleZone website',
    scopes: { item: { read: true }, category: { read: true } },
    license: LICENSE,
    branchAccess: [{ branch_id: BRANCH }],
    source: 'shuttlezone-installer',
    ...over,
  });

  test('stores only the hash, with the scopes and branch the shop has', async () => {
    const db = fakeDb();
    const r = await tokens.provisionToken(db, args());
    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].token_hash).toBe(tokens.hashToken(VALUE));
    expect(db.rows[0].token).toBeUndefined();
    expect(db.rows[0].usertype).toBe('api');
    expect(db.rows[0].active).toBe(true);
    expect(db.rows[0].source).toBe('shuttlezone-installer');
    expect(db.rows[0].access.item).toEqual({ read: true, write: false, delete: false });
    expect(db.rows[0].access.category.read).toBe(true);
    /* Write is never granted to a website: a shop's stock belongs to the shop. */
    expect(db.rows[0].access.item.write).toBe(false);
  });

  test('the provisioned value actually authenticates', async () => {
    const db = fakeDb();
    await tokens.provisionToken(db, args());
    const principal = await tokens.resolveScopedToken(db, VALUE);
    expect(principal).not.toBe(null);
    expect(principal.api_token).toBe(true);
    expect(String(principal.license)).toBe(LICENSE);
    expect(principal.branch_access).toEqual([{ branch_id: BRANCH }]);
  });

  test('provisioning the same value twice is one read, not a second row', async () => {
    const db = fakeDb();
    await tokens.provisionToken(db, args());
    const again = await tokens.provisionToken(db, args());
    expect(again.unchanged).toBe(true);
    expect(db.rows).toHaveLength(1);
  });

  /*
   * Re-pairing: replace AND revoke. The reason this matters is the leak case -
   * an installer that went astray must stop pulling the catalogue the moment a
   * replacement is issued, or the rotation bought nothing.
   */
  test('a rebuilt installer replaces the token and revokes the old one', async () => {
    const db = fakeDb();
    await tokens.provisionToken(db, args());
    const replacement = 'posnic_' + 'b'.repeat(48);
    const r = await tokens.provisionToken(db, args({ plaintext: replacement }));

    expect(r.created).toBe(true);
    expect(r.revoked).toBe(1);
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0].active).toBe(false);
    expect(db.rows[0].revokedReason).toBe('replaced');
    expect(db.rows[1].active).toBe(true);

    expect(await tokens.resolveScopedToken(db, VALUE)).toBe(null);
    expect(await tokens.resolveScopedToken(db, replacement)).not.toBe(null);
  });

  test('a restored database holding two live rows for the channel has both revoked', async () => {
    const db = fakeDb();
    await tokens.provisionToken(db, args());
    await tokens.provisionToken(db, args({ plaintext: 'posnic_' + 'c'.repeat(48) }));
    /* A restore put the superseded row back to live - the state that makes
       "revoke the one I read" insufficient. */
    db.rows[0].active = true;
    expect(db.rows.filter((r) => r.active)).toHaveLength(2);
    const third = await tokens.provisionToken(db, args({ plaintext: 'posnic_' + 'd'.repeat(48) }));
    expect(third.revoked).toBe(2);
    expect(db.rows.filter((r) => r.active)).toHaveLength(1);
  });

  test('a different channel does not disturb this one', async () => {
    const db = fakeDb();
    await tokens.provisionToken(db, args());
    await tokens.provisionToken(db, args({ source: 'other-channel' }));
    expect(db.rows.filter((r) => r.active)).toHaveLength(2);
  });

  /*
   * Anything the resolver would refuse must be refused here instead, while the
   * build can still be fixed. A stored-but-unusable token would look correct on
   * the Integrations screen and 401 at the website forever.
   */
  test('a value the resolver would not accept is refused at the door', async () => {
    const db = fakeDb();
    expect((await tokens.provisionToken(db, args({ plaintext: 'secret123' }))).reason).toMatch(
      /posnic_/
    );
    expect((await tokens.provisionToken(db, args({ plaintext: '' }))).ok).toBe(false);
    expect((await tokens.provisionToken(db, args({ plaintext: 'posnic_short' }))).ok).toBe(false);
    expect(db.rows).toHaveLength(0);
  });

  test('no shop context, no scope, or no database refuses the provision', async () => {
    const db = fakeDb();
    expect((await tokens.provisionToken(db, args({ license: null }))).ok).toBe(false);
    expect((await tokens.provisionToken(db, args({ license: 'not-an-objectid' }))).ok).toBe(false);
    expect((await tokens.provisionToken(db, args({ scopes: { item: { read: false } } }))).ok).toBe(
      false
    );
    expect((await tokens.provisionToken(null, args())).reason).toBe('no_database');
    expect(db.rows).toHaveLength(0);
  });
});
