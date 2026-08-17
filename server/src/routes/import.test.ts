import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseExpiry } from './import.js';

describe('expiry normalisation', () => {
  test('accepts YYYY-MM', () => {
    assert.equal(normaliseExpiry('2028-06'), '2028-06');
    assert.equal(normaliseExpiry('2028/6'), '2028-06');
  });

  test('accepts a full date and keeps the month', () => {
    assert.equal(normaliseExpiry('2028-06-30'), '2028-06');
  });

  test('accepts MM/YYYY, which is what a strip is printed with', () => {
    assert.equal(normaliseExpiry('06/2028'), '2028-06');
    assert.equal(normaliseExpiry('6-2028'), '2028-06');
  });

  test('accepts a two-digit year', () => {
    assert.equal(normaliseExpiry('06/28'), '2028-06');
  });

  test('accepts a month name', () => {
    assert.equal(normaliseExpiry('JUN-2028'), '2028-06');
    assert.equal(normaliseExpiry('Jun 28'), '2028-06');
    assert.equal(normaliseExpiry('june/2028'), '2028-06');
    assert.equal(normaliseExpiry('SEP-2027'), '2027-09');
  });

  test('accepts YYYYMM', () => {
    assert.equal(normaliseExpiry('202806'), '2028-06');
  });

  test('refuses a month that does not exist', () => {
    assert.equal(normaliseExpiry('2028-13'), null);
    assert.equal(normaliseExpiry('13/2028'), null);
    assert.equal(normaliseExpiry('2028-00'), null);
  });

  test('refuses a nonsense month name', () => {
    assert.equal(normaliseExpiry('XYZ-2028'), null);
  });

  test('refuses what it cannot read rather than guessing', () => {
    // A wrong guess would put stock on the shelf with the wrong expiry, and
    // FEFO would then dispense it in the wrong order.
    assert.equal(normaliseExpiry('next year'), null);
    assert.equal(normaliseExpiry('06'), null);
    assert.equal(normaliseExpiry('2028'), null);
    assert.equal(normaliseExpiry(''), null);
  });

  test('ignores surrounding whitespace', () => {
    assert.equal(normaliseExpiry('  2028-06  '), '2028-06');
  });
});
