#!/bin/bash
# Wrapper script for Test Runner MCP Server
# Loads DATABASE_URL from env.backend before starting the server (for tests that need DB)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT" || exit 1

# Load DATABASE_URL from env.backend if available (for tests that need DB)
if [ -f "$PROJECT_ROOT/env.backend" ]; then
  export $(grep "^DATABASE_URL" "$PROJECT_ROOT/env.backend" | head -1 | xargs)
fi

# Note: DATABASE_URL is optional for the test runner
# Some tests may mock the database, others may need real DB access

# Run the MCP server using npx tsx (tsx not in PATH)
exec npx tsx "$SCRIPT_DIR/mcp-server.ts"