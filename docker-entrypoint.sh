#!/bin/sh
set -e

echo "Running database migrations..."
node /app/migrate.js

# Data migration. Guarded — no-ops once allocations exist. A failure aborts
# startup on purpose: the schema migration empties investment_lots, so starting
# anyway would serve zero cost basis everywhere with no visible error.
echo "Rebuilding investment lots..."
node /app/rebuild-lots.js

echo "Starting Next.js server..."
exec node /app/server.js
