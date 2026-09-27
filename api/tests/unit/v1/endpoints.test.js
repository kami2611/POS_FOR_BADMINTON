'use strict';

/**
 * The two literal v1 endpoints (ShuttleZone integration asks I4.9 and I4.10).
 *
 * These are mounted on a REAL express app, because the risk they carry is a
 * routing one: /shop and /taxonomy sit in front of /:entity, and if that order
 * ever flips, they answer `404 unknown_entity` - "shop" being read as a
 * collection name. A test that called the handlers directly would not notice.
 */

const express = require('express');
const v1 = require('../../../src/v1');

/* A mongo collection stand-in with just the reads these routes perform. */
function collection(rows = []) {
  return {
    rows,
    findOne: async (query = {}, opts = {}) => {
      const hit = rows.find((r) =>
        Object.entries(query).every(([k, val]) => String(r[k]) === String(val))
      );
      if (!hit || !opts.projection) return hit || null;
      const out = {};
      for (const key of Object.keys(opts.projection)) if (key in hit) out[key] = hit[key];
      return out;
    },
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        toArray: async () => rows.slice(),
      };
      return chain;
    },
  };
}

function fakeDb(name, collections = {}) {
  return {
    databaseName: name,
    collection: (n) => collections[n] || collection(),
  };
}

async function withServer({ user, db, tenantContext = {} }, fn) {
  const app = express();
  app.use((req, res, next) => {
    req.user = user;
    req.db = db;
    req.tenantContext = tenantContext;
    next();
  });
  v1.registerV1({ app, protect: (req, res, next) => next() });
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    return await fn(url, async (path) => {
      const res = await fetch(url + path);
      return { status: res.status, body: await res.json() };
    });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/* A token like the one a website pairs with: it may read the catalogue and
   the category tree, and nothing else. */
const admin = {
  license: 'L1',
  access: { item: { read: true }, category: { read: true } },
};
const noCategoryRead = { license: 'L1', access: { item: { read: true } } };

describe('GET /api/v1/shop', () => {
  test('names the shop, and is not mistaken for an entity', async () => {
    const db = fakeDb('posnic_shop_ab12');
    await withServer(
      { user: admin, db, tenantContext: { licenseId: 'lic_123', branchName: 'Kamran Sports' } },
      async (url, get) => {
        const r = await get('/api/v1/shop');
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({
          shop: 'posnic_shop_ab12',
          shop_name: 'Kamran Sports',
          seller_id: 'lic_123',
          seller_name: 'Kamran Sports',
        });
      }
    );
  });

  test('falls back to the shop-own store name when the request has no branch', async () => {
    const db = fakeDb('posnic_shop_ab12', {
      settings: collection([{ store_name: 'From settings' }]),
    });
    await withServer(
      { user: admin, db, tenantContext: { licenseId: 'lic_123' } },
      async (url, get) => {
        const r = await get('/api/v1/shop');
        expect(r.body.data.shop_name).toBe('From settings');
      }
    );
  });

  test('a shop with nothing configured still identifies itself', async () => {
    const db = fakeDb('posnic_shop_ab12');
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/shop');
      expect(r.status).toBe(200);
      /* No request context: the licence comes off the principal instead, and
         the display name is honestly empty rather than invented. */
      expect(r.body.data).toEqual({
        shop: 'posnic_shop_ab12',
        shop_name: '',
        seller_id: 'L1',
        seller_name: '',
      });
    });
  });

  test('an unknown entity is still a 404 - the new routes did not shadow it', async () => {
    const db = fakeDb('posnic_shop_ab12');
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/nonsense');
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('unknown_entity');
    });
  });
});

describe('GET /api/v1/items', () => {
  /*
   * What the shop stores is what the website reads.
   *
   * INTERNAL_FIELDS is an EXCLUSION projection - `{field: 0}` - so every item
   * field crosses the wire by default. That is the property these tests exist
   * for, and the reason three of the ten integration requirements turned out
   * to be already satisfied: brand, description and the variant family fields
   * were being returned all along. A future "tidy-up" that flipped this to an
   * inclusion list would silently drop them from every shop's website, so the
   * fake below honours the projection rather than ignoring it.
   */
  function itemsCollection(rows) {
    return {
      rows,
      find: (query = {}, opts = {}) => {
        const projection = (opts && opts.projection) || {};
        const excluded = Object.keys(projection).filter((k) => projection[k] === 0);
        const out = rows
          .filter((r) => !query.license || String(r.license) === String(query.license))
          .map((r) => {
            const copy = { ...r };
            for (const key of excluded) delete copy[key];
            return copy;
          });
        const chain = {
          sort: () => chain,
          limit: () => chain,
          toArray: async () => out,
        };
        return chain;
      },
    };
  }

  const storedItem = {
    _id: 'item_1',
    name: 'Yonex Astrox 88D Pro',
    license: 'L1',
    category_name: 'badminton-rackets',
    sub_category: 'advanced-badminton-rackets',
    brand: 'Yonex',
    description: 'Head-heavy frame for steep smashes.',
    variant_group_id: 'grp_1',
    variant_axis: 'size',
    variant_value: '4U',
    variant_parent_name: 'Yonex Astrox 88D Pro',
    updated_date: new Date('2026-09-01T00:00:00.000Z'),
  };

  test('returns the fields the website mirrors, including both taxonomy levels', async () => {
    const db = fakeDb('shop', { items: itemsCollection([storedItem]) });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/items');
      expect(r.status).toBe(200);
      expect(r.body.data).toHaveLength(1);
      expect(r.body.data[0]).toMatchObject({
        name: 'Yonex Astrox 88D Pro',
        brand: 'Yonex',
        description: 'Head-heavy frame for steep smashes.',
        category_name: 'badminton-rackets',
        sub_category: 'advanced-badminton-rackets',
        variant_group_id: 'grp_1',
        variant_axis: 'size',
        variant_value: '4U',
        variant_parent_name: 'Yonex Astrox 88D Pro',
      });
    });
  });

  test('only the three internal fields are ever withheld', async () => {
    const db = fakeDb('shop', {
      items: itemsCollection([{ ...storedItem, _syncMeta: 'internal', password: 'x' }]),
    });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/items');
      const row = r.body.data[0];
      expect(row).not.toHaveProperty('_syncMeta');
      expect(row).not.toHaveProperty('password');
      // ...and nothing else was quietly dropped on the way out.
      for (const key of ['brand', 'description', 'sub_category', 'variant_group_id']) {
        expect(row).toHaveProperty(key);
      }
    });
  });

  test('the envelope carries a usable next_cursor', async () => {
    const db = fakeDb('shop', { items: itemsCollection([storedItem]) });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/items?limit=1');
      expect(r.body.meta.count).toBe(1);
      expect(r.body.meta.next_cursor).toBe(null);
    });
  });

  test('a token without item:read is refused', async () => {
    const db = fakeDb('shop', { items: itemsCollection([storedItem]) });
    await withServer({ user: { license: 'L1', access: {} }, db }, async (url, get) => {
      const r = await get('/api/v1/items');
      expect(r.status).toBe(403);
    });
  });

  /*
   * Soft-deleted rows are STILL LISTED, and this is a contract, not an
   * oversight: the deletion itself is the signal - the website sees the row
   * arrive with del_status set and archives its copy. Filtering them out here
   * would turn every shop-side deletion into a product that stays on the
   * website for ever, with nothing to indicate why.
   */
  test('a soft-deleted item is listed, with its del_status intact', async () => {
    const removed = { ...storedItem, _id: 'item_gone', del_status: 1 };
    const db = fakeDb('shop', { items: itemsCollection([storedItem, removed]) });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/items');
      const ids = r.body.data.map((row) => row._id);
      expect(ids).toContain('item_gone');
      expect(r.body.data.find((row) => row._id === 'item_gone').del_status).toBe(1);
    });
  });
});

describe('GET /api/v1/taxonomy', () => {
  test('two levels: parentless categories are tops, linked ones are leaves', async () => {
    const db = fakeDb('shop', {
      categories: collection([
        { _id: 'c1', name: 'Badminton Rackets' },
        { _id: 'c2', name: 'Apparel' },
        { _id: 'c3', name: 'Beginner Rackets', parent_id: 'c1' },
        { _id: 'c4', name: 'Advanced Rackets', parent_id: 'c1' },
        { _id: 'c5', name: 'Shirts', parent_id: 'c2' },
      ]),
    });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/taxonomy');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([
        { category: 'Badminton Rackets', subCategories: ['Advanced Rackets', 'Beginner Rackets'] },
        { category: 'Apparel', subCategories: ['Shirts'] },
      ]);
    });
  });

  test('the flat, pre-two-level shape still answers, with empty leaves', async () => {
    const db = fakeDb('shop', {
      categories: collection([
        { _id: 'c1', name: 'General' },
        { _id: 'c2', name: 'Electronics' },
      ]),
    });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/taxonomy');
      expect(r.body.data).toEqual([
        { category: 'General', subCategories: [] },
        { category: 'Electronics', subCategories: [] },
      ]);
    });
  });

  test('a leaf whose parent has vanished is a top, not a lost category', async () => {
    const db = fakeDb('shop', {
      categories: collection([{ _id: 'c9', name: 'Orphan', parent_id: 'gone' }]),
    });
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/taxonomy');
      expect(r.body.data).toEqual([{ category: 'Orphan', subCategories: [] }]);
    });
  });

  test('an empty catalogue is an empty tree, not an error', async () => {
    const db = fakeDb('shop');
    await withServer({ user: admin, db }, async (url, get) => {
      const r = await get('/api/v1/taxonomy');
      expect(r.status).toBe(200);
      expect(r.body.data).toEqual([]);
    });
  });

  test('reading the tree needs the category scope', async () => {
    const db = fakeDb('shop');
    await withServer({ user: noCategoryRead, db }, async (url, get) => {
      const r = await get('/api/v1/taxonomy');
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('forbidden');
    });
  });
});
