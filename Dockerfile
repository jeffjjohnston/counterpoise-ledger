# --- Stage 1: Install dependencies ---
FROM node:24-alpine AS deps
WORKDIR /app
# .npmrc carries strict-allow-scripts=true, which makes package.json's
# allowScripts map enforcing. Without it here, npm ci would run unapproved
# install scripts and merely warn.
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# --- Stage 2: Build the application ---
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# NEXT_PUBLIC_ vars must be present at build time (inlined by Next.js)
ARG NEXT_PUBLIC_POSTHOG_KEY
ARG NEXT_PUBLIC_POSTHOG_HOST
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
ENV NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST

# next.config.js reads this inside headers(), which Next.js evaluates at build
# time and bakes into routes-manifest.json — a runtime-only env var here would
# have no effect on the standalone server. Same pattern as the POSTHOG vars above.
ARG ENABLE_HSTS
ENV ENABLE_HSTS=$ENABLE_HSTS

RUN npm run build
RUN node scripts/bundle-node-entrypoints.mjs

# bundle-node-entrypoints.mjs uses packages:"external", so mcp-server.mjs and
# migrate.js need these at runtime. Record the exact versions this build's
# lockfile resolved, so the runner installs those rather than whatever is newest.
RUN node -e "const n=['drizzle-orm','postgres','@modelcontextprotocol/sdk','posthog-node','zod']; \
  require('fs').writeFileSync('/app/runtime-deps.txt', \
    n.map(p => p + '@' + require('/app/node_modules/' + p + '/package.json').version).join(' '))" \
 && cat /app/runtime-deps.txt

# --- Stage 3: Production runner ---
FROM node:24-alpine AS runner
WORKDIR /app

# node (uid 1000) ships in node:24-alpine. Chown the directory itself so the
# npm install below can write into it as that user.
RUN chown node:node /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Copy standalone server output
COPY --from=builder --chown=node:node /app/.next/standalone ./

# Copy static assets (standalone doesn't include these)
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

# Copy migration files and runner
COPY --from=builder --chown=node:node /app/db/migrations ./migrations
COPY --from=builder --chown=node:node /app/scripts/docker-migrate.mjs ./migrate.js

# Copy MCP server bundle
COPY --from=builder --chown=node:node /app/dist/mcp-server.mjs ./mcp-server.mjs

# Copy lot rebuild bundle (data migration, run by the entrypoint after schema migrations)
COPY --from=builder --chown=node:node /app/dist/rebuild-lots.mjs ./rebuild-lots.js

# Install runtime dependencies (not traced by standalone since these scripts are external).
# Versions come from runtime-deps.txt, pinned in the builder to what this build's
# package-lock.json resolved, so rebuilding a commit cannot silently pick up a newer
# major of drizzle-orm, postgres, the MCP SDK, posthog-node or zod.
#
# Known gap: their TRANSITIVE versions still resolve fresh here, because npm ci would
# delete the traced node_modules that .next/standalone provides. Pinning those too means
# either copying the full 491MB lockfile-pinned production tree, or bundling migrate.js
# and mcp-server.mjs so the runner needs no install at all.
#
# --ignore-scripts: no allowScripts map applies to this install, and none of these
# packages need install scripts.
COPY --from=builder --chown=node:node /app/runtime-deps.txt ./
USER node
RUN npm install --no-save --ignore-scripts $(cat runtime-deps.txt) \
 && rm runtime-deps.txt

# Copy entrypoint
COPY --chown=node:node docker-entrypoint.sh ./

EXPOSE 3000

# busybox wget ships with alpine; no extra layer needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
