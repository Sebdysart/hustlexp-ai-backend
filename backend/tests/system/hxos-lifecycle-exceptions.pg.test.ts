import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db.js';
import { ControlledTestDurationEvidenceService } from '../../src/services/ControlledTestDurationEvidenceService.js';
import { ControlledTestLiquidityService } from '../../src/services/ControlledTestLiquidityService.js';
import { ControlledTestOfferReviewService } from '../../src/services/ControlledTestOfferReviewService.js';
import { ControlledTestProviderCapabilityService } from '../../src/services/ControlledTestProviderCapabilityService.js';
import { DispatchExpiryService } from '../../src/services/DispatchExpiryService.js';
import { DisputeService } from '../../src/services/DisputeService.js';
import { EscrowService } from '../../src/services/EscrowService.js';
import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService.js';
import { LocalCertificationIdentityProvider } from '../../src/services/LocalCertificationIdentityProvider.js';
import { LocalCertificationPayoutProvider } from '../../src/services/LocalCertificationPayoutProvider.js';
import { LocalCertificationScreeningProvider } from '../../src/services/LocalCertificationScreeningProvider.js';
import { ProofService } from '../../src/services/ProofService.js';
import { advanceControlledReservationWaves } from '../../src/services/RecurringWorkService.js';
import { TaskLocationService } from '../../src/services/TaskLocationService.js';
import { TaskReservationService } from '../../src/services/TaskReservationService.js';
import { TaskScopeService } from '../../src/services/TaskScopeService.js';
import { TaskService } from '../../src/services/TaskService.js';
import type { CreateTaskParams } from '../../src/services/TaskServiceShared.js';
import { UnattendedCompletionSweepService } from '../../src/services/UnattendedCompletionSweepService.js';
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
const HUSTLER_PAYOUT_CENTS = 4_000;

function assertDisposableDatabase(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
  const disposableName = /(?:e2e|test|startup)/i.test(parsed.pathname.slice(1));
  if (!loopback || !disposableName) {
    throw new Error(`Refusing lifecycle exception test against ${parsed.hostname}/${parsed.pathname.slice(1)}`);
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

describePg('HX/OS PostgreSQL lifecycle exceptions', () => {
  const databaseUrl = process.env.DATABASE_URL ?? '';
  const runId = randomUUID();
  const runLetters = runId.replace(/[^a-f]/gu, '').slice(0, 8).padEnd(8, 'x');
  const posterId = randomUUID();
  const firstWorkerId = randomUUID();
  const secondWorkerId = randomUUID();
  const adminId = randomUUID();
  const phoneSeed = Number(String(Date.now()).slice(-7));
  const taskServiceCities = new Map<string, string>();

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    await db.query('SELECT 1');
    const phone = (offset: number) => `+1555${String((phoneSeed + offset) % 10_000_000).padStart(7, '0')}`;
    await db.query(
      `INSERT INTO users(
         id,email,full_name,default_mode,date_of_birth,is_minor,is_verified,phone,
         account_status,trust_tier,trust_hold,is_banned,plan,
         stripe_connect_id,stripe_connect_status,payouts_enabled,charges_enabled
       ) VALUES
         ($1,$2,'HX Exception Poster','poster','1990-01-01',FALSE,FALSE,$9,'ACTIVE',2,FALSE,FALSE,'free',NULL,NULL,FALSE,FALSE),
         ($3,$4,'HX Exception Worker One','worker','1990-01-01',FALSE,FALSE,$10,'ACTIVE',2,FALSE,FALSE,'free',$7,'complete',TRUE,TRUE),
         ($5,$6,'HX Exception Worker Two','worker','1990-01-01',FALSE,FALSE,$11,'ACTIVE',2,FALSE,FALSE,'free',$8,'complete',TRUE,TRUE),
         ($12,$13,'HX Exception Admin','poster','1990-01-01',FALSE,FALSE,$14,'ACTIVE',3,FALSE,FALSE,'free',NULL,NULL,FALSE,FALSE)`,
      [
        posterId,
        `poster-${runId}@exceptions.invalid`,
        firstWorkerId,
        `worker-one-${runId}@exceptions.invalid`,
        secondWorkerId,
        `worker-two-${runId}@exceptions.invalid`,
        `acct_exception_one_${runId.replaceAll('-', '')}`,
        `acct_exception_two_${runId.replaceAll('-', '')}`,
        phone(0),
        phone(1),
        phone(2),
        adminId,
        `admin-${runId}@exceptions.invalid`,
        phone(3),
      ],
    );
    await db.query(
      `INSERT INTO capability_profiles(
         user_id,trust_tier,risk_clearance,location_state,location_city,updated_at
       ) VALUES
         ($1,2,ARRAY['low','medium']::text[],'WA','Seattle',NOW()),
         ($2,2,ARRAY['low','medium']::text[],'WA','Seattle',NOW())`,
      [firstWorkerId, secondWorkerId],
    );
    await verifyControlledTestIdentity(firstWorkerId, `exceptions-worker-one-${runId}`);
    await verifyControlledTestIdentity(secondWorkerId, `exceptions-worker-two-${runId}`);
    await prepareControlledTestProvider(firstWorkerId, phone(1), `exceptions-worker-one-${runId}`);
    await prepareControlledTestProvider(secondWorkerId, phone(2), `exceptions-worker-two-${runId}`);
    await db.query(
      `INSERT INTO admin_roles(user_id,role,can_resolve_disputes)
       VALUES ($1,'admin',TRUE)`,
      [adminId],
    );
  });

  afterAll(async () => {
    if (enabled) await db.close();
  });

  async function createFundedTask(label: string): Promise<{ taskId: string; escrowId: string; location: string }> {
    const taskKey = `${label}-${runId}`;
    const serviceCity = `Seattle ${label.replace(/[^a-z]/gu, ' ')} ${runLetters}`.replace(/\s+/gu, ' ').trim();
    const location = `101 ${label.replaceAll('-', ' ')} Avenue, Seattle, WA 98101`;
    const params: CreateTaskParams = {
      posterId,
      title: `HX exception ${label}`,
      description: `Controlled lifecycle exception task for ${label}.`,
      price: CUSTOMER_TOTAL_CENTS,
      hustlerPayoutCents: HUSTLER_PAYOUT_CENTS,
      platformMarginCents: CUSTOMER_TOTAL_CENTS - HUSTLER_PAYOUT_CENTS,
      requirements: 'Complete the approved checklist exactly.',
      location,
      roughArea: `${serviceCity}, WA`,
      regionCode: 'US-WA',
      category: 'moving',
      deadline: new Date(Date.now() + 4 * 60 * 60_000),
      dispatchExpiresAt: new Date(Date.now() + 60 * 60_000),
      requiresProof: true,
      riskLevel: 'LOW',
      mode: 'STANDARD',
      automationClassification: 'CONTROLLED_TEST',
      proofSteps: ['Inspect the approved work area.', 'Complete the approved work.'],
      estimatedDurationMinutes: 60,
      requiredTools: ['general hand tools'],
      clientIdempotencyKey: taskKey,
    };
    const task = successData(await TaskService.create(params), `${label} create`);
    taskServiceCities.set(task.id, serviceCity);
    const escrowResult = await db.query<{ id: string }>('SELECT id FROM escrows WHERE task_id=$1', [task.id]);
    const escrowId = escrowResult.rows[0].id;
    successData(await EscrowService.fund({
      escrowId,
      stripePaymentIntentId: `pi_exception_${label}_${runId.replaceAll('-', '')}`,
    }), `${label} fund`);
    return { taskId: task.id, escrowId, location };
  }

  async function prepareTaskForWorker(taskId: string, workerId: string, label: string): Promise<void> {
    const serviceCity = taskServiceCities.get(taskId);
    if (!serviceCity) throw new Error(`Missing controlled TEST service city for ${taskId}`);
    await db.query(
      `UPDATE capability_profiles
          SET location_state='WA',location_city=$2,updated_at=NOW()
        WHERE user_id=$1`,
      [workerId, serviceCity],
    );
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
      idempotencyKey: `${label}-duration-${runId}`,
    }), `${label} duration evidence`);
    successData(await ControlledTestProviderCapabilityService.record({
      taskId,
      workerId,
      actorId: workerId,
      sourceHustlerId: workerId,
      category: 'moving',
      tools: ['general hand tools'],
      serviceCity,
      serviceState: 'WA',
      serviceRadiusMiles: 10,
      sourcePolicyVersion: 'hxos-exception-capability-test-v1',
      sourceEvidenceHash: 'c'.repeat(64),
      sourceExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
      idempotencyKey: `${label}-capability-${runId}`,
    }), `${label} provider capability`);
    successData(await ControlledTestLiquidityService.prepareAndBind({
      taskId,
      workerId,
      actorId: workerId,
      idempotencyKey: `${label}-liquidity-${runId}`,
    }), `${label} liquidity`);
    const reviewed = successData(await ControlledTestOfferReviewService.review({
      taskId,
      workerId,
      idempotencyKey: `${label}-offer-viewed-${runId}`,
    }), `${label} offer review`);
    successData(await ControlledTestOfferReviewService.accept({
      taskId,
      workerId,
      offerDecisionId: reviewed.offerDecisionId,
      idempotencyKey: `${label}-offer-accepted-${runId}`,
    }), `${label} offer accept`);
  }

  async function reserveAndStart(taskId: string, workerId: string, label: string): Promise<void> {
    await prepareTaskForWorker(taskId, workerId, label);
    successData(await TaskReservationService.reserve({
      engineTaskId: taskId,
      hustlerRef: workerId,
      idempotencyKey: `reserve-${label}-${runId}`,
      actorId: workerId,
    }), `${label} reserve`);
    successData(await TaskService.advanceProgress({
      taskId,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: workerId },
    }), `${label} traveling`);
    successData(await TaskService.startWork(taskId, workerId), `${label} start`);
  }

  async function completeChecklist(taskId: string, workerId: string): Promise<{ id: string; hash: string }> {
    const scope = await TaskScopeService.getForParticipant(taskId, workerId);
    expect(scope).toMatchObject({ legacy: false });
    for (const item of scope.checklist) {
      await TaskScopeService.setChecklistItem({
        taskId,
        workerId,
        versionId: scope.version!.id,
        itemIndex: item.itemIndex,
        completed: true,
      });
    }
    return { id: scope.version!.id, hash: scope.version!.hash };
  }

  async function submitTaskProof(params: {
    taskId: string;
    workerId: string;
    scope: { id: string; hash: string };
    label: string;
    gps?: boolean;
  }) {
    const mediaReceiptIds = [randomUUID(), randomUUID()];
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
          params.taskId,
          params.workerId,
          `quarantine/proof/${params.taskId}/${params.workerId}/${mediaReceiptId}.jpg`,
          `media/proof/${params.taskId}/${params.workerId}/${mediaReceiptId}.jpg`,
          (index === 0 ? 'd' : 'e').repeat(64),
        ],
      );
    }
    const capturedAt = new Date().toISOString();
    return db.transaction(async (query) => {
      const proof = successData(await ProofService.submit({
        taskId: params.taskId,
        submitterId: params.workerId,
        description: `Completed evidence for ${params.label}.`,
        gpsLatitude: params.gps ? 47.6062 : undefined,
        gpsLongitude: params.gps ? -122.3321 : undefined,
        gpsAccuracyMeters: params.gps ? 8 : undefined,
        photoEvidence: mediaReceiptIds.map((uploadReceiptId, index) => ({
          uploadReceiptId,
          contentType: 'image/jpeg' as const,
          fileSizeBytes: 120_000,
          checksumSha256: (index === 0 ? 'd' : 'e').repeat(64),
          capturedAt,
        })),
        scopeVersionId: params.scope.id,
        scopeHash: params.scope.hash,
        clientSubmissionId: `proof-${params.label}-${runId}`,
      }, query), `${params.label} proof`);
      successData(await TaskService.submitProof(params.taskId, query), `${params.label} proof transition`);
      return proof;
    });
  }

  async function reviewTaskProof(params: {
    taskId: string;
    workerId: string;
    proofId: string;
    decision: 'ACCEPTED' | 'REJECTED';
    reason?: string;
    label: string;
  }) {
    return successData(await ProofService.review({
      proofId: params.proofId,
      reviewerId: posterId,
      decision: params.decision,
      reason: params.reason,
    }, {
      signObject: async (key, expiresInSeconds) => {
        expect(key).toMatch(new RegExp(`^media/proof/${params.taskId}/${params.workerId}/`, 'u'));
        expect(expiresInSeconds).toBe(300);
        return `https://private-media.exceptions.invalid/${encodeURIComponent(key)}?signature=controlled-test`;
      },
    }), params.label);
  }

  it('proves race, privacy, scope, retake, dispute, timeout, and no-supply exceptions', async () => {
    const race = await createFundedTask('reservation-race');
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: race.taskId, workerId: firstWorkerId }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_NOT_RELEASED' } });
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: race.taskId, workerId: posterId }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_NOT_RELEASED' } });
    await prepareTaskForWorker(race.taskId, firstWorkerId, 'reservation-race');
    const contenders = await Promise.all([
      TaskReservationService.reserve({
        engineTaskId: race.taskId,
        hustlerRef: firstWorkerId,
        idempotencyKey: `race-one-${runId}`,
        actorId: firstWorkerId,
      }),
      TaskReservationService.reserve({
        engineTaskId: race.taskId,
        hustlerRef: firstWorkerId,
        idempotencyKey: `race-two-${runId}`,
        actorId: firstWorkerId,
      }),
    ]);
    expect(contenders.filter((result) => result.success)).toHaveLength(1);
    expect(contenders.filter((result) => !result.success)).toEqual([
      expect.objectContaining({ success: false, error: expect.objectContaining({ code: 'RESERVATION_CONFLICT' }) }),
    ]);
    const winnerId = firstWorkerId;
    const loserId = secondWorkerId;
    const reservationState = await db.query<{ worker_id: string; active_count: number }>(
      `SELECT t.worker_id,
              (SELECT COUNT(*)::int FROM task_reservations r WHERE r.task_id=t.id AND r.status='ACTIVE') AS active_count
       FROM tasks t WHERE t.id=$1`,
      [race.taskId],
    );
    expect(reservationState.rows[0]).toEqual({ worker_id: winnerId, active_count: 1 });
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: race.taskId, workerId: loserId }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_NOT_RELEASED' } });
    expect(successData(
      await TaskLocationService.releaseToReservedWorker({ taskId: race.taskId, workerId: winnerId }),
      'winner location release',
    )).toEqual({ exactLocation: race.location });
    const access = await db.query<{ worker_id: string; access_reason: string }>(
      'SELECT worker_id,access_reason FROM task_location_access_log WHERE task_id=$1',
      [race.taskId],
    );
    expect(access.rows).toEqual([{ worker_id: winnerId, access_reason: 'engine_reserved_worker' }]);
    successData(await TaskService.cancel(race.taskId, posterId), 'race cancel');
    const cancelledVault = await db.query<{
      expired_at: Date | null;
      expiration_reason: string;
      location_ciphertext: string | null;
    }>('SELECT expired_at,expiration_reason,location_ciphertext FROM task_location_vault WHERE task_id=$1', [race.taskId]);
    expect(cancelledVault.rows[0]).toMatchObject({
      expiration_reason: 'TASK_CANCELLED',
      location_ciphertext: null,
    });
    expect(cancelledVault.rows[0].expired_at).toBeInstanceOf(Date);
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: race.taskId, workerId: winnerId }))
      .resolves.toMatchObject({ success: false });

    const scopeTask = await createFundedTask('scope-retake');
    await reserveAndStart(scopeTask.taskId, winnerId, 'scope-retake');
    const initialScope = await TaskScopeService.getForParticipant(scopeTask.taskId, winnerId);
    const rejectedProposal = await TaskScopeService.proposeChange({
      taskId: scopeTask.taskId,
      userId: winnerId,
      observedScopeSummary: 'A third protected item is now in the approved area.',
      proposedChecklist: ['Inspect the approved work area.', 'Complete the approved work.', 'Protect the third item.'],
    });
    await expect(TaskScopeService.setChecklistItem({
      taskId: scopeTask.taskId,
      workerId: winnerId,
      versionId: initialScope.version!.id,
      itemIndex: 0,
      completed: true,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const rejected = await TaskScopeService.reviewChange({
      taskId: scopeTask.taskId,
      proposalId: rejectedProposal.id,
      posterId,
      decision: 'REJECTED',
      reason: 'The third item is outside the paid scope.',
    });
    expect(rejected).toMatchObject({ proposal: { status: 'REJECTED' }, version: null });
    const approvedProposal = await TaskScopeService.proposeChange({
      taskId: scopeTask.taskId,
      userId: winnerId,
      observedScopeSummary: 'The approved item needs one extra securing step.',
      proposedChecklist: ['Inspect the approved work area.', 'Complete the approved work.', 'Secure the approved item.'],
    });
    const approved = await TaskScopeService.reviewChange({
      taskId: scopeTask.taskId,
      proposalId: approvedProposal.id,
      posterId,
      decision: 'APPROVED',
      reason: 'This remains inside the funded work.',
    });
    expect(approved.version).toMatchObject({ version: 2, source: 'APPROVED_CHANGE' });
    const approvedScope = await completeChecklist(scopeTask.taskId, winnerId);
    await db.query('UPDATE tasks SET location_lat=$2,location_lng=$3 WHERE id=$1', [scopeTask.taskId, 47.6062, -122.3321]);
    const firstProof = await submitTaskProof({
      taskId: scopeTask.taskId,
      workerId: winnerId,
      scope: approvedScope,
      label: 'scope-retake-one',
      gps: true,
    });
    const gpsRow = await db.query<{ gps_coordinates: { latitude: number; longitude: number }; gps_accuracy_meters: string }>(
      'SELECT gps_coordinates,gps_accuracy_meters FROM proof_submissions WHERE proof_id=$1',
      [firstProof.id],
    );
    expect(gpsRow.rows[0]).toMatchObject({
      gps_coordinates: { latitude: 47.6062, longitude: -122.3321 },
    });
    expect(Number(gpsRow.rows[0].gps_accuracy_meters)).toBe(8);
    await reviewTaskProof({
      taskId: scopeTask.taskId,
      workerId: winnerId,
      proofId: firstProof.id,
      decision: 'REJECTED',
      reason: 'The final securing step is not visible.',
      label: 'reject first proof',
    });
    await expect(db.query(
      `UPDATE tasks SET state='ACCEPTED',worker_id=$2 WHERE id=$1`,
      [scopeTask.taskId, loserId],
    )).rejects.toThrow(/HXOR9|HXPC5|HXLQ9|HXWE/u);
    const protectedRetake = await db.query<{ state: string; worker_id: string }>(
      'SELECT state,worker_id FROM tasks WHERE id=$1',
      [scopeTask.taskId],
    );
    expect(protectedRetake.rows[0]).toEqual({ state: 'PROOF_SUBMITTED', worker_id: winnerId });
    successData(await TaskService.rejectProof(scopeTask.taskId, 'Retake the final securing step.'), 'retake transition');
    const secondProof = await submitTaskProof({
      taskId: scopeTask.taskId,
      workerId: winnerId,
      scope: approvedScope,
      label: 'scope-retake-two',
      gps: true,
    });
    await reviewTaskProof({
      taskId: scopeTask.taskId,
      workerId: winnerId,
      proofId: secondProof.id,
      decision: 'ACCEPTED',
      label: 'accept retake',
    });
    successData(await TaskService.complete(scopeTask.taskId, posterId, { mode: 'POSTER_CONFIRMED' }), 'retake completion');
    const proofStates = await db.query<{ id: string; state: string }>(
      'SELECT id,state FROM proofs WHERE task_id=$1 ORDER BY created_at,id',
      [scopeTask.taskId],
    );
    expect(proofStates.rows).toEqual([
      { id: firstProof.id, state: 'REJECTED' },
      { id: secondProof.id, state: 'ACCEPTED' },
    ]);

    const disputeTask = await createFundedTask('dispute-freeze');
    await reserveAndStart(disputeTask.taskId, winnerId, 'dispute-freeze');
    const disputeScope = await completeChecklist(disputeTask.taskId, winnerId);
    await submitTaskProof({
      taskId: disputeTask.taskId,
      workerId: winnerId,
      scope: disputeScope,
      label: 'dispute-freeze',
    });
    const dispute = successData(await DisputeService.create({
      taskId: disputeTask.taskId,
      escrowId: disputeTask.escrowId,
      initiatedBy: posterId,
      posterId,
      workerId: winnerId,
      reason: 'SCOPE_NOT_MET',
      description: 'The submitted evidence does not show the approved final step.',
    }), 'dispute create');
    const frozen = await db.query<{ task_state: string; escrow_state: string; dispute_state: string }>(
      `SELECT t.state AS task_state,e.state AS escrow_state,d.state AS dispute_state
       FROM tasks t JOIN escrows e ON e.task_id=t.id JOIN disputes d ON d.task_id=t.id
       WHERE t.id=$1`,
      [disputeTask.taskId],
    );
    expect(frozen.rows[0]).toEqual({
      task_state: 'DISPUTED',
      escrow_state: 'LOCKED_DISPUTE',
      dispute_state: 'OPEN',
    });
    await expect(TaskService.advanceProgress({
      taskId: disputeTask.taskId,
      to: 'COMPLETED',
      actor: { type: 'worker', userId: winnerId },
    })).resolves.toMatchObject({ success: false });
    successData(await DisputeService.resolve({
      disputeId: dispute.id,
      resolvedBy: adminId,
      resolution: 'POSTER_REFUND',
      resolutionNotes: 'Poster refund approved after human evidence review in the controlled exception test.',
      outcomeEscrowAction: 'REFUND',
      workerPenalty: false,
      posterPenalty: false,
    }), 'dispute resolve');
    const resolved = await db.query<{
      task_state: string;
      escrow_state: string;
      dispute_state: string;
      refund_requests: number;
    }>(
      `SELECT t.state AS task_state,e.state AS escrow_state,d.state AS dispute_state,
              (SELECT COUNT(*)::int FROM outbox_events o
               WHERE o.aggregate_id=e.id AND o.event_type='escrow.refund_requested'
                 AND o.payload->>'dispute_id'=d.id::text) AS refund_requests
       FROM tasks t JOIN escrows e ON e.task_id=t.id JOIN disputes d ON d.task_id=t.id
       WHERE t.id=$1`,
      [disputeTask.taskId],
    );
    expect(resolved.rows[0]).toEqual({
      task_state: 'CANCELLED',
      escrow_state: 'LOCKED_DISPUTE',
      dispute_state: 'RESOLVED',
      refund_requests: 1,
    });

    const timeoutTask = await createFundedTask('unattended-timeout');
    await reserveAndStart(timeoutTask.taskId, winnerId, 'unattended-timeout');
    const timeoutScope = await completeChecklist(timeoutTask.taskId, winnerId);
    const timeoutProof = await submitTaskProof({
      taskId: timeoutTask.taskId,
      workerId: winnerId,
      scope: timeoutScope,
      label: 'unattended-timeout',
    });
    await reviewTaskProof({
      taskId: timeoutTask.taskId,
      workerId: winnerId,
      proofId: timeoutProof.id,
      decision: 'ACCEPTED',
      label: 'timeout proof accept',
    });
    successData(await TaskService.recordCompletionDelivery({
      taskId: timeoutTask.taskId,
      providerDeliveryId: `delivery-${runId}`,
      channel: 'SMS',
      deliveredAt: new Date(Date.now() - 25 * 60 * 60_000),
      actorId: adminId,
    }), 'completion delivery');
    const timeoutSweep = await UnattendedCompletionSweepService.completeDue(100);
    expect(timeoutSweep.results).toContainEqual({ taskId: timeoutTask.taskId, status: 'completed' });
    const timeoutState = await db.query<{ state: string; payout_ready_reason: string; vault_expired: boolean }>(
      `SELECT t.state,t.payout_ready_reason,(v.expired_at IS NOT NULL AND v.location_ciphertext IS NULL) AS vault_expired
       FROM tasks t JOIN task_location_vault v ON v.task_id=t.id WHERE t.id=$1`,
      [timeoutTask.taskId],
    );
    expect(timeoutState.rows[0]).toEqual({
      state: 'COMPLETED',
      payout_ready_reason: 'unattended_policy',
      vault_expired: true,
    });
    expect((await UnattendedCompletionSweepService.completeDue(100)).results)
      .not.toContainEqual(expect.objectContaining({ taskId: timeoutTask.taskId }));

    const noSupply = await createFundedTask('no-supply-expiry');
    await db.query(
      `UPDATE tasks SET dispatch_expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`,
      [noSupply.taskId],
    );
    const expiryKey = `dispatch-expiry-${runId}`;
    expect(successData(await DispatchExpiryService.expireUnfilled({
      engineTaskId: noSupply.taskId,
      idempotencyKey: expiryKey,
    }), 'no-supply expiry')).toMatchObject({
      lifecycleState: 'EXPIRED_UNFILLED',
      refundState: 'PENDING',
      idempotencyReplayed: false,
    });
    expect(successData(await DispatchExpiryService.expireUnfilled({
      engineTaskId: noSupply.taskId,
      idempotencyKey: expiryKey,
    }), 'no-supply replay')).toMatchObject({ idempotencyReplayed: true });
    const expired = await db.query<{
      task_state: string;
      expiration_reason: string;
      escrow_state: string;
      refund_state: string;
      refund_requests: number;
      vault_expired: boolean;
    }>(
      `SELECT t.state AS task_state,t.expiration_reason,e.state AS escrow_state,t.refund_state,
              (SELECT COUNT(*)::int FROM outbox_events o
               WHERE o.aggregate_id=e.id AND o.event_type='escrow.refund_requested') AS refund_requests,
              (v.expired_at IS NOT NULL AND v.location_ciphertext IS NULL) AS vault_expired
       FROM tasks t JOIN escrows e ON e.task_id=t.id JOIN task_location_vault v ON v.task_id=t.id
       WHERE t.id=$1`,
      [noSupply.taskId],
    );
    expect(expired.rows[0]).toEqual({
      task_state: 'EXPIRED',
      expiration_reason: 'UNFILLED',
      escrow_state: 'LOCKED_DISPUTE',
      refund_state: 'PENDING',
      refund_requests: 1,
      vault_expired: true,
    });

    const warmBackup = await createFundedTask('warm-backup-wave');
    const seriesId = randomUUID();
    const revisionId = randomUUID();
    const occurrenceId = randomUUID();
    await db.query(
      `INSERT INTO recurring_task_series(
         id,poster_id,pattern,start_date,title,description,payment_cents,status,
         contract_version,backup_worker_ids,next_occurrence_at
       ) VALUES ($1,$2,'weekly',CURRENT_DATE,$3,$4,$5,'active',1,$6::uuid[],NOW())`,
      [
        seriesId,
        posterId,
        'Controlled warm-backup wave',
        'Proves sequential provider offer expiry without assignment leakage.',
        CUSTOMER_TOTAL_CENTS,
        [loserId],
      ],
    );
    await db.query(
      `INSERT INTO recurring_task_template_revisions(
         id,template_id,version,snapshot,snapshot_hash,change_reason,created_by
       ) VALUES ($1,$2,1,$3::jsonb,$4,$5,$6)`,
      [
        revisionId,
        seriesId,
        JSON.stringify({ title: 'Controlled warm-backup wave', contractVersion: 1 }),
        'c'.repeat(64),
        'Controlled exception fixture',
        posterId,
      ],
    );
    await db.query('UPDATE recurring_task_series SET current_revision_id=$2 WHERE id=$1', [seriesId, revisionId]);
    await db.query(
      `INSERT INTO recurring_task_occurrences(
         id,series_id,task_id,occurrence_number,scheduled_date,status,template_revision_id,
         scheduled_start,scheduled_end,customer_total_cents,provider_payout_cents,
         platform_margin_cents,reservation_state,generation_key
       ) VALUES ($1,$2,$3,1,CURRENT_DATE,'posted',$4,NOW(),NOW()+INTERVAL '1 hour',$5,$6,$7,
                 'PREFERRED_PENDING',$8)`,
      [
        occurrenceId,
        seriesId,
        warmBackup.taskId,
        revisionId,
        CUSTOMER_TOTAL_CENTS,
        HUSTLER_PAYOUT_CENTS,
        CUSTOMER_TOTAL_CENTS - HUSTLER_PAYOUT_CENTS,
        `warm-backup:${runId}`,
      ],
    );
    await db.query(
      `INSERT INTO recurring_provider_reservations(
         occurrence_id,worker_id,pool_type,wave_rank,status,expires_at
       ) VALUES ($1,$2,'PREFERRED',0,'PENDING',NOW()-INTERVAL '1 minute')`,
      [occurrenceId, winnerId],
    );
    const backupRace = await Promise.all([
      advanceControlledReservationWaves(1),
      advanceControlledReservationWaves(1),
    ]);
    expect(backupRace.reduce((sum, result) => sum + result.backupsOpened, 0)).toBe(1);
    expect(backupRace.reduce((sum, result) => sum + result.processed, 0)).toBe(1);
    const backupRows = await db.query<{
      worker_id: string;
      pool_type: string;
      wave_rank: number;
      status: string;
    }>(
      `SELECT worker_id,pool_type,wave_rank,status
       FROM recurring_provider_reservations WHERE occurrence_id=$1 ORDER BY wave_rank`,
      [occurrenceId],
    );
    expect(backupRows.rows).toEqual([
      { worker_id: winnerId, pool_type: 'PREFERRED', wave_rank: 0, status: 'TIMED_OUT' },
      { worker_id: loserId, pool_type: 'BACKUP', wave_rank: 1, status: 'PENDING' },
    ]);
    await expect(TaskLocationService.releaseToReservedWorker({ taskId: warmBackup.taskId, workerId: loserId }))
      .resolves.toMatchObject({ success: false, error: { code: 'LOCATION_NOT_RELEASED' } });
    await db.query(
      `UPDATE recurring_provider_reservations SET expires_at=NOW()-INTERVAL '1 minute'
       WHERE occurrence_id=$1 AND worker_id=$2`,
      [occurrenceId, loserId],
    );
    const exhaustionRace = await Promise.all([
      advanceControlledReservationWaves(1),
      advanceControlledReservationWaves(1),
    ]);
    expect(exhaustionRace.reduce((sum, result) => sum + result.exhausted, 0)).toBe(1);
    const exhaustedWave = await db.query<{ reservation_state: string; backup_status: string; failed_attempts: number }>(
      `SELECT o.reservation_state,r.status AS backup_status,s.failed_fulfillment_attempts AS failed_attempts
       FROM recurring_task_occurrences o
       JOIN recurring_task_series s ON s.id=o.series_id
       JOIN recurring_provider_reservations r ON r.occurrence_id=o.id AND r.worker_id=$2
       WHERE o.id=$1`,
      [occurrenceId, loserId],
    );
    expect(exhaustedWave.rows[0]).toEqual({
      reservation_state: 'EXHAUSTED',
      backup_status: 'TIMED_OUT',
      failed_attempts: 1,
    });
  }, 60_000);
});
