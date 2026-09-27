'use strict';

/*
 * Write a seller's pairing seed from environment variables.
 *
 * Called by .github/workflows/build-seller-installer.yml, where the values come
 * from repository secrets. It exists as a file rather than a few lines of shell
 * for one reason: everything here is a way for the build to go wrong silently,
 * and each check below turns one of those into a sentence.
 *
 * The failures it is built around, all of which have a version that looks fine:
 *
 *   * A secret that was never set. GitHub substitutes an empty string, so the
 *     seed would be written with an empty token, `check:pairing` would pass it
 *     as a "note" (an unpaired build is a legitimate configuration), and the
 *     installer would go out to a shop that can never be read by its website.
 *     So a missing secret is an error here, not a default.
 *
 *   * The WRONG TUNNEL'S credentials. Copy the JSON from the previous seller's
 *     `cloudflared tunnel create` and the till runs a tunnel for a hostname
 *     that is not the one in the seed. Nothing errors: the tunnel connects,
 *     the hostname resolves to a different tunnel, and the website times out
 *     against an address that answers. The TunnelID is cross-checked here.
 *
 *   * A credentials file that is not JSON, usually base64 of the wrong thing.
 *
 * Run locally to test your secrets without a build:
 *   SHUTTLEZONE_WEBHOOK_URL=... node .github/scripts/write-pairing-seed.js
 */

const fs = require('fs');
const path = require('path');

const SEED_DIR = path.join('builds', 'shuttlezone-seed');
const SEED_FILE = path.join(SEED_DIR, 'shuttlezone.json');

/* A fixed filename rather than one derived from the tunnel id: the seed names
   it, and one less thing to keep in step between the two is one less way to
   get a tunnel that reads credentials belonging to something else. */
const CREDENTIALS_FILE = 'tunnel-credentials.json';

const REQUIRED_SECRETS = [
  'SHUTTLEZONE_WEBHOOK_URL',
  'SHUTTLEZONE_WEBHOOK_SECRET',
  'SHUTTLEZONE_API_TOKEN',
  'SHUTTLEZONE_TUNNEL_HOSTNAME',
  'SHUTTLEZONE_TUNNEL_ID',
  'SHUTTLEZONE_TUNNEL_CREDENTIALS_B64',
];

/** @returns {{missing: string[], seed: object, credentials: object}} */
function buildPairing(env = process.env) {
  const value = (name) => String(env[name] || '').trim();

  const missing = REQUIRED_SECRETS.filter((name) => !value(name));
  if (missing.length) {
    const err = new Error(
      `missing ${missing.length} secret${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`
    );
    err.missing = missing;
    throw err;
  }

  /* The value the POS will accept as its own credential, so it has to be one
     the resolver recognises. check:pairing enforces this too; failing here
     names the secret rather than the seed field. */
  const apiToken = value('SHUTTLEZONE_API_TOKEN');
  if (!apiToken.startsWith('posnic_')) {
    throw new Error(
      'SHUTTLEZONE_API_TOKEN must start with "posnic_" - the API only recognises ' +
        'prefixed values, so this one could never authenticate'
    );
  }

  let credentials;
  try {
    credentials = JSON.parse(Buffer.from(value('SHUTTLEZONE_TUNNEL_CREDENTIALS_B64'), 'base64').toString('utf8'));
  } catch (e) {
    throw new Error(
      'SHUTTLEZONE_TUNNEL_CREDENTIALS_B64 is not base64 of JSON. Generate it with:\n' +
        "  base64 -i ~/.cloudflared/<uuid>.json | tr -d '\\n'"
    );
  }

  const tunnelId = value('SHUTTLEZONE_TUNNEL_ID');
  if (!credentials.TunnelID) {
    throw new Error('the tunnel credentials contain no TunnelID - is this the right file?');
  }
  if (String(credentials.TunnelID).toLowerCase() !== tunnelId.toLowerCase()) {
    throw new Error(
      `the credentials belong to tunnel ${credentials.TunnelID}, but SHUTTLEZONE_TUNNEL_ID ` +
        `is ${tunnelId}.\n` +
        '  These must be the same tunnel, or the till runs a tunnel for a hostname the\n' +
        '  seed does not name - which connects and then answers nothing.'
    );
  }

  const seller = value('SELLER') || value('SHUTTLEZONE_SELLER') || 'unpaired';

  return {
    credentials,
    seed: {
      seller,
      webhookUrl: value('SHUTTLEZONE_WEBHOOK_URL'),
      webhookSecret: value('SHUTTLEZONE_WEBHOOK_SECRET'),
      events: ['items', 'categories', 'sales', 'receivings'],
      apiToken,
      tunnel: {
        hostname: value('SHUTTLEZONE_TUNNEL_HOSTNAME'),
        tunnelId,
        credentialsFile: CREDENTIALS_FILE,
      },
    },
  };
}

function main() {
  const { seed, credentials } = buildPairing(process.env);

  fs.mkdirSync(SEED_DIR, { recursive: true });
  fs.writeFileSync(path.join(SEED_DIR, CREDENTIALS_FILE), JSON.stringify(credentials), 'utf8');
  fs.writeFileSync(SEED_FILE, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

  /* Deliberately not printing any of the values: a CI log is readable by
     anyone with access to the repository, and one of these is a credential. */
  console.log(`[pairing] seed written for "${seed.seller}"`);
  console.log(`[pairing] tunnel ${seed.tunnel.tunnelId} -> ${seed.tunnel.hostname}`);
  console.log(`[pairing] webhook ${seed.webhookUrl.replace(/\/[^/]+$/, '/…')}`);
  console.log('[pairing] files:');
  console.log(`[pairing]   ${SEED_FILE}`);
  console.log(`[pairing]   ${path.join(SEED_DIR, CREDENTIALS_FILE)}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`\n[pairing] ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { buildPairing, REQUIRED_SECRETS, SEED_DIR, CREDENTIALS_FILE };
