'use strict';

/*
 * THE BACKGROUND TIMERS A BOOTED API PROCESS STARTS FOR ITSELF.
 *
 * There are two ways this API boots, and they are not the same file:
 *
 *   api/server.js   the hosted and self-hosted server. It connects mongoose
 *                   itself, runs migrations, and listens itself.
 *   src/server.js   the DESKTOP till. It requires api/app.js in-process,
 *                   connects, and listens. It never requires api/server.js.
 *
 * Both must start the same background work, and for a long time only the first
 * one did. That cost was invisible and total: `realtime/scheduler` is the only
 * caller of the ShuttleZone pairing, which writes the shop's `posnic_...` API
 * token and its locked webhook subscription. A packaged installer provisioned
 * NEITHER, so the website's own Test connection was answered 401 - while the
 * same code passed every local test, because `npm run dev` runs api/server.js.
 *
 * So the block lives here, once, and both boot paths call it. A boot fact that
 * only one entry point knows is a boot fact that is wrong on the other.
 *
 * Nothing here is fatal. A shop still sells without either timer; the till
 * simply does not sync until it next boots with the timer working.
 */

/**
 * Start the API's background timers.
 *
 * Each one starts inside its own try/catch, so a single failure cannot take the
 * others - or the caller - down with it, and the return value says what
 * happened rather than leaving a caller to parse the log.
 *
 * @param {{log?: Console}} [opts]
 * @returns {{started: string[], failed: Array<{name: string, message: string}>}}
 */
function startBootTimers({ log = console } = {}) {
  const started = [];
  const failed = [];

  const timers = [
    {
      name: 'unanswered-orders',
      start: () => require('./services/unanswered-orders').start(),
      ok: '✅ Unanswered-order rule running',
      warn: (e) => `[unanswered-orders] not started: ${e && e.message}`,
    },
    {
      /*
       * Change signals leaving the building by themselves, and the ShuttleZone
       * pairing that rides on the same tick. Webhook retries used to drain only
       * when somebody used the till, so a shop that edited its catalogue and
       * then closed for the night left its website stale - and nothing on
       * either side looked broken. See realtime/scheduler.js for what it does
       * and, more importantly, what it deliberately does not.
       */
      name: 'scheduler',
      start: () => require('./realtime/scheduler').start(),
      ok: '✅ Webhook delivery scheduler running',
      warn: (e) => `[webhooks] scheduler not started: ${e && e.message}`,
    },
  ];

  for (const timer of timers) {
    try {
      timer.start();
      started.push(timer.name);
      log.log(timer.ok);
    } catch (e) {
      failed.push({ name: timer.name, message: (e && e.message) || String(e) });
      log.warn(timer.warn(e));
    }
  }

  return { started, failed };
}

module.exports = { startBootTimers };
