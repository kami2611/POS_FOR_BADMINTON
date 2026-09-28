'use strict';

/*
 * THE SECRETS THAT GO INTO A SELLER'S INSTALLER, AND THE WAYS THEY GO WRONG.
 *
 * This is the CI path, and CI is where a mistake is least visible: the workflow
 * runs unattended, produces an .exe, and uploads it. Nobody reads the seed. So
 * every failure below is one that has a version which looks completely fine.
 *
 * The tests are written against `buildPairing`, which is the whole decision -
 * what goes in the seed, and what is refused - with the file writing left out.
 */

const test = require('node:test');
const assert = require('node:assert');

const { buildPairing, REQUIRED_SECRETS } = require('../.github/scripts/write-pairing-seed');

/* Synthetic, like everything else here. A real tunnel id was used at first,
   which is the one kind of value this file must not carry: the repository is
   public, and the id belongs to a named shop's tunnel. */
const TUNNEL_ID = '11111111-2222-3333-4444-555555555555';
const CREDENTIALS = {
  AccountTag: 'a'.repeat(32),
  TunnelSecret: 'c2VjcmV0',
  TunnelID: TUNNEL_ID,
  Endpoint: '',
};

/* Deliberately generic values. This repository is public and carries no
   customer's name (tests/no-customer-branding.test.js), so an example seller
   here must not become one the day it is also a real one. */
function env(over = {}) {
  return {
    SHUTTLEZONE_WEBHOOK_URL: 'https://example.com/api/pos/webhook/abc123',
    SHUTTLEZONE_WEBHOOK_SECRET: 'a-long-enough-shared-secret',
    SHUTTLEZONE_API_TOKEN: 'posnic_' + 'a'.repeat(48),
    SHUTTLEZONE_TUNNEL_HOSTNAME: 'shop.example.com',
    SHUTTLEZONE_TUNNEL_ID: TUNNEL_ID,
    SHUTTLEZONE_TUNNEL_CREDENTIALS_B64: Buffer.from(JSON.stringify(CREDENTIALS)).toString('base64'),
    SELLER: 'example-seller',
    ...over,
  };
}

test('a complete set of secrets produces a seed the POS can use', () => {
  const { seed, credentials } = buildPairing(env());
  assert.strictEqual(seed.seller, 'example-seller');
  assert.strictEqual(seed.apiToken, 'posnic_' + 'a'.repeat(48));
  assert.deepStrictEqual(seed.events, ['items', 'categories', 'sales', 'receivings']);
  assert.strictEqual(seed.tunnel.hostname, 'shop.example.com');
  assert.strictEqual(seed.tunnel.tunnelId, TUNNEL_ID);
  assert.strictEqual(seed.tunnel.credentialsFile, 'tunnel-credentials.json');
  assert.strictEqual(credentials.TunnelID, TUNNEL_ID);
});

/*
 * GitHub substitutes an empty string for a secret that was never created. An
 * empty API token is not an error to the pairing check - an unpaired build is a
 * legitimate configuration - so without this the installer would go out to a
 * shop whose website can never read it.
 */
test('a secret that was never set is named, not defaulted', () => {
  for (const name of REQUIRED_SECRETS) {
    assert.throws(
      () => buildPairing(env({ [name]: '' })),
      (err) => {
        assert.deepStrictEqual(err.missing, [name]);
        assert.match(err.message, new RegExp(name));
        return true;
      },
      `${name} must be required`
    );
  }
});

test('all of them missing reports all of them, so one run fixes everything', () => {
  assert.throws(
    () => buildPairing({}),
    (err) => {
      assert.deepStrictEqual(err.missing, REQUIRED_SECRETS);
      return true;
    }
  );
});

test('whitespace is not a secret', () => {
  assert.throws(() => buildPairing(env({ SHUTTLEZONE_API_TOKEN: '   ' })), /missing 1 secret/);
});

/*
 * The failure this whole file was written for: credentials for a DIFFERENT
 * tunnel. The till then runs a tunnel for a hostname the seed does not name.
 * It connects, the hostname resolves elsewhere, and the website times out
 * against an address that answers - which reads as our bug, not a typo.
 */
test('credentials belonging to another tunnel are refused', () => {
  assert.throws(
    () => buildPairing(env({ SHUTTLEZONE_TUNNEL_ID: 'deadbeef-0000-0000-0000-000000000000' })),
    /credentials belong to tunnel .*but SHUTTLEZONE_TUNNEL_ID/
  );
});

test('the tunnel id comparison ignores case and padding', () => {
  const { seed } = buildPairing(env({ SHUTTLEZONE_TUNNEL_ID: `  ${TUNNEL_ID.toUpperCase()}  ` }));
  assert.strictEqual(seed.tunnel.tunnelId, TUNNEL_ID.toUpperCase());
  assert.strictEqual(seed.tunnel.credentialsFile, 'tunnel-credentials.json');
});

test('a token the API would never accept is refused by name', () => {
  assert.throws(
    () => buildPairing(env({ SHUTTLEZONE_API_TOKEN: 'abc123def456' })),
    /SHUTTLEZONE_API_TOKEN must start with "posnic_"/
  );
});

test('base64 of the wrong thing says how to generate it correctly', () => {
  assert.throws(
    () => buildPairing(env({ SHUTTLEZONE_TUNNEL_CREDENTIALS_B64: 'bm90IGpzb24=' })),
    /not base64 of JSON[\s\S]*base64 -i/
  );
});

test('credentials with no TunnelID at all are refused', () => {
  const noId = Buffer.from(JSON.stringify({ AccountTag: 'x' })).toString('base64');
  assert.throws(
    () => buildPairing(env({ SHUTTLEZONE_TUNNEL_CREDENTIALS_B64: noId })),
    /contain no TunnelID/
  );
});

test('the seed never contains the tunnel secret in the json', () => {
  /* The credentials go in their own file, which the tunnel reads. Putting a
     TunnelSecret into the seed would be a second copy in a place nothing
     needs it. */
  const { seed } = buildPairing(env());
  assert.ok(!JSON.stringify(seed).includes(CREDENTIALS.TunnelSecret));
  assert.strictEqual(seed.tunnel.credentialsFile, 'tunnel-credentials.json');
});
