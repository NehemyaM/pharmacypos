# PharmacyPOS

Billing and inventory management for a retail medical store in India.

Built for the way a chemist's shop actually works: fast keyboard billing at the
counter, batch-and-expiry tracking on every strip, GST that comes *out* of the
MRP rather than being added on top, and the statutory registers a drug
inspector will ask to see.

Runs entirely on one machine. SQLite on disk, no cloud account, no internet
needed to raise a bill.

---

## Quick start

```bash
npm install
npm run seed        # loads a demo Hyderabad medical store
npm run dev         # API on :4000, UI on :5173
```

Open http://localhost:5173 and sign in:

| Username     | Password    | Role       | Can do                                        |
|--------------|-------------|------------|-----------------------------------------------|
| `admin`      | `admin123`  | Admin      | Everything, including settings and audit log  |
| `pharmacist` | `pharma123` | Pharmacist | Billing, Schedule H1, purchases, returns      |
| `cashier`    | `cash123`   | Cashier    | OTC billing only                              |

For production, build once and run a single process:

```bash
npm run build
npm start           # serves API + UI together on :4000
```

The database lives at `data/pharmacy.sqlite`. Back that file up — it is the
entire shop. Override the location with `PHARMACY_DB=/path/to/db.sqlite`.

---

## What it does

**Billing.** Type two letters of a brand name, press Enter, press F9. The
earliest-expiring batch is selected automatically (FEFO), batch number and
expiry print on the line, and the total is computed live. Loose tablets are
priced pro-rata from the strip rate, so a full strip always bills exactly its
MRP.

**Inventory.** Stock is held per batch, never per product. Expiry pipeline by
month, reorder list sized by 30-day movement, non-moving stock report, stock
valuation at cost and at MRP, and an immutable ledger of every movement of
every batch.

**Purchases.** Enter the distributor's invoice; batches are created or topped
up, free goods enter stock at zero cost, and input tax credit is recorded.
Duplicate invoice numbers from the same supplier are rejected.

**Compliance.** Schedule H needs a prescriber. Schedule H1 and X additionally
need the patient's name and address, may only be dispensed by a pharmacist, and
write a row to the Schedule H1 register. Expired batches cannot be sold or
taken into stock, by any route.

**Reports.** Day book and till reconciliation, sales by day and by staff
member, HSN-wise GST summary with net liability after ITC, B2B invoice list,
product movement with margins, expiry pipeline, reorder list, audit log.

**Returns.** Credit notes against an invoice, refunding what was actually
charged. Cumulative returns can never exceed what was billed. Expired goods are
refunded but never restocked.

**Returns to distributor.** Send near-expiry or damaged stock back for credit.
Pick the batches, raise a debit note at cost, and track the claim until the
distributor issues their credit note — they often credit less than claimed, so
record what actually arrived.

**Supplier ledger.** What you owe each distributor, netting purchases against
payments and credit received on returns. Each invoice is aged against its own
due date (invoice date + that supplier's credit period), so overdue bills stand
out rather than hiding in a total.

**Backup.** A verified daily backup of the one file that is your entire shop,
downloadable off the machine, with a documented restore. See below.

**Export.** Every report downloads as CSV, with amounts as real numbers your
accountant can total.

---

## The India-specific decisions

These are the things a generic POS gets wrong.

**MRP is tax-inclusive, so GST is extracted, not added.** Under the Legal
Metrology Rules the printed MRP is the maximum a customer can be charged, all
taxes in. A chemist sells at MRP. Tax is therefore backed out of the line value
(`taxable = value × 100 / (100 + rate)`), never added on top. Adding it on top
would overcharge every customer on every bill. Purchase entry works the other
way round, because distributors quote rate exclusive of GST — the same
distinction governs how trade margin is computed.

**Medicines sit only in the Nil / 5% / 18% slabs.** The 12% slab was withdrawn
for pharmaceuticals with effect from 22 September 2025. Devices, diagnostics
and consumables still use 12% and 18%, so the slab is per-product and the
product form warns when a medicament HSN is given a withdrawn rate.

**Every amount is an integer number of paise.** No floating point rupees are
ever stored, summed or compared. Rounding residue on a CGST/SGST split is
assigned to SGST so that `taxable + cgst + sgst + igst` equals the line value
*exactly*, on every line, at every rate — this is asserted over thousands of
combinations in the test suite.

**CGST + SGST or IGST, decided by place of supply.** Intra-state (Telangana,
state code 36) splits the tax in half; inter-state puts the whole tax in IGST.
The shop's GSTIN must begin with its own state code, and settings refuse a
combination that contradicts itself, because getting this wrong misfiles every
return.

**Batch number and expiry on every line.** Mandated by both the Drugs &
Cosmetics Act and the GST invoice rules, which is why stock can never be
tracked at product level alone.

**Expiry is month-granular.** Drug expiry is printed as month and year; a batch
is saleable through the last day of its expiry month and not after.

**Schedule H1 register.** A separate register recording, at the time of supply:
prescriber name and address, patient name and address, drug and quantity,
manufacturer, batch number, expiry, and the dispensing pharmacist. Retained for
three years and produced on inspection. Entries are written automatically and
are never deleted — cancelling a bill annotates the register row rather than
removing it.

**Retail licences are Form 20 and Form 21** (general drugs, and Schedule C &
C1 drugs). 20B/21B are wholesale licences and do not belong on a retail
invoice. Both numbers print on every bill alongside the GSTIN.

**Invoice numbering restarts each financial year** (1 April – 31 March), as
`INV/2026-27/00001`. Numbers are allocated inside the billing transaction, so a
failed bill never burns one.

**Indian formatting throughout** — lakh/crore digit grouping, amount in words
in the Indian system, IST timestamps so "today's sales" doesn't shift at
05:30 every night.

---

## Backups — read this before going live

Your entire shop is one file: `data/pharmacy.sqlite`. Stock, every bill, and the
Schedule H1 register you must produce for three years. If that file dies and you
have no copy, the business is gone.

```bash
npm run backup                      # verified backup, prunes to the last 30
npm run backup -- --label pre-update
npm run backup:list
npm run backup -- --verify <file>   # accepts a path or just the filename
```

Copying the file with `cp` while the app is running is **not safe** — in WAL
mode the newest bills live partly in a side file, so a plain copy can miss them
or capture a torn page. `npm run backup` uses SQLite's own `VACUUM INTO`, which
writes a consistent copy with the shop still billing. Each backup is then
reopened and integrity-checked before it counts; the command exits non-zero if
verification fails, so a scheduler can alert you.

Admins can also take and download a backup from **Settings → Backup**. Do that:
a copy on the same machine as the original is not a backup.

**Schedule it daily.**

- *Windows*: Task Scheduler → daily → Program `npm`, Arguments `run backup`,
  Start in the project folder.
- *Linux/macOS*: `0 22 * * * cd /path/to/pharmacypos && npm run backup`

**To restore**: stop the app, rename the damaged `pharmacy.sqlite` (don't delete
it), copy a backup into its place under that name, delete any leftover `-wal`
and `-shm` files beside it, start the app, and check today's bill count on the
Dashboard. Anything billed after the backup was taken must be re-entered.

---

## Verification

```bash
npm test                          # 63 unit tests — GST, money, FEFO, CSV, schedule rules
npm run verify:api                # 64 end-to-end API checks against a running server
npm run verify:ui                 # 39 browser checks driving the real UI in Chromium
node e2e/verify-new-features.mjs  # 25 checks: backup, export, returns, ledger
```

The unit tests pin the arithmetic: that ₹105 at 5% is ₹100 + ₹2.50 + ₹2.50,
that a strip of 15 at ₹107 bills exactly ₹107, that GSTIN check digits
validate, that FEFO refuses expired stock even when quantity exists.

The API checks exercise the rules that matter: Schedule H without a prescriber
is refused; H1 without a patient address is refused; a cashier attempting H1
gets 403; selling an explicitly chosen expired batch is refused; over-returning
is refused; a duplicate distributor invoice is rejected; cancelling a bill puts
the stock back.

The browser checks drive the actual UI and screenshot each step into
`e2e/screenshots/`. `npm run verify:ui` needs a server running — start one with
`npm start` first. On a machine with a pre-installed Chromium, point at it with
`PLAYWRIGHT_CHROMIUM=/path/to/chromium`.

---

## Layout

```
server/src/
  db/schema.sql       every table, with the reasoning in comments
  db/seed.ts          demo Hyderabad shop: 40 products, 31 days of trading
  lib/gst.ts          slab handling, inclusive/exclusive split, GSTIN validation
  lib/money.ts        paise arithmetic, Indian grouping, amount in words
  lib/billing.ts      line computation, FEFO allocation, schedule rules
  routes/sales.ts     the billing transaction — stock, ledger, H1, all atomic
  routes/*.ts         masters, purchases, returns, inventory, reports, settings
web/src/
  pages/Billing.tsx      keyboard-driven counter screen
  pages/InvoiceView.tsx  the printable GST invoice
  pages/*.tsx            dashboard, stock, products, purchases, reports, H1
e2e/ui-verify.mjs     browser verification
```

Stack: TypeScript throughout, Express + better-sqlite3 on the server, React +
Vite + Tailwind on the client. Chosen so the whole thing is one `npm install`
and one process on a shop counter PC.

---

## Still missing

Honest list, so nothing is a surprise:

- **No bulk product import.** A real medical store carries thousands of SKUs and
  there is no CSV importer yet — masters must be entered by hand. This is the
  single biggest obstacle to going live.
- SQLite is single-machine by design. Right for a counter PC, wrong for
  multi-branch; that would mean migrating to Postgres.
- Printing goes through the browser's print dialog. The planned desktop build
  prints silently to the till printer.

## Notes before going live

- **Schedule the daily backup** and check it runs. See the backup section above.
- Change the three demo passwords, and delete any account you don't need.
- Put the real shop particulars into Settings: GSTIN, both drug licence
  numbers, FSSAI number if you sell supplements, and the registered
  pharmacist's name and registration number. They print on every invoice.
- Set `PHARMACY_JWT_SECRET` if you expose the server beyond the counter
  machine; otherwise a random secret is generated once and kept next to the
  database.
- Back up `data/pharmacy.sqlite` daily. A copy of that one file restores the
  whole shop.
- The GST reports are working papers for your accountant, not a filed return.
