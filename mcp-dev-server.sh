#!/bin/bash
# Runs the MCP server over stdio against the local database, for an MCP client
# that starts it. .env.local gives COUNTERPOISE_API_KEY, and DATABASE_PATH when
# the dev database is not data/counterpoise.db.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source .env.local
set +a
exec cargo run --quiet --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api -- mcp
