'use strict';

/*
 * Delivering a shop's change signals on a timer.
 *
 * Retries used to drain lazily: they piggybacked on the shop's OWN api traffic,
 * once a minute per process (webhooks.drainDue). That costs nothing and it is
 * also wrong in one specific and very common case - a shop edits its catalogue,
 * loses the line, then closes for the night. Nobody touches the till again, so
 * nothing drains, and the shop's website stays stale until somebody next rings
 * up a sale. Nothing looks broken on either side: the till is fine, the website
 * is fine, the numbers are just old.
 *
 * So the same drain, on a timer, for every shop this process has served. The
 * lazy drain stays as a second trigger - it is what makes a busy shop's signal
 * near-instant - and a delivery that SUCCEEDS after a failure forces an early
 * pass, so a queue built up during an outage flushes as soon as the line is
 * genuinely back rather than at the next minute boundary.
 *
 * Two deliberate limits:
 *   - it only ever drains shops this process has already served, so a single
 *     tenant install (which is what ships to sellers) does one shop's worth of
 *     work and no discovery;
 *   - forced passes are rate-limited, because every drain is a query and a
 *     burst of successes must not become a storm of them.
 *
 * Never fatal. A shop that cannot deliver a webhook is still a till that works.
 */

const webhooks = require('./webhooks');
const shuttlezonePairing = require('../services/shuttlezone-pairing.service');
const { isServableName } = require('../db/tenant-connections');

const EVERY_MS = 60_000;
/* The floor between two forced passes. */
const FORCE_FLOOR_MS = 10_000;
/* How long to wait before acting on a delivered signal: long enough for the
   rest of a batch to land, short enough to feel immediate. */
const FORCE_DELAY_MS = 400;

let timer = null;
let forcedTimer = null;
let lastForcedAt = 0;
let unsubscribe = null;

/**
 * Every shop database this process can see.
 *
 * Enumerated from the connection pool rather than read from an env var: the
 * desktop build serves exactly one shop, while the hosted one serves many, and
 * `useDb` caches a child connection per shop already. So this is precisely the
 * set of shops that have been served - no registry to keep in sync, and no
 * discovery work for a shop nobody has asked about.
 *
 * @param {import('mongoose').Mongoose} [mongoose]
 * @returns {Array<{db: object, dbName: string}>}
 */
function knownTenants(mongoose) {
  const mg = mongoose || require('mongoose');
  const base = mg.connection;
  const out = [];
  const seen = new Set();

  const add = (conn) => {
    if (!conn || !conn.name || !conn.db) return;
    if (!isServableName(conn.name)) return; // server databases are not shops
    if (seen.has(conn.name)) return;
    seen.add(conn.name);
    out.push({ db: conn.db, dbName: conn.name });
  };

  add(base);
  for (const child of base.otherDbs || []) add(child);
  return out;
}

/**
 * One pass over the given shops.
 *
 * Also repairs each shop's `items.updated_date` once per process (see
 * src/v1): a row without one is invisible to a cursor walk, so an integrator
 * mirroring the catalogue would never see it, and the whole point of this timer
 * is that a shop nobody is touching still converges.
 *
 * @param {Array<{db: object, dbName: string}>} tenants
 * @param {{log?: Console, force?: boolean}} [opts]
 * @returns {Promise<{drained: number, failed: number}>}
 */
async function tick(tenants = [], { log = console, force = false } = {}) {
  const out = { drained: 0, failed: 0 };
  for (const tenant of tenants) {
    if (!tenant || !tenant.db) continue;
    /* Re-assert the platform subscription before draining: a restored,
       reset or hand-edited database is exactly the case where the shop's
       website has silently stopped receiving signals, and nothing at the
       till would look wrong. Idempotent, so the common path is one lookup. */
    try {
      await webhooks.ensureProvisionedSubscription(tenant.db, { log });
    } catch (e) {
      out.failed++;
      log.warn('[webhooks] could not provision for', tenant.dbName, e && e.message);
    }
    /*
     * The other half of the same pairing: the token the shop's website reads
     * with. Here for the same reasons as the subscription above - it is
     * idempotent, it needs a licence and a branch that only exist after the
     * wizard, and a restored or reset database is exactly when it has gone
     * missing. Before the wizard it is a silent no-op.
     */
    try {
      await shuttlezonePairing.ensureProvisionedToken(tenant.db, { log });
    } catch (e) {
      out.failed++;
      log.warn('[shuttlezone] could not provision a token for', tenant.dbName, e && e.message);
    }
    try {
      out.drained += (await webhooks.drainDue(tenant.db, tenant.dbName, { force })) || 0;
    } catch (e) {
      out.failed++;
      log.warn('[webhooks] drain failed for', tenant.dbName, e && e.message);
    }
    try {
      await require('../v1').ensureUpdatedDates(tenant.db, 'items');
    } catch (e) {
      /* The cursor guard already stops this from breaking a walk. */
    }
  }
  return out;
}

/**
 * Drain one shop soon, because something just proved the line is up.
 *
 * Public for the same reason `tick` is: a test can drive it without waiting on
 * a real timer.
 */
function forceFor(db, { listTenants = knownTenants, log = console } = {}) {
  if (!db) return;
  const now = Date.now();
  if (forcedTimer) return; // one pending forced pass is enough
  if (now - lastForcedAt < FORCE_FLOOR_MS) return;
  forcedTimer = setTimeout(() => {
    forcedTimer = null;
    lastForcedAt = Date.now();
    const tenants = listTenants().filter((t) => t.db === db || t.dbName === db.databaseName);
    tick(tenants.length ? tenants : [{ db, dbName: db.databaseName }], {
      log,
      force: true,
    }).catch(() => {});
  }, FORCE_DELAY_MS);
  /* The process must be able to exit without waiting for this. */
  if (typeof forcedTimer.unref === 'function') forcedTimer.unref();
}

/**
 * Start draining. Idempotent, and never fatal.
 *
 * @param {{everyMs?: number, listTenants?: Function, log?: Console}} [opts]
 */
function start({ everyMs = EVERY_MS, listTenants = knownTenants, log = console } = {}) {
  if (timer) return timer;
  try {
    if (!unsubscribe) {
      unsubscribe = webhooks.onDeliverySuccess((db) => forceFor(db, { listTenants, log }));
    }
    /* One pass right away: a machine that has just started is precisely the
       case where last night's queue is still waiting and the shop has not
       touched anything yet. */
    tick(listTenants(), { log }).catch((e) => {
      log.warn('[webhooks] first drain failed:', e && e.message);
    });
    timer = setInterval(() => {
      tick(listTenants(), { log }).catch((e) => {
        log.warn('[webhooks] scheduled drain failed:', e && e.message);
      });
    }, everyMs);
    /* The process must be able to exit without waiting for this. */
    if (typeof timer.unref === 'function') timer.unref();
  } catch (e) {
    log.warn('[webhooks] scheduler could not start:', e && e.message);
    timer = null;
  }
  return timer;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (forcedTimer) {
    clearTimeout(forcedTimer);
    forcedTimer = null;
  }
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  lastForcedAt = 0;
}

module.exports = {
  start,
  stop,
  tick,
  forceFor,
  knownTenants,
  EVERY_MS,
  FORCE_FLOOR_MS,
};
