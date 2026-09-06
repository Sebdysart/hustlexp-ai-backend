import { z } from 'zod';
import { db, type Database } from '../db.js';
import {
  UniversalV1ActorAttestationResponseSchema,
  type UniversalV1ActorAttestationHandle,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import { FinancialProgressUuidSchema as uuid } from '../auth/financial-progress-command-contract.js';
import {
  WorkOrderHistoryPayloadSchema,
  WorkOrderHistorySchema,
  workOrderHistoryMatchesPayload,
  freezeWorkOrderHistory,
  type WorkOrderHistory,
  type WorkOrderHistoryPayload,
} from '../auth/work-order-history-command-contract.js';
import { authorizedUniversalV1FinancialApiRelease } from './payment/UniversalV1FinancialRequestService.js';
import type { FinancialProviderCommandReleaseEvidence } from './payment/FinancialProviderCommandJournal.js';
import { deterministicUuid } from './UniversalV1WorkOrderPostgresRepository.js';

const digest = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .refine((value) => value !== '0'.repeat(64));
const receiptSchema = z
  .object({
    history: WorkOrderHistorySchema.nullable(),
    actor_user_id: uuid,
    actor_assertion_id: uuid,
    actor_request_sha256: digest,
    target_authority_id: uuid,
    reader_release_sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
function refuse(reason: string): never {
  throw new Error('WORK_ORDER_HISTORY_' + reason);
}

export interface UniversalV1WorkOrderHistoryReader {
  read(
    payload: WorkOrderHistoryPayload,
    actor: string,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<Readonly<WorkOrderHistory> | null>;
}

export class PostgresUniversalV1WorkOrderHistoryReader implements UniversalV1WorkOrderHistoryReader {
  constructor(
    private readonly database: Database = db,
    private readonly authorize: () => FinancialProviderCommandReleaseEvidence = authorizedUniversalV1FinancialApiRelease
  ) {}

  async read(
    raw: WorkOrderHistoryPayload,
    actor: string,
    attestation: UniversalV1ActorAttestationHandle
  ): Promise<Readonly<WorkOrderHistory> | null> {
    try {
      const payload = Object.freeze(WorkOrderHistoryPayloadSchema.parse(raw));
      const expectedActor = uuid.parse(actor);
      const release = Object.freeze({ ...this.authorize() });
      const expectedRelease = JSON.stringify(release);
      const parsed = UniversalV1ActorAttestationResponseSchema.safeParse(
        await attestation.issue({
          commandKind: 'READ_FAKE_WORK_ORDER_HISTORY',
          commandPayload: payload,
        })
      );
      if (
        !parsed.success ||
        parsed.data.command_kind !== 'READ_FAKE_WORK_ORDER_HISTORY' ||
        !digest.safeParse(parsed.data.actor_assertion_token).success ||
        !digest.safeParse(parsed.data.canonical_request_sha256).success ||
        Date.parse(parsed.data.assertion_expires_at) <= Date.now()
      )
        return refuse('ASSERTION_INVALID');
      const assertion = Object.freeze(parsed.data);
      const history = await this.database.transaction(async (query) => {
        const rows = await query(
          'SELECT * FROM public.hxos_read_authenticated_work_order_history_v13($1,$2)',
          [assertion.actor_assertion_token, payload]
        );
        if (rows.rowCount !== 1 || rows.rows.length !== 1) return refuse('RECEIPT_INVALID');
        const receipt = receiptSchema.safeParse(rows.rows[0]);
        if (
          !receipt.success ||
          receipt.data.actor_user_id !== expectedActor ||
          receipt.data.actor_request_sha256 !== assertion.canonical_request_sha256 ||
          receipt.data.reader_release_sha256 !== release.manifestDigest ||
          (receipt.data.history !== null &&
            !workOrderHistoryMatchesPayload(receipt.data.history, payload, expectedActor))
        )
          return refuse('RECEIPT_BINDING_MISMATCH');
        const found = receipt.data.history;
        if (found?.state === 'COMPENSATION_CLAIM') {
          const claim = found.compensation;
          if (
            claim.secured_operation_id !== deterministicUuid(payload.idempotency_key, 'secure') ||
            claim.void_operation_id !== deterministicUuid(payload.idempotency_key, 'void') ||
            claim.void_idempotency_key !== payload.idempotency_key + ':void'
          )
            return refuse('RECEIPT_BINDING_MISMATCH');
        }
        return found === null ? null : freezeWorkOrderHistory(found);
      });
      if (JSON.stringify(this.authorize()) !== expectedRelease)
        return refuse('RELEASE_AUTHORITY_CHANGED');
      return history;
    } catch (error) {
      if (
        error instanceof Error &&
        /^WORK_ORDER_HISTORY_(ASSERTION_INVALID|RECEIPT_INVALID|RECEIPT_BINDING_MISMATCH|RELEASE_AUTHORITY_CHANGED)$/u.test(
          error.message
        )
      )
        throw error;
      return refuse('UNAVAILABLE');
    }
  }
}
