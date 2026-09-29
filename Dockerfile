# syntax=docker/dockerfile:1.7
# The production image (the `rust-api` service of docker-compose.yml).
# docker-entrypoint.sh checks the database credential, applies the Drizzle
# migrations and rebuilds the investment lots, then starts the Rust server,
# which serves the client build, the API and MCP. Node is in the runtime
# image only for migrate.js.

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
# migrate.js needs these at runtime. Record the exact versions this build's
# lockfile resolved, so the runtime installs those rather than whatever is
# newest.
RUN node -e "const n=['drizzle-orm','postgres']; \
  require('fs').writeFileSync('/app/runtime-deps.txt', \
    n.map(p => p + '@' + require('/app/node_modules/' + p + '/package.json').version).join(' '))" \
 && cat /app/runtime-deps.txt

# --- Build the server and ledger-cli ---
FROM rust:1.98-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY package.json ./package.json
COPY lib/api-contract.ts ./lib/api-contract.ts
COPY rust-api ./rust-api
ENV SQLX_OFFLINE=true
RUN --mount=type=cache,id=counterpoise-rust-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=counterpoise-rust-target,target=/app/rust-api/target,sharing=locked \
    cargo build --release --locked --manifest-path rust-api/Cargo.toml \
      -p counterpoise-rust-api -p ledger-cli && \
    cp rust-api/target/release/counterpoise-rust-api rust-api/target/release/ledger-cli /app/

# --- Runtime ---
FROM node:26-alpine
# chrono::Local reads TZ from these files. Without them it uses UTC in silence.
RUN apk add --no-cache tzdata
WORKDIR /app
# node (uid 1000) ships in node:26-alpine. Chown the directory itself so the
# npm install below can write into it as that user.
RUN chown node:node /app
ENV NODE_ENV=production

COPY --from=builder /app/counterpoise-rust-api /app/ledger-cli /usr/local/bin/
COPY --from=client /app/build /srv/client
ENV COUNTERPOISE_STATIC_DIR=/srv/client

# The migration files and their runner.
COPY --from=client --chown=node:node /app/db/migrations ./migrations
COPY --from=client --chown=node:node /app/scripts/docker-migrate.mjs ./migrate.js

# Install the runtime dependencies of migrate.js, at the versions that the
# client stage recorded, so rebuilding a commit cannot silently pick up a newer
# major of drizzle-orm or postgres.
#
# Known gap: their TRANSITIVE versions still resolve fresh here. Pinning those
# too means copying the lockfile-pinned production tree, or bundling
# migrate.js so the runtime needs no install at all.
#
# --ignore-scripts: no allowScripts map applies to this install, and none of these
# packages need install scripts.
COPY --from=client --chown=node:node /app/runtime-deps.txt ./
USER node
RUN npm install --no-save --ignore-scripts $(cat runtime-deps.txt) \
 && rm runtime-deps.txt

COPY --chown=node:node docker-entrypoint.sh ./
COPY --chown=node:node scripts/check-db-credential.sh ./

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
