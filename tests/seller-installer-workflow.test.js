'use strict';

/*
 * THE SELLER-INSTALLER WORKFLOW IS NOT A RELEASE PIPELINE, AND MUST NOT BECOME
 * ONE BY ACCIDENT.
 *
 * This repository has a deliberate policy that Windows installers are built and
 * signed at a desk, not in CI: the signing key lives on a Certum card, CA
 * requirements have put code-signing keys on certified hardware since June
 * 2023, and a GitHub-hosted runner has no card reader. A Windows build from CI
 * "could only ever be UNSIGNED, which is worse than no build at all: it looks
 * finished and tells every customer the publisher is unknown". That is asserted
 * for release.yml by tests/windows-release-separately.test.js.
 *
 * build-seller-installer.yml exists for the one case that policy does not
 * cover: producing an unsigned installer to TEST a seller's pairing with. That
 * is a legitimate need - a paired build has to be installed and watched to know
 * it works - and it is safe only for as long as the artifact cannot be mistaken
 * for something a shop should install.
 *
 * The distance between that and an unsigned installer escaping to customers is
 * one careless edit: `--publish always` added "so the file is easier to find",
 * or `contents: write`, or a tag trigger. None of those would fail a build. All
 * of them would put an unsigned installer where a real one belongs.
 *
 * So the boundary is written down here rather than in a comment somebody can
 * move.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILE = '.github/workflows/build-seller-installer.yml';
const workflow = fs.readFileSync(path.join(ROOT, FILE), 'utf8');

/*
 * Comments removed, and every assertion below runs against THIS.
 *
 * The first version of this file asserted against the raw text, and its own
 * explanatory comment - which says the workflow contains no publish flag -
 * made the "must not publish" check fail. That is the same trap
 * no-customer-branding.test.js records: a check that matches the prose written
 * to explain the rule rather than the rule itself.
 *
 * Stripping is safe here because every comment in the file is a whole line.
 */
const config = workflow
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

test('the workflow exists and is not a copy of the release pipeline', () => {
  assert.ok(fs.existsSync(path.join(ROOT, FILE)), `${FILE} is gone`);
  assert.ok(
    !fs.existsSync(path.join(ROOT, '.github/workflows/build-desktop.yml')),
    'the white-label build pipeline belongs in the private build repository'
  );
});

/* It runs when a human asks, and never on a push or a tag. A tag trigger would
   make it run on the same event as the real release. */
test('it only runs when somebody asks for it', () => {
  assert.match(config, /^on:\s*\n\s+workflow_dispatch:/m);
  for (const trigger of ['push:', 'pull_request:', 'schedule:', 'release:']) {
    assert.ok(
      !new RegExp(`^\\s{0,4}${trigger}`, 'm').test(config),
      `a ${trigger} trigger would make this run without anyone asking`
    );
  }
});

/* Read-only. This is what makes it impossible to attach the installer to a
   release even if a later edit asked it to. */
test('it cannot write to the repository', () => {
  assert.match(config, /permissions:\s*\n\s+contents:\s*read/);
  assert.ok(!/contents:\s*write/.test(config), 'contents: write would let it publish');
});

test('it never publishes, whatever else changes', () => {
  assert.ok(!/--publish\s+always/.test(config), 'this workflow must not publish');
  assert.ok(!/--publish\s+onTag/.test(config), 'this workflow must not publish');
  assert.ok(!/^\s*publish:\s*\n/m.test(config), 'electron-builder must not be told to publish');
  assert.match(config, /--publish\s+never/, 'the build must say --publish never');
});

test('its output is a workflow artifact, not a release asset', () => {
  assert.match(config, /actions\/upload-artifact@v\d+/);
  assert.ok(
    !/softprops|action-gh-release|gh release upload/.test(config),
    'nothing here should touch a GitHub Release'
  );
  /* Retained briefly on purpose: a test artifact, not an archive. */
  assert.match(config, /retention-days:\s*\d+/);
});

/* Order is a correctness property here, not style. The seed is written after
   the step that clears the seed directory, and the pairing is checked before
   anything is packaged - which is the whole reason check:pairing exists. */
test('it prepares before it seeds, and checks before it packages', () => {
  const prebuild = config.indexOf('npm run prebuild');
  const seed = config.indexOf('write-pairing-seed.js');
  const check = config.indexOf('check:pairing');
  const build = config.indexOf('electron-builder');

  assert.ok(prebuild !== -1 && seed !== -1 && check !== -1 && build !== -1);
  assert.ok(prebuild < seed, 'prebuild clears the seed directory; the seed must come after it');
  assert.ok(check < build, 'the pairing check must run before anything is packaged');
});

/* The two inputs a Windows runner has and a Mac does not. Without either, the
   installer is produced and cannot run - which is why the local build is
   documented as impossible rather than merely awkward. */
test('it supplies the two things only a Windows machine has', () => {
  assert.match(config, /mongodb-windows-x86_64-\$\{VERSION\}\.zip/);
  assert.match(config, /System32\/\$dll/, 'the VC++ runtime must be collected from the runner');
  assert.match(config, /check-mongodb-binaries\.js/);
  assert.match(config, /fetch-cloudflared\.js --win/);
});

/*
 * This repository is public and carries no customer's name
 * (tests/no-customer-branding.test.js). A default value on the seller input
 * would commit one - and, worse, silently build the wrong label for the next
 * seller.
 */
test('no seller name is baked in as a default', () => {
  const sellerInput = config.slice(config.indexOf('seller:'), config.indexOf('dry_run:'));
  assert.ok(!/default:/.test(sellerInput), 'the seller input must not have a default');
  assert.match(sellerInput, /required:\s*true/);
});
