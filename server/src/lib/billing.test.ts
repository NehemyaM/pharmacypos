import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLine, allocateFefo, InsufficientStockError, isExpired,
  monthsToExpiry, requiresPrescription, requiresH1Register,
  type AllocatableBatch,
} from './billing.js';

describe('computeLine', () => {
  test('a full strip of 10 bills exactly the strip MRP', () => {
    const r = computeLine({
      qtyUnits: 10, saleRatePerPackPaise: 4550, packSize: 10,
      discountPct: 0, gstRate: 5, isInterstate: false,
    });
    assert.equal(r.grossPaise, 4550);
    assert.equal(r.netPaise, 4550);
    assert.equal(r.ratePaise, 455);
    assert.equal(r.taxable + r.cgst + r.sgst, 4550);
  });

  test('loose tablets are priced pro-rata from the pack rate', () => {
    const r = computeLine({
      qtyUnits: 3, saleRatePerPackPaise: 4550, packSize: 10,
      discountPct: 0, gstRate: 5, isInterstate: false,
    });
    assert.equal(r.grossPaise, 1365); // 3 × ₹4.55
  });

  test('pack sizes that do not divide evenly still bill the full pack correctly', () => {
    // ₹107.00 for a strip of 15 — a rounded per-unit rate would lose 5 paise
    const r = computeLine({
      qtyUnits: 15, saleRatePerPackPaise: 10700, packSize: 15,
      discountPct: 0, gstRate: 5, isInterstate: false,
    });
    assert.equal(r.grossPaise, 10700);
  });

  test('discount is applied before tax is extracted', () => {
    const r = computeLine({
      qtyUnits: 10, saleRatePerPackPaise: 10000, packSize: 10,
      discountPct: 10, gstRate: 5, isInterstate: false,
    });
    assert.equal(r.grossPaise, 10000);
    assert.equal(r.discountPaise, 1000);
    assert.equal(r.netPaise, 9000);
    assert.equal(r.taxable + r.tax, 9000);
  });

  test('inter-state line uses IGST only', () => {
    const r = computeLine({
      qtyUnits: 1, saleRatePerPackPaise: 11800, packSize: 1,
      discountPct: 0, gstRate: 18, isInterstate: true,
    });
    assert.equal(r.igst, 1800);
    assert.equal(r.taxable, 10000);
    assert.equal(r.cgst, 0);
  });

  test('never charges more than the pack MRP for a whole pack', () => {
    for (const packSize of [1, 5, 10, 15, 30]) {
      for (const mrp of [1000, 4550, 10700, 23999]) {
        const r = computeLine({
          qtyUnits: packSize, saleRatePerPackPaise: mrp, packSize,
          discountPct: 0, gstRate: 5, isInterstate: false,
        });
        assert.equal(r.grossPaise, mrp, `packSize=${packSize} mrp=${mrp}`);
      }
    }
  });

  test('rejects invalid input', () => {
    const base = {
      qtyUnits: 1, saleRatePerPackPaise: 100, packSize: 1,
      discountPct: 0, gstRate: 5, isInterstate: false,
    };
    assert.throws(() => computeLine({ ...base, qtyUnits: 0 }));
    assert.throws(() => computeLine({ ...base, qtyUnits: -1 }));
    assert.throws(() => computeLine({ ...base, packSize: 0 }));
    assert.throws(() => computeLine({ ...base, discountPct: 101 }));
    assert.throws(() => computeLine({ ...base, discountPct: -5 }));
  });
});

describe('FEFO allocation', () => {
  const batches: AllocatableBatch[] = [
    { id: 1, batch_no: 'B-LATE', expiry: '2027-06', qty_units: 50, mrp_paise: 4550, sale_rate_paise: 4550 },
    { id: 2, batch_no: 'B-SOON', expiry: '2026-10', qty_units: 20, mrp_paise: 4500, sale_rate_paise: 4500 },
    { id: 3, batch_no: 'B-MID',  expiry: '2027-01', qty_units: 30, mrp_paise: 4550, sale_rate_paise: 4550 },
  ];

  test('consumes the earliest-expiring batch first', () => {
    const alloc = allocateFefo(batches, 10, '2026-07');
    assert.equal(alloc.length, 1);
    assert.equal(alloc[0].batchNo, 'B-SOON');
    assert.equal(alloc[0].qtyUnits, 10);
  });

  test('spills into later batches in expiry order', () => {
    const alloc = allocateFefo(batches, 60, '2026-07');
    assert.deepEqual(alloc.map((a) => [a.batchNo, a.qtyUnits]), [
      ['B-SOON', 20], ['B-MID', 30], ['B-LATE', 10],
    ]);
    assert.equal(alloc.reduce((s, a) => s + a.qtyUnits, 0), 60);
  });

  test('refuses to dispense expired stock even when quantity exists', () => {
    const expired: AllocatableBatch[] = [
      { id: 9, batch_no: 'OLD', expiry: '2026-06', qty_units: 100, mrp_paise: 100, sale_rate_paise: 100 },
    ];
    assert.throws(() => allocateFefo(expired, 1, '2026-07'), InsufficientStockError);
  });

  test('a batch expiring this month is still dispensable', () => {
    const thisMonth: AllocatableBatch[] = [
      { id: 9, batch_no: 'NOW', expiry: '2026-07', qty_units: 5, mrp_paise: 100, sale_rate_paise: 100 },
    ];
    const alloc = allocateFefo(thisMonth, 5, '2026-07');
    assert.equal(alloc[0].batchNo, 'NOW');
  });

  test('throws with the true available quantity when short', () => {
    try {
      allocateFefo(batches, 500, '2026-07');
      assert.fail('should have thrown');
    } catch (e) {
      assert.ok(e instanceof InsufficientStockError);
      assert.equal(e.available, 100);
      assert.equal(e.requested, 500);
    }
  });

  test('skips zero-quantity batches', () => {
    const withEmpty: AllocatableBatch[] = [
      { id: 1, batch_no: 'EMPTY', expiry: '2026-08', qty_units: 0, mrp_paise: 100, sale_rate_paise: 100 },
      { id: 2, batch_no: 'FULL', expiry: '2026-12', qty_units: 10, mrp_paise: 100, sale_rate_paise: 100 },
    ];
    const alloc = allocateFefo(withEmpty, 5, '2026-07');
    assert.equal(alloc.length, 1);
    assert.equal(alloc[0].batchNo, 'FULL');
  });
});

describe('expiry helpers', () => {
  test('isExpired is month-granular', () => {
    assert.equal(isExpired('2026-06', '2026-07'), true);
    assert.equal(isExpired('2026-07', '2026-07'), false);
    assert.equal(isExpired('2026-08', '2026-07'), false);
  });

  test('monthsToExpiry crosses year boundaries', () => {
    assert.equal(monthsToExpiry('2026-10', '2026-07'), 3);
    assert.equal(monthsToExpiry('2027-01', '2026-07'), 6);
    assert.equal(monthsToExpiry('2026-05', '2026-07'), -2);
  });
});

describe('drug schedule rules', () => {
  test('Schedule H, H1 and X need a prescription; OTC does not', () => {
    assert.ok(requiresPrescription('H'));
    assert.ok(requiresPrescription('H1'));
    assert.ok(requiresPrescription('X'));
    assert.ok(!requiresPrescription('OTC'));
    assert.ok(!requiresPrescription('G'));
  });

  test('only H1 and X require the separate bound register', () => {
    assert.ok(requiresH1Register('H1'));
    assert.ok(requiresH1Register('X'));
    assert.ok(!requiresH1Register('H'));
    assert.ok(!requiresH1Register('OTC'));
  });
});
