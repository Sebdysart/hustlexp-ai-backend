/** Lazy domain-user provisioning for verified Firebase identities. */
import { db } from '../db.js';
import { normalizePhoneToE164 } from '../lib/phone.js';
import { logger } from '../logger.js';
import type { User } from '../types.js';
import { getFirebaseUserRecord } from './firebase.js';
import { FirebasePhoneCollisionError, prepareVerifiedPhoneAssignment } from './verified-phone.js';

const log = logger.child({ module: 'ensureUserFromFirebase' });
const LAZY_PROVISION_DOB = '1990-01-01';

export { FirebasePhoneCollisionError } from './verified-phone.js';

export async function ensureUserRowForFirebaseUid(firebaseUid: string): Promise<User | null> {
  try {
    const fbUser = await getFirebaseUserRecord(firebaseUid);
    const email = fbUser.email?.trim().toLowerCase() || null;
    const phone = fbUser.phoneNumber ? normalizePhoneToE164(fbUser.phoneNumber) : null;
    if (!email && !phone) {
      log.warn({ firebaseUid }, 'Firebase user has no verified email or phone');
      return null;
    }

    const displayName = fbUser.displayName?.trim()
      || (email ? email.split('@')[0] : 'HustleXP customer');
    const result = await db.transaction(async (query) => {
      if (phone) await prepareVerifiedPhoneAssignment(query, firebaseUid, phone);
      return query<User>(
      `INSERT INTO users
         (firebase_uid, email, phone, full_name, default_mode, date_of_birth, is_minor, trust_tier, phone_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6::date, true, $7, CASE WHEN $3 IS NOT NULL THEN NOW() END)
       ON CONFLICT (firebase_uid) DO UPDATE SET
         email = COALESCE(users.email, EXCLUDED.email),
         contact_phone = CASE WHEN users.phone_verified_at IS NULL AND users.phone IS DISTINCT FROM EXCLUDED.phone THEN COALESCE(users.contact_phone, users.phone) ELSE users.contact_phone END,
         phone = COALESCE(EXCLUDED.phone, users.phone),
         phone_verified_at = CASE WHEN EXCLUDED.phone IS NOT NULL THEN NOW() ELSE users.phone_verified_at END,
         updated_at = NOW()
       RETURNING *`,
      [firebaseUid, email, phone, displayName, phone && !email ? 'poster' : 'worker', LAZY_PROVISION_DOB, phone ? 1 : 0],
    );
    });
    const row = result.rows[0] ?? null;
    if (row) log.info({ userId: row.id, firebaseUid }, 'Lazy-provisioned Firebase user');
    return row;
  } catch (error) {
    if (error instanceof FirebasePhoneCollisionError) throw error;
    log.warn({ err: error, firebaseUid }, 'Lazy user provision failed');
    return null;
  }
}
