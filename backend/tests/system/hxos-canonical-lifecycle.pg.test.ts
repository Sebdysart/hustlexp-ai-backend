import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BuildIdentity } from '../../src/buildIdentity.js';
import { db } from '../../src/db.js';
import {
  RELEASE_CHARTER_AUTHORITY,
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import { AutomationLifecycleReadService } from '../../src/services/AutomationLifecycleReadService.js';
import { ControlledTestDurationEvidenceService } from '../../src/services/ControlledTestDurationEvidenceService.js';
import { ControlledTestLiquidityService } from '../../src/services/ControlledTestLiquidityService.js';
import { ControlledTestOfferReviewService } from '../../src/services/ControlledTestOfferReviewService.js';
import { ControlledTestProviderCapabilityService } from '../../src/services/ControlledTestProviderCapabilityService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { EscrowReleaseReconciliationService } from '../../src/services/EscrowReleaseReconciliationService.js';
import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService.js';
import { HustlerWalletService } from '../../src/services/HustlerWalletService.js';
import type { WalletProvider } from '../../src/services/HustlerWalletTypes.js';
import { LocalCertificationIdentityProvider } from '../../src/services/LocalCertificationIdentityProvider.js';
import { LocalCertificationPayoutProvider } from '../../src/services/LocalCertificationPayoutProvider.js';
import { LocalCertificationScreeningProvider } from '../../src/services/LocalCertificationScreeningProvider.js';
import { newPaymentCreationHealth } from '../../src/services/NewPaymentCreationGuard.js';
import { ProofService } from '../../src/services/ProofService.js';
import { TaskLocationService } from '../../src/services/TaskLocationService.js';
import { TaskReservationService } from '../../src/services/TaskReservationService.js';
import { TaskScopeService } from '../../src/services/TaskScopeService.js';
import { TaskService } from '../../src/services/TaskService.js';
import type { CreateTaskParams } from '../../src/services/TaskServiceShared.js';
import { createDatabaseBackedFakeFinancialProvider } from '../../src/services/payment/FakeFinancialProvider.js';
import { grantScreeningConsent } from '../../src/services/WorkerScreeningRightsService.js';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
} from '../../src/services/WorkerScreeningRightsPolicy.js';
import type { ServiceResult } from '../../src/types.js';

const enabled = process.env.HX_ALLOW_E2E_LIFECYCLE === '1';
const describePg = enabled ? describe : describe.skip;

const CUSTOMER_TOTAL_CENTS = 5_000;
const GROSS_WORKER_PAYOUT_CENTS = 4_000;
const PLATFORM_FEE_CENTS = 1_000;
const INSURANCE_CENTS = 100;
const NET_WORKER_PAYOUT_CENTS = 3_900;
const LOCAL_TEST_REVISION = 'd'.repeat(40);
const LOCAL_TEST_DIGEST = `sha256:${'a'.repeat(64)}`;

function authorizedFakeFinanceRuntime(): {
  environment: NodeJS.ProcessEnv;
  release: ReleaseManifestEvidence;
  identity: BuildIdentity;
} {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    HX_ENVIRONMENT: 'local',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    HX_EXTERNAL_VALUE: 'false',
    HX_LIVE_PROVIDER_ACCESS: 'false',
    SERVICE_ROLE: 'backend',
  };
  const component = {
    revision: LOCAL_TEST_REVISION,
    artifactDigest: LOCAL_TEST_DIGEST,
  };
  const imageComponent = { ...component, imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE' as const, imageDigest: LOCAL_TEST_DIGEST };
  const manifest: ReleaseManifest = {
    version: 1,
    environment: 'local',
    releaseId: 'hxos-canonical-lifecycle-test',
    createdAt: '2026-08-26T00:00:00.000Z',
    authority: {
      document: RELEASE_CHARTER_AUTHORITY.document,
      charterVersion: RELEASE_CHARTER_AUTHORITY.version,
      charterRevision: RELEASE_CHARTER_AUTHORITY.revision,
      capabilityPolicyDigest: LOCAL_TEST_DIGEST,
    },
    components: {
      backend: imageComponent,
      worker: imageComponent,
      web: imageComponent,
      migration: component,
      policy: component,
      fixtures: imageComponent,
    },
    capabilities: {
      financialProvider: 'fake',
      fakeFinancialEvents: true,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'sink',
      dataClass: 'synthetic',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
    },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  };
  const release: ReleaseManifestEvidence = {
    schema_version: 1,
    status: 'valid',
    digest: releaseManifestDigest(manifest),
    source: 'HXOS_CANONICAL_LIFECYCLE_TEST',
    errors: [],
    manifest,
  };
  const identity: BuildIdentity = {
    schema_version: 1,
    service: 'hustlexp-engine',
    revision: LOCAL_TEST_REVISION,
    built_at: '2026-08-26T00:00:00.000Z',
    environment: 'test',
    clean_source: false,
    source: 'HXOS_CANONICAL_LIFECYCLE_TEST',
  };
  return { environment, release, identity };
}

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(
      `Refusing canonical lifecycle test against non-disposable target ${parsed.hostname}/${parsed.pathname.slice(1)}`,
    );
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
  expect(completed).toMatchObject({ status: 'VERIFIED', environment: 'CONTROLLED_TEST', isTest: true });
}

async function prepareControlledTestProvider(workerId: string, phone: string, key: string): Promise<void> {
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
  expect(successData(await LocalCertificationScreeningProvider.completeClear({
    backgroundCheckId: screening.backgroundCheckId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-screening-clear`,
  }), 'controlled TEST screening complete')).toMatchObject({ status: 'CLEAR', isTest: true });
  expect(successData(
    await LocalCertificationPayoutProvider.activateDestination(workerId, workerId),
    'controlled TEST payout destination',
  )).toMatchObject({ status: 'ACTIVE', isTest: true });
}

async function prepareControlledTestOffer(
  taskId: string,
  workerId: string,
  serviceCity: string,
  key: string,
) {
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
  }), 'controlled TEST duration evidence');
  successData(await ControlledTestProviderCapabilityService.record({
    taskId,
    workerId,
    actorId: workerId,
    sourceHustlerId: workerId,
    category: 'moving',
    tools: ['hand truck'],
    serviceCity,
    serviceState: 'WA',
    serviceRadiusMiles: 10,
    sourcePolicyVersion: 'hxos-canonical-capability-test-v1',
    sourceEvidenceHash: 'c'.repeat(64),
    sourceExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    idempotencyKey: `${key}-capability`,
  }), 'controlled TEST provider capability');
  const liquidity = successData(await ControlledTestLiquidityService.prepareAndBind({
    taskId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-liquidity`,
  }), 'controlled TEST liquidity');
  expect(liquidity).toMatchObject({ activeVerifiedProviders: 1, isTest: true });
  const reviewed = successData(await ControlledTestOfferReviewService.review({
    taskId,
    workerId,
    idempotencyKey: `${key}-offer-viewed`,
  }), 'controlled TEST offer review');
  expect(reviewed.decision).toMatchObject({
    decisionReady: true,
    blockingReasons: [],
    economics: {
      customerTotalCents: CUSTOMER_TOTAL_CENTS,
      payoutCents: GROSS_WORKER_PAYOUT_CENTS,
      insuranceAdjustmentCents: INSURANCE_CENTS,
      netPayoutCents: NET_WORKER_PAYOUT_CENTS,
      minimumNetHourlyCents: 2_000,
      providerEarningsFloorMet: true,
    },
    logistics: { estimatedDurationMinutes: 60 },
    cancellation: {
      policyVersion: 'task-template-v2:standard_physical:0',
      lateCancelPercent: 0,
      windowHours: 24,
    },
    rights: { passingHasRankPenalty: false },
    ranking: { paidPromotionAffectsRank: false },
  });
  successData(await ControlledTestOfferReviewService.accept({
    taskId,
    workerId,
    offerDecisionId: reviewed.offerDecisionId,
    idempotencyKey: `${key}-offer-accepted`,
  }), 'controlled TEST offer acceptance');
  return reviewed;
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

describePg('HX/OS canonical PostgreSQL lifecycle', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const serviceCity = `Seattle ${runId.replace(/[^a-f]/gu, '').slice(0, 8).padEnd(8, 'x')}`;
  const posterId = randomUUID();
  const workerId = randomUUID();
  const createKey = `task-create-${runId}`;
  const reservationKey = `reservation-${runId}`;
  const proofKey = `proof-${runId}`;
  const mediaReceiptIds = [randomUUID(), randomUUID()];
  const cashOutKey = `cashout-${runId}`;
  const cashOutRetryKey = `cashout-retry-${runId}`;
  const phoneDigits = runId.replace(/\D/g, '').padEnd(10, '0').slice(0, 10);
  const posterPhone = `+1${phoneDigits}`;
  const workerPhone = `+1${(BigInt(phoneDigits) + 1n).toString().padStart(10, '0').slice(-10)}`;

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
    const fakeFinanceSchema = await db.query<{ table_name: string | null }>(
      "SELECT to_regclass('public.hxos_fake_financial_operations_v1')::text AS table_name",
    );
    if (!fakeFinanceSchema.rows[0]?.table_name) {
      throw new Error('NONPRODUCTION_FAKE_FINANCE_SCHEMA_REQUIRED');
    }
  });

  afterAll(async () => {
    if (enabled) await db.close();
  });

  it('proves intent through bank payout with replay, concurrency, and failure evidence', async () => {
    const fakeRuntime = authorizedFakeFinanceRuntime();
    expect(newPaymentCreationHealth(fakeRuntime.environment)).toMatchObject({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      permitsRealSettlement: false,
      permitsProviderPayouts: false,
    });
    const financialProvider = createDatabaseBackedFakeFinancialProvider(
      db,
      fakeRuntime.environment,
      fakeRuntime.release,
      fakeRuntime.identity,
    );
    const stripeEventsBefore = await db.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM stripe_events',
    );
    const financialOperationIds = {
      providerAccount: randomUUID(),
      paymentMethod: randomUUID(),
      authorization: randomUUID(),
      security: randomUUID(),
      capture: randomUUID(),
      settlement: randomUUID(),
      funding: randomUUID(),
      underpaidPayout: randomUUID(),
      mismatchReconciliation: randomUUID(),
      payout: randomUUID(),
      webhook: randomUUID(),
      reconciliation: randomUUID(),
    } as const;
    const initialPool = await db.query<{ total_deposits_cents: number }>(
      'SELECT total_deposits_cents FROM self_insurance_pool LIMIT 1',
    );
    const initialPoolDeposits = initialPool.rows[0]?.total_deposits_cents ?? 0;
    await db.query(
      `INSERT INTO users(
         id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
         account_status,trust_tier,trust_hold,is_banned,plan,
         stripe_connect_id,stripe_connect_status,payouts_enabled,charges_enabled
       ) VALUES
         ($1,$2,'HX E2E Poster','poster','1990-01-01',FALSE,FALSE,$6,'ACTIVE',2,FALSE,FALSE,'free',NULL,NULL,FALSE,FALSE),
         ($3,$4,'HX E2E Hustler','worker','1990-01-01',FALSE,FALSE,$7,'ACTIVE',2,FALSE,FALSE,'free',$5,'complete',TRUE,TRUE)`,
      [
        posterId,
        `poster-${runId}@e2e.invalid`,
        workerId,
        `worker-${runId}@e2e.invalid`,
        `acct_e2e_${runId.replaceAll('-', '')}`,
        posterPhone,
        workerPhone,
      ],
    );
    await verifyControlledTestIdentity(workerId, `canonical-worker-${runId}`);
    await db.query(
      `INSERT INTO worker_payout_settings(
         worker_id,minimum_payout_amount_cents,bank_account_last4,bank_account_type,bank_name
       ) VALUES ($1,1000,'4242','checking','HX E2E Bank')`,
      [workerId],
    );
    await db.query(
      `INSERT INTO capability_profiles(
         user_id,trust_tier,risk_clearance,location_state,location_city,updated_at
       ) VALUES ($1,2,ARRAY['low','medium']::text[],'WA','Seattle',NOW())`,
      [workerId],
    );
    await prepareControlledTestProvider(workerId, workerPhone, `canonical-worker-${runId}`);
    await db.query(
      `UPDATE capability_profiles
          SET location_state='WA',location_city=$2,updated_at=NOW()
        WHERE user_id=$1`,
      [workerId, serviceCity],
    );

    const deadline = new Date(Date.now() + 2 * 60 * 60_000);
    const dispatchExpiresAt = new Date(Date.now() + 60 * 60_000);
    const createParams: CreateTaskParams = {
      posterId,
      title: 'Move two sealed storage boxes',
      description: 'Move two sealed boxes from the entry to the labeled storage area.',
      price: CUSTOMER_TOTAL_CENTS,
      hustlerPayoutCents: GROSS_WORKER_PAYOUT_CENTS,
      platformMarginCents: PLATFORM_FEE_CENTS,
      requirements: 'Confirm both labels; Keep both boxes sealed',
      location: '101 Test Avenue, Seattle, WA 98101',
      roughArea: `${serviceCity}, WA`,
      regionCode: 'US-WA',
      category: 'moving',
      deadline,
      dispatchExpiresAt,
      requiresProof: true,
      riskLevel: 'LOW',
      mode: 'STANDARD',
      automationClassification: 'CONTROLLED_TEST',
      proofSteps: ['Confirm both box labels.', 'Place both boxes in the storage area.'],
      estimatedDurationMinutes: 60,
      requiredTools: ['hand truck'],
      clientIdempotencyKey: createKey,
    };

    const created = successData(await TaskService.create(createParams), 'task create');
    const taskId = created.id;
    expect(created).toMatchObject({
      state: 'OPEN',
      progress_state: 'POSTED',
      price: CUSTOMER_TOTAL_CENTS,
      hustler_payout_cents: GROSS_WORKER_PAYOUT_CENTS,
      platform_margin_cents: PLATFORM_FEE_CENTS,
    });
    expect(created.location).not.toContain('101 Test Avenue');

    const locationAtRest = await db.query<{
      exact_location: string | null;
      location_ciphertext: string | null;
      location_key_id: string | null;
    }>(
      `SELECT exact_location,location_ciphertext,location_key_id
       FROM task_location_vault WHERE task_id=$1`,
      [taskId],
    );
    expect(locationAtRest.rows[0]).toMatchObject({
      exact_location: null,
      location_key_id: process.env.TASK_LOCATION_ENCRYPTION_KEY_ID,
    });
    expect(locationAtRest.rows[0]?.location_ciphertext).toBeTruthy();

    expect(successData(await TaskService.create(createParams), 'task create replay')).toMatchObject({
      id: taskId,
      idempotency_replayed: true,
    });
    await expect(TaskService.create({ ...createParams, title: 'Changed title' })).resolves.toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });

    await expect(TaskReservationService.reserve({
      engineTaskId: taskId,
      hustlerRef: workerId,
      idempotencyKey: reservationKey,
      actorId: workerId,
    })).resolves.toMatchObject({ success: false, error: { code: 'TASK_NOT_FUNDED' } });

    const escrowBeforeFunding = await db.query<{ id: string; version: number }>(
      'SELECT id,version FROM escrows WHERE task_id=$1',
      [taskId],
    );
    const escrowId = escrowBeforeFunding.rows[0].id;
    const providerAccount = await financialProvider.onboardProvider({
      operationId: financialOperationIds.providerAccount,
      idempotencyKey: `canonical:${runId}:provider-account`,
      expectedVersion: 0,
      providerId: workerId,
    });
    expect(providerAccount).toMatchObject({ providerKind: 'FAKE', state: 'SUCCEEDED' });
    const paymentMethod = await financialProvider.preparePaymentMethod({
      operationId: financialOperationIds.paymentMethod,
      idempotencyKey: `canonical:${runId}:payment-method`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      customerId: posterId,
    });
    const authorization = await financialProvider.authorize({
      operationId: financialOperationIds.authorization,
      idempotencyKey: `canonical:${runId}:authorization`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      relatedOperationId: paymentMethod.operationId,
      paymentMethodReference: paymentMethod.externalReference,
    });
    const secureInput = {
      operationId: financialOperationIds.security,
      idempotencyKey: `canonical:${runId}:security`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      relatedOperationId: authorization.operationId,
      authorizationOperationId: authorization.operationId,
    } as const;
    const securedAttempts = await Promise.all([
      financialProvider.secure(secureInput),
      financialProvider.secure(secureInput),
    ]);
    expect(securedAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerKind: 'FAKE', state: 'SUCCEEDED', idempotencyReplayed: false }),
      expect.objectContaining({ providerKind: 'FAKE', state: 'SUCCEEDED', idempotencyReplayed: true }),
    ]));
    const secured = securedAttempts[0];

    // The legacy escrow schema still names this compatibility column stripe_*.
    // In this nonproduction-only test it is a projection of a verified FAKE
    // security event; it is not processor authority and creates no Stripe row.
    successData(await EscrowService.fund({
      escrowId,
      stripePaymentIntentId: secured.externalReference,
    }), 'FAKE security legacy escrow projection');
    const funded = await db.query<{
      state: string;
      compatibility_reference: string;
      event_count: string;
      provider_state: string;
    }>(
      `SELECT e.state,e.stripe_payment_intent_id AS compatibility_reference,
              (SELECT COUNT(*)::text FROM escrow_events x
               WHERE x.escrow_id=e.id AND x.to_state='FUNDED') AS event_count,
              f.state AS provider_state
       FROM escrows e
       JOIN hxos_fake_financial_operation_events_v1 f
         ON f.operation_id=$2 AND f.operation_kind='SECURE'
       WHERE e.id=$1`,
      [escrowId, financialOperationIds.security],
    );
    expect(funded.rows[0]).toEqual({
      state: 'FUNDED',
      compatibility_reference: secured.externalReference,
      event_count: '1',
      provider_state: 'SUCCEEDED',
    });

    const offer = await prepareControlledTestOffer(
      taskId,
      workerId,
      serviceCity,
      `canonical-task-${runId}`,
    );
    await expect(db.query(
      'UPDATE worker_offer_decisions SET payout_cents=3999 WHERE id=$1',
      [offer.offerDecisionId],
    )).rejects.toMatchObject({ code: 'P0001' });

    const reservation = successData(await TaskReservationService.reserve({
      engineTaskId: taskId,
      hustlerRef: workerId,
      idempotencyKey: reservationKey,
      actorId: workerId,
    }), 'reservation');
    expect(reservation.idempotencyReplayed).toBe(false);
    expect(successData(await TaskReservationService.reserve({
      engineTaskId: taskId,
      hustlerRef: workerId,
      idempotencyKey: reservationKey,
      actorId: workerId,
    }), 'reservation replay')).toMatchObject({
      reservationId: reservation.reservationId,
      idempotencyReplayed: true,
    });
    await expect(TaskReservationService.reserve({
      engineTaskId: taskId,
      hustlerRef: randomUUID(),
      idempotencyKey: reservationKey,
      actorId: workerId,
    })).resolves.toMatchObject({ success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });

    expect(successData(await TaskLocationService.releaseToReservedWorker({ taskId, workerId }), 'location release'))
      .toEqual({ exactLocation: createParams.location });
    successData(await TaskService.advanceProgress({
      taskId,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: workerId },
    }), 'traveling');
    successData(await TaskService.startWork(taskId, workerId), 'start work');

    const scope = await TaskScopeService.getForParticipant(taskId, workerId);
    expect(scope.legacy).toBe(false);
    expect(scope.version).not.toBeNull();
    for (const item of scope.checklist) {
      expect(await TaskScopeService.setChecklistItem({
        taskId,
        workerId,
        versionId: scope.version!.id,
        itemIndex: item.itemIndex,
        completed: true,
      }), `checklist ${item.itemIndex}`).toEqual({
        versionId: scope.version!.id,
        itemIndex: item.itemIndex,
        completed: true,
      });
    }
    await expect(TaskService.complete(taskId, posterId, { mode: 'POSTER_CONFIRMED' }))
      .resolves.toMatchObject({ success: false, error: { code: 'INVALID_STATE' } });

    for (const [index, mediaReceiptId] of mediaReceiptIds.entries()) {
      await db.query(
        `INSERT INTO media_upload_receipts (
           id,task_id,uploader_id,purpose,status,quarantine_key,
           expected_content_type,expected_size_bytes,canonical_key,canonical_url,
           canonical_content_type,canonical_size_bytes,canonical_checksum_sha256,
           pixel_width,pixel_height,source_metadata_detected,raw_deleted_at,finalized_at,
           quarantine_expires_at,expires_at
         ) VALUES (
           $1,$2,$3,'PROOF','FINALIZED',$4,'image/jpeg',120000,$5,NULL,
           'image/jpeg',120000,$6,3,2,TRUE,NOW(),NOW(),NOW()+INTERVAL '15 minutes',NOW()+INTERVAL '24 hours'
         )`,
        [
          mediaReceiptId,
          taskId,
          workerId,
          `quarantine/proof/${taskId}/${workerId}/${mediaReceiptId}.jpg`,
          `media/proof/${taskId}/${workerId}/${mediaReceiptId}.jpg`,
          (index === 0 ? 'a' : 'b').repeat(64),
        ],
      );
    }
    const capturedAt = new Date().toISOString();
    const proofParams = {
      taskId,
      submitterId: workerId,
      description: 'Both sealed boxes are in the approved storage area.',
      photoEvidence: mediaReceiptIds.map((uploadReceiptId, index) => ({
        uploadReceiptId,
        contentType: 'image/jpeg' as const,
        fileSizeBytes: 120_000,
        checksumSha256: (index === 0 ? 'a' : 'b').repeat(64),
        capturedAt,
      })),
      scopeVersionId: scope.version!.id,
      scopeHash: scope.version!.hash,
      clientSubmissionId: proofKey,
    };
    const proof = await db.transaction(async (query) => {
      const submittedProof = successData(await ProofService.submit(proofParams, query), 'proof submit');
      successData(await TaskService.submitProof(taskId, query), 'task proof transition');
      return submittedProof;
    });
    expect(proof.state).toBe('SUBMITTED');
    expect(successData(await ProofService.submit(proofParams), 'proof replay').id).toBe(proof.id);
    await expect(ProofService.submit({ ...proofParams, description: 'Different evidence' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });

    const review = successData(await ProofService.review({
      proofId: proof.id,
      reviewerId: posterId,
      decision: 'ACCEPTED',
    }, {
      signObject: async (key, expiresInSeconds) => {
        expect(key).toMatch(new RegExp(`^media/proof/${taskId}/${workerId}/`, 'u'));
        expect(expiresInSeconds).toBe(300);
        return `https://private-media.e2e.invalid/${encodeURIComponent(key)}?signature=controlled-test`;
      },
    }), 'proof review');
    expect(review.state).toBe('ACCEPTED');
    const proofSignals = await db.query<{
      biometric_signal_status: string;
      liveness_score: number | null;
      deepfake_score: number | null;
      biometric_provider: string | null;
      biometric_failure_reason_code: string | null;
      biometric_analyzed_at: Date | null;
      biometric_verified: boolean;
    }>(
      `SELECT biometric_signal_status,liveness_score,deepfake_score,
              biometric_provider,biometric_failure_reason_code,
              biometric_analyzed_at,biometric_verified
       FROM proof_submissions
       WHERE proof_id=$1
       ORDER BY created_at DESC,id DESC
       LIMIT 1`,
      [proof.id],
    );
    expect(proofSignals.rows[0]).toMatchObject({
      biometric_signal_status: 'UNAVAILABLE',
      liveness_score: null,
      deepfake_score: null,
      biometric_provider: null,
      biometric_failure_reason_code: 'BIOMETRIC_PROVIDER_UNAVAILABLE',
      biometric_verified: false,
    });
    expect(proofSignals.rows[0].biometric_analyzed_at).not.toBeNull();
    expect(successData(await TaskService.complete(taskId, posterId, { mode: 'POSTER_CONFIRMED' }), 'completion'))
      .toMatchObject({ state: 'COMPLETED', progress_state: 'COMPLETED' });
    expect(successData(await TaskService.complete(taskId, posterId, { mode: 'POSTER_CONFIRMED' }), 'completion replay').id)
      .toBe(taskId);

    const capture = await financialProvider.capture({
      operationId: financialOperationIds.capture,
      idempotencyKey: `canonical:${runId}:capture`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      relatedOperationId: secured.operationId,
    });
    const settlement = await financialProvider.settle({
      operationId: financialOperationIds.settlement,
      idempotencyKey: `canonical:${runId}:settlement`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      relatedOperationId: capture.operationId,
    });
    const funding = await financialProvider.fund({
      operationId: financialOperationIds.funding,
      idempotencyKey: `canonical:${runId}:funding`,
      expectedVersion: 0,
      amountCents: CUSTOMER_TOTAL_CENTS,
      currency: 'usd',
      relatedOperationId: settlement.operationId,
    });
    const underpaidPayout = await financialProvider.payout({
      operationId: financialOperationIds.underpaidPayout,
      idempotencyKey: `canonical:${runId}:underpaid-payout`,
      expectedVersion: 0,
      amountCents: NET_WORKER_PAYOUT_CENTS - 1,
      currency: 'usd',
      relatedOperationId: funding.operationId,
      providerAccountReference: providerAccount.externalReference,
    });
    const mismatch = await financialProvider.reconcile({
      operationId: financialOperationIds.mismatchReconciliation,
      idempotencyKey: `canonical:${runId}:mismatch-reconciliation`,
      expectedVersion: 0,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      currency: 'usd',
      relatedOperationId: underpaidPayout.operationId,
      scenario: 'RECONCILIATION_MISMATCH',
      reconciliationSnapshotSha256: 'b'.repeat(64),
    });
    expect(mismatch).toMatchObject({ providerKind: 'FAKE', state: 'MISMATCH' });
    const mismatchEvidence = await db.query<{
      escrow_state: string;
      payout_state: string;
      payout_cents: number;
      reconciliation_state: string;
    }>(
      `SELECT e.state AS escrow_state,payout.state AS payout_state,
              payout.amount_cents::integer AS payout_cents,
              reconciliation.state AS reconciliation_state
       FROM escrows e
       JOIN hxos_fake_financial_operation_events_v1 payout
         ON payout.operation_id=$2 AND payout.operation_kind='PAYOUT'
       JOIN hxos_fake_financial_operation_events_v1 reconciliation
         ON reconciliation.operation_id=$3 AND reconciliation.operation_kind='RECONCILE'
       WHERE e.id=$1`,
      [
        escrowId,
        financialOperationIds.underpaidPayout,
        financialOperationIds.mismatchReconciliation,
      ],
    );
    expect(mismatchEvidence.rows[0]).toEqual({
      escrow_state: 'FUNDED',
      payout_state: 'SUCCEEDED',
      payout_cents: NET_WORKER_PAYOUT_CENTS - 1,
      reconciliation_state: 'MISMATCH',
    });

    const payoutInput = {
      operationId: financialOperationIds.payout,
      idempotencyKey: `canonical:${runId}:payout`,
      expectedVersion: 0,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      currency: 'usd',
      relatedOperationId: funding.operationId,
      providerAccountReference: providerAccount.externalReference,
    } as const;
    const payoutAttempts = await Promise.all([
      financialProvider.payout(payoutInput),
      financialProvider.payout(payoutInput),
    ]);
    expect(payoutAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ providerKind: 'FAKE', state: 'SUCCEEDED', idempotencyReplayed: false }),
      expect.objectContaining({ providerKind: 'FAKE', state: 'SUCCEEDED', idempotencyReplayed: true }),
    ]));
    const payout = payoutAttempts[0];
    const webhookInput = {
      operationId: financialOperationIds.webhook,
      idempotencyKey: `canonical:${runId}:payout-webhook`,
      expectedVersion: 0,
      relatedOperationId: payout.operationId,
      providerEventReference: payout.externalReference,
      authenticated: true,
      scenario: 'DUPLICATE_WEBHOOK',
    } as const;
    const webhook = await financialProvider.ingestWebhook(webhookInput);
    const webhookReplay = await financialProvider.ingestWebhook(webhookInput);
    expect(webhook).toMatchObject({ providerKind: 'FAKE', state: 'ACCEPTED', idempotencyReplayed: false });
    expect(webhookReplay).toMatchObject({ providerKind: 'FAKE', state: 'ACCEPTED', idempotencyReplayed: true });
    const reconciliationInput = {
      operationId: financialOperationIds.reconciliation,
      idempotencyKey: `canonical:${runId}:reconciliation`,
      expectedVersion: 0,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      currency: 'usd',
      relatedOperationId: payout.operationId,
      reconciliationSnapshotSha256: 'c'.repeat(64),
    } as const;
    const fakeReconciliation = await financialProvider.reconcile(reconciliationInput);
    const fakeReconciliationReplay = await financialProvider.reconcile(reconciliationInput);
    expect(fakeReconciliation).toMatchObject({
      providerKind: 'FAKE', state: 'MATCHED', idempotencyReplayed: false,
    });
    expect(fakeReconciliationReplay).toMatchObject({
      providerKind: 'FAKE', state: 'MATCHED', idempotencyReplayed: true,
    });

    // The legacy accounting projection remains bounded to the pre-existing
    // controlled TEST provider. It cannot run outside a disposable test DB and
    // never turns the FAKE external reference into a Stripe transfer.
    const compatibilityTransfer = successData(
      await LocalCertificationPayoutProvider.createPaidTransfer({
        taskId,
        escrowId,
        workerId,
        idempotencyKey: `canonical:${runId}:legacy-payout-projection`,
      }),
      'FAKE payout legacy escrow projection',
    );
    expect(compatibilityTransfer).toMatchObject({
      provider: 'LOCAL_CERTIFICATION_TEST',
      status: 'paid',
      amountCents: payout.amountCents,
      isTest: true,
    });
    successData(await EscrowService.release({
      escrowId,
      localTestTransferId: compatibilityTransfer.transferId,
    }), 'legacy escrow release projection');
    const releaseReconciliation = successData(await EscrowReleaseReconciliationService.reconcile({
      escrowId,
      fromState: 'E2E_REPLAY',
    }), 'release reconciliation');
    expect(releaseReconciliation).toMatchObject({
      taskId,
      workerId,
      grossAmountCents: CUSTOMER_TOTAL_CENTS,
      platformFeeCents: PLATFORM_FEE_CENTS,
      insuranceContributionCents: INSURANCE_CENTS,
      netPayoutCents: NET_WORKER_PAYOUT_CENTS,
    });
    successData(await EscrowReleaseReconciliationService.reconcile({
      escrowId,
      fromState: 'E2E_SECOND_REPLAY',
    }), 'release reconciliation replay');

    const accounting = await db.query<{
      escrow_state: string;
      transfer_id: string;
      stripe_transfer_id: string | null;
      payout_provider: string;
      compatibility_security_reference: string;
      task_state: string;
      progress_state: string;
      release_events: string;
      release_outbox: string;
      insurance_rows: string;
      insurance_cents: string;
      verification_rows: string;
      verification_cents: string;
      verification_total: number;
      verification_tasks: number;
      verification_unlocked: boolean;
      verification_notified: boolean;
      unlock_notifications: string;
      xp_rows: string;
      xp_base: string;
      xp_effective: string;
      platform_fee_rows: string;
      platform_fee: string;
      ledger_gross: string;
      ledger_net: string;
      pool_deposits: number;
      judge_decisions: string;
      judge_overrides: string;
      trust_telemetry: string;
      fake_payout_state: string;
      fake_reconciliation_state: string;
    }>(
      `SELECT e.state AS escrow_state,e.provider_transfer_id AS transfer_id,
              e.stripe_transfer_id,e.payout_provider,
              e.stripe_payment_intent_id AS compatibility_security_reference,
              t.state AS task_state,t.progress_state,
              (SELECT COUNT(*)::text FROM escrow_events x WHERE x.escrow_id=e.id AND x.to_state='RELEASED') AS release_events,
              (SELECT COUNT(*)::text FROM outbox_events o WHERE o.idempotency_key='escrow.released:'||e.id::text) AS release_outbox,
              (SELECT COUNT(*)::text FROM insurance_contributions i WHERE i.task_id=t.id AND i.hustler_id=t.worker_id) AS insurance_rows,
              (SELECT COALESCE(SUM(i.contribution_cents),0)::text FROM insurance_contributions i WHERE i.task_id=t.id AND i.hustler_id=t.worker_id) AS insurance_cents,
              (SELECT COUNT(*)::text FROM verification_earnings_ledger v WHERE v.escrow_id=e.id) AS verification_rows,
              (SELECT COALESCE(SUM(v.net_payout_cents),0)::text FROM verification_earnings_ledger v WHERE v.escrow_id=e.id) AS verification_cents,
              COALESCE(vt.total_net_earnings_cents,0) AS verification_total,
              COALESCE(vt.completed_task_count,0) AS verification_tasks,
              COALESCE(vt.earned_unlock_achieved,FALSE) AS verification_unlocked,
              vt.unlock_notified_at IS NOT NULL AS verification_notified,
              (SELECT COUNT(*)::text FROM notifications n
               WHERE n.user_id=t.worker_id AND n.category='EARNED_VERIFICATION_UNLOCKED') AS unlock_notifications,
              (SELECT COUNT(*)::text FROM xp_ledger x WHERE x.escrow_id=e.id AND x.reason='task_completion') AS xp_rows,
              (SELECT COALESCE(SUM(x.base_xp),0)::text FROM xp_ledger x WHERE x.escrow_id=e.id AND x.reason='task_completion') AS xp_base,
              (SELECT COALESCE(SUM(x.effective_xp),0)::text FROM xp_ledger x WHERE x.escrow_id=e.id AND x.reason='task_completion') AS xp_effective,
              (SELECT COUNT(*)::text FROM revenue_ledger r WHERE r.escrow_id=e.id AND r.event_type='platform_fee') AS platform_fee_rows,
              (SELECT COALESCE(SUM(r.platform_fee_cents),0)::text FROM revenue_ledger r WHERE r.escrow_id=e.id AND r.event_type='platform_fee') AS platform_fee,
              (SELECT COALESCE(SUM(r.gross_amount_cents),0)::text FROM revenue_ledger r WHERE r.escrow_id=e.id AND r.event_type='platform_fee') AS ledger_gross,
              (SELECT COALESCE(SUM(r.net_amount_cents),0)::text FROM revenue_ledger r WHERE r.escrow_id=e.id AND r.event_type='platform_fee') AS ledger_net,
              (SELECT total_deposits_cents FROM self_insurance_pool LIMIT 1) AS pool_deposits,
              (SELECT COUNT(*)::text FROM ai_agent_decisions a
               WHERE a.task_id=t.id AND a.proof_id=$3 AND a.agent_type='judge'
                 AND a.authority_level='A2') AS judge_decisions,
              (SELECT COUNT(*)::text FROM ai_agent_decisions a
               WHERE a.task_id=t.id AND a.proof_id=$3 AND a.agent_type='judge'
                 AND a.validator_override=TRUE AND a.validator_reason IS NOT NULL) AS judge_overrides,
              (SELECT COUNT(*)::text FROM alpha_telemetry a
               WHERE a.user_id=t.worker_id AND a.task_id=t.id
                  AND a.event_group='trust_delta_applied') AS trust_telemetry,
              (SELECT f.state FROM hxos_fake_financial_operation_events_v1 f
               WHERE f.operation_id=$2 AND f.operation_kind='PAYOUT'
               ORDER BY f.event_version DESC LIMIT 1) AS fake_payout_state,
              (SELECT f.state FROM hxos_fake_financial_operation_events_v1 f
               WHERE f.operation_id=$4 AND f.operation_kind='RECONCILE'
               ORDER BY f.event_version DESC LIMIT 1) AS fake_reconciliation_state
       FROM escrows e
       JOIN tasks t ON t.id=e.task_id
       LEFT JOIN verification_earnings_tracking vt ON vt.user_id=t.worker_id
       WHERE e.id=$1`,
      [escrowId, payout.operationId, proof.id, fakeReconciliation.operationId],
    );
    expect(accounting.rows[0]).toEqual({
      escrow_state: 'RELEASED',
      transfer_id: compatibilityTransfer.transferId,
      stripe_transfer_id: null,
      payout_provider: 'LOCAL_CERTIFICATION_TEST',
      compatibility_security_reference: secured.externalReference,
      task_state: 'COMPLETED',
      progress_state: 'CLOSED',
      release_events: '1',
      release_outbox: '1',
      insurance_rows: '1',
      insurance_cents: String(INSURANCE_CENTS),
      verification_rows: '1',
      verification_cents: String(NET_WORKER_PAYOUT_CENTS),
      verification_total: NET_WORKER_PAYOUT_CENTS,
      verification_tasks: 1,
      verification_unlocked: false,
      verification_notified: false,
      unlock_notifications: '0',
      xp_rows: '1',
      xp_base: '500',
      xp_effective: '750',
      platform_fee_rows: '1',
      platform_fee: String(PLATFORM_FEE_CENTS),
      ledger_gross: String(CUSTOMER_TOTAL_CENTS),
      ledger_net: String(GROSS_WORKER_PAYOUT_CENTS),
      pool_deposits: initialPoolDeposits + INSURANCE_CENTS,
      judge_decisions: '1',
      judge_overrides: '1',
      trust_telemetry: '2',
      fake_payout_state: 'SUCCEEDED',
      fake_reconciliation_state: 'MATCHED',
    });
    expect(
      Number(accounting.rows[0].platform_fee)
      + Number(accounting.rows[0].insurance_cents)
      + Number(accounting.rows[0].verification_cents),
    ).toBe(CUSTOMER_TOTAL_CENTS);

    const financialEvidence = await db.query<{
      operation_count: number;
      event_count: number;
      fake_provider_count: number;
    }>(
      `SELECT COUNT(DISTINCT operation.operation_id)::integer AS operation_count,
              COUNT(*)::integer AS event_count,
              COUNT(*) FILTER (WHERE operation.provider_kind='FAKE')::integer AS fake_provider_count
       FROM hxos_fake_financial_operations_v1 operation
       JOIN hxos_fake_financial_operation_events_v1 event
         ON event.operation_id=operation.operation_id
       WHERE operation.operation_id=ANY($1::uuid[])`,
      [Object.values(financialOperationIds)],
    );
    expect(financialEvidence.rows[0]).toEqual({
      operation_count: Object.keys(financialOperationIds).length,
      event_count: Object.keys(financialOperationIds).length,
      fake_provider_count: Object.keys(financialOperationIds).length,
    });
    const stripeEventsAfter = await db.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM stripe_events',
    );
    expect(stripeEventsAfter.rows[0].count).toBe(stripeEventsBefore.rows[0].count);

    const providerPayoutIds = [
      `po_e2e_failed_${runId.replaceAll('-', '')}`,
      `po_e2e_retry_${runId.replaceAll('-', '')}`,
    ];
    let providerAttempt = 0;
    const provider: WalletProvider = {
      providerKind: 'FAKE',
      isConfigured: () => true,
      getSnapshot: async (accountId) => ({
        accountId,
        payoutsEnabled: true,
        disabledReason: null,
        availableCents: NET_WORKER_PAYOUT_CENTS,
        pendingCents: 0,
        destination: {
          type: 'bank_account',
          last4: '4242',
          label: 'HX E2E Bank •••• 4242',
          providerId: `ba_e2e_${runId}`,
          status: 'verified',
        },
        payouts: [],
        payoutHistoryComplete: true,
        capturedAt: new Date().toISOString(),
      }),
      createStandardPayout: async (input) => {
        expect(input).toMatchObject({ amountCents: NET_WORKER_PAYOUT_CENTS, workerId });
        return {
          providerPayoutId: providerPayoutIds[providerAttempt++]!,
          state: 'submitted',
          estimatedArrivalAt: new Date(Date.now() + 2 * 24 * 60 * 60_000).toISOString(),
          failureCode: null,
          failureMessage: null,
        };
      },
    };
    const cashOut = successData(await HustlerWalletService.requestCashOut({
      workerId,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      idempotencyKey: cashOutKey,
    }, provider), 'cash out');
    expect(cashOut).toMatchObject({
      state: 'submitted', amountCents: NET_WORKER_PAYOUT_CENTS, feeCents: 0, netCents: NET_WORKER_PAYOUT_CENTS,
    });
    expect(successData(await HustlerWalletService.requestCashOut({
      workerId,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      idempotencyKey: cashOutKey,
    }, provider), 'cash out replay').id).toBe(cashOut.id);
    await expect(HustlerWalletService.requestCashOut({
      workerId,
      amountCents: NET_WORKER_PAYOUT_CENTS - 1,
      idempotencyKey: cashOutKey,
    }, provider)).resolves.toMatchObject({ success: false, error: { code: 'IDEMPOTENCY_CONFLICT' } });

    // HustlerWalletService's transitional DTO still names the provider event
    // reference stripeEventId. These values belong to the FAKE provider and are
    // never written to stripe_events; the zero-Stripe-event assertion below
    // keeps that compatibility boundary executable.
    const failedEvent = {
      stripeEventId: `evt_payout_failed_${runId}`,
      providerPayoutId: providerPayoutIds[0]!,
      state: 'failed' as const,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      accountId: `acct_e2e_${runId.replaceAll('-', '')}`,
      requestId: cashOut.id,
      estimatedArrivalAt: null,
      failureCode: 'bank_account_closed',
      failureMessage: 'The destination bank account is closed.',
    };
    await expect(HustlerWalletService.syncProviderPayoutEvent({
      ...failedEvent,
      stripeEventId: `evt_payout_wrong_amount_${runId}`,
      amountCents: NET_WORKER_PAYOUT_CENTS - 1,
    })).rejects.toThrow('PAYOUT_EVENT_AMOUNT_MISMATCH');
    expect(await HustlerWalletService.syncProviderPayoutEvent(failedEvent)).toEqual({ matched: true, workerId });
    expect(await HustlerWalletService.syncProviderPayoutEvent(failedEvent)).toEqual({ matched: true, workerId });

    const retry = successData(await HustlerWalletService.requestCashOut({
      workerId,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      idempotencyKey: cashOutRetryKey,
    }, provider), 'cash out retry');
    expect(retry).toMatchObject({
      state: 'submitted', amountCents: NET_WORKER_PAYOUT_CENTS, feeCents: 0, netCents: NET_WORKER_PAYOUT_CENTS,
    });
    expect(retry.id).not.toBe(cashOut.id);
    expect(successData(await HustlerWalletService.requestCashOut({
      workerId,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      idempotencyKey: cashOutRetryKey,
    }, provider), 'cash out retry replay').id).toBe(retry.id);

    const paidEvent = {
      stripeEventId: `evt_payout_paid_${runId}`,
      providerPayoutId: providerPayoutIds[1]!,
      state: 'paid' as const,
      amountCents: NET_WORKER_PAYOUT_CENTS,
      accountId: `acct_e2e_${runId.replaceAll('-', '')}`,
      requestId: retry.id,
      estimatedArrivalAt: null,
      failureCode: null,
      failureMessage: null,
    };
    expect(await HustlerWalletService.syncProviderPayoutEvent(paidEvent)).toEqual({ matched: true, workerId });
    expect(await HustlerWalletService.syncProviderPayoutEvent(paidEvent)).toEqual({ matched: true, workerId });
    expect(await HustlerWalletService.syncProviderPayoutEvent({
      ...paidEvent,
      stripeEventId: `evt_payout_stale_${runId}`,
      state: 'provider_processing',
    })).toEqual({ matched: true, workerId });
    const lateFailure = {
      ...paidEvent,
      stripeEventId: `evt_payout_late_failure_${runId}`,
      state: 'failed' as const,
      failureCode: 'bank_returned',
      failureMessage: 'The bank returned the payout after the provider marked it paid.',
    };
    expect(await HustlerWalletService.syncProviderPayoutEvent(lateFailure)).toEqual({ matched: true, workerId });
    expect(await HustlerWalletService.syncProviderPayoutEvent(lateFailure)).toEqual({ matched: true, workerId });

    await expect(db.query(
      `UPDATE worker_cash_out_requests SET provider_payout_id=$2 WHERE id=$1`,
      [retry.id, `po_tamper_${runId}`],
    )).rejects.toThrow(/HXWAL7/u);
    await expect(db.query(
      `UPDATE worker_cash_out_requests
       SET last_transition_source='PROVIDER_WEBHOOK',last_provider_event_id=$2
       WHERE id=$1`,
      [retry.id, `evt_unreconciled_${runId}`],
    )).rejects.toThrow(/HXWAL8/u);

    const cashOutEvidence = await db.query<{
      id: string;
      state: string;
      events: Array<{ event: string; reported: string | null; disposition: string; cents: number }>;
    }>(
      `SELECT r.id::text,r.state,
              jsonb_agg(jsonb_build_object(
                'event',e.event_type,
                'reported',e.provider_reported_state,
                'disposition',e.disposition,
                'cents',e.amount_cents
              ) ORDER BY e.created_at,e.id) AS events
       FROM worker_cash_out_requests r
       JOIN worker_cash_out_events e ON e.cash_out_request_id=r.id
       WHERE r.id IN ($1,$2)
       GROUP BY r.id,r.state
       ORDER BY r.created_at`,
      [cashOut.id, retry.id],
    );
    expect(cashOutEvidence.rows).toEqual([
      {
        id: cashOut.id,
        state: 'FAILED',
        events: [
          { event: 'INITIATING', reported: null, disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'SUBMITTED', reported: 'SUBMITTED', disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'FAILED', reported: 'FAILED', disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
        ],
      },
      {
        id: retry.id,
        state: 'REVERSED',
        events: [
          { event: 'INITIATING', reported: null, disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'SUBMITTED', reported: 'SUBMITTED', disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'PAID', reported: 'PAID', disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'PAID', reported: 'PROVIDER_PROCESSING', disposition: 'IGNORED_STALE', cents: NET_WORKER_PAYOUT_CENTS },
          { event: 'REVERSED', reported: 'FAILED', disposition: 'APPLIED', cents: NET_WORKER_PAYOUT_CENTS },
        ],
      },
    ]);
    expect(providerAttempt).toBe(2);

    const walletAfterRecovery = successData(
      await HustlerWalletService.getOverview(workerId, provider),
      'wallet after failure recovery',
    );
    expect(walletAfterRecovery.activeCashOut).toBeNull();
    expect(walletAfterRecovery.recentCashOuts.slice(0, 2).map((item) => item.state)).toEqual([
      'reversed', 'failed',
    ]);
    expect(walletAfterRecovery.recentCashOuts[0]).toMatchObject({
      amountCents: NET_WORKER_PAYOUT_CENTS,
      feeCents: 0,
      netCents: NET_WORKER_PAYOUT_CENTS,
    });

    const lifecycle = successData(await AutomationLifecycleReadService.listTasks({ limit: 100 }), 'lifecycle read')
      .tasks.find((item) => item.engineTaskId === taskId);
    expect(lifecycle).toMatchObject({
      taskState: 'COMPLETED',
      progressState: 'CLOSED',
      escrowState: 'RELEASED',
      payoutState: 'RELEASED',
      blockerCode: null,
      nextAutomaticAction: null,
      automationClassification: 'CONTROLLED_TEST',
    });

    await expect(db.query("UPDATE escrows SET state='REFUNDED' WHERE id=$1", [escrowId]))
      .rejects.toMatchObject({ code: 'HX002' });
    await expect(db.query("UPDATE tasks SET title='Forbidden terminal rewrite' WHERE id=$1", [taskId]))
      .rejects.toMatchObject({ code: 'HX001' });
    const terminal = await db.query<{ escrow_state: string; task_title: string }>(
      `SELECT e.state AS escrow_state,t.title AS task_title
       FROM escrows e JOIN tasks t ON t.id=e.task_id WHERE e.id=$1`,
      [escrowId],
    );
    expect(terminal.rows[0]).toEqual({
      escrow_state: 'RELEASED', task_title: createParams.title,
    });

    console.log(JSON.stringify({
      evidence: 'HXOS_CANONICAL_LIFECYCLE',
      runId,
      taskId,
      escrowId,
      proofId: proof.id,
      cashOutId: cashOut.id,
      cashOutRetryId: retry.id,
      fakeFinancialOperationIds: financialOperationIds,
      fakePayoutExternalReference: payout.externalReference,
      compatibilityTransferId: compatibilityTransfer.transferId,
      stripeEventsCreated: stripeEventsAfter.rows[0].count - stripeEventsBefore.rows[0].count,
    }));
  }, 60_000);

  it('persists provider-account refresh with replay, conflict, concurrency, and no external effect', async () => {
    const fakeRuntime = authorizedFakeFinanceRuntime();
    expect(newPaymentCreationHealth(fakeRuntime.environment)).toMatchObject({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      permitsRealSettlement: false,
      permitsProviderPayouts: false,
    });
    const provider = createDatabaseBackedFakeFinancialProvider(
      db,
      fakeRuntime.environment,
      fakeRuntime.release,
      fakeRuntime.identity,
    );
    const refreshRunId = randomUUID();
    const providerId = `synthetic-provider-${refreshRunId}`;
    const operationIds = {
      onboarding: randomUUID(),
      refresh: randomUUID(),
      failedRefresh: randomUUID(),
    };
    const stripeEventsBefore = await db.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM stripe_events',
    );

    const onboarding = await provider.onboardProvider({
      operationId: operationIds.onboarding,
      idempotencyKey: `refresh:${refreshRunId}:onboarding`,
      expectedVersion: 0,
      providerId,
    });
    expect(onboarding).toMatchObject({
      operationKind: 'ONBOARD_PROVIDER',
      providerKind: 'FAKE',
      state: 'SUCCEEDED',
      idempotencyReplayed: false,
    });

    const refreshCommand = {
      operationId: operationIds.refresh,
      idempotencyKey: `refresh:${refreshRunId}:enabled`,
      expectedVersion: 0,
      providerId,
      providerAccountReference: onboarding.externalReference,
    } as const;
    const refreshAttempts = await Promise.all([
      provider.refreshProviderAccountState(refreshCommand),
      provider.refreshProviderAccountState(refreshCommand),
    ]);
    expect(refreshAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
        accountState: 'ENABLED',
        chargesEnabled: true,
        payoutsEnabled: true,
        idempotencyReplayed: false,
      }),
      expect.objectContaining({
        operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
        accountState: 'ENABLED',
        chargesEnabled: true,
        payoutsEnabled: true,
        idempotencyReplayed: true,
      }),
    ]));
    await expect(provider.refreshProviderAccountState(refreshCommand)).resolves.toMatchObject({
      idempotencyReplayed: true,
      accountState: 'ENABLED',
    });
    await expect(provider.refreshProviderAccountState({
      ...refreshCommand,
      providerId: `${providerId}-substituted`,
    })).rejects.toThrow('FAKE_FINANCIAL_IDEMPOTENCY_CONFLICT');

    const failedRefresh = await provider.refreshProviderAccountState({
      operationId: operationIds.failedRefresh,
      idempotencyKey: `refresh:${refreshRunId}:failed`,
      expectedVersion: 0,
      providerId,
      providerAccountReference: onboarding.externalReference,
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
    });
    expect(failedRefresh).toMatchObject({
      operationKind: 'REFRESH_PROVIDER_ACCOUNT_STATE',
      state: 'FAILED',
      accountState: 'FAILED',
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsDue: ['identity_verification'],
    });

    const persisted = await db.query<{
      operation_count: number;
      event_count: number;
      refresh_count: number;
      failed_refresh_count: number;
      fake_provider_count: number;
    }>(
      `SELECT COUNT(DISTINCT operation.operation_id)::integer AS operation_count,
              COUNT(*)::integer AS event_count,
              COUNT(*) FILTER (
                WHERE operation.operation_kind='REFRESH_PROVIDER_ACCOUNT_STATE'
              )::integer AS refresh_count,
              COUNT(*) FILTER (
                WHERE operation.operation_kind='REFRESH_PROVIDER_ACCOUNT_STATE'
                  AND event.state='FAILED'
              )::integer AS failed_refresh_count,
              COUNT(*) FILTER (WHERE operation.provider_kind='FAKE')::integer
                AS fake_provider_count
       FROM hxos_fake_financial_operations_v1 operation
       JOIN hxos_fake_financial_operation_events_v1 event
         ON event.operation_id=operation.operation_id
       WHERE operation.operation_id=ANY($1::uuid[])`,
      [Object.values(operationIds)],
    );
    expect(persisted.rows[0]).toEqual({
      operation_count: 3,
      event_count: 3,
      refresh_count: 2,
      failed_refresh_count: 1,
      fake_provider_count: 3,
    });
    const migrationEvidence = await db.query<{
      schema_digest: string;
      applied_digest: string;
    }>(
      `SELECT evidence.migration_sql_sha256 AS schema_digest,
              applied.sha256 AS applied_digest
       FROM hxos_fake_financial_schema_evidence_v2 evidence
       JOIN applied_migrations applied ON applied.name=evidence.migration_name
       WHERE evidence.migration_name='20260903_fake_financial_provider_account_refresh_v2'`,
    );
    expect(migrationEvidence.rows[0]?.schema_digest.trim()).toMatch(/^[0-9a-f]{64}$/u);
    expect(migrationEvidence.rows[0]?.applied_digest.trim()).toBe(
      migrationEvidence.rows[0]?.schema_digest.trim(),
    );

    const stripeEventsAfter = await db.query<{ count: number }>(
      'SELECT COUNT(*)::integer AS count FROM stripe_events',
    );
    expect(stripeEventsAfter.rows[0].count).toBe(stripeEventsBefore.rows[0].count);
  }, 30_000);
});
