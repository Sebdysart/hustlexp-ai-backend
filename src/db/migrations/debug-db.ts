#!/usr/bin/env npx tsx
import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

const sql = neon(process.env.DATABASE_URL!);

async function main() {
    // Check ALL tables
    const allTables = await sql`
        SELECT table_schema, table_name 
        FROM information_schema.tables 
        WHERE table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
    `;

    console.log('ALL TABLES IN DATABASE:');
    allTables.forEach((t: any) => console.log(`  ${t.table_schema}.${t.table_name}`));

    // Try direct query on ledger_accounts
    console.log('\n--- Direct query on ledger_accounts ---');
    try {
        const count = await sql`SELECT COUNT(*) as cnt FROM ledger_accounts`;
        console.log('ledger_accounts exists, row count:', count[0]?.cnt);
    } catch (err: any) {
        console.log('ledger_accounts query failed:', err.message);
    }

    // Check database name
    const dbInfo = await sql`SELECT current_database(), current_schema()`;
    console.log('\nConnected to:', dbInfo);
}

main();
