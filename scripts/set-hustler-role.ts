/**
 * Set test user role to hustler for Gate-1 verification
 *
 * Usage: npx tsx scripts/set-hustler-role.ts
 */

import 'dotenv/config';
import { db, hasDb } from '../backend/src/db.js';

if (!hasDb || !db) {
  console.error('Database not available (set DATABASE_URL)');
  process.exit(1);
}

const TEST_HUSTLER_UID = 'test-hustler-001';

async function setHustlerRole() {
  console.log('Connecting to database...');

  try {
    const existing = await db.query<{ id: string; firebase_uid: string; email: string; default_mode: string }>(
      'SELECT id, firebase_uid, email, default_mode FROM users WHERE firebase_uid = $1',
      [TEST_HUSTLER_UID]
    );

    if (existing.rows.length > 0) {
      console.log('User found:', existing.rows[0]);
      if (existing.rows[0].default_mode === 'worker') {
        console.log('User already has worker (hustler) mode!');
      } else {
        await db.query(
          "UPDATE users SET default_mode = 'worker', updated_at = NOW() WHERE firebase_uid = $1",
          [TEST_HUSTLER_UID]
        );
        console.log('Default mode updated to worker (hustler)!');
      }
    } else {
      console.log('User not found, creating...');
      await db.query(
        `INSERT INTO users (firebase_uid, email, full_name, default_mode)
         VALUES ($1, $2, $3, 'worker')
         ON CONFLICT (firebase_uid) DO UPDATE SET default_mode = 'worker'`,
        [TEST_HUSTLER_UID, 'hustler_test@hustlexp.com', 'Test Hustler']
      );
      console.log('User created/updated.');
    }

    const verify = await db.query(
      'SELECT id, firebase_uid, email, default_mode FROM users WHERE firebase_uid = $1',
      [TEST_HUSTLER_UID]
    );
    console.log('');
    console.log('=== VERIFICATION ===');
    console.log('User:', verify.rows[0]);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await db.getPool().end();
  }
}

setHustlerRole();
