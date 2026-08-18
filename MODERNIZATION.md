# MODERNIZATION.md — the finance2 plan

## Why a rewrite

The original repo ([jeffbstewart/finance](https://github.com/jeffbstewart/finance))
has rotted on the vine for years:

- Legacy GOPATH layout, no `go.mod`; the Go tree no longer compiles with a
  modern toolchain (third-party deps never vendored, several now archived or
  deprecated: `dgrijalva/jwt-go`, `gobuffalo/packr`, `golang/protobuf`).
- Angular 7-era UI with 238 open vulnerability alerts (26 critical) and 9
  open Dependabot PRs that cannot be merged meaningfully — piecemeal bumps
  already left `package.json` internally inconsistent.
- One of the two price sources (IEX Cloud) shut down in August 2024; the
  other (AlphaVantage) and the legacy fund-composition lookup are
  unvalidated.
- The domain model predates real-world requirements that now exist:
  multi-currency holdings and instruments with no public pricing.

Decision: leave that tree alone and rewrite from scratch here as **finance2**,
intended to eventually become a **public repository**.

## Collaboration model

Claude authors changes on **feature branches** and proposes **pull requests**
for human (Jeff's) review and approval. No direct commits to the default
branch after the initial bootstrap; no self-merging.

## Firm architectural requirements

These are settled, not decision points:

- **Proto-typed API boundary, end to end.** Experience on other three-tier
  apps built with Claude (notably MediaManager) shows that hallucination is
  common at a hand-written JSON REST boundary — field names, shapes, and
  endpoints drift between server and client and nothing catches it until
  runtime. Here, the wire contract is defined once in **Protocol Buffers**
  and both sides are **generated** from it: server stubs in the backend
  language, a typed TypeScript client for the UI. A hallucinated field or
  endpoint must be a **compile-time error** on both sides. No hand-written
  DTOs, no `any`-typed fetch calls.
- **Local database.** No network database server. The legacy app's
  dependency on a remote MySQL host (`mysql.stewart.net`) is part of why it
  rotted: MySQL is the wrong choice for this project because it is a
  separate server to install, patch, and keep running; it forces credential
  management (a chunk of what `secrets.json` existed for); backup means
  `mysqldump` discipline instead of copying a file; and it makes a public
  repo hostile to contributors, who would need to stand up a server to run
  tests. This is a single-user application whose entire dataset fits in
  megabytes — an embedded, in-process database (SQLite-family) gives
  zero-administration operation, single-file backup/restore, real
  transactions, and trivial test setup. The exact engine/access layer
  follows Decision 0, cribbing MediaManager's DB setup where it fits.
- **Secrets in `.env`** (never in code, never in git, never read by AI) —
  see goal 3 below.

## Reference repositories

All three reference projects are **public GitHub repos under
[github.com/jeffbstewart](https://github.com/jeffbstewart)**:

- **[MediaManager](https://github.com/jeffbstewart/MediaManager)** (Kotlin) —
  three-tier web app; crib its DB setup and Protocol Buffer / TypeScript
  client-side support.
- **[touchvault](https://github.com/jeffbstewart/touchvault)** (Go) — crib
  Plaid access patterns.
- **[bankferry](https://github.com/jeffbstewart/bankferry)** (Go) — crib
  Plaid access patterns.

Expect them checked out as siblings of this repo (`../MediaManager`, etc.)
when working locally; they are also clonable/readable at the URLs above.

## Decision 0 — implementation language: Kotlin vs Go

Before any code lands, evaluate **rewriting the backend in Kotlin** rather
than Go. Motivation: MediaManager — an existing three-tier web app of
Jeff's, developed with Claude — already has working, proven patterns for
exactly the two hardest parts of this rewrite: **database setup** and
**Protocol Buffer definitions with client-side (TypeScript) support**.
Cribbing a known-good skeleton beats reinventing it.

The evaluation (first task after bootstrap, run with both repos visible)
should compare, concretely:

| Criterion | Notes |
|---|---|
| Reuse from MediaManager | How much of its DB layer, proto toolchain, build wiring, and client codegen transfers directly (favors **Kotlin**) |
| Reuse of Plaid access code | **touchvault** and **bankferry** already implement Plaid (Link flow, token handling, API client) and both are **Go** (favors **Go**) |
| Proto/typed-client toolchain maturity | Kotlin: protobuf-kotlin, gRPC-Kotlin, or Connect; Go: connect-go + connect-es. Both must yield a typed TS client where drift is a compile error |
| Decimal math | Kotlin/JVM has `BigDecimal` natively — potentially eliminating the bespoke fixed-point type and most of its audit surface. Go needs a library (e.g. shopspring/decimal) or the ported bespoke type |
| Embedded DB story | Kotlin: SQLite via JDBC/SQLDelight/Exposed (whatever MediaManager uses), or H2; Go: modernc/mattn SQLite |
| Deployment | Go: single static binary. Kotlin: JVM + jar (or GraalVM native). How much does this matter for a self-hosted personal app? |
| Claude effectiveness | Which stack has Claude produced fewer wrong-API/hallucination bugs in, in Jeff's actual experience |
| Public-repo accessibility | Contributor toolchain burden for each |

Output: a short written assessment committed to this repo, with a
recommendation; Jeff decides. The assessment lives at
[decisions/0-implementation-language.md](decisions/0-implementation-language.md).

**Decided 2026-07-17: Kotlin**, with three corollaries recorded in the
assessment. Two were amended the same day by the Plaid pipeline design
([docs/design/plaid-investments-pipeline.md](docs/design/plaid-investments-pipeline.md)):
the JVM security-key guard is rescinded (bankferry stays the sole
Plaid credential holder and exports investment data as proto files that
finance2 imports), and the bankferry extraction shrinks to "request the
Investments product + a separate proto-export command." The third
corollary stands: extraction of the Kotlin application base (DB +
Flyway + Armeria + Protocol Buffers) from MediaManager into a reusable
foundation. **Every phase below is language-neutral until
Decision 0 lands**, and the Gradle-vs-go.mod, SQLDelight-vs-sqlc style
choices all flow from it.

## End-state goals

1. **Modern, maintained backend** in the Decision-0 language — proper module
   system (`go.mod` or Gradle), maintained dependencies, current protobuf
   toolchain, UI assets embedded or served by the app.
2. **Modern UI** — current framework versions, generated proto client,
   clean `npm audit`, CI-enforced.
3. **Secrets in `.env`** — per project standards:
   - `.env` is git-ignored **and** `.aiignore`'d; CLAUDE.md instructs Claude
     to never read it.
   - A committed `example.env` documents every variable and how to use it;
     that file is fair game for AI to read and write, and lives in git.
4. **Pricing sources validated or replaced** — IEX Cloud is gone; every
   source that ships must be tested against its live API.
5. **Multi-currency support** — the portfolio now spans currencies:
   - A **currency conversion (FX) source** for valuation and reporting.
   - **Manual pricing support** for instruments with no public data: a Euro
     investment and 401(k) holdings now in trust instruments.
6. **Audited core value types** — decimal money math and the currency type
   get a dedicated correctness audit (see Phase 2), not a mechanical port.
7. **Legacy close-out** — all security PRs on the old repo closed as
   superseded; old repo archived once finance2 reaches parity.
8. **Public-repo hygiene from the first commit** — suitable license, no
   secrets or personal data ever in history, no non-redistributable assets.

## Phases

### Phase 0 — Bootstrap

- This document (initial commit).
- **Decision 0** evaluation (see above) — first real task; reads the legacy
  finance tree plus the three public reference repos (MediaManager,
  touchvault, bankferry).
- License suitability assessment (Phase 1) — **before** a LICENSE file lands.
- `CLAUDE.md` with the collaboration model and the `.env` policy.
- `.gitignore`, `.aiignore`, `example.env` skeleton.
- CI (GitHub Actions) from the very first code PR: build, test, lint,
  proto codegen check (generated code in sync with `.proto` sources),
  `npm audit` once a UI exists. Nothing rots silently this time.

### Phase 1 — License & IP suitability assessment

Proposed license: **Apache-2.0**. Before adopting it, assess suitability
given what the project touches:

- **Inherited code**: `jlog` in the legacy repo is a fork of Google's glog
  (Apache-2.0) — compatible, but requires attribution/NOTICE if any of it is
  ported. Prefer the platform's standard logging instead of carrying it.
- **Cribbed code**: anything copied from MediaManager needs a license/
  ownership check appropriate to that repo's status before it lands in a
  public tree.
- **Assets**: the legacy Omega icon is under an Iconfinder Basic license —
  almost certainly **not** redistributable in a public repo. Exclude it;
  pick or draw a freely-licensed replacement.
- **Data-provider terms**: AlphaVantage (and any replacement: Tiingo,
  Finnhub, Polygon, ECB) have terms about redistribution of data and API
  usage. The *code* can be Apache-2.0 while the repo must never commit
  provider *data*; verify no provider's ToS restricts publishing an open
  client.
- **Fund-composition sources**: any fund-composition lookup source must
  be appropriately licensed for use, or the data manually entered;
  nothing ships without one of the two.
- Output: a short written assessment in-repo, then LICENSE (+ NOTICE if
  needed) lands by PR.

### Phase 2 — Core domain types, ported with audit

The heart of the legacy system gets a real correctness review, not a
copy-paste:

- **Decimal money math**: audit the legacy `number/fixed` fixed-point
  decimal — representation, precision/scale, rounding modes, overflow
  behavior, and **all math** (add/sub/mul/div, comparisons, conversions,
  pro-rata/allocation splitting). Then decide (informed by Decision 0)
  whether the type survives: on Kotlin/JVM, `BigDecimal` with an explicit
  `MathContext` policy likely replaces it outright and the audit's product
  becomes the **test suite** — property-based tests (round-trip,
  no-penny-lost allocation invariants) that any implementation must pass.
- **Currency**: audit the legacy type, then **extend for multi-currency**:
  currency as a first-class dimension of every amount, no implicit
  cross-currency arithmetic (compile-time or hard runtime error), explicit
  conversion only through an FX rate with a date.
- Strong-typed domain IDs, real duration types, and the other house
  conventions apply from the start.

### Phase 3 — Domain model & persistence

- Proto-first domain model where it crosses the wire; schema designed for
  today's requirements: multi-currency accounts and positions, manual price
  points with as-of dates and provenance (who/what entered them), FX rate
  storage, trust-instrument holdings.
- **Embedded local database** (firm requirement above); engine and access
  layer per Decision 0, cribbing MediaManager's DB setup where it fits.
- A migration/import path for the legacy MySQL data (Phase 7 executes it).

### Phase 4 — Pricing, FX & portfolio composition acquisition

- A pluggable **price source interface**; each implementation validated
  against the live API in an integration-test mode (keyed via `.env`).
- **Portfolio composition via aggregation — evaluate Plaid.** Composition
  tracking (which holdings, in which accounts, in what quantities) has
  historically been manual. Plaid's **Investments** product reports
  holdings, quantities, cost basis, and institution-reported valuations
  directly from linked brokerage/retirement accounts, which could replace
  most manual entry — and notably, institution-reported values may cover
  the 401(k) **trust instruments** that have no public pricing. The
  evaluation must establish:
  - **Coverage**: does Plaid actually connect to Jeff's specific
    institutions (brokerages and the 401(k) recordkeeper), and what data
    does each return? Investments coverage is much narrower than Plaid's
    banking coverage, and varies per institution.
  - **The Euro investment**: Plaid's European offering centers on
    banking/payments, not investments — the EU holding likely stays manual.
  - **Cost & access model**: a Plaid trial is already working in
    bankferry, so the access path is proven. **Decided 2026-07-17: a
    single shared Plaid account (bankferry's) — no separate trial for
    finance2** (finance2 never talks to Plaid under the proto-export
    design). Confirm the trial's limits cover the added Investments
    items (~3 of the ~10 lifetime slots planned) and what production
    graduation would cost.
  - **Cribbable code**: the **touchvault** and **bankferry** projects
    already implement Plaid access — reference them for Link flow, token
    exchange/storage, and API client patterns. Both are **Go** projects,
    which weighs on Decision 0 (see above).
  - **Security posture**: linking is via Plaid Link (OAuth where the
    institution supports it); client ID/secret live in `.env`; token
    storage in the local DB needs care since this repo goes public —
    keys and data stay local, only code is published.
  - **Alternatives** if Plaid falls short: SnapTrade (investment-focused
    aggregation), SimpleFIN, or a structured CSV/OFX import pipeline from
    each institution as the low-tech fallback.
  - Outcome shapes the manual-pricing scope below: aggregation-fed accounts
    need reconciliation views rather than data entry; manual entry remains
    for whatever aggregation can't reach.
- **AlphaVantage**: validate current API and free-tier limits (~25 req/day);
  keep only if it earns its place.
- **Replacement/additional equity+fund sources**: evaluate Tiingo, Finnhub,
  Polygon — decision point on provider(s) and free vs paid.
- **FX rates**: evaluate ECB reference rates (free, reliable, EUR-based —
  likely sufficient for EUR/USD) plus a provider fallback.
- **Manual pricing**: first-class UI + API flow for entering prices for the
  Euro investment and the 401(k) trust instruments — dated entries, edit
  history, and staleness surfaced in reporting ("price as of N days ago").

### Phase 5 — Backend services

- API server speaking the proto contract (gRPC-web or Connect protocol so
  the browser client stays generated and typed).
- Google OAuth sign-in with maintained libraries; sessions via maintained
  equivalents of the legacy gorilla stack.
- UI assets embedded/served by the app.
- Single process unless a real need for the separate price-server daemon
  emerges — leaning single binary/service with an internal scheduler.

### Phase 6 — UI rewrite

- Fresh workspace on a current framework — default assumption is current
  Angular (v20), but this is an explicit decision point before the phase
  starts (and may be informed by what MediaManager's client uses).
- All server calls through the **generated proto TypeScript client** — no
  hand-rolled fetch/DTO code.
- Ports the legacy screens: portfolio/accounts/brokers, securities,
  allocations and targets, charts — plus new screens for manual pricing and
  FX/multi-currency views.
- Modern test stack (no Karma/Protractor/TSLint); `npm audit` clean in CI.

### Phase 7 — Data migration & cutover

- Import legacy MySQL data into the new schema; reconcile: positions,
  cost basis, and valuations must match legacy output (where legacy was
  right) before cutover.
- Run side-by-side until trust is established.

### Phase 8 — Legacy close-out

- Close all 9 Dependabot PRs on jeffbstewart/finance as superseded.
- Archive the legacy repo; its 238 alerts die with it.

## Decision points (need Jeff's call, flagged as they arrive)

| # | Decision | Default / leaning |
|---|---|---|
| 0 | **Implementation language: Kotlin vs Go** | **Decided 2026-07-17: Kotlin** — see [decisions/0-implementation-language.md](decisions/0-implementation-language.md) |
| 1 | License | Apache-2.0, pending Phase 1 assessment |
| 2 | Decimal implementation (BigDecimal / library / ported bespoke type) | Decide after Phase 2 audit, downstream of Decision 0 |
| 3 | Embedded DB engine & access layer | SQLite-family; specifics follow Decision 0 / MediaManager patterns |
| 4 | Price provider(s), free vs paid | Evaluate in Phase 4 |
| 5 | FX rate source | ECB reference rates, leaning |
| 6 | UI framework | Angular (current) by default; confirm before Phase 6 |
| 7 | Proto transport (gRPC-web vs Connect) | Follows Decision 0 toolchain |
| 8 | Portfolio composition: Plaid vs manual/CSV | Mechanism decided 2026-07-17: bankferry fetches Investments and exports proto snapshots finance2 imports, single shared Plaid account — see [docs/design/plaid-investments-pipeline.md](docs/design/plaid-investments-pipeline.md); Plaid-vs-manual per institution awaits the coverage verification there |
| 9 | Initial build scope: lots by tax status, decimal scales, classification launch fields, account-currency model | **Decided 2026-08-18** — see [docs/design/initial-build-scope.md](docs/design/initial-build-scope.md); gold-IRA modeling proposal pending therein |

## Baseline facts (recorded 2026-07-17)

- Legacy repo: 238 vulnerability alerts (26 critical / 105 high / 81
  moderate / 26 low); 9 open Dependabot PRs, all against the UI.
- `secrets.json` was never committed to legacy git history — no key
  rotation forced by the migration.
- IEX Cloud API shut down August 2024.
- Legacy CLAUDE.md (repo map of the old tree) landed there via PR #22.
