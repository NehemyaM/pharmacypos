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

Three commands, from nothing to a working shop:

```bash
git clone https://github.com/NehemyaM/pharmacypos.git
cd pharmacypos
npm install
npm run demo        # builds, loads a demo shop, serves on :4000
```

Then open **http://localhost:4000**.

`npm run demo` is safe to re-run: the seed refuses to touch a database that
already has data in it, so it will not wipe a shop you have started using. Use
`npm run seed -- --force` when you deliberately want the demo data back.

Needs Node 20 or newer (`node --version`). On Windows use PowerShell or Git
Bash. If port 4000 is taken, `PORT=4100 npm run demo`.

To work on the code instead, `npm run dev` runs the API on :4000 and Vite with
hot reload on :5173.

Sign in with:

| Username     | Password    | Role       | Can do                                        |
|--------------|-------------|------------|-----------------------------------------------|
| `admin`      | `admin123`  | Admin      | Everything, including settings and audit log  |
| `pharmacist` | `pharma123` | Pharmacist | Billing, Schedule H1, purchases, returns      |
| `cashier`    | `cash123`   | Cashier    | OTC billing only                              |

On the shop counter, install the desktop build instead — see
[Desktop application](#desktop-application). It is the same software, wrapped so
it starts on boot, fills the screen and keeps its data where an update cannot
destroy it.

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

**Hold Bill.** F6 parks the basket under a name so the counter can serve the
next customer; F7 opens the tray. Held bills deliberately do **not** reserve
stock — a bill nobody resumes would otherwise lock medicine out of the shop
indefinitely — so resuming re-checks every line and tells you what changed if a
batch sold out or expired meanwhile.

**Customer dues.** Credit sales, receipts against them, per-customer statements
aged by invoice, and a credit limit that is *enforced* at billing time rather
than merely displayed: a credit sale that would take a customer past their limit
is refused, with the arithmetic in the message.

**Import.** Load the whole catalogue, and its opening stock, from a spreadsheet.
Column names are matched loosely, so a distributor's price list or an export from
the shop's previous software usually works untouched; expiries are accepted in
every spelling a distributor sends (`2028-06`, `06/2028`, `JUN-2028`, `06-28`,
`202806`) and refused rather than guessed at when unreadable. Preview first: the
file is checked row by row and **nothing is written unless all of it is valid**,
because a half-loaded catalogue cannot be reasoned about. Re-importing the same
file is safe — a batch already on the shelf is reported and left alone, so stock
can never be doubled by running it twice.

**Go-live checklist.** The software checks itself and says what is not ready:
missing GSTIN, either drug licence, the pharmacist's registration, no backup
taken — and any account still using a password this software shipped with,
detected by testing them. Nothing about an invalid invoice announces itself at
the counter, so it is stated plainly on the dashboard until it is fixed.

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

## Desktop application

The counter machine should not be running a browser. The same software packages
into an installable program that starts on boot, fills the screen, and cannot be
casually exited.

**Getting the Windows installer.** It has to be built on Windows, so CI does it:
push a tag and the `.exe` appears on the GitHub release.

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Download `PharmacyPOS-Setup-1.0.0.exe` from the release and run it on the shop
PC. Windows will show a SmartScreen warning because the installer is not
code-signed — **More info** → **Run anyway**. A signing certificate removes the
warning and costs roughly ₹15–25k a year; it is optional.

To build one locally instead, on the matching OS:

```bash
npm run rebuild:electron    # better-sqlite3 must match Electron's ABI, not Node's
npm run desktop:win         # or desktop:linux
```

That ABI step matters: the native module can only be compiled for one runtime at
a time. Run `npm run rebuild:node` before `npm test` again, or the server tests
will not load it.

**At the counter.**

- Fullscreen kiosk, single instance. Staff cannot alt-tab out or open a second
  copy.
- **Ctrl+Shift+Q** is the only way out, and it asks for an admin password, which
  is checked against the database rather than anything held in the page.
- Bills print silently to the configured printer instead of raising the OS print
  dialog, and the cash drawer opens on the ESC/POS kick.

**Where the data lives.** `%APPDATA%\PharmacyPOS` on Windows, never the program
folder. That separation is the whole point: an update replaces the installed
program, so a database inside it would be destroyed on every upgrade. Backups
and the machine's signing secret sit beside it.

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
npm test                    # 123 unit tests — GST, money, FEFO, CSV, expiry, invoice parsing
npm run verify:api          # 64 API checks against a running server
npm run verify:ui           # 39 browser checks driving the real UI
npm run verify:features     # 25 checks: backup, export, returns, supplier ledger
npm run verify:hold-dues    # 20 checks: hold/resume, credit limits, receipts
npm run verify:import       # 65 checks: catalogue import, go-live checklist
npm run verify:doctor       # 20 checks: naming a prescriber, choosing a file
npm run verify:scan         # 31 checks: reading an invoice from a photo or PDF
npm run verify:desktop      # 20 checks: the real Electron app under Xvfb
```

`npm run verify:all` runs everything that needs a running app, in one go. Start
it first with `npm run demo`, or point the suites elsewhere with `BASE=...`.

That is 407 checks. All of them pass on this commit, and CI runs every one
on every push and pull request.

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


---

## Working on it

`main` is what the shop would install. It is only reached through a pull
request, and CI has to be green first.

```bash
git checkout -b claude/short-description-of-the-change
# ... work, with a test for anything that could be wrong ...
npm test && npm run typecheck
npm run demo &                 # a running app for the browser suites
npm run verify:all
git push -u origin claude/short-description-of-the-change
```

Then open a pull request. `.github/pull_request_template.md` asks the questions
this codebase in particular needs answered — whether tax is still extracted from
the MRP rather than added to it, whether batch and expiry still reach every
line, whether anything new leaves the shop's machine.

**What CI runs** (`.github/workflows/ci.yml`), on every push and every pull
request:

| Job | What it proves |
|-----|----------------|
| Types, unit tests, build | The arithmetic is right and the thing compiles |
| Browser suites | Seven suites drive the real UI against a running app |
| Desktop application | The Electron shell starts and bills, under a virtual display |

A failing browser suite uploads its screenshots as an artifact, which is
usually the quickest way to see what went wrong.

**Releases.** Tag a version and `.github/workflows/desktop-release.yml` builds
the Windows installer on a Windows runner and attaches it to the GitHub release:

```bash
git tag v1.1.0 && git push origin v1.1.0
```

Record what changed in `CHANGELOG.md` in the same pull request as the change
itself, while the reason for it is still fresh.

## Layout

```
server/src/
  db/schema.sql       every table, with the reasoning in comments
  db/seed.ts          demo Hyderabad shop: 40 products, 31 days of trading
  lib/gst.ts          slab handling, inclusive/exclusive split, GSTIN validation
  lib/money.ts        paise arithmetic, Indian grouping, amount in words
  lib/billing.ts      line computation, FEFO allocation, schedule rules
  lib/csv.ts          CSV writing (formula-injection safe) and reading
  routes/sales.ts     the billing transaction — stock, ledger, H1, all atomic
  routes/import.ts    catalogue + opening stock import, preview then one commit
  routes/readiness.ts the go-live checklist the app runs against itself
  routes/*.ts         masters, purchases, returns, inventory, reports, settings
web/src/
  pages/Billing.tsx      keyboard-driven counter screen
  pages/InvoiceView.tsx  the printable GST invoice
  pages/Import.tsx       spreadsheet import with a row-by-row preview
  pages/*.tsx            dashboard, stock, products, purchases, reports, H1
  components/GoLiveChecklist.tsx  what is not ready to bill for real
desktop/main.js       the Electron shell: kiosk, supervised server, printing
e2e/*.mjs             browser and desktop verification
```

Stack: TypeScript throughout, Express + better-sqlite3 on the server, React +
Vite + Tailwind on the client. Chosen so the whole thing is one `npm install`
and one process on a shop counter PC.

---

## Still missing

Honest list, so nothing is a surprise:

- SQLite is single-machine by design. Right for a counter PC, wrong for
  multi-branch; that would mean migrating to Postgres.
- The invoice is laid out for A4/A5. An 80&nbsp;mm thermal template is still to
  come; the desktop build already prints silently and kicks the cash drawer.
- The importer loads products and opening stock. It does not read a distributor's
  invoice as goods inward — use Purchases for that, so input tax credit is
  recorded against the invoice.

## Notes before going live

Work through **Settings → Go-live checklist** in the app. It checks most of this
for you and will not report ready until every item is done.

- **Schedule the daily backup** and check it runs. See the backup section above.
- Change the three demo passwords, and delete any account you don't need. The
  checklist tests each account against the passwords this software shipped with
  and names the ones still using them.
- Put the real shop particulars into Settings: GSTIN, both drug licence
  numbers, FSSAI number if you sell supplements, and the registered
  pharmacist's name and registration number. They print on every invoice.
- Load the shop's catalogue and opening stock through **Import**. Take a backup
  first, so a wrong file is a five-second restore rather than an afternoon.
- Set `PHARMACY_JWT_SECRET` if you expose the server beyond the counter
  machine; otherwise a random secret is generated once and kept next to the
  database.
- Back up `data/pharmacy.sqlite` daily. A copy of that one file restores the
  whole shop.
- The GST reports are working papers for your accountant, not a filed return.
