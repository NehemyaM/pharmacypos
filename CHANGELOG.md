# Changelog

What changed, and why it mattered to the shop. Newest first.

This project follows [semantic versioning](https://semver.org): the middle
number moves when the counter gains something it could not do before, the last
when something that was wrong is put right.

Nothing here has been used to bill a real customer yet. Before it is, see
**Notes before going live** in the README and work through
**Settings → Go-live checklist** in the software itself.

## Unreleased

### Added

- **Continuous integration on every push and pull request.** Typecheck, 123
  unit tests, a production build, seven browser suites against a running app,
  and the Electron shell driven under a virtual display. Until now these only
  ran when a release was tagged, which meant a change could sit on `main` for
  days before anything noticed it was broken.
- A pull request template that asks the questions this particular codebase
  needs answered — whether GST is still extracted rather than added, whether
  batch and expiry still reach every line, whether anything new leaves the
  shop's machine.
- This changelog.

## 1.0.0

The first version that a medical store could actually run.

### Reading paperwork instead of typing it

- **Read a distributor's invoice from a photograph or a PDF.** A PDF from the
  distributor's own software is read from its text layer: exact, and seven
  times faster than recognising the same page as an image. A photograph is read
  by eye, marked as such, and shown beside the extracted figures so a
  pharmacist can check it. Nothing reaches stock until each line is confirmed.
  A picture too poor to read is refused with advice on retaking it rather than
  yielding plausible nonsense. All of it runs on the shop's own machine.
- **Import the catalogue and opening stock from a spreadsheet.** Loose column
  matching, a row-by-row preview, and an all-or-nothing commit so a
  half-loaded catalogue can never happen.

### The counter

- Keyboard-driven billing with batch and expiry on every line, FEFO allocation,
  and refusal of expired stock.
- Hold a bill and resume it later, re-validating every line against stock as it
  stands at that moment.
- Customer credit with enforced limits, receipts and statements.
- **A prescriber can be named at the counter.** Previously the doctor was a
  dropdown of those already on file, so a prescription from anyone else could
  not be billed at all — which on the first day is every doctor.

### Statute

- GST **extracted** from the MRP rather than added on top, because a printed
  MRP is tax-inclusive under Legal Metrology. Getting this backwards
  overcharges every customer.
- CGST/SGST or IGST by place of supply; medicines restricted to the Nil/5/18%
  slabs that survived September 2025.
- The Schedule H1 register, with prescriber, patient and pharmacist recorded
  against each supply.
- Invoice numbering that restarts each financial year.
- **A GSTIN that fails its check digit now says which character is wrong**, and
  can be overruled by the owner holding the certificate. It also accepts the
  number spaced or in lower case instead of calling that invalid.
- **A go-live checklist** the software runs against itself: shop particulars,
  both drug licences, the pharmacist's registration, and any account still
  using a password this software shipped with.

### Stock and suppliers

- Batch-wise stock, purchase entry, purchase returns as debit notes, and a
  supplier ledger with ageing.
- Backups by SQLite's own `VACUUM INTO`, verified by reopening and
  integrity-checking each one — a plain file copy of a live database is not
  safe.
- CSV export on every report, escaped against spreadsheet formula injection.

### Running it

- **An installable desktop application.** Fullscreen kiosk, single instance,
  a supervised server that restarts if it dies, silent thermal printing and the
  cash-drawer kick. Ctrl+Shift+Q and an admin password is the only way out. The
  database lives outside the program folder, so an update cannot destroy it.
- `npm run demo` — one command from a fresh clone to a working shop.
- Deployment scripts for a small cloud VM, and Firebase Hosting config for a
  split front end.

### Fixed

- **A fresh install was unusable.** An empty database had no settings row and
  no user account, so nobody could sign in and the first bill would have thrown
  on the shop's state code. It now bootstraps itself and insists the installed
  password is changed before anything else is reachable.
- Two seeded GSTINs failed their own check digit.
- The SPA fallback returned `index.html` with a 200 for any missing asset,
  which masked a missing favicon and would have masked worse.
