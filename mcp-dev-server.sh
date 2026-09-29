#!/bin/bash
# Runs the MCP server over stdio against the local database, for an MCP client
# that starts it. .env.local gives DATABASE_URL and COUNTERPOISE_API_KEY.

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source .env.local
set +a
exec cargo run --quiet --manifest-path rust-api/Cargo.toml -p counterpoise-rust-api -- mcp
