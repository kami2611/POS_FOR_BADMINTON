'use strict';

/**
 * The seeded two-level category tree (ShuttleZone integration ask I4.7), and
 * the invariants of the file it is seeded from.
 *
 * Two things are being protected here. The first is that the shop's pickers
 * actually get both levels, linked, from the file ShuttleZone generates. The
 * second is that the FILE ITSELF is safe to seed: this is the build-side half
 * of a contract whose other half lives in ShuttleZone's repository, and a
 * broken tree (a duplicate leaf, a name the category validator rejects) would
 * otherwise be discovered by a shopkeeper, halfway through installing.
 */

jest.mock('../../../src/repositories/install.repository', () =>
  jest.fn().mockImplementation(() => ({ getCollection: jest.fn() }))
);

const path = require('path');
const fs = require('fs');
const InstallService = require('../../../src/services/install.service');
const {
  VALIDATION_PATTERNS,
  FIELD_LIMITS,
} = require('../../../src/constants/categories.constants');

const TREE_FILE = path.join(__dirname, '../../../src/json/pos-taxonomy.json');
const TREE = JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));

/* A categories collection with just what the seeder touches. */
function fakeCategories(rows = []) {
  const store = rows.slice();
  const matches = (row, q) =>
    Object.entries(q).every(([k, v]) => String(row[k] || '') === String(v || ''));
  return {
    rows: store,
    find: (q) => ({ toArray: async () => store.filter((r) => matches(r, q)) }),
    findOne: async (q) => store.find((r) => matches(r, q)) || null,
    insertOne: async (doc) => {
      const _id = `id_${store.length + 1}_${String(doc.name).slice(0, 8)}`;
      store.push({ ...doc, _id });
      return { insertedId: _id };
    },
  };
}

const params = (licenseId = 'lic_1') => ({
  branchId: 'br_1',
  branchName: 'Main Branch',
  userId: 'u_1',
  username: 'admin',
  licenseId,
  now: new Date('2026-09-27T00:00:00.000Z'),
});

function serviceWith(categories) {
  const service = new InstallService();
  service.repository.getCollection = jest.fn(async () => categories);
  return service;
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

let spies;
beforeEach(() => {
  spies = {
    log: jest.spyOn(console, 'log').mockImplementation(quiet.log),
    warn: jest.spyOn(console, 'warn').mockImplementation(quiet.warn),
    error: jest.spyOn(console, 'error').mockImplementation(quiet.error),
  };
});
afterEach(() => {
  spies.log.mockRestore();
  spies.warn.mockRestore();
  spies.error.mockRestore();
});

describe('the vendored tree file', () => {
  test('is a non-empty array of {category, subCategories}', () => {
    expect(Array.isArray(TREE)).toBe(true);
    expect(TREE.length).toBeGreaterThan(0);
    for (const row of TREE) {
      expect(typeof row.category).toBe('string');
      expect(row.category.trim()).not.toBe('');
      expect(Array.isArray(row.subCategories)).toBe(true);
    }
  });

  test('every name would pass the category validator a shopkeeper is held to', () => {
    /* The installer writes through the repository, so these names never reach
       express-validator - which is exactly why the check lives here instead:
       a seeded category that the shop could never have typed is a category
       the shop cannot edit afterwards either. */
    for (const row of TREE) {
      for (const name of [row.category, ...row.subCategories]) {
        expect(VALIDATION_PATTERNS.NAME.test(name)).toBe(true);
        expect(name.length).toBeGreaterThanOrEqual(FIELD_LIMITS.NAME_MIN);
        expect(name.length).toBeLessThanOrEqual(FIELD_LIMITS.NAME_MAX);
      }
    }
  });

  test('no name is repeated anywhere - the branch keeps names unique', () => {
    const all = [];
    for (const row of TREE) all.push(row.category, ...row.subCategories);
    const seen = new Set();
    const dupes = [];
    for (const name of all) {
      const key = name.toLowerCase();
      if (seen.has(key)) dupes.push(name);
      seen.add(key);
    }
    /* The unique index is {name, branch_id}: a repeated leaf would make the
       second insert fail - silently, because seeding swallows its errors. */
    expect(dupes).toEqual([]);
  });
});

describe('_seedTaxonomyTree', () => {
  test('creates both levels and links every leaf to its parent', async () => {
    const categories = fakeCategories();
    const result = await serviceWith(categories)._seedTaxonomyTree(params());

    const expectedParents = TREE.length;
    const expectedLeaves = TREE.reduce((n, r) => n + r.subCategories.length, 0);
    expect(result).toEqual({ status: true, parents: expectedParents, leaves: expectedLeaves });

    const parents = categories.rows.filter((r) => r.parent_id === null);
    const leaves = categories.rows.filter((r) => r.parent_id !== null);
    expect(parents).toHaveLength(expectedParents);
    expect(leaves).toHaveLength(expectedLeaves);

    // Every leaf points at the row that owns its name, not at any old parent.
    const byName = new Map(categories.rows.map((r) => [r.name, r]));
    for (const row of TREE) {
      const parent = byName.get(row.category);
      for (const leaf of row.subCategories) {
        expect(byName.get(leaf).parent_id).toBe(parent._id);
      }
    }
  });

  test('stamps the branch, licence and actor on every row', async () => {
    const categories = fakeCategories();
    await serviceWith(categories)._seedTaxonomyTree(params('lic_9'));
    for (const row of categories.rows) {
      expect(row).toMatchObject({
        branch_id: 'br_1',
        branch_name: 'Main Branch',
        license: 'lic_9',
        created_by: 'admin',
        is_active: true,
      });
      expect(row.created_date).toBeInstanceOf(Date);
    }
  });

  test('is idempotent: a re-run adds nothing and doubles nothing', async () => {
    const categories = fakeCategories();
    const service = serviceWith(categories);
    await service._seedTaxonomyTree(params());
    const afterFirst = categories.rows.length;

    const second = await service._seedTaxonomyTree(params());
    expect(second).toEqual({ status: true, parents: 0, leaves: 0 });
    expect(categories.rows).toHaveLength(afterFirst);
  });

  test('a shop that already has a category by that name keeps its own', async () => {
    /* A parent WITH leaves, chosen rather than assumed: the tree is allowed to
       change, and a test that reaches for TREE[0] breaks the day the first
       entry becomes a parent-only category - which it now is. */
    const parent = TREE.find((r) => r.subCategories.length > 0);
    const categories = fakeCategories([
      { _id: 'existing', name: parent.category, parent_id: null, license: 'lic_1' },
    ]);
    const result = await serviceWith(categories)._seedTaxonomyTree(params());

    expect(result.parents).toBe(TREE.length - 1);
    // The pre-existing row is reused as the parent, not duplicated...
    expect(categories.rows.filter((r) => r.name === parent.category)).toHaveLength(1);
    // ...and its leaves still hang off it.
    const leaves = categories.rows.filter((r) => r.name === parent.subCategories[0]);
    expect(leaves[0].parent_id).toBe('existing');
  });

  /*
   * A category with NO sub-categories is still a category a shop needs.
   *
   * The seeded tree used to be derived from the leaf map, so `rackets` - which
   * has no children - was never created at all, and a shop could not file a
   * racket anywhere. The tree is now written out in full, and this is what
   * holds that: every parent in the file must exist afterwards, leaves or not.
   */
  test('a category with no sub-categories is seeded like any other', async () => {
    const parentOnly = TREE.filter((r) => r.subCategories.length === 0);
    expect(parentOnly.length).toBeGreaterThan(0);

    const categories = fakeCategories();
    await serviceWith(categories)._seedTaxonomyTree(params());

    for (const row of parentOnly) {
      const created = categories.rows.filter((r) => r.name === row.category);
      expect(created).toHaveLength(1);
      expect(created[0].parent_id).toBe(null);
    }
    // And they are tops, so nothing was accidentally filed under them.
    expect(categories.rows.filter((r) => r.parent_id !== null)).toHaveLength(
      TREE.reduce((n, r) => n + r.subCategories.length, 0)
    );
  });

  test('is scoped to the licence it is seeding for', async () => {
    const categories = fakeCategories();
    await serviceWith(categories)._seedTaxonomyTree(params('lic_alpha'));
    // Every lookup is licence-scoped, so one shop's tree can never be read
    // (or skipped) because of another's.
    expect(categories.rows.every((r) => r.license === 'lic_alpha')).toBe(true);
  });

  test('a broken database is logged, not thrown at the installer', async () => {
    const service = new InstallService();
    service.repository.getCollection = jest.fn(async () => {
      throw new Error('not authorised');
    });
    await expect(service._seedTaxonomyTree(params())).resolves.toEqual({
      status: false,
      reason: 'not authorised',
    });
  });

  test('a build with no tree file says so instead of inventing categories', async () => {
    const exists = jest.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      await expect(serviceWith(fakeCategories())._seedTaxonomyTree(params())).resolves.toEqual({
        status: false,
        reason: 'no taxonomy file',
      });
    } finally {
      exists.mockRestore();
    }
  });
});
