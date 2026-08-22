# UI test inventory: per-page facts for test-building agents

Companion to [ui-testing.md](ui-testing.md) (the how); this is the
what - every page's data dependencies, states worth testing, and
widget quirks, surveyed 2026-08-21. Trust but verify: if a page has
changed since, the code wins.

## Core seams

- **`core/api.ts`**: module-level singleton; clients built at import
  time. Unit specs swap clients via `testing/fake-api.ts`
  (`installFakeApi`), never the transport.
- **`core/session.ts`**: signal store; `ensureLoaded()` caches for
  the app lifetime once resolved. **`core/auth.guard.ts`** guards the
  shell route (everything but `/welcome`); redirects to
  `/welcome?return=<url>`.
- **`core/notify.ts`**: success 2500 ms / info 4000 ms / error
  8000 ms with a "Dismiss" action; error text comes from
  `ConnectError.rawMessage`.
- **`core/decimals.ts` / `core/dates.ts`**: pure functions - a
  dedicated unit-spec assignment (shift/mul/div edge cases, civil
  date round-trips, `isDecimalString` rejects negatives/exponents).
- **`app.config.ts`**: `withComponentInputBinding()` (router params ->
  `input()`), zoneless, no animations provider, no global date
  adapter (each datepicker dialog provides its own).

## Pages

### Welcome - `/welcome` (unguarded)
- RPCs: `session.getSessionStatus`, `session.login`,
  `session.createFirstUser`. Reads `return` query param.
- States: setup mode (create-first-user card with setup-token field)
  vs sign-in mode; auto-navigates away when already signed in;
  `busy()` disables submit + shows progress bar; post-auth navigates
  to `return` else `/brokers`.
- Widgets: template-driven form, progress bar, snackbar.

### Shell (guarded parent)
- RPC: `session.logout`. Menu only when a user is set; logout ->
  `/welcome`. Six nav links with `routerLinkActive`.
- Widgets: toolbar, sidenav, nav list, mat-menu.

### BrokersPage - `/brokers`
- RPCs: `brokers.listBrokers({includeHidden})`,
  `brokers.setBrokerHidden(false)`; dialog -> `brokers.createBroker`.
- States: show-hidden toggle refetches; `(hidden)` tag + unhide icon
  on hidden rows only; pie hidden when no visible brokers; footer
  totals; slice click -> `/brokers/:id`; no empty-state text.
- Widgets: slide-toggle, table + footer, FAB, dialog; pie facade.

### BrokerAccountsPage - `/brokers/:id` (required input `id`)
- RPCs: `accounts.listAccounts({brokerId})`; when empty, also
  `brokers.listBrokers({includeHidden:true})` (title resolution);
  `brokers.setBrokerHidden(true)`; dialogs -> `accounts.createAccount`,
  `accounts.updateAccount`, `brokers.renameBroker`.
- States: empty -> "No accounts yet." + hide-empty-brokerage button;
  footer totals; pie/name click -> `/positions?account=`.
- **AccountDialog**: create shows Currency select (USD/EUR); edit
  shows Sweeps input instead. Tax Status select has **boolean**
  option values. sweepBalance is not client-validated.

### SecuritiesPage - `/securities`
- RPCs: `securities.listSecurities({includeHidden})`,
  `securities.setSecurityHidden(false)`; dialog ->
  `securities.addSecurity`.
- States: show-hidden; empty-state text; per-row SVG sparkline (no
  `<path>` under 2 points).
- **AddSecurityDialog**: upper-cases ticker; on success closes then
  navigates to the new details page.

### SecurityDetailsPage - `/securities/:id` (`tab` query param)
- RPCs: `securities.getSecurityDetails({inflationAdjusted})`; via
  children: `allocation.getAllocation`, `securities.setClassification`,
  `securities.listMtmMarks`, `securities.deleteMtmMark`,
  `securities.suggestMtmMark`, `securities.recordMtmMark`,
  `securities.updateMtmMark`, `securities.updateSecurityProfile`.
- States: card hidden until loaded; **Mark to Market tab only when
  `taxTreatment === MARK_TO_MARKET`**; tab index round-trips the
  `tab` query param; "Edit price history" link only for MANUAL locus;
  empty-history wording branches on locus; indicator select adds 1
  (SMA/EMA) or 3 (Bollinger) series; duration filter is client-side
  from `new Date()`; inflation toggle refetches.
- **ProfileDialog**: 4 selects (type/pricing/tax treatment) +
  expense-ratio decimal validation with mat-error.
- **ClassificationEditor** (Asset Allocation tab): edit mode fetches
  class names from `getAllocation`; sum-to-100 (+/-0.01), 0-100, <=2
  decimals validators with exact message strings; `refreshSuggested`
  chip; parent reload forces view mode; zero rows dropped from
  payload; **validation only recomputes on ngModelChange**.
- **MtmMarks / MtmMarkDialog**: delete icon on latest row only, edit
  on all; default year = last mark + 1 else `currentYear - 1`;
  suggestion failure is non-fatal (falls back to local Dec 31, error
  into notes); edit mode disables Tax Year with a hint and warns that
  later marks restate; `window.confirm` on delete.

### PrivatePricesPage - `/securities/:id/prices`
- RPCs: `listPrivatePrices` + `getSecurityDetails` in parallel;
  `deletePrivatePrice`; dialog -> `addPrivatePrice`/`updatePrivatePrice`.
- States: empty text; confirm on delete; back link; no client-side
  locus guard (server rejects MARKET).
- **PrivatePriceDialog**: datepicker + price; empty price shows no
  error but disables Submit.

### PositionsPage - `/positions` (optional `account` query param)
- RPCs: `positions.listPositions`; scoped adds `accounts.getAccount`;
  `accounts.setAccountHidden`, `accounts.deleteAccount`; dialogs ->
  `positions.getPurchaseFormInfo`, `positions.addPurchase`,
  `positions.setHolding`, `accounts.updateAccount`.
- States: title/subtitle flip on scope; **FAB branches**: HoldingDialog
  for tax-deferred, BuyDialog otherwise (dynamic aria-label);
  provenance chip; empty scoped -> hide/delete buttons (confirm), then
  nav to broker; footer totals; pie click carries `account` param.
- **BuyDialog**: account/security selects hidden in lot-edit mode;
  account list client-filtered to non-tax-deferred; **bigint option
  values**; commission required with 0 hint.
- **HoldingDialog**: security select unless preselected; quantity 0
  deletes.

### LotDetailsPage - `/positions/:id` (optional `account`)
- RPCs: `getLotDetails({inflationAdjusted})` + `getSecurityDetails`
  (+ scoped `getAccount`) in parallel; `deletePurchase`, `deleteSale`,
  `setSecurityHidden(true)`; dialogs -> buy/edit/sell RPCs.
- States: **column set changes with scope** (Account column when
  unscoped); inflation toggle refetches and adds `*` to five headers
  + footnote; checkbox only when still-held > 0; Sell disabled with
  no selection; multi-account selection -> `notify.info` and no
  dialog; selection cleared on reload; empty -> hide-security button
  (unscoped only); sale-history table only when sales exist; confirms
  on both deletes.
- **SellDialog**: 3-step linear stepper; step-2 per-lot caps and
  sum-to-total via scale-8 BigInt with exact message strings; step-3
  text uses `toLocaleDateString()` (locale-sensitive - don't golden).

### AllocationPage - `/allocation`
- RPCs: `allocation.getAllocation`; dialog ->
  `allocation.setTargetAllocation`.
- States: `targetSet === false` -> prompt block (charts still render);
  both pies filter zero slices; 4-chart grid; footer portfolio total;
  pie clicks -> `/allocation/class/:name`.
- **TargetDialog**: same sum-to-100 validator family, message
  "Percents must sum to 100 (currently X)".

### RebalancePage - `/allocation/rebalance`
- RPCs: `positions.getPurchaseFormInfo` (accounts **unfiltered** - 
  includes tax-deferred), `allocation.scoreRebalance` on account
  pick / funds blur / Enter / cart change.
- States: auto-select + auto-score when exactly one account; invalid
  funds string silently skips rescore (stale results); empty state
  until scored; cart table only when non-empty; per-class buy button
  disabled at/over target or without candidates; nothing persists.
- **RebalanceBuyDialog**: no RPCs - pure client math; candidate
  select with **object** option values; Shares <-> Net Cost mutually
  recompute via exact decimal mul/div; price readonly.

### ClassDetailsPage - `/allocation/class/:name`
- RPC: `allocation.getAllocation` (finds its class by name).
- States: contributors table + pie; empty text; ticker links.

### TaxPage - `/tax`
- RPC: `positions.getTaxReport({from,to})`, auto-run in constructor.
- States: defaults to **previous calendar year**; From <= To validator
  disables Submit with inline message; report block hidden until
  loaded; zero money renders blank (`blankZero`); PFIC MTM table only
  when `mtmRows` non-empty; notes as footnotes; footer totals.
- Widgets: two datepickers.

### ImportsPage - `/imports`
- RPCs: `imports.listSnapshots` + `accounts.listAccounts` in
  parallel; `imports.uploadSnapshot` (raw bytes from a **file
  input**), `imports.processSnapshot`, `imports.deleteSnapshot`,
  `imports.getSnapshotAccounts`, `imports.linkPlaidAccount`.
- States: empty-state text mentioning `bankferry investments export`;
  status chips Uploaded/Processed/Failed; selecting a snapshot loads
  its accounts panel; link select per Plaid account ("Not linked"
  uses a **bigint zero** sentinel); severity-tagged report lines with
  warning styling; `window.confirm` on delete; process/upload disable
  on `busy()`.
- Seeded fixture: one unprocessed snapshot, ref-roth pre-linked.

### Seeded states added 2026-08-21
- `SOLO`: a priced MANUAL security with no lots or holdings - reaches
  the lot-details empty state / hide-security path and the single-close
  sparkline branch without deleting anything.

## Cross-cutting date/time dependencies

| Where | Dependency |
|---|---|
| tax-page | previous-calendar-year default range, auto-run |
| mtm-marks / mtm-mark-dialog | default year `currentYear - 1`; Dec 31 fallback date |
| security-details | duration cutoffs from `new Date()` |
| classification editor | `asOf: todayCivil()` on save |
| dates.ts | local-midnight civil<->JS conversions (timezone-sensitive) |
| sell-dialog step 3 | `toLocaleDateString()` - locale-sensitive |
| notify | snackbar windows 2.5 s / 4 s / 8 s |

No `Date.now()`, `setTimeout`, or `setInterval` in `src/app`.
