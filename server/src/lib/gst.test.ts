import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitInclusive, addExclusive, isValidGstin, stateCodeOfGstin,
  isInterstateSupply, STATE_CODES,
} from './gst.js';

describe('splitInclusive — extracting GST from an MRP-inclusive amount', () => {
  test('5% intra-state on ₹105 yields ₹100 taxable + ₹2.50 each', () => {
    const r = splitInclusive(10500, 5, false);
    assert.equal(r.taxable, 10000);
    assert.equal(r.cgst, 250);
    assert.equal(r.sgst, 250);
    assert.equal(r.igst, 0);
    assert.equal(r.total, 10500);
  });

  test('5% inter-state puts the whole tax in IGST', () => {
    const r = splitInclusive(10500, 5, true);
    assert.equal(r.taxable, 10000);
    assert.equal(r.igst, 500);
    assert.equal(r.cgst, 0);
    assert.equal(r.sgst, 0);
  });

  test('18% intra-state on ₹118', () => {
    const r = splitInclusive(11800, 18, false);
    assert.equal(r.taxable, 10000);
    assert.equal(r.cgst, 900);
    assert.equal(r.sgst, 900);
  });

  test('nil-rated life-saving drugs carry no tax', () => {
    const r = splitInclusive(50000, 0, false);
    assert.equal(r.taxable, 50000);
    assert.equal(r.tax, 0);
    assert.equal(r.total, 50000);
  });

  test('odd paise go to SGST so the line still foots exactly', () => {
    // ₹45.50 at 5%: taxable 4333.33 -> 4333, tax 217, split 108/109
    const r = splitInclusive(4550, 5, false);
    assert.equal(r.taxable + r.cgst + r.sgst, 4550);
    assert.equal(r.cgst, 108);
    assert.equal(r.sgst, 109);
  });

  test('invariant: taxable + all tax === input, across many amounts and slabs', () => {
    for (const rate of [0, 5, 12, 18, 28]) {
      for (let amt = 1; amt <= 5000; amt += 7) {
        for (const inter of [false, true]) {
          const r = splitInclusive(amt, rate, inter);
          assert.equal(
            r.taxable + r.cgst + r.sgst + r.igst, amt,
            `failed at amt=${amt} rate=${rate} interstate=${inter}`,
          );
          assert.ok(r.taxable >= 0 && r.cgst >= 0 && r.sgst >= 0 && r.igst >= 0);
        }
      }
    }
  });

  test('intra-state never produces IGST and vice versa', () => {
    const intra = splitInclusive(9999, 18, false);
    assert.equal(intra.igst, 0);
    const inter = splitInclusive(9999, 18, true);
    assert.equal(inter.cgst, 0);
    assert.equal(inter.sgst, 0);
  });
});

describe('addExclusive — distributor purchase invoices add tax on top', () => {
  test('5% on ₹100 taxable gives ₹105', () => {
    const r = addExclusive(10000, 5, false);
    assert.equal(r.cgst, 250);
    assert.equal(r.sgst, 250);
    assert.equal(r.total, 10500);
  });

  test('inter-state purchase from a Maharashtra distributor uses IGST', () => {
    const r = addExclusive(10000, 12, true);
    assert.equal(r.igst, 1200);
    assert.equal(r.total, 11200);
  });

  test('round trip: addExclusive then splitInclusive recovers the taxable value', () => {
    for (const rate of [5, 12, 18]) {
      for (let taxable = 100; taxable < 3000; taxable += 37) {
        const added = addExclusive(taxable, rate, false);
        const split = splitInclusive(added.total, rate, false);
        assert.ok(
          Math.abs(split.taxable - taxable) <= 1,
          `rate=${rate} taxable=${taxable} recovered=${split.taxable}`,
        );
      }
    }
  });
});

describe('GSTIN validation', () => {
  test('accepts well-formed GSTINs with a correct check digit', () => {
    // Widely published specimen GSTINs
    assert.ok(isValidGstin('27AAPFU0939F1ZV'));
    assert.ok(isValidGstin('29AAGCB7383J1Z4'));
  });

  test('rejects a wrong check digit', () => {
    assert.ok(!isValidGstin('27AAPFU0939F1ZX'));
  });

  test('rejects wrong length, bad shape and unknown state codes', () => {
    assert.ok(!isValidGstin('27AAPFU0939F1Z'));
    assert.ok(!isValidGstin(''));
    assert.ok(!isValidGstin('AAAAAAAAAAAAAAA'));
    assert.ok(!isValidGstin('99AAPFU0939F1ZV'));
  });

  test('Telangana is state code 36', () => {
    assert.equal(STATE_CODES['36'], 'Telangana');
    assert.equal(stateCodeOfGstin('36AAPFU0939F1ZV'), '36');
    assert.equal(stateCodeOfGstin('99AAPFU0939F1ZV'), null);
  });
});

describe('place of supply', () => {
  test('a Hyderabad walk-in customer is intra-state', () => {
    assert.equal(isInterstateSupply('36', '36'), false);
  });

  test('a customer billing to Andhra Pradesh is inter-state', () => {
    assert.equal(isInterstateSupply('36', '37'), true);
  });

  test('a blank place of supply defaults to intra-state (counter sale)', () => {
    assert.equal(isInterstateSupply('36', ''), false);
  });
});
