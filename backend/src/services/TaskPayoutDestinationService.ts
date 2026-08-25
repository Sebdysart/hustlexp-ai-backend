import type { QueryFn } from '../db.js';

export type TaskPayoutBinding =
  | {
      kind: 'WORKER';
      taskId: string;
      workerId: string;
      payoutRecipientUserId: string;
    }
  | {
      kind: 'BUSINESS';
      taskId: string;
      businessOrganizationId: string;
    };

export interface TaskPayoutDestination {
  ready: boolean;
  stripeConnectId: string | null;
  payoutRecipientUserId: string | null;
  reason: 'READY' | 'TASK_BINDING_MISMATCH' | 'PAYOUT_ACCOUNT_NOT_READY';
}

interface DestinationRow {
  stripe_connect_id: string | null;
  payouts_enabled: boolean;
  account_status: string;
  binding_current: boolean;
}

export async function loadCurrentTaskPayoutDestination(
  query: QueryFn,
  binding: TaskPayoutBinding,
): Promise<TaskPayoutDestination> {
  if (binding.kind === 'BUSINESS') {
    const result = await query<DestinationRow & {
      payout_recipient_user_id: string | null;
    }>(
      `
      SELECT
        payee.id AS payout_recipient_user_id,
        payee.stripe_connect_id,
        payee.payouts_enabled,
        payee.account_status,
        EXISTS (
          SELECT 1
          FROM business_provider_payout_accounts payout
          WHERE payout.organization_id = task.business_fulfiller_organization_id
            AND payout.status = 'ACTIVE'
            AND payout.payout_recipient_user_id = payee.id
            AND payout.provider_account_fingerprint =
              encode(digest(payee.stripe_connect_id, 'sha256'), 'hex')
        ) AS binding_current
      FROM tasks task
      JOIN business_provider_payout_accounts payout
        ON payout.organization_id = task.business_fulfiller_organization_id
       AND payout.status = 'ACTIVE'
      JOIN users payee
        ON payee.id = payout.payout_recipient_user_id
      WHERE task.id = $1
        AND task.business_fulfiller_organization_id = $2
      ORDER BY payout.verified_at DESC, payout.created_at DESC
      LIMIT 1
      `,
      [binding.taskId, binding.businessOrganizationId],
    );

    const row = result.rows[0];

    if (!row?.binding_current) {
      return {
        ready: false,
        stripeConnectId: null,
        payoutRecipientUserId: null,
        reason: 'TASK_BINDING_MISMATCH',
      };
    }

    if (
      row.account_status !== 'ACTIVE'
      || !row.payouts_enabled
      || !row.stripe_connect_id
    ) {
      return {
        ready: false,
        stripeConnectId: null,
        payoutRecipientUserId: row.payout_recipient_user_id,
        reason: 'PAYOUT_ACCOUNT_NOT_READY',
      };
    }

    return {
      ready: true,
      stripeConnectId: row.stripe_connect_id,
      payoutRecipientUserId: row.payout_recipient_user_id,
      reason: 'READY',
    };
  }

  const result = await query<DestinationRow & {
    payout_recipient_user_id: string | null;
  }>(
    `
    SELECT
      payee.id AS payout_recipient_user_id,
      payee.stripe_connect_id,
      payee.payouts_enabled,
      payee.account_status,
      CASE
        WHEN task.provider_organization_id IS NULL THEN
          task.payout_recipient_user_id IS NULL
          AND payee.id = task.worker_id
        ELSE EXISTS (
          SELECT 1
          FROM business_service_task_assignments assignment
          JOIN business_provider_payout_accounts payout
            ON payout.id = assignment.payout_account_id
           AND payout.organization_id = assignment.provider_organization_id
           AND payout.payout_recipient_user_id = assignment.payout_recipient_user_id
           AND payout.status = 'ACTIVE'
          WHERE assignment.id = task.provider_assignment_id
            AND assignment.task_id = task.id
            AND assignment.provider_organization_id = task.provider_organization_id
            AND assignment.service_profile_id = task.provider_service_profile_id
            AND assignment.fulfiller_user_id = task.worker_id
            AND assignment.payout_recipient_user_id = payee.id
            AND payout.provider_account_fingerprint =
              encode(digest(payee.stripe_connect_id, 'sha256'), 'hex')
        )
      END AS binding_current
    FROM tasks task
    JOIN users payee
      ON payee.id = COALESCE(task.payout_recipient_user_id, task.worker_id)
    WHERE task.id = $1
      AND task.worker_id = $2
      AND payee.id = $3
    `,
    [
      binding.taskId,
      binding.workerId,
      binding.payoutRecipientUserId,
    ],
  );

  const row = result.rows[0];

  if (!row?.binding_current) {
    return {
      ready: false,
      stripeConnectId: null,
      payoutRecipientUserId: null,
      reason: 'TASK_BINDING_MISMATCH',
    };
  }

  if (
    row.account_status !== 'ACTIVE'
    || !row.payouts_enabled
    || !row.stripe_connect_id
  ) {
    return {
      ready: false,
      stripeConnectId: null,
      payoutRecipientUserId: row.payout_recipient_user_id,
      reason: 'PAYOUT_ACCOUNT_NOT_READY',
    };
  }

  return {
    ready: true,
    stripeConnectId: row.stripe_connect_id,
    payoutRecipientUserId: row.payout_recipient_user_id,
    reason: 'READY',
  };
}
