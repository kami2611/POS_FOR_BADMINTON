'use strict';

/**
 * Unit tests for src/realtime/scheduler.js (INTEGRATIONS_ROADMAP I4.5 ask).
 *
 * What must hold: a shop nobody touches still gets its queued deliveries
 * drained on a timer; a delivery that proves the line is back forces one early
 * pass and no more than that; every shop this process serves is covered, and
 * server databases are not mistaken for shops; and none of it can throw into a
 * boot path or hold the process open.
 */

jest.mock('../../../src/realtime/webhooks', () => ({
  drainDue: jest.fn(async () => 0),
  onDeliverySuccess: jest.fn(() => () => {}),
  ensureProvisionedSubscription: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
  provisionedConfig: jest.fn(() => ({ url: '', secret: '', events: [] })),
}));
jest.mock('../../../src/services/shuttlezone-pairing.service', () => ({
  ensureProvisionedToken: jest.fn(async () => ({ ok: false, reason: 'not_configured' })),
}));
jest.mock('../../../src/db/tenant-connections', () => ({
  isServableName: (name) => {
    const text = String(name == null ? '' : name);
    if (!/^[A-Za-z0-9_-]{1,63}$/.test(text)) return false;
    return !['admin', 'local', 'config'].includes(text.toLowerCase());
  },
}));
jest.mock('../../../src/v1', () => ({ ensureUpdatedDates: jest.fn(async () => 0) }));

const scheduler = require('../../../src/realtime/scheduler');
const webhooks = require('../../../src/realtime/webhooks');
const pairing = require('../../../src/services/shuttlezone-pairing.service');
const v1 = require('../../../src/v1');

const quiet = { warn: () => {}, log: () => {}, error: () => {} };
const tenant = (name) => ({ db: { databaseName: name }, dbName: name });

beforeEach(() => {
  jest.clearAllMocks();
  scheduler.stop();
  webhooks.drainDue.mockResolvedValue(0);
});

afterEach(() => {
  scheduler.stop();
});

describe('knownTenants', () => {
  test('covers the pool connection and every shop served from it', () => {
    const base = {
      name: 'PosnicPro',
      db: {},
      otherDbs: [
        { name: 'shop_a', db: {} },
        { name: 'shop_b', db: {} },
      ],
    };
    const names = scheduler.knownTenants({ connection: base }).map((t) => t.dbName);
    expect(names).toEqual(['PosnicPro', 'shop_a', 'shop_b']);
  });

  test('a server database is not a shop, and neither is a half-built one', () => {
    const base = {
      name: 'local',
      db: {},
      otherDbs: [
        { name: 'admin', db: {} },
        { name: 'shop_c' }, // no db yet - never served
        { name: 'shop_c', db: {} },
        { name: 'shop_c', db: {} }, // duplicates collapse
        { db: {} }, // no name
      ],
    };
    expect(scheduler.knownTenants({ connection: base }).map((t) => t.dbName)).toEqual(['shop_c']);
  });

  test('a connection that has served nothing yields nothing', () => {
    expect(
      scheduler.knownTenants({ connection: { name: 'x', db: {}, otherDbs: [] } })
    ).toHaveLength(1);
    expect(scheduler.knownTenants({ connection: {} })).toEqual([]);
  });
});

describe('tick', () => {
  test('drains every shop and reports what it moved', async () => {
    webhooks.drainDue.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    const out = await scheduler.tick([tenant('a'), tenant('b')], { log: quiet });
    expect(out).toEqual({ drained: 3, failed: 0 });
    expect(webhooks.drainDue).toHaveBeenNthCalledWith(1, { databaseName: 'a' }, 'a', {
      force: false,
    });
  });

  test('also repairs items.updated_date, which is what makes a row reachable at all', async () => {
    await scheduler.tick([tenant('a')], { log: quiet });
    expect(v1.ensureUpdatedDates).toHaveBeenCalledWith({ databaseName: 'a' }, 'items');
  });

  test('re-asserts the platform subscription on every pass', async () => {
    await scheduler.tick([tenant('a'), tenant('b')], { log: quiet });
    expect(webhooks.ensureProvisionedSubscription).toHaveBeenCalledTimes(2);
  });

  /*
   * The other half of the pairing, and the reason it lives here rather than at
   * the end of the first-run wizard: the token needs a licence and a branch, so
   * it cannot be provisioned before the shop exists - but a timer retries until
   * it does, and heals a restored database on its own.
   */
  test('re-asserts the website token on every pass, for every shop', async () => {
    await scheduler.tick([tenant('a'), tenant('b')], { log: quiet });
    expect(pairing.ensureProvisionedToken).toHaveBeenCalledTimes(2);
    expect(pairing.ensureProvisionedToken).toHaveBeenNthCalledWith(
      1,
      { databaseName: 'a' },
      {
        log: quiet,
      }
    );
  });

  test('a token that cannot be provisioned is counted, and the drain still runs', async () => {
    pairing.ensureProvisionedToken.mockRejectedValueOnce(new Error('read only'));
    const out = await scheduler.tick([tenant('a')], { log: quiet });
    expect(out.failed).toBe(1);
    expect(webhooks.drainDue).toHaveBeenCalledTimes(1);
  });

  test('an unpaired shop provisions no token and is not an error', async () => {
    /* The default mock: not_configured, which is every stock build. */
    const out = await scheduler.tick([tenant('a')], { log: quiet });
    expect(out.failed).toBe(0);
  });

  test('a provision that fails is counted, and the drain still runs', async () => {
    webhooks.ensureProvisionedSubscription.mockRejectedValueOnce(new Error('read only'));
    const out = await scheduler.tick([tenant('a')], { log: quiet });
    expect(out.failed).toBe(1);
    expect(webhooks.drainDue).toHaveBeenCalledTimes(1);
  });

  test('one broken shop cannot stop the others, and never throws', async () => {
    webhooks.drainDue.mockRejectedValueOnce(new Error('not authorised')).mockResolvedValueOnce(5);
    const out = await scheduler.tick([tenant('a'), tenant('b')], { log: quiet });
    expect(out).toEqual({ drained: 5, failed: 1 });
  });

  test('a failed repair does not fail the pass', async () => {
    v1.ensureUpdatedDates.mockRejectedValueOnce(new Error('nope'));
    await expect(scheduler.tick([tenant('a')], { log: quiet })).resolves.toEqual({
      drained: 0,
      failed: 0,
    });
  });

  test('skips half-built tenant records instead of crashing on them', async () => {
    await expect(scheduler.tick([null, {}, { dbName: 'x' }], { log: quiet })).resolves.toEqual({
      drained: 0,
      failed: 0,
    });
  });
});

describe('the timer', () => {
  test('drains on its own, with no shop traffic at all - the whole point', async () => {
    const listTenants = jest.fn(() => [tenant('a')]);
    scheduler.start({ everyMs: 15, listTenants, log: quiet });
    await new Promise((r) => setTimeout(r, 70));
    scheduler.stop();
    expect(webhooks.drainDue.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('start is idempotent and stop is clean', () => {
    const first = scheduler.start({ everyMs: 1000, listTenants: () => [], log: quiet });
    expect(scheduler.start({ everyMs: 1000, listTenants: () => [], log: quiet })).toBe(first);
    scheduler.stop();
    expect(scheduler.start({ everyMs: 1000, listTenants: () => [], log: quiet })).not.toBe(first);
    scheduler.stop();
  });

  test('it does not hold the process open', () => {
    const realSetInterval = global.setInterval;
    let unrefCalled = false;
    global.setInterval = (fn, ms) => {
      const t = realSetInterval(fn, ms);
      const realUnref = t.unref.bind(t);
      t.unref = () => {
        unrefCalled = true;
        return realUnref();
      };
      return t;
    };
    try {
      scheduler.start({ everyMs: 10_000, listTenants: () => [], log: quiet });
    } finally {
      global.setInterval = realSetInterval;
      scheduler.stop();
    }
    expect(unrefCalled).toBe(true);
  });
});

describe('the line is back', () => {
  test('a delivered signal forces one early pass, and a second is absorbed', async () => {
    jest.useFakeTimers();
    try {
      const db = { databaseName: 'a' };
      scheduler.forceFor(db, { listTenants: () => [tenant('a')], log: quiet });
      scheduler.forceFor(db, { listTenants: () => [tenant('a')], log: quiet });
      await jest.advanceTimersByTimeAsync(1000);
      expect(webhooks.drainDue).toHaveBeenCalledTimes(1);
      expect(webhooks.drainDue.mock.calls[0][2]).toEqual({ force: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('forced passes are rate-limited: a burst of successes is not a storm', async () => {
    jest.useFakeTimers();
    try {
      const db = { databaseName: 'a' };
      const opts = { listTenants: () => [tenant('a')], log: quiet };
      scheduler.forceFor(db, opts);
      await jest.advanceTimersByTimeAsync(1000);
      expect(webhooks.drainDue).toHaveBeenCalledTimes(1);

      // Immediately after: inside the floor, so nothing new is scheduled.
      scheduler.forceFor(db, opts);
      await jest.advanceTimersByTimeAsync(1000);
      expect(webhooks.drainDue).toHaveBeenCalledTimes(1);

      // Past the floor: allowed again.
      await jest.advanceTimersByTimeAsync(scheduler.FORCE_FLOOR_MS + 500);
      scheduler.forceFor(db, opts);
      await jest.advanceTimersByTimeAsync(1000);
      expect(webhooks.drainDue).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a shop the pool does not know yet is still drained, by its own handle', async () => {
    jest.useFakeTimers();
    try {
      const db = { databaseName: 'fresh' };
      scheduler.forceFor(db, { listTenants: () => [], log: quiet });
      await jest.advanceTimersByTimeAsync(1000);
      expect(webhooks.drainDue).toHaveBeenCalledWith(db, 'fresh', { force: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('no db means nothing to do, and no throw', () => {
    expect(() => scheduler.forceFor(null, { log: quiet })).not.toThrow();
    expect(webhooks.drainDue).not.toHaveBeenCalled();
  });
});
