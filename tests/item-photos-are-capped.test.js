'use strict';

/*
 * EIGHT PHOTOS, AND WHERE THEY SIT.
 *
 * The form takes at most eight. It used to take twelve, so a shop could attach
 * more pictures than its own storefront would ever mirror - the extras were
 * uploaded, stored, and seen by nobody.
 *
 * There is no rule requiring a photo. One was added and then removed again at
 * the owner's request, and the assertion below says so, because "the field has
 * a red asterisk" and "the form refuses to save" are easy to confuse.
 *
 * The last test is the one worth keeping. The rules that turn the uploader into
 * a compact strip were scoped to `#item_tab_details`, so moving that markup to
 * another tab left it sized like a landing page, with nothing erroring and no
 * other test able to notice. Scoping them to the form means the styling follows
 * the control wherever the control goes.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const HTML = read('frontend', 'modules', 'items_write.html');
const JS = read('frontend', 'static', 'script', 'js', 'modules', 'js', 'items.js');
const CSS = read('frontend', 'static', 'style', 'css', 'custom.css');

test('the form takes eight photos, not twelve', () => {
  assert.match(
    JS,
    /\$\('#item-display-preview'\)\.find\('div'\)\.length >= 8/,
    'the eight-photo cap is gone, so a shop can again attach more than its website mirrors'
  );
  assert.ok(
    !/\.length > 11/.test(JS),
    'the old twelve-photo cap is back, and the form and the website disagree again'
  );
  assert.ok(
    !/photosRequired/.test(JS),
    'the photo requirement is back, and a product can no longer be saved without a picture'
  );
});

test('the dropzone exists once, inside the form tabs', () => {
  const inputs = HTML.match(/id="item_upload_image"/g) || [];
  assert.strictEqual(inputs.length, 1, `the dropzone exists ${inputs.length} times`);

  const label = HTML.indexOf('for="item_upload_image"');
  const first = HTML.indexOf('id="item_tab_main"');
  const last = HTML.indexOf('id="item_tab_more"');
  assert.ok(label > first && label < last, 'the dropzone fell outside the form tabs');
});

test('the no-photo fallbacks still sit with the image', () => {
  /* The icon and the tile colour and shape answer the same question as the
     photos ("what does this look like"), so they follow the preview and stay
     above the date row rather than drifting down the form. */
  const preview = HTML.indexOf('id="item-display-preview"');
  const icon = HTML.indexOf('id="item_icon_row"');
  const tile = HTML.indexOf('id="item_tile_fallback"');
  const dates = HTML.indexOf('id="items_mfg_date"');

  assert.notStrictEqual(preview, -1, 'the preview strip is gone');
  assert.ok(icon > preview && icon < tile, 'the icon row drifted from the photos');
  assert.ok(tile > preview, 'the tile fallback drifted from the photos');
  assert.ok(tile < dates, 'the tile fallback was left down with the date row');
});

test('the dropzone styling is scoped to the form, not to a tab', () => {
  assert.match(
    CSS,
    /#items_new \.Neon\.Neon-theme-dragdropbox/,
    'the compact drop strip lost its scope, so the uploader is a landing page again'
  );
  assert.ok(
    !/#item_tab_details \.Neon/.test(CSS),
    'a dropzone rule is scoped to the Details pane again: it stops applying the moment the control moves'
  );
  assert.ok(
    !/#item_tab_details \.imagezoom/.test(CSS),
    'the preview zoom is scoped to the Details pane again, so magnifying a thumbnail silently stops working'
  );
});
