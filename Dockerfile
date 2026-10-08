# syntax=docker/dockerfile:1.7
# The production image: one container, one process (the `rust-api` service of
# docker-compose.yml). The Rust server applies the SQLite migrations when it
# starts, then serves the client build, the API and MCP, and runs the
# scheduled jobs and the backups.

# --- Compile the shared Rust core for the browser ---
FROM rust:1.98 AS wasm-builder
WORKDIR /app
RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-bindgen-cli --version 0.2.128 --locked
RUN apt-get update && apt-get install -y --no-install-recommends binaryen \
    && rm -rf /var/lib/apt/lists/*
COPY rust-api ./rust-api
RUN cargo build --locked --release -p ledger-core --features wasm \
    --target wasm32-unknown-unknown --manifest-path rust-api/Cargo.toml
RUN wasm-bindgen --target web --out-dir /wasm-pkg \
    rust-api/target/wasm32-unknown-unknown/release/ledger_core.wasm
RUN wasm-opt --enable-bulk-memory --enable-nontrapping-float-to-int -Oz \
    /wasm-pkg/ledger_core_bg.wasm -o /wasm-pkg/optimized.wasm \
    && mv /wasm-pkg/optimized.wasm /wasm-pkg/ledger_core_bg.wasm

# --- Build the client (vite build writes build/) ---
FROM node:26-alpine AS client
WORKDIR /app
# .npmrc carries strict-allow-scripts=true, which makes package.json's
# allowScripts map enforcing. Without it here, npm ci would run unapproved
# install scripts and merely warn.
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
COPY --from=wasm-builder /wasm-pkg/ledger_core.js /wasm-pkg/ledger_core.d.ts \
    /wasm-pkg/ledger_core_bg.wasm /wasm-pkg/ledger_core_bg.wasm.d.ts ./lib/wasm/generated/
# vite.config.ts puts these in the client at build time, so they must be here
# now. A runtime value has no effect on a built client.
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST
RUN CORE_WASM_PREBUILT=1 npm run build

# --- Build the server and ledger-cli ---
FROM rust:1.98-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY package.json ./package.json
COPY lib/api-contract.ts ./lib/api-contract.ts
COPY rust-api ./rust-api
ENV SQLX_OFFLINE=true
# Every checkout on a host shares these caches: production, dev and each
# worktree. A registry crate is fixed by its version and checksum, so sharing
# it is safe. A workspace crate has the same path in every checkout, and cargo
# decides freshness by file times, so a build could link a workspace crate
# that another checkout compiled. `cargo clean -p` removes the workspace
# crates first; the dependencies stay cached. Name every workspace member here;
# a repository test checks the list against rust-api/Cargo.toml.
RUN --mount=type=cache,id=counterpoise-rust-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=counterpoise-rust-target,target=/app/rust-api/target,sharing=locked \
    cargo clean --release --manifest-path rust-api/Cargo.toml \
      -p ledger-core -p ledger-db -p counterpoise-rust-api -p ledger-cli && \
    cargo build --release --locked --manifest-path rust-api/Cargo.toml \
      -p counterpoise-rust-api -p ledger-cli && \
    cp rust-api/target/release/counterpoise-rust-api rust-api/target/release/ledger-cli /app/

# --- Runtime ---
# No Node and no shell tools are needed: the binaries are static (musl), and
# reqwest carries its own TLS roots. Alpine gives `sh` for `docker exec`.
FROM alpine:3.24
# chrono::Local reads TZ from these files. Without them it uses UTC in silence.
RUN apk add --no-cache tzdata
# The server runs as uid 1000. /data holds counterpoise.db with its -wal,
# -shm and lock files; /backups holds the snapshots and the job status
# records. A new named volume takes this ownership from the image.
RUN addgroup -g 1000 counterpoise \
    && adduser -D -H -u 1000 -G counterpoise counterpoise \
    && mkdir -p /data /backups/status \
    && chown -R counterpoise:counterpoise /data /backups

COPY --from=builder /app/counterpoise-rust-api /app/ledger-cli /usr/local/bin/
COPY --from=client /app/build /srv/client

# COUNTERPOISE_SCHEDULER=on: the server runs the scheduled jobs itself
# (rust-api/server/src/scheduler.rs).
ENV NODE_ENV=production \
    RUST_BIND=0.0.0.0:4000 \
    DATABASE_PATH=/data/counterpoise.db \
    BACKUP_DIR=/backups \
    COUNTERPOISE_STATIC_DIR=/srv/client \
    COUNTERPOISE_SCHEDULER=on

USER counterpoise
WORKDIR /data
VOLUME ["/data", "/backups"]
EXPOSE 4000

# /health runs a query, so a broken database fails the check, not only a
# dead process.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
    CMD ["counterpoise-rust-api", "health"]

# No entrypoint script: the server opens the file, takes the server lock,
# applies the migrations and runs the lot guard before it serves. Any other
# command runs in its place, for example
# `docker run ... ledger-cli import-postgres --from ... --to /data/counterpoise.db`.
CMD ["counterpoise-rust-api"]
