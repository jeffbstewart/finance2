# Design: initial build scope

**Status:** **Accepted in full** (Jeff, 2026-08-18) - all rulings
recorded inline; the gold-coin IRA model (sec. 6) was approved as proposed
the same day.
**Date:** 2026-08-18.
**Relates to:** [docs/FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md)
(committed alongside this doc),
[docs/design/plaid-investments-pipeline.md](plaid-investments-pipeline.md),
MODERNIZATION.md Phases 2-6.

## What this scopes

FUNCTIONAL_SPEC.md describes the legacy application in full, as
extracted from the `../finance` code read. This document crosses that
spec with the Plaid investments pipeline design and records what the
initial build actually includes, where it deliberately diverges from
the spec, and which seams stay open for later. **Where this document
and the functional spec conflict, this document wins.** The spec
remains the reference for everything not overridden here.

The two documents fit together as: the spec is the application (entity
graph, computations, UI); the Plaid pipeline is one data feed into it.
The seam is an importer with provenance, feeding reconciliation views - 
which forces the schema decisions in sec. 1.

## 1. Composition feeds and lot tracking (ruling)

Plaid snapshots are position-level; the spec's tax machinery is
lot-level. The roles split by account tax status:

- **Taxable accounts:** manually entered purchase lots remain
  authoritative - they are the tax record. Plaid snapshots feed
  **reconciliation views** (imported quantity/value vs. the lot
  ledger), never silent mutation of lots.
- **Tax-deferred accounts:** **no lots, no cost basis.** Holdings are
  position-level (security, quantity), updated by snapshot import or by
  hand. They stay excluded from the tax report, as in the spec.
- The one IRA that actually has a basis: **punted** - tracked like any
  other tax-deferred account; revisit if it ever matters.
- **Sweep balances** are updatable both by hand (the edit-account form)
  and by import (`is_cash_equivalent` holdings), with provenance.

Schema consequences for Phase 3:

- Holdings are modeled position-level, with lots as taxable-account
  detail beneath them (rather than lots being the only source of
  positions, as in the legacy schema).
- Snapshot **staging tables** retain bankferry's verbatim decimal
  strings plus provenance (`source`, `as_of`, `imported_at`) - the
  canonical model is derived from staging, never the only copy.
- Linkage tables: account <-> Plaid `account_ref`, security <->
  `plaid_security_id`.

## 2. Numeric representation (ruling)

- **Money and fractions: scale 4. Quantities: scale 8** (absorbs
  fractional shares and bullion ounces from providers without
  rounding). The spec's +/-0.0001 tolerances (lot-closed test, target
  allocation sum) stand.
- Storage is exact end to end: H2 `NUMERIC` columns declared with
  headroom (e.g. `NUMERIC(20,4)` / `NUMERIC(20,8)`), `BigDecimal` on
  the JVM with explicit scale/rounding policy, string-encoded decimals
  on the wire. **No binary floating point anywhere on the storage or
  wire path.**
- Import rounding rule: a provider value entering the canonical model
  rounds `HALF_EVEN` to the canonical scale; the staging row keeps the
  provider's exact string, so nothing is ever lossy.

## 3. Accepted spec recommendations (ruling)

- **Sign-in allowlist: yes** - a configured list of permitted emails;
  everyone else rejected at login. Resolves the spec sec. 3.2 open
  decision. *(Superseded by sec. 8: local authentication removes federated
  sign-up entirely, which is a stronger guarantee than an allowlist.)*
- **Broker logos: dropped**; broker names only. Resolves spec sec. 7.
- **Single process:** the price service becomes a module inside the one
  Armeria server, keeping its required properties (persistent
  multi-hour cache, rate limiting, request coalescing, typed
  quota-exceeded detection) - no separate daemon.
- **Sell-side rebalance planner: not built now, not foreclosed.** The
  planner's trade shape carries a side (`BUY` today; `SELL` reserved),
  and neither the proto contract nor the planner math may bake in
  buy-only assumptions. (Spec sec. 5.5 / sec. 9.14.)

## 4. Security classification: launch scope (ruling)

Launch fields on a security: **ticker, description, pricing locus,
net expense ratio, asset-class mix.**

- **Pricing locus** is the public/private distinction, modeled
  extensibly (a value with room for later nuance such as which
  exchange/venue prices the ticker) rather than a bare boolean.
- **Asset-class mix is date-stamped** (`as_of`). The UI surfaces the
  age of the mix and prompts for a refresh once it is older than a
  configurable threshold.
- **Sector, market-cap, region, and credit-quality weights are dropped
  from the launch scope** - enjoyed in legacy, but not worth the manual
  data entry. Storage stays generic - `(security, classification kind,
  key, weight, as_of)` - so reviving a taxonomy later is seed data plus
  UI, not schema surgery. Spec sec. 9.10 tabs 3-6 are deferred; the
  asset-allocation tab stays.
- The country->region seed table (and its typo fixes) is deferred along
  with region weights.
- **Asset classes are seed data, not a closed enum**, in both schema
  and proto - the launch seed is the spec's five (Cash, US Stock,
  Non US Stock, Bond, Other), and adding a class later (see sec. 6) is
  additive.

## 5. Account currency (ruling)

The portfolio now spans **USD- and EUR-denominated accounts**.

- **Currency is a property of the account.** Every security held in an
  account, and the account's sweep balance, is denominated in the
  account's currency.
- A security therefore carries a denomination currency; holding a
  security in an account of a different currency is rejected at write
  time.
- Aggregation across currencies (broker totals, grand totals, the
  allocation dashboard, the rebalancer) converts to the **reporting
  currency, USD**, through dated FX rates (ECB reference rates, per the
  MODERNIZATION Phase 4 leaning). No implicit cross-currency
  arithmetic - conversion is explicit and dated, per house rules.
- **Open question (flagged, not designed):** the tax report's treatment
  of sales in EUR-denominated taxable accounts - IRS translation rules
  value purchase and sale legs at their respective transaction-date
  rates. Leaning: translate per-leg via dated FX; needs Jeff's tax
  judgment before that machinery is built. Until then the tax report
  covers USD accounts and visibly notes any exclusion.

## 6. The gold-coin IRA (ruling - approved as proposed, Jeff 2026-08-18)

One IRA holds physical gold coins in a vault. It is modeled with
existing machinery, nothing bespoke - 

- **Broker** = the custodian; **Account** = the IRA, tax-deferred, USD.
- Each coin type is a **privately-priced security**, quantity in **troy
  ounces** at scale 8 (recommended over coin count so a future spot
  price source can price it directly; a 1-oz coin type makes the two
  equivalent anyway).
- **Valuation** via dated manual price entries - custodian statement
  values or spotxpremium, same private-price path the 401(k) trust
  instruments use; staleness surfaces in reporting like any manually
  priced instrument.
- **Asset-class mix: 100% Other at launch.** If gold deserves
  first-class allocation targeting later, a **Commodities** asset class
  is a seed-data addition plus a target-allocation row (enabled by sec. 4's
  classes-are-data rule).
- No lots, no basis, per sec. 1 (tax-deferred).

## 7. Build order

1. **Phase 2 - core value types:** `Money`, `Currency`, `Quantity`,
   `Fraction` (+ pro-rata allocation), `BigDecimal`-backed with the sec. 2
   scale/rounding policy; accounting-style parse/format; the
   property-based suite (wire round-trip, no-penny-lost allocation,
   cross-currency arithmetic rejected) that any implementation must
   pass.
2. **Phase 3 - schema + contract:** Flyway migrations for the spec's
   entity graph with sec. 1's staging/provenance/linkage additions and sec. 4's
   generic classification storage; seed data; the proto API surface.
3. **Phases 4/5 - server:** business rules as pure, DB-free testable
   code (lots/FIFO/gains, allocation, drift, rebalancer, CPI,
   indicators); the price-source module; the snapshot importer; auth
   via the toolkit with the allowlist.
4. **Phase 6 - UI**, against the generated client.

The Plaid track's gating step (sandbox institution-directory query in
bankferry, then the Vanguard production link) proceeds independently.

## 8. Authentication: auth-kotlin-toolkit, not Google OAuth (ruling, Jeff 2026-08-18)

The spec's federated Google sign-in (sec. 3.1) is **dropped**. finance2
authenticates locally via
[auth-kotlin-toolkit](https://github.com/jeffbstewart/auth-kotlin-toolkit):
bcrypt credentials, SHA-256-hashed revocable cookie sessions,
rate-limited login with lockout, and optional WebAuthn passkeys. The
Armeria auth interceptor already in place gates every RPC not on the
unauthenticated allowlist.

Consequences:

- **Identity is a local username**, not a verified Google email. The
  `users` table implements the toolkit's `AuthUser` contract
  (`username` unique case-insensitively, `password_hash`, `locked`,
  `must_change_password`); the email column disappears.
- **The sec. 3 sign-in allowlist is moot** - with no federated sign-up,
  nobody can self-provision. Accounts are created deliberately
  (first-run bootstrap; the toolkit's `hasUsers()` supports a setup
  flow). This supersedes that ruling with a stronger guarantee.
- **First-run flow and single-user ruling (Jeff, 2026-08-18):** when
  the app comes online with an empty user table, the UI offers a
  "create the first account" setup flow; that account is **the** user
  account. Once any user exists, account creation is closed - there is
  no registration and no user management for now. A future "manage
  users" mechanism (some users empowered to administer others) stays
  open as additive work: a role/admin column and a user-admin service
  are new-migration/new-service additions, so nothing is built for it
  today and nothing forecloses it.
- **Logout genuinely invalidates** (server-side session revocation) and
  no third-party signing keys exist to rotate - legacy defect 1 dies by
  construction, and the server authenticates offline.
- **Session RPCs** become `Login(username, password)` / `Logout` /
  `WhoAmI`; no OAuth client config in `.env`. The toolkit's JWT service
  goes unused for now (the SPA rides cookie sessions); its tables exist
  but stay empty.
- **Auth DDL is duplicated into finance2's own migration chain**
  (consumer-versioned, the MediaManager precedent) rather than added as
  a second Flyway location: the toolkit's `db/auth` files use versions
  V001-V002, which would collide with finance2's own chain in a merged
  location scan. The toolkit's files are the source of truth; finance2's
  copy notes provenance, mirroring the Plaid proto duplication
  convention.

## 9. Migration discipline (ruling, Jeff 2026-08-18)

Schema definition and value population are **separate migration
steps**: a DDL migration never INSERTs, and reference/seed data (asset
classes today; a future Commodities class) arrives in its own
versioned migration. Structure diffs and data diffs review
independently.

## 10. Deployment topology: behind HAProxy (design note, Jeff 2026-08-18)

The server runs behind an **HAProxy** instance that owns TLS (SSL
transcoding) and forwards standard origin-IP headers so the app can
know the calling client's address.

Consequences for Phase 5 wiring:

- The Armeria server listens in **cleartext** (h2c/HTTP1) on an
  address only the proxy reaches; it never terminates TLS itself.
- **Client IP comes from the forwarded headers** (`X-Forwarded-For`),
  trusted only from the proxy's address (Armeria's client-address
  source configuration). The auth toolkit's per-IP login rate limiting
  and lockout must be fed this derived address, not the socket peer - 
  otherwise every attempt appears to come from HAProxy and one
  attacker's failures lock everyone out.
- **Session cookies stay `Secure` + `HttpOnly` + `SameSite`**: the
  browser-facing origin is HTTPS even though the backend hop is
  cleartext, so the server sets cookie flags for the proxied origin
  (honoring `X-Forwarded-Proto`), not its own listener.
- Proxy trust is **configuration** (`.env`): the trusted proxy
  address(es), documented in `example.env` when Phase 5 lands.
- **Amended (ruling, Jeff 2026-08-19):** health and metrics move to a
  **separate internal port** (`INTERNAL_PORT`), LAN-direct with no
  proxy and no auth. Exactly `/healthz` and `/metrics` answer there,
  plus `/` redirecting to `/metrics`; everything else on that port is
  404, and the ops endpoints do not exist on the main port. With
  trusted proxies configured, the main port accepts requests only from
  them, and a proxied request missing the forwarded client address
  fails as a bad request.

## 11. Mark-to-market international investments (ruling, Jeff 2026-08-20)

Non-USD securities subject to an annual **PFIC sec. 1296 mark-to-market
election** get first-class support. Rulings:

- **sec. 1296 semantics confirmed.** Each tax year the position is marked
  to fair market value; the year's change is **ordinary income** (not
  capital gain), and the basis resets to the marked FMV. The USD
  filing inherently captures FX movement: FMV = shares x year-end
  price x year-end FX rate, compared against a USD basis carried from
  the prior mark.
- **Election is per security** (`tax_treatment`: `LOTS` default,
  `MARK_TO_MARKET` elected). Purchases still record lots for share
  counts and audit; the lot ST/LT machinery is bypassed for MTM
  securities.
- **Loss limitation = FMV floored at acquisition cost.** For a single
  position acquired once and never partially sold this is exactly the
  sec. 1296 unreversed-inclusions rule: allowed loss in any year is
  basis - max(FMV, total acquisition cost). Marks can carry negative
  ordinary income down to that floor, never below.
- **FX convention:** the suggested mark uses ECB's last published
  rate on or before Dec 31 of the tax year. The ECB feed only
  backfills 90 days, so a past year's rate may be absent - the
  suggestion says so and the rate is enterable by hand; the recorded
  mark stores the rate actually used.
- **Sales are punted.** Sale-year treatment under the election is not
  yet ruled (the position is committed for years). Until ruled, the
  server rejects recording sales of MTM securities and rejects
  reverting a security to `LOTS` while marks exist.
- **Tax report:** MTM marks appear as a separate **"PFIC
  mark-to-market ordinary income"** section with its own total,
  distinct from the ST/LT capital-gain columns. This supersedes the
  sec. 5 "non-USD sales excluded" note for elected securities.
- Position views keep showing acquisition cost as Basis ("what I
  paid"); the marked (tax) basis lives on the security's
  mark-to-market ledger and the tax report.
