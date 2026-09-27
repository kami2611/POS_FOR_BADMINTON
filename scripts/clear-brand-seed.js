// Empties builds/brand-seed before a build.
//
// That directory is packaged into the installer as `resources/brand-seed`, and
// whatever is sitting in it on disk when electron-builder runs is what a shop
// sees on first launch. It is build output, not source - nothing regenerates it
// and nothing cleaned it, so a brand seed left behind by an earlier run stayed
// there.
//
// Which is exactly what happened: a stock installer went out wearing a
// customer's name and logo, because the previous build had been a branded one
// and this directory still held its files. Brand building has since moved to a
// separate private repository, so the only way to populate this now is by hand
// - but the failure was silent and shipped, so the guard stays.
//
// .gitkeep survives; it is what keeps the empty directory in git, and
// extraResources skips a `from` path that does not exist without saying so.

const fs = require("fs");
const path = require("path");

const seedDir = path.join(__dirname, "..", "builds", "brand-seed");

if (!fs.existsSync(seedDir)) {
  fs.mkdirSync(seedDir, { recursive: true });
  fs.writeFileSync(path.join(seedDir, ".gitkeep"), "");
  console.log("[brand-seed] created empty builds/brand-seed");
  process.exit(0);
}

let removed = 0;
for (const entry of fs.readdirSync(seedDir)) {
  if (entry === ".gitkeep") continue;
  fs.rmSync(path.join(seedDir, entry), { recursive: true, force: true });
  removed += 1;
}

if (removed > 0) {
  console.log(
    `[brand-seed] cleared ${removed} leftover item${removed === 1 ? "" : "s"} - this build is stock Posnic`,
  );
} else {
  console.log("[brand-seed] empty, as a stock build needs it to be");
}

/*
 * The same guard, for the same reason, for a per-seller seed folder.
 *
 * `builds/shuttlezone-seed/` carries one shop's ShuttleZone pairing values -
 * the webhook URL, the shared secret and the events to send - and packaging
 * copies it to `resources/shuttlezone-seed/`, where the shell reads it and
 * hands it to the API as environment. It is build output exactly like a brand
 * seed, with a worse failure if it outlives its build: a seed left behind by
 * one seller would go out in the NEXT seller's installer, and that seller's
 * shop would then sign every change signal with the first seller's key. Their
 * products would arrive under somebody else's storefront.
 *
 * So it is cleared here, in the same step every prebuild command already runs,
 * rather than in a script somebody has to remember.
 */
const pairingSeedDir = path.join(__dirname, "..", "builds", "shuttlezone-seed");

if (!fs.existsSync(pairingSeedDir)) {
  fs.mkdirSync(pairingSeedDir, { recursive: true });
  fs.writeFileSync(path.join(pairingSeedDir, ".gitkeep"), "");
  console.log("[shuttlezone-seed] created empty builds/shuttlezone-seed");
} else {
  let pairingRemoved = 0;
  let hadTunnelCredentials = false;
  for (const entry of fs.readdirSync(pairingSeedDir)) {
    if (entry === ".gitkeep" || entry === "README.txt") continue;
    /*
     * The tunnel's credentials file lives here too, beside the JSON, and it is
     * the more sensitive of the two: it is what lets a process run that
     * hostname. It is cleared by this loop like everything else - the explicit
     * note below exists so an operator who reads the log knows it was, and does
     * not go looking for a second copy that needs clearing by hand.
     */
    if (entry.endsWith(".json") && entry !== "shuttlezone.json") hadTunnelCredentials = true;
    fs.rmSync(path.join(pairingSeedDir, entry), { recursive: true, force: true });
    pairingRemoved += 1;
  }
  console.log(
    pairingRemoved > 0
      ? `[shuttlezone-seed] cleared ${pairingRemoved} leftover file${pairingRemoved === 1 ? "" : "s"} - this build is not paired to a website`
      : "[shuttlezone-seed] empty, as an unpaired build needs it to be",
  );
  if (hadTunnelCredentials) {
    console.log("[shuttlezone-seed]   (including tunnel credentials, which must not outlive their seller)");
  }
}

/*
 * `builds/cloudflared/` is deliberately NOT cleared, and that is worth saying
 * out loud so nobody "fixes" it later.
 *
 * The seed folder holds things that identify ONE shop - a webhook secret, an
 * API token, tunnel credentials - so it must never survive into the next
 * seller's build. The cloudflared binary identifies nobody: it is the same
 * third-party executable for every seller, downloaded once. Clearing it would
 * mean re-downloading 40 MB before every build, and would make a paired build
 * fail with "no_binary" for a reason that has nothing to do with pairing.
 */
