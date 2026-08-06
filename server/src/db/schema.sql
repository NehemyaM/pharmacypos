-- PharmacyPOS schema — Indian retail medical store
--
-- Conventions
--   * All monetary values are INTEGER paise (₹1 = 100 paise). Never floats.
--   * All quantities are INTEGER *base units* (a tablet, a bottle, 1 ml pack).
--     `products.pack_size` converts base units <-> a saleable pack (strip/box).
--   * Drug expiry in India is month-granular, stored TEXT 'YYYY-MM'.
--     A batch is expired when strftime('%Y-%m','now') > expiry.
--   * Timestamps are TEXT ISO-8601 in IST (Asia/Kolkata), see db/index.ts nowIso().

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Shop identity & statutory particulars printed on every invoice
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  shop_name          TEXT    NOT NULL,
  legal_name         TEXT    NOT NULL DEFAULT '',
  address_line1      TEXT    NOT NULL DEFAULT '',
  address_line2      TEXT    NOT NULL DEFAULT '',
  city               TEXT    NOT NULL DEFAULT 'Hyderabad',
  state              TEXT    NOT NULL DEFAULT 'Telangana',
  state_code         TEXT    NOT NULL DEFAULT '36',   -- GST state code, Telangana = 36
  pincode            TEXT    NOT NULL DEFAULT '',
  phone              TEXT    NOT NULL DEFAULT '',
  email              TEXT    NOT NULL DEFAULT '',
  gstin              TEXT    NOT NULL DEFAULT '',
  pan                TEXT    NOT NULL DEFAULT '',
  -- Retail sale licences under the Drugs & Cosmetics Act, 1940
  dl_no_form20       TEXT    NOT NULL DEFAULT '',     -- Form 20: non-Schedule-C drugs
  dl_no_form21       TEXT    NOT NULL DEFAULT '',     -- Form 21: Schedule C & C1 drugs
  fssai_no           TEXT    NOT NULL DEFAULT '',
  pharmacist_name    TEXT    NOT NULL DEFAULT '',
  pharmacist_reg_no  TEXT    NOT NULL DEFAULT '',
  invoice_prefix     TEXT    NOT NULL DEFAULT 'INV',
  return_prefix      TEXT    NOT NULL DEFAULT 'CN',
  invoice_footer     TEXT    NOT NULL DEFAULT '',
  round_off_enabled  INTEGER NOT NULL DEFAULT 1,
  expiry_alert_days  INTEGER NOT NULL DEFAULT 90,
  low_stock_enabled  INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Users. A retail shop in Telangana must have a registered pharmacist present
-- during working hours; Schedule H1 supply is attributed to their reg. number.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE,
  password_hash     TEXT    NOT NULL,
  full_name         TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('admin','pharmacist','cashier')),
  pharmacist_reg_no TEXT    NOT NULL DEFAULT '',
  phone             TEXT    NOT NULL DEFAULT '',
  active            INTEGER NOT NULL DEFAULT 1,
  last_login_at     TEXT,
  created_at        TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Trade partners
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppliers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  contact_person TEXT    NOT NULL DEFAULT '',
  phone          TEXT    NOT NULL DEFAULT '',
  email          TEXT    NOT NULL DEFAULT '',
  address        TEXT    NOT NULL DEFAULT '',
  city           TEXT    NOT NULL DEFAULT '',
  state          TEXT    NOT NULL DEFAULT 'Telangana',
  state_code     TEXT    NOT NULL DEFAULT '36',
  gstin          TEXT    NOT NULL DEFAULT '',
  dl_no          TEXT    NOT NULL DEFAULT '',
  credit_days    INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

CREATE TABLE IF NOT EXISTS customers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  phone        TEXT    NOT NULL DEFAULT '',
  email        TEXT    NOT NULL DEFAULT '',
  address      TEXT    NOT NULL DEFAULT '',
  city         TEXT    NOT NULL DEFAULT 'Hyderabad',
  state_code   TEXT    NOT NULL DEFAULT '36',
  gstin        TEXT    NOT NULL DEFAULT '',
  credit_limit INTEGER NOT NULL DEFAULT 0,   -- paise
  notes        TEXT    NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customers_name  ON customers(name);

-- Prescribers. Required verbatim in the Schedule H1 register.
CREATE TABLE IF NOT EXISTS doctors (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  qualification TEXT    NOT NULL DEFAULT '',
  reg_no        TEXT    NOT NULL DEFAULT '',
  hospital      TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  phone         TEXT    NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doctors_name ON doctors(name);

-- ---------------------------------------------------------------------------
-- Product master
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  generic_name   TEXT    NOT NULL DEFAULT '',   -- composition / salt
  manufacturer   TEXT    NOT NULL DEFAULT '',
  category       TEXT    NOT NULL DEFAULT 'GENERAL',
  -- Drugs & Cosmetics Rules schedule governing sale
  schedule_type  TEXT    NOT NULL DEFAULT 'OTC'
                 CHECK (schedule_type IN ('OTC','G','H','H1','X','C','C1')),
  hsn_code       TEXT    NOT NULL DEFAULT '3004',
  gst_rate       INTEGER NOT NULL DEFAULT 5,    -- whole percent: 0 / 5 / 18
  unit           TEXT    NOT NULL DEFAULT 'TAB',
  pack_size      INTEGER NOT NULL DEFAULT 1 CHECK (pack_size > 0),
  pack_label     TEXT    NOT NULL DEFAULT '',   -- e.g. "Strip of 10 tablets"
  barcode        TEXT    NOT NULL DEFAULT '',
  rack           TEXT    NOT NULL DEFAULT '',
  reorder_level  INTEGER NOT NULL DEFAULT 0,    -- base units
  cold_chain     INTEGER NOT NULL DEFAULT 0,
  allow_loose    INTEGER NOT NULL DEFAULT 1,    -- may be sold as loose units
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_name     ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_generic  ON products(generic_name);
CREATE INDEX IF NOT EXISTS idx_products_barcode  ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_active   ON products(active);

-- ---------------------------------------------------------------------------
-- Batch-wise stock. Batch no. + expiry must appear on every invoice line, so
-- stock is *never* tracked at product level alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id         INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_no           TEXT    NOT NULL,
  expiry             TEXT    NOT NULL,          -- 'YYYY-MM'
  mrp_paise          INTEGER NOT NULL,          -- per pack, tax inclusive
  purchase_rate_paise INTEGER NOT NULL DEFAULT 0, -- per pack, exclusive of GST
  sale_rate_paise    INTEGER NOT NULL,          -- per pack, tax inclusive (<= MRP)
  qty_units          INTEGER NOT NULL DEFAULT 0,-- base units on hand
  supplier_id        INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  received_at        TEXT    NOT NULL,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT    NOT NULL,
  UNIQUE (product_id, batch_no, expiry)
);
CREATE INDEX IF NOT EXISTS idx_batches_product ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expiry  ON batches(expiry);
CREATE INDEX IF NOT EXISTS idx_batches_instock ON batches(product_id, qty_units);

-- ---------------------------------------------------------------------------
-- Purchases (goods inward against a distributor's tax invoice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no     TEXT    NOT NULL,
  invoice_date   TEXT    NOT NULL,               -- 'YYYY-MM-DD'
  supplier_id    INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  is_interstate  INTEGER NOT NULL DEFAULT 0,
  taxable_paise  INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  igst_paise     INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise    INTEGER NOT NULL DEFAULT 0,
  paid_paise     INTEGER NOT NULL DEFAULT 0,
  payment_mode   TEXT    NOT NULL DEFAULT 'CREDIT',
  notes          TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED','CANCELLED')),
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  UNIQUE (supplier_id, invoice_no)
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(invoice_date);

CREATE TABLE IF NOT EXISTS purchase_items (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id         INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id            INTEGER REFERENCES batches(id) ON DELETE SET NULL,
  batch_no            TEXT    NOT NULL,
  expiry              TEXT    NOT NULL,
  pack_size           INTEGER NOT NULL DEFAULT 1,
  qty_packs           INTEGER NOT NULL,          -- billed packs
  free_packs          INTEGER NOT NULL DEFAULT 0,-- scheme/free goods
  purchase_rate_paise INTEGER NOT NULL,          -- per pack, ex-GST
  mrp_paise           INTEGER NOT NULL,
  sale_rate_paise     INTEGER NOT NULL,
  discount_pct        REAL    NOT NULL DEFAULT 0,
  gst_rate            INTEGER NOT NULL DEFAULT 5,
  taxable_paise       INTEGER NOT NULL,
  cgst_paise          INTEGER NOT NULL DEFAULT 0,
  sgst_paise          INTEGER NOT NULL DEFAULT 0,
  igst_paise          INTEGER NOT NULL DEFAULT 0,
  total_paise         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ---------------------------------------------------------------------------
-- Sales (retail tax invoice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no       TEXT    NOT NULL UNIQUE,
  invoice_date     TEXT    NOT NULL,             -- ISO datetime, IST
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name    TEXT    NOT NULL DEFAULT 'Cash Customer',
  customer_phone   TEXT    NOT NULL DEFAULT '',
  customer_gstin   TEXT    NOT NULL DEFAULT '',
  doctor_id        INTEGER REFERENCES doctors(id) ON DELETE SET NULL,
  prescription_no  TEXT    NOT NULL DEFAULT '',
  patient_name     TEXT    NOT NULL DEFAULT '',
  patient_address  TEXT    NOT NULL DEFAULT '',
  place_of_supply  TEXT    NOT NULL DEFAULT '36',
  is_interstate    INTEGER NOT NULL DEFAULT 0,
  gross_paise      INTEGER NOT NULL DEFAULT 0,   -- sum of MRP-value before discount
  discount_paise   INTEGER NOT NULL DEFAULT 0,
  taxable_paise    INTEGER NOT NULL DEFAULT 0,
  cgst_paise       INTEGER NOT NULL DEFAULT 0,
  sgst_paise       INTEGER NOT NULL DEFAULT 0,
  igst_paise       INTEGER NOT NULL DEFAULT 0,
  round_off_paise  INTEGER NOT NULL DEFAULT 0,
  total_paise      INTEGER NOT NULL DEFAULT 0,
  paid_paise       INTEGER NOT NULL DEFAULT 0,
  payment_mode     TEXT    NOT NULL DEFAULT 'CASH'
                   CHECK (payment_mode IN ('CASH','UPI','CARD','CREDIT','SPLIT')),
  payment_ref      TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'COMPLETED'
                   CHECK (status IN ('COMPLETED','CANCELLED')),
  cancel_reason    TEXT    NOT NULL DEFAULT '',
  notes            TEXT    NOT NULL DEFAULT '',
  served_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pharmacist_name  TEXT    NOT NULL DEFAULT '',
  created_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sales_date     ON sales(invoice_date);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_status   ON sales(status);

CREATE TABLE IF NOT EXISTS sale_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id        INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id       INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  -- Snapshots: an invoice must reprint identically even if masters change later
  product_name   TEXT    NOT NULL,
  manufacturer   TEXT    NOT NULL DEFAULT '',
  hsn_code       TEXT    NOT NULL,
  schedule_type  TEXT    NOT NULL DEFAULT 'OTC',
  batch_no       TEXT    NOT NULL,
  expiry         TEXT    NOT NULL,
  pack_size      INTEGER NOT NULL DEFAULT 1,
  qty_units      INTEGER NOT NULL CHECK (qty_units > 0),
  mrp_paise      INTEGER NOT NULL,              -- per pack
  rate_paise     INTEGER NOT NULL,              -- per base unit, tax inclusive
  gross_paise    INTEGER NOT NULL,
  discount_pct   REAL    NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  taxable_paise  INTEGER NOT NULL,
  gst_rate       INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  igst_paise     INTEGER NOT NULL DEFAULT 0,
  total_paise    INTEGER NOT NULL,
  returned_units INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_batch   ON sale_items(batch_id);

-- ---------------------------------------------------------------------------
-- Sales return / credit note
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no       TEXT    NOT NULL UNIQUE,
  return_date     TEXT    NOT NULL,
  sale_id         INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  reason          TEXT    NOT NULL DEFAULT '',
  restock         INTEGER NOT NULL DEFAULT 1,   -- 0 when goods are unsaleable
  taxable_paise   INTEGER NOT NULL DEFAULT 0,
  cgst_paise      INTEGER NOT NULL DEFAULT 0,
  sgst_paise      INTEGER NOT NULL DEFAULT 0,
  igst_paise      INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_date ON sale_returns(return_date);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id      INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id   INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id       INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  product_name   TEXT    NOT NULL,
  batch_no       TEXT    NOT NULL,
  expiry         TEXT    NOT NULL,
  hsn_code       TEXT    NOT NULL DEFAULT '3004',
  qty_units      INTEGER NOT NULL CHECK (qty_units > 0),
  rate_paise     INTEGER NOT NULL,
  taxable_paise  INTEGER NOT NULL,
  gst_rate       INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  igst_paise     INTEGER NOT NULL DEFAULT 0,
  total_paise    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(return_id);

-- ---------------------------------------------------------------------------
-- Stock adjustments (breakage, expiry write-off, physical count correction)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id   INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty_delta  INTEGER NOT NULL,                  -- signed base units
  reason     TEXT    NOT NULL CHECK (reason IN ('DAMAGE','EXPIRED','COUNT_CORRECTION','THEFT','OTHER')),
  note       TEXT    NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL
);

-- ---------------------------------------------------------------------------
-- Immutable stock ledger — every movement of every batch, for audit
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id      INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  txn_type      TEXT    NOT NULL CHECK (txn_type IN
                  ('PURCHASE','SALE','SALE_RETURN','PURCHASE_RETURN','ADJUSTMENT','SALE_CANCEL')),
  ref_table     TEXT    NOT NULL DEFAULT '',
  ref_id        INTEGER,
  qty_in        INTEGER NOT NULL DEFAULT 0,
  qty_out       INTEGER NOT NULL DEFAULT 0,
  balance_after INTEGER NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_batch ON stock_ledger(batch_id);
CREATE INDEX IF NOT EXISTS idx_ledger_date  ON stock_ledger(created_at);

-- ---------------------------------------------------------------------------
-- Schedule H1 register — Drugs & Cosmetics Rules, Schedule H1 requires a
-- SEPARATE bound register recording, at the time of supply: prescriber name &
-- address, patient name & address, drug name & quantity, manufacturer, batch
-- no., expiry, and the signature of the registered pharmacist.
-- Records must be retained for THREE YEARS and produced for inspection.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS h1_register (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no          INTEGER NOT NULL UNIQUE,
  supply_date        TEXT    NOT NULL,
  sale_id            INTEGER NOT NULL REFERENCES sales(id) ON DELETE RESTRICT,
  sale_item_id       INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE RESTRICT,
  invoice_no         TEXT    NOT NULL,
  prescriber_name    TEXT    NOT NULL,
  prescriber_address TEXT    NOT NULL DEFAULT '',
  prescriber_reg_no  TEXT    NOT NULL DEFAULT '',
  patient_name       TEXT    NOT NULL,
  patient_address    TEXT    NOT NULL DEFAULT '',
  drug_name          TEXT    NOT NULL,
  quantity           TEXT    NOT NULL,          -- e.g. "10 TAB"
  manufacturer       TEXT    NOT NULL DEFAULT '',
  batch_no           TEXT    NOT NULL,
  expiry             TEXT    NOT NULL,
  pharmacist_name    TEXT    NOT NULL,
  pharmacist_reg_no  TEXT    NOT NULL DEFAULT '',
  created_at         TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_h1_date ON h1_register(supply_date);
CREATE INDEX IF NOT EXISTS idx_h1_sale ON h1_register(sale_id);

-- ---------------------------------------------------------------------------
-- Document number sequences (atomic, per prefix+period)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Audit trail for sensitive actions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT    NOT NULL DEFAULT '',
  action     TEXT    NOT NULL,
  entity     TEXT    NOT NULL DEFAULT '',
  entity_id  INTEGER,
  details    TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_log(created_at);

-- ---------------------------------------------------------------------------
-- Purchase returns (debit notes to the distributor)
--
-- Chemists routinely send near-expiry and damaged stock back to the supplier
-- for credit — most distributors accept returns 3-6 months before expiry.
-- Unlike a sales return this is goods going OUT of the shop, so stock reduces.
-- A claim stays PENDING until the distributor issues the credit note.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_returns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  return_no       TEXT    NOT NULL UNIQUE,
  return_date     TEXT    NOT NULL,
  supplier_id     INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  is_interstate   INTEGER NOT NULL DEFAULT 0,
  reason          TEXT    NOT NULL DEFAULT 'NEAR_EXPIRY'
                  CHECK (reason IN ('NEAR_EXPIRY','EXPIRED','DAMAGED','WRONG_SUPPLY','RECALL','OTHER')),
  notes           TEXT    NOT NULL DEFAULT '',
  taxable_paise   INTEGER NOT NULL DEFAULT 0,
  cgst_paise      INTEGER NOT NULL DEFAULT 0,
  sgst_paise      INTEGER NOT NULL DEFAULT 0,
  igst_paise      INTEGER NOT NULL DEFAULT 0,
  round_off_paise INTEGER NOT NULL DEFAULT 0,
  total_paise     INTEGER NOT NULL DEFAULT 0,
  -- Credit claimed from the distributor, settled when they issue a credit note
  status          TEXT    NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','CREDITED','REJECTED')),
  credit_note_no  TEXT    NOT NULL DEFAULT '',
  credited_paise  INTEGER NOT NULL DEFAULT 0,
  settled_at      TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_date     ON purchase_returns(return_date);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_status   ON purchase_returns(status);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id      INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  batch_id       INTEGER NOT NULL REFERENCES batches(id) ON DELETE RESTRICT,
  product_name   TEXT    NOT NULL,
  manufacturer   TEXT    NOT NULL DEFAULT '',
  hsn_code       TEXT    NOT NULL DEFAULT '3004',
  batch_no       TEXT    NOT NULL,
  expiry         TEXT    NOT NULL,
  pack_size      INTEGER NOT NULL DEFAULT 1,
  qty_units      INTEGER NOT NULL CHECK (qty_units > 0),
  -- Returned at the rate it was bought at, exclusive of GST
  rate_paise     INTEGER NOT NULL,
  mrp_paise      INTEGER NOT NULL DEFAULT 0,
  gst_rate       INTEGER NOT NULL DEFAULT 5,
  taxable_paise  INTEGER NOT NULL,
  cgst_paise     INTEGER NOT NULL DEFAULT 0,
  sgst_paise     INTEGER NOT NULL DEFAULT 0,
  igst_paise     INTEGER NOT NULL DEFAULT 0,
  total_paise    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(return_id);

-- ---------------------------------------------------------------------------
-- Supplier payments — a running account per distributor
--
-- What is owed is: purchases - payments - credit received on returns.
-- Distributors work on credit periods (see suppliers.credit_days), so the
-- outstanding statement ages each invoice against its own due date.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_no    TEXT    NOT NULL UNIQUE,
  payment_date  TEXT    NOT NULL,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- Optional: a payment may settle one invoice or be on account
  purchase_id   INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  mode          TEXT    NOT NULL DEFAULT 'CASH'
                CHECK (mode IN ('CASH','UPI','BANK','CHEQUE','ADJUSTMENT')),
  reference     TEXT    NOT NULL DEFAULT '',
  notes         TEXT    NOT NULL DEFAULT '',
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_date     ON supplier_payments(payment_date);
CREATE INDEX IF NOT EXISTS idx_supplier_payments_purchase ON supplier_payments(purchase_id);
