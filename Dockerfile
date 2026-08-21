# finance2 container image — one durable, always-running process that
# serves gRPC + gRPC-Web + the SPA on $PORT (behind HAProxy) and
# /healthz + /metrics on $INTERNAL_PORT (LAN-direct). See README.md
# "Run with Docker".
#
# Self-contained: the toolkit family (composite-build siblings in a
# developer checkout) is cloned inside the build stage, so
# `docker build .` needs nothing beside this repository. No secrets
# are baked in — .env is excluded by .dockerignore and every
# credential arrives at run time as an environment variable.

# ---- Stage 1: the Angular SPA ------------------------------------------
# Regenerates the Connect-ES client from proto/ (prebuild) and builds
# the production bundle into /src/spa with base href /app/.
FROM node:24-bookworm-slim AS spa
WORKDIR /src/web-app
COPY web-app/package.json web-app/package-lock.json ./
RUN npm ci
COPY proto /src/proto
COPY web-app ./
RUN npm run build

# ---- Stage 2: the Kotlin server ----------------------------------------
# Tests are CI's job (the verify workflow runs them against the same
# sources); the image build compiles and assembles only.
FROM eclipse-temurin:25-jdk-noble AS server
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Composite-build siblings, beside the checkout exactly as settings.gradle.kts
# expects (armeria-kotlin-toolkit itself includes ../auth-kotlin-toolkit).
RUN git clone --depth 1 https://github.com/jeffbstewart/armeria-kotlin-toolkit.git \
 && git clone --depth 1 https://github.com/jeffbstewart/auth-kotlin-toolkit.git \
 && git clone --depth 1 https://github.com/jeffbstewart/h2-kotlin-toolkit.git
WORKDIR /src/finance2
COPY . ./
# Tolerate a Windows checkout (CRLF wrapper, no exec bit).
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew \
 && ./gradlew installDist --no-daemon -x test

# ---- Stage 3: the runtime image ----------------------------------------
FROM eclipse-temurin:25-jre-noble
# curl is for HEALTHCHECK only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 finance2 \
 && mkdir -p /data && chown finance2:finance2 /data
WORKDIR /app
COPY --from=server --chown=finance2:finance2 /src/finance2/build/install/finance2 ./
# The server serves the SPA from ./spa relative to its working directory.
COPY --from=spa --chown=finance2:finance2 /src/spa ./spa
USER finance2

# The database lives on a volume; everything else in the container is
# disposable. DB_PATH is the file path without extension.
VOLUME /data
ENV DB_PATH=/data/finance2 \
    PORT=9090 \
    INTERNAL_PORT=9091 \
    JAVA_OPTS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"
EXPOSE 9090 9091
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${INTERNAL_PORT}/healthz" || exit 1
ENTRYPOINT ["bin/finance2"]
