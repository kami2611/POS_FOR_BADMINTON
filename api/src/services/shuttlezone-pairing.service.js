'use strict';

/*
 * Pairing this shop with its website, from the till's point of view.
 *
 * A paired installer carries everything needed to talk to one website, and
 * there are two halves to that conversation:
 *
 *   outbound - a webhook subscription, so the shop tells the website that
 *              something changed      (api/src/realtime/webhooks.js)
 *   inbound  - a scoped API token, so the website can read the catalogue
 *              (this file)
 *
 * Both are decided by the operator BEFORE the shop exists, and both arrive the
 * same way: values the Electron shell reads out of the pairing seed and hands
 * to this process as environment. `pairingConfig` below is the one place that
 * knows the whole set, and it delegates the webhook trio to the module that
 * already owned it rather than parsing those names a second time.
 *
 * The webhook half is provisioned by `webhooks.ensureProvisionedSubscription`;
 * the token half is here, and the two are called from the same place (the
 * scheduler's tick) for the same reason. Provisioning a token needs a licence
 * and a branch, and neither exists until the shopkeeper has been through the
 * first-run wizard - which is why this cannot be baked into the build and
 * cannot run at build time. Running it on a timer instead of hanging it off
 * the end of the wizard means there is no ordering to get wrong: before the
 * wizard it is a no-op, and after a restore or a hand-edited database it heals
 * itself on the next pass.
 *
 * Nothing here is fatal. A till that cannot provision a token is still a till.
 */

const apiTokens = require('../utils/api-tokens');
const webhooks = require('../realtime/webhooks');

/* Identifies the provisioning channel. There is at most one live token per
   channel per shop, which is what makes "rebuilt installer" replace-and-revoke
   rather than "now there are two valid credentials". */
const SOURCE = 'shuttlezone-installer';
const TOKEN_NAME = 'ShuttleZone website';

/*
 * Least privilege, and derived from what the website actually calls rather than
 * from what looks tidy.
 *
 *   GET /api/v1/items      -> acl `item`
 *   GET /api/v1/taxonomy   -> `category:read`
 *   GET /api/v1/shop       -> no scope of its own (tenant context only)
 *   GET /uploads/...       -> `express.static`, no authentication at all
 *
 * So read on two modules is the whole requirement. Write is not granted
 * because the website never writes to the till: a shop's stock belongs to the
 * shop. Anything wider would be a credential that could do more than the
 * feature it exists for, sitting in an installer on a shopkeeper's desk.
 */
const SCOPES = Object.freeze({
  item: { read: true, write: false, delete: false },
  category: { read: true, write: false, delete: false },
});

/**
 * Every value a paired build carries, in one object.
 *
 * @param {object} [env]
 * @returns {{url: string, secret: string, events: string[], apiToken: string}}
 */
function pairingConfig(env = process.env) {
  const hook = webhooks.provisionedConfig(env);
  return {
    url: hook.url,
    secret: hook.secret,
    events: hook.events,
    apiToken: String((env && env.SHUTTLEZONE_API_TOKEN) || '').trim(),
  };
}

/**
 * Make sure this shop has the token its website was built to use.
 *
 * Idempotent: the same value twice is one read. A different value replaces the
 * old token and revokes it (see `provisionToken`), which is what makes a
 * rebuilt installer safe to send after one has been lost.
 *
 * @param {object} db  the shop's database
 * @param {{env?: object, log?: Console}} [opts]
 * @returns {Promise<{ok: boolean, reason?: string, created?: boolean, unchanged?: boolean, hint?: string, revoked?: number}>}
 */
async function ensureProvisionedToken(db, { env = process.env, log = console } = {}) {
  if (!db) return { ok: false, reason: 'no_database' };

  const cfg = pairingConfig(env);
  /* A stock build: an ordinary Posnic with no website of its own. Silent, and
     deliberately so - this is the normal case for almost every installation. */
  if (!cfg.apiToken) return { ok: false, reason: 'not_configured' };

  /*
   * The shop in context. Read from `branches` rather than from settings or a
   * user row because that is the collection the authentication path validates
   * a token's branch against: what we write here is what `attachTenantContext`
   * will later require to exist, so taking it from the same place means the
   * two cannot disagree.
   *
   * No branch yet means the wizard has not run. Not an error - the next pass
   * will find it.
   */
  const branch = await db
    .collection('branches')
    .findOne(
      {},
      { projection: { _id: 1, license: 1, branch_name: 1 }, sort: { created_date: 1, _id: 1 } }
    );
  if (!branch || !branch.license) return { ok: false, reason: 'no_shop' };

  const result = await apiTokens.provisionToken(db, {
    plaintext: cfg.apiToken,
    name: TOKEN_NAME,
    scopes: SCOPES,
    license: branch.license,
    branchAccess: [{ branch_id: branch._id, branch_name: branch.branch_name || '' }],
    createdBy: 'installer',
    source: SOURCE,
  });

  if (result.ok && result.created) {
    log.log(
      `[shuttlezone] website token provisioned (${result.hint})` +
        (result.revoked ? `; ${result.revoked} previous token revoked` : '')
    );
  } else if (!result.ok) {
    /* `no_shop` is the wizard not having run; `not_configured` cannot reach
       here. Anything else is a real misconfiguration worth a log line. */
    if (result.reason !== 'no_shop') {
      log.warn('[shuttlezone] could not provision the website token:', result.reason);
    }
  }

  return result;
}

module.exports = {
  SOURCE,
  TOKEN_NAME,
  SCOPES,
  pairingConfig,
  ensureProvisionedToken,
};
