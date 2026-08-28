import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import { ControlledTestDurationEvidenceService } from '../../src/services/ControlledTestDurationEvidenceService.js';
import { ControlledTestLiquidityService } from '../../src/services/ControlledTestLiquidityService.js';
import { ControlledTestOfferReviewService } from '../../src/services/ControlledTestOfferReviewService.js';
import { ControlledTestProviderCapabilityService } from '../../src/services/ControlledTestProviderCapabilityService.js';
import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService.js';
import { LocalCertificationIdentityProvider } from '../../src/services/LocalCertificationIdentityProvider.js';
import { LocalCertificationPayoutProvider } from '../../src/services/LocalCertificationPayoutProvider.js';
import { LocalCertificationScreeningProvider } from '../../src/services/LocalCertificationScreeningProvider.js';
import { TaskService } from '../../src/services/TaskService.js';
import type { CreateTaskParams } from '../../src/services/TaskServiceShared.js';
import { grantScreeningConsent } from '../../src/services/WorkerScreeningRightsService.js';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
} from '../../src/services/WorkerScreeningRightsPolicy.js';
import { WorkerCounterOfferService } from '../../src/services/WorkerCounterOfferService.js';
import type { ServiceResult } from '../../src/types.js';

const enabled = process.env.HX_ALLOW_WORKER_COUNTER_E2E === '1';
const describePg = enabled ? describe : describe.skip;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing worker-counter test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
  }
}

function successData<T>(result: ServiceResult<T>, label: string): T {
  if (!result.success) throw new Error(`${label}: ${result.error.code} ${result.error.message}`);
  expect(result, label).toMatchObject({ success: true });
  return result.data;
}

async function verifyControlledTestIdentity(userId: string, key: string): Promise<void> {
  const prepared = successData(
    await LocalCertificationIdentityProvider.prepare({ userId, idempotencyKey: key }),
    'controlled TEST identity prepare',
  );
  const completed = successData(
    await LocalCertificationIdentityProvider.completeVerified({
      userId,
      caseId: prepared.caseId,
      actorId: userId,
      idempotencyKey: `${key}-verified`,
    }),
    'controlled TEST identity complete',
  );
  expect(completed).toMatchObject({
    status: 'VERIFIED',
    environment: 'CONTROLLED_TEST',
    isTest: true,
  });
}

async function prepareControlledTestProvider(
  workerId: string,
  phone: string,
  key: string,
): Promise<void> {
  successData(await HustlerIdentityLinkService.link({
    engineHustlerRef: workerId,
    phoneE164: phone,
    providerClaimId: randomUUID(),
  }), 'controlled TEST hustler identity link');
  const consent = await grantScreeningConsent({
    workerId,
    provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
    purpose: LOCAL_CERTIFICATION_SCREENING_PURPOSE,
    disclosureVersion: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
    disclosureHash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
    disclosurePresentedStandalone: true,
    consentGranted: true,
    purposeAcknowledged: true,
    rightsSummaryAcknowledged: true,
    providerNamed: true,
    idempotencyKey: `${key}-screening-consent`,
  });
  const screening = successData(await LocalCertificationScreeningProvider.initiate({
    workerId,
    consentId: consent.consentId,
    idempotencyKey: `${key}-screening-start`,
  }), 'controlled TEST screening initiate');
  successData(await LocalCertificationScreeningProvider.completeClear({
    backgroundCheckId: screening.backgroundCheckId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-screening-clear`,
  }), 'controlled TEST screening complete');
  successData(
    await LocalCertificationPayoutProvider.activateDestination(workerId, workerId),
    'controlled TEST payout destination',
  );
}

async function prepareCounterPrerequisiteOffer(
  taskId: string,
  workerId: string,
  key: string,
  includeDurationEvidence: boolean,
): Promise<void> {
  if (includeDurationEvidence) {
    successData(await ControlledTestDurationEvidenceService.apply({
      taskId,
      actorId: workerId,
      sourceQuoteVersionId: randomUUID(),
      minimumMinutes: 45,
      expectedMinutes: 60,
      maximumMinutes: 90,
      policyVersion: 'price-book-duration-v1',
      sourceEvidenceHash: 'b'.repeat(64),
      sourceEnvironment: 'TEST',
      idempotencyKey: `${key}-duration`,
    }), 'counter duration evidence');
  }
  successData(await ControlledTestProviderCapabilityService.record({
    taskId,
    workerId,
    actorId: workerId,
    sourceHustlerId: workerId,
    category: 'moving',
    tools: ['hand truck'],
    serviceCity: 'Seattle',
    serviceState: 'WA',
    serviceRadiusMiles: 10,
    sourcePolicyVersion: 'hxos-counter-capability-test-v1',
    sourceEvidenceHash: 'c'.repeat(64),
    sourceExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    idempotencyKey: `${key}-capability`,
  }), 'counter provider capability');
  successData(await ControlledTestLiquidityService.prepareAndBind({
    taskId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-liquidity`,
  }), 'counter liquidity');
  successData(await ControlledTestOfferReviewService.review({
    taskId,
    workerId,
    idempotencyKey: `${key}-offer-reviewed`,
  }), 'counter offer review');
}

describePg('HX/OS worker counter PostgreSQL lifecycle', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const posterId = randomUUID();
  const firstWorkerId = randomUUID();
  const secondWorkerId = randomUUID();

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
  });

  afterAll(async () => {
    if (enabled) await db.close();
  });

  it('requires bounded proposal, singular Poster approval, refund evidence, and fresh payment authorization', async () => {
    const basePhone = BigInt(`1${runId.replaceAll('-', '').replace(/\D/gu, '').padEnd(9, '0').slice(0, 9)}`);
    const posterPhone = `+${basePhone}`;
    const firstWorkerPhone = `+${basePhone + 1n}`;
    const secondWorkerPhone = `+${basePhone + 2n}`;
    await db.query(
      `INSERT INTO users(
         id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
         account_status,trust_tier,trust_hold,is_banned,plan
       ) VALUES
         ($1,$2,'HX Counter Poster','poster','1990-01-01',FALSE,FALSE,$7,'ACTIVE',2,FALSE,FALSE,'free'),
         ($3,$4,'HX Counter Worker A','worker','1990-01-01',FALSE,FALSE,$8,'ACTIVE',2,FALSE,FALSE,'free'),
         ($5,$6,'HX Counter Worker B','worker','1990-01-01',FALSE,FALSE,$9,'ACTIVE',2,FALSE,FALSE,'free')`,
      [
        posterId, `counter-poster-${runId}@e2e.invalid`,
        firstWorkerId, `counter-worker-a-${runId}@e2e.invalid`,
        secondWorkerId, `counter-worker-b-${runId}@e2e.invalid`,
        posterPhone, firstWorkerPhone, secondWorkerPhone,
      ],
    );
    await verifyControlledTestIdentity(firstWorkerId, `counter-worker-a-${runId}`);
    await verifyControlledTestIdentity(secondWorkerId, `counter-worker-b-${runId}`);
    await db.query(
      `INSERT INTO capability_profiles(
         user_id,trust_tier,risk_clearance,location_state,location_city,updated_at
       ) VALUES
         ($1,2,ARRAY['low','medium']::text[],'WA','Seattle',NOW()),
         ($2,2,ARRAY['low','medium']::text[],'WA','Seattle',NOW())`,
      [firstWorkerId, secondWorkerId],
    );
    await prepareControlledTestProvider(firstWorkerId, firstWorkerPhone, `counter-worker-a-${runId}`);
    await prepareControlledTestProvider(secondWorkerId, secondWorkerPhone, `counter-worker-b-${runId}`);
    await db.query(
      `UPDATE capability_profiles
       SET location_state='WA',location_city='Seattle',updated_at=NOW()
       WHERE user_id = ANY($1::uuid[])`,
      [[firstWorkerId, secondWorkerId]],
    );

    const createParams: CreateTaskParams = {
      posterId,
      title: 'Move two sealed counter-test boxes',
      description: 'Move two sealed boxes to the marked storage room.',
      price: 5_000,
      hustlerPayoutCents: 4_000,
      platformMarginCents: 1_000,
      requirements: 'Keep both boxes sealed; confirm both labels',
      location: '101 Original Counter Test Avenue, Seattle, WA 98101',
      roughArea: 'Seattle, WA',
      regionCode: 'US-WA',
      category: 'moving',
      requiresProof: true,
      riskLevel: 'LOW',
      mode: 'STANDARD',
      automationClassification: 'CONTROLLED_TEST',
      proofSteps: ['Confirm both labels.', 'Place both boxes in the marked room.'],
      estimatedDurationMinutes: 60,
      requiredTools: ['hand truck'],
      clientIdempotencyKey: `counter-source-${runId}`,
    };
    const task = successData(await TaskService.create(createParams), 'source task create');

    const paymentIntentId = `pi_counter_${runId.replaceAll('-', '')}`;
    await db.query(
      `UPDATE escrows SET state='FUNDED',stripe_payment_intent_id=$2,funded_at=NOW(),version=version+1
        WHERE task_id=$1`,
      [task.id, paymentIntentId],
    );
    await prepareCounterPrerequisiteOffer(task.id, firstWorkerId, `counter-a-${runId}`, true);
    await prepareCounterPrerequisiteOffer(task.id, secondWorkerId, `counter-b-${runId}`, false);

    await expect(WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: firstWorkerId,
      proposedPayoutCents: 4_801,
      reason: 'This intentionally exceeds the deterministic bounded corridor.',
      idempotencyKey: `counter-outside-${runId}`,
    })).resolves.toMatchObject({ success: false, error: { code: 'COUNTER_OUT_OF_BOUNDS' } });

    const firstSubmit = successData(await WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: firstWorkerId,
      proposedPayoutCents: 4_500,
      reason: 'The stairs and heavy boxes justify this bounded increase.',
      idempotencyKey: `counter-submit-a-${runId}`,
    }), 'first counter submit');
    expect(firstSubmit).toMatchObject({
      status: 'PENDING_POSTER', currentCustomerTotalCents: 5_000,
      currentPayoutCents: 4_000, platformMarginCents: 1_000,
      minimumCounterPayoutCents: 4_100, maximumCounterPayoutCents: 4_800,
      customerMaximumCents: 6_250, proposedPayoutCents: 4_500,
      proposedCustomerTotalCents: 5_500, replayed: false,
    });
    expect(successData(await WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: firstWorkerId,
      proposedPayoutCents: 4_500,
      reason: 'The stairs and heavy boxes justify this bounded increase.',
      idempotencyKey: `counter-submit-a-${runId}`,
    }), 'counter replay')).toMatchObject({ id: firstSubmit.id, replayed: true });
    await expect(WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: firstWorkerId,
      proposedPayoutCents: 4_600,
      reason: 'The stairs and heavy boxes justify this bounded increase.',
      idempotencyKey: `counter-submit-a-${runId}`,
    })).resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });
    await expect(WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: firstWorkerId,
      proposedPayoutCents: 4_600,
      reason: 'A second pending proposal must fail before database insertion.',
      idempotencyKey: `counter-second-pending-${runId}`,
    })).resolves.toMatchObject({ success: false, error: { code: 'COUNTER_ALREADY_PENDING' } });
    const secondSubmit = successData(await WorkerCounterOfferService.submit({
      taskId: task.id,
      workerId: secondWorkerId,
      proposedPayoutCents: 4_400,
      reason: 'The access conditions justify this second bounded proposal.',
      idempotencyKey: `counter-submit-b-${runId}`,
    }), 'second counter submit');
    expect(successData(await WorkerCounterOfferService.getContext({
      taskId: task.id, viewerId: firstWorkerId,
    }), 'worker context')).toMatchObject({
      viewerRole: 'ELIGIBLE_CANDIDATE',
      corridor: { minimumCounterPayoutCents: 4_100, maximumCounterPayoutCents: 4_800 },
      activeCounter: { id: firstSubmit.id },
    });
    expect(successData(await WorkerCounterOfferService.getContext({
      taskId: task.id, viewerId: posterId,
    }), 'poster context')).toMatchObject({ viewerRole: 'POSTER' });

    const approved = successData(await WorkerCounterOfferService.review({
      counterOfferId: firstSubmit.id,
      posterId,
      decision: 'APPROVED',
      reason: 'I approve these exact economics and will reauthorize payment.',
      idempotencyKey: `counter-approve-${runId}`,
    }), 'counter approve');
    expect(approved).toMatchObject({ status: 'APPROVED_REAUTH_REQUIRED', requiresPaymentReauthorization: true });
    const unchangedTask = await db.query<{
      state: string; clarification_state: string; price: number;
      hustler_payout_cents: number; platform_margin_cents: number;
    }>(
      `SELECT state,clarification_state,price,hustler_payout_cents,platform_margin_cents
         FROM tasks WHERE id=$1`,
      [task.id],
    );
    expect(unchangedTask.rows[0]).toEqual({
      state: 'OPEN', clarification_state: 'READY', price: 5_000,
      hustler_payout_cents: 4_000, platform_margin_cents: 1_000,
    });
    await expect(WorkerCounterOfferService.review({
      counterOfferId: secondSubmit.id,
      posterId,
      decision: 'APPROVED',
      reason: 'This competing approval must fail closed every time.',
      idempotencyKey: `counter-compete-${runId}`,
    })).resolves.toMatchObject({ success: false, error: { code: 'COUNTER_ALREADY_AUTHORIZED' } });
    expect(successData(await WorkerCounterOfferService.review({
      counterOfferId: secondSubmit.id,
      posterId,
      decision: 'REJECTED',
      reason: 'Another exact counter was selected for reauthorization.',
      idempotencyKey: `counter-reject-${runId}`,
    }), 'competing counter reject')).toMatchObject({ status: 'REJECTED' });

    const materializeInput = {
      counterOfferId: firstSubmit.id,
      posterId,
      replacementLocation: '202 Fresh Counter Authorization Street, Seattle, WA 98101',
      idempotencyKey: `counter-materialize-${runId}`,
    };
    await expect(WorkerCounterOfferService.materialize(materializeInput)).resolves.toMatchObject({
      success: false, error: { code: 'REFUND_REQUIRED' },
    });

    const refundId = `re_counter_${runId.replaceAll('-', '')}`;
    await db.query(
      `UPDATE escrows SET state='REFUNDED',stripe_refund_id=$2,refunded_at=NOW(),version=version+1
        WHERE task_id=$1`,
      [task.id, refundId],
    );
    await db.query(
      `UPDATE tasks SET state='CANCELLED',cancelled_at=NOW(),refund_state='REFUNDED',updated_at=NOW()
        WHERE id=$1`,
      [task.id],
    );
    const sourceVault = await db.query<{
      location_ciphertext: string | null; expired_at: Date | null; expiration_reason: string | null;
    }>(
      `SELECT location_ciphertext,expired_at,expiration_reason FROM task_location_vault WHERE task_id=$1`,
      [task.id],
    );
    expect(sourceVault.rows[0]).toMatchObject({
      location_ciphertext: null,
      expiration_reason: 'TASK_CANCELLED',
    });
    expect(sourceVault.rows[0].expired_at).not.toBeNull();

    const materialized = successData(
      await WorkerCounterOfferService.materialize(materializeInput),
      'counter materialize',
    );
    expect(materialized).toMatchObject({
      id: firstSubmit.id, status: 'MATERIALIZED', replayed: false,
      proposedPayoutCents: 4_500, proposedCustomerTotalCents: 5_500,
    });
    expect(materialized.replacementTaskId).toBeTruthy();
    const replacementId = materialized.replacementTaskId!;
    const replacement = await db.query<{
      state: string; worker_id: string | null; poster_id: string;
      price: number; hustler_payout_cents: number; platform_margin_cents: number;
      counter_source_task_id: string; counter_offer_id: string; counter_candidate_id: string;
      scope_hash: string;
    }>(
      `SELECT state,worker_id,poster_id,price,hustler_payout_cents,platform_margin_cents,
              counter_source_task_id,counter_offer_id,counter_candidate_id,scope_hash
         FROM tasks WHERE id=$1`,
      [replacementId],
    );
    expect(replacement.rows[0]).toMatchObject({
      state: 'OPEN', worker_id: null, poster_id: posterId,
      price: 5_500, hustler_payout_cents: 4_500, platform_margin_cents: 1_000,
      counter_source_task_id: task.id, counter_offer_id: firstSubmit.id,
      counter_candidate_id: firstWorkerId,
    });
    const replacementFinancialAndLocation = await db.query<{
      state: string; amount: number; stripe_payment_intent_id: string | null;
      location_ciphertext: string | null; exact_location: string | null; expired_at: Date | null;
    }>(
      `SELECT e.state,e.amount,e.stripe_payment_intent_id,
              v.location_ciphertext,v.exact_location,v.expired_at
         FROM escrows e JOIN task_location_vault v ON v.task_id=e.task_id
        WHERE e.task_id=$1`,
      [replacementId],
    );
    expect(replacementFinancialAndLocation.rows[0]).toMatchObject({
      state: 'PENDING', amount: 5_500, stripe_payment_intent_id: null,
      exact_location: null, expired_at: null,
    });
    expect(replacementFinancialAndLocation.rows[0].location_ciphertext).toBeTruthy();
    expect(successData(
      await WorkerCounterOfferService.materialize(materializeInput),
      'materialize replay',
    )).toMatchObject({ replacementTaskId: replacementId, replayed: true });
    await expect(WorkerCounterOfferService.materialize({
      ...materializeInput,
      replacementLocation: '999 Conflicting Replay Road, Seattle, WA 98101',
    })).resolves.toMatchObject({ success: false, error: { code: 'CONFLICT' } });

    await expect(db.query(
      'UPDATE worker_counter_offers SET proposed_payout_cents=4600 WHERE id=$1',
      [firstSubmit.id],
    )).rejects.toMatchObject({ code: 'P0001' });
    await expect(db.query(
      `UPDATE worker_counter_offer_events SET details='{"tampered":true}'::jsonb
        WHERE counter_offer_id=$1`,
      [firstSubmit.id],
    )).rejects.toMatchObject({ code: 'P0001' });
    await expect(db.query(
      'UPDATE tasks SET counter_candidate_id=$2 WHERE id=$1',
      [replacementId, secondWorkerId],
    )).rejects.toMatchObject({ code: 'P0001' });

    const retained = await db.query<{ status: string; replacement_task_id: string; event_count: string }>(
      `SELECT c.status,c.replacement_task_id,COUNT(e.id)::text AS event_count
         FROM worker_counter_offers c
         JOIN worker_counter_offer_events e ON e.counter_offer_id=c.id
        WHERE c.id=$1 GROUP BY c.id`,
      [firstSubmit.id],
    );
    expect(retained.rows[0]).toEqual({
      status: 'MATERIALIZED', replacement_task_id: replacementId, event_count: '3',
    });
  }, 30_000);
});
