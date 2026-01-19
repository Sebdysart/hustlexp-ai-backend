# Database MCP Implementation Guide

**Date**: January 2025  
**Status**: Configuration created, implementation needs refinement  
**Purpose**: Read-only PostgreSQL database schema inspection via MCP

---

## ✅ What's Been Created

1. **Database MCP Server File**: `backend/database/mcp-server.ts`
   - Read-only PostgreSQL connection using Neon serverless
   - MCP protocol implementation (needs SDK refinement)
   - Query whitelisting for read-only enforcement
   - Tools for schema inspection

2. **MCP Configuration**: Updated `~/.cursor/mcp.json`
   - Added `database-mcp` entry
   - Configured with `tsx` to run TypeScript
   - Environment: `DATABASE_URL` required

3. **Documentation**:
   - `docs/MCP_DATABASE_CONFIG.md` - Configuration guide
   - `docs/MCP_DATABASE_IMPLEMENTATION.md` - This file

4. **Dependencies**: 
   - ✅ `@modelcontextprotocol/sdk` installed (v1.25.2)
   - ✅ `@neondatabase/serverless` already available
   - ✅ `tsx` already available

---

## ⚠️ Implementation Status

**Current Status**: Configuration complete, implementation needs refinement

The MCP server implementation (`backend/database/mcp-server.ts`) was created but needs refinement based on the actual SDK API. The SDK uses:
- `Server` class from `@modelcontextprotocol/sdk/server/index.js`
- Stdio transport handled differently (may need manual stdin/stdout handling)
- Different schema types than initially assumed

---

## 🔧 Next Steps to Complete Implementation

### Step 1: Verify SDK API

Check the actual SDK exports:
```bash
cd backend && node -e "import('@modelcontextprotocol/sdk/server/index.js').then(m => console.log(Object.keys(m)))"
```

### Step 2: Check Example Implementations

Look for example stdio server implementations:
```bash
find node_modules/@modelcontextprotocol/sdk -name "*stdio*" -o -name "*example*"
```

### Step 3: Create Working Implementation

Use one of these approaches:

**Option A: Use Official Example Pattern**
- Copy pattern from SDK examples
- Adapt for PostgreSQL read-only queries

**Option B: Manual Stdio Handling**
- Use `process.stdin`/`process.stdout` directly
- Implement MCP JSON-RPC protocol manually
- Simpler but more error-prone

**Option C: Use Existing PostgreSQL MCP Server**
- Search npm for existing PostgreSQL MCP servers
- Use if available (e.g., `@modelcontextprotocol/server-postgres`)

---

## 📋 Verification Checklist

Once implementation is working:

- [ ] Server starts without errors
- [ ] Connects to PostgreSQL database
- [ ] Read-only enforcement works (rejects INSERT/UPDATE/DELETE)
- [ ] Schema inspection tools work:
  - [ ] `list_tables` returns all tables
  - [ ] `list_constraints` returns constraints for a table
  - [ ] `query_schema` executes SELECT queries
  - [ ] `get_schema_version` returns schema version
- [ ] AI can answer:
  - [ ] "What constraints exist on escrow release?"
  - [ ] "What table is the source of truth for XP?"
- [ ] AI refuses to design logic that violates schema constraints

---

## 🚀 Quick Test

Once implementation is refined, test it:

```bash
# Set DATABASE_URL
export DATABASE_URL="postgresql://neondb_owner:password@REDACTED_NEON_HOST_1-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require"

# Test MCP server manually
tsx backend/database/mcp-server.ts
```

Then test via MCP client (Cursor) by asking:
- "List all tables in the database"
- "What constraints exist on the escrows table?"
- "What is the current schema version?"

---

## 📝 Current Configuration

**MCP Config** (`~/.cursor/mcp.json`):
```json
{
  "database-mcp": {
    "command": "tsx",
    "args": ["backend/database/mcp-server.ts"],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}"
    },
    "cwd": "/Users/sebastiandysart/HustleXP/hustlexp-ai-backend"
  }
}
```

**Note**: `${DATABASE_URL}` may need to be replaced with actual environment variable resolution, or use absolute path/script wrapper.

---

## ✅ Done Criteria

The Database MCP is complete when:

- ✅ Configuration added to `~/.cursor/mcp.json`
- ✅ Server implementation created (`backend/database/mcp-server.ts`)
- ⏳ Server implementation works with actual SDK API
- ⏳ Read-only enforcement verified
- ⏳ AI can inspect schema via MCP
- ⏳ AI refuses invalid schema logic

**Current**: Configuration complete, implementation needs SDK API refinement

---

**Last Updated**: January 2025  
**Next**: Refine implementation based on actual SDK API, then test and verify
