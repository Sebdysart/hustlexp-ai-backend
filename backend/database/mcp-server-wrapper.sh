#!/bin/bash
# Wrapper script for Database MCP Server
# Loads DATABASE_URL from env.backend before starting the server

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Change to project root
cd "$PROJECT_ROOT" || exit 1

# Load DATABASE_URL from env.backend if available
if [ -f "$PROJECT_ROOT/env.backend" ]; then
  export $(grep "^DATABASE_URL" "$PROJECT_ROOT/env.backend" | head -1 | xargs)
fi

# If still not set, try environment
if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL not found in env.backend or environment" >&2
  exit 1
fi

# Run the MCP server using npx tsx (tsx not in PATH)
# Use absolute path to mcp-server.ts
exec npx tsx "$SCRIPT_DIR/mcp-server.ts"
