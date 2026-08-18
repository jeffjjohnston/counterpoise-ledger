#!/bin/bash

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a
source .env.local
set +a
npx tsx mcp/server.ts
