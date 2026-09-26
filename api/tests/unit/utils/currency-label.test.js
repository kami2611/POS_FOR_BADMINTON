'use strict';

/*
 * What goes beside a price.
 *
 * The bug this pins: the public menu printed the whole stored label -
 * "India Rupee / INR or ₹ 80" - beside every dish, because the branch keeps
 * the dropdown's label and the page was handed it unchanged.
 */

const {
  parseCurrencyLabel,
  currencySymbol,
  currencyCode,
} = require('../../../src/utils/currency-label');

describe('the label the signup dropdown writes', () => {
  test('is taken apart into name, code and symbol', () => {
    expect(parseCurrencyLabel('India Rupee / INR or Rs.')).toEqual({
      name: 'India Rupee',
      code: 'INR',
      symbol: 'Rs.',
    });
  });

  test('the symbol is what a price wears', () => {
    expect(currencySymbol('India Rupee / INR or Rs.')).toBe('Rs.');
    expect(currencySymbol('US Dollar / USD or $')).toBe('$');
    expect(currencyCode('US Dollar / USD or $')).toBe('USD');
  });

  test('a name containing "or" is not split on it', () => {
    /* "Norwegian Krone" carries the letters, not the word; a name with the
       word in it must still find the LAST separator. */
    expect(parseCurrencyLabel('Dollar or Peso / MXN or $')).toEqual({
      name: 'Dollar or Peso',
      code: 'MXN',
      symbol: '$',
    });
  });
});

describe('the shapes older and self-hosted installs have stored', () => {
  test('a bare ISO code is the code, and stands in as the symbol', () => {
    expect(parseCurrencyLabel('INR')).toEqual({ name: '', code: 'INR', symbol: 'INR' });
  });

  test('a bare symbol is the symbol', () => {
    expect(parseCurrencyLabel('Rs.')).toEqual({ name: '', code: '', symbol: 'Rs.' });
    expect(parseCurrencyLabel('$')).toEqual({ name: '', code: '', symbol: '$' });
  });

  test('the sign an older install stored is read, and wears the new one', () => {
    /* The stored row is nobody's fault and is not being rewritten - but a page
       that printed the character this codebase no longer writes would look
       like the change had not happened. */
    expect(parseCurrencyLabel('\u20b9')).toEqual({ name: '', code: '', symbol: 'Rs.' });
    expect(parseCurrencyLabel('India Rupee / INR or \u20b9')).toEqual({
      name: 'India Rupee',
      code: 'INR',
      symbol: 'Rs.',
    });
    expect(currencySymbol('\u20b9')).toBe('Rs.');
    expect(currencySymbol('\u00e2\u201a\u00b9')).toBe('Rs.');
  });

  test('a label with no symbol falls back to its code', () => {
    expect(parseCurrencyLabel('Euro / EUR')).toEqual({ name: 'Euro', code: 'EUR', symbol: 'EUR' });
  });

  test('"Rs." is a symbol people wrote by hand, not a code', () => {
    expect(parseCurrencyLabel('Rs.')).toEqual({ name: '', code: '', symbol: 'Rs.' });
  });

  test('a made-up code after the slash is not passed off as ISO', () => {
    /* A gateway handed "Rupees" as a currency code refuses the payment. */
    const parsed = parseCurrencyLabel('Indian / Rupees or Rs');
    expect(parsed.code).toBe('');
    expect(parsed.symbol).toBe('Rs');
  });

  test('nothing stored is nothing, not "undefined"', () => {
    expect(parseCurrencyLabel(undefined)).toEqual({ name: '', code: '', symbol: '' });
    expect(parseCurrencyLabel(null)).toEqual({ name: '', code: '', symbol: '' });
    expect(parseCurrencyLabel('   ')).toEqual({ name: '', code: '', symbol: '' });
    expect(currencySymbol('')).toBe('');
  });

  test('a plain name is kept as the name and is never blank beside a price', () => {
    expect(parseCurrencyLabel('Indian Rupee')).toEqual({
      name: 'Indian Rupee',
      code: '',
      symbol: 'Indian Rupee',
    });
  });
});
