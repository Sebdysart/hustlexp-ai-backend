/** Lazy domain-user provisioning for verified Firebase identities. */
import { db } from '../db.js';
import { normalizePhoneToE164 } from '../lib/phone.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';
import { getFirebaseUserRecord } from './firebase.js';

const log = logger.child({ module: 'ensureUserFromFirebase' });
const LAZY_PROVISION_DOB = '1990-01-01';

export class FirebasePhoneCollisionError extends Error {
  readonly applicationCode = 'PHONE_ALREADY_LINKED';
  constructor() {
    super('This verified phone number is already linked to another HustleXP account.');
    this.name = 'FirebasePhoneCollisionError';
  }
}

export async function ensureUserRowForFirebaseUid(firebaseUid: string): Promise<User | null> {
  try {
    const fbUser = await getFirebaseUserRecord(firebaseUid);
    const email = fbUser.email?.trim().toLowerCase() || null;
    const phone = fbUser.phoneNumber ? normalizePhoneToE164(fbUser.phoneNumber) : null;
    if (!email && !phone) {
      log.warn({ firebaseUid }, 'Firebase user has no verified email or phone');
      return null;
    }

    if (phone) {
      const collision = await db.query<{ id: string }>(
        'SELECT id FROM users WHERE phone = $1 AND firebase_uid IS DISTINCT FROM $2 LIMIT 1',
        [phone, firebaseUid],
      );
      if (collision.rows.length) throw new FirebasePhoneCollisionError();
    }

    const displayName = fbUser.displayName?.trim()
      || (email ? email.split('@')[0] : 'HustleXP customer');
    const result = await db.query<User>(
      `INSERT INTO users
         (firebase_uid, email, phone, full_name, default_mode, date_of_birth, is_minor, trust_tier)
       VALUES ($1, $2, $3, $4, $5, $6::date, true, $7)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = COALESCE(users.email, EXCLUDED.email),
         phone = COALESCE(users.phone, EXCLUDED.phone),
         updated_at = NOW()
       RETURNING *`,
      [firebaseUid, email, phone, displayName, phone && !email ? 'poster' : 'worker', LAZY_PROVISION_DOB, phone ? 1 : 0],
    );
    const row = result.rows[0] ?? null;
    if (row) log.info({ userId: row.id, firebaseUid }, 'Lazy-provisioned Firebase user');
    return row;
  } catch (error) {
    if (error instanceof FirebasePhoneCollisionError) throw error;
    log.warn({ err: error, firebaseUid }, 'Lazy user provision failed');
    return null;
  }
}
