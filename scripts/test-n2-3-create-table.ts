/**
 * Test: Create one table manually
 */

import { neon } from '@neondatabase/serverless';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ FATAL: DATABASE_URL not set');
  process.exit(1);
}

async function test() {
  const sql = neon(DATABASE_URL);

  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS license_verifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      trade_type TEXT NOT NULL,
      license_number TEXT NOT NULL,
      issuing_state TEXT NOT NULL,
      expiration_date DATE,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
      source TEXT NOT NULL DEFAULT 'USER_SUBMITTED' CHECK (source IN ('USER_SUBMITTED', 'ADMIN_OVERRIDE', 'EXTERNAL_API')),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_by_system BOOLEAN DEFAULT false,
      external_provider_ref TEXT,
      external_validation_at TIMESTAMPTZ,
      attachments TEXT[],
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `;

  try {
    console.log('Testing CREATE TABLE...');
    await sql.unsafe(createTableSQL);
    console.log('✅ CREATE TABLE executed');

    const check = await sql`SELECT table_name FROM information_schema.tables WHERE table_name = 'license_verifications'`;
    console.log('Tables found:', check);
  } catch (err: any) {
    console.error('❌ Failed:', err.message);
    process.exit(1);
  }
}

test();
