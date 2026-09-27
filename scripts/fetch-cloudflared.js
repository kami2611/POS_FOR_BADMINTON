'use strict';

/*
 * Fetch the `cloudflared` binary a paired installer carries.
 *
 * Run this once, on the build machine, before building an installer for a
 * seller. It is not part of `npm install`: the binary is ~40 MB, it is
 * third-party, and a stock build has no use for it at all.
 *
 *   node scripts/fetch-cloudflared.js             # this machine (for testing)
 *   node scripts/fetch-cloudflared.js --win       # the Windows build target
 *
 * WHERE THE VERSION COMES FROM. Rather than hard-code a version in this file -
 * which would silently rot, and which nobody would remember to bump - the
 * script resolves it once: an explicit `--version`, else the version already
 * recorded in the lock file, else the current release from GitHub. Whatever it
 * resolves is written to the lock, and every later run uses that. So the first
 * run picks a version and every run after it is reproducible.
 *
 * WHERE THE TRUST COMES FROM. The download is hashed, and the hash is compared
 * against the lock file.
 *
 *   - hash matches the lock  -> installed
 *   - no hash in the lock    -> the hash is PRINTED and recorded (first use).
 *                               Check it against the release's published
 *                               checksums before you ship, then commit the
 *                               lock file. That commit is the review step.
 *   - hash differs from lock -> REFUSED. Either the version was re-published
 *                               or something is wrong with the download, and
 *                               neither is something to find out later.
 *
 * The lock file is committed; the binary is not.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'builds', 'cloudflared');
const LOCK_FILE = path.join(OUT_DIR, 'cloudflared.lock.json');
const RELEASES_API = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';
const DOWNLOAD_BASE = 'https://github.com/cloudflare/cloudflared/releases/download';

/*
 * What Cloudflare actually publishes, per platform.
 *
 * Written down rather than inferred, because inferring it is how this script
 * first failed: `--win` on an Apple Silicon Mac asked for
 * `cloudflared-windows-arm64.exe` — a file that does not exist — and the
 * resulting 404 reads like a network problem rather than a wrong request.
 * **There is no windows-arm64 build.** The Windows target is x64, which is
 * exactly what `electron-builder --win --x64` produces.
 *
 * So an impossible combination is refused here, in one sentence, instead of
 * becoming a download failure further down.
 */
const PUBLISHED = Object.freeze({
  win32: Object.freeze(['amd64']),
  darwin: Object.freeze(['amd64', 'arm64']),
  linux: Object.freeze(['amd64', 'arm64']),
});

/* Which release asset this platform/arch needs. Note the macOS difference:
   Cloudflare publishes Windows and Linux as bare binaries and macOS only as a
   .tgz, so the macOS path has to unpack - which the system `tar` does. */
function assetFor(platform, arch) {
  const available = PUBLISHED[platform];
  if (!available) throw new Error(`No cloudflared asset is published for ${platform}`);

  const archName = arch === 'arm64' ? 'arm64' : 'amd64';
  if (!available.includes(archName)) {
    throw new Error(
      `Cloudflare does not publish cloudflared for ${platform}/${archName}.\n` +
        `  ${platform} is published for: ${available.join(', ')}\n` +
        (platform === 'win32'
          ? '  The Windows build is x64 — use --x64, or omit the arch flag.\n'
          : '')
    );
  }

  if (platform === 'win32') {
    return { name: `cloudflared-windows-${archName}.exe`, binary: 'cloudflared.exe', packed: false };
  }
  if (platform === 'darwin') {
    return { name: `cloudflared-darwin-${archName}.tgz`, binary: 'cloudflared', packed: true };
  }
  return { name: `cloudflared-linux-${archName}`, binary: 'cloudflared', packed: false };
}

/**
 * Which architecture to fetch when no flag says.
 *
 * This machine's arch is only the right answer when we are downloading for this
 * machine. A cross-build is not about this machine at all: the installer it
 * goes into is built `--win --x64`, so the binary has to be x64 whatever
 * architecture the build host happens to be.
 */
function resolveArch(explicit, platform) {
  if (explicit) return explicit;
  if (platform === process.platform) return process.arch;
  if (platform === 'win32') return 'amd64';
  return process.arch;
}

function parseArgs(argv) {
  /* `arch` starts EMPTY, meaning "nobody said". Defaulting it to process.arch
     here was the bug: `--win` must not inherit this Mac's arm64. */
  const out = { platform: process.platform, arch: '', version: '', force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--win' || arg === '--windows') out.platform = 'win32';
    else if (arg === '--mac' || arg === '--darwin') out.platform = 'darwin';
    else if (arg === '--linux') out.platform = 'linux';
    else if (arg === '--arm64') out.arch = 'arm64';
    else if (arg === '--x64' || arg === '--amd64') out.arch = 'amd64';
    else if (arg === '--force') out.force = true;
    else if (arg === '--version') {
      out.version = String(argv[i + 1] || '').trim();
      i += 1;
    } else if (arg.startsWith('--version=')) out.version = arg.slice('--version='.length).trim();
  }
  return out;
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  } catch (e) {
    return { version: '', assets: {} };
  }
}

function writeLock(lock) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

async function resolveVersion(explicit, lock) {
  if (explicit) return explicit;
  if (lock.version) return lock.version;
  const res = await fetch(RELEASES_API, {
    headers: { accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(
      `Could not ask GitHub for the current cloudflared release (${res.status}). ` +
        'Pass --version <tag> instead.'
    );
  }
  const body = await res.json();
  const tag = String((body && body.tag_name) || '').trim();
  if (!tag) throw new Error('GitHub returned no release tag; pass --version <tag> instead.');
  return tag;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lock = readLock();
  const arch = resolveArch(args.arch, args.platform);
  const asset = assetFor(args.platform, arch);
  const key = `${args.platform}-${arch}`;

  const version = await resolveVersion(args.version, lock);
  const url = `${DOWNLOAD_BASE}/${version}/${asset.name}`;
  const target = path.join(OUT_DIR, asset.binary);

  console.log(`[cloudflared] version  ${version}`);
  console.log(`[cloudflared] target   ${args.platform}/${arch}`);
  console.log(`[cloudflared] asset    ${asset.name}`);
  console.log(`[cloudflared] output   ${path.relative(ROOT, target)}`);

  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    throw new Error(
      `Download failed (${res.status}) for ${url}\n` +
        'If the version looks wrong, check https://github.com/cloudflare/cloudflared/releases'
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const digest = sha256(buffer);

  const pinned = lock.assets[key];
  if (pinned && pinned !== digest && !args.force) {
    throw new Error(
      `REFUSED: ${asset.name} hashed ${digest}\n` +
        `  but the lock file pins ${pinned}\n` +
        '  Either the release changed under a version that was supposed to be immutable, ' +
        'or this download is not what it claims to be. Investigate before shipping anything.\n' +
        '  If you have checked the new hash yourself, re-run with --force to accept it.'
    );
  }
  if (pinned && pinned !== digest && args.force) {
    console.warn(`[cloudflared] accepting a changed hash for ${key} because --force was given`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (asset.packed) {
    /* macOS ships a .tgz. Unpack with the system tar; the archive holds the
       binary at the top level. */
    const tarball = path.join(OUT_DIR, `${asset.name}`);
    fs.writeFileSync(tarball, buffer);
    execFileSync('tar', ['-xzf', tarball, '-C', OUT_DIR], { stdio: 'inherit' });
    fs.rmSync(tarball, { force: true });
  } else {
    fs.writeFileSync(target, buffer);
  }
  if (args.platform !== 'win32') {
    try {
      fs.chmodSync(target, 0o755);
    } catch (e) {
      /* best effort */
    }
  }

  /* Record the version once; record this asset's hash on first use. */
  lock.version = lock.version || version;
  if (pinned !== digest) {
    lock.assets[key] = digest;
    console.log('');
    console.log('[cloudflared] FIRST DOWNLOAD - the hash was recorded, not yet reviewed.');
    console.log(`[cloudflared] sha256 ${digest}`);
    console.log('[cloudflared] Check it against the release notes, then commit');
    console.log(`[cloudflared]   ${path.relative(ROOT, LOCK_FILE)}`);
    console.log('');
  }
  writeLock(lock);

  console.log(`[cloudflared] ok  ${digest}`);
}

/* Only fetch when run as a script. Without this guard, requiring the file from a
   test would immediately start a 55 MB download. */
if (require.main === module) {
  main().catch((err) => {
    console.error(`\n[cloudflared] ${err.message}\n`);
    process.exit(1);
  });
}

/* Exported for tests: the asset mapping is the part that failed in the field. */
module.exports = { assetFor, parseArgs, resolveArch, PUBLISHED };
