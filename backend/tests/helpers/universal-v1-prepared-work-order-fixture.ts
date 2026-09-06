import { randomUUID } from 'node:crypto';
import type { Client, Pool } from 'pg';
import type { Database } from '../../src/db.js';
import { createAcceptedEstimateFixture } from './universal-v1-accepted-estimate-fixture.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import { PostgresUniversalV1WorkOrderRepository } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from '../../src/services/UniversalV1WorkOrderPublicFacts.js';
import {
  UNIVERSAL_V1_ACTOR_ATTESTATION_PATH,
  type UniversalV1ActorAttestationHandle,
} from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  createUniversalV1ActorAttestationHandle,
  PostgresUniversalV1CanonicalRequestAuthority,
  UniversalV1ActorAttesterClient,
} from '../../src/services/UniversalV1ActorAttesterClient.js';
import { createUniversalV1ActorAttesterApp } from '../../src/services/UniversalV1ActorAttesterService.js';
import { PostgresUniversalV1ActorAssertionIssuer } from '../../src/services/UniversalV1ActorAssertionIssuer.js';

/** Disposable fixture: real attester/API database commands and in-process
 * attester HTTP transport; bearer verification and prerequisite facts are synthetic.
 * This helper never runs a provider or materializes a Work Order. */
export async function createSyntheticActorAttestation(
  owner: Pick<Pool, 'query'>,
  apiDatabase: Database,
  attester: Pick<Client, 'query'>,
  attesterRole: string,
  releaseManifestSha256: string,
  actorUserId: string
): Promise<UniversalV1ActorAttestationHandle> {
  const identity = await owner.query<{ firebase_uid: string }>(
    `SELECT firebase_uid FROM public.users WHERE id = $1`,
    [actorUserId]
  );
  const subject = identity.rows[0]?.firebase_uid;
  if (!subject) throw new Error('Exact actor fixture has no canonical subject');

  const clock = new Date();
  const transportSecret = 'work-order-real-attester-transport-secret-v1';
  const bearer = `real.firebase.bearer.${subject}`;
  const releaseBinding = () => ({
    environment: 'local' as const,
    releaseManifestSha256,
    backendRevision: 'c'.repeat(40),
    backendArtifactSha256: `sha256:${'d'.repeat(64)}`,
  });
  const attesterEnvironment = {
    HX_ENVIRONMENT: 'local',
    SERVICE_ROLE: 'attester',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    STRIPE_MODE: 'test',
    ENGINE_API_MODE: 'test',
    HX_EXTERNAL_VALUE: 'false',
    HX_ACTOR_ATTESTER_TRANSPORT_SECRET: transportSecret,
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: attesterRole,
  };
  const issuer = new PostgresUniversalV1ActorAssertionIssuer({
    env: attesterEnvironment,
    query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
      const result = await attester.query(sql, [...(parameters ?? [])]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  });
  const app = createUniversalV1ActorAttesterApp({
    env: attesterEnvironment,
    releaseBinding,
    verifyBearer: async (candidate) => {
      if (candidate !== bearer) throw new Error('Unexpected exact actor bearer');
      return {
        verifiedSubject: subject,
        issuer: 'https://securetoken.google.com/hustlexp-work-order-test',
        audience: 'hustlexp-work-order-test',
        authenticationTime: new Date(clock.getTime() - 10_000),
        bearerExpiresAt: new Date(clock.getTime() + 120_000),
        verifiedAt: clock,
        revocationCheckedAt: clock,
        authenticationMethods: ['password'],
        mfaVerified: false,
      };
    },
    issuer,
    now: () => clock,
  });
  const client = new UniversalV1ActorAttesterClient({
    env: {
      HX_ACTOR_ATTESTER_URL: `http://127.0.0.1:3002${UNIVERSAL_V1_ACTOR_ATTESTATION_PATH}`,
      HX_ACTOR_ATTESTER_TIMEOUT_MS: '2000',
      HX_ACTOR_ATTESTER_TRANSPORT_SECRET: transportSecret,
    },
    releaseBinding,
    canonicalAuthority: new PostgresUniversalV1CanonicalRequestAuthority(apiDatabase.query),
    fetch: async (input, init) => app.fetch(new Request(input, init)),
    now: () => clock,
  });
  return createUniversalV1ActorAttestationHandle(bearer, client);
}

export async function createPreparedWorkOrderFixture(
  ownerDatabase: Database,
  owner: Pick<Pool, 'query'>,
  apiDatabase: Database,
  attester: Pick<Client, 'query'>,
  attesterRole: string,
  releaseManifestSha256: string,
  label: string
) {
  const realActorAttestation = (actorUserId: string) =>
    createSyntheticActorAttestation(
      owner,
      apiDatabase,
      attester,
      attesterRole,
      releaseManifestSha256,
      actorUserId
    );

  const lane = await createAcceptedEstimateFixture(ownerDatabase, owner, label, false);
  const facts = new PostgresUniversalV1WorkOrderPublicFactReader(ownerDatabase.query);
  const repository = new PostgresUniversalV1WorkOrderRepository(apiDatabase);
  const application = new UniversalV1WorkOrderApplication(facts, repository);
  const interest = await application.expressProviderInterest(
    lane.providerUserId,
    {
      task_id: lane.taskId,
      expected_scope_version: lane.scopeVersion,
      idempotency_key: 'finance:interest:' + randomUUID(),
      client_ts: new Date().toISOString(),
    },
    await realActorAttestation(lane.providerUserId)
  );
  const hold = await application.placeConditionalHold(
    lane.posterUserId,
    {
      interest_application_id: interest.interest_application_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: 'finance:hold:' + randomUUID(),
      client_ts: new Date().toISOString(),
    },
    await realActorAttestation(lane.posterUserId)
  );
  const context = await facts.workOrder(lane.posterUserId, hold.conditional_hold_id);
  if (!context) throw Error('SYNTHETIC_HELD_CONTEXT_MISSING');
  const key = 'finance:work-order:' + randomUUID();
  const timestamp = new Date().toISOString();
  const assertion = await (
    await realActorAttestation(lane.posterUserId)
  ).issue({
    commandKind: 'PREPARE_FAKE_WORK_ORDER',
    commandPayload: {
      conditional_hold_id: hold.conditional_hold_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: key,
      client_timestamp_epoch_ms: Date.parse(timestamp),
    },
  });
  const phase = await repository.prepareMaterialization(
    context,
    key,
    assertion.actor_assertion_token,
    timestamp
  );
  if (phase.completed) throw Error('SYNTHETIC_PHASE_ALREADY_COMPLETED');
  return {
    lane: { ...lane, eligibilityDecisionId: phase.context.eligibility_decision_id },
    phase,
    key,
    interest,
    hold,
  };
}
