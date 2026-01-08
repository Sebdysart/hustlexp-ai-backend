/**
 * Migration Runner for Constitutional Enforcement
 * Run with: npx tsx migrations/run-001.ts
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));

async function runMigration() {
  const DATABASE_URL = process.env.DATABASE_URL;
  
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set');
    process.exit(1);
  }
  
  console.log('🔄 Connecting to Neon...');
  const sql = neon(DATABASE_URL);
  
  // Read the migration file
  const migrationPath = join(__dirname, '001_constitutional_enforcement.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  
  // Split into individual statements (careful with $$ blocks)
  // For complex migrations, we'll run key parts individually
  
  console.log('🔄 Running constitutional enforcement migration...\n');
  
  try {
    // 1. Task Terminal Guard
    console.log('1/9 Creating task terminal guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('completed', 'cancelled', 'expired') THEN
          RAISE EXCEPTION 'INV-TERMINAL: Cannot modify task in terminal state: %. Task ID: %', 
            OLD.status, OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS task_terminal_guard ON tasks`;
    await sql`
      CREATE TRIGGER task_terminal_guard
      BEFORE UPDATE ON tasks
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_task_terminal_mutation()
    `;
    console.log('   ✅ task_terminal_guard created');
    
    // 2. Escrow Terminal Guard
    console.log('2/9 Creating escrow terminal guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('released', 'refunded') THEN
          RAISE EXCEPTION 'INV-TERMINAL: Cannot modify escrow in terminal state: %. Escrow ID: %', 
            OLD.status, OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS escrow_terminal_guard ON escrow_holds`;
    await sql`
      CREATE TRIGGER escrow_terminal_guard
      BEFORE UPDATE ON escrow_holds
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_escrow_terminal_mutation()
    `;
    console.log('   ✅ escrow_terminal_guard created');
    
    // 3. Escrow Amount Immutable
    console.log('3/9 Creating escrow amount immutability guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_escrow_amount_change()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.gross_amount_cents IS NOT NULL 
           AND NEW.gross_amount_cents IS DISTINCT FROM OLD.gross_amount_cents THEN
          RAISE EXCEPTION 'INV-4: Escrow amount is immutable. Cannot change from % to %. Escrow ID: %',
            OLD.gross_amount_cents, NEW.gross_amount_cents, OLD.id;
        END IF;
        IF OLD.net_payout_cents IS NOT NULL 
           AND NEW.net_payout_cents IS DISTINCT FROM OLD.net_payout_cents THEN
          RAISE EXCEPTION 'INV-4: Escrow payout amount is immutable. Cannot change from % to %. Escrow ID: %',
            OLD.net_payout_cents, NEW.net_payout_cents, OLD.id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS escrow_amount_immutable ON escrow_holds`;
    await sql`
      CREATE TRIGGER escrow_amount_immutable
      BEFORE UPDATE ON escrow_holds
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_escrow_amount_change()
    `;
    console.log('   ✅ escrow_amount_immutable created');
    
    // 4. XP Ledger Escrow Linkage
    console.log('4/9 Adding escrow_id to xp_events...');
    await sql`ALTER TABLE xp_events ADD COLUMN IF NOT EXISTS escrow_id TEXT`;
    
    // Check if constraint exists
    const constraintCheck = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = 'xp_events_escrow_id_unique'
    `;
    if (constraintCheck.length === 0) {
      await sql`
        ALTER TABLE xp_events 
        ADD CONSTRAINT xp_events_escrow_id_unique 
        UNIQUE (escrow_id)
      `;
      console.log('   ✅ xp_events_escrow_id_unique constraint created');
    } else {
      console.log('   ⏭️  xp_events_escrow_id_unique already exists');
    }
    
    await sql`CREATE INDEX IF NOT EXISTS idx_xp_events_escrow ON xp_events(escrow_id)`;
    console.log('   ✅ escrow_id column + index added');
    
    // 5. Badge Delete Prevention
    console.log('5/9 Creating badge append-only guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_badge_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'INV-BADGE-2: Badge ledger is append-only. Deletions are forbidden. Badge ID: %',
          OLD.id;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS badge_no_delete ON badges`;
    await sql`
      CREATE TRIGGER badge_no_delete
      BEFORE DELETE ON badges
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_badge_delete()
    `;
    console.log('   ✅ badge_no_delete created');
    
    // 6. XP Delete Prevention
    console.log('6/9 Creating XP append-only guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_xp_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'INV-XP: XP ledger is append-only. Deletions are forbidden. XP Event ID: %',
          OLD.id;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS xp_no_delete ON xp_events`;
    await sql`
      CREATE TRIGGER xp_no_delete
      BEFORE DELETE ON xp_events
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_xp_delete()
    `;
    console.log('   ✅ xp_no_delete created');
    
    // 7. Trust Tier Column + Bounds
    console.log('7/9 Adding trust_tier to users...');
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS trust_tier INTEGER DEFAULT 1`;
    
    const tierConstraintCheck = await sql`
      SELECT 1 FROM pg_constraint WHERE conname = 'trust_tier_bounds'
    `;
    if (tierConstraintCheck.length === 0) {
      await sql`
        ALTER TABLE users 
        ADD CONSTRAINT trust_tier_bounds 
        CHECK (trust_tier >= 1 AND trust_tier <= 4)
      `;
      console.log('   ✅ trust_tier_bounds constraint created');
    } else {
      console.log('   ⏭️  trust_tier_bounds already exists');
    }
    
    // 8. Trust Ledger Table
    console.log('8/9 Creating trust_ledger table...');
    await sql`
      CREATE TABLE IF NOT EXISTS trust_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        old_tier INTEGER NOT NULL,
        new_tier INTEGER NOT NULL,
        reason TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_trust_ledger_user ON trust_ledger(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_trust_ledger_created ON trust_ledger(created_at)`;
    
    await sql`
      CREATE OR REPLACE FUNCTION prevent_trust_ledger_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'INV-TRUST-3: Trust ledger is append-only. Deletions are forbidden.';
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS trust_ledger_no_delete ON trust_ledger`;
    await sql`
      CREATE TRIGGER trust_ledger_no_delete
      BEFORE DELETE ON trust_ledger
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_trust_ledger_delete()
    `;
    console.log('   ✅ trust_ledger table + trigger created');
    
    // 9. Admin Roles Table
    console.log('9/9 Creating admin_roles table...');
    await sql`
      CREATE TABLE IF NOT EXISTS admin_roles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(50) NOT NULL CHECK (role IN (
          'founder',
          'lead_engineer',
          'support_lead',
          'support_agent'
        )),
        granted_by UUID REFERENCES users(id),
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_admin_roles_user ON admin_roles(user_id)`;
    console.log('   ✅ admin_roles table created');
    
    // Verification
    console.log('\n🔍 Verifying triggers...');
    const triggers = await sql`
      SELECT t.tgname as trigger_name, c.relname as table_name
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      WHERE t.tgname IN (
        'task_terminal_guard',
        'escrow_terminal_guard', 
        'escrow_amount_immutable',
        'badge_no_delete',
        'xp_no_delete',
        'trust_ledger_no_delete'
      )
      ORDER BY c.relname
    `;
    
    console.log('\n============================================================');
    console.log('CONSTITUTIONAL ENFORCEMENT MIGRATION COMPLETE');
    console.log('============================================================');
    console.log(`Triggers created: ${triggers.length}/6`);
    triggers.forEach((t: any) => {
      console.log(`  ✓ ${t.trigger_name} on ${t.table_name}`);
    });
    console.log('============================================================\n');
    
    if (triggers.length < 6) {
      console.warn('⚠️  Some triggers may not have been created. Check logs above.');
    }
    
  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    if (error.message.includes('does not exist')) {
      console.error('   → Table may not exist. Check your schema.');
    }
    process.exit(1);
  }
}

runMigration();
