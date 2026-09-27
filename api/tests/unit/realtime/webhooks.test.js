'use strict';

/**
 * Unit tests for src/realtime/webhooks.js (integration platform step 1).
 *
 * What must hold: only safe URLs; the secret shown exactly once; a delivery
 * row written before the attempt; HMAC over the exact body; coalescing while
 * a delivery is pending; backoff then dead after MAX_ATTEMPTS; the lazy
 * drain throttled and resilient to removed subscriptions; and none of it
 * ever throwing into the write path that triggered it.
 */

const crypto = require('crypto');
const wh = require('../../../src/realtime/webhooks');

/* Minimal in-memory mongo-ish fake: enough find/insert/update for the module. */
function fakeDb() {
  const stores = new Map();
  const coll = (name) => {
    if (!stores.has(name)) stores.set(name, []);
    const rows = stores.get(name);
    const matches = (row, q) =>
      Object.entries(q).every(([k, v]) => {
        const val = k.split('.').reduce((o, part) => (o ? o[part] : undefined), row);
        if (v && typeof v === 'object' && v.$lte !== undefined) return val <= v.$lte;
        if (v && typeof v === 'object' && v.$gt !== undefined) return val > v.$gt;
        return String(val) === String(v);
      });
    return {
      insertOne: async (doc) => {
        doc._id = doc._id || crypto.randomBytes(12).toString('hex');
        rows.push(doc);
        return { insertedId: doc._id };
      },
      findOne: async (q) => rows.find((r) => matches(r, q)) || null,
      find: (q = {}) => {
        let out = rows.filter((r) => matches(r, q));
        const cursor = {
          sort: () => cursor,
          limit: (n) => {
            out = out.slice(0, n);
            return cursor;
          },
          project: () => cursor,
          toArray: async () => out.slice(),
        };
        return cursor;
      },
      updateOne: async (q, u) => {
        const row = rows.find((r) => matches(r, q));
        if (row && u.$set) Object.assign(row, u.$set);
        if (row && u.$unset) {
          for (const path of Object.keys(u.$unset)) {
            const parts = path.split('.');
            const key = parts.pop();
            const owner = parts.reduce((value, part) => (value ? value[part] : undefined), row);
            if (owner) delete owner[key];
          }
        }
        return { matchedCount: row ? 1 : 0 };
      },
      deleteOne: async (q) => {
        const i = rows.findIndex((r) => matches(r, q));
        if (i >= 0) rows.splice(i, 1);
        return { deletedCount: i >= 0 ? 1 : 0 };
      },
      rows,
    };
  };
  return { collection: coll, _stores: stores };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

let realFetch;
beforeEach(() => {
  realFetch = global.fetch;
});
afterEach(() => {
  global.fetch = realFetch;
});

/*
 * The wire contract, pinned.
 *
 * A receiver on the other side of the internet verifies the signature over the
 * RAW body and routes on these exact header names. Renaming a header or
 * reshaping the body is a one-line change here and a total outage there, with
 * no shared compiler to catch it - so the shapes are asserted, not assumed.
 */
describe('the wire contract', () => {
  test('one request carries exactly what a receiver was promised', async () => {
    const db = fakeDb();
    const added = await wh.addSubscription(db, {
      url: 'https://example.com/hook',
      events: ['items'],
    });
    const seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push({ url, init });
      return { status: 202 };
    });

    await wh.publish(db, 'shop_ab12', {
      entity: 'items',
      at: '2026-09-27T09:14:03.221Z',
      seller_id: 'lic_1',
      seller_name: 'Kamran Sports',
    });
    await flush();

    const { url, init } = seen[0];
    expect(url).toBe('https://example.com/hook');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');

    /* The body, exactly. It carries no business data at all - the receiver
       fetches with its own scoped credentials, so a leaked webhook secret
       alone leaks nothing. That is deliberate, and it is load-bearing. */
    expect(JSON.parse(init.body)).toEqual({
      event: 'change',
      entity: 'items',
      at: '2026-09-27T09:14:03.221Z',
      shop: 'shop_ab12',
      seller_id: 'lic_1',
      seller_name: 'Kamran Sports',
    });

    expect(init.headers['x-posnic-event']).toBe('change');
    expect(init.headers['x-posnic-delivery']).toBe(
      String(db.collection(wh.DELIVERIES).rows[0]._id)
    );
    /* HMAC-SHA256 over the exact bytes sent, prefixed `sha256=`. */
    expect(init.headers['x-posnic-signature']).toBe(
      'sha256=' + crypto.createHmac('sha256', added.secret).update(init.body).digest('hex')
    );
  });

  test('a receiver only ever gets https, or loopback for development', () => {
    expect(wh.urlAllowed('https://shuttlezone.app/api/pos/webhook/k')).toBe(true);
    expect(wh.urlAllowed('http://shuttlezone.app/api/pos/webhook/k')).toBe(false);
    expect(wh.urlAllowed('http://127.0.0.1:3000/api/pos/webhook/k')).toBe(true);
    expect(wh.urlAllowed('http://localhost:3000/api/pos/webhook/k')).toBe(true);
    expect(wh.urlAllowed('ftp://example.com')).toBe(false);
  });

  test('the retry ladder is what the docs say it is', () => {
    /* 1m, 5m, 25m, ~2h, ~10h, then dead. A receiver that goes down for an
       hour must expect a retry after it comes back, not a hole. */
    expect(wh.MAX_ATTEMPTS).toBe(5);
  });
});

describe('urlAllowed', () => {
  test('https yes, plain http no, loopback http yes (dev)', () => {
    expect(wh.urlAllowed('https://hooks.example.com/x')).toBe(true);
    expect(wh.urlAllowed('http://hooks.example.com/x')).toBe(false);
    expect(wh.urlAllowed('http://127.0.0.1:9000/x')).toBe(true);
    expect(wh.urlAllowed('not a url')).toBe(false);
  });
});

describe('subscriptions', () => {
  test('registration returns the secret once and the list never repeats it', async () => {
    const db = fakeDb();
    const r = await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    expect(r.ok).toBe(true);
    expect(r.secret).toHaveLength(48);
    const rows = await wh.listSubscriptions(db);
    expect(rows).toHaveLength(1);
    // the module stores it; the ROUTE layer's projection is what hides it -
    // asserted here so the field name a route must exclude stays stable
    expect(rows[0].secret).toBe(r.secret);
  });

  test('an http url or an empty event list is refused', async () => {
    const db = fakeDb();
    expect(
      (await wh.addSubscription(db, { url: 'http://a.example/h', events: ['sales'] })).ok
    ).toBe(false);
    expect((await wh.addSubscription(db, { url: 'https://a.example/h', events: [] })).ok).toBe(
      false
    );
  });
});

describe('publish', () => {
  test('writes the delivery row, signs the exact body, marks delivered on 2xx', async () => {
    const db = fakeDb();
    const { secret } = await wh.addSubscription(db, {
      url: 'https://a.example/h',
      events: ['sales'],
    });
    const seen = [];
    global.fetch = async (url, init) => {
      seen.push({ url, init });
      return { status: 200 };
    };

    const fired = await wh.publish(db, 'shop_one', { entity: 'sales', at: 'T' });
    await flush();

    expect(fired).toBe(1);
    expect(seen).toHaveLength(1);
    const expected =
      'sha256=' + crypto.createHmac('sha256', secret).update(seen[0].init.body).digest('hex');
    expect(seen[0].init.headers['x-posnic-signature']).toBe(expected);
    const delivery = db.collection(wh.DELIVERIES).rows[0];
    expect(delivery.status).toBe('delivered');
    expect(delivery.payload).toEqual({
      event: 'change',
      entity: 'sales',
      at: 'T',
      shop: 'shop_one',
      /* Always present, even when the publisher did not know them: a receiver
         can assert on the shape. */
      seller_id: '',
      seller_name: '',
    });
  });

  test('the body names the shop that sent it', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://example.com/hook', events: ['items'] });
    const seen = [];
    global.fetch = jest.fn(async (url, init) => {
      seen.push({ url, init });
      return { status: 200 };
    });

    await wh.publish(db, 'shop_one', {
      entity: 'items',
      at: 'T',
      seller_id: 'lic_123',
      seller_name: 'Kamran Sports',
    });
    await flush();

    const body = JSON.parse(seen[0].init.body);
    expect(body.seller_id).toBe('lic_123');
    expect(body.seller_name).toBe('Kamran Sports');
    expect(body.shop).toBe('shop_one');
    // The signature covers the whole body, so these fields are authenticated
    // like everything else rather than trusted.
    expect(seen[0].init.headers['x-posnic-signature']).toBe(
      'sha256=' +
        crypto
          .createHmac('sha256', db.collection(wh.SUBS).rows[0].secret)
          .update(seen[0].init.body)
          .digest('hex')
    );
  });

  test('only subscriptions listening to the entity fire', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://a.example/h', events: ['items'] });
    global.fetch = async () => {
      throw new Error('should not be called');
    };
    expect(await wh.publish(db, 's', { entity: 'sales', at: 'T' })).toBe(0);
  });

  test('a failure schedules backoff; a pending delivery coalesces the next signal', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    global.fetch = async () => {
      throw new Error('refused');
    };

    await wh.publish(db, 's', { entity: 'sales', at: 'T1' });
    await flush();
    const delivery = db.collection(wh.DELIVERIES).rows[0];
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextAt.getTime()).toBeGreaterThan(Date.now());

    // rush of writes while pending -> no second row
    expect(await wh.publish(db, 's', { entity: 'sales', at: 'T2' })).toBe(0);
    expect(db.collection(wh.DELIVERIES).rows).toHaveLength(1);
  });

  test('never throws into the caller, whatever the db does', async () => {
    const broken = {
      collection: () => {
        throw new Error('db down');
      },
    };
    await expect(wh.publish(broken, 's', { entity: 'sales', at: 'T' })).resolves.toBe(0);
  });
});

describe('drainDue', () => {
  test('throttled per db name, retries due rows, kills orphans', async () => {
    const db = fakeDb();
    const sub = await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    // one due retry, one orphan (subscription gone)
    await db.collection(wh.DELIVERIES).insertOne({
      subscription_id: sub.id,
      payload: { event: 'change', entity: 'sales', at: 'T', shop: 's' },
      status: 'pending',
      attempts: 1,
      nextAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    });
    await db.collection(wh.DELIVERIES).insertOne({
      subscription_id: 'gone',
      payload: { event: 'change', entity: 'sales', at: 'T', shop: 's' },
      status: 'pending',
      attempts: 1,
      nextAt: new Date(Date.now() - 1000),
      createdAt: new Date(),
    });
    global.fetch = async () => ({ status: 204 });

    const unique = 'drain_test_' + Date.now();
    const n = await wh.drainDue(db, unique);
    await flush();
    expect(n).toBe(1);
    const rows = db.collection(wh.DELIVERIES).rows;
    expect(rows.find((r) => String(r.subscription_id) === String(sub.id)).status).toBe('delivered');
    expect(rows.find((r) => r.subscription_id === 'gone').status).toBe('dead');

    // second call within the window is a no-op by throttle
    expect(await wh.drainDue(db, unique)).toBe(0);
  });
});

describe('retry and dead-letter contract (#75, parent #34)', () => {
  test('a timeout gets a safe retry code and bounded backoff', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    global.fetch = async () => {
      const error = new Error('private.internal.example timed out with token=secret');
      error.name = 'TimeoutError';
      throw error;
    };

    await wh.publish(db, 'private-shop-name', { entity: 'sales', at: 'T' });
    await flush();
    const row = db.collection(wh.DELIVERIES).rows[0];
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastErrorCode).toBe('timeout');
    expect(JSON.stringify(row)).not.toContain('private.internal.example');
    expect(JSON.stringify(row)).not.toContain('token=secret');
    expect(row.nextAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('a 500 retries, while a non-retryable 400 dead-letters immediately', async () => {
    const retryDb = fakeDb();
    await wh.addSubscription(retryDb, { url: 'https://a.example/h', events: ['sales'] });
    global.fetch = async () => ({ status: 500 });
    await wh.publish(retryDb, 's', { entity: 'sales', at: 'T' });
    await flush();
    expect(retryDb.collection(wh.DELIVERIES).rows[0]).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'http_5xx',
    });

    const deadDb = fakeDb();
    await wh.addSubscription(deadDb, { url: 'https://b.example/h', events: ['sales'] });
    global.fetch = async () => ({ status: 400 });
    await wh.publish(deadDb, 'private-shop', { entity: 'sales', at: 'private-time' });
    await flush();
    const dead = deadDb.collection(wh.DELIVERIES).rows[0];
    expect(dead).toMatchObject({ status: 'dead', attempts: 1, lastErrorCode: 'http_4xx' });
    expect(dead.deadLetteredAt).toBeInstanceOf(Date);
    expect(dead.payload).toEqual({ event: 'change', entity: 'sales' });
    expect(dead).not.toHaveProperty('lastError');
  });

  test('a retry keeps the delivery id stable and can succeed', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    const ids = [];
    let calls = 0;
    global.fetch = async (_url, init) => {
      ids.push(init.headers['x-posnic-delivery']);
      calls++;
      return { status: calls === 1 ? 500 : 204 };
    };

    await wh.publish(db, 's', { entity: 'sales', at: 'T' });
    await flush();
    const row = db.collection(wh.DELIVERIES).rows[0];
    row.nextAt = new Date(Date.now() - 1);
    expect(await wh.drainDue(db, 'retry_success_' + Date.now())).toBe(1);
    await flush();
    expect(row).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(ids).toEqual([String(row._id), String(row._id)]);
  });

  test('permanent 500 failure stops at MAX_ATTEMPTS and leaves a sanitized record', async () => {
    const db = fakeDb();
    await wh.addSubscription(db, { url: 'https://a.example/h', events: ['sales'] });
    global.fetch = async () => ({ status: 500 });
    await wh.publish(db, 'private-shop', { entity: 'sales', at: 'private-time' });
    await flush();
    const row = db.collection(wh.DELIVERIES).rows[0];

    for (let attempt = 1; attempt < wh.MAX_ATTEMPTS; attempt++) {
      row.nextAt = new Date(Date.now() - 1);
      expect(await wh.drainDue(db, `permanent_${Date.now()}_${attempt}`)).toBe(1);
      await flush();
    }

    expect(row).toMatchObject({
      status: 'dead',
      attempts: wh.MAX_ATTEMPTS,
      lastErrorCode: 'http_5xx',
    });
    expect(row.deadLetteredAt).toBeInstanceOf(Date);
    expect(row.payload).toEqual({ event: 'change', entity: 'sales' });
    expect(row).not.toHaveProperty('lastError');
  });
});

/*
 * The provisioned ShuttleZone subscription.
 *
 * What must hold: the INJECTED secret is used and never replaced by a minted
 * one (a secret generated on this machine is one the website can never verify);
 * the row is marked so the shop cannot remove it; drift of every kind is
 * repaired rather than tolerated; and a hand-added row for the same endpoint is
 * adopted instead of duplicated.
 */
const SHZ = {
  SHUTTLEZONE_WEBHOOK_URL: 'https://shuttlezone.app/api/pos/webhook/key_abc',
  SHUTTLEZONE_WEBHOOK_SECRET: 'secret-from-the-website',
  SHUTTLEZONE_WEBHOOK_EVENTS: 'items,categories,sales,receivings',
};
const quiet = { warn: () => {}, error: () => {}, log: () => {} };

describe('ensureProvisionedSubscription', () => {
  test('does nothing at all when this build was not provisioned', async () => {
    const db = fakeDb();
    const r = await wh.ensureProvisionedSubscription(db, { env: {}, log: quiet });
    expect(r).toEqual({ ok: false, reason: 'not_configured' });
    expect(db.collection(wh.SUBS).rows).toHaveLength(0);
  });

  test('inserts the row with the injected secret, never a generated one', async () => {
    const db = fakeDb();
    const r = await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    expect(r).toEqual({ ok: true, action: 'created' });
    const row = db.collection(wh.SUBS).rows[0];
    expect(row.secret).toBe('secret-from-the-website');
    expect(row.url).toBe(SHZ.SHUTTLEZONE_WEBHOOK_URL);
    expect(row.events).toEqual(['items', 'categories', 'sales', 'receivings']);
    expect(row.active).toBe(true);
    expect(row.locked).toBe(true);
    expect(row.provider).toBe(wh.PROVIDER);
  });

  test('config: events default, and junk is not honoured', async () => {
    expect(
      wh.provisionedConfig({ SHUTTLEZONE_WEBHOOK_URL: 'u', SHUTTLEZONE_WEBHOOK_SECRET: 's' }).events
    ).toEqual(['items', 'categories', 'sales', 'receivings']);
    expect(
      wh.provisionedConfig({
        SHUTTLEZONE_WEBHOOK_URL: 'u',
        SHUTTLEZONE_WEBHOOK_SECRET: 's',
        SHUTTLEZONE_WEBHOOK_EVENTS: 'items,  SALES ,,;drop',
      }).events
    ).toEqual(['items', 'sales']);
  });

  test('a plain http endpoint is refused outright', async () => {
    const db = fakeDb();
    const r = await wh.ensureProvisionedSubscription(db, {
      env: { ...SHZ, SHUTTLEZONE_WEBHOOK_URL: 'http://shuttlezone.app/hook' },
      log: quiet,
    });
    expect(r.ok).toBe(false);
    expect(db.collection(wh.SUBS).rows).toHaveLength(0);
  });

  test('is idempotent: the second call is a no-op, not a second row', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const again = await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    expect(again).toEqual({ ok: true, action: 'ok' });
    expect(db.collection(wh.SUBS).rows).toHaveLength(1);
  });

  test('repairs every kind of drift - the DB reset, the restore, the hand edit', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const row = db.collection(wh.SUBS).rows[0];

    row.active = false;
    row.url = 'https://somewhere.else/hook';
    row.events = ['sales'];
    row.locked = false;
    row.secret = 'a-secret-somebody-else-made-up';

    const r = await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    expect(r.ok).toBe(true);
    expect(r.action).toBe('repaired');
    expect(r.fields.sort()).toEqual(['active', 'events', 'locked', 'secret', 'url']);
    expect(row).toMatchObject({
      active: true,
      url: SHZ.SHUTTLEZONE_WEBHOOK_URL,
      events: ['items', 'categories', 'sales', 'receivings'],
      locked: true,
      provider: wh.PROVIDER,
      // The website holds this value; anything else makes every delivery 401.
      secret: 'secret-from-the-website',
    });
    // Still one row - repaired in place, not replaced.
    expect(db.collection(wh.SUBS).rows).toHaveLength(1);
  });

  test('a row stripped of every marker is unidentifiable, so a correct one is made', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const row = db.collection(wh.SUBS).rows[0];
    /* Nothing left to recognise it by: no marker, and not the endpoint we
       call. It cannot be assumed to be ours, and leaving the shop without a
       working feed while we guess is the worse error - so a correct row is
       added beside it. */
    delete row.provider;
    row.url = 'https://not-ours.example.com/hook';

    const r = await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    expect(r.action).toBe('created');
    const rows = db.collection(wh.SUBS).rows;
    expect(rows).toHaveLength(2);
    const ours = rows.find((x) => x.provider === wh.PROVIDER);
    expect(ours).toMatchObject({
      url: SHZ.SHUTTLEZONE_WEBHOOK_URL,
      locked: true,
      secret: 'secret-from-the-website',
    });
  });

  test('event order is not drift', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const row = db.collection(wh.SUBS).rows[0];
    row.events = ['receivings', 'sales', 'categories', 'items'];
    const r = await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    expect(r.action).toBe('ok');
  });

  test('a row somebody added by hand for the same endpoint is adopted, not duplicated', async () => {
    const db = fakeDb();
    await db.collection(wh.SUBS).insertOne({
      url: SHZ.SHUTTLEZONE_WEBHOOK_URL,
      secret: 'typed-by-hand',
      events: ['items'],
      active: true,
      description: '',
      createdAt: new Date(),
    });

    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });

    expect(db.collection(wh.SUBS).rows).toHaveLength(1);
    expect(db.collection(wh.SUBS).rows[0]).toMatchObject({
      locked: true,
      provider: wh.PROVIDER,
      events: ['items', 'categories', 'sales', 'receivings'],
    });
  });

  test('the locked row cannot be deleted, and a shop-created one still can', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const locked = db.collection(wh.SUBS).rows[0];

    expect(await wh.removeSubscription(db, String(locked._id))).toEqual({
      ok: false,
      reason: 'locked',
    });
    expect(db.collection(wh.SUBS).rows).toHaveLength(1);

    const own = await wh.addSubscription(db, {
      url: 'https://shop.example.com/hook',
      events: ['sales'],
    });
    expect(own.ok).toBe(true);
    expect((await wh.removeSubscription(db, String(own.id))).ok).toBe(true);
    expect(db.collection(wh.SUBS).rows).toHaveLength(1);
    expect(db.collection(wh.SUBS).rows[0].locked).toBe(true);
  });

  test('a locked row still receives its events, and a disabled one does not', async () => {
    const db = fakeDb();
    await wh.ensureProvisionedSubscription(db, { env: SHZ, log: quiet });
    const row = db.collection(wh.SUBS).rows[0];
    global.fetch = jest.fn(async () => ({ status: 202 }));

    expect(await wh.publish(db, 'shop', { entity: 'items', at: 'now' })).toBe(1);
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    db.collection(wh.DELIVERIES).rows.length = 0;
    row.active = false;
    expect(await wh.publish(db, 'shop', { entity: 'items', at: 'now' })).toBe(0);
  });
});
