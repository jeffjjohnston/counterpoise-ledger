#!/bin/sh
# The entrypoint of the production image. The server starts only after the
# migrations and the lot rebuild succeed, so a new server never runs against a
# schema that it does not expect. A failure stops the container, and the
# deploy (`up --wait`) fails.
set -e

# Before migrations, because a run that gets this far has already connected
# with the credential in question.
./check-db-credential.sh

echo "Running database migrations..."
node /app/migrate.js

# Data migration. Guarded — no-ops once allocations exist. A failure aborts
# startup on purpose: the schema migration empties investment_lots, so starting
# anyway would serve zero cost basis everywhere with no visible error.
echo "Rebuilding investment lots..."
ledger-cli rebuild-lots

echo "Starting the server..."
exec counterpoise-rust-api
