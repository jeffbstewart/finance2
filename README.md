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

CI publishes the image to GitHub Container Registry on every merge to
`main`: `ghcr.io/jeffbstewart/finance2:latest`, plus `:sha-<short>`
per commit for pinning (`FINANCE2_IMAGE`). The package is public, so
pulling needs no login. The image is self-contained (`docker build .`
clones the toolkit siblings itself) and holds no secrets: every
credential arrives at run time from the environment - Portainer's
stack variables, or a `.env` beside the compose file for the CLI
(`.dockerignore` keeps it out of the build context). The compose file
lists every variable it forwards and refuses to start without the
required ones.

```bash
cp example.env .env               # set FINANCE2_DATA, H2_PASSWORD, H2_FILE_PASSWORD, TRUSTED_PROXIES, API keys
docker compose up -d              # pulls ghcr.io/jeffbstewart/finance2:latest (always)
docker compose logs -f finance2   # the first boot prints the one-time setup token
```

To run a build of your own checkout instead, add the developer
override - it tags the result `finance2:local`, never the registry's
name, and the UI shows `dev build`:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

- Which build is this? The foot of the left nav shows the build stamp
  CI baked into the image - `PR #82 - 2026-08-22 02:30 UTC - 7d470c5`:
  the pull request that was merged, the commit's time, the short
  commit. Hover for the version. Images are also tagged `pr-<N>`, so
  `FINANCE2_IMAGE=ghcr.io/jeffbstewart/finance2:pr-82` pins exactly
  that PR. Anything built outside CI says `dev build`.
- Portainer: deploy the stack from this repository; every update
  pulls `:latest` (`pull_policy: always`), so the **Re-pull image**
  toggle no longer matters. Earlier, the compose file also carried
  `build: .`, and an update without re-pull silently built from the
  checkout and tagged it with the registry's name - a build with no
  stamp, showing `dev build`, shadowing the CI image. If a host still
  has one of those, `docker rmi ghcr.io/jeffbstewart/finance2:latest`
  (with the stack stopped) and redeploy.

- The encrypted database lives in the host directory `FINANCE2_DATA`
  (required - compose refuses to start without it), bind-mounted at
  `/data`; the container itself is disposable. Back the directory up
  like any other file. The server runs unprivileged as
  `FINANCE2_UID:FINANCE2_GID` (10001:10001 by default), so the
  directory must be writable by that uid - `chown` it or set the
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
  (~115 JVM threads - each a pid - and well under 300 MiB RSS); the JVM
  sizes its heap from the memory limit.
- `TRUSTED_PROXIES`: a proxy on another host keeps its own address; a
  proxy on the same host appears as the gateway of the stack's network,
  which the compose file pins to `FINANCE2_SUBNET` (`172.28.0.0/24`, so
  the gateway is `172.28.0.1`) precisely so that re-creating the stack
  does not move it. Entries may be CIDR ranges (`172.28.0.0/24`) when
  you would rather trust the whole subnet than one gateway address.
- Deploying through Portainer behind HAProxy: the stack create/update
  is one synchronous HTTP request that includes pulling the 170 MB
  image, and HAProxy's default `timeout server` (50s) will cut it off
  with its own `504 Gateway Time-out` page while Portainer carries on
  in the background - leaving a half-created stack. Either raise the
  timeout on the Portainer backend (`timeout server 10m` is plenty) or
  pull the image first (`docker pull ghcr.io/jeffbstewart/finance2:latest`,
  or Portainer's Images > Pull) so the deploy itself is quick.
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

- **Tax years are calendar years.** Everything tax-shaped - the tax
  report's default range, and mark-to-market tax years in particular
  (a mark's date must fall inside its tax year, Jan 1 - Dec 31) - 
  assumes the user's tax year and the civil calendar year align. A
  fiscal-year taxpayer would need changes wherever a year number is
  treated as Jan-Dec.
- **The reporting currency is USD.** Multi-currency accounts are
  supported; cross-currency arithmetic only ever happens through a
  dated FX rate.
- **Single user.** The first account created is the only account;
  registration closes permanently afterwards.

## Not tax advice

Neither the author nor this software is a tax advisor. The tax
treatment this software implements - capital gain terms, the PFIC
sec. 1296 mark-to-market handling, and everything else tax-shaped - is
the best understanding of the author and their AI agent, based on
**United States tax rules as of 2026**. Tax law differs by
jurisdiction and changes over time. Users are on their own to confirm
with a competent tax advisor that these assumptions hold for their
situation before relying on any figure this software produces.
