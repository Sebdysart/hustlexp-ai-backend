/**
 * Lazy DB user provisioning when Firebase Auth has a valid user but the
 * `users` row is missing (e.g. legacy accounts, Firebase-only users).
 * Mirrors `user.register` INSERT shape so `user.me` + protectedProcedure work after sign-in.
 */

import { db } from '../db.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';
import { getFirebaseUserRecord } from './firebase.js';

const log = logger.child({ module: 'ensureUserFromFirebase' });

/** Placeholder DOB for COPPA column when we only have Firebase identity (user should complete onboarding). */
const LAZY_PROVISION_DOB = '1990-01-01';

/**
 * Insert (or return existing) users row for a Firebase UID.
 * Returns null if Firebase has no email, insert fails (e.g. email owned by another UID), or on error.
 */
export async function ensureUserRowForFirebaseUid(firebaseUid: string): Promise<User | null> {
  try {
    const fbUser = await getFirebaseUserRecord(firebaseUid);
    const email = fbUser.email;
    if (!email) {
      log.warn({ firebaseUid }, 'Firebase user has no email — cannot provision DB row');
      return null;
    }

    const displayName = fbUser.displayName?.trim() || email.split('@')[0] || 'User';
    // Match user.register: phone-less → trust_tier 0 (UNVERIFIED)
    const initialTrustTier = 0;

    const result = await db.query<User>(
      `INSERT INTO users (firebase_uid, email, full_name, default_mode, date_of_birth, is_minor, trust_tier)
       VALUES ($1, $2, $3, 'worker', $4::date, false, $5)
       ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, updated_at = NOW()
       RETURNING *`,
      [firebaseUid, email, displayName, LAZY_PROVISION_DOB, initialTrustTier]
    );

    const row = result.rows[0] ?? null;
    if (row) {
      log.info({ userId: row.id, firebaseUid }, 'Lazy-provisioned users row for Firebase sign-in');
    }
    return row;
  } catch (err) {
    log.warn({ err, firebaseUid }, 'Lazy user provision failed (email conflict or schema mismatch)');
    return null;
  }
}
