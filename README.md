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

## Run with Docker

The image is self-contained (`docker build .` clones the toolkit
siblings itself) and holds no secrets: every credential arrives at run
time from `.env`, which `.dockerignore` keeps out of the build context.

```bash
cp example.env .env               # set FINANCE2_DATA, H2_PASSWORD, H2_FILE_PASSWORD, TRUSTED_PROXIES, API keys
docker compose up -d --build
docker compose logs -f finance2   # the first boot prints the one-time setup token
```

- The encrypted database lives in the host directory `FINANCE2_DATA`
  (required — compose refuses to start without it), bind-mounted at
  `/data`; the container itself is disposable. Back the directory up
  like any other file. The server runs unprivileged as
  `FINANCE2_UID:FINANCE2_GID` (10001:10001 by default), so the
  directory must be writable by that uid — `chown` it or set the
  variables to its owner. The container drops all capabilities, forbids
  privilege escalation, and runs on a read-only root filesystem; only
  `/data` and a tmpfs `/tmp` are writable.
- Host ports and limits are environment-overridable with defaults:
  `FINANCE2_PORT` (9090) is meant to be reached only through HAProxy,
  which terminates TLS and is identified by `TRUSTED_PROXIES`;
  `FINANCE2_INTERNAL_PORT` (9091) serves `/healthz` and `/metrics`
  LAN-direct and backs the image's `HEALTHCHECK`. `FINANCE2_MEM_LIMIT`
  (512m) and `FINANCE2_PIDS_LIMIT` (256) are the limits a NAS container
  manager can enforce, set at about twice the measured steady state
  (~115 JVM threads — each a pid — and well under 300 MiB RSS); the JVM
  sizes its heap from the memory limit.
- On the bridge network a proxy on another host keeps its own address
  for `TRUSTED_PROXIES`; a proxy on the same host appears as the
  bridge gateway (typically `172.17.0.1`), not `127.0.0.1`.
- A minimal HAProxy backend:

  ```
  frontend https
      bind :443 ssl crt /etc/haproxy/certs/finance.pem
      http-request set-header X-Forwarded-For %[src]
      http-request set-header X-Forwarded-Proto https
      default_backend finance2

  backend finance2
      server app <docker-host>:9090 proto h2
  ```

  `proto h2` matters: native gRPC needs end-to-end HTTP/2 (gRPC-Web
  and the SPA work either way).

## Assumptions

- **Tax years are calendar years.** Everything tax-shaped â€” the tax
  report's default range, and mark-to-market tax years in particular
  (a mark's date must fall inside its tax year, Jan 1 â€“ Dec 31) â€”
  assumes the user's tax year and the civil calendar year align. A
  fiscal-year taxpayer would need changes wherever a year number is
  treated as Janâ€“Dec.
- **The reporting currency is USD.** Multi-currency accounts are
  supported; cross-currency arithmetic only ever happens through a
  dated FX rate.
- **Single user.** The first account created is the only account;
  registration closes permanently afterwards.

## Not tax advice

Neither the author nor this software is a tax advisor. The tax
treatment this software implements â€” capital gain terms, the PFIC
Â§1296 mark-to-market handling, and everything else tax-shaped â€” is
the best understanding of the author and their AI agent, based on
**United States tax rules as of 2026**. Tax law differs by
jurisdiction and changes over time. Users are on their own to confirm
with a competent tax advisor that these assumptions hold for their
situation before relying on any figure this software produces.
