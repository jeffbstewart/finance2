# finance2

A single-user personal portfolio manager: Kotlin/Armeria backend,
embedded encrypted H2 database, a proto-typed API with a generated
TypeScript client, and an Angular UI. The full plan and firm
requirements live in [MODERNIZATION.md](MODERNIZATION.md); settled
decisions in [decisions/](decisions/) and designs in
[docs/design/](docs/design/).

## Build and run

```bash
JAVA_HOME=<jdk21+> ./gradlew build   # build + tests
./gradlew --no-daemon run            # run the server (default port 9090)
cd web-app && npm ci && npm run check
```

Configuration is environment variables; `example.env` documents every
one. The sibling toolkit repos (`armeria-kotlin-toolkit`,
`h2-kotlin-toolkit`, `auth-kotlin-toolkit`) are consumed as Gradle
composite builds from checkouts beside this one.

## Assumptions

- **Tax years are calendar years.** Everything tax-shaped — the tax
  report's default range, and mark-to-market tax years in particular
  (a mark's date must fall inside its tax year, Jan 1 – Dec 31) —
  assumes the user's tax year and the civil calendar year align. A
  fiscal-year taxpayer would need changes wherever a year number is
  treated as Jan–Dec.
- **The reporting currency is USD.** Multi-currency accounts are
  supported; cross-currency arithmetic only ever happens through a
  dated FX rate.
- **Single user.** The first account created is the only account;
  registration closes permanently afterwards.
