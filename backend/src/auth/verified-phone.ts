import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';
import { normalizePhoneToE164 } from '../lib/phone.js';
import { getFirebaseUserRecord } from './firebase.js';

export class FirebasePhoneCollisionError extends TRPCError {
  readonly applicationCode = 'PHONE_ALREADY_LINKED';
  constructor() {
    super({ code: 'CONFLICT', message: 'This verified phone number is already linked to another HustleXP account.' });
    this.name = 'FirebasePhoneCollisionError';
  }
}

/** Call inside the same transaction as the trusted phone write. The phone must
 * come from Firebase Admin, never from profile/registration request input. */
export async function prepareVerifiedPhoneAssignment(
  query: QueryFn,
  firebaseUid: string,
  verifiedPhone: string,
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`verified-phone:${verifiedPhone}`]);
  const owner = (await query<{
    id: string; firebase_uid: string | null; phone_verified_at: Date | null; email: string | null;
  }>('SELECT id, firebase_uid, phone_verified_at, email FROM users WHERE phone = $1 FOR UPDATE', [verifiedPhone])).rows[0];
  if (!owner || owner.firebase_uid === firebaseUid) return;
  if (owner.phone_verified_at) throw new FirebasePhoneCollisionError();

  // Legacy profile editing allowed unverified contact data in users.phone. Do
  // not grandfather that value as identity, or evict a real verified owner.
  if (owner.firebase_uid) {
    const identity = await getFirebaseUserRecord(owner.firebase_uid);
    if (identity.phoneNumber && normalizePhoneToE164(identity.phoneNumber) === verifiedPhone) {
      throw new FirebasePhoneCollisionError();
    }
  }
  // A legacy phone-only row needs explicit account repair if Firebase cannot
  // prove its identity. Never remove its only contact/identity blindly.
  if (!owner.email) throw new FirebasePhoneCollisionError();
  await query(
    `UPDATE users SET contact_phone = COALESCE(contact_phone, phone),
       phone = NULL, updated_at = NOW()
     WHERE id = $1 AND phone = $2 AND phone_verified_at IS NULL`,
    [owner.id, verifiedPhone],
  );
}
