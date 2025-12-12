#!/usr/bin/env bun
/**
 * Quick Database Health Check
 *
 * Checks if database is properly set up with all required tables
 * Run: bun run scripts/check-database.ts
 */

import { Pool } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not found in environment variables');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

const REQUIRED_TABLES = [
  'users',
  'tasks',
  'task_assignments',
  'transactions',
  'messages',
  'user_stats',
  'user_boosts',
  'leaderboard_cache',
  'proactive_preferences',
];

async function checkDatabase() {
  try {
    console.log('🔍 Checking database health...\n');

    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);

    const existingTables = result.rows.map((row: any) => row.table_name);

    console.log('📋 Database Tables Status:\n');

    let allPresent = true;
    for (const table of REQUIRED_TABLES) {
      const exists = existingTables.includes(table);
      const icon = exists ? '✅' : '❌';
      console.log(`${icon} ${table}`);
      if (!exists) allPresent = false;
    }

    console.log('\n');

    if (allPresent) {
      console.log('✅ All required tables exist!');

      const userCount = await pool.query('SELECT COUNT(*) as count FROM users');
      const taskCount = await pool.query('SELECT COUNT(*) as count FROM tasks');

      console.log('\n📊 Database Statistics:');
      console.log(`  👤 Users: ${userCount.rows[0].count}`);
      console.log(`  📋 Tasks: ${taskCount.rows[0].count}`);
    } else {
      console.log('❌ Some tables are missing!');
      console.log('\n🔧 To fix this, run:');
      console.log('   bun run db:setup');
    }

    process.exit(allPresent ? 0 : 1);
  } catch (error) {
    console.error('❌ Database check failed:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    console.log('\n🔧 To set up the database, run:');
    console.log('   bun run db:setup');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

checkDatabase();
