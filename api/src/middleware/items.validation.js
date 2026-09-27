const { body, param } = require('express-validator');
const { ObjectId } = require('mongodb');
const { FIELD_LIMITS, ERROR_MESSAGES } = require('../constants/items.constants');

/*
 * WHAT A PRODUCT MUST HAVE BEFORE IT CAN BE SOLD ANYWHERE.
 *
 * A shop's catalogue is published on its website as well as rung up at the
 * till, and the website cannot invent what it was never told: a product with
 * no price reads as free, one with no stock reads as available or not depending
 * on nothing at all, and one with no picture is a grey rectangle in a grid of
 * photographs.
 *
 * So four things are required on create - a name, a price, a quantity and at
 * least one image - and at most eight images, because the item screen can show
 * eight and a ninth would be silently dropped somewhere downstream.
 *
 * Deliberately NOT required: description, brand, category, tax, SKU, barcode.
 * The website fills descriptions and attributes in with its own AI for whatever
 * a shop leaves blank, and a category is something a shop may reasonably not
 * have decided yet.
 *
 * Services are exempt from the quantity (they hold no stock - see item_kind in
 * item.repository.js) and from the image (a haircut has no photograph).
 */
const isService = (_value, { req }) => String(req.body && req.body.item_kind) === 'service';

/** Shared by create and edit: the money has to be real. */
const PRICE_RULES = [
  body('selling_price')
    .notEmpty()
    .withMessage('Enter the price customers pay')
    .bail()
    .isFloat({ min: 0.01 })
    .withMessage('The price must be greater than zero'),
];

/** Shared by create and edit: stock is what the website mirrors. */
const STOCK_RULES = [
  body('available_quantity')
    .if((value, { req }) => !isService(value, { req }))
    .notEmpty()
    .withMessage('Enter how many are in stock')
    .bail()
    .isFloat({ min: 0 })
    .withMessage('Stock cannot be a negative number'),
];

/** Shared by create and edit: never more than the screen can show. */
const IMAGE_LIMIT_RULE = [
  body('image')
    .optional()
    .custom((value) => {
      if (value === undefined || value === null || value === '') return true;
      if (!Array.isArray(value)) throw new Error('Images must be a list');
      if (value.length > FIELD_LIMITS.IMAGES_MAX) {
        throw new Error(`A product can have at most ${FIELD_LIMITS.IMAGES_MAX} images`);
      }
      return true;
    }),
];

/**
 * Validation middleware for creating an item
 * Applied to the modern POST /items endpoint (ItemsController.add)
 */
const validateCreateItem = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage(ERROR_MESSAGES.ITEM_NAME_REQUIRED)
    .isLength({ min: FIELD_LIMITS.NAME_MIN, max: FIELD_LIMITS.NAME_MAX })
    .withMessage(
      `Item name must be between ${FIELD_LIMITS.NAME_MIN} and ${FIELD_LIMITS.NAME_MAX} characters`
    ),

  ...PRICE_RULES,
  ...STOCK_RULES,

  body('company_price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Company price must be a positive number'),

  /* At least one image. `cover_image` is the uploaded file the card and the
     product page show first, and the POS only sets it once a real image has
     been through the uploader - so it is the honest signal that there is one. */
  body('cover_image')
    .if((value, { req }) => !isService(value, { req }))
    .trim()
    .notEmpty()
    .withMessage('Upload at least one product image'),

  ...IMAGE_LIMIT_RULE,

  body('barcode_id')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: FIELD_LIMITS.BARCODE_MAX })
    .withMessage(`Barcode cannot exceed ${FIELD_LIMITS.BARCODE_MAX} characters`),

  body('description')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: FIELD_LIMITS.DESCRIPTION_MAX })
    .withMessage(`Description cannot exceed ${FIELD_LIMITS.DESCRIPTION_MAX} characters`),
];

/**
 * Validation middleware for updating an item
 * Applied to the modern PUT /items/:id endpoint (ItemsController.edit)
 *
 * The same four requirements as create, with one deliberate difference: an
 * image is only demanded when the request is actually changing the images. Most
 * edits arrive from a screen that sends only what it touched, and a saved
 * catalogue holds items photographed before any of this existed - refusing
 * those an edit until somebody uploads a picture would turn a rule about new
 * products into an outage on old ones.
 */
const validateUpdateItem = [
  param('id')
    .notEmpty()
    .withMessage(ERROR_MESSAGES.ITEM_ID_REQUIRED)
    .isMongoId()
    .withMessage('Invalid item ID format'),

  body('name')
    .optional()
    .trim()
    .notEmpty()
    .withMessage('Item name cannot be empty')
    .isLength({ min: FIELD_LIMITS.NAME_MIN, max: FIELD_LIMITS.NAME_MAX })
    .withMessage(
      `Item name must be between ${FIELD_LIMITS.NAME_MIN} and ${FIELD_LIMITS.NAME_MAX} characters`
    ),

  ...PRICE_RULES,
  ...STOCK_RULES,

  body('company_price')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Company price must be a positive number'),

  /* Present and empty means somebody cleared the picture, which is the one
     thing this must refuse. Absent means the screen did not touch images. */
  body('cover_image')
    .if((value) => value !== undefined)
    .if((value, { req }) => !isService(value, { req }))
    .trim()
    .notEmpty()
    .withMessage('Upload at least one product image'),

  ...IMAGE_LIMIT_RULE,

  body('barcode_id')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: FIELD_LIMITS.BARCODE_MAX })
    .withMessage(`Barcode cannot exceed ${FIELD_LIMITS.BARCODE_MAX} characters`),

  body('description')
    .optional({ checkFalsy: true })
    .trim()
    .isLength({ max: FIELD_LIMITS.DESCRIPTION_MAX })
    .withMessage(`Description cannot exceed ${FIELD_LIMITS.DESCRIPTION_MAX} characters`),
];

const ensureValidItemIdParam = (req, res, next) => {
  const { id } = req.params;
  if (!id || !ObjectId.isValid(id)) {
    return next('route');
  }
  return next();
};

/**
 * A waiter saying a dish has run out for tonight.
 *
 * Small on purpose: which dish, whether it is off or back, and which shop's
 * menu is being changed. Declaring it here is not only runtime safety - the
 * API document is generated from these rules, so an endpoint with no
 * validation is an endpoint nobody reading the docs can call correctly.
 */
const validateSoldOut = [
  body('item')
    .notEmpty()
    .withMessage('Which dish has run out?')
    .isMongoId()
    .withMessage('Invalid item ID format'),

  /* Absent means "it has run out". Only an explicit false puts it back, so a
     body that loses a field cannot quietly restock the kitchen. */
  body('off').optional().isBoolean().withMessage('off must be true or false'),

  body('branch').optional().isMongoId().withMessage('Invalid branch ID format'),
];

module.exports = {
  validateCreateItem,
  validateSoldOut,
  validateUpdateItem,
  ensureValidItemIdParam,
};
