'use strict';

/*
 * THE TUNNEL BINARY THIS SCRIPT ASKS FOR HAS TO BE ONE THAT EXISTS.
 *
 * This file exists because of a real failure. `--win` sets the platform to
 * win32 but originally left the architecture at the HOST's — so on an Apple
 * Silicon Mac the script requested:
 *
 *     cloudflared-windows-arm64.exe
 *
 * which Cloudflare does not publish, and the run ended with a 404 from
 * github.com. That reads like a network problem, so the natural next move is to
 * retry or to blame the connection — not to notice that the request itself was
 * impossible. Nothing downstream could work: no binary, so no tunnel, so a
 * shop that installs cleanly and is never reachable.
 *
 * The Windows target is x64. It is x64 because `electron-builder --win --x64`
 * is what produces the installer this binary goes into, and that is true
 * regardless of what the build machine is.
 */

const test = require('node:test');
const assert = require('node:assert');

const { assetFor, parseArgs, resolveArch, PUBLISHED } = require('../scripts/fetch-cloudflared');

test('a Windows build asks for the x64 binary, which is the one that exists', () => {
  const asset = assetFor('win32', 'amd64');
  assert.strictEqual(asset.name, 'cloudflared-windows-amd64.exe');
  assert.strictEqual(asset.binary, 'cloudflared.exe');
  assert.strictEqual(asset.packed, false, 'Windows ships a bare .exe, not an archive');
});

/* The exact bug: the host's architecture leaking into a cross-build. */
test('--win does not inherit this machine’s architecture', () => {
  const args = parseArgs(['--win']);
  assert.strictEqual(args.platform, 'win32');
  assert.strictEqual(args.arch, '', 'no arch flag means "nobody said"');

  /* Whatever this machine is, a Windows target resolves to amd64. */
  assert.strictEqual(resolveArch(args.arch, 'win32'), 'amd64');
});

test('a download for THIS machine does use its own architecture', () => {
  assert.strictEqual(resolveArch('', process.platform), process.arch);
});

test('an explicit architecture still wins', () => {
  assert.strictEqual(resolveArch('arm64', 'darwin'), 'arm64');
  assert.strictEqual(parseArgs(['--mac', '--arm64']).arch, 'arm64');
  assert.strictEqual(parseArgs(['--x64']).arch, 'amd64');
  assert.strictEqual(parseArgs(['--amd64']).arch, 'amd64');
});

/*
 * Refused in a sentence here, rather than becoming a 404 several seconds later.
 */
test('an architecture Cloudflare does not publish is refused clearly', () => {
  assert.throws(
    () => assetFor('win32', 'arm64'),
    (err) => {
      /* It must name the platform/arch it refused, say what IS available, and
         point at the fix — a 404 from GitHub says none of that. */
      assert.match(err.message, /win32\/arm64/);
      assert.match(err.message, /published for: amd64/);
      assert.match(err.message, /--x64/);
      return true;
    }
  );
  assert.throws(() => assetFor('plan9', 'amd64'), /No cloudflared asset/);
});

test('the published table matches what the releases actually contain', () => {
  /* Verified against the GitHub release assets for the pinned version:
     windows  amd64, 386 (+ .msi)
     darwin   amd64, arm64   (as .tgz only)
     linux    amd64, arm64, 386, armv6, armv7 */
  assert.deepStrictEqual([...PUBLISHED.win32], ['amd64']);
  assert.ok(PUBLISHED.darwin.includes('arm64'));
  assert.ok(PUBLISHED.linux.includes('amd64'));
  assert.ok(!PUBLISHED.win32.includes('arm64'), 'there is no Windows arm64 build');
});

test('macOS is fetched as an archive, because that is how it is published', () => {
  const asset = assetFor('darwin', 'arm64');
  assert.strictEqual(asset.name, 'cloudflared-darwin-arm64.tgz');
  assert.strictEqual(asset.binary, 'cloudflared');
  assert.strictEqual(asset.packed, true, 'the .tgz has to be unpacked');
});

test('the flags the docs tell an operator to use are accepted', () => {
  const args = parseArgs(['--win', '--version', '2026.9.3', '--force']);
  assert.deepStrictEqual(
    { platform: args.platform, version: args.version, force: args.force },
    { platform: 'win32', version: '2026.9.3', force: true }
  );
  assert.strictEqual(parseArgs(['--version=2026.9.3']).version, '2026.9.3');
});
