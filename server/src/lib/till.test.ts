import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedCashPaise, variancePaise, countTotalPaise, describeVariance, DENOMINATIONS,
} from './till.js';

const base = {
  opening_float_paise: 0,
  cash_sales_paise: 0,
  cash_refunds_paise: 0,
  cash_receipts_paise: 0,
  pay_in_paise: 0,
  pay_out_paise: 0,
};

describe('what the drawer should hold', () => {
  test('a float on its own', () => {
    assert.equal(expectedCashPaise({ ...base, opening_float_paise: 200000 }), 200000);
  });

  test('a day of trading, netted', () => {
    // ₹2,000 float, ₹14,350 taken in cash, ₹250 refunded, ₹1,100 collected
    // against an account, ₹500 change brought in, ₹3,000 sent to the bank.
    const expected = expectedCashPaise({
      opening_float_paise: 200000,
      cash_sales_paise: 1435000,
      cash_refunds_paise: 25000,
      cash_receipts_paise: 110000,
      pay_in_paise: 50000,
      pay_out_paise: 300000,
    });
    assert.equal(expected, 1470000); // ₹14,700
  });

  test('card and UPI never reach the drawer', () => {
    // The caller supplies cash figures only; this is the contract that keeps
    // a UPI-heavy day from looking like a huge shortfall at close.
    assert.equal(expectedCashPaise({ ...base, opening_float_paise: 100000 }), 100000);
  });

  test('paying out more than was taken shows honestly', () => {
    assert.equal(expectedCashPaise({ ...base, pay_out_paise: 5000 }), -5000);
  });
});

describe('variance', () => {
  test('counted less expected', () => {
    assert.equal(variancePaise(1470000, 1470000), 0);
    assert.equal(variancePaise(1465000, 1470000), -5000);
    assert.equal(variancePaise(1475000, 1470000), 5000);
  });

  test('a balanced drawer says so plainly', () => {
    assert.equal(describeVariance(0).severity, 'balanced');
  });

  test('small change is not treated as theft', () => {
    // A few rupees out on thousands is coins, and crying wolf about it is how
    // a real shortfall gets ignored later.
    assert.equal(describeVariance(-350).severity, 'minor');
    assert.equal(describeVariance(900).severity, 'minor');
  });

  test('a real gap says where to look', () => {
    const short = describeVariance(-250000);
    assert.equal(short.severity, 'significant');
    assert.match(short.text, /2500\.00/);
    assert.match(short.text, /UPI|payout/);

    const over = describeVariance(250000);
    assert.equal(over.severity, 'significant');
    assert.match(over.text, /without a bill/);
  });
});

describe('counting the drawer', () => {
  test('notes and coins total correctly', () => {
    // 3x500 + 2x200 + 4x100 + 1x50 + 3x10 + 2x1 = 1500+400+400+50+30+2 = 2382
    assert.equal(countTotalPaise({ 500: 3, 200: 2, 100: 4, 50: 1, 10: 3, 1: 2 }), 238200);
  });

  test('an empty count is zero, not an error', () => {
    assert.equal(countTotalPaise({}), 0);
  });

  test('nonsense entries are ignored rather than corrupting the total', () => {
    assert.equal(countTotalPaise({ 500: -3, 100: 0 }), 0);
  });

  test('every denomination in circulation is countable', () => {
    const all = Object.fromEntries(DENOMINATIONS.map((d) => [d, 1]));
    // 500+200+100+50+20+10+5+2+1 = 888
    assert.equal(countTotalPaise(all), 88800);
  });
});
