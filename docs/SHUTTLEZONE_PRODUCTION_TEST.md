# Testing the ShuttleZone pairing on production

A step by step runbook for proving, on real production infrastructure, that a
paired Posnic installer can be read by ShuttleZone: the seller installs one
`.exe`, finishes the wizard, and their products appear on the website with no
credential ever travelling back from them.

Use this when you have changed anything in the pairing chain (the seed writer,
the API token provisioning, the tunnel, the workflow) and you want to confirm it
end to end rather than in a unit test.

For the design and the field-by-field explanation, read
[WEBSITE_SYNC.md](WEBSITE_SYNC.md). This file is only the operational checklist.

---

## What this runbook is actually validating

The failure this exists to catch is a silent one. A POS that is paired but has
not provisioned its token still looks completely healthy: the till starts, the
tunnel connects, the wizard completes, and the only symptom is that ShuttleZone's
**Test connection** answers:

```
POS not usable: pos_401 - POS answered 401 for /api/v1/items?limit=1
```

That 401 means one specific thing: the `posnic_...` value in the installer's
seed is not in the shop's `api_tokens` collection. The POS provisioned nothing,
so its own auth middleware correctly refuses the website's token.

The provisioning is done by a background timer (`api/src/realtime/scheduler.js`),
which is started at boot by `api/src/boot-timers.js`. If that timer is not
started, you get exactly the 401 above and no other error anywhere.

So the whole point of this runbook is to watch for two log lines on a real
install. If both appear, the pairing is correct.

---

## What "working" looks like

On the shop's machine, inside 60 seconds of finishing the wizard:

```
✅ Webhook delivery scheduler running
[shuttlezone] pairing seed applied (4 values) for example-seller
[shuttlezone-tunnel] starting for example-seller.shuttlezone.app -> 127.0.0.1:5555
[shuttlezone-tunnel] connected
[shuttlezone] website token provisioned (posnic_1f3c4d…)
```

In the POS UI (`Settings -> Integrations`):

- **API Tokens** has one active row named `ShuttleZone website`.
- **Webhooks** has a locked, pre-filled, greyed out row pointing at
  `https://shuttlezone.app/api/pos/webhook/<key>`.

In ShuttleZone admin (`https://shuttlezone.app/admin/pos/<id>`):

- **Test connection** reports the shop name and that its API answered.
- **Sync now** imports the catalogue and the product count goes up.

---

## Prerequisites

On the machine you run these commands from (your Mac is fine):

| Tool                        | Check                                | Notes                                            |
| --------------------------- | ------------------------------------ | ------------------------------------------------ |
| Node.js 22                  | `node -v`                            | to generate the token and base64 the credentials |
| `cloudflared`               | `cloudflared --version`              | `brew install cloudflared`                       |
| GitHub CLI                  | `gh --version` and `gh auth status`  | `brew install gh`, then `gh auth login`          |
| Access to ShuttleZone admin | open `https://shuttlezone.app/admin` | to create the connection                         |
| Cloudflare account          | the one holding `shuttlezone.app`    | to create the tunnel and DNS route               |

And one Windows machine (or VM) to install the built `.exe` on.

Throughout this document:

- `<owner>/<repo>` is the POS repository, for example `kami2611/POS_FOR_BADMINTON`.
- `example-seller` is the seller label. Replace it with the real one, and use the
  same string everywhere: on the Cloudflare tunnel, the DNS hostname, the
  ShuttleZone connection label, and the workflow input.

Never reuse a label, token, or tunnel across two sellers.

---

## The six secrets, and exactly where each comes from

The workflow reads six repository secrets. Each one has a different origin, and
getting them from the right place is most of the work.

| Secret                               | What it is                                                        | Where you get it                               |
| ------------------------------------ | ----------------------------------------------------------------- | ---------------------------------------------- |
| `SHUTTLEZONE_API_TOKEN`              | `posnic_...`, the credential ShuttleZone reads the catalogue with | you generate it (Step 1)                       |
| `SHUTTLEZONE_WEBHOOK_URL`            | full webhook URL, key included                                    | the ShuttleZone connection page (Step 2)       |
| `SHUTTLEZONE_WEBHOOK_SECRET`         | the secret that signs change signals                              | the same connection page, shown once (Step 2)  |
| `SHUTTLEZONE_TUNNEL_ID`              | the tunnel UUID                                                   | `cloudflared tunnel create` (Step 3)           |
| `SHUTTLEZONE_TUNNEL_HOSTNAME`        | the hostname routed to that tunnel                                | `cloudflared tunnel route dns` (Step 3)        |
| `SHUTTLEZONE_TUNNEL_CREDENTIALS_B64` | base64 of the tunnel's credentials JSON                           | the `~/.cloudflared/<uuid>.json` file (Step 4) |

Nothing comes back from the seller. All six are decided by you, before the build.

---

## Step 1: generate the API token

This is your value, not the POS's. Generate one per seller and keep it to hand:
it goes into two places (the ShuttleZone connection, and the installer seed via
the workflow secret).

```bash
node -e "console.log('posnic_' + require('crypto').randomBytes(24).toString('hex'))"
```

It must start with `posnic_` and be at least 32 characters after the prefix. The
build refuses anything else, because a token the API would never recognise is a
permanent 401 with no other symptom.

Write it down somewhere for the next two steps, then treat it as a secret.

---

## Step 2: create the ShuttleZone connection

Go to `https://shuttlezone.app/admin/pos/new` and fill in:

| Field            | Value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| Seller           | the seller this shop belongs to, status `active`                           |
| Label            | `example-seller`                                                           |
| POS API base URL | `https://example-seller.shuttlezone.app` (the tunnel hostname from Step 3) |
| POS API token    | the `posnic_...` from Step 1                                               |
| Webhook secret   | leave blank, one is generated for you                                      |
| Publish mode     | whatever this test needs                                                   |

Press **Create connection**. It now shows a **webhook URL** and a **webhook
secret** in a dark box, **once only**. Copy both now:

- `SHUTTLEZONE_WEBHOOK_URL` looks like `https://shuttlezone.app/api/pos/webhook/<key>`
- `SHUTTLEZONE_WEBHOOK_SECRET` is a long hex string

If you navigate away before copying, delete the connection and make a new one.
The secret is never shown again.

> The hostname in **POS API base URL** must match the tunnel hostname you are
> about to create, character for character. A mismatch means ShuttleZone reads
> whatever else lives at that address, or nothing at all.

---

## Step 3: create the Cloudflare tunnel and route its hostname

One tunnel per seller. The first time on a machine only, authorise
`cloudflared`:

```bash
cloudflared tunnel login
```

Then create the tunnel. Note the UUID it prints: that is
`SHUTTLEZONE_TUNNEL_ID`.

```bash
cloudflared tunnel create example-seller
```

Give it a hostname under a domain in your Cloudflare account. Note the hostname:
that is `SHUTTLEZONE_TUNNEL_HOSTNAME`.

```bash
cloudflared tunnel route dns example-seller example-seller.shuttlezone.app
```

Two things to know:

- **Do not configure ingress in the Cloudflare dashboard.** The till writes its
  own `config.yml` at every launch, because the API's local port is not fixed (it
  asks for 5555 and moves to a derived port when that is taken). Dashboard
  ingress would point at a port the machine may not be using, and the failure
  would be silent.
- The credentials file `cloudflared tunnel create` wrote is at
  `~/.cloudflared/<uuid>.json`. That is the next step's input.

---

## Step 4: base64 the tunnel credentials

The workflow cannot read a file from your machine, so the credentials travel as
base64. Use Node, which behaves the same on macOS, Linux and Windows:

```bash
node -e "process.stdout.write(Buffer.from(require('fs').readFileSync(process.argv[1])).toString('base64'))" ~/.cloudflared/<uuid>.json > /tmp/example-seller-tunnel.b64
wc -c /tmp/example-seller-tunnel.b64
```

Alternatives if you prefer the platform tools:

```bash
# macOS
base64 -i ~/.cloudflared/<uuid>.json | tr -d '\n'
# Linux / Git Bash
base64 -w0 ~/.cloudflared/<uuid>.json
```

The build also cross-checks that the credentials file's `TunnelID` matches
`SHUTTLEZONE_TUNNEL_ID`, so a copy of the wrong seller's credentials fails at
build time instead of producing a tunnel that connects and then answers nothing.

---

## Step 5: write the six GitHub Actions secrets

Either the CLI (shown) or the browser (`Settings -> Secrets and variables ->
Actions -> New repository secret`, one at a time).

CLI, for the four short values. Omit the value so it prompts, which keeps the
secret out of your shell history:

```bash
gh secret set SHUTTLEZONE_API_TOKEN              --repo <owner>/<repo>
gh secret set SHUTTLEZONE_WEBHOOK_URL            --repo <owner>/<repo>
gh secret set SHUTTLEZONE_WEBHOOK_SECRET         --repo <owner>/<repo>
gh secret set SHUTTLEZONE_TUNNEL_ID              --repo <owner>/<repo>
gh secret set SHUTTLEZONE_TUNNEL_HOSTNAME        --repo <owner>/<repo>
```

And the base64 one from the file you wrote in Step 4:

```bash
gh secret set SHUTTLEZONE_TUNNEL_CREDENTIALS_B64 --repo <owner>/<repo> < /tmp/example-seller-tunnel.b64
```

Confirm all six are present. You should see the six names and a timestamp:

```bash
gh secret list --repo <owner>/<repo>
```

> The names must be exactly these. The workflow passes them to
> [write-pairing-seed.js](../.github/scripts/write-pairing-seed.js) under the
> same names, and GitHub substitutes an empty string for any name that is not
> set. A typo does not error: it produces six empty variables and a build that
> stops at "missing 6 secrets" while every secret is visibly present.

---

## Step 6: dry run first (no build, validates everything)

This checks the secrets are readable and the seed passes `check:pairing`, without
spending a full Windows build. In the workflow UI this input is labelled
"Stop after the pairing check - validates the secrets without building".

```bash
gh workflow run build-seller-installer.yml \
  --repo <owner>/<repo> \
  -f seller=example-seller \
  -f dry_run=true
```

Watch it, then read the result:

```bash
gh run list --repo <owner>/<repo> --workflow=build-seller-installer.yml --limit 3
gh run watch --repo <owner>/<repo> <run-id>
```

You should see the "Write the pairing seed from secrets" and "Check the pairing"
steps succeed. If a secret is missing the log names it; if a token or URL is
malformed, `check:pairing` says which one.

Prefer to check locally before involving CI? The same script runs on your Mac:

```bash
cd "/Users/kamran/Documents/POS AND SHUTTLEZONE FOLDERS/POS ULTIMAX"
SHUTTLEZONE_WEBHOOK_URL='https://shuttlezone.app/api/pos/webhook/<key>' \
SHUTTLEZONE_WEBHOOK_SECRET='<from Step 2>' \
SHUTTLEZONE_API_TOKEN='<from Step 1>' \
SHUTTLEZONE_TUNNEL_HOSTNAME='example-seller.shuttlezone.app' \
SHUTTLEZONE_TUNNEL_ID='<from Step 3>' \
SHUTTLEZONE_TUNNEL_CREDENTIALS_B64='<from Step 4>' \
SELLER='example-seller' \
node .github/scripts/write-pairing-seed.js
npm run check:pairing
```

That writes `builds/shuttlezone-seed/shuttlezone.json` and
`builds/shuttlezone-seed/tunnel-credentials.json`. Remember that
`npm run prebuild` clears that folder, so never run it after this step.

---

## Step 7: build the installer on GitHub Actions

A Windows installer cannot be built on a Mac: `mongod.exe` and three MSVC
runtime DLLs are Windows only inputs, and the packaging step does not fail
loudly, it just produces an installer that dies on the shop's counter. That is
why this builds on a `windows-latest` runner.

```bash
gh workflow run build-seller-installer.yml \
  --repo <owner>/<repo> \
  -f seller=example-seller \
  -f dry_run=false
```

Get the run id and watch it:

```bash
gh run list --repo <owner>/<repo> --workflow=build-seller-installer.yml --limit 3
gh run watch --repo <owner>/<repo> <run-id>
```

A full build takes a while: it fetches MongoDB and `cloudflared`, installs three
dependency trees, runs `prebuild`, then packages with electron-builder. The run
summary lists the `.exe` files it produced.

> **This installer is unsigned.** That is deliberate and is enforced by
> `tests/windows-release-separately.test.js`: the Windows signing key lives on a
> Certum hardware card, and a hosted runner has no card reader. CI builds are for
> testing pairing only. When this seller gets a real installer, build it on the
> desk machine where the card is, from the same seed. Windows SmartScreen will
> warn on first run of the CI artifact; that is expected.

---

## Step 8: download the artifact and rename it

```bash
mkdir -p /tmp/example-seller-installer
gh run download <run-id> --repo <owner>/<repo> -n example-seller-installer -D /tmp/example-seller-installer
ls -lh /tmp/example-seller-installer
```

The artifact is named `<seller>-installer` because you passed the label. Rename
the file before sending it anywhere: every seller's build has the same internal
name, and two shops with one filename is how the wrong installer reaches the
wrong shop.

```bash
mv /tmp/example-seller-installer/Posnic-*-windows-x64-installer.exe \
   /tmp/example-seller-installer/Posnic-example-seller.exe
```

Artifacts expire after 14 days.

---

## Step 9: install it on Windows and finish the wizard

Copy the `.exe` to the Windows machine and run it. Accept the SmartScreen
warning. When the POS opens, complete the first run wizard (shop name, admin
user, password, country, state). That wizard is what creates the licence and the
branch the token is bound to, so nothing is provisioned before it finishes.

For a genuinely fresh test, remove a previous install completely first. In an
Administrator Command Prompt:

```cmd
taskkill /F /IM posnic.exe /T
taskkill /F /IM cloudflared.exe /T
tasklist | findstr /I mongod
tasklist | findstr /I electron
rmdir /s /q "%APPDATA%\posnic"
dir "%APPDATA%\posnic"
rmdir /s /q "%LOCALAPPDATA%\posnic"
```

`dir` must answer **File Not Found**, not "0 files". A stuck folder handle has
produced a false "fresh" result before and needed a reboot to clear. Then
uninstall through `appwiz.cpl` and install the new `.exe`.

---

## Step 10: verify the POS provisioned, within 60 seconds

This is the step the whole runbook exists for.

**Watch the log.** Launch the installed app from a Command Prompt rather than by
double clicking, so the `[shuttlezone]` lines are visible, or open
`%APPDATA%\posnic\app.log` after startup.

You are looking for all of these:

```
✅ Webhook delivery scheduler running
[shuttlezone] pairing seed applied (4 values) for example-seller
[shuttlezone-tunnel] starting for example-seller.shuttlezone.app -> 127.0.0.1:5555
[shuttlezone-tunnel] connected
[shuttlezone] website token provisioned (posnic_1f3c4d…)
```

The first line proves the boot timer started. The last line proves the token was
written. If the first is missing, the installer predates the boot path fix; if
the second is missing, the seed did not reach the API; if the fourth is missing,
the tunnel is up but not connected to Cloudflare's edge.

The token line appears on the scheduler's first tick after the wizard created a
licence and a branch, so within about a minute. It is idempotent: seeing it once
is enough, and a restart does not duplicate it.

**Check the POS UI.** Open `Settings -> Integrations`:

- **API Tokens**: one active row named `ShuttleZone website`.
- **Webhooks**: one locked row pointing at your ShuttleZone webhook URL.

This is the reliable check, because the bundled MongoDB ships only `mongod.exe`
with no shell, so you cannot query `api_tokens` directly on a seller style
install.

**Check the tunnel health.** `%APPDATA%\posnic\health-status.json` carries the
tunnel state, which is deliberately not shown to the shopkeeper: a dead tunnel
and a working one look identical from the shop's side.

---

## Step 11: verify from ShuttleZone

Open `https://shuttlezone.app/admin/pos/<id>` for the connection you created.

1. **Test connection**. Expected: success, naming the shop and reporting that its
   API answered. A `401` here means the token never got provisioned, so go back
   to Step 10. An "unreachable" or timeout means the tunnel, so check the
   hostname resolves and look for `[shuttlezone-tunnel] not connected to the
edge`.
2. **Sync now**. The first import. The product count on the connection page
   should go up.
3. **Deliveries**, at `/admin/pos/deliveries`. Signals from the POS appear here
   with their status.

---

## Step 12: prove it changes in both directions

Reading the catalogue only tests the inbound half. The outbound half is the
webhook.

1. In the POS, edit an item: change its price or stock.
2. Within a few seconds, `/admin/pos/deliveries` should show a new row.
3. Press **Sync now** on the connection, or wait for the website's own pull, and
   confirm the new value appears.

If deliveries stay empty, the outbound side is the problem: check that the POS's
**Integrations -> Webhooks** row exists and is locked, and that the secret in the
seed matches the one on the connection page.

---

## Troubleshooting

| Symptom                                               | Most likely cause                                     | What to check                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pos_401 POS answered 401 for /api/v1/items`          | the token was never provisioned                       | Step 10, the `website token provisioned` line, and the API Tokens screen                 |
| `✅ Webhook delivery scheduler running` never appears | the installer predates the shared boot-timers fix     | rebuild from current `main`, do not just resend the old artifact                         |
| `[shuttlezone] pairing seed applied` never appears    | the seed is not in the installer                      | unzip the installer and confirm `resources/shuttlezone-seed/shuttlezone.json` exists     |
| `[shuttlezone-tunnel] not connected to the edge`      | tunnel or credentials problem                         | the hostname resolves, `cloudflared tunnel info <slug>`, and the credentials' `TunnelID` |
| Cloudflare Error 1033                                 | no tunnel is connected to that hostname               | Step 3, and the till's log                                                               |
| unreachable / timeout from ShuttleZone                | `POS API base URL` does not match the tunnel hostname | both must be `https://example-seller.shuttlezone.app`, no path, no port                  |
| Test connection passes, nothing changes               | the webhook half, not the token half                  | `/admin/pos/deliveries`, then the POS Webhooks screen                                    |
| build fails at "missing 6 secrets"                    | a secret name is mistyped, or unset                   | `gh secret list`, compare names character for character                                  |

Noise that is **not** a fault, present on every install:

```
POST /public/client-errors  -> 403 Your session security token is missing or expired
GET  /public/runtime-info   -> 404 Not Found
GET  /public/events         -> 404 Not Found
```

## Where to look, on the machine

| Path                                          | What it holds                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `%APPDATA%\posnic\app.log`                    | the full application log, including `[shuttlezone]` and `[shuttlezone-tunnel]` |
| `%APPDATA%\posnic\health-status.json`         | tunnel and API health, for support rather than the shopkeeper                  |
| `resources\shuttlezone-seed\shuttlezone.json` | the seed baked into that installer (inside the install folder)                 |
| `resources\cloudflared\`                      | the bundled tunnel client                                                      |

## Rotating a seller's credentials

If a token or secret leaked, or a seller's installer is lost: generate a new
token, paste it into the connection, update the secrets, rebuild with Step 6 and
Step 7, and re-send. The POS **replaces the old token and revokes it** as it
provisions the new one, so the superseded value stops working immediately rather
than lingering as a second way in.

Rotating the webhook secret is the same shape: rotate it in ShuttleZone, then
update `SHUTTLEZONE_WEBHOOK_SECRET` and rebuild, because the shop's install keeps
signing with the old value and its signals will be rejected.

After a rotation, delete the old connection at `/admin/pos/<id>` so it cannot be
confused with the new one.

## Quick reference

| Thing                             | Value                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Workflow                          | `.github/workflows/build-seller-installer.yml` (see [the workflow](../.github/workflows/build-seller-installer.yml)) |
| Seed writer                       | `.github/scripts/write-pairing-seed.js`                                                                              |
| Seed a check reads                | `builds/shuttlezone-seed/shuttlezone.json` plus `tunnel-credentials.json`                                            |
| Artifact name                     | `<seller>-installer`, 14 day retention                                                                               |
| Local pairing check               | `npm run check:pairing`                                                                                              |
| Local paired build (Windows only) | `npm run prebuild`, write seed, then `npm run build:paired`                                                          |
