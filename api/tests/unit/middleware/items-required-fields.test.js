'use strict';

/**
 * What a product MUST have before it can exist (operator decision, 2026-09-27).
 *
 * A shop's catalogue is published on its website as well as rung up at the
 * till, and the website cannot invent what it was never told: no price reads as
 * free, no quantity reads as available or not depending on nothing at all, and
 * no picture is a grey rectangle in a grid of photographs. So a name, a price,
 * a quantity and at least one image are required - and at most eight images,
 * because that is what the item screen shows.
 *
 * These run the REAL express-validator chains. The neighbouring
 * items.validation.test.js mocks express-validator down to a chain of no-ops,
 * which proves the rules are wired up and nothing about what they do; the two
 * are complementary, and this is the half that can fail.
 */

const { validationResult } = require('express-validator');
const {
  validateCreateItem,
  validateUpdateItem,
} = require('../../../src/middleware/items.validation');
const { FIELD_LIMITS } = require('../../../src/constants/items.constants');

const VALID_ID = '64f9a1c2e3b4d5e6f7000001';

/** Run a validator chain the way express does, then read the verdict. */
async function run(chain, body = {}, params = {}) {
  const req = { body, params, query: {}, headers: {} };
  for (const middleware of chain) {
    await new Promise((resolve, reject) => {
      middleware(req, {}, (err) => (err ? reject(err) : resolve()));
    });
  }
  return validationResult(req)
    .array()
    .map((e) => ({ field: e.path, message: e.msg }));
}

const A_WHOLE_PRODUCT = {
  name: 'Yonex Astrox 88D Pro',
  selling_price: '29500',
  available_quantity: '7',
  cover_image: 'astrox-main.jpg',
};

const fieldsWithErrors = (errors) => [...new Set(errors.map((e) => e.field))].sort();

describe('creating a product', () => {
  test('a name, a price, a quantity and one image are enough', async () => {
    expect(await run(validateCreateItem, A_WHOLE_PRODUCT)).toEqual([]);
  });

  test('nothing else is required - the website fills the rest in', async () => {
    /* No description, no brand, no category, no SKU, no barcode, no tax, no
       MRP. Every one of those is optional on purpose: descriptions and
       attributes are what the website's AI populates, and a shop may not have
       decided a category yet. If this test ever fails, a new "required" field
       has been added to a product and the shop has been handed work it was
       promised it would not have. */
    expect(await run(validateCreateItem, A_WHOLE_PRODUCT)).toEqual([]);
  });

  test('a product with no price is refused', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, selling_price: '' });
    expect(fieldsWithErrors(errors)).toEqual(['selling_price']);
  });

  test('a price of zero is refused - it would publish the product as free', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, selling_price: '0' });
    expect(fieldsWithErrors(errors)).toEqual(['selling_price']);
  });

  test('a product with no quantity is refused', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, available_quantity: '' });
    expect(fieldsWithErrors(errors)).toEqual(['available_quantity']);
  });

  test('zero quantity is accepted - sold out is a real state', async () => {
    expect(await run(validateCreateItem, { ...A_WHOLE_PRODUCT, available_quantity: '0' })).toEqual(
      []
    );
  });

  test('a negative quantity is refused', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, available_quantity: '-2' });
    expect(fieldsWithErrors(errors)).toEqual(['available_quantity']);
  });

  test('a product with no image is refused', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, cover_image: '' });
    expect(fieldsWithErrors(errors)).toEqual(['cover_image']);
    expect(errors[0].message).toMatch(/at least one product image/i);
  });

  test('eight images are allowed, nine are not', async () => {
    const eight = Array.from({ length: FIELD_LIMITS.IMAGES_MAX }, (_, i) => ({ name: `${i}.jpg` }));
    const nine = eight.concat([{ name: 'nine.jpg' }]);
    expect(await run(validateCreateItem, { ...A_WHOLE_PRODUCT, image: eight })).toEqual([]);
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, image: nine });
    expect(fieldsWithErrors(errors)).toEqual(['image']);
  });

  test('a name is still required', async () => {
    const errors = await run(validateCreateItem, { ...A_WHOLE_PRODUCT, name: '' });
    expect(fieldsWithErrors(errors)).toEqual(['name']);
  });

  /*
   * A service has no stock and no photograph - a restringing job is not a
   * thing with a picture - so the two rules that describe PHYSICAL stock skip
   * it. The price still applies: a service has a price.
   */
  test('a service is exempt from stock and images, but not from price', async () => {
    const service = {
      name: 'BG65 Restringing',
      selling_price: '1500',
      item_kind: 'service',
    };
    expect(await run(validateCreateItem, service)).toEqual([]);

    const errors = await run(validateCreateItem, { ...service, selling_price: '' });
    expect(fieldsWithErrors(errors)).toEqual(['selling_price']);
  });
});

describe('editing a product', () => {
  test('the same four requirements hold', async () => {
    expect(
      await run(validateUpdateItem, { ...A_WHOLE_PRODUCT, id: VALID_ID }, { id: VALID_ID })
    ).toEqual([]);
    const errors = await run(
      validateUpdateItem,
      { name: 'x', selling_price: '', available_quantity: '', cover_image: '' },
      { id: VALID_ID }
    );
    expect(fieldsWithErrors(errors)).toEqual([
      'available_quantity',
      'cover_image',
      'selling_price',
    ]);
  });

  /*
   * The one deliberate difference from create: an edit that simply does not
   * mention images is allowed, because most edits come from a screen that
   * sends only what was touched - and the saved catalogue holds items
   * photographed long before any of this existed. Clearing the picture, on the
   * other hand, is refused: that is the shop removing the only image a product
   * has, and the website has nothing to show afterwards.
   */
  test('an edit that leaves images alone is allowed', async () => {
    const withoutImages = { name: 'x', selling_price: '10', available_quantity: '1' };
    expect(await run(validateUpdateItem, withoutImages, { id: VALID_ID })).toEqual([]);
  });

  test('an edit that clears the image is refused', async () => {
    const cleared = {
      name: 'x',
      selling_price: '10',
      available_quantity: '1',
      cover_image: '',
    };
    const errors = await run(validateUpdateItem, cleared, { id: VALID_ID });
    expect(fieldsWithErrors(errors)).toEqual(['cover_image']);
  });
});
