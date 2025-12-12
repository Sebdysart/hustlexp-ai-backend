#!/usr/bin/env bun
/**
 * Database Setup Script
 * 
 * This script creates all necessary database tables by executing schema.sql
 * Run this once after setting up your database connection
 * 
 * Usage: bun run scripts/setup-database.ts
 */

import { Pool } from '@neondatabase/serverless';
import { readFileSync } from 'fs';
import { join } from 'path';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL not found in environment variables');
  console.error('Please set DATABASE_URL in env.backend file');
  process.exit(1);
}

console.log('🔧 Setting up database...');
console.log('📍 Database:', DATABASE_URL.split('@')[1]?.split('/')[0] || 'unknown');

const pool = new Pool({ connectionString: DATABASE_URL });

async function setupDatabase() {
  try {
    const schemaPath = join(process.cwd(), 'backend/database/schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    console.log('📄 Executing schema.sql...');
    
    await pool.query(schema);

    console.log('✅ Database schema created successfully!');
    console.log('\n📋 Created tables:');
    console.log('  - users');
    console.log('  - tasks');
    console.log('  - task_assignments');
    console.log('  - transactions');
    console.log('  - messages');
    console.log('  - user_stats');
    console.log('  - user_boosts');
    console.log('  - leaderboard_cache');
    console.log('  - proactive_preferences');

    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);

    console.log('\n✅ Verified tables in database:');
    result.rows.forEach((row: any) => {
      console.log(`  ✓ ${row.table_name}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to setup database:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
    }
    process.exit(1);
  } finally {
    await pool.end();
  }
}

setupDatabase();
