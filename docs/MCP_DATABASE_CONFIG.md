# Database MCP Configuration (Read-Only)

**Date**: January 2025  
**Purpose**: Enable AI to inspect database schema, constraints, and audit tables (read-only)  
**Status**: **CRITICAL** — Required before test MCP  
**Authority**: Tier 0 (Truth & Enforcement)

---

## 🎯 Why Database MCP Must Come First

**Tests validate behavior. Schemas define reality.**

Without database schema awareness:
- ❌ Tests can validate impossible logic
- ❌ AI designs code that violates constraints
- ❌ False confidence (green tests, red production)
- ❌ Specs can hallucinate schema structure

**With Database MCP (read-only)**:
- ✅ AI inspects real tables, constraints, enums
- ✅ AI understands foreign keys and audit tables
- ✅ AI reasons about transaction boundaries
- ✅ Specs become grounded and enforceable
- ✅ Tests (later) become correct by construction

---

## 📋 Required Capabilities

The Database MCP must provide:

1. **Schema Inspection**:
   - List all tables
   - List all views
   - List all columns with types
   - List all constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK)
   - List all enums
   - List all triggers
   - List all functions

2. **Constraint Visibility**:
   - Foreign key relationships
   - Unique constraints
   - Check constraints (e.g., `trust_tier >= 1 AND trust_tier <= 4`)
   - NOT NULL constraints
   - Default values

3. **Audit Table Access**:
   - Read-only access to audit tables
   - View schema versions
   - View admin actions
   - View processed events

4. **Query Execution (Read-Only)**:
   - SELECT queries only
   - No INSERT, UPDATE, DELETE
   - No DDL (CREATE, ALTER, DROP)
   - No transactions that modify state

---

## 🔧 Configuration Options

### Option A: Official PostgreSQL MCP Server (Recommended)

If an official `@modelcontextprotocol/server-postgres` exists:

```json
{
  "database-mcp": {
    "command": "npx",
    "args": [
      "-y",
      "@modelcontextprotocol/server-postgres@latest"
    ],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}",
      "POSTGRES_READ_ONLY": "true",
      "POSTGRES_MAX_ROWS": "1000"
    }
  }
}
```

**Note**: As of January 2025, this package may not exist yet. If not, use Option B.

---

### Option B: Custom PostgreSQL MCP Server (Current Implementation)

Since no official PostgreSQL MCP server exists, we'll create a custom read-only wrapper.

**Implementation**: Create a Node.js script that:
1. Connects to PostgreSQL using `pg` or `@neondatabase/serverless`
2. Exposes read-only queries via MCP protocol
3. Enforces read-only by filtering SQL statements

**File**: `backend/database/mcp-server.ts` (to be created)

**Configuration**:
```json
{
  "database-mcp": {
    "command": "tsx",
    "args": [
      "backend/database/mcp-server.ts"
    ],
    "env": {
      "DATABASE_URL": "${DATABASE_URL}",
      "READ_ONLY": "true"
    }
  }
}
```

---

### Option C: Use Existing Database Tools (Temporary Workaround)

As an immediate workaround, use the filesystem MCP with database schema files:

**Current**: AI can read `backend/database/constitutional-schema.sql` via filesystem MCP

**Limitations**:
- ❌ Cannot verify actual database state
- ❌ Cannot inspect audit tables
- ❌ Cannot validate constraints against real DB
- ❌ Schema file may drift from actual DB

**Better**: Still need read-only DB MCP for real-time verification

---

## 🔒 Security Requirements

### Read-Only Enforcement

**Hard Rules**:
- ❌ No INSERT, UPDATE, DELETE statements
- ❌ No DDL statements (CREATE, ALTER, DROP)
- ❌ No transaction control (COMMIT, ROLLBACK)
- ❌ No GRANT/REVOKE statements
- ✅ SELECT statements only
- ✅ Information schema queries only
- ✅ EXPLAIN queries (read-only)

**Implementation**:
- Parse SQL statements before execution
- Whitelist allowed query types
- Reject any statement that modifies state
- Use PostgreSQL read-only role if possible

---

## 📊 Database Connection

### Environment Variable

The MCP server must read `DATABASE_URL` from environment:

```bash
DATABASE_URL=postgresql://neondb_owner:password@ep-young-shape-af9wgdv0-pooler.c-2.us-west-2.aws.neon.tech/neondb?sslmode=require
```

**Note**: Use read-only database role if available in Neon.

---

## 🧪 Verification Queries

Once the Database MCP is configured, the AI must be able to answer:

### Schema Questions

1. **"What constraints exist on escrow release?"**
   ```sql
   SELECT constraint_name, constraint_type, table_name
   FROM information_schema.table_constraints
   WHERE table_name = 'escrows';
   ```

2. **"What table is the source of truth for XP?"**
   ```sql
   SELECT table_name, column_name
   FROM information_schema.columns
   WHERE column_name LIKE '%xp%' OR table_name LIKE '%xp%';
   ```

3. **"What are all the CHECK constraints on the users table?"**
   ```sql
   SELECT constraint_name, check_clause
   FROM information_schema.check_constraints
   WHERE constraint_schema = 'public';
   ```

4. **"What foreign keys reference the tasks table?"**
   ```sql
   SELECT
     tc.constraint_name,
     kcu.column_name,
     ccu.table_name AS foreign_table_name,
     ccu.column_name AS foreign_column_name
   FROM information_schema.table_constraints AS tc
   JOIN information_schema.key_column_usage AS kcu
     ON tc.constraint_name = kcu.constraint_name
   JOIN information_schema.constraint_column_usage AS ccu
     ON ccu.constraint_name = tc.constraint_name
   WHERE tc.constraint_type = 'FOREIGN KEY'
     AND ccu.table_name = 'tasks';
   ```

### Constraint Questions

5. **"What are the valid values for task.state?"**
   ```sql
   SELECT column_name, data_type, column_default
   FROM information_schema.columns
   WHERE table_name = 'tasks' AND column_name = 'state';
   -- Also check CHECK constraints
   ```

6. **"What invariants are enforced at the database level?"**
   ```sql
   SELECT trigger_name, event_manipulation, event_object_table, action_statement
   FROM information_schema.triggers
   WHERE trigger_schema = 'public';
   ```

### Audit Questions

7. **"What is the current schema version?"**
   ```sql
   SELECT version, applied_at, applied_by
   FROM schema_versions
   ORDER BY applied_at DESC
   LIMIT 1;
   ```

---

## ✅ Done Criteria

The Database MCP is complete when:

- [ ] AI can answer: "What constraints exist on escrow release?"
- [ ] AI can answer: "What table is the source of truth for XP?"
- [ ] AI **refuses** to design logic that violates schema constraints
- [ ] Specs reference **actual table and column names**, not abstractions
- [ ] AI can inspect real tables, constraints, enums via MCP
- [ ] Read-only enforcement is verified (no writes possible)
- [ ] Connection to Neon PostgreSQL works
- [ ] Information schema queries execute successfully

**When these are true, tests are finally worth writing.**

---

## 🚀 Next Steps

1. **Create Custom PostgreSQL MCP Server** (if official doesn't exist)
   - File: `backend/database/mcp-server.ts`
   - Implements MCP protocol
   - Enforces read-only queries
   - Exposes schema inspection tools

2. **Add to MCP Configuration**
   - Update `~/.cursor/mcp.json`
   - Add `database-mcp` entry
   - Configure `DATABASE_URL` environment variable

3. **Test Database MCP**
   - Verify schema inspection works
   - Verify read-only enforcement
   - Verify AI can answer constraint questions

4. **Document Usage**
   - Add examples of database queries
   - Document constraint inspection patterns
   - Create verification checklist

5. **Then**: Configure Test Runner MCP (after DB MCP is working)

---

## 📝 Implementation Notes

### Custom MCP Server Structure

If creating a custom PostgreSQL MCP server:

```typescript
// backend/database/mcp-server.ts
import { neon } from '@neondatabase/serverless';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Read-only SQL whitelist
const READ_ONLY_PATTERNS = [
  /^SELECT/i,
  /^EXPLAIN/i,
  /^SHOW/i,
  /^DESCRIBE/i,
  /information_schema/i,
];

function isReadOnly(query: string): boolean {
  const trimmed = query.trim();
  return READ_ONLY_PATTERNS.some(pattern => pattern.test(trimmed));
}

// MCP server implementation
// ... (full implementation needed)
```

**Status**: Custom implementation needed (official package may not exist)

---

## 🔗 Related Documentation

- `docs/MCP_AUTHORITY_CONTRACT.md` - Authority tiers and enforcement rules
- `backend/database/constitutional-schema.sql` - Schema definition
- `backend/database/verify-schema.ts` - Schema verification script
- `backend/src/db.ts` - Database client (read-write, for application use)

---

**Last Updated**: January 2025  
**Status**: Configuration documented, implementation pending  
**Next**: Create custom PostgreSQL MCP server (if official doesn't exist)
