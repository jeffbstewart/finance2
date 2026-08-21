# UI testing: lanes, shared infrastructure, and the per-page brief

**Status:** infrastructure accepted and built (Jeff, 2026-08-21).
This document is the working brief for per-page test-building agents.

## The two lanes

**Unit lane** — vitest + jsdom via `ng test` (`npm test -- --no-watch`
in CI). Pages run in a zoneless TestBed against **in-memory fake
backends**; no server, no network, milliseconds per spec.

**E2E lane** — Playwright (`npm run e2e`). Boots the real server on a
scratch database with `FINANCE2_TEST_SUPPORT=true`, logs in once
(shared `storageState`), and drives the seeded portfolio in Chromium.
Specs run serially against one server, and **every test reseeds**
in `beforeEach` — a full reset+seed measures ~46 ms mean (p95
54 ms) on a warm server, so there is no read-only vs mutation
test taxonomy to maintain and no cross-test state coupling to
debug (ruling, Jeff 2026-08-21). If a suite ever grows slow,
`test.beforeAll` seeding is a local optimization for that file,
not a framework concept.

Both lanes assert against the same canonical **sample portfolio**, so
entity names and figures agree everywhere.

## Shared pieces (build on these; do not reinvent)

| Piece | Where | What it does |
|---|---|---|
| `installFakeApi(routes)` | `src/testing/fake-api.ts` | Swaps the `api` singleton's clients for `createRouterTransport` fakes. Unimplemented RPCs reject loudly (surface as the error snackbar). Returns a restore fn — call it in `afterEach`. |
| Wire builders | `src/testing/wire.ts` | `money()`, `fraction()`, `quantity()`, `date()`, `civil()`, `decimal()` — coherent exact/display/sortKey triples. |
| Sample responses | `src/testing/sample-data.ts` | Canned lists mirroring the seeder's names. Extend it rather than inventing new entities. |
| Chart stubs | `src/testing/chart-stubs.ts` | Same-selector stand-ins for the ECharts facades. Assert the *data* handed to the facade; drive `sliceClick` via `emitSliceClick`. The sparkline is plain SVG — assert it directly. |
| `settle(fixture)` | `src/testing/settle.ts` | Zoneless change detection doesn't track the pages' bare `reload()` promises — call `settle` after render/actions instead of `whenStable`. |
| Server fixtures | `TestSupportService` (`proto/testsupport.proto`) | `ResetPortfolio` + `SeedSamplePortfolio`, registered only under `FINANCE2_TEST_SUPPORT=true`. Seeding runs through production repositories/services. |
| E2E session | `e2e/global-setup.ts` | One login, shared `storageState`; `SETUP_TOKEN` env makes first boot deterministic. |
| E2E helpers | `e2e/support/material.ts` | `seedPortfolio()`, `pickSelect` (by option **text** — several selects use bigint/object values), `fillField`, `setToggle`, `readTable` (header/rows/footer), `expectSnackbar`, `acceptConfirms` (five pages use native `window.confirm`). |
| Exemplars | `src/app/pages/brokers/brokers-page.spec.ts`, `e2e/specs/brokers.spec.ts` | Copy these shapes. |

## The canonical sample portfolio (`SampleSeeder.kt`)

All dates are **relative to the server clock**; `lastYear` below means
the previous calendar year.

- **Brokers**: Vanguard, EuroBank, and hidden "Old Broker".
- **Accounts**: Vanguard *Brokerage* (USD taxable, sweep $500),
  Vanguard *Roth IRA* (USD tax-deferred, sweep $55.25 with `plaid`
  provenance), EuroBank *EUR Brokerage* (EUR taxable, sweep €250),
  and hidden *Closed Account*.
- **Securities**: `VTI` (MARKET locus, ETF; 220 pinned daily bars
  180.00→201.90 so charts/indicators/sparklines have data and **no
  provider is ever contacted**; class US Stock), `BONDX` (MANUAL
  mutual fund, class Bond — the rebalance candidate), `GOLD` (MANUAL
  private investment, class Other, **stale classification** so the
  refresh chip shows), `EUFUND` (EUR, MANUAL, **MARK_TO_MARKET**,
  class Non US Stock), hidden `GHOST`.
- **Lots/sales** (Brokerage): VTI 30 sh @ $150+$5 (lastYear−1) and
  20 sh @ $180+$5 (lastYear); a **lastYear sale** — 10 sh @ $190,
  $9 costs, 6 LT + 4 ST — whose gains are exactly **LT $233.60 / ST
  $35.40** (the tax report's default range shows them); a this-year
  sale of 5 sh @ $200 from the LT lot; BONDX 100 sh @ $10.
- **EUFUND ledger**: 100 sh @ €90+€10 (cost floor **$9,911.00** at
  the 1.10 purchase rate); marks for lastYear−1 (€9,500 × 1.05) and
  lastYear (€10,000 × 1.08), chained.
- **Holdings** (Roth): VTI 12 sh (`manual`), GOLD 5 sh (`plaid`).
- **Target allocation**: Cash 10 / US Stock 40 / Non US Stock 20 /
  Bond 20 / Other 10.
- **Imports**: one archived, unprocessed snapshot
  (`vanguard-sample.pb`, ref-roth already linked to the Roth IRA).
- **FX**: MANUAL EUR→USD rows at the purchase date (1.10), both year
  ends (1.05, 1.08), and yesterday (1.16). CPI comes from the
  embedded snapshot at boot.

`SeedSamplePortfolio` returns stable id keys (`security.vti`,
`account.roth`, `lot.vti_lt`, …) — use them; never scrape ids.

## Dos and don'ts for per-page agents

- **Do** test each page's distinct states: empty, hidden-toggle,
  error snackbar (fake an RPC rejection), conditional sections
  (tax-deferred vs taxable, MTM tab, target-not-set prompt), and
  client-side validators (sum-to-100, per-lot caps, decimal shapes).
- **Do** pin dates with `vi.setSystemTime` in unit specs that touch
  the date-sensitive defaults (tax range, MTM year, duration filter).
- **Don't** assert canvas pixels or golden screenshots; assert facade
  inputs (unit) or table/text content (e2e).
- **Don't** sleep — use `settle()` (unit) and Playwright's
  auto-waiting `expect` (e2e).
- **Don't** depend on spec order or prior state; call
  `seedPortfolio()` in `test.beforeEach` — it costs ~46 ms.
- **Don't** widen `SampleSeeder` casually — pages share it; additive
  changes only, and update this document's inventory when you do.
