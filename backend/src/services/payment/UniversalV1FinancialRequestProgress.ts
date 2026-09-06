import { z } from 'zod';
import { db, type Database } from '../../db.js';
import {
  UniversalV1ActorAttestationResponseSchema,
  type UniversalV1ActorAttestationHandle,
} from '../../auth/universal-v1-actor-attestation-contracts.js';
import {
  FakeFinancialProgressPayloadSchema,
  FinancialProgressUuidSchema,
  PublicFinancialRequestProgressSchema,
  type PublicFinancialRequestProgress,
} from '../../auth/financial-progress-command-contract.js';
import type { FinancialProviderCommandReleaseEvidence } from './FinancialProviderCommandJournal.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const responseSchema = z
  .object({
    progress: PublicFinancialRequestProgressSchema.nullable(),
    actor_user_id: FinancialProgressUuidSchema,
    actor_assertion_id: FinancialProgressUuidSchema,
    actor_request_sha256: digest,
    target_authority_id: FinancialProgressUuidSchema,
    reader_release_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

function refuse(reason: string): never {
  throw new Error('UNIVERSAL_FINANCE_PROGRESS_' + reason);
}
export interface UniversalV1FinancialRequestProgressReader {
  read(
    commandId: string,
    actorId: string,
    attestation: UniversalV1ActorAttestationHandle,
    release: FinancialProviderCommandReleaseEvidence
  ): Promise<Readonly<PublicFinancialRequestProgress> | null>;
}

/** The actor argument is only a server expectation. The sealed port independently
 * resolves the fresh one-use assertion and checks current customer ownership. */
export class PostgresUniversalV1FinancialRequestProgressReader implements UniversalV1FinancialRequestProgressReader {
  constructor(private readonly database: Database = db) {}
  async read(
    commandId: string,
    actorId: string,
    attestation: UniversalV1ActorAttestationHandle,
    release: FinancialProviderCommandReleaseEvidence
  ): Promise<Readonly<PublicFinancialRequestProgress> | null> {
    try {
      const payload = Object.freeze(FakeFinancialProgressPayloadSchema.parse({ commandId }));
      const expectedActor = FinancialProgressUuidSchema.parse(actorId);
      const expectedRelease = release.manifestDigest;
      const parsed = UniversalV1ActorAttestationResponseSchema.safeParse(
        await attestation.issue({
          commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
          commandPayload: payload,
        })
      );
      if (
        !parsed.success ||
        parsed.data.command_kind !== 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS' ||
        !digest.safeParse(parsed.data.actor_assertion_token).success ||
        !digest.safeParse(parsed.data.canonical_request_sha256).success ||
        Date.parse(parsed.data.assertion_expires_at) <= Date.now()
      )
        return refuse('ASSERTION_INVALID');
      const assertion = Object.freeze(parsed.data);
      return await this.database.transaction(async (query) => {
        const result = await query(
          'SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)',
          [assertion.actor_assertion_token, payload]
        );
        if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('RECEIPT_INVALID');
        const receipt = responseSchema.safeParse(result.rows[0]);
        if (
          !receipt.success ||
          receipt.data.actor_user_id !== expectedActor ||
          receipt.data.actor_request_sha256 !== assertion.canonical_request_sha256 ||
          receipt.data.reader_release_sha256 !== expectedRelease ||
          (receipt.data.progress !== null && receipt.data.progress.commandId !== commandId)
        )
          return refuse('RECEIPT_BINDING_MISMATCH');
        const progress = receipt.data.progress;
        if (progress?.financialEvent) Object.freeze(progress.financialEvent);
        return progress === null ? null : Object.freeze(progress);
      });
    } catch (error) {
      // Database/assertion errors may contain private bindings or provider data.
      if (
        error instanceof Error &&
        /^UNIVERSAL_FINANCE_PROGRESS_(ASSERTION_INVALID|RECEIPT_INVALID|RECEIPT_BINDING_MISMATCH)$/u.test(
          error.message
        )
      )
        throw error;
      return refuse('UNAVAILABLE');
    }
  }
}
