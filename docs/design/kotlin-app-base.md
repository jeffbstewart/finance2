# Design: the reusable Kotlin application base (Decision 0, corollary 3)

**Status:** **Accepted** (Jeff, 2026-07-17) — every recommendation in
the open-questions section adopted as written: name
`armeria-kotlin-toolkit`, codegen as documented template, auth bridge
as an optional module, public repo, toolkit changes by PR under the
same collaboration model.
**Date:** 2026-07-17.
**Relates to:** Decision 0 corollary 3
([decisions/0-implementation-language.md](../../decisions/0-implementation-language.md)),
MODERNIZATION.md Phase 0 (bootstrap) and Phase 5 (backend services).

## Context: two of the three pieces already exist

Corollary 3 called for extracting MediaManager's application base
(DB + Flyway + Armeria + Protocol Buffers) into a reusable foundation.
Survey result (2026-07-17): the extraction is further along than the
corollary assumed —

- **[h2-kotlin-toolkit](https://github.com/jeffbstewart/h2-kotlin-toolkit)**
  (MIT) already packages the DB layer: H2 file mode with AES encryption
  at rest, unencrypted→encrypted migration, password rotation, Flyway
  DDL migrations plus the SchemaUpdater framework for programmatic
  backfills, HikariCP (leak detection, optional metrics registry), and
  rotating `SCRIPT TO` backups with sentinel-file restore. jdbi-orm is
  wired in. Consumption: Gradle composite build or mavenLocal.
- **[auth-kotlin-toolkit](https://github.com/jeffbstewart/auth-kotlin-toolkit)**
  (MIT) already packages auth: bcrypt, hashed-cookie sessions, JWT with
  refresh rotation and theft detection, rate-limited login with
  lockout, WebAuthn/passkeys — deliberately framework-uncoupled
  (consumer implements `UserRepository`, brings its own HTTP server).

What has **no toolkit yet** is the Armeria server wiring and the
protobuf/TypeScript codegen pipeline. That is what this design adds,
plus one small gap in h2-kotlin-toolkit.

## Piece 1 — new toolkit: `armeria-kotlin-toolkit`

A third sibling toolkit (working name; alternative:
`appserver-kotlin-toolkit`), MIT like the others, package
`net.stewart.armeria`, consumed by composite build per the family
convention.

**Extracted from** MediaManager's `grpc/ArmeriaServer.kt` (350 LOC) —
generalized from a hard-coded service list into configuration:

```kotlin
val server = ArmeriaAppServer(
  AppServerConfig(
    port = 9090,
    grpcServices = listOf(...),            // BindableService instances
    grpcInterceptors = listOf(...),        // applied to all, or per-service pairs
    httpServices = listOf(...),            // optional Armeria annotated services
    spa = SpaConfig(dir = Path("spa"), urlPrefix = "/app/"),  // optional
    healthPath = "/healthz",
    decorators = listOf(...),              // e.g. auth decorator
    meterRegistry = ...,                   // optional Micrometer
  )
).start()
```

Behavior carried over from MediaManager, verbatim in spirit:

- **One HTTP/2 port serves everything**: gRPC with *all* serialization
  formats enabled — native proto for programmatic clients and
  **gRPC-Web for the browser's Connect-ES client, no proxy** — plus
  optional annotated REST services and SPA static serving with
  `index.html` fallback.
- Internal-only second port + decorator (MediaManager's
  `internalOnlyDecorator`) kept as an option — useful later for
  metrics/admin.
- Explicitly **not** extracted: MediaManager's media streaming
  handlers, its ~70 app-specific REST services, transcode wiring.

**Auth boundary:** the core module does **not** depend on
auth-kotlin-toolkit — it only exposes decorator/interceptor injection
points. A small **optional module** `armeria-kotlin-toolkit-auth`
(extracting MediaManager's `AuthInterceptor` + `ArmeriaAuthDecorator`
patterns) bridges the two toolkits for consumers that want the pairing.
finance2 will use it.

## Piece 2 — the codegen pipeline

What finance2 needs end to end: `.proto` → Kotlin/Java server stubs
(Gradle, at build time) and `.proto` → typed TypeScript Connect-ES
client (node script), with drift a compile error on both sides.

**Ship as documented template, not a Gradle plugin (recommendation).**
The pipeline is three small, transparent pieces — the
protobuf-gradle-plugin block (~20 lines), the `gen-proto.mjs`
Connect-ES script, and a CI job — and there will be at most two
consumers for the foreseeable future. A convention plugin adds build
machinery, plugin publishing, and debugging indirection to save ~40
lines of copying. The toolkit repo carries a `codegen/` directory with
the canonical script + snippets and a README; consumers copy and pin
their own tool versions in their version catalog. Revisit as a plugin
if a third consumer appears or the copies drift painfully.

**The CI sync guarantee** (MODERNIZATION Phase 0 requirement, stricter
than MediaManager): generated code is **never committed** — Kotlin
stubs regenerate on every Gradle build, and CI regenerates the TS
client from `.proto` and then **compiles the web app against it**. A
hallucinated field or RPC on either side is a build failure in CI by
construction; with nothing generated in git, there is nothing to
drift.

## Piece 3 — close the h2-kotlin-toolkit test gap

h2-kotlin-toolkit has no in-memory mode, so MediaManager's test
pattern (in-memory H2 running the consumer's own Flyway migrations,
per-class schema for parallel runs) is not yet reusable. Small PR **to
h2-kotlin-toolkit**:

- `H2Config` gains an in-memory variant
  (`jdbc:h2:mem:<name>;DB_CLOSE_DELAY=-1`; encryption/backup paths
  skipped).
- A published **test-fixtures artifact** with a JUnit 5 extension/base
  class: fresh named schema per test class, runs the consumer's
  migrations, wires jdbi-orm's data source.

This lives in h2-kotlin-toolkit (not the new toolkit) because it is
purely a DB concern and useful to consumers that don't use Armeria.

## Execution order

1. **PR to h2-kotlin-toolkit**: in-memory mode + test fixtures
   (piece 3 — small, independent).
2. **New repo `armeria-kotlin-toolkit`**: core module extracted from
   MediaManager + optional auth-bridge module + `codegen/` templates +
   its own tests and CI (pieces 1–2). MIT, same copyright; MediaManager
   attribution is same-owner hygiene.
3. **finance2 bootstrap PR** (completes Phase 0): Gradle skeleton
   (version catalog, Kotlin 2.3.x, JVM 21) with
   `includeBuild` of the three sibling toolkits; `proto/` with a first
   trivial service proving the pipeline; minimal web-app workspace so
   the TS side of the codegen check is real from day one; `CLAUDE.md`
   (collaboration model, `.env` policy); `.gitignore`/`.aiignore`
   covering `.env`, data directories, and the Plaid snapshot directory
   (a Decision 1 obligation); `example.env`; CI running build + tests +
   both codegen checks + `npm audit`.
4. MediaManager's own adoption of the toolkits: **out of scope** here;
   nothing in this design depends on it.

## Open questions for Jeff (all answered 2026-07-17: recommendations accepted)

1. **Name**: `armeria-kotlin-toolkit` (recommended — says what it is,
   matches the family naming) or something app-base flavored?
2. **Codegen as template** (recommended) vs Gradle convention plugin?
3. **Auth bridge as an optional module** inside the new toolkit
   (recommended) vs leaving the bridging entirely to consumers?
4. **Repo visibility**: siblings are public; assume public for the new
   toolkit too?
5. **Toolkit changes by PR**: same collaboration model as finance2
   (feature branch + PR, you merge) for h2-kotlin-toolkit and the new
   repo?
