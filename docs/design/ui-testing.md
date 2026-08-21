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
  lastYear (€10,000 × 1.08), chained. The lastYear mark's figures:
  FMV **$10,800.00**, basis before **$9,975.00**, ordinary income
  **$825.00** (the PFIC row on the default tax report); the earlier
  mark: FMV $9,975.00 over the $9,911.00 floor, income $64.00.
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
- **Don't** mutate component fields directly in unit specs and expect
  a re-render — zoneless change detection never sees it. Drive the
  DOM (dispatch `input` events, click buttons) or call the component
  method the template calls, then `settle()`.
- **Do** locate buttons by role + name on datepicker pages — the
  first `<button>` in a datepicker form field is the calendar toggle,
  not the action button.
- **Don't** depend on spec order or prior state; call
  `seedPortfolio()` in `test.beforeEach` — it costs ~46 ms.
- **Don't** widen `SampleSeeder` casually — pages share it; additive
  changes only, and update this document's inventory when you do.

## Cloud worker dispatch (2026-08-21)

The per-page test work runs as independent cloud workers with zero
shared context. Everything a worker needs is in this repo: this
document, [ui-test-inventory.md](ui-test-inventory.md) (the per-page
facts), the exemplars, and `scripts/cloud-setup.sh`.

**Bootstrap:** run `bash scripts/cloud-setup.sh` first. It clones the
public toolkit siblings beside the repo (the Gradle composite cannot
configure without them), installs web deps, tries to install
Chromium, builds the server + SPA, and prints the lane commands.

**Cloud sandbox realities (learned from the first cloud worker,
PR #52):** the sandbox's egress proxy blocks the Chromium download,
so the full e2e lane is unavailable there — `npm run e2e:typecheck`
is the expected cloud rung and CI runs the real e2e lane on the PR.
The sandbox image's Node (22.22.2) is below Angular CLI's minimum
(22.22.3) and the box has no version manager, so `cloud-setup.sh`
fetches a pinned Node 24 tarball from nodejs.org (reachable through
the proxy) via `scripts/cloud-env.sh` — **every worker shell must
`source scripts/cloud-env.sh` before running any lane**, since PATH
does not persist across processes or worktrees. The script now
fails loudly and ends with `cloud-setup OK` on success. Sandbox
checkouts may hide `.github/`; CI nonetheless runs on GitHub for
every PR, including the real e2e lane. A session's configured default branch
name does not override rule 1 — use `agent/tests-<slug>`. Pure-function
assignments (`core-utils`) have no e2e spec by design.

**Rules — these prevent fifteen PRs from colliding:**

1. One assignment per worker. Branch `agent/tests-<slug>`, base
   `main`, one PR. Touch ONLY your assignment's new spec files.
2. **Never modify shared files**: anything under `src/testing/`,
   `e2e/support/`, `e2e/*.ts|mjs`, `SampleSeeder.kt`,
   `TestSupportService`, this document, or another page's code. If a
   shared helper or seed datum is missing, work around it locally in
   your spec and record the gap in your PR description under
   "Shared-infrastructure gaps" — the gaps get consolidated into one
   follow-up PR.
3. Found a real product bug? Do NOT fix it. Write the test to pin the
   CURRENT behavior with a `// BUG:` comment, and list it in the PR
   description under "Suspected bugs".
4. **Validation ladder** — state in the PR which rung you reached:
   - `npm test -- --no-watch` green (mandatory, always achievable).
   - `npm run e2e` green (requires the JVM boot + Chromium; do this
     if the sandbox supports it).
   - `npm run e2e:typecheck` green (the minimum bar for e2e specs
     when the full lane cannot run — CI runs the real thing on your
     PR either way).
5. Unit specs live beside their page (`<page>.spec.ts`); e2e specs in
   `e2e/specs/<slug>.spec.ts`. Seed via `seedPortfolio()` in
   `test.beforeEach` (~46 ms).

**Assignments** (slug — scope):

| Slug | Scope |
|---|---|
| `core-utils` | `core/decimals.ts` + `core/dates.ts` pure-function unit specs (no e2e) |
| `welcome` | Welcome page + auth guard redirect |
| `shell` | Shell nav, user menu, logout |
| `brokers` | BrokersPage + BrokerDialog (extend the exemplars) |
| `broker-accounts` | BrokerAccountsPage + AccountDialog |
| `securities-list` | SecuritiesPage + AddSecurityDialog |
| `security-details` | SecurityDetailsPage price-history tab + ProfileDialog |
| `classification` | ClassificationEditor (Asset Allocation tab) |
| `mtm` | MtmMarks + MtmMarkDialog |
| `private-prices` | PrivatePricesPage + PrivatePriceDialog |
| `positions` | PositionsPage + BuyDialog + HoldingDialog |
| `lot-details` | LotDetailsPage + SellDialog |
| `allocation` | AllocationPage + TargetDialog + ClassDetailsPage |
| `rebalance` | RebalancePage + RebalanceBuyDialog |
| `tax` | TaxPage |
| `imports` | ImportsPage |

**Dispatch prompt template** (one line per worker):

> Read docs/design/ui-testing.md (including "Cloud worker dispatch")
> and docs/design/ui-test-inventory.md, run scripts/cloud-setup.sh,
> then build the unit and e2e tests for assignment `<slug>` following
> the rules and exemplars. Branch `agent/tests-<slug>`, open a PR.
