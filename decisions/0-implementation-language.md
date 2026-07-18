# Decision 0 — Implementation language: Kotlin vs Go

**Status:** **Decided — Kotlin** (Jeff, 2026-07-17).
**Date:** 2026-07-17 (assessment and decision same day).
**Recommendation: Kotlin** — accepted, with three corollaries (see
[Decision](#decision-2026-07-17)).

Inputs: local working trees of the legacy
[finance](https://github.com/jeffbstewart/finance) repo and the three
reference repos —
[MediaManager](https://github.com/jeffbstewart/MediaManager),
[touchvault](https://github.com/jeffbstewart/touchvault),
[bankferry](https://github.com/jeffbstewart/bankferry) — surveyed
2026-07-17, plus Jeff's direction (same day) on Plaid enrollment
ownership (see criterion 2).

## Summary

The case for Kotlin is that the two hardest, riskiest subsystems of this
rewrite — the embedded database layer and the proto-typed API boundary
with a generated TypeScript client — exist today, complete and proven, in
MediaManager, and transfer nearly wholesale. The case for Go rested
mainly on cribbing Plaid code from touchvault/bankferry, and that case
did not survive inspection: touchvault contains no Plaid code at all,
bankferry uses only the Transactions product (finance2 needs
Investments), and Jeff's direction to keep Plaid enrollment in bankferry
removes most of the remaining reuse from the language question. Go keeps
real but modest advantages: single-binary deployment and a lighter
contributor toolchain.

## Criterion-by-criterion

### 1. Reuse from MediaManager (favors Kotlin — strongly, confirmed)

MediaManager is a mature Kotlin server (~59k LOC main, ~48k LOC test,
100 Flyway migrations, CI, OWASP dependency scanning) whose core stack
maps one-to-one onto finance2's firm requirements:

- **Database:** embedded **H2 2.4** in file mode, AES-encrypted at rest,
  HikariCP pool, **jdbi-orm** active-record entities, **Flyway** SQL
  migrations, and a clean test pattern (in-memory H2 running the same
  migrations, per-class schemas for parallel tests). The reusable
  bootstrap core is ~30 lines plus conventions; it has no dependency on
  the sibling toolkit repos.
- **Proto boundary:** `.proto` sources → Java messages + Kotlin coroutine
  gRPC stubs (`protoc-gen-grpc-kotlin`), served by **Armeria**, which
  speaks native gRPC *and* gRPC-Web on one port — no Envoy/proxy. The
  TypeScript client is generated with **`@bufbuild/protoc-gen-es` 2.x /
  Connect-ES** and consumed by an **Angular 22** SPA over
  `createGrpcWebTransport`. A hallucinated field or RPC is a
  compile-time error on both sides — exactly the firm requirement, and
  the toolchain versions are current (protobuf 4.34, grpc 1.80).
- **Build wiring:** Gradle 9.3 + version catalog, JVM 21 target, Jacoco,
  `npmAudit` task, Docker multi-stage build.
- **License:** MediaManager is MIT under Jeff's copyright, so cribbing
  into an Apache-2.0 public repo needs only routine attribution
  (Phase 1 confirms).

Two deltas to plan for rather than blockers: MediaManager has **no
Google OAuth** (auth is hand-rolled JWT + session cookie + WebAuthn
passkeys — Phase 5 either adopts that model or adds OAuth fresh), and
its codegen-sync guarantee is "generated output is gitignored + npm
pre-hooks regenerate," not a CI diff-check — finance2's CI requirement
should tighten that.

### 2. Reuse of Plaid access code (was assumed to favor Go — largely neutralized)

Findings that revise MODERNIZATION.md's assumption:

- **touchvault has no Plaid code.** It is a FIDO2/WebAuthn sealed-vault
  crypto library; bankferry uses it to seal the production Plaid API
  secret behind a security-key touch.
- **bankferry is the only Plaid implementation**, built on
  `plaid/plaid-go/v43`, **Transactions product only**. Its account
  adapter explicitly discards investment/brokerage accounts. There is
  **zero Investments code** — the product finance2 actually needs. The
  genuinely cribbable "call Plaid" core is ~1,100 LOC.
- **Plaid officially maintains a Java client**
  ([plaid-java](https://github.com/plaid/plaid-java), one of its five
  first-party SDKs, regenerated ~monthly). Kotlin is not locked out of
  anything.
- One bankferry lesson transfers as a *pattern*, not code, and applies
  in either language: the official SDKs decode money as floating point,
  so bankferry hand-rolls its data endpoints over raw JSON
  (`json.Number`). finance2 must do the same (Kotlin: raw JSON →
  `BigDecimal`) for any endpoint carrying money.

**Jeff's direction (2026-07-17):** keep touchvault and bankferry as the
Plaid *enrollment* managers — bankferry owns Link, token exchange, and
item lifecycle — and **share access tokens between projects via the OS
keyring** (bankferry stores them under service `"bankferry"`, one entry
per Item). Accepted tradeoff: this is ugly for outside contributors to
reproduce ("they can suck it up") — document it, don't block on it.
Under this split, finance2 needs only a read-side Plaid data client in
whichever language it's written; Link-flow reuse stops being a language
argument at all.

Consequences to resolve in Phase 4 / Decision 8 (they don't change the
language call, but they're real):

- **Access tokens are bound to the Plaid client account** (every API
  call sends `client_id` + `secret` + `access_token`). Sharing
  bankferry's tokens means sharing its Plaid account — which conflicts
  with MODERNIZATION.md's "coin a separate Plaid trial account for this
  project." Pick one: shared account (token sharing works) or separate
  trial (finance2 runs its own Link and the keyring-sharing idea is
  moot).
- **bankferry must request the Investments product at Link time** (or
  via update-mode re-link) for its tokens to serve holdings data; today
  it requests Transactions only. Small Go change, in bankferry.
- **finance2 needs the shared client credentials.** bankferry's
  production secret is sealed behind a hardware-key touch in touchvault;
  the sandbox secret is in the OS keyring. finance2 needs an agreed path
  to those (its own keyring read, or a coordinated convention).
- JVM keyring access is doable (e.g. `java-keyring`, or JNA to Windows
  Credential Manager) but less beaten-path than Go's
  `99designs/keyring`; a small compatibility shim reading bankferry's
  JSON-versioned entries is the concrete work item.

### 3. Proto / typed-client toolchain maturity (tie, with Kotlin proven in-house)

Both stacks meet the compile-time-drift requirement. Go's
connect-go + connect-es is arguably the industry's cleanest path, but it
would be assembled from scratch here. Kotlin's equivalent is *already
assembled and running* in MediaManager (Armeria gRPC-Web + Connect-ES —
note Armeria makes the usual "gRPC-Web needs a proxy" objection moot).
One external fact checked: **connect-kotlin is client-only** — a Kotlin
Connect *server* isn't an option, and doesn't need to be, because the
Armeria pattern covers the browser.

### 4. Decimal math (favors Kotlin)

The legacy `number/fixed` type (int64 mantissa, per-value decimal count,
560 LOC + 743 test LOC) has real gaps a port would inherit: **no
explicit rounding modes** (division truncates toward zero), **no
allocation/penny-splitting primitive** (pro-rata logic lives ad hoc in
`allocation`), documented overflow-check compromises in `Mul`, and the
`currency.Quantity` wrapper hard-codes 4 decimal places. On the JVM,
`BigDecimal` with an explicit `MathContext`/rounding policy replaces the
type outright, and Phase 2's audit product becomes the property-based
test suite any implementation must pass. Go would need
`shopspring/decimal` (fine, but one more third-party API surface) or a
port of the bespoke type including fixing the gaps above.

### 5. Embedded DB story (tie; Kotlin's harness is richer)

Both languages have a proven embedded engine in Jeff's own repos:
MediaManager's H2 (encrypted file mode, Flyway, in-memory test pattern)
and bankferry's `modernc.org/sqlite` (pure Go, no CGo, embedded SQL
migrations). H2 satisfies the "SQLite-family embedded, in-process"
requirement — MODERNIZATION.md explicitly lists it — and its
at-rest AES encryption is a genuine bonus for a financial dataset,
especially if any Plaid-derived data lands in the DB. The Kotlin side
brings the more complete proven harness (migration framework + test
setup + pooling + metrics).

### 6. Deployment (favors Go, modest weight)

Go produces a single static binary. The Kotlin path is JVM +
`installDist` in a Docker image — MediaManager's Docker → GHCR →
Watchtower pipeline is already how Jeff deploys. For a self-hosted,
single-user app with an existing container workflow, this is a
convenience difference, not a capability one.

### 7. Claude effectiveness (Jeff's call)

This criterion is explicitly Jeff's lived experience and is left open.
The observable evidence cuts both ways and mostly says "both work at
scale with a typed boundary": MediaManager is a large, actively
maintained Claude-developed Kotlin codebase; bankferry is a careful,
well-tested Claude-developed Go codebase. The proto-typed boundary —
present in both candidate stacks — is the actual hallucination defense.

### 8. Public-repo accessibility (slight Go edge)

A Go contributor needs one toolchain; a Kotlin contributor needs a JDK +
Gradle (wrapper-pinned, so effectively `./gradlew` + JDK) + npm for the
UI — and the UI/npm burden exists in both futures. Both are ordinary
open-source asks. The genuinely awkward contributor story is the
bankferry keyring coupling for Plaid features (accepted above); core
development — DB, domain, pricing, UI — remains fully reproducible with
an ordinary checkout in either language.

## Recommendation

**Kotlin.** The decision-weighting: criteria 1 and 3 are where rewrite
projects actually die (data layer and API boundary), and Kotlin inherits
both from MediaManager essentially intact. Criterion 4 deletes an entire
bespoke-correctness audit surface in Kotlin's favor. The expected Go
advantage (criterion 2) evaporated on inspection and shrank further
under the bankferry-owns-enrollment split. Go's surviving advantages
(6, 8) are real but are conveniences for a self-hosted personal app, not
capabilities.

If Go were chosen instead, the honest picture: connect-go/connect-es +
`modernc.org/sqlite` + `shopspring/decimal`, cribbing bankferry's
~1,100-LOC Plaid core and porting/refactoring the legacy `allocation`
engine in-language — a perfectly good stack, but every piece of the DB
layer and proto/TS pipeline gets built and debugged fresh instead of
lifted.

Language-neutral notes recorded for later phases: the legacy
`allocation` rebalancing engine (~786 LOC + tests) is the most valuable
business logic to port in either language; the legacy fund-composition
lookup is not ported — any fund-composition lookup source must be
appropriately licensed for use, or the data manually entered
(Phase 1/4); the legacy Google-OAuth `webcore/sso` stack is
local sign-in only and will be replaced per Phase 5.

## Decision (2026-07-17)

Jeff decided: **Kotlin.** One additional factor weighed beyond the
assessment above: many of the portfolio calculations this app needs read
naturally as pure functional collection pipelines —
`holdings.map { ... }.filter { ... }.groupBy { ... }.sumOf { ... }` —
a style Kotlin's stdlib excels at and Go, lacking generic collection
combinators as idiom, is poor at. The allocation/rebalancing engine and
the tax-lot reporting are exactly this shape.

The decision carries three **corollaries** — committed work items, not
options:

1. **A JVM implementation of security-key-guarded Plaid credential
   handling.** The threat model is specific: a hallucinating agent with
   access to the Plaid credential could burn through the
   lifetime-available **10 Plaid trial slots** by creating Items. The
   credential must therefore be unusable without a human security-key
   touch, as touchvault provides for bankferry today (FIDO2 seal +
   refuse-under-agent markers).
   > **Amended (rescinded) 2026-07-17:** under the proto-export
   > architecture
   > ([docs/design/plaid-investments-pipeline.md](../docs/design/plaid-investments-pipeline.md)),
   > bankferry remains the only holder of Plaid credentials and finance2
   > never touches them, so no JVM guard is needed. The threat model
   > stands; the existing Go/touchvault guard covers it.
2. **Extract bankferry's Plaid account-linking into something
   reusable.** The Link flow, token exchange, guarded local Link/OAuth
   server, and keyring item storage come out of bankferry into a
   reusable component that both bankferry and finance2 enrollment use —
   including the Investments-product extension finance2 needs.
   > **Amended (reduced) 2026-07-17:** no large bankferry refactoring.
   > The scope shrinks to two additions inside bankferry: request the
   > Investments product at enrollment, and a separate command that
   > exports an investments snapshot as proto (contract's primary
   > source lives in bankferry; finance2 duplicates the `.proto`). See
   > the design doc above.
3. **Extract the Kotlin application base into something reusable.** The
   DB stack (H2 + HikariCP + jdbi-orm + Flyway), the Armeria server
   wiring (gRPC + gRPC-Web + SPA on one port), and the Protocol
   Buffer / Connect-ES codegen pipeline come out of MediaManager into a
   reusable foundation rather than being copy-cribbed. (The existing
   `h2-kotlin-toolkit` / `auth-kotlin-toolkit` sibling repos are
   candidate homes; MediaManager depends on neither today.)

## Immediate follow-ups

1. Execute corollary 3: extract the reusable Kotlin application base
   from MediaManager (Gradle version catalog + protobuf block, Armeria
   server wiring, H2/Hikari/jdbi-orm/Flyway bootstrap + test base, the
   `gen-proto.mjs` Connect-ES pipeline), with MIT attribution per
   Phase 1.
2. Add the CI codegen-sync check MODERNIZATION.md requires (stricter
   than MediaManager's npm-hook approach).
3. ~~Design corollaries 1 and 2 before Phase 4 touches Plaid~~ —
   done 2026-07-17: the design
   ([docs/design/plaid-investments-pipeline.md](../docs/design/plaid-investments-pipeline.md))
   rescinded corollary 1, reduced corollary 2 (see amendments above),
   and settled on a single shared Plaid account (bankferry's; no
   separate trial for finance2).
4. Decide Phase 5 auth: adopt MediaManager's session/passkey model vs
   Google OAuth.
