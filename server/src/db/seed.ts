/**
 * Seed a working demo of a Hyderabad retail medical store.
 *
 * Data is representative of real Indian retail pharmacy stock: brand names,
 * manufacturers, pack sizes, MRPs and — importantly — the correct Drugs &
 * Cosmetics schedule and GST slab for each item.
 *
 * Run with `npm run seed`. Add `--force` to wipe and reseed.
 */

import bcrypt from 'bcryptjs';
import { getDb, nowIso, today, addMonths, currentMonth, nextCounter, financialYear } from './index.js';
import { computeLine } from '../lib/billing.js';
import { addExclusive } from '../lib/gst.js';
import { roundOff } from '../lib/money.js';

const force = process.argv.includes('--force');
const db = getDb();
const ts = nowIso();
const cm = currentMonth();

// ---------------------------------------------------------------------------

type SeedProduct = {
  name: string;
  generic: string;
  mfr: string;
  category: string;
  schedule: 'OTC' | 'G' | 'H' | 'H1' | 'X' | 'C' | 'C1';
  hsn: string;
  gst: number;
  unit: string;
  packSize: number;
  packLabel: string;
  mrp: number;          // rupees, per pack
  costPct: number;      // purchase rate as a % of MRP (typical chemist margin)
  reorder: number;      // base units
  rack: string;
  coldChain?: boolean;
};

/**
 * GST: medicines under HSN 3003/3004 are at 5%. Medical devices, diagnostics
 * and most consumables sit at 12% or 18%. Nutraceuticals and cosmetics at 18%.
 * (The 12% slab was withdrawn for medicines w.e.f. 22-Sep-2025 but still
 * applies to several device/consumable headings.)
 */
const PRODUCTS: SeedProduct[] = [
  // ---- Analgesics / antipyretics — OTC -------------------------------------
  { name: 'Dolo 650 Tablet', generic: 'Paracetamol 650mg', mfr: 'Micro Labs Ltd', category: 'ANALGESIC', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 34.5, costPct: 78, reorder: 300, rack: 'A1' },
  { name: 'Crocin Advance 500 Tablet', generic: 'Paracetamol 500mg', mfr: 'GSK Consumer', category: 'ANALGESIC', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 30.0, costPct: 80, reorder: 200, rack: 'A1' },
  { name: 'Combiflam Tablet', generic: 'Ibuprofen 400mg + Paracetamol 325mg', mfr: 'Sanofi India', category: 'ANALGESIC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 20, packLabel: 'Strip of 20 tablets', mrp: 55.4, costPct: 80, reorder: 200, rack: 'A1' },
  { name: 'Zerodol-SP Tablet', generic: 'Aceclofenac 100mg + Paracetamol 325mg + Serratiopeptidase 15mg', mfr: 'Ipca Laboratories', category: 'ANALGESIC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 119.0, costPct: 78, reorder: 100, rack: 'A2' },

  // ---- Antibiotics — Schedule H1 (separate register mandatory) -------------
  { name: 'Augmentin 625 Duo Tablet', generic: 'Amoxycillin 500mg + Clavulanic Acid 125mg', mfr: 'GlaxoSmithKline', category: 'ANTIBIOTIC', schedule: 'H1', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 223.4, costPct: 82, reorder: 60, rack: 'B1' },
  { name: 'Azithral 500 Tablet', generic: 'Azithromycin 500mg', mfr: 'Alembic Pharmaceuticals', category: 'ANTIBIOTIC', schedule: 'H1', hsn: '3004', gst: 5, unit: 'TAB', packSize: 5, packLabel: 'Strip of 5 tablets', mrp: 130.5, costPct: 80, reorder: 50, rack: 'B1' },
  { name: 'Taxim-O 200 Tablet', generic: 'Cefixime 200mg', mfr: 'Alkem Laboratories', category: 'ANTIBIOTIC', schedule: 'H1', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 178.0, costPct: 80, reorder: 50, rack: 'B1' },
  { name: 'Ciplox 500 Tablet', generic: 'Ciprofloxacin 500mg', mfr: 'Cipla Ltd', category: 'ANTIBIOTIC', schedule: 'H1', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 78.5, costPct: 78, reorder: 60, rack: 'B2' },
  { name: 'Monocef 1gm Injection', generic: 'Ceftriaxone 1000mg', mfr: 'Aristo Pharmaceuticals', category: 'ANTIBIOTIC', schedule: 'H1', hsn: '3004', gst: 5, unit: 'VIAL', packSize: 1, packLabel: 'Single vial', mrp: 52.0, costPct: 75, reorder: 20, rack: 'F1' },

  // ---- Gastro -------------------------------------------------------------
  { name: 'Pan 40 Tablet', generic: 'Pantoprazole 40mg', mfr: 'Alkem Laboratories', category: 'GASTRO', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 156.0, costPct: 80, reorder: 150, rack: 'C1' },
  { name: 'Omez 20 Capsule', generic: 'Omeprazole 20mg', mfr: 'Dr Reddys Laboratories', category: 'GASTRO', schedule: 'H', hsn: '3004', gst: 5, unit: 'CAP', packSize: 20, packLabel: 'Strip of 20 capsules', mrp: 105.0, costPct: 78, reorder: 100, rack: 'C1' },
  { name: 'Digene Gel Mint', generic: 'Magnesium Hydroxide + Aluminium Hydroxide + Simethicone', mfr: 'Abbott India', category: 'GASTRO', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'BOTTLE', packSize: 1, packLabel: '200ml bottle', mrp: 145.0, costPct: 82, reorder: 20, rack: 'C2' },
  { name: 'Eldoper Capsule', generic: 'Loperamide 2mg', mfr: 'Micro Labs Ltd', category: 'GASTRO', schedule: 'H', hsn: '3004', gst: 5, unit: 'CAP', packSize: 10, packLabel: 'Strip of 10 capsules', mrp: 32.0, costPct: 78, reorder: 60, rack: 'C2' },
  { name: 'ORS Powder Orange', generic: 'Oral Rehydration Salts WHO formula', mfr: 'FDC Ltd', category: 'GASTRO', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'SACHET', packSize: 1, packLabel: '21.8g sachet', mrp: 22.0, costPct: 75, reorder: 100, rack: 'C3' },

  // ---- Cardiovascular / metabolic — chronic, high repeat ------------------
  { name: 'Telma 40 Tablet', generic: 'Telmisartan 40mg', mfr: 'Glenmark Pharmaceuticals', category: 'CARDIAC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 148.5, costPct: 80, reorder: 150, rack: 'D1' },
  { name: 'Amlong 5 Tablet', generic: 'Amlodipine 5mg', mfr: 'Micro Labs Ltd', category: 'CARDIAC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 62.0, costPct: 78, reorder: 150, rack: 'D1' },
  { name: 'Ecosprin 75 Tablet', generic: 'Aspirin 75mg', mfr: 'USV Private Ltd', category: 'CARDIAC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 14, packLabel: 'Strip of 14 tablets', mrp: 12.5, costPct: 75, reorder: 200, rack: 'D1' },
  { name: 'Rosuvas 10 Tablet', generic: 'Rosuvastatin 10mg', mfr: 'Sun Pharmaceutical', category: 'CARDIAC', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 168.0, costPct: 80, reorder: 100, rack: 'D2' },
  { name: 'Glycomet GP 1 Tablet', generic: 'Metformin 500mg + Glimepiride 1mg', mfr: 'USV Private Ltd', category: 'DIABETES', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 128.0, costPct: 80, reorder: 150, rack: 'D3' },
  { name: 'Januvia 100 Tablet', generic: 'Sitagliptin 100mg', mfr: 'MSD Pharmaceuticals', category: 'DIABETES', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 385.0, costPct: 85, reorder: 45, rack: 'D3' },
  { name: 'Human Mixtard 30/70 Insulin', generic: 'Human Insulin 100IU/ml', mfr: 'Novo Nordisk India', category: 'DIABETES', schedule: 'H', hsn: '3004', gst: 5, unit: 'VIAL', packSize: 1, packLabel: '10ml vial', mrp: 168.0, costPct: 82, reorder: 15, rack: 'FRIDGE', coldChain: true },

  // ---- Respiratory / allergy ----------------------------------------------
  { name: 'Montair-LC Tablet', generic: 'Montelukast 10mg + Levocetirizine 5mg', mfr: 'Cipla Ltd', category: 'RESPIRATORY', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 189.0, costPct: 80, reorder: 100, rack: 'E1' },
  { name: 'Allegra 120 Tablet', generic: 'Fexofenadine 120mg', mfr: 'Sanofi India', category: 'ALLERGY', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 218.0, costPct: 82, reorder: 80, rack: 'E1' },
  { name: 'Cetzine Tablet', generic: 'Cetirizine 10mg', mfr: 'Dr Reddys Laboratories', category: 'ALLERGY', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TAB', packSize: 10, packLabel: 'Strip of 10 tablets', mrp: 28.5, costPct: 75, reorder: 150, rack: 'E1' },
  { name: 'Asthalin Inhaler 100mcg', generic: 'Salbutamol 100mcg', mfr: 'Cipla Ltd', category: 'RESPIRATORY', schedule: 'H', hsn: '3004', gst: 5, unit: 'UNIT', packSize: 1, packLabel: '200 MDI', mrp: 128.0, costPct: 82, reorder: 15, rack: 'E2' },
  { name: 'Ascoril LS Syrup', generic: 'Ambroxol + Levosalbutamol + Guaiphenesin', mfr: 'Glenmark Pharmaceuticals', category: 'RESPIRATORY', schedule: 'H', hsn: '3004', gst: 5, unit: 'BOTTLE', packSize: 1, packLabel: '100ml bottle', mrp: 132.0, costPct: 80, reorder: 25, rack: 'E2' },

  // ---- Schedule X — narcotic/psychotropic, strictest controls -------------
  { name: 'Alprax 0.5 Tablet', generic: 'Alprazolam 0.5mg', mfr: 'Torrent Pharmaceuticals', category: 'PSYCHIATRY', schedule: 'X', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 62.0, costPct: 78, reorder: 30, rack: 'SAFE' },

  // ---- Thyroid / hormones -------------------------------------------------
  { name: 'Thyronorm 50mcg Tablet', generic: 'Thyroxine Sodium 50mcg', mfr: 'Abbott India', category: 'HORMONE', schedule: 'H', hsn: '3004', gst: 5, unit: 'TAB', packSize: 120, packLabel: 'Bottle of 120 tablets', mrp: 180.0, costPct: 82, reorder: 240, rack: 'D4' },

  // ---- Vitamins & supplements — 18% (nutraceutical, not a medicament) -----
  { name: 'Shelcal 500 Tablet', generic: 'Calcium Carbonate 500mg + Vitamin D3 250IU', mfr: 'Torrent Pharmaceuticals', category: 'SUPPLEMENT', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 128.0, costPct: 80, reorder: 150, rack: 'G1' },
  { name: 'Zincovit Tablet', generic: 'Multivitamin + Multimineral', mfr: 'Apex Laboratories', category: 'SUPPLEMENT', schedule: 'OTC', hsn: '2106', gst: 18, unit: 'TAB', packSize: 15, packLabel: 'Strip of 15 tablets', mrp: 108.0, costPct: 78, reorder: 150, rack: 'G1' },
  { name: 'Protinex Original 400g', generic: 'Protein supplement', mfr: 'Danone India', category: 'NUTRITION', schedule: 'OTC', hsn: '2106', gst: 18, unit: 'TIN', packSize: 1, packLabel: '400g tin', mrp: 550.0, costPct: 85, reorder: 8, rack: 'G2' },

  // ---- Topicals -----------------------------------------------------------
  { name: 'Betadine Ointment 20g', generic: 'Povidone Iodine 5% w/w', mfr: 'Win-Medicare', category: 'TOPICAL', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TUBE', packSize: 1, packLabel: '20g tube', mrp: 98.0, costPct: 80, reorder: 20, rack: 'H1' },
  { name: 'Volini Gel 30g', generic: 'Diclofenac + Linseed Oil + Methyl Salicylate + Menthol', mfr: 'Sun Pharmaceutical', category: 'TOPICAL', schedule: 'OTC', hsn: '3004', gst: 5, unit: 'TUBE', packSize: 1, packLabel: '30g tube', mrp: 135.0, costPct: 80, reorder: 20, rack: 'H1' },
  { name: 'Candid Dusting Powder 100g', generic: 'Clotrimazole 1% w/w', mfr: 'Glenmark Pharmaceuticals', category: 'TOPICAL', schedule: 'H', hsn: '3004', gst: 5, unit: 'BOTTLE', packSize: 1, packLabel: '100g bottle', mrp: 128.0, costPct: 80, reorder: 15, rack: 'H1' },

  // ---- Devices & consumables — 12% / 18% ----------------------------------
  { name: 'Dettol Antiseptic Liquid 250ml', generic: 'Chloroxylenol 4.8% w/v', mfr: 'Reckitt Benckiser', category: 'ANTISEPTIC', schedule: 'OTC', hsn: '3808', gst: 18, unit: 'BOTTLE', packSize: 1, packLabel: '250ml bottle', mrp: 155.0, costPct: 85, reorder: 15, rack: 'H2' },
  { name: 'Accu-Chek Active Test Strips', generic: 'Blood glucose test strips', mfr: 'Roche Diabetes Care', category: 'DEVICE', schedule: 'OTC', hsn: '3822', gst: 12, unit: 'BOX', packSize: 1, packLabel: 'Box of 50 strips', mrp: 1150.0, costPct: 88, reorder: 6, rack: 'I1' },
  { name: 'Omron HEM-7124 BP Monitor', generic: 'Digital blood pressure monitor', mfr: 'Omron Healthcare', category: 'DEVICE', schedule: 'OTC', hsn: '9018', gst: 12, unit: 'UNIT', packSize: 1, packLabel: 'Single unit', mrp: 2350.0, costPct: 88, reorder: 3, rack: 'I1' },
  { name: 'Surgical Face Mask 3-Ply', generic: 'Disposable 3-ply mask', mfr: 'Romsons Scientific', category: 'CONSUMABLE', schedule: 'OTC', hsn: '6307', gst: 5, unit: 'BOX', packSize: 1, packLabel: 'Box of 50', mrp: 120.0, costPct: 70, reorder: 10, rack: 'I2' },
  { name: 'Dispovan Syringe 5ml', generic: 'Disposable syringe with needle', mfr: 'Hindustan Syringes', category: 'CONSUMABLE', schedule: 'OTC', hsn: '9018', gst: 12, unit: 'NOS', packSize: 1, packLabel: 'Single syringe', mrp: 8.0, costPct: 65, reorder: 100, rack: 'I2' },
  { name: 'Cotton Roll 100g', generic: 'Absorbent cotton wool IP', mfr: 'Jyoti Surgicals', category: 'CONSUMABLE', schedule: 'OTC', hsn: '3005', gst: 5, unit: 'ROLL', packSize: 1, packLabel: '100g roll', mrp: 65.0, costPct: 70, reorder: 15, rack: 'I2' },
];

const SUPPLIERS = [
  { name: 'Sri Venkateswara Pharma Distributors', contact: 'K. Ramesh', phone: '9848012345', address: '12-2-417/A, Gudimalkapur Main Road', city: 'Hyderabad', state: 'Telangana', code: '36', gstin: '36AAPFU0939F1ZV', dl: 'TS/HYD/20B/2019/1145', credit: 30 },
  { name: 'Deccan Medical Agencies', contact: 'Syed Imran', phone: '9440098765', address: '5-4-88, Ranigunj, Secunderabad', city: 'Hyderabad', state: 'Telangana', code: '36', gstin: '', dl: 'TS/HYD/21B/2018/0872', credit: 21 },
  { name: 'Kaveri Drug House', contact: 'P. Lakshmi', phone: '9032145678', address: '3-6-198, Himayatnagar', city: 'Hyderabad', state: 'Telangana', code: '36', gstin: '', dl: 'TS/HYD/20B/2020/2231', credit: 15 },
  { name: 'Bombay Pharma Traders', contact: 'Nitin Shah', phone: '9820011223', address: 'Princess Street, Marine Lines', city: 'Mumbai', state: 'Maharashtra', code: '27', gstin: '27AAPFU0939F1ZV', dl: 'MH/MUM/20B/2017/4410', credit: 45 },
];

const DOCTORS = [
  { name: 'Dr. Srinivas Reddy', qual: 'MBBS, MD (General Medicine)', reg: 'TSMC/FMR/48211', hospital: 'Apollo Hospitals, Jubilee Hills', address: 'Road No 72, Jubilee Hills, Hyderabad 500033', phone: '9848100200' },
  { name: 'Dr. Ayesha Fatima', qual: 'MBBS, DCH', reg: 'TSMC/FMR/52907', hospital: 'Rainbow Children Hospital, Banjara Hills', address: 'Road No 2, Banjara Hills, Hyderabad 500034', phone: '9948223344' },
  { name: 'Dr. M. Prakash Rao', qual: 'MBBS, MS (Ortho)', reg: 'TSMC/FMR/39118', hospital: 'Yashoda Hospitals, Somajiguda', address: 'Raj Bhavan Road, Somajiguda, Hyderabad 500082', phone: '9866554433' },
  { name: 'Dr. Kavita Sharma', qual: 'MBBS, DGO', reg: 'TSMC/FMR/61402', hospital: 'Fernandez Hospital, Hyderguda', address: 'Bogulkunta, Hyderguda, Hyderabad 500029', phone: '9700112233' },
];

const CUSTOMERS = [
  { name: 'Ramesh Kumar', phone: '9849011223', address: 'Flat 302, Sai Residency, Ameerpet', city: 'Hyderabad' },
  { name: 'Sunitha Rao', phone: '9700334455', address: '8-3-231, Yousufguda', city: 'Hyderabad' },
  { name: 'Mohammed Ilyas', phone: '9391556677', address: '16-11-20, Malakpet', city: 'Hyderabad' },
  { name: 'Lakshmi Prasad', phone: '9848778899', address: 'Plot 45, Kukatpally Housing Board', city: 'Hyderabad' },
  { name: 'Anjali Verma', phone: '9959001122', address: 'Villa 7, Gachibowli', city: 'Hyderabad' },
  { name: 'Sri Sai Clinic', phone: '9440887766', address: '2-1-98, Nallakunta', city: 'Hyderabad', gstin: '36AAGCB7383J1Z1' },
];

// ---------------------------------------------------------------------------

function alreadySeeded(): boolean {
  const row = db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number };
  return row.c > 0;
}

function wipe(): void {
  // Every table, children before parents. Anything missing here survives a
  // --force reseed and collides with the new data on a unique key.
  const tables = [
    'h1_register', 'sale_return_items', 'sale_returns', 'sale_items', 'sales',
    'customer_receipts', 'held_bills',
    'purchase_return_items', 'purchase_returns', 'supplier_payments',
    'purchase_items', 'purchases', 'stock_ledger', 'stock_adjustments', 'batches',
    'products', 'customers', 'doctors', 'suppliers', 'audit_log', 'counters',
    'users', 'settings',
  ];
  db.pragma('foreign_keys = OFF');
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM sqlite_sequence").run();
  db.pragma('foreign_keys = ON');
}

/** Deterministic pseudo-random so reseeding produces a comparable dataset. */
let rngState = 20260728;
function rand(): number {
  rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
  return rngState / 0x7fffffff;
}
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function batchNo(i: number): string {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return `${letters[randInt(0, 23)]}${letters[randInt(0, 23)]}${String(randInt(1000, 9999))}${i % 10}`;
}

// ---------------------------------------------------------------------------

function main(): void {
  if (alreadySeeded() && !force) {
    console.log('Database already has data. Re-run with --force to wipe and reseed.');
    return;
  }
  if (force) {
    console.log('Wiping existing data...');
    wipe();
  }

  db.transaction(() => {
    // ---- Shop identity ----------------------------------------------------
    db.prepare(
      `INSERT INTO settings (id, shop_name, legal_name, address_line1, address_line2, city, state,
         state_code, pincode, phone, email, gstin, pan, dl_no_form20, dl_no_form21, fssai_no,
         pharmacist_name, pharmacist_reg_no, invoice_prefix, return_prefix, invoice_footer,
         round_off_enabled, expiry_alert_days, low_stock_enabled, updated_at)
       VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,90,1,?)`,
    ).run(
      'Sai Krishna Medical & General Stores',
      'Sai Krishna Medicals',
      'Shop No. 5, Ground Floor, Balaji Complex',
      'Street No. 8, Habsiguda, Near Metro Station',
      'Hyderabad', 'Telangana', '36', '500007',
      '040-27176543, 9848012345',
      'saikrishnamedicals.hyd@gmail.com',
      '36AAPFU0939F1ZV', 'AAPFU0939F',
      'TS/HYD/20/2021/003412', 'TS/HYD/21/2021/003413',
      '13624999000123',
      'B. Sai Krishna', 'TSPC/A/24187',
      'INV', 'CN',
      'Medicines once sold are not returnable except for manufacturing defect. Keep out of reach of children. Store below 25°C.',
      ts,
    );

    // ---- Users ------------------------------------------------------------
    const users = [
      { u: 'admin', p: 'admin123', n: 'B. Sai Krishna', r: 'admin', reg: 'TSPC/A/24187', ph: '9848012345' },
      { u: 'pharmacist', p: 'pharma123', n: 'K. Deepika', r: 'pharmacist', reg: 'TSPC/A/31905', ph: '9700445566' },
      { u: 'cashier', p: 'cash123', n: 'Ravi Teja', r: 'cashier', reg: '', ph: '9391778899' },
    ];
    for (const u of users) {
      db.prepare(
        `INSERT INTO users (username, password_hash, full_name, role, pharmacist_reg_no, phone, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(u.u, bcrypt.hashSync(u.p, 10), u.n, u.r, u.reg, u.ph, ts);
    }

    // ---- Suppliers, doctors, customers ------------------------------------
    for (const s of SUPPLIERS) {
      db.prepare(
        `INSERT INTO suppliers (name, contact_person, phone, address, city, state, state_code,
           gstin, dl_no, credit_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(s.name, s.contact, s.phone, s.address, s.city, s.state, s.code, s.gstin, s.dl, s.credit, ts);
    }
    for (const d of DOCTORS) {
      db.prepare(
        `INSERT INTO doctors (name, qualification, reg_no, hospital, address, phone, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(d.name, d.qual, d.reg, d.hospital, d.address, d.phone, ts);
    }
    for (const c of CUSTOMERS) {
      // A couple of regulars run a monthly account — the clinic and one chronic
      // patient — so the dues screen has something realistic to show.
      const limit = c.name === 'Sri Sai Clinic' ? 2500000
        : c.name === 'Ramesh Kumar' ? 500000 : 0;
      db.prepare(
        `INSERT INTO customers (name, phone, address, city, gstin, credit_limit, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(c.name, c.phone, c.address, c.city, (c as { gstin?: string }).gstin ?? '', limit, ts);
    }

    // ---- Products ---------------------------------------------------------
    for (const p of PRODUCTS) {
      db.prepare(
        `INSERT INTO products (name, generic_name, manufacturer, category, schedule_type, hsn_code,
           gst_rate, unit, pack_size, pack_label, rack, reorder_level, cold_chain, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(p.name, p.generic, p.mfr, p.category, p.schedule, p.hsn, p.gst, p.unit,
        p.packSize, p.packLabel, p.rack, p.reorder, p.coldChain ? 1 : 0, ts, ts);
    }

    const productRows = db.prepare('SELECT * FROM products ORDER BY id').all() as Array<{
      id: number; pack_size: number; name: string;
    }>;
    const supplierIds = (db.prepare('SELECT id FROM suppliers').all() as { id: number }[]).map((r) => r.id);

    // ---- Opening stock: 1-3 batches per product, spread across expiry dates
    let batchCounter = 0;
    for (let i = 0; i < productRows.length; i++) {
      const product = productRows[i];
      const seed = PRODUCTS[i];
      const batchCount = randInt(1, 3);

      for (let b = 0; b < batchCount; b++) {
        batchCounter++;
        // A few near-expiry and expired batches so the alerts have real data.
        let monthsOut: number;
        if (batchCounter % 17 === 0) monthsOut = -randInt(1, 4);        // already expired
        else if (batchCounter % 7 === 0) monthsOut = randInt(0, 2);     // expiring soon
        else monthsOut = randInt(6, 30);

        const expiry = addMonths(cm, monthsOut);
        const mrpPaise = Math.round(seed.mrp * 100);
        // A distributor quotes rate *exclusive* of GST while MRP is inclusive,
        // so the trade margin applies to the ex-GST value of the MRP. Taking
        // the percentage off the inclusive MRP would understate — and for
        // 12%/18% items invert — the shop's real margin.
        const exGstMrp = (mrpPaise * 100) / (100 + seed.gst);
        const costPaise = Math.round((exGstMrp * seed.costPct) / 100);
        // Sized so a month of simulated trading leaves a realistic shelf rather
        // than emptying it: fast movers carry deeper cover than slow ones.
        const packs = seed.reorder >= 100 ? randInt(40, 110) : randInt(10, 40);

        db.prepare(
          `INSERT INTO batches (product_id, batch_no, expiry, mrp_paise, purchase_rate_paise,
             sale_rate_paise, qty_units, supplier_id, received_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(product.id, batchNo(batchCounter), expiry, mrpPaise, costPaise, mrpPaise,
          packs * product.pack_size, pick(supplierIds), today(), ts);
      }
    }

    // Ledger opening entries so every batch has a traceable origin.
    const allBatches = db.prepare('SELECT * FROM batches').all() as Array<{
      id: number; product_id: number; qty_units: number;
    }>;
    for (const b of allBatches) {
      db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id, qty_in,
           qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'PURCHASE','opening',NULL,?,0,?,'Opening stock',1,?)`,
      ).run(b.product_id, b.id, b.qty_units, b.qty_units, ts);
    }

    console.log(`  ${productRows.length} products, ${allBatches.length} batches`);
  })();

  seedSalesHistory();
  seedPurchaseHistory();

  console.log('\nSeed complete.\n');
  console.log('  Shop     : Sai Krishna Medical & General Stores, Habsiguda, Hyderabad');
  console.log('  GSTIN    : 36AAPFU0939F1ZV   DL: TS/HYD/20/2021/003412, TS/HYD/21/2021/003413');
  console.log('\n  Sign in with:');
  console.log('    admin      / admin123     (owner — full access)');
  console.log('    pharmacist / pharma123    (billing, purchases, Schedule H1)');
  console.log('    cashier    / cash123      (billing only, no H1 dispensing)\n');
}

/**
 * Generate ~30 days of trading so reports, margins and the H1 register have
 * something real to show. Uses the same arithmetic as the live billing path.
 */
function seedSalesHistory(): void {
  const products = db.prepare(
    `SELECT p.*, (SELECT COUNT(*) FROM batches b WHERE b.product_id = p.id AND b.qty_units > 0) AS nb
       FROM products p WHERE p.active = 1`,
  ).all() as Array<Record<string, number | string>>;
  const inStock = products.filter((p) => Number(p.nb) > 0);
  const customers = db.prepare('SELECT * FROM customers').all() as Array<{ id: number; name: string; phone: string; gstin: string; credit_limit: number }>;
  const doctors = db.prepare('SELECT * FROM doctors').all() as Array<{ id: number; name: string; address: string; reg_no: string }>;

  let bills = 0;

  db.transaction(() => {
    for (let daysAgo = 30; daysAgo >= 0; daysAgo--) {
      const billsToday = randInt(6, 18);
      for (let n = 0; n < billsToday; n++) {
        const dateIso = db.prepare("SELECT datetime('now', ?, 'localtime') AS d")
          .get(`-${daysAgo} days`) as { d: string };
        const invoiceDate = `${dateIso.d.slice(0, 10)}T${String(randInt(9, 21)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:00`;
        const invoiceDay = invoiceDate.slice(0, 10);

        const lineCount = randInt(1, 5);
        const chosen: Array<Record<string, number | string>> = [];
        for (let i = 0; i < lineCount; i++) {
          const p = pick(inStock);
          if (!chosen.find((c) => c.id === p.id)) chosen.push(p);
        }

        const prepared: Array<{
          product: Record<string, number | string>;
          batch: { id: number; batch_no: string; expiry: string; mrp_paise: number; sale_rate_paise: number; qty_units: number };
          qty: number;
          line: { grossPaise: number; discountPaise: number; taxable: number; cgst: number; sgst: number; igst: number; netPaise: number; ratePaise: number };
        }> = [];

        for (const p of chosen) {
          const batch = db.prepare(
            `SELECT * FROM batches WHERE product_id = ? AND qty_units > 0 AND expiry >= ?
              ORDER BY expiry LIMIT 1`,
          ).get(p.id, cm) as typeof prepared[0]['batch'] | undefined;
          if (!batch) continue;

          const packSize = Number(p.pack_size);
          const maxUnits = Math.min(batch.qty_units, packSize * 2);
          if (maxUnits < 1) continue;
          const qty = packSize > 1 && rand() > 0.35
            ? packSize * randInt(1, 2)
            : randInt(1, Math.max(1, Math.min(10, maxUnits)));
          if (qty > batch.qty_units) continue;

          const line = computeLine({
            qtyUnits: qty,
            saleRatePerPackPaise: batch.sale_rate_paise,
            packSize,
            discountPct: 0,
            gstRate: Number(p.gst_rate),
            isInterstate: false,
          });
          prepared.push({ product: p, batch, qty, line });
        }
        if (prepared.length === 0) continue;

        const needsRx = prepared.some((x) => ['H', 'H1', 'X', 'C', 'C1'].includes(String(x.product.schedule_type)));
        const needsH1 = prepared.some((x) => ['H1', 'X'].includes(String(x.product.schedule_type)));
        const doctor = needsRx ? pick(doctors) : null;
        const customer = rand() > 0.45 ? pick(customers) : null;

        const gross = prepared.reduce((s, x) => s + x.line.grossPaise, 0);
        const discount = prepared.reduce((s, x) => s + x.line.discountPaise, 0);
        const taxable = prepared.reduce((s, x) => s + x.line.taxable, 0);
        const cgst = prepared.reduce((s, x) => s + x.line.cgst, 0);
        const sgst = prepared.reduce((s, x) => s + x.line.sgst, 0);
        const { adjustment, total } = roundOff(taxable + cgst + sgst);

        const fy = financialYear(invoiceDay);
        const seq = nextCounter(db, `invoice:${fy}`);
        const invoiceNo = `INV/${fy}/${String(seq).padStart(5, '0')}`;
        // Account customers sometimes buy on credit; everyone else pays at the
        // counter. paid_paise is what actually crossed the counter, so a credit
        // bill records zero and shows up as a due.
        const onAccount = !!customer && customer.credit_limit > 0 && rand() > 0.45;
        const paymentMode = onAccount
          ? 'CREDIT'
          : pick(['CASH', 'CASH', 'CASH', 'UPI', 'UPI', 'CARD']);
        const servedBy = needsH1 ? pick([1, 2]) : pick([1, 2, 3]);
        const pharmacistName = servedBy === 1 ? 'B. Sai Krishna' : servedBy === 2 ? 'K. Deepika' : 'B. Sai Krishna';
        const patientName = customer?.name ?? pick(['Walk-in Patient', 'Ravi', 'Sita', 'Imran', 'Padma']);

        const saleInfo = db.prepare(
          `INSERT INTO sales (invoice_no, invoice_date, customer_id, customer_name, customer_phone,
             customer_gstin, doctor_id, prescription_no, patient_name, patient_address,
             place_of_supply, is_interstate, gross_paise, discount_paise, taxable_paise,
             cgst_paise, sgst_paise, igst_paise, round_off_paise, total_paise, paid_paise,
             payment_mode, payment_ref, notes, served_by, pharmacist_name, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,'36',0,?,?,?,?,?,0,?,?,?,?,'','',?,?,?)`,
        ).run(
          invoiceNo, invoiceDate, customer?.id ?? null, customer?.name ?? 'Cash Customer',
          customer?.phone ?? '', customer?.gstin ?? '', doctor?.id ?? null,
          needsRx ? `RX${randInt(1000, 9999)}` : '',
          needsH1 ? patientName : '',
          needsH1 ? (customer?.name ? 'Hyderabad' : 'Habsiguda, Hyderabad') : '',
          gross, discount, taxable, cgst, sgst, adjustment, total, onAccount ? 0 : total,
          paymentMode, servedBy, pharmacistName, invoiceDate,
        );
        const saleId = Number(saleInfo.lastInsertRowid);

        for (const x of prepared) {
          const itemInfo = db.prepare(
            `INSERT INTO sale_items (sale_id, product_id, batch_id, product_name, manufacturer,
               hsn_code, schedule_type, batch_no, expiry, pack_size, qty_units, mrp_paise,
               rate_paise, gross_paise, discount_pct, discount_paise, taxable_paise, gst_rate,
               cgst_paise, sgst_paise, igst_paise, total_paise)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,0,?)`,
          ).run(saleId, x.product.id, x.batch.id, x.product.name, x.product.manufacturer,
            x.product.hsn_code, x.product.schedule_type, x.batch.batch_no, x.batch.expiry,
            x.product.pack_size, x.qty, x.batch.mrp_paise, x.line.ratePaise, x.line.grossPaise,
            x.line.discountPaise, x.line.taxable, x.product.gst_rate, x.line.cgst, x.line.sgst,
            x.line.netPaise);

          db.prepare('UPDATE batches SET qty_units = qty_units - ? WHERE id = ?')
            .run(x.qty, x.batch.id);
          db.prepare(
            `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
               qty_in, qty_out, balance_after, note, created_by, created_at)
             VALUES (?,?,'SALE','sales',?,0,?,?,?,?,?)`,
          ).run(x.product.id, x.batch.id, saleId, x.qty, x.batch.qty_units - x.qty,
            invoiceNo, servedBy, invoiceDate);

          if (['H1', 'X'].includes(String(x.product.schedule_type))) {
            db.prepare(
              `INSERT INTO h1_register (serial_no, supply_date, sale_id, sale_item_id, invoice_no,
                 prescriber_name, prescriber_address, prescriber_reg_no, patient_name,
                 patient_address, drug_name, quantity, manufacturer, batch_no, expiry,
                 pharmacist_name, pharmacist_reg_no, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(nextCounter(db, 'h1_register'), invoiceDay, saleId,
              Number(itemInfo.lastInsertRowid), invoiceNo,
              doctor?.name ?? '', doctor?.address ?? '', doctor?.reg_no ?? '',
              patientName, 'Habsiguda, Hyderabad', x.product.name,
              `${x.qty} ${x.product.unit}`, x.product.manufacturer, x.batch.batch_no,
              x.batch.expiry, pharmacistName, servedBy === 2 ? 'TSPC/A/31905' : 'TSPC/A/24187',
              invoiceDate);
          }
        }
        bills++;
      }
    }
  })();

  const h1 = db.prepare('SELECT COUNT(*) c FROM h1_register').get() as { c: number };
  console.log(`  ${bills} historical bills over 31 days, ${h1.c} Schedule H1 register entries`);

  // Account customers settle some of what they owe, so the dues screen shows a
  // realistic mix of settled, part-paid and still-outstanding bills.
  let receipts = 0;
  db.transaction(() => {
    const credit = db.prepare(
      `SELECT id, customer_id, invoice_date, total_paise FROM sales
        WHERE payment_mode = 'CREDIT' AND status = 'COMPLETED' AND total_paise > paid_paise
        ORDER BY invoice_date`,
    ).all() as Array<{ id: number; customer_id: number; invoice_date: string; total_paise: number }>;

    for (const bill of credit) {
      // Older bills are more likely to have been settled.
      if (rand() > 0.55) continue;
      const partial = rand() > 0.7;
      const amount = partial ? Math.round(bill.total_paise * 0.5) : bill.total_paise;
      if (amount <= 0) continue;

      const date = bill.invoice_date.slice(0, 10);
      const fy = financialYear(date);
      const seq = nextCounter(db, `customer_receipt:${fy}`);
      db.prepare(
        `INSERT INTO customer_receipts (receipt_no, receipt_date, customer_id, sale_id,
           amount_paise, mode, reference, notes, created_by, created_at)
         VALUES (?,?,?,?,?,?,'','',1,?)`,
      ).run(`RCT/${fy}/${String(seq).padStart(5, '0')}`, date, bill.customer_id, bill.id,
        amount, pick(['CASH', 'UPI', 'BANK']), ts);
      receipts++;
    }
  })();

  const due = db.prepare(
    `SELECT COALESCE(SUM(s.total_paise - s.paid_paise), 0)
            - COALESCE((SELECT SUM(amount_paise) FROM customer_receipts), 0) AS owed
       FROM sales s WHERE s.status = 'COMPLETED'`,
  ).get() as { owed: number };
  console.log(`  ${credit_count()} credit bills, ${receipts} customer receipts`);
  console.log(`  customers owe: Rs ${(due.owed / 100).toFixed(2)}`);
}

function credit_count(): number {
  return (db.prepare(
    "SELECT COUNT(*) c FROM sales WHERE payment_mode = 'CREDIT' AND status = 'COMPLETED'",
  ).get() as { c: number }).c;
}

/**
 * Generate goods-inward history: distributor invoices topping up stock the shop
 * already carries, the payments made against them, and one debit note for
 * near-expiry stock going back. Without this the Purchases, Supplier ledger and
 * Purchase returns screens are empty on a fresh install and look broken.
 */
function seedPurchaseHistory(): void {
  const suppliers = db.prepare('SELECT * FROM suppliers').all() as Array<{
    id: number; name: string; state_code: string; credit_days: number;
  }>;
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all() as Array<{
    id: number; name: string; pack_size: number; gst_rate: number;
  }>;
  const settings = db.prepare('SELECT state_code FROM settings WHERE id = 1').get() as
    { state_code: string };

  let invoices = 0, payments = 0;

  db.transaction(() => {
    // Invoices spread over ~2 months, so some sit inside their credit period and
    // some are overdue — otherwise the ageing report has nothing to show.
    for (let n = 0; n < 16; n++) {
      const daysAgo = randInt(1, 70);
      const invoiceDate = (db.prepare("SELECT date('now', ?, 'localtime') d")
        .get(`-${daysAgo} days`) as { d: string }).d;
      const supplier = pick(suppliers);
      const isInterstate = supplier.state_code !== settings.state_code;
      const ts = nowIso();

      const info = db.prepare(
        `INSERT INTO purchases (invoice_no, invoice_date, supplier_id, is_interstate,
           payment_mode, notes, created_by, created_at) VALUES (?,?,?,?,'CREDIT','',1,?)`,
      ).run(`${supplier.name.slice(0, 3).toUpperCase()}/${randInt(1000, 9999)}`,
        invoiceDate, supplier.id, isInterstate ? 1 : 0, ts);
      const purchaseId = Number(info.lastInsertRowid);

      let taxableTotal = 0, cgstTotal = 0, sgstTotal = 0, igstTotal = 0;
      const chosen: number[] = [];

      for (let i = 0; i < randInt(3, 7); i++) {
        const product = pick(products);
        if (chosen.includes(product.id)) continue;
        chosen.push(product.id);

        // Top up an existing batch, which is what reordering actually does.
        const batch = db.prepare(
          'SELECT * FROM batches WHERE product_id = ? AND expiry >= ? ORDER BY expiry DESC LIMIT 1',
        ).get(product.id, cm) as {
          id: number; batch_no: string; expiry: string; mrp_paise: number;
          purchase_rate_paise: number; qty_units: number;
        } | undefined;
        if (!batch) continue;

        const qtyPacks = randInt(5, 30);
        const freePacks = rand() > 0.8 ? 1 : 0;
        const discountPct = pick([0, 0, 2.5, 5, 10]);

        const gross = batch.purchase_rate_paise * qtyPacks;
        const discountPaise = Math.round((gross * discountPct) / 100);
        const taxablePaise = gross - discountPaise;
        const tax = addExclusive(taxablePaise, product.gst_rate, isInterstate);

        taxableTotal += taxablePaise;
        cgstTotal += tax.cgst;
        sgstTotal += tax.sgst;
        igstTotal += tax.igst;

        const addedUnits = (qtyPacks + freePacks) * product.pack_size;
        const balance = batch.qty_units + addedUnits;
        db.prepare('UPDATE batches SET qty_units = ? WHERE id = ?').run(balance, batch.id);

        db.prepare(
          `INSERT INTO purchase_items (purchase_id, product_id, batch_id, batch_no, expiry,
             pack_size, qty_packs, free_packs, purchase_rate_paise, mrp_paise, sale_rate_paise,
             discount_pct, gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(purchaseId, product.id, batch.id, batch.batch_no, batch.expiry, product.pack_size,
          qtyPacks, freePacks, batch.purchase_rate_paise, batch.mrp_paise, batch.mrp_paise,
          discountPct, product.gst_rate, taxablePaise, tax.cgst, tax.sgst, tax.igst, tax.total);

        db.prepare(
          `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
             qty_in, qty_out, balance_after, note, created_by, created_at)
           VALUES (?,?,'PURCHASE','purchases',?,?,0,?,?,1,?)`,
        ).run(product.id, batch.id, purchaseId, addedUnits, balance,
          `${supplier.name} restock`, ts);
      }

      const { adjustment, total } = roundOff(taxableTotal + cgstTotal + sgstTotal + igstTotal);
      db.prepare(
        `UPDATE purchases SET taxable_paise=?, cgst_paise=?, sgst_paise=?, igst_paise=?,
           round_off_paise=?, total_paise=? WHERE id=?`,
      ).run(taxableTotal, cgstTotal, sgstTotal, igstTotal, adjustment, total, purchaseId);
      invoices++;

      // Older invoices are settled; recent ones sit within their credit period,
      // so the outstanding report has something realistic to age.
      if (daysAgo > supplier.credit_days && rand() > 0.25) {
        const payDate = (db.prepare("SELECT date('now', ?, 'localtime') d")
          .get(`-${Math.max(0, daysAgo - randInt(1, 10))} days`) as { d: string }).d;
        const partial = rand() > 0.75;
        const amount = partial ? Math.round(total * 0.6) : total;
        if (amount > 0) {
          const fy = financialYear(payDate);
          const seq = nextCounter(db, `supplier_payment:${fy}`);
          db.prepare(
            `INSERT INTO supplier_payments (payment_no, payment_date, supplier_id, purchase_id,
               amount_paise, mode, reference, notes, created_by, created_at)
             VALUES (?,?,?,?,?,?,?,'',1,?)`,
          ).run(`PAY/${fy}/${String(seq).padStart(5, '0')}`, payDate, supplier.id, purchaseId,
            amount, pick(['BANK', 'UPI', 'CASH', 'CHEQUE']), `REF${randInt(10000, 99999)}`, ts);
          payments++;
        }
      }
    }

    // One debit note: near-expiry stock going back to the distributor.
    const candidate = db.prepare(
      `SELECT b.*, p.name product_name, p.manufacturer, p.hsn_code, p.pack_size, p.gst_rate
         FROM batches b JOIN products p ON p.id = b.product_id
        WHERE b.qty_units > 0 AND b.supplier_id IS NOT NULL AND b.expiry <= ?
        ORDER BY b.expiry LIMIT 1`,
    ).get(addMonths(cm, 2)) as any;

    if (candidate) {
      const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?')
        .get(candidate.supplier_id) as { id: number; name: string; state_code: string };
      const isInterstate = supplier.state_code !== settings.state_code;
      const returnDate = today();
      const fy = financialYear(returnDate);
      const seq = nextCounter(db, `purchase_return:${fy}`);
      const returnNo = `DN/${fy}/${String(seq).padStart(5, '0')}`;
      const ts = nowIso();
      const qty = Math.min(candidate.qty_units, candidate.pack_size * 2);

      const info = db.prepare(
        `INSERT INTO purchase_returns (return_no, return_date, supplier_id, is_interstate,
           reason, notes, created_by, created_at)
         VALUES (?,?,?,?,'NEAR_EXPIRY','Returned for credit before expiry',1,?)`,
      ).run(returnNo, returnDate, supplier.id, isInterstate ? 1 : 0, ts);
      const returnId = Number(info.lastInsertRowid);

      const taxablePaise = Math.round((candidate.purchase_rate_paise * qty) / candidate.pack_size);
      const tax = addExclusive(taxablePaise, candidate.gst_rate, isInterstate);

      db.prepare(
        `INSERT INTO purchase_return_items (return_id, product_id, batch_id, product_name,
           manufacturer, hsn_code, batch_no, expiry, pack_size, qty_units, rate_paise, mrp_paise,
           gst_rate, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(returnId, candidate.product_id, candidate.id, candidate.product_name,
        candidate.manufacturer, candidate.hsn_code, candidate.batch_no, candidate.expiry,
        candidate.pack_size, qty, candidate.purchase_rate_paise, candidate.mrp_paise,
        candidate.gst_rate, taxablePaise, tax.cgst, tax.sgst, tax.igst, tax.total);

      const balance = candidate.qty_units - qty;
      db.prepare('UPDATE batches SET qty_units = ? WHERE id = ?').run(balance, candidate.id);
      db.prepare(
        `INSERT INTO stock_ledger (product_id, batch_id, txn_type, ref_table, ref_id,
           qty_in, qty_out, balance_after, note, created_by, created_at)
         VALUES (?,?,'PURCHASE_RETURN','purchase_returns',?,0,?,?,?,1,?)`,
      ).run(candidate.product_id, candidate.id, returnId, qty, balance,
        `${returnNo} to ${supplier.name}`, ts);

      const { adjustment, total } = roundOff(tax.total);
      db.prepare(
        `UPDATE purchase_returns SET taxable_paise=?, cgst_paise=?, sgst_paise=?, igst_paise=?,
           round_off_paise=?, total_paise=? WHERE id=?`,
      ).run(taxablePaise, tax.cgst, tax.sgst, tax.igst, adjustment, total, returnId);
    }
  })();

  const outstanding = db.prepare(
    `SELECT COALESCE(SUM(p.total_paise), 0) - COALESCE((SELECT SUM(amount_paise)
       FROM supplier_payments), 0) AS due FROM purchases p`,
  ).get() as { due: number };

  console.log(`  ${invoices} purchase invoices, ${payments} supplier payments, 1 debit note`);
  console.log(`  supplier outstanding: Rs ${(outstanding.due / 100).toFixed(2)}`);
}

main();
