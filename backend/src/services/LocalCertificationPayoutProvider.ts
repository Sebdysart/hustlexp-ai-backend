import { createHash, createHmac } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import { computeFeeBreakdown } from '../lib/money.js';
import { config } from '../config.js';
import type { ServiceResult } from '../types.js';

const DESTINATION_RE = /^pd_hxos_test_[a-f0-9]{32}$/;
const TRANSFER_RE = /^tr_hxos_test_[a-f0-9]{32}$/;

const BUSINESS_DESTINATION_RE = /^pd_hxos_business_test_[a-f0-9]{32}$/;
const BUSINESS_TRANSFER_RE = /^tr_hxos_business_test_[a-f0-9]{32}$/;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface DestinationRow {
  id: string;
  worker_id: string;
  status: 'ACTIVE';
  is_test: boolean;
}

interface TransferRow {
  id: string;
  task_id: string;
  escrow_id: string;
  worker_id: string;
  destination_id: string;
  amount_cents: number;
  status: 'submitted' | 'processing' | 'paid';
  idempotency_key: string;
  request_hash: string;
  is_test: boolean;
  paid_at: Date | string | null;
}

interface TransferContextRow {
  task_id: string;
  task_state: string;
  payout_ready_at: Date | string | null;
  automation_classification: string | null;
  worker_id: string | null;
  hustler_payout_cents: number | null;
  platform_margin_cents: number | null;
  escrow_id: string;
  escrow_state: string;
  amount: number;
  platform_fee_cents: number | null;
  destination_id: string | null;
  destination_status: string | null;
}

export interface CreateLocalTestTransferParams {
  taskId: string;
  escrowId: string;
  workerId: string;
  idempotencyKey: string;
}

export interface CreateLocalTestBusinessTransferParams {
  taskId: string;
  escrowId: string;
  organizationId: string;
  payoutRecipientUserId: string;
  idempotencyKey: string;
}

interface BusinessDestinationRow {
  id: string;
  organization_id: string;
  payout_recipient_user_id: string;
  status: 'ACTIVE';
  is_test: boolean;
}

interface BusinessTransferRow {
  id: string;
  task_id: string;
  escrow_id: string;
  organization_id: string;
  payout_recipient_user_id: string;
  destination_id: string;
  amount_cents: number;
  status: 'submitted' | 'processing' | 'paid';
  idempotency_key: string;
  request_hash: string;
  is_test: boolean;
  paid_at: Date | string | null;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment = process.env): string {
  return env.HXOS_LOCAL_TEST_PAYOUT_SECRET?.trim() ?? '';
}

function hmac(value: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(value).digest('hex');
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function destinationIdentity(workerId: string): { id: string; fingerprint: string } {
  return {
    id: `pd_hxos_test_${hmac(`destination:${workerId}`).slice(0, 32)}`,
    fingerprint: hmac(`destination-fingerprint:${workerId}`),
  };
}

function transferIdentity(escrowId: string): string {
  return `tr_hxos_test_${hmac(`transfer:${escrowId}`).slice(0, 32)}`;
}

function requestHash(params: CreateLocalTestTransferParams): string {
  return digest(JSON.stringify({
    taskId: params.taskId,
    escrowId: params.escrowId,
    workerId: params.workerId,
  }));
}

function businessDestinationIdentity(
  organizationId: string,
  payoutRecipientUserId: string,
): { id: string; fingerprint: string } {
  return {
    id: `pd_hxos_business_test_${hmac(
      `business-destination:${organizationId}:${payoutRecipientUserId}`,
    ).slice(0, 32)}`,
    fingerprint: hmac(
      `business-destination-fingerprint:${organizationId}:${payoutRecipientUserId}`,
    ),
  };
}

function businessTransferIdentity(escrowId: string): string {
  return `tr_hxos_business_test_${hmac(`business-transfer:${escrowId}`).slice(0, 32)}`;
}

function businessRequestHash(
  params: CreateLocalTestBusinessTransferParams,
): string {
  return digest(JSON.stringify({
    taskId: params.taskId,
    escrowId: params.escrowId,
    organizationId: params.organizationId,
    payoutRecipientUserId: params.payoutRecipientUserId,
  }));
}

export function localCertificationPayoutEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_PAYOUT === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

export function isLocalCertificationPayoutDestinationId(value: string): boolean {
  return DESTINATION_RE.test(value);
}

export function isLocalCertificationPayoutTransferId(value: string): boolean {
  return TRANSFER_RE.test(value);
}

export async function hasActiveLocalTestPayoutDestination(
  query: QueryFn,
  workerId: string,
): Promise<boolean> {
  const result = await query<{ ready: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM hxos_local_test_payout_destinations
       WHERE worker_id = $1 AND status = 'ACTIVE' AND is_test IS TRUE
     ) AS ready`,
    [workerId],
  );
  return result.rows[0]?.ready === true;
}

async function loadTransferContext(
  query: QueryFn,
  params: CreateLocalTestTransferParams,
): Promise<TransferContextRow | null> {
  const result = await query<TransferContextRow>(
    `SELECT t.id AS task_id, t.state AS task_state, t.payout_ready_at,
            t.automation_classification, t.worker_id, t.hustler_payout_cents,
            t.platform_margin_cents, e.id AS escrow_id, e.state AS escrow_state,
            e.amount, e.platform_fee_cents, d.id AS destination_id,
            d.status AS destination_status
     FROM tasks t
     JOIN escrows e ON e.task_id = t.id
     LEFT JOIN hxos_local_test_payout_destinations d
       ON d.worker_id = t.worker_id AND d.status = 'ACTIVE' AND d.is_test IS TRUE
     WHERE t.id = $1 AND e.id = $2
     FOR UPDATE OF t, e`,
    [params.taskId, params.escrowId],
  );
  return result.rows[0] ?? null;
}

function expectedTransferAmount(context: TransferContextRow): number | null {
  if (context.platform_fee_cents == null || context.hustler_payout_cents == null) return null;
  const breakdown = computeFeeBreakdown(
    context.amount,
    config.stripe.platformFeePercent,
    context.platform_fee_cents,
  );
  return breakdown.netPayoutCents;
}

function validateTransferContext(
  context: TransferContextRow | null,
  params: CreateLocalTestTransferParams,
): ServiceResult<{ destinationId: string; amountCents: number }> {
  if (!context) return failure('LOCAL_TEST_PAYOUT_NOT_FOUND', 'Local certification payout context was not found.');
  if (context.platform_margin_cents == null || context.hustler_payout_cents == null) {
    return failure(
      'LOCAL_TEST_PAYOUT_PRECONDITION_FAILED',
      'Local certification payout requires immutable quote economics.',
    );
  }
  const amountCents = expectedTransferAmount(context);
  if (
    context.task_state !== 'COMPLETED'
    || !context.payout_ready_at
    || context.automation_classification !== 'CONTROLLED_TEST'
    || context.worker_id !== params.workerId
    || context.escrow_state !== 'FUNDED'
    || context.amount <= 0
    || context.platform_margin_cents !== context.platform_fee_cents
    || context.hustler_payout_cents !== context.amount - context.platform_margin_cents
    || !context.destination_id
    || context.destination_status !== 'ACTIVE'
    || amountCents == null
    || amountCents <= 0
  ) {
    return failure(
      'LOCAL_TEST_PAYOUT_PRECONDITION_FAILED',
      'Local certification payout requires exact completed CONTROLLED_TEST economics and an active TEST destination.',
    );
  }
  return { success: true, data: { destinationId: context.destination_id, amountCents } };
}

async function replayTransfer(
  query: QueryFn,
  params: CreateLocalTestTransferParams,
  hash: string,
): Promise<ServiceResult<TransferRow> | null> {
  const existing = await query<TransferRow>(
    `SELECT id, task_id, escrow_id, worker_id, destination_id, amount_cents,
            status, idempotency_key, request_hash, is_test, paid_at
     FROM hxos_local_test_payout_transfers
     WHERE idempotency_key = $1 OR escrow_id = $2
     ORDER BY CASE WHEN idempotency_key = $1 THEN 0 ELSE 1 END
     LIMIT 1
     FOR UPDATE`,
    [params.idempotencyKey, params.escrowId],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (
    row.request_hash !== hash
    || row.task_id !== params.taskId
    || row.escrow_id !== params.escrowId
    || row.worker_id !== params.workerId
    || row.is_test !== true
  ) {
    return failure('LOCAL_TEST_PAYOUT_IDEMPOTENCY_CONFLICT', 'Local certification payout idempotency conflict.');
  }
  if (row.status !== 'paid' || !row.paid_at) {
    return failure('LOCAL_TEST_PAYOUT_INCOMPLETE', 'Local certification payout did not reach its paid TEST state.');
  }
  return { success: true, data: row };
}

export const LocalCertificationPayoutProvider = {
  activateDestination: async (
    workerId: string,
    actorId: string,
  ): Promise<ServiceResult<{
    destinationId: string;
    provider: 'LOCAL_CERTIFICATION_TEST';
    status: 'ACTIVE';
    isTest: true;
    idempotencyReplayed: boolean;
  }>> => {
    if (!localCertificationPayoutEnabled()) {
      return failure('LOCAL_TEST_PAYOUT_DISABLED', 'Local certification payouts are disabled.');
    }
    const identity = destinationIdentity(workerId);
    try {
      return await db.transaction(async (query) => {
        const inserted = await query<{ id: string }>(
          `INSERT INTO hxos_local_test_payout_destinations
             (id, worker_id, destination_fingerprint)
           VALUES ($1, $2, $3)
           ON CONFLICT (worker_id) DO NOTHING
           RETURNING id`,
          [identity.id, workerId, identity.fingerprint],
        );
        const selected = await query<DestinationRow>(
          `SELECT id, worker_id, status, is_test
           FROM hxos_local_test_payout_destinations
           WHERE worker_id = $1
           FOR UPDATE`,
          [workerId],
        );
        const destination = selected.rows[0];
        if (
          !destination
          || destination.id !== identity.id
          || destination.worker_id !== workerId
          || destination.status !== 'ACTIVE'
          || destination.is_test !== true
        ) {
          return failure('LOCAL_TEST_PAYOUT_DESTINATION_CONFLICT', 'Local certification payout destination conflicts with existing evidence.');
        }
        await query(
          `INSERT INTO hxos_local_test_payout_destination_events
             (destination_id, worker_id, event_type, actor_id, idempotency_key, metadata)
           VALUES ($1, $2, 'destination_activated', $3, $4, $5::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            destination.id,
            workerId,
            actorId,
            `local-test-payout-destination:${workerId}`,
            JSON.stringify({ provider: 'LOCAL_CERTIFICATION_TEST', is_test: true }),
          ],
        );
        return {
          success: true,
          data: {
            destinationId: destination.id,
            provider: 'LOCAL_CERTIFICATION_TEST' as const,
            status: 'ACTIVE' as const,
            isTest: true as const,
            idempotencyReplayed: (inserted.rowCount ?? 0) === 0,
          },
        };
      });
    } catch {
      return failure('LOCAL_TEST_PAYOUT_DESTINATION_FAILED', 'Local certification payout destination could not be activated.');
    }
  },

  activateBusinessDestination: async (
    organizationId: string,
    payoutRecipientUserId: string,
    actorId: string,
  ): Promise<ServiceResult<{
    destinationId: string;
    provider: 'LOCAL_CERTIFICATION_TEST';
    status: 'ACTIVE';
    isTest: true;
    idempotencyReplayed: boolean;
  }>> => {
    if (!localCertificationPayoutEnabled()) {
      return failure(
        'LOCAL_TEST_PAYOUT_DISABLED',
        'Local certification payouts are disabled.',
      );
    }

    const identity = businessDestinationIdentity(
      organizationId,
      payoutRecipientUserId,
    );

    try {
      return await db.transaction(async (query) => {
        const inserted = await query<{ id: string }>(
          `INSERT INTO hxos_local_test_business_payout_destinations
            (id, organization_id, payout_recipient_user_id, destination_fingerprint)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (organization_id) DO NOTHING
          RETURNING id`,
          [
            identity.id,
            organizationId,
            payoutRecipientUserId,
            identity.fingerprint,
          ],
        );

        const selected = await query<BusinessDestinationRow>(
          `SELECT
            id,
            organization_id,
            payout_recipient_user_id,
            status,
            is_test
          FROM hxos_local_test_business_payout_destinations
          WHERE organization_id = $1
          FOR UPDATE`,
          [organizationId],
        );

        const destination = selected.rows[0];

        if (
          !destination
          || destination.id !== identity.id
          || destination.organization_id !== organizationId
          || destination.payout_recipient_user_id !== payoutRecipientUserId
          || destination.status !== 'ACTIVE'
          || destination.is_test !== true
        ) {
          return failure(
            'LOCAL_TEST_BUSINESS_PAYOUT_DESTINATION_CONFLICT',
            'Business local payout destination conflicts with existing evidence.',
          );
        }

        // IMPORTANT: make sure the destination belongs to the expected Business.
        const membership = await query<{ organization_id: string }>(
          `SELECT organization_id
          FROM business_memberships
          WHERE organization_id = $1
            AND user_id = $2
            AND role IN ('OWNER', 'ADMIN')
            AND status = 'ACTIVE'
          LIMIT 1`,
          [organizationId, payoutRecipientUserId],
        );

        if (!membership.rows[0]) {
          return failure(
            'LOCAL_TEST_BUSINESS_PAYOUT_RECIPIENT_INVALID',
            'Business payout recipient is not an active OWNER or ADMIN.',
          );
        }

        return {
          success: true,
          data: {
            destinationId: destination.id,
            provider: 'LOCAL_CERTIFICATION_TEST' as const,
            status: 'ACTIVE' as const,
            isTest: true as const,
            idempotencyReplayed: (inserted.rowCount ?? 0) === 0,
          },
        };
      });
    } catch {
      return failure(
        'LOCAL_TEST_BUSINESS_PAYOUT_DESTINATION_FAILED',
        'Business local certification payout destination could not be activated.',
      );
    }
  },

  createPaidTransfer: async (
    params: CreateLocalTestTransferParams,
  ): Promise<ServiceResult<{
    transferId: string;
    provider: 'LOCAL_CERTIFICATION_TEST';
    status: 'paid';
    amountCents: number;
    isTest: true;
    idempotencyReplayed: boolean;
  }>> => {
    if (!localCertificationPayoutEnabled()) {
      return failure('LOCAL_TEST_PAYOUT_DISABLED', 'Local certification payouts are disabled.');
    }
    if (params.idempotencyKey.trim().length < 8 || params.idempotencyKey.length > 200) {
      return failure('LOCAL_TEST_PAYOUT_INVALID', 'Local certification payout idempotency key is invalid.');
    }
    const hash = requestHash(params);
    const transferId = transferIdentity(params.escrowId);
    try {
      return await db.transaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(hashtext('local-test-payout'), hashtext($1))`,
          [params.idempotencyKey],
        );
        const replay = await replayTransfer(query, params, hash);
        if (replay) {
          if (!replay.success) return replay;
          return {
            success: true,
            data: {
              transferId: replay.data.id,
              provider: 'LOCAL_CERTIFICATION_TEST' as const,
              status: 'paid' as const,
              amountCents: replay.data.amount_cents,
              isTest: true as const,
              idempotencyReplayed: true,
            },
          };
        }
        const context = await loadTransferContext(query, params);
        const validated = validateTransferContext(context, params);
        if (!validated.success) return validated;

        await query(
          `INSERT INTO hxos_local_test_payout_transfers
             (id, task_id, escrow_id, worker_id, destination_id, amount_cents,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            transferId,
            params.taskId,
            params.escrowId,
            params.workerId,
            validated.data.destinationId,
            validated.data.amountCents,
            params.idempotencyKey,
            hash,
          ],
        );
        await query(
          `INSERT INTO hxos_local_test_payout_transfer_events
             (transfer_id, from_status, to_status, event_type, idempotency_key, metadata)
           VALUES ($1, NULL, 'submitted', 'transfer_submitted', $2, $3::jsonb)`,
          [transferId, `local-test-payout-submitted:${transferId}`, JSON.stringify({
            task_id: params.taskId,
            escrow_id: params.escrowId,
            amount_cents: validated.data.amountCents,
          })],
        );
        await query(
          `UPDATE hxos_local_test_payout_transfers
           SET status = 'processing', processing_at = NOW()
           WHERE id = $1 AND status = 'submitted'`,
          [transferId],
        );
        await query(
          `INSERT INTO hxos_local_test_payout_transfer_events
             (transfer_id, from_status, to_status, event_type, idempotency_key, metadata)
           VALUES ($1, 'submitted', 'processing', 'transfer_processing', $2, $3::jsonb)`,
          [transferId, `local-test-payout-processing:${transferId}`, JSON.stringify({
            provider: 'LOCAL_CERTIFICATION_TEST', is_test: true,
          })],
        );
        const paid = await query<TransferRow>(
          `UPDATE hxos_local_test_payout_transfers
           SET status = 'paid', paid_at = NOW()
           WHERE id = $1 AND status = 'processing'
           RETURNING id, task_id, escrow_id, worker_id, destination_id,
                     amount_cents, status, idempotency_key, request_hash, is_test, paid_at`,
          [transferId],
        );
        await query(
          `INSERT INTO hxos_local_test_payout_transfer_events
             (transfer_id, from_status, to_status, event_type, idempotency_key, metadata)
           VALUES ($1, 'processing', 'paid', 'transfer_paid', $2, $3::jsonb)`,
          [transferId, `local-test-payout-paid:${transferId}`, JSON.stringify({
            provider: 'LOCAL_CERTIFICATION_TEST',
            task_id: params.taskId,
            escrow_id: params.escrowId,
            amount_cents: validated.data.amountCents,
            is_test: true,
          })],
        );
        return {
          success: true,
          data: {
            transferId: paid.rows[0].id,
            provider: 'LOCAL_CERTIFICATION_TEST' as const,
            status: 'paid' as const,
            amountCents: paid.rows[0].amount_cents,
            isTest: true as const,
            idempotencyReplayed: false,
          },
        };
      });
    } catch {
      return failure('LOCAL_TEST_PAYOUT_FAILED', 'Local certification payout transfer failed.');
    }
  },

  createPaidBusinessTransfer: async (
    params: CreateLocalTestBusinessTransferParams,
  ) => {
    if (!localCertificationPayoutEnabled()) {
      return failure(
        'LOCAL_TEST_PAYOUT_DISABLED',
        'Local certification payouts are disabled.',
      );
    }

    if (
      params.idempotencyKey.trim().length < 8
      || params.idempotencyKey.length > 200
    ) {
      return failure(
        'LOCAL_TEST_PAYOUT_INVALID',
        'Local certification payout idempotency key is invalid.',
      );
    }

    const hash = businessRequestHash(params);
    const transferId = businessTransferIdentity(params.escrowId);

    try {
      return await db.transaction(async (query) => {
        await query(
          `SELECT pg_advisory_xact_lock(
            hashtext('local-test-business-payout'),
            hashtext($1)
          )`,
          [params.idempotencyKey],
        );

        const existing = await query<BusinessTransferRow>(
          `SELECT
            id, task_id, escrow_id, organization_id,
            payout_recipient_user_id, destination_id,
            amount_cents, status, idempotency_key,
            request_hash, is_test, paid_at
          FROM hxos_local_test_business_payout_transfers
          WHERE idempotency_key = $1
              OR escrow_id = $2
          ORDER BY CASE WHEN idempotency_key = $1 THEN 0 ELSE 1 END
          LIMIT 1
          FOR UPDATE`,
          [params.idempotencyKey, params.escrowId],
        );

        const replay = existing.rows[0];

        if (replay) {
          if (
            replay.request_hash !== hash
            || replay.task_id !== params.taskId
            || replay.escrow_id !== params.escrowId
            || replay.organization_id !== params.organizationId
            || replay.payout_recipient_user_id !== params.payoutRecipientUserId
            || replay.is_test !== true
          ) {
            return failure(
              'LOCAL_TEST_PAYOUT_IDEMPOTENCY_CONFLICT',
              'Business local certification payout idempotency conflict.',
            );
          }

          if (replay.status !== 'paid' || !replay.paid_at) {
            return failure(
              'LOCAL_TEST_PAYOUT_INCOMPLETE',
              'Business local certification payout did not reach its paid TEST state.',
            );
          }

          return {
            success: true,
            data: {
              transferId: replay.id,
              provider: 'LOCAL_CERTIFICATION_TEST' as const,
              status: 'paid' as const,
              amountCents: replay.amount_cents,
              isTest: true as const,
              idempotencyReplayed: true,
            },
          };
        }

        const context = await query<{
          task_state: string;
          payout_ready_at: Date | string | null;
          automation_classification: string | null;
          business_fulfiller_organization_id: string | null;
          hustler_payout_cents: number | null;
          platform_margin_cents: number | null;
          escrow_state: string;
          amount: number;
          platform_fee_cents: number | null;
          destination_id: string | null;
          destination_status: string | null;
        }>(
          `SELECT
            t.state AS task_state,
            t.payout_ready_at,
            t.automation_classification,
            t.business_fulfiller_organization_id,
            t.hustler_payout_cents,
            t.platform_margin_cents,
            e.state AS escrow_state,
            e.amount,
            e.platform_fee_cents,
            d.id AS destination_id,
            d.status AS destination_status
          FROM tasks t
          JOIN escrows e ON e.task_id = t.id
          LEFT JOIN hxos_local_test_business_payout_destinations d
            ON d.organization_id = t.business_fulfiller_organization_id
            AND d.payout_recipient_user_id = $3
            AND d.status = 'ACTIVE'
            AND d.is_test IS TRUE
          WHERE t.id = $1
            AND e.id = $2
          FOR UPDATE OF t, e`,
          [
            params.taskId,
            params.escrowId,
            params.payoutRecipientUserId,
          ],
        );

        const row = context.rows[0];

        if (
          !row
          || row.task_state !== 'COMPLETED'
          || !row.payout_ready_at
          || row.automation_classification !== 'CONTROLLED_TEST'
          || row.business_fulfiller_organization_id !== params.organizationId
          || row.escrow_state !== 'FUNDED'
          || row.amount <= 0
          || row.platform_margin_cents == null
          || row.hustler_payout_cents == null
          || row.platform_margin_cents !== row.platform_fee_cents
          || row.hustler_payout_cents !== row.amount - row.platform_margin_cents
          || !row.destination_id
          || row.destination_status !== 'ACTIVE'
        ) {
          return failure(
            'LOCAL_TEST_PAYOUT_PRECONDITION_FAILED',
            'Business local certification payout requires an exact completed CONTROLLED_TEST task, funded escrow, immutable economics, and active TEST destination.',
          );
        }

        const breakdown = computeFeeBreakdown(
          row.amount,
          config.stripe.platformFeePercent,
          row.platform_fee_cents,
        );

        if (breakdown.netPayoutCents <= 0) {
          return failure(
            'LOCAL_TEST_PAYOUT_PRECONDITION_FAILED',
            'Business local certification payout amount is invalid.',
          );
        }

        await query(
          `INSERT INTO hxos_local_test_business_payout_transfers (
            id,
            task_id,
            escrow_id,
            organization_id,
            payout_recipient_user_id,
            destination_id,
            amount_cents,
            idempotency_key,
            request_hash
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            transferId,
            params.taskId,
            params.escrowId,
            params.organizationId,
            params.payoutRecipientUserId,
            row.destination_id,
            breakdown.netPayoutCents,
            params.idempotencyKey,
            hash,
          ],
        );

        await query(
          `UPDATE hxos_local_test_business_payout_transfers
          SET status = 'processing', processing_at = NOW()
          WHERE id = $1`,
          [transferId],
        );

        const paid = await query<BusinessTransferRow>(
          `UPDATE hxos_local_test_business_payout_transfers
          SET status = 'paid', paid_at = NOW(), updated_at = NOW()
          WHERE id = $1
            AND status = 'processing'
          RETURNING
            id, task_id, escrow_id,
            organization_id, payout_recipient_user_id,
            destination_id, amount_cents,
            status, idempotency_key,
            request_hash, is_test, paid_at`,
          [transferId],
        );

        if (!paid.rows[0]) {
          return failure(
            'LOCAL_TEST_PAYOUT_FAILED',
            'Business local certification payout could not reach paid state.',
          );
        }

        return {
          success: true,
          data: {
            transferId: paid.rows[0].id,
            provider: 'LOCAL_CERTIFICATION_TEST' as const,
            status: 'paid' as const,
            amountCents: paid.rows[0].amount_cents,
            isTest: true as const,
            idempotencyReplayed: false,
          },
        };
      });
    } catch {
      return failure(
        'LOCAL_TEST_PAYOUT_FAILED',
        'Business local certification payout transfer failed.',
      );
    }
  },

  verifyPaidTransfer: async (
    query: QueryFn,
    params: { transferId: string; taskId: string; escrowId: string; workerId: string; amountCents: number },
  ): Promise<boolean> => {
    if (!localCertificationPayoutEnabled() || !isLocalCertificationPayoutTransferId(params.transferId)) {
      return false;
    }
    const result = await query<{ id: string }>(
      `SELECT transfer.id
       FROM hxos_local_test_payout_transfers transfer
       JOIN hxos_local_test_payout_destinations destination
         ON destination.id = transfer.destination_id
       JOIN tasks task ON task.id = transfer.task_id
       WHERE transfer.id = $1
         AND transfer.task_id = $2
         AND transfer.escrow_id = $3
         AND transfer.worker_id = $4
         AND transfer.amount_cents = $5
         AND transfer.status = 'paid'
         AND transfer.paid_at IS NOT NULL
         AND transfer.is_test IS TRUE
         AND destination.worker_id = transfer.worker_id
         AND destination.status = 'ACTIVE'
         AND destination.is_test IS TRUE
         AND task.automation_classification = 'CONTROLLED_TEST'`,
      [params.transferId, params.taskId, params.escrowId, params.workerId, params.amountCents],
    );
    return Boolean(result.rows[0]);
  },

  verifyPaidBusinessTransfer: async (
    query: QueryFn,
    params: {
      transferId: string;
      taskId: string;
      escrowId: string;
      organizationId: string;
      payoutRecipientUserId: string;
      amountCents: number;
    },
  ): Promise<boolean> => {
    if (
      !localCertificationPayoutEnabled()
      || !BUSINESS_TRANSFER_RE.test(params.transferId)
    ) {
      return false;
    }

    const result = await query<{ id: string }>(
      `SELECT transfer.id
      FROM hxos_local_test_business_payout_transfers transfer
      JOIN hxos_local_test_business_payout_destinations destination
        ON destination.id = transfer.destination_id
      JOIN tasks task
        ON task.id = transfer.task_id
      WHERE transfer.id = $1
        AND transfer.task_id = $2
        AND transfer.escrow_id = $3
        AND transfer.organization_id = $4
        AND transfer.payout_recipient_user_id = $5
        AND transfer.amount_cents = $6
        AND transfer.status = 'paid'
        AND transfer.paid_at IS NOT NULL
        AND transfer.is_test IS TRUE
        AND destination.organization_id = transfer.organization_id
        AND destination.payout_recipient_user_id = transfer.payout_recipient_user_id
        AND destination.status = 'ACTIVE'
        AND destination.is_test IS TRUE
        AND task.business_fulfiller_organization_id = transfer.organization_id
        AND task.automation_classification = 'CONTROLLED_TEST'`,
      [
        params.transferId,
        params.taskId,
        params.escrowId,
        params.organizationId,
        params.payoutRecipientUserId,
        params.amountCents,
      ],
    );

    return Boolean(result.rows[0]);
  },
};


