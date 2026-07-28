import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatIndian, formatRupees, amountInWords, numberToWordsIndian,
  roundOff, rupeesToPaise, roundHalfUp,
} from './money.js';

describe('Indian digit grouping', () => {
  test('groups by lakh and crore, not by thousand', () => {
    assert.equal(formatIndian(100), '1.00');
    assert.equal(formatIndian(99999), '999.99');
    assert.equal(formatIndian(100000), '1,000.00');
    assert.equal(formatIndian(10000000), '1,00,000.00');
    assert.equal(formatIndian(123456789), '12,34,567.89');
    assert.equal(formatIndian(1234567890), '1,23,45,678.90');
  });

  test('pads paise and handles negatives', () => {
    assert.equal(formatIndian(5), '0.05');
    assert.equal(formatIndian(-45050), '-450.50');
    assert.equal(formatRupees(4550), '₹45.50');
  });
});

describe('amount in words', () => {
  test('renders rupees and paise for an invoice footer', () => {
    assert.equal(amountInWords(125050), 'Rupees One Thousand Two Hundred Fifty and Fifty Paise Only');
    assert.equal(amountInWords(10000), 'Rupees One Hundred Only');
    assert.equal(amountInWords(0), 'Rupees Zero Only');
    assert.equal(amountInWords(4550), 'Rupees Forty Five and Fifty Paise Only');
  });

  test('uses lakh and crore', () => {
    assert.equal(numberToWordsIndian(100000), 'One Lakh');
    assert.equal(numberToWordsIndian(1500000), 'Fifteen Lakh');
    assert.equal(numberToWordsIndian(10000000), 'One Crore');
    assert.equal(numberToWordsIndian(12345678), 'One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight');
  });

  test('handles the teens correctly', () => {
    assert.equal(numberToWordsIndian(19), 'Nineteen');
    assert.equal(numberToWordsIndian(115), 'One Hundred Fifteen');
  });
});

describe('round off to nearest rupee', () => {
  test('rounds down below fifty paise', () => {
    const r = roundOff(12340);
    assert.equal(r.total, 12300);
    assert.equal(r.adjustment, -40);
  });

  test('rounds up at fifty paise and above', () => {
    const r = roundOff(12350);
    assert.equal(r.total, 12400);
    assert.equal(r.adjustment, 50);
  });

  test('exact rupees need no adjustment', () => {
    const r = roundOff(10000);
    assert.equal(r.adjustment, 0);
    assert.equal(r.total, 10000);
  });

  test('adjustment always reconciles the original amount', () => {
    for (let p = 1; p < 2000; p++) {
      const r = roundOff(p);
      assert.equal(p + r.adjustment, r.total);
      assert.equal(r.total % 100, 0);
    }
  });
});

describe('rupee/paise conversion', () => {
  test('avoids float drift on classic problem values', () => {
    assert.equal(rupeesToPaise(45.5), 4550);
    assert.equal(rupeesToPaise(0.1 + 0.2), 30);
    assert.equal(rupeesToPaise('1234.56'), 123456);
    assert.equal(rupeesToPaise(19.99), 1999);
  });

  test('rejects garbage', () => {
    assert.throws(() => rupeesToPaise('abc'));
  });

  test('rounds half away from zero', () => {
    assert.equal(roundHalfUp(2.5), 3);
    assert.equal(roundHalfUp(-2.5), -3);
    assert.equal(roundHalfUp(2.4), 2);
  });
});
