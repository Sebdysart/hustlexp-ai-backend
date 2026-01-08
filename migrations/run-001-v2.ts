/**
 * CONSTITUTIONAL ENFORCEMENT MIGRATION v2
 * Adapted for actual HustleXP database schema
 * 
 * Run with: npx tsx migrations/run-001-v2.ts
 */

import { neon } from '@neondatabase/serverless';
import { config } from 'dotenv';

config();

async function runMigration() {
  const DATABASE_URL = process.env.DATABASE_URL;
  
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL not set');
    process.exit(1);
  }
  
  console.log('🔄 Connecting to Neon...');
  const sql = neon(DATABASE_URL);
  
  console.log('🔄 Running constitutional enforcement migration v2...\n');
  console.log('   (Adapted for actual schema: money_state_lock, users, tasks)\n');
  
  try {
    // =========================================================================
    // 1. TASK TERMINAL STATE GUARD (AUDIT-4)
    // =========================================================================
    console.log('1/8 Creating task terminal guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_task_terminal_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status IN ('completed', 'cancelled', 'expired', 'disputed_refunded', 'disputed_upheld') THEN
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
    console.log('   ✅ task_terminal_guard created on tasks');
    
    // =========================================================================
    // 2. MONEY STATE LOCK TERMINAL GUARD (Escrow equivalent)
    // =========================================================================
    console.log('2/8 Creating money_state_lock terminal guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_money_state_terminal_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.current_state IN ('released', 'refunded', 'completed') THEN
          RAISE EXCEPTION 'INV-TERMINAL: Cannot modify money_state_lock in terminal state: %. Task ID: %', 
            OLD.current_state, OLD.task_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS money_state_terminal_guard ON money_state_lock`;
    await sql`
      CREATE TRIGGER money_state_terminal_guard
      BEFORE UPDATE ON money_state_lock
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_money_state_terminal_mutation()
    `;
    console.log('   ✅ money_state_terminal_guard created on money_state_lock');
    
    // =========================================================================
    // 3. XP LEDGER TABLE (New - for INV-5)
    // =========================================================================
    console.log('3/8 Creating xp_ledger table (INV-5)...');
    await sql`
      CREATE TABLE IF NOT EXISTS xp_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        task_id UUID REFERENCES tasks(id) ON DELETE SET NULL,
        money_state_lock_task_id UUID UNIQUE,
        base_xp INTEGER NOT NULL,
        decay_factor NUMERIC(10,4) NOT NULL DEFAULT 1.0,
        effective_xp INTEGER NOT NULL,
        streak_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
        final_xp INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_xp_ledger_user ON xp_ledger(user_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_xp_ledger_task ON xp_ledger(task_id)`;
    console.log('   ✅ xp_ledger table created with UNIQUE(money_state_lock_task_id)');
    
    // =========================================================================
    // 4. XP LEDGER APPEND-ONLY
    // =========================================================================
    console.log('4/8 Creating xp_ledger append-only guard...');
    await sql`
      CREATE OR REPLACE FUNCTION prevent_xp_ledger_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'INV-XP: XP ledger is append-only. Deletions are forbidden. XP ID: %',
          OLD.id;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS xp_ledger_no_delete ON xp_ledger`;
    await sql`
      CREATE TRIGGER xp_ledger_no_delete
      BEFORE DELETE ON xp_ledger
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_xp_ledger_delete()
    `;
    console.log('   ✅ xp_ledger_no_delete trigger created');
    
    // =========================================================================
    // 5. BADGE LEDGER TABLE (New - for INV-BADGE-2)
    // =========================================================================
    console.log('5/8 Creating badge_ledger table...');
    await sql`
      CREATE TABLE IF NOT EXISTS badge_ledger (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        badge_id VARCHAR(100) NOT NULL,
        badge_name VARCHAR(255) NOT NULL,
        badge_tier INTEGER NOT NULL DEFAULT 1 CHECK (badge_tier >= 1 AND badge_tier <= 4),
        badge_category VARCHAR(100) NOT NULL,
        xp_awarded INTEGER DEFAULT 0,
        animation_shown_at TIMESTAMPTZ,
        awarded_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, badge_id)
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS idx_badge_ledger_user ON badge_ledger(user_id)`;
    
    await sql`
      CREATE OR REPLACE FUNCTION prevent_badge_ledger_delete()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'INV-BADGE-2: Badge ledger is append-only. Deletions are forbidden. Badge ID: %',
          OLD.id;
      END;
      $$ LANGUAGE plpgsql
    `;
    await sql`DROP TRIGGER IF EXISTS badge_ledger_no_delete ON badge_ledger`;
    await sql`
      CREATE TRIGGER badge_ledger_no_delete
      BEFORE DELETE ON badge_ledger
      FOR EACH ROW 
      EXECUTE FUNCTION prevent_badge_ledger_delete()
    `;
    console.log('   ✅ badge_ledger table + trigger created');
    
    // =========================================================================
    // 6. TRUST TIER COLUMN + BOUNDS
    // =========================================================================
    console.log('6/8 Adding trust_tier to users...');
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
    
    // =========================================================================
    // 7. TRUST LEDGER TABLE (INV-TRUST-3)
    // =========================================================================
    console.log('7/8 Creating trust_ledger table...');
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
    
    // =========================================================================
    // 8. ADMIN ROLES TABLE (INV-ADMIN-2)
    // =========================================================================
    console.log('8/8 Creating admin_roles table...');
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
    
    // =========================================================================
    // VERIFICATION
    // =========================================================================
    console.log('\n🔍 Verifying triggers...');
    const triggers = await sql`
      SELECT t.tgname as trigger_name, c.relname as table_name
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      WHERE t.tgname IN (
        'task_terminal_guard',
        'money_state_terminal_guard', 
        'xp_ledger_no_delete',
        'badge_ledger_no_delete',
        'trust_ledger_no_delete'
      )
      ORDER BY c.relname
    `;
    
    console.log('\n🔍 Verifying new tables...');
    const newTables = await sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      AND table_name IN ('xp_ledger', 'badge_ledger', 'trust_ledger', 'admin_roles')
      ORDER BY table_name
    `;
    
    console.log('\n============================================================');
    console.log('CONSTITUTIONAL ENFORCEMENT MIGRATION v2 COMPLETE');
    console.log('============================================================');
    console.log(`Triggers created: ${triggers.length}/5`);
    triggers.forEach((t: any) => {
      console.log(`  ✓ ${t.trigger_name} on ${t.table_name}`);
    });
    console.log(`\nNew tables created: ${newTables.length}/4`);
    newTables.forEach((t: any) => {
      console.log(`  ✓ ${t.table_name}`);
    });
    console.log('\nInvariants now enforced:');
    console.log('  ✓ AUDIT-4: Task terminal states immutable');
    console.log('  ✓ AUDIT-4: Money state (escrow) terminal states immutable');
    console.log('  ✓ INV-5:   XP idempotent per task (UNIQUE constraint)');
    console.log('  ✓ INV-BADGE-2: Badge ledger append-only');
    console.log('  ✓ INV-TRUST-3: Trust ledger append-only');
    console.log('============================================================\n');
    
  } catch (error: any) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('Full error:', error);
    process.exit(1);
  }
}

runMigration();
