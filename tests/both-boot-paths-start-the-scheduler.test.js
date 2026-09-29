'use strict';

/*
 * A BOOT FACT ONLY ONE ENTRY POINT KNOWS IS A BOOT FACT THAT IS WRONG.
 *
 * This API boots two ways, and they are not the same file:
 *
 *   api/server.js   the hosted and self-hosted server. Connects mongoose
 *                   itself, runs migrations, listens itself.
 *   src/server.js   the DESKTOP till. Requires api/app.js in-process, connects,
 *                   listens. It never requires api/server.js.
 *
 * The background timers used to be started in api/server.js alone, and both of
 * them matter to a paired seller:
 *
 *   realtime/scheduler          the only caller of the ShuttleZone pairing,
 *                               which writes the shop's posnic_... API token
 *                               and its locked webhook subscription.
 *   services/unanswered-orders  the shop's declared rule for orders nobody
 *                               answered.
 *
 * So a packaged installer provisioned neither, and ShuttleZone's own Test
 * connection was answered 401 - while every local test passed, because
 * `npm run dev` runs api/server.js. That is the shape of the fault this file
 * makes impossible to repeat: not "the scheduler is broken", but "one boot path
 * starts it and the other does not".
 *
 * It DERIVES the requirement rather than restating filenames: it finds every
 * file in the runtime trees that listens with app.listen, and asserts each one
 * starts the boot timers. A third boot path added later is caught without
 * anybody remembering to edit this file. The lesson is the one
 * tests/what-ships-beside-the-server.test.js already learned from
 * src/handset-slots.js: an assertion can be green for the whole life of the bug
 * it names, so derive, do not restate.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/* The runtime trees. Vendored data, docs and build output are not boot paths. */
const CODE_ROOTS = ['api', 'src'];
const SKIP_DIRS = new Set([
  'node_modules',
  'tests',
  'test',
  '__tests__',
  'coverage',
  'dist',
  'builds',
  'public',
  'docs',
]);

function jsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) jsFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/* Source without comments, so a comment ABOUT listening is not read as a boot
   path and a commented-out timer is not mistaken for a live one. */
function code(file) {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

test('the two boot paths this file is about are both still here', () => {
  /* If either moves, the discovery below would find one of them and this test
     would be quietly checking half of the surface it claims to. */
  for (const file of ['api/server.js', 'src/server.js']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, file)),
      `${file} moved - find where the API is booted from now`
    );
  }
});

test('EVERY FILE THAT LISTENS WITH app.listen STARTS THE BOOT TIMERS', () => {
  const bootPaths = [];
  for (const root of CODE_ROOTS) {
    for (const file of jsFiles(path.join(ROOT, root))) {
      /* app.listen, not server.listen: this is "boots the express API", and
         the callback servers in local-ports.js, browser-cloud-auth.js and
         shuttlezone-tunnel.js are not that. */
      if (/app\.listen\s*\(/.test(code(file))) bootPaths.push(file);
    }
  }

  /* An assertion over an empty list passes for ever, so the discovery is
     checked before it is trusted. Both known entry points must be in it. */
  const found = bootPaths.map(rel).sort();
  for (const known of ['api/server.js', 'src/server.js']) {
    assert.ok(
      found.includes(known),
      `${known} no longer calls app.listen, so this check found ${JSON.stringify(found)} `
        + 'and is no longer testing the boot path you think it is'
    );
  }

  const missing = [];
  for (const file of bootPaths) {
    const text = code(file);
    /* The shared helper, or the scheduler directly. Both are honest; the
       helper is the one that keeps the paths in step. */
    const viaHelper = /startBootTimers\s*\(/.test(text);
    const direct = /require\(\s*['"][^'"]*realtime\/scheduler['"]\s*\)/.test(text);
    if (!viaHelper && !direct) missing.push(rel(file));
  }

  assert.deepStrictEqual(
    missing,
    [],
    'these boot paths listen but never start the boot timers, so a shop booted '
      + 'through one of them never provisions its ShuttleZone API token or its '
      + 'webhook subscription, and the website answers 401:\n  ' + missing.join('\n  ')
  );
});

test('and the shared list still starts the timers that matter', () => {
  const timers = code(path.join(ROOT, 'api', 'src', 'boot-timers.js'));

  assert.match(timers, /realtime\/scheduler/, 'the shared boot list dropped the scheduler');
  assert.match(
    timers,
    /services\/unanswered-orders/,
    'the shared boot list dropped the unanswered-order rule'
  );

  /* Named, because this is the one whose absence cost a seller their pairing,
     and because it is the log line support looks for on a real install. */
  assert.match(
    timers,
    /Webhook delivery scheduler running/,
    'the scheduler no longer says it started, which is the line a support session reads'
  );
});
