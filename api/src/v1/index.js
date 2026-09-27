'use strict';
/*
 * /api/v1 - the versioned facade (INTEGRATIONS_ROADMAP I4).
 *
 * The promise: this surface is stable. Legacy routes get refactored freely;
 * v1 keeps its shapes, and a contract test pins them. Read-only in v1.0 -
 * writes arrive as deliberate additions, never as leaks from legacy.
 *
 * Auth is whatever passed `protect` upstream - scoped tokens (the intended
 * caller) and sessions both land here as req.user with a resolved ACL, and
 * every entity check goes through the same access matrix the rest of the
 * API enforces. Reads are tenant-scoped by license and, for restricted
 * users, by their branch access.
 */

const ENTITIES = {
  sales: { collection: 'sales', acl: 'sales' },
  items: { collection: 'items', acl: 'item' },
  customers: { collection: 'customers', acl: 'customer' },
  suppliers: { collection: 'suppliers', acl: 'supplier' },
  categories: { collection: 'categories', acl: 'category' },
  receivings: { collection: 'receivings', acl: 'receiving' },
  expenses: { collection: 'expenses', acl: 'expense' },
};

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/* Fields that are ours, not the caller's. */
const INTERNAL_FIELDS = { _syncMeta: 0, password: 0, token_hash: 0 };

function canRead(user, aclModule) {
  return !!(user && user.access && user.access[aclModule] && user.access[aclModule].read === true);
}

function canWrite(user, aclModule) {
  return !!(user && user.access && user.access[aclModule] && user.access[aclModule].write === true);
}

/*
 * Writes arrive per entity, deliberately (I4.5) - never leaked from legacy.
 * customers first: the fields an integrator may set are exactly these.
 * Deliberate omissions: balance and loyalty (money-adjacent state changes
 * belong to the sale/credit flows that account for them), category and
 * referrer links (referential - they need the lookup flows), tags.
 */
const WRITABLE = {
  customers: {
    fields: [
      'name',
      'email',
      'phone',
      'alternatePhone',
      'address',
      'city',
      'state',
      'country',
      'pincode',
      'notes',
      'gst_number',
      'gst_type',
    ],
    required: (body) =>
      (typeof body.name === 'string' && body.name.trim()) ||
      (typeof body.phone === 'string' && body.phone.trim())
        ? null
        : 'A customer needs at least a name or a phone number.',
  },
};

/** The whitelisted subset of a write body, every value coerced to string. */
function pickWritable(entity, body) {
  const def = WRITABLE[entity];
  const out = {};
  for (const f of def.fields) {
    if (body[f] !== undefined && body[f] !== null) out[f] = String(body[f]);
  }
  return out;
}

/** The branch a token principal's writes land in. */
function writeBranchId(user) {
  if (!user) return null;
  if (user.branch_id) return user.branch_id;
  const ba = user.branch_access;
  if (Array.isArray(ba) && ba[0] && ba[0].branch_id) return ba[0].branch_id;
  return null;
}

/* Cursor = base64url of "isoDate|id". Compound so equal timestamps can
   neither skip nor repeat - the same rule the sync checkpoints use.

   A row with no usable updated_date must still yield a cursor this API
   accepts. It used to emit an EMPTY timestamp, which decodeCursor rejects - so
   the caller's next page answered `400 bad_cursor` and the walk stopped dead
   with no way to resume except by hand. Such rows sort before every dated one,
   so the epoch is the honest stand-in: "everything from the beginning of". */
function encodeCursor(doc) {
  const when = doc && doc.updated_date;
  const usable = when instanceof Date && !isNaN(when.getTime());
  const ts = usable ? when.toISOString() : new Date(0).toISOString();
  return Buffer.from(ts + '|' + String(doc._id)).toString('base64url');
}

function decodeCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let text;
  try {
    text = Buffer.from(raw, 'base64url').toString('utf8');
  } catch (e) {
    return null;
  }
  const i = text.indexOf('|');
  if (i < 0) return null;
  const ts = new Date(text.slice(0, i));
  if (isNaN(ts.getTime())) return null;
  return { ts, id: text.slice(i + 1) };
}

/*
 * Rows written before every write path stamped a date - legacy imports, the
 * PHP-era collections, a hand-edited database - carry no updated_date at all.
 *
 * Such a row can never satisfy `updated_date > <cursor>`, so it is INVISIBLE
 * to every paginated walk: an integrator mirroring the catalogue would never
 * see it and would never be told. The cursor guard above stops that from
 * breaking the walk outright, but it cannot make the row reachable. So the
 * repair is the real fix and the guard is the safety net - both, deliberately.
 *
 * Once per process per collection: a shop's items are written by paths that
 * all stamp a date, so after one sweep there is normally nothing left to find
 * and the cost is a single indexed query. */
const repairedInProcess = new Set();

async function repairUpdatedDates(db, collectionName) {
  if (!db || !collectionName) return 0;
  const collection = db.collection(collectionName);
  const rows = await collection
    .find({ updated_date: { $exists: false } }, { projection: { _id: 1, created_date: 1 } })
    .limit(5000)
    .toArray();
  if (!rows.length) return 0;
  const now = new Date();
  await collection.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { _id: row._id },
        /* created_date is the truth when it exists - the row has not changed
           since then. Only a row with neither gets "now", which costs it one
           extra visit in the caller's next walk and nothing more. */
        update: {
          $set: { updated_date: row.created_date instanceof Date ? row.created_date : now },
        },
      },
    })),
    { ordered: false }
  );
  return rows.length;
}

/** The once-per-process guard around repairUpdatedDates. */
async function ensureUpdatedDates(db, collectionName) {
  const key = (db && (db.databaseName || db.namespace)) + ':' + collectionName;
  if (repairedInProcess.has(key)) return 0;
  repairedInProcess.add(key);
  try {
    return await repairUpdatedDates(db, collectionName);
  } catch (e) {
    /* A repair that fails must never fail the read - the cursor guard already
       stops the 400. Release the key so a transient failure is retried on the
       next request rather than leaving the collection broken forever. */
    repairedInProcess.delete(key);
    return 0;
  }
}

function resetUpdatedDateRepairs() {
  repairedInProcess.clear();
}

/*
 * Fixed-window rate limit per principal. In-memory per process - the goal
 * is stopping a runaway integration loop, not billing-grade accounting.
 */
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 300;
const windows = new Map(); // principalId -> {start, count}

function rateLimited(principalId, now = Date.now()) {
  const w = windows.get(principalId);
  if (!w || now - w.start >= WINDOW_MS) {
    windows.set(principalId, { start: now, count: 1 });
    return false;
  }
  w.count++;
  return w.count > MAX_PER_WINDOW;
}

function resetRateLimits() {
  windows.clear();
}

function branchFilter(user) {
  const branches = (user && user.branch_access) || [];
  if (!branches.length) return null;
  const ids = [];
  for (const b of branches) {
    if (b && b.branch_id != null) {
      ids.push(b.branch_id, String(b.branch_id));
    }
  }
  if (!ids.length) return null;
  return {
    $or: [{ branch_id: { $exists: false } }, { branch_id: null }, { branch_id: { $in: ids } }],
  };
}

function buildListQuery(user, cursor) {
  const and = [];
  if (user && user.license) {
    and.push({ license: user.license });
  }
  const bf = branchFilter(user);
  if (bf) and.push(bf);
  if (cursor) {
    and.push({
      $or: [
        { updated_date: { $gt: cursor.ts } },
        { updated_date: cursor.ts, _id: { $gt: cursor.id } },
      ],
    });
  }
  return and.length ? { $and: and } : {};
}

function envelope(docs, limit) {
  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  return {
    data: page,
    meta: {
      count: page.length,
      next_cursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
    },
  };
}

function err(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

function openapiSpec() {
  const entityNames = Object.keys(ENTITIES);
  return {
    openapi: '3.0.3',
    info: {
      title: 'Posnic API',
      version: '1.0.0',
      description:
        'Authenticate with a scoped API token (Manage > Integrations) via the Authorization: Bearer header. Lists are cursor-paginated; pass meta.next_cursor back as ?cursor= until it returns null. Reads cover every entity; writes exist per entity, deliberately - customers today.',
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: { token: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Envelope: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'object' } },
            meta: {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                next_cursor: { type: 'string', nullable: true },
              },
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' } },
            },
          },
        },
      },
    },
    security: [{ token: [] }],
    paths: {
      '/shop': {
        get: {
          summary: 'This shop\u2019s identity',
          responses: {
            200: {
              description: 'shop, shop_name, seller_id and seller_name',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            401: { description: 'No token' },
          },
        },
      },
      '/taxonomy': {
        get: {
          summary: 'The seeded category tree, parent and leaves',
          responses: {
            200: {
              description: 'An array of {category, subCategories}',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            403: { description: 'Token lacks the category:read scope' },
          },
        },
      },
      '/{entity}': {
        get: {
          summary: 'List records, oldest change first',
          parameters: [
            {
              name: 'entity',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: entityNames },
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
            },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'A page plus the cursor for the next one',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Envelope' } },
              },
            },
            403: { description: 'Token lacks the read scope for this entity' },
            429: { description: 'Over ' + MAX_PER_WINDOW + ' requests per minute' },
          },
        },
        post: {
          summary: 'Create a record',
          description:
            'Writable entities: ' +
            Object.keys(WRITABLE).join(', ') +
            '. customers accepts: ' +
            WRITABLE.customers.fields.join(', ') +
            '. A customer needs at least a name or a phone.',
          parameters: [
            {
              name: 'entity',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: Object.keys(WRITABLE) },
            },
          ],
          responses: {
            201: { description: 'The created record, wrapped as {data}' },
            405: { description: 'This entity is read-only in v1' },
          },
        },
      },
      '/{entity}/{id}': {
        get: {
          summary: 'Fetch one record by id',
          parameters: [
            {
              name: 'entity',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: entityNames },
            },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'The record, wrapped as {data}' },
            404: { description: 'No such record in this shop' },
          },
        },
        patch: {
          summary: 'Update writable fields of one record',
          description:
            'Writable entities: ' +
            Object.keys(WRITABLE).join(', ') +
            '. Only the documented fields are accepted; anything else is ignored.',
          parameters: [
            {
              name: 'entity',
              in: 'path',
              required: true,
              schema: { type: 'string', enum: Object.keys(WRITABLE) },
            },
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
          ],
          responses: {
            200: { description: 'The updated record, wrapped as {data}' },
            405: { description: 'This entity is read-only in v1' },
          },
        },
      },
    },
  };
}

function registerV1({ app, protect }) {
  const express = require('express');
  const router = express.Router();

  /* The spec is public and must beat the protected mounts, or it 401s. */
  app.get(['/v1/openapi.json', '/api/v1/openapi.json'], (req, res) => res.json(openapiSpec()));

  router.use((req, res, next) => {
    const principal = req.user && (req.user.id || String(req.user._id || 'anon'));
    if (rateLimited(principal)) {
      return err(
        res,
        429,
        'rate_limited',
        'Too many requests - at most ' + MAX_PER_WINDOW + ' per minute per token.'
      );
    }
    next();
  });

  /*
   * Both of the literal paths below MUST be declared before /:entity, or the
   * parameterised route reads "shop" and "taxonomy" as entity names and
   * answers 404 unknown_entity. The same rule the public openapi.json follows.
   */

  /*
   * Who this shop is (ShuttleZone integration ask I4.9).
   *
   * Pairing a website with a shop needs to confirm the token belongs to the
   * shop it is being paired with. Without this the site infers it from
   * whatever the first webhook happens to say, which is the wrong order: the
   * verification should be possible BEFORE any data is mirrored.
   *
   * seller_id is the licence - it scopes every document in this database, so
   * it survives a reinstall of the till and matches what the webhook body
   * reports.
   */
  router.get('/shop', async (req, res) => {
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const tenant = req.tenantContext || {};
      let displayName = String(tenant.branchName || '').trim();
      if (!displayName) {
        /* A new shop may have no settings document yet, which is not an
           error - the database name still identifies it. */
        const doc = await req.db
          .collection('settings')
          .findOne({}, { projection: { store_name: 1 } });
        displayName = String((doc && doc.store_name) || '').trim();
      }
      res.json({
        data: {
          shop: req.db.databaseName,
          shop_name: displayName,
          seller_id: String(tenant.licenseId || (req.user && req.user.license) || ''),
          seller_name: displayName,
        },
      });
    } catch (e) {
      err(res, 500, 'internal', 'Could not read the shop identity.');
    }
  });

  /*
   * The category tree this install seeds (ShuttleZone integration ask I4.10).
   *
   * Two levels, because the website's own browsing is two levels. Reading it
   * over the API beats parsing the packaged install document: the answer is
   * what THIS shop actually has, including anything the shopkeeper added.
   * Parentless categories are top level; a category whose parent_id points at
   * another is that parent's leaf.
   */
  router.get('/taxonomy', async (req, res) => {
    if (!canRead(req.user, 'category'))
      return err(res, 403, 'forbidden', 'This token has no category:read scope.');
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const rows = await req.db
        .collection('categories')
        .find({}, { projection: { name: 1, parent_id: 1 } })
        .sort({ name: 1 })
        .toArray();
      const byId = new Map(rows.map((r) => [String(r._id), r]));
      const leaves = new Map();
      const tops = [];
      for (const row of rows) {
        const parentId = row.parent_id == null ? '' : String(row.parent_id);
        /* A category cannot be its own parent. If one somehow is, it is
           treated as a top rather than disappearing from the tree - a
           category nobody can see is worse than one at the wrong level. */
        const parent = parentId && parentId !== String(row._id) ? byId.get(parentId) : null;
        if (parent) {
          const key = String(parent._id);
          if (!leaves.has(key)) leaves.set(key, []);
          leaves.get(key).push(String(row.name || ''));
        } else {
          tops.push(row);
        }
      }
      res.json({
        data: tops.map((t) => ({
          category: String(t.name || ''),
          subCategories: (leaves.get(String(t._id)) || []).sort(),
        })),
      });
    } catch (e) {
      err(res, 500, 'internal', 'Could not read the category tree.');
    }
  });

  router.get('/:entity', async (req, res) => {
    const def = ENTITIES[req.params.entity];
    if (!def) return err(res, 404, 'unknown_entity', 'No such collection in v1.');
    if (!canRead(req.user, def.acl))
      return err(res, 403, 'forbidden', 'This token has no ' + def.acl + ':read scope.');
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || DEFAULT_LIMIT, MAX_LIMIT);
      const cursor = decodeCursor(req.query.cursor);
      if (req.query.cursor && !cursor)
        return err(res, 400, 'bad_cursor', 'The cursor is not one this API issued.');
      /* Repairing the collection being listed, once, is cheaper than either
         explanation: a date-less row would be invisible to this walk, and the
         integrator would never know it was missing. */
      await ensureUpdatedDates(req.db, def.collection);
      const docs = await req.db
        .collection(def.collection)
        .find(buildListQuery(req.user, cursor), { projection: INTERNAL_FIELDS })
        .sort({ updated_date: 1, _id: 1 })
        .limit(limit + 1)
        .toArray();
      res.json(envelope(docs, limit));
    } catch (e) {
      err(res, 500, 'internal', 'Could not list ' + req.params.entity + '.');
    }
  });

  router.get('/:entity/:id', async (req, res) => {
    const def = ENTITIES[req.params.entity];
    if (!def) return err(res, 404, 'unknown_entity', 'No such collection in v1.');
    if (!canRead(req.user, def.acl))
      return err(res, 403, 'forbidden', 'This token has no ' + def.acl + ':read scope.');
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const { ObjectId } = require('mongodb');
      if (!ObjectId.isValid(String(req.params.id))) {
        return err(res, 400, 'bad_id', 'Not a valid id.');
      }
      const and = [{ _id: new ObjectId(String(req.params.id)) }];
      if (req.user && req.user.license) and.push({ license: req.user.license });
      const bf = branchFilter(req.user);
      if (bf) and.push(bf);
      const doc = await req.db
        .collection(def.collection)
        .findOne({ $and: and }, { projection: INTERNAL_FIELDS });
      if (!doc) return err(res, 404, 'not_found', 'No such record in this shop.');
      res.json({ data: doc });
    } catch (e) {
      err(res, 500, 'internal', 'Could not fetch the record.');
    }
  });

  router.post('/:entity', async (req, res) => {
    const def = ENTITIES[req.params.entity];
    const wdef = WRITABLE[req.params.entity];
    if (!def) return err(res, 404, 'unknown_entity', 'No such collection in v1.');
    if (!wdef)
      return err(
        res,
        405,
        'read_only',
        'v1 does not accept writes to ' + req.params.entity + ' yet.'
      );
    if (!canWrite(req.user, def.acl))
      return err(res, 403, 'forbidden', 'This token has no ' + def.acl + ':write scope.');
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const body = req.body || {};
      const problem = wdef.required(body);
      if (problem) return err(res, 400, 'invalid', problem);
      const now = new Date();
      const doc = {
        ...pickWritable(req.params.entity, body),
        license: req.user.license || null,
        branch_id: writeBranchId(req.user),
        created_date: now,
        updated_date: now,
        is_deleted: false,
        created_via: 'api_v1',
      };
      const r = await req.db.collection(def.collection).insertOne(doc);
      res.status(201).json({ data: { ...doc, _id: r.insertedId } });
    } catch (e) {
      err(res, 500, 'internal', 'Could not create the record.');
    }
  });

  router.patch('/:entity/:id', async (req, res) => {
    const def = ENTITIES[req.params.entity];
    const wdef = WRITABLE[req.params.entity];
    if (!def) return err(res, 404, 'unknown_entity', 'No such collection in v1.');
    if (!wdef)
      return err(
        res,
        405,
        'read_only',
        'v1 does not accept writes to ' + req.params.entity + ' yet.'
      );
    if (!canWrite(req.user, def.acl))
      return err(res, 403, 'forbidden', 'This token has no ' + def.acl + ':write scope.');
    if (!req.db) return err(res, 503, 'no_tenant', 'Tenant context unavailable.');
    try {
      const { ObjectId } = require('mongodb');
      if (!ObjectId.isValid(String(req.params.id)))
        return err(res, 400, 'bad_id', 'Not a valid id.');
      const set = pickWritable(req.params.entity, req.body || {});
      if (!Object.keys(set).length)
        return err(res, 400, 'invalid', 'Nothing writable in the body.');
      set.updated_date = new Date();
      const and = [{ _id: new ObjectId(String(req.params.id)) }];
      if (req.user && req.user.license) and.push({ license: req.user.license });
      const bf = branchFilter(req.user);
      if (bf) and.push(bf);
      const r = await req.db
        .collection(def.collection)
        .findOneAndUpdate(
          { $and: and },
          { $set: set },
          { returnDocument: 'after', projection: INTERNAL_FIELDS }
        );
      const doc = r && (r.value !== undefined ? r.value : r);
      if (!doc || !doc._id) return err(res, 404, 'not_found', 'No such record in this shop.');
      res.json({ data: doc });
    } catch (e) {
      err(res, 500, 'internal', 'Could not update the record.');
    }
  });

  /* Dual-path, always - the proxy keeps /api on this estate. */
  app.use('/v1', protect, router);
  app.use('/api/v1', protect, router);
}

module.exports = {
  ENTITIES,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_PER_WINDOW,
  canRead,
  encodeCursor,
  decodeCursor,
  rateLimited,
  resetRateLimits,
  branchFilter,
  buildListQuery,
  envelope,
  openapiSpec,
  registerV1,
  WRITABLE,
  canWrite,
  pickWritable,
  writeBranchId,
  repairUpdatedDates,
  ensureUpdatedDates,
  resetUpdatedDateRepairs,
};
