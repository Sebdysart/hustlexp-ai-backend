import {
  createHash,
} from 'node:crypto';

import { db } from '../db.js';

export interface EnsureBusinessTestPayoutDestinationInput {
  organizationId: string;
  payoutRecipientUserId: string;
}

export interface BusinessTestPayoutDestination {
  id: string;
  organizationId: string;
  payoutRecipientUserId: string;
  destinationFingerprint: string;
  providerMode: string;
  status: string;
  isTest: boolean;
  activatedAt: Date;
  createdAt: Date;
  replayed: boolean;
}

function destinationFingerprint(
  organizationId: string,
  payoutRecipientUserId: string,
): string {
  return createHash('sha256')
    .update(
      [
        'hxos-business-test-payout',
        organizationId,
        payoutRecipientUserId,
        'local_certification_test',
      ].join(':'),
    )
    .digest('hex');
}

function destinationId(
  organizationId: string,
  payoutRecipientUserId: string,
): string {
  const digest = createHash('sha256')
    .update(
      [
        'hxos-business-test-destination-id',
        organizationId,
        payoutRecipientUserId,
      ].join(':'),
    )
    .digest('hex');

  return `pd_hxos_business_test_${digest.slice(0, 32)}`;
}

export async function ensureBusinessTestPayoutDestination(
  input: EnsureBusinessTestPayoutDestinationInput,
): Promise<BusinessTestPayoutDestination> {
  const existing = await db.query<{
    id: string;
    organization_id: string;
    payout_recipient_user_id: string;
    destination_fingerprint: string;
    provider_mode: string;
    status: string;
    is_test: boolean;
    activated_at: Date;
    created_at: Date;
  }>(
    `
    SELECT
      id,
      organization_id,
      payout_recipient_user_id,
      destination_fingerprint,
      provider_mode,
      status,
      is_test,
      activated_at,
      created_at
    FROM hxos_local_test_business_payout_destinations
    WHERE organization_id = $1
    LIMIT 1
    `,
    [input.organizationId],
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];

    return {
      id: row.id,
      organizationId:
        row.organization_id,
      payoutRecipientUserId:
        row.payout_recipient_user_id,
      destinationFingerprint:
        row.destination_fingerprint,
      providerMode:
        row.provider_mode,
      status:
        row.status,
      isTest:
        row.is_test,
      activatedAt:
        row.activated_at,
      createdAt:
        row.created_at,
      replayed: true,
    };
  }

  const id = destinationId(
    input.organizationId,
    input.payoutRecipientUserId,
  );

  const fingerprint =
    destinationFingerprint(
      input.organizationId,
      input.payoutRecipientUserId,
    );

  const created = await db.query<{
    id: string;
    organization_id: string;
    payout_recipient_user_id: string;
    destination_fingerprint: string;
    provider_mode: string;
    status: string;
    is_test: boolean;
    activated_at: Date;
    created_at: Date;
  }>(
    `
    INSERT INTO hxos_local_test_business_payout_destinations (
      id,
      organization_id,
      payout_recipient_user_id,
      destination_fingerprint,
      provider_mode,
      status,
      is_test,
      activated_at,
      created_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      'local_certification_test',
      'ACTIVE',
      TRUE,
      NOW(),
      NOW()
    )
    ON CONFLICT (organization_id)
    DO NOTHING
    RETURNING
      id,
      organization_id,
      payout_recipient_user_id,
      destination_fingerprint,
      provider_mode,
      status,
      is_test,
      activated_at,
      created_at
    `,
    [
      id,
      input.organizationId,
      input.payoutRecipientUserId,
      fingerprint,
    ],
  );

  const row =
    created.rows[0];

  if (row) {
    return {
      id: row.id,
      organizationId:
        row.organization_id,
      payoutRecipientUserId:
        row.payout_recipient_user_id,
      destinationFingerprint:
        row.destination_fingerprint,
      providerMode:
        row.provider_mode,
      status:
        row.status,
      isTest:
        row.is_test,
      activatedAt:
        row.activated_at,
      createdAt:
        row.created_at,
      replayed: false,
    };
  }

  // Another retry/request may have created it
  // between our initial SELECT and INSERT.
  const replay = await db.query<{
    id: string;
    organization_id: string;
    payout_recipient_user_id: string;
    destination_fingerprint: string;
    provider_mode: string;
    status: string;
    is_test: boolean;
    activated_at: Date;
    created_at: Date;
  }>(
    `
    SELECT
      id,
      organization_id,
      payout_recipient_user_id,
      destination_fingerprint,
      provider_mode,
      status,
      is_test,
      activated_at,
      created_at
    FROM hxos_local_test_business_payout_destinations
    WHERE organization_id = $1
    LIMIT 1
    `,
    [input.organizationId],
  );

  const replayRow =
    replay.rows[0];

  if (!replayRow) {
    throw new Error(
      'BUSINESS_TEST_PAYOUT_DESTINATION_CREATE_FAILED',
    );
  }

  return {
    id: replayRow.id,
    organizationId:
      replayRow.organization_id,
    payoutRecipientUserId:
      replayRow.payout_recipient_user_id,
    destinationFingerprint:
      replayRow.destination_fingerprint,
    providerMode:
      replayRow.provider_mode,
    status:
      replayRow.status,
    isTest:
      replayRow.is_test,
    activatedAt:
      replayRow.activated_at,
    createdAt:
      replayRow.created_at,
    replayed: true,
  };
}