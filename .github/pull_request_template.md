<!--
  This is a pharmacy's billing system. A defect here does not lose a page view;
  it overcharges a customer, sells an expired batch, or leaves a Schedule H1
  register that a drug inspector will not accept. The questions below are the
  ones worth answering before merging.
-->

## What this changes

<!-- What the shop can do now that it could not before, or what was wrong. -->

## Why

<!-- The problem this solves, in the shop's terms rather than the code's. -->

## How it was verified

<!--
  Which suites were run, and what was checked by hand. Say plainly if something
  was not tested — an untested corner named is far safer than one assumed.
-->

- [ ] `npm test` — unit tests
- [ ] `npm run typecheck`
- [ ] `npm run verify:all` — API and browser suites against a running app
- [ ] `npm run verify:desktop` — only when the Electron shell changed

## Money, stock and statute

<!-- Delete any line that this change cannot possibly affect. -->

- [ ] GST is still **extracted** from the MRP, never added on top
- [ ] Amounts stay integer paise; no floating point entered the money path
- [ ] Batch number and expiry still reach every invoice line
- [ ] FEFO still refuses expired stock
- [ ] Schedule H1 supplies still reach the register with prescriber and patient
- [ ] Nothing new leaves the shop's machine over the network

## Anything the shop should know

<!--
  A migration, a new dependency, a setting to fill in, a behaviour that will
  look different at the counter tomorrow morning.
-->
