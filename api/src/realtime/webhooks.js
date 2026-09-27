'use strict';
/*
 * Webhooks (INTEGRATION_PLATFORM_ARCHITECTURE step 1).
 *
 * The S2 change-event seam already knows the moment anything in a shop
 * changes; this module fans that signal out to registered HTTPS endpoints so
 * an accounting system, an e-commerce sync or any counterparty learns within
 * seconds instead of polling.
 *
 * The contract (deliberately coarse in v1, same honesty as the bell):
 *   POST <url>  body {event:'change', entity, at, shop}
 *   headers     X-Posnic-Signature: sha256=<HMAC-SHA256(body, secret)>
 *               X-Posnic-Delivery: <delivery id>   X-Posnic-Event: change
 * The payload carries NO business data - the receiver fetches through its
 * own scoped credentials, so a leaked webhook secret alone leaks nothing.
 *
 * Delivery discipline (the outbox's, restated for HTTP):
 *  - a delivery row is written BEFORE the attempt (durable intent),
 *  - failures retry with exponential backoff (1m, 5m, 25m, ~2h, ~10h),
 *  - after MAX_ATTEMPTS the row is marked dead and left visible - a
 *    subscriber's outage must be diagnosable, never silent,
 *  - per (subscription, entity) COALESCING while a delivery is pending:
 *    a rush of sales becomes one "sales changed", not a queue of them.
 *  - retries drain lazily on the shop's own traffic (no global timers - a
 *    shard must not need a scheduler per tenant).
 *
 * Everything is fire-safe: webhooks are a courtesy to outsiders and may
 * never slow or fail the write that triggered them.
 */

const crypto = require('crypto');

/*
 * Delivered-signal listeners (realtime/scheduler.js). A set of callbacks rather
 * than a direct require, so this module stays unaware of the scheduler that
 * requires IT. A listener is a courtesy like everything else here: one that
 * throws is swallowed, never carried back into the delivery. */
const deliveredListeners = new Set();

function onDeliverySuccess(fn) {
  if (typeof fn !== 'function') return () => {};
  deliveredListeners.add(fn);
  return () => deliveredListeners.delete(fn);
}

function notifyDelivered(db) {
  for (const fn of deliveredListeners) {
    try {
      fn(db);
    } catch (e) {
      /* never let a listener break a delivery */
    }
  }
}

const SUBS = 'webhook_subscriptions';
const DELIVERIES = 'webhook_deliveries';
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [60e3, 300e3, 1500e3, 7500e3, 37500e3];
const TIMEOUT_MS = 10_000;
const DRAIN_EVERY_MS = 60_000; // how often lazy draining may run, per process
const drainLast = new Map(); // dbName -> ts

/*
 * THE PLATFORM SUBSCRIPTION.
 *
 * A shop installs this build and never touches the website's admin panel, so
 * the site's change signals have to leave the building on their own - and the
 * shop must not be able to switch them off, by accident or otherwise. The
 * three values below are injected when the seller's installer is assembled:
 *
 *   SHUTTLEZONE_WEBHOOK_URL    https://shuttlezone.app/api/pos/webhook/<key>
 *   SHUTTLEZONE_WEBHOOK_SECRET the secret the website already holds
 *   SHUTTLEZONE_WEBHOOK_EVENTS items,categories,sales,receivings
 *
 * The secret is USED, never generated. addSubscription mints one with
 * crypto.randomBytes - which is right for a shop adding its own endpoint and
 * useless here, because a secret created on this machine is a secret the
 * website's verifier can never learn.
 *
 * The row is marked `provider` + `locked`: the shop can still add, edit and
 * remove its OWN webhooks, and cannot touch this one.
 */
const PROVIDER = 'shuttlezone';
const DEFAULT_PROVIDER_EVENTS = ['items', 'categories', 'sales', 'receivings'];
const PROVIDER_DESCRIPTION = 'ShuttleZone - keeps this shop up to date on its website';

/** The injected configuration, or nulls when this build was not provisioned. */
function provisionedConfig(env = process.env) {
  const url = String(env.SHUTTLEZONE_WEBHOOK_URL || '').trim();
  const secret = String(env.SHUTTLEZONE_WEBHOOK_SECRET || '').trim();
  const raw = String(env.SHUTTLEZONE_WEBHOOK_EVENTS || '').trim();
  const events = raw
    ? raw
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter((e) => /^[a-z_]{1,32}$/.test(e))
    : DEFAULT_PROVIDER_EVENTS;
  return { url, secret, events: events.length ? events : DEFAULT_PROVIDER_EVENTS };
}

/** Are two event lists the same set, whatever order they were written in? */
function sameEvents(a, b) {
  const left = [...new Set((Array.isArray(a) ? a : []).map(String))].sort();
  const right = [...new Set((Array.isArray(b) ? b : []).map(String))].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/* Store only stable, non-sensitive failure categories. Raw exception messages can
 * contain hostnames, query strings, credentials or payload fragments and do not
 * belong in durable delivery records. */
function classifyFailure(outcome) {
  const status = Number(outcome && outcome.status) || 0;
  if (status === 408) return { code: 'http_408', retryable: true };
  if (status === 429) return { code: 'http_429', retryable: true };
  if (status >= 500) return { code: 'http_5xx', retryable: true };
  if (status >= 400) return { code: 'http_4xx', retryable: false };
  if (outcome && ['AbortError', 'TimeoutError'].includes(outcome.errorName)) {
    return { code: 'timeout', retryable: true };
  }
  return { code: 'network_error', retryable: true };
}

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', String(secret)).update(body).digest('hex');
}

/** Only https (or loopback http for development) may receive shop events. */
function urlAllowed(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

async function listSubscriptions(db) {
  return db.collection(SUBS).find({}).sort({ createdAt: 1 }).toArray();
}

async function addSubscription(db, { url, events, description }) {
  if (!urlAllowed(url)) return { ok: false, reason: 'url must be https' };
  const wanted = Array.isArray(events) ? events.filter((e) => typeof e === 'string') : [];
  if (!wanted.length) return { ok: false, reason: 'at least one event entity required' };
  const secret = crypto.randomBytes(24).toString('hex');
  const row = {
    url: String(url),
    events: wanted,
    description: String(description || ''),
    secret,
    active: true,
    createdAt: new Date(),
  };
  const r = await db.collection(SUBS).insertOne(row);
  /* The secret is returned ONCE, at creation - the list endpoint never
     repeats it, the same discipline as every API key issuer. */
  return { ok: true, id: r.insertedId, secret };
}

async function removeSubscription(db, id) {
  const { ObjectId } = require('mongodb');
  if (!ObjectId.isValid(String(id))) return { ok: false };
  /* The platform row is not the shop's to remove. Deleting it would stop the
     website updating with nothing looking broken at the till - the exact
     silent failure the lock exists to prevent. The management screen never
     offers the control; this is the second line of defence, because a route is
     an endpoint anybody with a token can call. */
  const row = await db.collection(SUBS).findOne({ _id: new ObjectId(String(id)) });
  if (row && row.locked === true) return { ok: false, reason: 'locked' };
  const r = await db.collection(SUBS).deleteOne({ _id: new ObjectId(String(id)) });
  return { ok: r.deletedCount === 1 };
}

/**
 * Make sure this shop has the provisioned ShuttleZone subscription, exactly
 * as the injected configuration describes it.
 *
 * Idempotent, and safe to call on every drain tick - which is the point: a
 * database reset, a restore from backup, a reinstall, or somebody editing the
 * collection by hand would otherwise stop a shop's website updating silently,
 * and nothing at the till would look wrong.
 *
 * @param {object} db
 * @param {{env?: object, log?: Console, now?: Function}} [opts]
 * @returns {Promise<{ok: boolean, action?: string, reason?: string, fields?: string[]}>}
 */
async function ensureProvisionedSubscription(db, { env = process.env, log = console, now } = {}) {
  const clock = typeof now === 'function' ? now : () => new Date();
  const cfg = provisionedConfig(env);
  if (!cfg.url || !cfg.secret) return { ok: false, reason: 'not_configured' };
  if (!urlAllowed(cfg.url)) return { ok: false, reason: 'url must be https' };
  if (!db) return { ok: false, reason: 'no_database' };

  const col = db.collection(SUBS);
  /* Ours by marker, or by being the endpoint we are configured to call - a
     shop that added it by hand before an upgrade should be adopted, not
     duplicated. */
  const existing =
    (await col.findOne({ provider: PROVIDER })) || (await col.findOne({ url: cfg.url }));

  if (!existing) {
    await col.insertOne({
      url: cfg.url,
      /* The INJECTED secret. Never generated here - see the note above. */
      secret: cfg.secret,
      events: cfg.events,
      description: PROVIDER_DESCRIPTION,
      active: true,
      provider: PROVIDER,
      locked: true,
      createdAt: clock(),
      provisionedAt: clock(),
    });
    return { ok: true, action: 'created' };
  }

  const drift = {};
  if (existing.url !== cfg.url) drift.url = cfg.url;
  if (existing.active !== true) drift.active = true;
  if (!sameEvents(existing.events, cfg.events)) drift.events = cfg.events;
  if (existing.provider !== PROVIDER) drift.provider = PROVIDER;
  if (existing.locked !== true) drift.locked = true;
  /* A row whose secret is not the injected one signs everything with a value
     the website cannot verify: every delivery would be answered 401 and the
     shop's website would quietly stop updating. We hold the right value, so
     restoring it is the repair - it is not a new secret. */
  if (existing.secret !== cfg.secret) drift.secret = cfg.secret;

  const fields = Object.keys(drift);
  if (!fields.length) return { ok: true, action: 'ok' };
  await col.updateOne({ _id: existing._id }, { $set: { ...drift, provisionedAt: clock() } });
  log.warn('[webhooks] repaired the ShuttleZone subscription:', fields.join(', '));
  return { ok: true, action: 'repaired', fields };
}

async function attempt(db, delivery, sub) {
  const body = JSON.stringify(delivery.payload);
  let outcome;
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-posnic-signature': sign(sub.secret, body),
        'x-posnic-delivery': String(delivery._id),
        'x-posnic-event': delivery.payload.event,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    outcome = { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (err) {
    outcome = { ok: false, status: 0, errorName: err && err.name };
  }

  const attempts = (delivery.attempts || 0) + 1;
  const failure = outcome.ok ? null : classifyFailure(outcome);
  if (outcome.ok) {
    await db.collection(DELIVERIES).updateOne(
      { _id: delivery._id },
      {
        $set: {
          status: 'delivered',
          attempts,
          deliveredAt: new Date(),
          lastStatus: outcome.status,
        },
      }
    );
    /* The line is up. Tell whoever is listening (realtime/scheduler.js), so a
       queue that built up during an outage flushes now rather than at the next
       minute boundary. */
    notifyDelivered(db);
  } else if (!failure.retryable || attempts >= MAX_ATTEMPTS) {
    await db.collection(DELIVERIES).updateOne(
      { _id: delivery._id },
      {
        $set: {
          status: 'dead',
          attempts,
          lastStatus: outcome.status,
          lastErrorCode: failure.code,
          deadLetteredAt: new Date(),
        },
        /* The corpse keeps no shop identity: this row already lives in that
           shop's own database, so the fields were only ever duplication - and
           a dead row is the one place duplication has no use. Same rule
           payload.at and payload.shop already follow. */
        $unset: {
          lastError: '',
          'payload.at': '',
          'payload.shop': '',
          'payload.seller_id': '',
          'payload.seller_name': '',
        },
      }
    );
  } else {
    await db.collection(DELIVERIES).updateOne(
      { _id: delivery._id },
      {
        $set: {
          status: 'pending',
          attempts,
          nextAt: new Date(Date.now() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]),
          lastStatus: outcome.status,
          lastErrorCode: failure.code,
        },
        $unset: { lastError: '' },
      }
    );
  }
  return outcome.ok;
}

/**
 * Fan one change signal out. Called from the change-events seam; must never
 * throw and never block the response that triggered it.
 */
async function publish(db, shopName, event) {
  try {
    const subs = (await listSubscriptions(db)).filter(
      (s) => s.active && s.events.includes(event.entity)
    );
    if (!subs.length) return 0;

    let fired = 0;
    for (const sub of subs) {
      /* Coalesce: one pending delivery per (subscription, entity). */
      const existing = await db.collection(DELIVERIES).findOne({
        subscription_id: sub._id,
        'payload.entity': event.entity,
        status: 'pending',
      });
      if (existing) continue;

      const delivery = {
        subscription_id: sub._id,
        payload: {
          event: 'change',
          entity: event.entity,
          at: event.at,
          shop: shopName || '',
          /*
           * WHO IS SPEAKING (ShuttleZone integration ask I4.4).
           *
           * Without these a receiver cannot check that the till posting a
           * change is the one it is paired with, so pointing a shop at the
           * wrong storefront would publish one shop's stock on another shop's
           * website - silently, and looking perfectly healthy.
           *
           * Always present, possibly empty: a receiver can then assert on the
           * shape, and an install that genuinely cannot identify itself says so
           * instead of looking like a build that predates the field. The whole
           * body is covered by the signature, so these are authenticated like
           * everything else. `shop` is unchanged.
           */
          seller_id: String(event.seller_id || ''),
          seller_name: String(event.seller_name || ''),
        },
        status: 'pending',
        attempts: 0,
        createdAt: new Date(),
        nextAt: new Date(),
      };
      const r = await db.collection(DELIVERIES).insertOne(delivery);
      delivery._id = r.insertedId;
      fired++;
      attempt(db, delivery, sub).catch(() => {});
    }
    return fired;
  } catch (e) {
    return 0; // a courtesy, never a failure
  }
}

/**
 * Lazy retry drain: piggybacks on the shop's own traffic at most once a
 * minute per process, so a shard needs no per-tenant scheduler and an idle
 * shop costs nothing.
 *
 * `force` is for the scheduler's two deliberate exceptions to that throttle: a
 * delivery that just succeeded (the line is back, so the rest of the queue
 * should go), and the periodic pass, which is itself the guarantee for a shop
 * nobody is touching. Callers that force are expected to rate-limit
 * themselves - see realtime/scheduler.js.
 */
async function drainDue(db, dbName, { force = false } = {}) {
  const last = drainLast.get(dbName) || 0;
  if (!force && Date.now() - last < DRAIN_EVERY_MS) return 0;
  drainLast.set(dbName, Date.now());
  try {
    const due = await db
      .collection(DELIVERIES)
      .find({ status: 'pending', nextAt: { $lte: new Date() }, attempts: { $gt: 0 } })
      .limit(10)
      .toArray();
    if (!due.length) return 0;
    const subs = new Map((await listSubscriptions(db)).map((s) => [String(s._id), s]));
    let n = 0;
    for (const d of due) {
      const sub = subs.get(String(d.subscription_id));
      if (!sub || !sub.active) {
        await db.collection(DELIVERIES).updateOne(
          { _id: d._id },
          {
            $set: {
              status: 'dead',
              lastErrorCode: 'subscription_removed',
              deadLetteredAt: new Date(),
            },
            $unset: {
              lastError: '',
              'payload.at': '',
              'payload.shop': '',
              'payload.seller_id': '',
              'payload.seller_name': '',
            },
          }
        );
        continue;
      }
      attempt(db, d, sub).catch(() => {});
      n++;
    }
    return n;
  } catch (e) {
    return 0;
  }
}

async function recentDeliveries(db, limit = 50) {
  return db
    .collection(DELIVERIES)
    .find(
      {},
      {
        projection: {
          payload: 1,
          status: 1,
          attempts: 1,
          createdAt: 1,
          deliveredAt: 1,
          lastStatus: 1,
          lastErrorCode: 1,
          deadLetteredAt: 1,
          subscription_id: 1,
        },
      }
    )
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  publish,
  drainDue,
  onDeliverySuccess,
  listSubscriptions,
  addSubscription,
  removeSubscription,
  ensureProvisionedSubscription,
  provisionedConfig,
  recentDeliveries,
  sign,
  urlAllowed,
  classifyFailure,
  SUBS,
  DELIVERIES,
  MAX_ATTEMPTS,
  PROVIDER,
};
