#!/usr/bin/env node
/**
 * HustleXP Database MCP Server (Read-Only)
 * 
 * Provides read-only database schema inspection via MCP protocol.
 * Enforces read-only access to prevent any state mutations.
 * 
 * Authority: Tier 0 (Truth & Enforcement)
 * 
 * Usage: tsx backend/database/mcp-server.ts
 * Environment: DATABASE_URL required
 */

import { neon, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

// Enable WebSocket for Neon serverless
neonConfig.webSocketConstructor = ws;

// ============================================================================
// CONFIGURATION
// ============================================================================

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = neon(DATABASE_URL);

// ============================================================================
// MCP SERVER SETUP
// ============================================================================

const server = new McpServer(
  {
    name: 'hustlexp-database-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ============================================================================
// TOOLS (Read-Only Schema Inspection)
// ============================================================================

// Tool 1: Inspect Schema (tables, columns, types, nullability)
server.registerTool('db.inspect_schema', {
  title: 'Inspect Database Schema',
  description: 'Returns all tables with their columns, data types, nullability, and default values. Read-only operation.',
  inputSchema: z.object({
    tableName: z.string().optional().describe('Optional: specific table name to inspect. If not provided, returns all tables.'),
  }),
}, async (args, _extra) => {
  const { tableName } = args;
  try {
    if (tableName) {
      // Get specific table schema
      const columns = await sql`
        SELECT
          column_name,
          data_type,
          is_nullable,
          column_default,
          character_maximum_length,
          numeric_precision,
          numeric_scale
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
        ORDER BY ordinal_position
      `;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              table: tableName,
              columns: columns,
            }, null, 2),
          },
        ],
      };
    } else {
      // Get all tables with their columns
      const tables = await sql`
        SELECT DISTINCT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `;

      const schemas = await Promise.all(
        tables.map(async (t: { table_name: string }) => {
          const columns = await sql`
            SELECT
              column_name,
              data_type,
              is_nullable,
              column_default
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = ${t.table_name}
            ORDER BY ordinal_position
          `;
          return {
            table: t.table_name,
            columns: columns,
          };
        })
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(schemas, null, 2),
          },
        ],
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error inspecting schema: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Tool 2: Inspect Constraints (foreign keys, unique, checks)
server.registerTool('db.inspect_constraints', {
  title: 'Inspect Database Constraints',
  description: 'Returns all constraints (foreign keys, unique, check, primary key) for a table. Read-only operation.',
  inputSchema: z.object({
    tableName: z.string().describe('Name of the table to inspect constraints for'),
  }),
}, async (args, _extra) => {
  const { tableName } = args;
  try {
    // Get all constraints
    const constraints = await sql`
      SELECT
        constraint_name,
        constraint_type,
        table_name
      FROM information_schema.table_constraints
      WHERE table_schema = 'public'
        AND table_name = ${tableName}
    `;

    // Get foreign keys
    const foreignKeys = await sql`
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
        AND tc.table_schema = 'public'
        AND tc.table_name = ${tableName}
    `;

    // Get CHECK constraint details
    const checkConstraints = await sql`
      SELECT
        cc.constraint_name,
        cc.check_clause
      FROM information_schema.check_constraints AS cc
      WHERE cc.constraint_schema = 'public'
        AND EXISTS (
          SELECT 1
          FROM information_schema.table_constraints AS tc
          WHERE tc.constraint_name = cc.constraint_name
            AND tc.table_name = ${tableName}
        )
    `;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            table: tableName,
            constraints: constraints,
            foreignKeys: foreignKeys,
            checkConstraints: checkConstraints,
          }, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error inspecting constraints: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// Tool 3: Inspect Enums
server.registerTool('db.inspect_enums', {
  title: 'Inspect Database Enums',
  description: 'Returns all enum types with their values. Read-only operation.',
  inputSchema: z.object({}),
}, async (_args, _extra) => {
  try {
    const enums = await sql`
      SELECT
        t.typname AS enum_name,
        e.enumlabel AS enum_value
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      ORDER BY t.typname, e.enumsortorder
    `;

    // Group by enum name
    const enumMap: Record<string, string[]> = {};
    for (const row of enums) {
      const enumName = (row as { enum_name: string }).enum_name;
      const enumValue = (row as { enum_value: string }).enum_value;
      if (!enumMap[enumName]) {
        enumMap[enumName] = [];
      }
      enumMap[enumName].push(enumValue);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(enumMap, null, 2),
        },
      ],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text',
          text: `❌ Error inspecting enums: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

// ============================================================================
// SERVER START
// ============================================================================

async function main() {
  try {
    // Create stdio transport
    const transport = new StdioServerTransport();
    
    // Connect server to transport
    await server.connect(transport);
    
    // Log startup to stderr (stdout is used for MCP protocol)
    console.error('✅ HustleXP Database MCP Server (Read-Only) started');
    console.error(`   Connected to database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
    console.error('   Mode: READ-ONLY (no writes allowed)');
    console.error('   Tools registered: db.inspect_schema, db.inspect_constraints, db.inspect_enums');
  } catch (error) {
    console.error('❌ Fatal error starting MCP server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('\n🛑 Shutting down Database MCP Server...');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.error('\n🛑 Shutting down Database MCP Server...');
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Start server
main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
