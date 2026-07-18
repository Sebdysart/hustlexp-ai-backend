import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

interface LinkInput {
  engineHustlerRef: string;
  phoneE164: string;
  providerClaimId: string;
}

interface LinkResult {
  engineHustlerRef: string;
  trustTier: number;
  idempotencyReplayed: boolean;
}

interface UserRow {
  id: string;
  default_mode: string;
  phone: string | null;
  trust_tier: number;
  is_banned: boolean;
  is_minor: boolean;
  account_status: string;
}

function phoneHash(phone: string): string {
  return createHash('sha256').update(phone).digest('hex');
}

export const HustlerIdentityLinkService = {
  async link(input: LinkInput): Promise<ServiceResult<LinkResult>> {
    try {
      return await db.serializableTransaction(async (query) => {
        const userResult = await query<UserRow>(
          `SELECT id, default_mode, phone, trust_tier, is_banned, is_minor, account_status
             FROM users WHERE id = $1 FOR UPDATE`,
          [input.engineHustlerRef],
        );
        const user = userResult.rows[0];
        if (!user) return { success: false, error: { code: 'NOT_FOUND', message: 'Hustler identity not found' } };
        if (user.default_mode !== 'worker' || user.is_banned || user.is_minor || user.account_status !== 'ACTIVE') {
          return { success: false, error: { code: 'PRECONDITION_FAILED', message: 'Hustler identity is not eligible for linking' } };
        }

        const hash = phoneHash(input.phoneE164);
        const replay = await query<{ user_id: string; phone_hash: string }>(
          `SELECT user_id, phone_hash FROM engine_hustler_identity_links
            WHERE provider_claim_id = $1 FOR UPDATE`,
          [input.providerClaimId],
        );
        if (replay.rows[0]) {
          const matches = replay.rows[0].user_id === input.engineHustlerRef
            && replay.rows[0].phone_hash === hash;
          return matches
            ? { success: true, data: {
                engineHustlerRef: user.id,
                trustTier: Math.max(user.trust_tier, 1),
                idempotencyReplayed: true,
              } }
            : { success: false, error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Identity claim conflicts with prior evidence' } };
        }

        const collision = await query<{ id: string }>(
          `SELECT id FROM users WHERE phone = $1 AND id <> $2 LIMIT 1 FOR UPDATE`,
          [input.phoneE164, input.engineHustlerRef],
        );
        if (collision.rows.length > 0) {
          return { success: false, error: { code: 'IDENTITY_CONFLICT', message: 'Phone already belongs to another engine identity' } };
        }

        const linkedPhone = await query<{ user_id: string }>(
          `SELECT user_id FROM engine_hustler_identity_links
            WHERE phone_hash = $1 AND user_id <> $2 LIMIT 1 FOR UPDATE`,
          [hash, input.engineHustlerRef],
        );
        if (linkedPhone.rows.length > 0) {
          return { success: false, error: { code: 'IDENTITY_CONFLICT', message: 'Roster identity is already linked' } };
        }

        const trustTier = Math.max(user.trust_tier, 1);
        await query(
          `UPDATE users SET phone = $1, trust_tier = $2, updated_at = NOW() WHERE id = $3`,
          [input.phoneE164, trustTier, input.engineHustlerRef],
        );
        await query(
          `INSERT INTO engine_hustler_identity_links(provider_claim_id,user_id,phone_hash)
           VALUES($1,$2,$3)`,
          [input.providerClaimId, input.engineHustlerRef, hash],
        );
        return { success: true, data: {
          engineHustlerRef: input.engineHustlerRef,
          trustTier,
          idempotencyReplayed: false,
        } };
      });
    } catch {
      return { success: false, error: { code: 'DB_ERROR', message: 'Identity link could not be persisted' } };
    }
  },
};
