'use strict';

/*
 * THE TUNNEL A PAIRED INSTALLER CARRIES.
 *
 * This is the piece that makes a shop reachable at all. The website pulls -
 * it reads the catalogue through /api/v1 and downloads each product photo from
 * /uploads - and a till sits behind a router on a shop LAN, so there is no
 * address for it to call. The tunnel is what gives it one, without the
 * shopkeeper configuring anything.
 *
 * Two properties matter enough to pin here:
 *
 * 1. IT POINTS AT THE PORT THE API IS ACTUALLY ON. The API asks for 5555 and
 *    moves to a derived port when 5555 is taken, which it often is. A tunnel
 *    whose target was decided at build time would be pointed at nothing on
 *    those machines - and the failure is silent: the till looks fine and the
 *    website is quietly stale. The config is generated per launch, so it
 *    always names the live port.
 *
 * 2. IT EXPOSES TWO PATHS, NOT THE API. The ingress rules are written here
 *    rather than in a dashboard, so what is reachable from the internet is
 *    exactly /api/v1 and /uploads and nothing else. The management API -
 *    /api-tokens, /items, /settings - is not on the public internet, and the
 *    catch-all answers 404.
 *
 * The seed values are interpolated into a YAML file that decides what this
 * machine exposes, so they are validated as strictly as they are used: a
 * hostname carrying a newline and an extra ingress rule is refused, and so is
 * a credentials path that walks out of the seed directory.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tunnel = require('../src/shuttlezone-tunnel');

const TUNNEL_ID = 'abc12345-1111-2222-3333-444455556666';
const GOOD = {
  tunnel: {
    hostname: 'karachi-sports.example.com',
    tunnelId: TUNNEL_ID,
    credentialsFile: 'karachi-sports.json',
  },
};
const quiet = { log: () => {}, warn: () => {}, error: () => {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'posnic-tunnel-'));
}

test('a complete, sane seed is accepted', () => {
  const parsed = tunnel.tunnelSeed(GOOD);
  assert.deepStrictEqual(parsed, {
    hostname: 'karachi-sports.example.com',
    tunnelId: TUNNEL_ID,
    credentialsFile: 'karachi-sports.json',
  });
});

test('a hostname is normalised, since DNS names are case-insensitive', () => {
  const parsed = tunnel.tunnelSeed({
    tunnel: { ...GOOD.tunnel, hostname: 'Karachi-Sports.Example.COM' },
  });
  assert.strictEqual(parsed.hostname, 'karachi-sports.example.com');
});

test('an unpaired or half-built seed yields null rather than a broken config', () => {
  assert.strictEqual(tunnel.tunnelSeed(null), null);
  assert.strictEqual(tunnel.tunnelSeed({}), null);
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: null }), null);
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: { hostname: 'a.example.com' } }), null);
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: { hostname: 'not a hostname' } }), null);
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: { hostname: 'localhost' } }), null);
});

/*
 * These values are written into YAML that decides what this machine exposes to
 * the internet. A seed is operator-authored and normally correct, but "normally
 * correct" is not a reason to interpolate anything into that file.
 */
test('a hostname cannot smuggle extra ingress into the config', () => {
  const attack = 'good.example.com\n  - service: http://169.254.169.254';
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: { ...GOOD.tunnel, hostname: attack } }), null);
  assert.strictEqual(tunnel.tunnelSeed({ tunnel: { ...GOOD.tunnel, hostname: 'a b.com' } }), null);
  assert.strictEqual(
    tunnel.tunnelSeed({ tunnel: { ...GOOD.tunnel, tunnelId: 'x\nservice: y' } }),
    null
  );
});

test('the credentials file stays inside the seed directory', () => {
  const bad = ['../../etc/passwd', '/etc/passwd', 'sub/dir.json', 'a\\b.json', ''];
  for (const credentialsFile of bad) {
    assert.strictEqual(
      tunnel.tunnelSeed({ tunnel: { ...GOOD.tunnel, credentialsFile } }),
      null,
      `should have refused ${JSON.stringify(credentialsFile)}`
    );
  }
});

test('the ingress is the website surface and a 404, in that order', () => {
  const rules = tunnel.ingressRules({ hostname: 'shop.example.com', port: 42590 });
  assert.deepStrictEqual(
    rules.map((r) => r.path || '(catch-all)'),
    ['/api/v1/.*', '/uploads/.*', '(catch-all)']
  );
  for (const rule of rules.slice(0, 2)) {
    assert.strictEqual(rule.hostname, 'shop.example.com');
    assert.strictEqual(rule.service, 'http://127.0.0.1:42590');
  }
  /* Last, because cloudflared requires the catch-all to be last - a rule after
     it would never be reached. */
  assert.strictEqual(rules[rules.length - 1].service, 'http_status:404');
});

test('the generated config names the live port, not a remembered one', () => {
  const yaml = tunnel.buildConfigYaml({
    tunnelId: TUNNEL_ID,
    credentialsFile: 'C:/seeds/karachi.json',
    hostname: 'shop.example.com',
    port: 42590,
    metricsPort: 51000,
  });
  assert.match(yaml, /^tunnel: abc12345-1111/m);
  assert.match(yaml, /service: http:\/\/127\.0\.0\.1:42590/g);
  assert.match(yaml, /no-autoupdate: true/);
  assert.match(yaml, /metrics: 127\.0\.0\.1:51000/);
  assert.match(yaml, /service: http_status:404/);
  /* A second launch on a moved port rewrites this; the port must not be baked. */
  const moved = tunnel.buildConfigYaml({
    tunnelId: TUNNEL_ID,
    credentialsFile: 'C:/seeds/karachi.json',
    hostname: 'shop.example.com',
    port: 42017,
    metricsPort: 51001,
  });
  assert.match(moved, /127\.0\.0\.1:42017/);
  assert.doesNotMatch(moved, /42590/);
});

test('the management API is not reachable through the tunnel', () => {
  const yaml = tunnel.buildConfigYaml({
    tunnelId: TUNNEL_ID,
    credentialsFile: 'C:/seeds/karachi.json',
    hostname: 'shop.example.com',
    port: 42590,
    metricsPort: 51000,
  });
  for (const exposed of ['/api-tokens', '/items', '/settings', '/webhooks']) {
    assert.ok(!yaml.includes(exposed), `${exposed} must not be in the ingress`);
  }
});

test('the binary is looked for where the platform puts it', () => {
  const devRoot = tempDir();
  const binaryDir = path.join(devRoot, 'builds', 'cloudflared');
  fs.mkdirSync(binaryDir, { recursive: true });

  assert.strictEqual(tunnel.resolveBinary({ isPackaged: false, devRoot }), null);

  fs.writeFileSync(path.join(binaryDir, 'cloudflared.exe'), '');
  assert.strictEqual(
    tunnel.resolveBinary({ isPackaged: false, devRoot, platform: 'win32' }),
    path.join(binaryDir, 'cloudflared.exe')
  );
  assert.strictEqual(tunnel.resolveBinary({ isPackaged: false, devRoot, platform: 'linux' }), null);

  fs.writeFileSync(path.join(binaryDir, 'cloudflared'), '');
  assert.strictEqual(
    tunnel.resolveBinary({ isPackaged: false, devRoot, platform: 'linux' }),
    path.join(binaryDir, 'cloudflared')
  );
  fs.rmSync(devRoot, { recursive: true, force: true });
});

test('packaged builds read resources, development builds read builds/', () => {
  assert.strictEqual(
    tunnel.resolveSeedDir({ isPackaged: true, resourcesPath: '/app/resources', devRoot: '/repo' }),
    path.join('/app/resources', 'shuttlezone-seed')
  );
  assert.strictEqual(
    tunnel.resolveSeedDir({ isPackaged: false, resourcesPath: '/app/resources', devRoot: '/repo' }),
    path.join('/repo', 'builds', 'shuttlezone-seed')
  );
});

test('an unpaired build is inert: nothing starts, and that is not an error', async () => {
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => os.tmpdir() },
    seed: null,
    apiPort: () => 5555,
    log: quiet,
  });
  assert.strictEqual(subject.configured, false);
  assert.strictEqual(subject.status().state, 'not_configured');
  const started = await subject.start();
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.reason, 'not_configured');
  subject.stop(); // safe to stop what never started
});

test('a paired build without the binary says so instead of throwing', async () => {
  const devRoot = tempDir();
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => devRoot },
    seed: GOOD,
    apiPort: () => 5555,
    log: quiet,
    overrides: { isPackaged: false, devRoot },
  });
  assert.strictEqual(subject.configured, true);
  const started = await subject.start();
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.reason, 'no_binary');
  assert.strictEqual(subject.status().state, 'down');
  fs.rmSync(devRoot, { recursive: true, force: true });
});

/*
 * A stand-in for the tunnel process.
 *
 * Real `spawn` is deliberately not used for these: what this module must get
 * right is the config it writes and the process it asks for, and driving that
 * through a real child means testing the operating system's reaction to a file
 * that is not executable - which is a different subject with its own timing.
 */
function fakeProcess() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.destroy = () => {};
  child.stderr.destroy = () => {};
  child.kill = () => { child.killedByUs = true; };
  child.unref = () => {};
  return child;
}

/*
 * A hostname and no credentials would be a tunnel retrying forever against
 * nothing, which is the kind of failure nobody notices for a month.
 */
test('a paired build whose credentials went missing refuses clearly', async () => {
  const devRoot = tempDir();
  const binaryDir = path.join(devRoot, 'builds', 'cloudflared');
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.writeFileSync(
    path.join(binaryDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    ''
  );

  let spawned = 0;
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => devRoot },
    seed: GOOD,
    apiPort: () => 5555,
    log: quiet,
    overrides: { isPackaged: false, devRoot },
    spawnImpl: () => {
      spawned += 1;
      return fakeProcess();
    },
  });
  const started = await subject.start();
  assert.strictEqual(started.ok, false);
  assert.strictEqual(started.reason, 'no_credentials');
  assert.strictEqual(spawned, 0, 'nothing should be launched without credentials');

  fs.mkdirSync(path.join(devRoot, 'builds', 'shuttlezone-seed'), { recursive: true });
  fs.writeFileSync(path.join(devRoot, 'builds', 'shuttlezone-seed', 'karachi-sports.json'), '{}');

  const again = await subject.start();
  assert.strictEqual(again.ok, true);
  assert.strictEqual(spawned, 1);
  subject.stop();
  fs.rmSync(devRoot, { recursive: true, force: true });
});

test('the process is launched with the generated config, and the config names the live port', async () => {
  const devRoot = tempDir();
  const binaryDir = path.join(devRoot, 'builds', 'cloudflared');
  const seedDir = path.join(devRoot, 'builds', 'shuttlezone-seed');
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(
    path.join(binaryDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    ''
  );
  fs.writeFileSync(path.join(seedDir, 'karachi-sports.json'), '{}');

  let call = null;
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => devRoot },
    seed: GOOD,
    /* The whole point: a port the API chose, not one chosen at build time. */
    apiPort: () => 42590,
    log: quiet,
    overrides: { isPackaged: false, devRoot },
    spawnImpl: (...args) => {
      call = args;
      return fakeProcess();
    },
  });

  const started = await subject.start();
  assert.strictEqual(started.ok, true);

  assert.ok(call, 'the process should have been launched');
  const [binary, argv, options] = call;
  assert.match(binary, /cloudflared(\.exe)?$/);
  assert.deepStrictEqual(argv.slice(0, 2), ['tunnel', '--config']);
  assert.strictEqual(argv[3], 'run');
  assert.strictEqual(argv[2], path.join(devRoot, 'shuttlezone-tunnel', 'config.yml'));
  assert.strictEqual(options.windowsHide, true, 'no console window on a shopkeeper till');

  const yaml = fs.readFileSync(argv[2], 'utf8');
  assert.match(yaml, /127\.0\.0\.1:42590/);
  assert.match(yaml, /hostname: karachi-sports\.example\.com/);
  assert.match(yaml, /service: http_status:404/);
  assert.match(yaml, /credentials-file: ".*karachi-sports\.json"/);

  subject.stop();
  assert.strictEqual(subject.child, null, 'stop must not leave a process behind');
  fs.rmSync(devRoot, { recursive: true, force: true });
});

test('a tunnel that dies is restarted, up to a limit, and not after a quit', async () => {
  const devRoot = tempDir();
  const binaryDir = path.join(devRoot, 'builds', 'cloudflared');
  const seedDir = path.join(devRoot, 'builds', 'shuttlezone-seed');
  fs.mkdirSync(binaryDir, { recursive: true });
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(
    path.join(binaryDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    ''
  );
  fs.writeFileSync(path.join(seedDir, 'karachi-sports.json'), '{}');

  const children = [];
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => devRoot },
    seed: GOOD,
    apiPort: () => 42590,
    log: quiet,
    overrides: { isPackaged: false, devRoot },
    spawnImpl: () => {
      const child = fakeProcess();
      children.push(child);
      return child;
    },
  });

  await subject.start();
  assert.strictEqual(children.length, 1);

  /* It died. A restart is scheduled (never immediate), and the count is kept
     so a tunnel that cannot stay up stops being retried. */
  children[0].emit('exit', 1);
  assert.strictEqual(subject.restarts, 1);
  assert.strictEqual(subject.child, null);

  subject.stop();
  assert.strictEqual(subject._restartTimer, null, 'a quit must cancel a pending restart');
  fs.rmSync(devRoot, { recursive: true, force: true });
});

test('status is what support would read: state, host, and the last error', async () => {
  const devRoot = tempDir();
  const subject = new tunnel.ShuttlezoneTunnel({
    app: { isPackaged: false, getPath: () => devRoot },
    seed: GOOD,
    apiPort: () => 5555,
    log: quiet,
    overrides: { isPackaged: false, devRoot },
  });
  const status = subject.status();
  assert.strictEqual(status.state, 'down');
  assert.strictEqual(status.hostname, 'karachi-sports.example.com');
  assert.strictEqual(status.ready, false);
  fs.rmSync(devRoot, { recursive: true, force: true });
});
