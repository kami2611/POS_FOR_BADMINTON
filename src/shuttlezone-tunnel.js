'use strict';

/*
 * The Cloudflare tunnel a paired installer carries.
 *
 * WHY A TUNNEL AT ALL. The website PULLS: it reads the catalogue through
 * /api/v1 and downloads each product's photo from /uploads. A shop's till is
 * behind a router on a LAN, so there is no address for the website to call.
 * Something has to make this machine reachable, and the shopkeeper is not
 * going to configure port forwarding - the whole point of a paired installer
 * is that they install it and do nothing else.
 *
 * WHY LOCALLY-MANAGED, NOT A TOKEN. Cloudflare offers a remotely-managed
 * tunnel: one `--token` string, ingress set in their dashboard. It is simpler
 * for the operator and it is wrong here, for a reason specific to this
 * application: the API's local port is NOT fixed. `local-ports.js` asks for
 * 5555 first and moves to a derived port when 5555 is taken, which it often is.
 * A remotely-managed tunnel ignores local configuration entirely, so its
 * ingress would be pinned to a port that this machine may not be using - and
 * the failure is silent. The website would simply stop being able to read, with
 * nothing at the till looking wrong.
 *
 * So the tunnel is locally managed: this module writes a config file at every
 * launch, containing the port the API is ACTUALLY listening on. If the port
 * moves, the config moves with it.
 *
 * WHAT THAT BUYS, AND WHAT IT EXPOSES. Because ingress is written here, it is
 * written narrowly: two path rules, /api/v1/* and /uploads/*, and a catch-all
 * that answers 404. The admin surface of this API - /api-tokens, /items,
 * /settings, the whole management API - is therefore not reachable from the
 * internet, even with the tunnel up. That is the reason to prefer this shape
 * over a remote-managed one beyond the port problem.
 *
 * The path field in an ingress rule is a regular expression, matched against
 * the request path. A wrong expression produces a 404 rather than a leak, so
 * the failure mode is loud on the website's side and safe on this one.
 *
 * Nothing here is fatal. No seed, no binary or no credentials means an ordinary
 * unpaired till that starts and works exactly as it always did.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

/* Where the website is allowed to reach. Two rules, and no third: every other
   path in this API answers 404 through the tunnel, including the management
   endpoints, which have no business being on the public internet. */
const EXPOSED_PATHS = Object.freeze(['/api/v1/.*', '/uploads/.*']);

const RESTART_DELAY_MS = 15_000;
const MAX_RESTARTS = 5;
/* How often to ask the tunnel whether it is actually up. `cloudflared` serves
   a metrics endpoint on loopback; /ready answers 200 once it holds a live edge
   connection, which is a real answer rather than a guess from log text. */
const HEALTH_EVERY_MS = 60_000;
/* The tunnel is not up the instant it is spawned; give it this long before the
   first health probe and treat a failure as real. */
const HEALTH_GRACE_MS = 20_000;

/* A hostname we are willing to write into a YAML file. This is not decoration:
   the value is interpolated into config that decides what this machine exposes,
   so a seed carrying a newline and an extra ingress rule must be refused
   outright rather than trusted. */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/;
const TUNNEL_ID_RE = /^[a-z0-9][a-z0-9-]{7,63}$/i;
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]{1,80}$/;

/**
 * The tunnel half of the pairing seed, or null.
 *
 * @param {object} seed
 * @returns {{hostname: string, tunnelId: string, credentialsFile: string}|null}
 */
function tunnelSeed(seed) {
  const t = seed && seed.tunnel;
  if (!t || typeof t !== 'object') return null;

  const hostname = String(t.hostname || '').trim().toLowerCase();
  const tunnelId = String(t.tunnelId || '').trim();
  const credentialsFile = String(t.credentialsFile || '').trim();

  if (!HOSTNAME_RE.test(hostname)) return null;
  if (!TUNNEL_ID_RE.test(tunnelId)) return null;
  /* A basename only. The file is looked for inside the seed directory, so an
     absolute path or a `../` here would point at something else on the disk. */
  if (!SAFE_FILENAME_RE.test(credentialsFile)) return null;

  return { hostname, tunnelId, credentialsFile };
}

/**
 * The ingress rules, in order. The last rule has no hostname on purpose: it is
 * cloudflared's required catch-all, and it answers 404 rather than forwarding.
 */
function ingressRules({ hostname, port }) {
  const rules = EXPOSED_PATHS.map((pattern) => ({
    hostname,
    path: pattern,
    service: `http://127.0.0.1:${port}`,
  }));
  rules.push({ service: 'http_status:404' });
  return rules;
}

/** Render the config file cloudflared is started with. */
function buildConfigYaml({ tunnelId, credentialsFile, hostname, port, metricsPort }) {
  const lines = [
    `# Written by Posnic at launch for this shop's website pairing.`,
    `# Regenerated on every start, because the local API port is not fixed.`,
    `tunnel: ${tunnelId}`,
    `credentials-file: "${credentialsFile}"`,
    `no-autoupdate: true`,
    `metrics: 127.0.0.1:${metricsPort}`,
    `ingress:`,
  ];
  for (const rule of ingressRules({ hostname, port })) {
    if (rule.hostname) {
      lines.push(`  - hostname: ${rule.hostname}`);
      lines.push(`    path: ${rule.path}`);
      lines.push(`    service: ${rule.service}`);
    } else {
      lines.push(`  - service: ${rule.service}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Where the tunnel binary lives.
 *
 * Packaged, it is a resource beside the app; in a development tree it is
 * whatever `scripts/fetch-cloudflared.js` downloaded into `builds/`.
 */
function resolveBinary({ isPackaged, resourcesPath, devRoot, platform = process.platform }) {
  const name = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const candidate = isPackaged
    ? path.join(resourcesPath, 'cloudflared', name)
    : path.join(devRoot, 'builds', 'cloudflared', name);
  return fs.existsSync(candidate) ? candidate : null;
}

/** Where the pairing seed's files sit, packaged or not. */
function resolveSeedDir({ isPackaged, resourcesPath, devRoot }) {
  return isPackaged
    ? path.join(resourcesPath, 'shuttlezone-seed')
    : path.join(devRoot, 'builds', 'shuttlezone-seed');
}

/** Let the OS pick a free loopback port for the metrics endpoint. */
function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.once('listening', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.listen(0, '127.0.0.1');
  });
}

/**
 * Runs and supervises one tunnel process.
 *
 * @param {object} options
 * @param {Electron.App} options.app
 * @param {object} options.seed            the whole pairing seed
 * @param {() => number} options.apiPort   read LIVE, never captured - the port
 *                                         is decided before the API starts
 * @param {Console} [options.log]
 * @param {(state: object) => void} [options.onStatus]
 * @param {{isPackaged?: boolean, resourcesPath?: string, devRoot?: string}} [options.overrides]
 *        Path resolution for tests. Production never passes it: the real
 *        answers come from the app and from where this file lives.
 * @param {Function} [options.spawnImpl] Used instead of child_process.spawn.
 *        Injected by tests for the same reason `fetchImpl` is: the interesting
 *        behaviour is what this module does with a process, not what the
 *        operating system does when handed a script that is not executable.
 */
class ShuttlezoneTunnel {
  constructor({
    app,
    seed,
    apiPort,
    log = console,
    onStatus = null,
    fetchImpl = null,
    spawnImpl = null,
    overrides = null,
  } = {}) {
    this.app = app;
    this.seed = seed;
    this.apiPort = apiPort;
    this.log = log;
    this.onStatus = onStatus;
    this._fetch = fetchImpl || globalThis.fetch;
    this._spawnFn = spawnImpl || spawn;
    this.overrides = overrides || {};

    this.config = tunnelSeed(seed);
    this.child = null;
    this.stopped = false;
    this.restarts = 0;
    this.ready = false;
    this.lastError = '';
    this.startedAt = null;
    this._healthTimer = null;
    this._restartTimer = null;
    this._readyDeadline = 0;
    this._metricsPort = 0;
    this._probeController = null;
  }

  /** Where the binary and the seed live, packaged or in a development tree. */
  _paths() {
    const o = this.overrides || {};
    return {
      isPackaged:
        o.isPackaged !== undefined ? Boolean(o.isPackaged) : Boolean(this.app && this.app.isPackaged),
      resourcesPath: o.resourcesPath || process.resourcesPath,
      devRoot: o.devRoot || path.join(__dirname, '..'),
    };
  }

  /** Is this build paired to a website that needs a tunnel at all? */
  get configured() {
    return Boolean(this.config);
  }

  status() {
    return {
      state: !this.configured ? 'not_configured' : this.ready ? 'up' : this.child ? 'starting' : 'down',
      hostname: this.config ? this.config.hostname : '',
      ready: this.ready,
      restarts: this.restarts,
      lastError: this.lastError,
      since: this.startedAt ? this.startedAt.toISOString() : '',
    };
  }

  _publish() {
    if (typeof this.onStatus === 'function') {
      try {
        this.onStatus(this.status());
      } catch (e) {
        /* a status listener must never take the tunnel down */
      }
    }
  }

  /**
   * Start it, or explain in one line why not. Never throws: this runs on the
   * boot path of a till, and a till that cannot open a tunnel is still a till.
   */
  async start() {
    if (!this.configured) return { ok: false, reason: 'not_configured' };
    if (this.child) return { ok: true, reason: 'already_running' };

    try {
      const { isPackaged, resourcesPath, devRoot } = this._paths();

      const binary = resolveBinary({ isPackaged, resourcesPath, devRoot });
      if (!binary) {
        this.lastError = 'cloudflared is not shipped in this build';
        this.log.warn('[shuttlezone-tunnel]', this.lastError);
        this._publish();
        return { ok: false, reason: 'no_binary' };
      }

      const seedDir = resolveSeedDir({ isPackaged, resourcesPath, devRoot });
      const credentialsFile = path.join(seedDir, this.config.credentialsFile);
      if (!fs.existsSync(credentialsFile)) {
        /* Sending a build out with a hostname and no credentials would mean a
           tunnel that retries forever against nothing. Say so plainly. */
        this.lastError = 'the tunnel credentials file is missing from the seed';
        this.log.warn('[shuttlezone-tunnel]', this.lastError);
        this._publish();
        return { ok: false, reason: 'no_credentials' };
      }

      const metricsPort = (await freePort()) || 0;
      const configDir = path.join(this.app.getPath('userData'), 'shuttlezone-tunnel');
      fs.mkdirSync(configDir, { recursive: true });
      const configPath = path.join(configDir, 'config.yml');
      fs.writeFileSync(
        configPath,
        buildConfigYaml({
          tunnelId: this.config.tunnelId,
          credentialsFile,
          hostname: this.config.hostname,
          port: this.apiPort(),
          metricsPort,
        }),
        'utf8'
      );

      this._metricsPort = metricsPort;
      this._spawn(binary, configPath);
      this.startedAt = new Date();
      this._readyDeadline = Date.now() + HEALTH_GRACE_MS;
      this._startHealthLoop();
      this.log.log(
        `[shuttlezone-tunnel] starting for ${this.config.hostname} -> 127.0.0.1:${this.apiPort()}`
      );
      this._publish();
      return { ok: true };
    } catch (e) {
      this.lastError = (e && e.message) || String(e);
      this.log.warn('[shuttlezone-tunnel] could not start:', this.lastError);
      this._publish();
      return { ok: false, reason: 'error' };
    }
  }

  _spawn(binary, configPath) {
    /* windowsHide: cloudflared is a console program, and a black window
       appearing on a shopkeeper's till every time it starts would be alarming
       and unclosable. */
    const child = this._spawnFn(binary, ['tunnel', '--config', configPath, 'run'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const relay = (level, chunk) => {
      const text = String(chunk || '').trim();
      if (text) this.log[level]('[shuttlezone-tunnel]', text);
    };
    if (child.stdout) child.stdout.on('data', (c) => relay('log', c));
    if (child.stderr) child.stderr.on('data', (c) => relay('warn', c));

    child.on('error', (err) => {
      this.lastError = err && err.message ? err.message : String(err);
      this.log.warn('[shuttlezone-tunnel] process error:', this.lastError);
      /* A spawn that never became a process emits 'error' and NOT 'exit', so
         nothing else would release the pipes. Left alone they outlive the
         failure, and the till's shutdown waits on handles belonging to a
         process that never existed. */
      this._releaseChild(child);
      this._publish();
    });

    child.on('exit', (code) => {
      this._releaseChild(child);
      this.ready = false;
      this._publish();
      if (this.stopped) return;
      if (this.restarts >= MAX_RESTARTS) {
        /* Enough. A tunnel that cannot stay up is not going to be fixed by
           another attempt, and the failure is recorded for support. */
        this.lastError = `the tunnel exited ${MAX_RESTARTS + 1} times without staying up`;
        this.log.warn('[shuttlezone-tunnel]', this.lastError, '(last exit code', code + ')');
        return;
      }
      this.restarts += 1;
      this.log.warn(
        `[shuttlezone-tunnel] exited (code ${code}); restarting in ${RESTART_DELAY_MS / 1000}s`
      );
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this.start().catch(() => {});
      }, RESTART_DELAY_MS);
      if (typeof this._restartTimer.unref === 'function') this._restartTimer.unref();
    });
  }

  /** Close the pipes and forget the process; nothing of it is left to wait on. */
  _releaseChild(child) {
    if (this.child === child) this.child = null;
    for (const stream of [child.stdout, child.stderr]) {
      try {
        if (stream) stream.destroy();
      } catch (e) {
        /* already closed */
      }
    }
    try {
      if (typeof child.unref === 'function') child.unref();
    } catch (e) {
      /* gone */
    }
  }

  _startHealthLoop() {
    if (this._healthTimer) return;
    const probe = async () => {
      if (this.stopped || !this._metricsPort) return;
      /* Aborted in stop() rather than left to time out: a quit must not leave a
         request and its timer pending behind it. */
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      if (typeof timeout.unref === 'function') timeout.unref();
      this._probeController = controller;
      let up = false;
      try {
        const res = await this._fetch(`http://127.0.0.1:${this._metricsPort}/ready`, {
          signal: controller.signal,
        });
        up = res.ok;
      } catch (e) {
        up = false;
      } finally {
        clearTimeout(timeout);
        this._probeController = null;
      }
      if (this.stopped) return;
      if (up !== this.ready) {
        this.ready = up;
        if (up) {
          this.log.log('[shuttlezone-tunnel] connected');
        } else if (Date.now() > this._readyDeadline) {
          /* Paired and not reachable is the failure that hides for weeks: the
             till looks fine, the website is simply stale. Say it in the log,
             which is what support reads, and let the shell surface it. */
          this.lastError = 'the tunnel is not connected';
          this.log.warn('[shuttlezone-tunnel] not connected to the edge');
        }
        this._publish();
      }
    };
    this._healthTimer = setInterval(probe, HEALTH_EVERY_MS);
    if (typeof this._healthTimer.unref === 'function') this._healthTimer.unref();
    probe().catch(() => {});
  }

  /** Stop, and do not restart. Safe to call when it was never started. */
  stop() {
    this.stopped = true;
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._probeController) {
      try {
        this._probeController.abort();
      } catch (e) {
        /* nothing in flight */
      }
      this._probeController = null;
    }
    if (this.child) {
      const child = this.child;
      try {
        child.kill();
      } catch (e) {
        /* already gone */
      }
      this._releaseChild(child);
    }
    this.ready = false;
    this._publish();
  }
}

module.exports = {
  ShuttlezoneTunnel,
  EXPOSED_PATHS,
  RESTART_DELAY_MS,
  MAX_RESTARTS,
  tunnelSeed,
  ingressRules,
  buildConfigYaml,
  resolveBinary,
  resolveSeedDir,
  freePort,
};
