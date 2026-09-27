'use strict';

/*
 * Check a pairing seed BEFORE an installer is built from it.
 *
 * Run this between staging the seed and running electron-builder:
 *
 *   node scripts/verify-pairing.js
 *
 * WHY IT EXISTS. Every mistake this checks for is one that produces no error at
 * build time and no error at the shop - the installer goes out, installs
 * cleanly, and the website is simply never updated. Two in particular:
 *
 *   - a seed that declares a tunnel but ships no cloudflared binary. Packaged
 *     builds look for the binary in `resources/cloudflared/`, and electron-builder
 *     SKIPS a missing `from` path without saying anything, so the build succeeds
 *     and the tunnel silently does not exist.
 *
 *   - an API token that does not begin with `posnic_`. The API's resolver only
 *     ever looks at prefixed values, so this one would be stored, listed on the
 *     Integrations screen, and permanently unable to authenticate.
 *
 * A stock build - no seed at all - passes trivially. That is the normal case and
 * it is not something to warn about.
 *
 * The validation is deliberately the same code the application runs at launch
 * (`tunnelSeed` from src/shuttlezone-tunnel.js), so this cannot drift from what
 * the till will actually do with the file.
 */

const fs = require('fs');
const path = require('path');

const { tunnelSeed } = require('../src/shuttlezone-tunnel');

const ROOT = path.join(__dirname, '..');
const SEED_DIR = path.join(ROOT, 'builds', 'shuttlezone-seed');
const SEED_FILE = path.join(SEED_DIR, 'shuttlezone.json');
const BINARY_DIR = path.join(ROOT, 'builds', 'cloudflared');
const TOKEN_PREFIX = 'posnic_';

const problems = [];
const notes = [];

function problem(message) {
  problems.push(message);
}

function note(message) {
  notes.push(message);
}

function checkStrings(seed) {
  const url = String(seed.webhookUrl || '').trim();
  const secret = String(seed.webhookSecret || '').trim();

  if (url && !/^https:\/\//i.test(url)) {
    /* The API signs every delivery; plain HTTP would send the shop's change
       signals - and the signature - in the clear. */
    problem(`webhookUrl must be https (found "${url}")`);
  }
  if (url && !secret) problem('webhookUrl is set but webhookSecret is empty');
  if (secret && !url) problem('webhookSecret is set but webhookUrl is empty');
  if (secret && secret.length < 16) {
    problem(`webhookSecret looks too short to be a secret (${secret.length} characters)`);
  }

  const token = String(seed.apiToken || '').trim();
  if (!token) {
    note('no apiToken in the seed - the shop will not be readable by a website');
  } else if (!token.startsWith(TOKEN_PREFIX)) {
    problem(
      `apiToken must start with "${TOKEN_PREFIX}" - the API only recognises prefixed ` +
        'tokens, so this value could never authenticate'
    );
  } else if (token.length < TOKEN_PREFIX.length + 32) {
    problem(`apiToken is too short (${token.length} characters) to be a credential`);
  }
}

function checkTunnel(seed) {
  if (!seed.tunnel) {
    note('no tunnel in the seed - the shop is not reachable from the internet');
    return;
  }

  /* Same validation the till runs, so a build cannot pass this and then be
     refused at the shop. */
  const parsed = tunnelSeed(seed);
  if (!parsed) {
    problem(
      'tunnel is malformed: needs a lowercase hostname, a tunnel id, and a bare ' +
        'credentials filename (no path separators)'
    );
    return;
  }

  const credentialsFile = path.join(SEED_DIR, parsed.credentialsFile);
  if (!fs.existsSync(credentialsFile)) {
    problem(
      `tunnel credentials are missing: expected ${path.relative(ROOT, credentialsFile)}`
    );
  }

  /*
   * The Windows binary is what the packaged installer looks for. Checked
   * explicitly rather than "some cloudflared exists" - a developer's own macOS
   * copy would pass that check and produce a Windows build with no tunnel.
   */
  const windowsBinary = path.join(BINARY_DIR, 'cloudflared.exe');
  if (!fs.existsSync(windowsBinary)) {
    problem(
      'the seed declares a tunnel but builds/cloudflared/cloudflared.exe is missing.\n' +
        '    Run: node scripts/fetch-cloudflared.js --win\n' +
        '    (electron-builder skips a missing extraResources path in silence, so\n' +
        '     without this check the build would succeed and ship no tunnel.)'
    );
  }
}

function main() {
  if (!fs.existsSync(SEED_FILE)) {
    console.log('[pairing] no seed - this is a stock, unpaired build');
    console.log('[pairing] ok');
    return;
  }

  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (e) {
    console.error(`[pairing] ${path.relative(ROOT, SEED_FILE)} is not valid JSON: ${e.message}`);
    process.exit(1);
  }

  const seller = String(seed.seller || '').trim();
  console.log(`[pairing] seed for: ${seller || '(no seller name)'}`);
  if (!seller) note('no seller name in the seed (cosmetic: it is only used in log lines)');

  checkStrings(seed);
  checkTunnel(seed);

  for (const message of notes) console.log(`[pairing] note: ${message}`);

  if (problems.length) {
    console.error('');
    for (const message of problems) console.error(`[pairing] PROBLEM: ${message}`);
    console.error('');
    console.error(`[pairing] refusing to build with ${problems.length} problem(s)`);
    process.exit(1);
  }

  console.log('[pairing] ok');
}

main();
