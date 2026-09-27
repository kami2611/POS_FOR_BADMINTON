'use strict';

/**
 * /api/v1 contract (INTEGRATIONS_ROADMAP I4).
 *
 * The whole point of v1 is that its shapes hold while legacy refactors -
 * so the shapes are what these tests pin: the envelope, the cursor
 * round-trip, ACL refusal, tenant scoping, the rate window, and the
 * entity->collection->acl map itself.
 */

const v1 = require('../../../src/v1');

describe('entity map', () => {
  test('exposes exactly the seven read collections, each with an acl module', () => {
    expect(Object.keys(v1.ENTITIES).sort()).toEqual([
      'categories',
      'customers',
      'expenses',
      'items',
      'receivings',
      'sales',
      'suppliers',
    ]);
    for (const def of Object.values(v1.ENTITIES)) {
      expect(typeof def.collection).toBe('string');
      expect(typeof def.acl).toBe('string');
    }
  });
  test('never exposes users, settings, branches or plan surfaces', () => {
    for (const k of ['users', 'settings', 'branches', 'plan', 'registers']) {
      expect(v1.ENTITIES[k]).toBeUndefined();
    }
  });
});

describe('acl', () => {
  test('read requires the exact module read grant', () => {
    expect(v1.canRead({ access: { sales: { read: true } } }, 'sales')).toBe(true);
    expect(v1.canRead({ access: { sales: { write: true } } }, 'sales')).toBe(false);
    expect(v1.canRead({ access: {} }, 'sales')).toBe(false);
    expect(v1.canRead(null, 'sales')).toBe(false);
  });
});

describe('cursor', () => {
  test('round-trips date and id', () => {
    const doc = { _id: 'abc123', updated_date: new Date('2026-08-18T10:00:00.000Z') };
    const c = v1.decodeCursor(v1.encodeCursor(doc));
    expect(c.ts.toISOString()).toBe('2026-08-18T10:00:00.000Z');
    expect(c.id).toBe('abc123');
  });
  test('garbage cursors decode to null, never throw', () => {
    expect(v1.decodeCursor('not-a-cursor')).toBe(null);
    expect(v1.decodeCursor('')).toBe(null);
    expect(v1.decodeCursor(null)).toBe(null);
    expect(v1.decodeCursor(Buffer.from('no-pipe-here').toString('base64url'))).toBe(null);
  });

  /*
   * The trap: encodeCursor used to write an EMPTY timestamp for a row whose
   * updated_date is missing or not a Date, and decodeCursor rejects an empty
   * timestamp - so a caller's next page answered 400 bad_cursor and the walk
   * stopped dead with no way to resume. Every cursor this API ISSUES must be
   * one this API ACCEPTS; that is the invariant, whatever is on the row.
   */
  test('a row with no usable updated_date still yields a cursor that decodes', () => {
    for (const bad of [
      { _id: 'a' },
      { _id: 'b', updated_date: null },
      { _id: 'c', updated_date: '' },
      { _id: 'd', updated_date: '2026-08-18T10:00:00.000Z' },
      { _id: 'e', updated_date: new Date('nonsense') },
    ]) {
      const raw = v1.encodeCursor(bad);
      const back = v1.decodeCursor(raw);
      expect(back).not.toBe(null);
      expect(back.id).toBe(bad._id);
    }
  });

  test('a dated row is still encoded exactly as before', () => {
    const doc = { _id: 'abc123', updated_date: new Date('2026-08-18T10:00:00.000Z') };
    const back = v1.decodeCursor(v1.encodeCursor(doc));
    expect(back.ts.toISOString()).toBe('2026-08-18T10:00:00.000Z');
    expect(back.id).toBe('abc123');
  });
});

/*
 * The other half of the same trap, and the half a cursor guard cannot fix: a
 * row with NO updated_date can never satisfy `updated_date > <cursor>`, so it
 * is invisible to every paginated walk. An integrator mirroring the catalogue
 * would silently never see it.
 */
describe('updated_date repair', () => {
  function fakeDb(rows) {
    const store = rows.slice();
    const calls = { find: 0, bulkWrite: 0 };
    return {
      databaseName: 'posnic_t_shop',
      calls,
      _rows: store,
      collection: () => ({
        find: (q, opts) => {
          calls.find++;
          const out = store.filter((r) => r.updated_date === undefined);
          const chain = {
            limit: () => chain,
            projection: () => chain,
            toArray: async () => out.map((r) => ({ _id: r._id, created_date: r.created_date })),
          };
          return chain;
        },
        bulkWrite: async (ops) => {
          calls.bulkWrite++;
          for (const op of ops) {
            const row = store.find((r) => r._id === op.updateOne.filter._id);
            if (row) Object.assign(row, op.updateOne.update.$set);
          }
          return { modifiedCount: ops.length };
        },
      }),
    };
  }

  beforeEach(() => v1.resetUpdatedDateRepairs());

  test('stamps created_date where it exists, now where it does not', async () => {
    const created = new Date('2025-01-02T03:04:05.000Z');
    const db = fakeDb([
      { _id: 'old-with-created', created_date: created },
      { _id: 'old-with-neither' },
      { _id: 'fine', updated_date: new Date('2026-01-01T00:00:00.000Z') },
    ]);
    const n = await v1.repairUpdatedDates(db, 'items');
    expect(n).toBe(2);
    expect(db._rows.find((r) => r._id === 'old-with-created').updated_date).toEqual(created);
    // A row with no dates at all gets "now": it costs one extra visit in the
    // caller's next walk instead of being invisible forever.
    expect(db._rows.find((r) => r._id === 'old-with-neither').updated_date).toBeInstanceOf(Date);
    // The already-dated row is untouched.
    expect(db._rows.find((r) => r._id === 'fine').updated_date.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });

  test('nothing to repair means no write at all', async () => {
    const db = fakeDb([{ _id: 'fine', updated_date: new Date() }]);
    expect(await v1.repairUpdatedDates(db, 'items')).toBe(0);
    expect(db.calls.bulkWrite).toBe(0);
  });

  test('runs once per process per collection, then never again', async () => {
    const db = fakeDb([{ _id: 'old' }]);
    await v1.ensureUpdatedDates(db, 'items');
    expect(db.calls.find).toBe(1);
    await v1.ensureUpdatedDates(db, 'items');
    await v1.ensureUpdatedDates(db, 'items');
    // Guarded: the repeat calls do not even reach the database.
    expect(db.calls.find).toBe(1);
    // A different collection still gets its own pass.
    await v1.ensureUpdatedDates(db, 'categories');
    expect(db.calls.find).toBe(2);
  });

  test('a failing repair never throws at the caller, and is retried next time', async () => {
    let attempts = 0;
    const db = {
      databaseName: 'shop',
      collection: () => ({
        find: () => ({
          limit: () => ({
            toArray: async () => {
              attempts++;
              throw new Error('not authorised');
            },
          }),
        }),
      }),
    };
    expect(await v1.ensureUpdatedDates(db, 'items')).toBe(0);
    expect(await v1.ensureUpdatedDates(db, 'items')).toBe(0);
    expect(attempts).toBe(2); // the key was released, so it tried again
  });
});

describe('list query', () => {
  test('scopes by license, branch access and cursor together', () => {
    const user = { license: 'L1', branch_access: [{ branch_id: 'B1' }] };
    const cursor = { ts: new Date('2026-08-18T10:00:00Z'), id: 'x' };
    const q = v1.buildListQuery(user, cursor);
    expect(q.$and).toHaveLength(3);
    expect(q.$and[0]).toEqual({ license: 'L1' });
    expect(q.$and[1].$or[2].branch_id.$in).toContain('B1');
    expect(q.$and[2].$or[0].updated_date.$gt).toEqual(cursor.ts);
  });
  test('unrestricted user gets license scope only', () => {
    const q = v1.buildListQuery({ license: 'L1', branch_access: [] }, null);
    expect(q).toEqual({ $and: [{ license: 'L1' }] });
  });
});

describe('envelope', () => {
  const doc = (id) => ({ _id: id, updated_date: new Date('2026-08-18T10:00:00Z') });
  test('under the limit: no next cursor', () => {
    const e = v1.envelope([doc('a'), doc('b')], 50);
    expect(e.data).toHaveLength(2);
    expect(e.meta).toEqual({ count: 2, next_cursor: null });
  });
  test('over the limit: page trimmed, cursor points at the last returned row', () => {
    const e = v1.envelope([doc('a'), doc('b'), doc('c')], 2);
    expect(e.data).toHaveLength(2);
    expect(v1.decodeCursor(e.meta.next_cursor).id).toBe('b');
  });
});

describe('writes (I4.5) - deliberate, per entity', () => {
  test('customers is the only writable entity in this cut', () => {
    expect(Object.keys(v1.WRITABLE)).toEqual(['customers']);
  });
  test('the whitelist never carries money or referential state', () => {
    for (const banned of [
      'balance',
      'loyalty',
      'tags',
      'category_id',
      'referrer_id',
      'license',
      'branch_id',
      '_id',
    ]) {
      expect(v1.WRITABLE.customers.fields).not.toContain(banned);
    }
  });
  test('pickWritable keeps whitelisted fields only, coerced to strings', () => {
    const out = v1.pickWritable('customers', {
      name: 'Asha',
      phone: 98400,
      balance: 9999,
      license: 'EVIL',
      _id: 'x',
      extra: 'no',
    });
    expect(out).toEqual({ name: 'Asha', phone: '98400' });
  });
  test('a customer needs a name or a phone', () => {
    expect(v1.WRITABLE.customers.required({})).toBeTruthy();
    expect(v1.WRITABLE.customers.required({ name: '  ' })).toBeTruthy();
    expect(v1.WRITABLE.customers.required({ name: 'Asha' })).toBe(null);
    expect(v1.WRITABLE.customers.required({ phone: '9' })).toBe(null);
  });
  test('write requires the write grant, not just read', () => {
    expect(v1.canWrite({ access: { customer: { read: true } } }, 'customer')).toBe(false);
    expect(v1.canWrite({ access: { customer: { write: true } } }, 'customer')).toBe(true);
  });
  test('writes land in the principal`s branch', () => {
    expect(v1.writeBranchId({ branch_id: 'B1' })).toBe('B1');
    expect(v1.writeBranchId({ branch_access: [{ branch_id: 'B2' }] })).toBe('B2');
    expect(v1.writeBranchId({})).toBe(null);
  });
});

describe('openapi spec', () => {
  test('documents exactly the entities the router serves', () => {
    const spec = v1.openapiSpec();
    expect(spec.openapi).toBe('3.0.3');
    const listed = spec.paths['/{entity}'].get.parameters[0].schema.enum;
    expect(listed.sort()).toEqual(Object.keys(v1.ENTITIES).sort());
    expect(spec.security).toEqual([{ token: [] }]);
  });
});

describe('rate window', () => {
  beforeEach(() => v1.resetRateLimits());
  test('allows the window, refuses past it, resets on the next window', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < v1.MAX_PER_WINDOW; i++) {
      expect(v1.rateLimited('tok1', t0)).toBe(false);
    }
    expect(v1.rateLimited('tok1', t0)).toBe(true);
    expect(v1.rateLimited('tok1', t0 + 61_000)).toBe(false);
    // other principals are unaffected
    expect(v1.rateLimited('tok2', t0)).toBe(false);
  });
});
