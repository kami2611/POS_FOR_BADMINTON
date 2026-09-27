'use strict';

/**
 * Unit tests for src/services/shuttlezone-pairing.service.js.
 *
 * The token half of a paired installer. What must hold: a stock build does
 * nothing at all; a paired build mints exactly one usable token, scoped to what
 * the website actually calls; the licence and branch come from the shop rather
 * than from the build; a shop whose wizard has not run yet is a quiet no-op
 * that heals on a later pass; and a rebuilt installer replaces the credential
 * AND revokes the one it replaces.
 *
 * The webhooks module is deliberately NOT mocked: `pairingConfig` composing the
 * real `provisionedConfig` with the token is the thing under test.
 */

const tokens = require('../../../src/utils/api-tokens');
const pairing = require('../../../src/services/shuttlezone-pairing.service');

/* Minimal in-memory mongo-ish fake, matching the shape the module uses. */
function fakeDb({ branches = [], tokens: seedTokens = [] } = {}) {
  const stores = new Map([
    ['branches', branches.slice()],
    ['api_tokens', seedTokens.slice()],
  ]);
  const coll = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const rows = stores.get(name);
    const matches = (row, q) =>
      Object.entries(q).every(([k, v]) => {
        if (v && typeof v === 'object' && v.$ne !== undefined) {
          return String(row[k]) !== String(v.$ne);
        }
        return String(row[k]) === String(v);
      });
    return {
      insertOne: async (doc) => {
        doc._id = 'id_' + rows.length;
        rows.push(doc);
        return { insertedId: doc._id };
      },
      findOne: async (q) => rows.find((r) => matches(r, q)) || null,
      updateOne: async (q, u) => {
        const row = rows.find((r) => matches(r, q));
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
    };
  };
  return { stores, collection: coll, apiTokenRows: () => stores.get('api_tokens') };
}

/* A licence and a branch, shaped the way the shop actually stores them:
   ObjectIds. A placeholder string would be refused by provisionToken, which is
   correct behaviour and not what these tests are about. */
const LICENSE = 'a1b2c3d4e5f6a1b2c3d4e5f6';
const BRANCH = 'b1b2c3d4e5f6a1b2c3d4e5f6';
const SHOP = [{ _id: BRANCH, license: LICENSE, branch_name: 'Example Shop' }];
const TOKEN = 'posnic_' + 'a'.repeat(48);
const ENV = { SHUTTLEZONE_API_TOKEN: TOKEN };
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

describe('pairingConfig', () => {
  test('is the one place that knows the whole set of pairing values', () => {
    const cfg = pairing.pairingConfig({
      SHUTTLEZONE_WEBHOOK_URL: 'https://shuttlezone.app/api/pos/webhook/abc',
      SHUTTLEZONE_WEBHOOK_SECRET: 's3cret',
      SHUTTLEZONE_WEBHOOK_EVENTS: 'items,categories',
      SHUTTLEZONE_API_TOKEN: TOKEN,
    });
    expect(cfg.url).toBe('https://shuttlezone.app/api/pos/webhook/abc');
    expect(cfg.secret).toBe('s3cret');
    expect(cfg.events).toEqual(['items', 'categories']);
    expect(cfg.apiToken).toBe(TOKEN);
  });

  test('an unpaired build is empty, not wrong', () => {
    const cfg = pairing.pairingConfig({});
    expect(cfg.apiToken).toBe('');
    expect(cfg.url).toBe('');
  });
});

describe('ensureProvisionedToken', () => {
  test('a stock build provisions nothing, and says so without noise', async () => {
    const db = fakeDb({ branches: SHOP });
    const r = await pairing.ensureProvisionedToken(db, { env: {}, log: quiet });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_configured');
    expect(db.apiTokenRows()).toHaveLength(0);
  });

  test('a paired shop gets one token, scoped and bound to its own licence and branch', async () => {
    const db = fakeDb({ branches: SHOP });
    const r = await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });

    expect(r.ok).toBe(true);
    expect(r.created).toBe(true);
    expect(db.apiTokenRows()).toHaveLength(1);

    const row = db.apiTokenRows()[0];
    expect(row.token_hash).toBe(tokens.hashToken(TOKEN));
    expect(String(row.license)).toBe(LICENSE);
    expect(row.branch_access).toEqual([{ branch_id: BRANCH, branch_name: 'Example Shop' }]);
    expect(row.source).toBe('shuttlezone-installer');
    expect(row.active).toBe(true);
  });

  /* The token must be usable, not merely stored: the same hash and prefix the
     resolver checks, which is why it is round-tripped here rather than asserted. */
  test('the provisioned token resolves through the real resolver', async () => {
    const db = fakeDb({ branches: SHOP });
    await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    const principal = await tokens.resolveScopedToken(db, TOKEN);
    expect(principal).not.toBe(null);
    expect(String(principal.license)).toBe(LICENSE);
    expect(principal.branch_access[0].branch_id).toBe(BRANCH);
  });

  test('exactly the scopes the website calls with, and no more', async () => {
    const db = fakeDb({ branches: SHOP });
    await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    const access = db.apiTokenRows()[0].access;
    expect(Object.keys(access).sort()).toEqual(['category', 'item']);
    expect(access.category).toEqual({ read: true, write: false, delete: false });
    expect(access.item).toEqual({ read: true, write: false, delete: false });
  });

  test('called every minute it is a read, not a second token', async () => {
    const db = fakeDb({ branches: SHOP });
    await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    const again = await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    expect(again.unchanged).toBe(true);
    expect(db.apiTokenRows()).toHaveLength(1);
  });

  /*
   * The wizard-not-run case is the whole reason this lives on a timer instead
   * of at the end of the install: there is nothing to hang it off yet, and it
   * must not be an error.
   */
  test('a shop with no branch yet is a quiet no-op that heals later', async () => {
    const db = fakeDb({ branches: [] });
    const before = await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    expect(before.ok).toBe(false);
    expect(before.reason).toBe('no_shop');
    expect(db.apiTokenRows()).toHaveLength(0);

    /* The wizard runs; the next pass finds the shop and provisions. */
    db.stores.set('branches', SHOP);
    const after = await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    expect(after.ok).toBe(true);
    expect(db.apiTokenRows()).toHaveLength(1);
  });

  test('a branch row without a licence is not a shop yet', async () => {
    const db = fakeDb({ branches: [{ _id: BRANCH, branch_name: 'Half-built' }] });
    const r = await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });
    expect(r.reason).toBe('no_shop');
    expect(db.apiTokenRows()).toHaveLength(0);
  });

  test('no database is refused rather than thrown', async () => {
    const r = await pairing.ensureProvisionedToken(null, { env: ENV, log: quiet });
    expect(r.reason).toBe('no_database');
  });

  /* Re-pairing: the rebuilt installer's value wins, and the leaked one dies. */
  test('a rebuilt installer replaces the token and revokes its predecessor', async () => {
    const db = fakeDb({ branches: SHOP });
    await pairing.ensureProvisionedToken(db, { env: ENV, log: quiet });

    const rotated = 'posnic_' + 'b'.repeat(48);
    const r = await pairing.ensureProvisionedToken(db, {
      env: { SHUTTLEZONE_API_TOKEN: rotated },
      log: quiet,
    });

    expect(r.created).toBe(true);
    expect(r.revoked).toBe(1);
    expect(db.apiTokenRows()).toHaveLength(2);
    expect(await tokens.resolveScopedToken(db, TOKEN)).toBe(null);
    expect(await tokens.resolveScopedToken(db, rotated)).not.toBe(null);
  });

  test('a malformed value in the seed is reported, not stored', async () => {
    const db = fakeDb({ branches: SHOP });
    const r = await pairing.ensureProvisionedToken(db, {
      env: { SHUTTLEZONE_API_TOKEN: 'not-prefixed' },
      log: quiet,
    });
    expect(r.ok).toBe(false);
    expect(db.apiTokenRows()).toHaveLength(0);
  });
});
