# CLAUDE.md

## Project Overview

finance2 is a single-user personal portfolio manager - the ground-up
rewrite of the legacy `finance` repo. Kotlin/Armeria backend, embedded
H2 database, proto-typed API boundary with a generated TypeScript
client, intended to become a public repository. The full plan, firm
requirements, and phase roadmap live in **MODERNIZATION.md**; settled
decisions live in **decisions/** and designs in **docs/design/**. Read
those before proposing architectural changes.

## Collaboration Model

Claude authors changes on **feature branches** and proposes **pull
requests** for Jeff's review and approval. No direct commits to `main`;
**no self-merging**. The same model applies to the sibling toolkit
repos.

## Architecture

- **Server:** `ArmeriaAppServer` from
  [armeria-kotlin-toolkit](https://github.com/jeffbstewart/armeria-kotlin-toolkit)
  - one HTTP/2 port serving gRPC (native + gRPC-Web, no proxy), REST,
  the SPA, and `/healthz`. Auth wiring comes from its
  `armeria-kotlin-toolkit-auth` module: every RPC not on the explicit
  unauthenticated allowlist is rejected.
- **Database:** embedded H2, AES-encrypted at rest, via
  [h2-kotlin-toolkit](https://github.com/jeffbstewart/h2-kotlin-toolkit)
  (HikariCP + Flyway + SchemaUpdater). Migrations in
  `src/main/resources/db/migration/`, `V{NNN}__{description}.sql`.
  Tests use the toolkit's `H2TestDatabaseExtension` (in-memory, same
  migrations).
- **Wire contract:** `.proto` files in `proto/` are the single source
  of truth. Kotlin stubs regenerate on every Gradle build; the
  TypeScript Connect-ES client regenerates via
  `web-app/scripts/gen-proto.mjs` before every check/build. **Generated
  code is never committed.** No hand-written DTOs, no `any`-typed
  fetch calls - a hallucinated field or RPC must fail compilation.
- **Toolkits are consumed as composite builds** from sibling checkouts
  (`../armeria-kotlin-toolkit`, `../h2-kotlin-toolkit`,
  `../auth-kotlin-toolkit` - the first includes the third).

## Build and Run

```bash
JAVA_HOME=<jdk21+> ./gradlew build            # build + tests (regenerates Kotlin stubs)
./gradlew --no-daemon run                     # run the server (default port 9090)
cd web-app && npm ci && npm run check         # regenerate TS client + typecheck
```

## House Conventions

- **Money and quantities are never floats.** `BigDecimal` on the JVM,
  string-encoded decimals on the wire and in JSON parsing (raw
  `json.Number`-style handling; provider SDK float fields are a known
  trap). The Phase 2 property-based test suite is the authority.
- **Strong-typed domain IDs** (value classes with validated
  construction), **real duration/date types** - no unit-suffixed
  primitives, no bare-string IDs.
- Multi-currency: no implicit cross-currency arithmetic; explicit
  conversion only through a dated FX rate.
- **All committed text is 7-bit ASCII** (tab and LF are the only
  control characters). No em dashes, section signs, arrows, curly
  quotes, or currency symbols in source, docs, or comments: write
  `-`, `sec.`, `->`, `"`, and `\u20ac`-style escapes where a string
  needs the real character. Enforced by `scripts/check-ascii.sh`,
  which CI runs first; the vendored Gradle wrapper, fonts, favicon,
  and the already-applied migrations `V001`-`V009` are the only
  exemptions.
- **An applied Flyway migration is immutable, byte for byte.** Flyway
  checksums the whole file, comments included, and a database that
  applied the original refuses to start against an edited one. Never
  reformat, re-comment, or otherwise touch `V{NNN}` once it has run
  anywhere; fix forward with a new migration.

## Security

- Claude must **never read `.env`** (git-ignored and `.aiignore`'d).
  `example.env` documents every variable and is fair game to read and
  edit.
- Values from `.env` are never committed or logged.
- **No provider data in git, ever** - API responses and bankferry
  snapshot files live under `data/` (git-ignored). Committing provider
  data violates provider ToS (see decisions/1-license-and-ip.md).
- finance2 holds **no Plaid credentials** - bankferry owns all Plaid
  access and exports proto snapshots
  (docs/design/plaid-investments-pipeline.md).

## Commit Message Style

Imperative summary line (~50 chars), body explaining what/why wrapped
at ~72, `-` bullets for change lists.
