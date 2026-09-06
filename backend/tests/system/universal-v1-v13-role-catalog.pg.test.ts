import { PostgresUniversalV1ChangeOrderMaterialization } from '../../src/services/UniversalV1ChangeOrderMaterialization.js';
import {
  PostgresUniversalV1ChangeOrderRecoveryTerminals,
  type ChangeOrderTerminalCommand,
} from '../../src/services/UniversalV1ChangeOrderRecoveryTerminals.js';
import { PostgresUniversalV1ChangeOrderRecoveryCompensation } from '../../src/services/UniversalV1ChangeOrderRecoveryCompensation.js';
import { PostgresUniversalV1ChangeOrderReversalRequests } from '../../src/services/payment/UniversalV1ChangeOrderReversalRequest.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import { UniversalV1ChangeOrderApplication } from '../../src/services/UniversalV1ChangeOrderApplication.js';
import { PostgresUniversalV1ChangeOrderCommands } from '../../src/services/UniversalV1ChangeOrderCommands.js';
import type { ProposeUniversalV1ChangeOrderPublic } from '../../src/services/UniversalV1ChangeOrderContracts.js';
import { PostgresUniversalV1ChangeOrderRepository } from '../../src/services/UniversalV1ChangeOrderPostgresRepository.js';
import type { ExecuteUniversalV1FinancialEventCommand } from '../../src/services/payment/UniversalV1FinancialApplicationService.js';
import { PostgresUniversalV1WorkOrderRepository } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { createUniversalContractRouter } from '../../src/routers/universalContract.js';
import { PostgresUniversalV1WorkOrderHistoryReader } from '../../src/services/UniversalV1WorkOrderHistory.js';
import { PostgresUniversalV1FinancialPredecessorReader } from '../../src/services/payment/UniversalV1FinancialPredecessor.js';
import type { Database } from '../../src/db.js';
import { Hono } from 'hono';
import { syntheticFinancialWebhook } from '../../src/serverSyntheticFinancialWebhook.js';
import { decodeFakeFinancialMaterializationRow } from '../../src/jobs/fake-financial-materialization.js';
import { decodeFakeFinancialOutcomeRow } from '../../src/jobs/fake-financial-outcome.js';
import { decodeFakeFinancialProgressRow } from '../../src/jobs/fake-financial-progress.js';
import { once } from 'node:events';
import { db as runtimeDb } from '../../src/db.js';
import { Queue, QueueEvents, Worker } from 'bullmq';
import * as requestApplication from '../../src/services/payment/UniversalV1FinancialRequestService.js';
import { PostgresUniversalV1FinancialRequestProgressReader } from '../../src/services/payment/UniversalV1FinancialRequestProgress.js';
import {
  prepareFinancialProviderCommand,
  PostgresFinancialProviderCommandJournal,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import * as financialAuthorization from '../../src/services/payment/NonproductionFinancialAuthorization.js';
import * as manifestAuthority from '../../src/releaseManifest.js';
import * as databaseStartup from '../../src/jobs/runtime-database-startup-config.js';
import {
  FakeFinancialDurableRecovery,
  PostgresFakeFinancialDurableRecoveryRepository,
} from '../../src/jobs/fake-financial-durable-recovery.js';
import { SyntheticFinancialCommandProcessor } from '../../src/jobs/synthetic-financial-worker.js';
import {
  FakeFinancialOutboxPublisher,
  PostgresFakeFinancialOutboxRepository,
} from '../../src/jobs/fake-financial-outbox-publisher.js';
import { createFakeFinancialOutboxTransport } from '../../src/jobs/queues.js';
import { universalFinanceRouter } from '../../src/routers/syntheticFinance.js';
import type { Context } from '../../src/trpc.js';
import { deterministicUuid } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { FakeFinancialPreparationPayloadSchema } from '../../src/auth/financial-preparation-command-contract.js';
import {
  createPreparedWorkOrderFixture,
  createSyntheticActorAttestation,
} from '../helpers/universal-v1-prepared-work-order-fixture.js';
import { createClaimedTaskDraftFixture } from '../helpers/universal-v1-claimed-task-draft-fixture.js';
import { createAcceptedEstimateFixture } from '../helpers/universal-v1-accepted-estimate-fixture.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { canonicalFinancialProviderRequestJson } from '../../src/services/payment/FinancialProviderRequestCanonicalization.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  fakeFinancialWebhookSignedBytes,
  fakeFinancialWebhookAuthenticationEvidence,
} from '../../src/services/payment/FakeFinancialWebhookAuthentication.js';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { QueryFn } from '../../src/database-contracts.js';
import { PostgresUniversalV1ActorAssertionIssuer } from '../../src/services/UniversalV1ActorAssertionIssuer.js';
import type { UniversalV1CanonicalActorRequest } from '../../src/auth/universal-v1-actor-attestation-contracts.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
} from '../../src/serverStartupMigrations.js';
import {
  attestRuntimeDatabaseAuthority,
  runtimeDatabaseBuildProofDigest,
  runtimeDatabaseRoleTopologyDigest,
  runtimeDatabaseTargetDigest,
  type RuntimeDatabaseTargetBinding,
} from '../../src/jobs/runtime-database-authority.js';
import { createPgRuntimeDatabaseAuthorityAdapter } from '../../src/jobs/runtime-database-pg-adapter.js';
import { createRuntimeDatabaseDataPlane } from '../../src/jobs/runtime-database-data-plane.js';
import {
  createWorkOrderCommandAuthorityTransaction,
  verifyWorkOrderCommandAuthority,
  type WorkOrderCommandRoleNames,
} from '../../src/jobs/work-order-command-role-authority.js';
import {
  FAKE_FINANCIAL_OUTBOX_RELATIONS,
  FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
} from '../../src/jobs/fake-financial-outbox-role-plans.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { createUniversalV1DisposableDatabase } from '../helpers/universal-v1-disposable-database.js';
import { provisionUniversalV1SyntheticRoles } from '../helpers/universal-v1-synthetic-role-provisioning.js';

const describePg = describe.skipIf(!process.env.DATABASE_URL).sequential;
describePg('v13 complete eight-role PostgreSQL authority catalog', () => {
  let fixture: Awaited<ReturnType<typeof createUniversalV1DisposableDatabase>>;
  const suffix = randomUUID().replaceAll('-', '').slice(0, 20);
  const roles: WorkOrderCommandRoleNames = {
    migrationRole: `hx_ci_${suffix}_migration`,
    apiRole: `hx_ci_${suffix}_api`,
    workerRole: `hx_ci_${suffix}_worker`,
    attesterRole: `hx_ci_${suffix}_attester`,
    commandOwnerRole: `hx_ci_${suffix}_command`,
    assertionOwnerRole: `hx_ci_${suffix}_assertion`,
    financeOwnerRole: `hx_ci_${suffix}_finance`,
    telemetryOwnerRole: `hx_ci_${suffix}_telemetry`,
  };
  const environment = {
    HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: roles.migrationRole,
    HX_WORK_ORDER_API_DATABASE_ROLE: roles.apiRole,
    HX_WORK_ORDER_WORKER_DATABASE_ROLE: roles.workerRole,
    HX_WORK_ORDER_ATTESTER_DATABASE_ROLE: roles.attesterRole,
    HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: roles.commandOwnerRole,
    HX_WORK_ORDER_ASSERTION_OWNER_DATABASE_ROLE: roles.assertionOwnerRole,
    HX_FINANCE_COMMAND_OWNER_DATABASE_ROLE: roles.financeOwnerRole,
    HX_TELEMETRY_OWNER_DATABASE_ROLE: roles.telemetryOwnerRole,
  };
  const loginKeys = ['migrationRole', 'apiRole', 'workerRole', 'attesterRole'] as const;
  const clients = new Map<(typeof loginKeys)[number], pg.Client>();
  const created: string[] = [];
  const password = `synthetic-${randomUUID()}`;
  const quote = (name: string): string => {
    if (!/^hx_ci_[a-f0-9]{20}_[a-z]+$/u.test(name)) throw new Error('UNSAFE_SYNTHETIC_ROLE');
    return `"${name}"`;
  };
  beforeAll(async () => {
    fixture = await createUniversalV1DisposableDatabase({
      throughFinancialMigration:
        '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
    });
    const admin = await fixture.pool.connect();
    try {
      for (const [key, name] of Object.entries(roles)) {
        const login = (loginKeys as readonly string[]).includes(key);
        await admin.query(`CREATE ROLE ${quote(name)} ${login ? `LOGIN PASSWORD '${password}'` : 'NOLOGIN'}
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
        created.push(name);
      }
      await admin.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts(
        authority_version,target_database_name,environment,release_manifest_sha256,activation_request_sha256
      ) VALUES (1,current_database(),'local',$1,$2)`,
        [`sha256:${'b'.repeat(64)}`, 'c'.repeat(64)]
      );
      await admin.query(
        `INSERT INTO public.hxos_nonproduction_bootstrap_completion_v1(
        release_manifest_digest,migration_artifact_digest,release_id,release_environment,
        required_migration_count,financial_migration_status,completed_at
      ) VALUES ($1,$2,'synthetic-metadata-port','local',$3,'applied','2026-09-04T00:00:00Z')`,
        [`sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`, REQUIRED_MIGRATION_FILES.length]
      );
      await provisionUniversalV1SyntheticRoles(
        admin,
        new URL(fixture.databaseUrl).pathname.slice(1),
        roles
      );
      for (const key of loginKeys) {
        const url = new URL(fixture.databaseUrl);
        url.username = roles[key];
        url.password = password;
        const client = new pg.Client({ connectionString: url.toString() });
        await client.connect();
        clients.set(key, client);
      }
    } finally {
      admin.release();
    }
  }, 120_000);
  afterAll(async () => {
    for (const client of clients.values()) await client.end();
    if (fixture) {
      try {
        for (const name of created) {
          await fixture.pool.query(`REASSIGN OWNED BY ${quote(name)} TO hx_ci_runner`);
          await fixture.pool.query(`DROP OWNED BY ${quote(name)}`);
          await fixture.pool.query(`DROP ROLE ${quote(name)}`);
        }
      } finally {
        await fixture.close();
      }
    }
  }, 30_000);

  function preparationDatabase(client?: pg.Client | pg.Pool): Database {
    const query: QueryFn = async <Row>(sql: string, params?: unknown[]) => {
      const result = await (client ?? fixture.pool).query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    };
    const transaction = async <T>(
      work: (query: QueryFn) => Promise<T>,
      serializable = false
    ): Promise<T> => {
      const owned = client instanceof pg.Client ? client : await (client ?? fixture.pool).connect();
      try {
        await owned.query(serializable ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN');
        const result = await work(async <Row>(sql: string, params?: unknown[]) => {
          const reply = await owned.query(sql, params);
          return { rows: reply.rows as Row[], rowCount: reply.rowCount ?? 0 };
        });
        await owned.query('COMMIT');
        return result;
      } catch (error) {
        await owned.query('ROLLBACK');
        throw error;
      } finally {
        if (!(client instanceof pg.Client)) (owned as pg.PoolClient).release();
      }
    };
    return {
      query,
      readQuery: query,
      transaction,
      serializableTransaction: <T>(work: (query: QueryFn) => Promise<T>) => transaction(work, true),
    } as Database;
  }
  function preparationInput(owner: {
    draftId: string;
    posterUserId: string;
  }): PrepareUniversalV1FinancialCommandInput {
    const operationId = randomUUID(),
      idempotencyKey = 'authenticated:pg:' + randomUUID();
    const request = canonicalFinancialProviderRequestJson({
      operationId,
      idempotencyKey,
      expectedVersion: 0,
      customerId: owner.posterUserId,
    });
    return {
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId,
      providerKind: 'FAKE',
      idempotencyKey,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: 0,
      providerRequestSha256: createHash('sha256').update(request).digest('hex'),
      taskDraftId: owner.draftId,
      taskId: null,
      eligibilityDecisionId: null,
      scopeVersionId: null,
      changeOrderId: null,
      predecessorEventId: null,
      completionFactId: null,
      relatedOperationId: null,
      amountCents: null,
      currency: null,
      recordedBy: owner.posterUserId,
    };
  }
  const preparationAttestation = (actorId: string) =>
    createSyntheticActorAttestation(
      fixture.pool,
      preparationDatabase(clients.get('apiRole')!),
      clients.get('attesterRole')!,
      roles.attesterRole,
      'sha256:' + 'b'.repeat(64),
      actorId
    );
  const claimedPreparation = async (label: string) => {
    const owner = await createClaimedTaskDraftFixture(preparationDatabase(), fixture.pool, label);
    return { owner, input: preparationInput(owner) };
  };
  const preparationAuthority = () =>
    new PostgresUniversalV1PreparedFinancialCommandAuthority(
      preparationDatabase(clients.get('apiRole')!)
    );

  function preparationRequest(
    input: PrepareUniversalV1FinancialCommandInput,
    receipt: { preparedCommandId: string; authorityContextSha256: string }
  ): [string, string] {
    return [
      canonicalFinancialProviderRequestJson({
        operationId: input.operationId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: input.providerExpectedVersion,
        customerId: input.recordedBy,
      }),
      JSON.stringify({
        schemaVersion: 1,
        operationKind: input.operationKind,
        operationId: input.operationId,
        providerKind: 'FAKE',
        idempotencyKey: input.idempotencyKey,
        providerExpectedVersion: input.providerExpectedVersion,
        requestSha256: input.providerRequestSha256,
        evidence: {
          preparedFinancialCommandId: receipt.preparedCommandId,
          preparedAuthoritySha256: receipt.authorityContextSha256,
          taskDraftId: input.taskDraftId,
          taskId: null,
          workOrderId: null,
          relatedOperationId: null,
          amountCents: null,
          currency: null,
        },
        actor: { actorId: input.recordedBy, actorKind: 'PARTICIPANT' },
        release: {
          manifestDigest: 'sha256:' + 'b'.repeat(64),
          releaseId: 'v13.test.' + randomUUID(),
          revision: 'd'.repeat(40),
          environment: 'local',
          authenticationStatus: 'VERIFIED',
        },
      }),
    ];
  }

  async function webhookFixture(expirySeconds = 3600) {
    const target = (
      await fixture.pool
        .query(`SELECT * FROM hx_authority.universal_v1_work_order_target_authority_facts t
      WHERE NOT EXISTS(SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts s WHERE s.supersedes_target_authority_id=t.target_authority_id)`)
    ).rows[0];
    const keyId = randomUUID(),
      key = randomBytes(32);
    await clients.get('migrationRole')!.query(
      `INSERT INTO hx_authority.fake_financial_webhook_keys_v13
      (key_id,target_authority_id,key_material,expires_at) VALUES($1,$2,$3,clock_timestamp()+make_interval(secs=>$4))`,
      [keyId, target.target_authority_id, key, expirySeconds]
    );
    const payload = {
      version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
      kind: 'FINANCIAL_OPERATION_OBSERVED',
      providerKind: 'FAKE',
      providerEventReference: 'independent-webhook:' + randomUUID(),
      operationId: randomUUID(),
      operationKind: 'SETTLE',
      predecessorProviderVersion: 0,
      observedProviderVersion: 1,
      observedState: 'SUCCEEDED',
      externalReference: 'fake-settle:' + randomUUID(),
      amountCents: 12000,
      currency: 'USD',
      providerOccurredAt: new Date().toISOString(),
    };
    const binding = {
      keyId,
      targetAuthorityId: target.target_authority_id,
      targetAuthorityVersion: target.authority_version,
      targetDatabaseName: target.target_database_name,
      environment: target.environment,
      releaseManifestSha256: target.release_manifest_sha256,
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const sign = (raw: Buffer = body, scope = binding) =>
      createHmac('sha256', key).update(fakeFinancialWebhookSignedBytes(scope, raw)).digest('hex');
    const send = async (
      raw = body,
      signature = sign(raw),
      ingressKey: string | null = null,
      client = clients.get('apiRole')!
    ) => {
      const result = await client.query(
        'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4) AS receipt',
        [keyId, raw, signature, ingressKey]
      );
      return result.rows[0].receipt;
    };
    return { keyId, key, payload, binding, body, sign, send };
  }

  it('records independently signed webhook bytes through the API login with stable inbox and verification facts', async () => {
    const hook = await webhookFixture();
    const financialCounts = () =>
      fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM public.financial_provider_command_outcome_facts) AS outcomes,
      (SELECT count(*)::int FROM public.task_financial_security_events) AS events`);
    const before = (await financialCounts()).rows;
    const receipt = await hook.send();
    expect(receipt).toMatchObject({
      providerKind: 'FAKE',
      operationId: hook.payload.operationId,
      keyId: hook.keyId,
      environment: 'local',
      rawPayloadSha256: createHash('sha256').update(hook.body).digest('hex'),
      authenticationScheme: 'HMAC_SHA256_TARGET_V13',
      observationReplayed: false,
      idempotencyReplayed: false,
    });
    const replay = await hook.send();
    expect(replay).toEqual({ ...receipt, observationReplayed: true, idempotencyReplayed: true });
    const otherReceipt = await hook.send(
      hook.body,
      hook.sign(),
      'webhook-delivery:' + randomUUID()
    );
    expect(otherReceipt.observationId).toBe(receipt.observationId);
    expect(otherReceipt.receiptId).not.toBe(receipt.receiptId);
    expect(otherReceipt).toMatchObject({ observationReplayed: true, idempotencyReplayed: false });
    const evidence = await fixture.pool.query(
      `SELECT encode(o.raw_payload,'hex') AS bytes,p.processing_state,
      v.recording_transaction_id::TEXT AS xid,v.target_authority_id
      FROM public.provider_event_inbox_observations o JOIN public.provider_event_processing_state p USING(observation_id)
      JOIN hx_authority.fake_financial_webhook_verifications_v13 v USING(observation_id)
      WHERE v.receipt_id=$1`,
      [receipt.receiptId]
    );
    expect(evidence.rows).toEqual([
      {
        bytes: hook.body.toString('hex'),
        processing_state: 'PENDING',
        xid: expect.stringMatching(/^\d+$/u),
        target_authority_id: hook.binding.targetAuthorityId,
      },
    ]);
    expect((await financialCounts()).rows).toEqual(before);
  });

  it('refuses caller-VERIFIED legacy receipts even with exact new hashes, while independently authenticating a fresh delivery', async () => {
    const hook = await webhookFixture();
    const ingressKey = 'legacy-webhook:' + randomUUID();
    const observationId = randomUUID(),
      receiptId = randomUUID();
    const rawHash = createHash('sha256').update(hook.body).digest('hex');
    const authenticationHash = fakeFinancialWebhookAuthenticationEvidence(
      fakeFinancialWebhookSignedBytes(hook.binding, hook.body),
      hook.sign()
    );
    // Owner-backed historical fixture. No runtime role can create either raw row.
    await preparationDatabase().transaction(async (query) => {
      await query(
        `INSERT INTO public.provider_event_inbox_observations
        (observation_id,provider_kind,provider_event_reference,provider_event_kind,operation_id,raw_payload,raw_payload_sha256,raw_payload_bytes)
        VALUES($1,'FAKE',$2,'FINANCIAL_OPERATION_OBSERVED',$3,$4,$5,$6)`,
        [
          observationId,
          hook.payload.providerEventReference,
          hook.payload.operationId,
          hook.body,
          rawHash,
          hook.body.length,
        ]
      );
      await query(
        `INSERT INTO public.provider_event_inbox_receipts
        (receipt_id,observation_id,ingress_idempotency_key,request_sha256,authentication_status,authentication_scheme,authentication_evidence_sha256,authenticated_at)
        VALUES($1,$2,$3,hx_authority.fake_financial_job_digest_v13($4::TEXT[]),'VERIFIED','HMAC_SHA256_TARGET_V13',$5,clock_timestamp())`,
        [
          receiptId,
          observationId,
          ingressKey,
          [
            'HX_FAKE_WEBHOOK_RECEIPT_V13',
            hook.keyId,
            hook.binding.targetAuthorityId,
            ingressKey,
            rawHash,
            authenticationHash,
          ],
          authenticationHash,
        ]
      );
    });
    await expect(hook.send(hook.body, hook.sign(), ingressKey)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT'
    );
    const readCounts = () =>
      fixture.pool.query(
        `SELECT
      (SELECT count(*)::int FROM public.provider_event_inbox_receipts WHERE observation_id=$1) AS receipts,
      (SELECT count(*)::int FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE observation_id=$1) AS verifications`,
        [observationId]
      );
    expect((await readCounts()).rows).toEqual([{ receipts: 1, verifications: 0 }]);
    const fresh = await hook.send(hook.body, hook.sign(), 'fresh-webhook:' + randomUUID());
    expect(fresh).toMatchObject({
      observationId,
      observationReplayed: true,
      idempotencyReplayed: false,
    });
    expect(fresh.receiptId).not.toBe(receiptId);
    expect((await readCounts()).rows).toEqual([{ receipts: 2, verifications: 1 }]);
    expect(
      (
        await fixture.pool.query(
          'SELECT receipt_id FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE observation_id=$1',
          [observationId]
        )
      ).rows
    ).toEqual([{ receipt_id: fresh.receiptId }]);
    await expect(hook.send(hook.body, hook.sign(), ingressKey)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT'
    );
  });

  it('denies key custody, provisioning, raw receipts and ingress invocation outside their exact roles', async () => {
    const hook = await webhookFixture();
    for (const role of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = clients.get(role)!;
      for (const relation of [
        'hx_authority.fake_financial_webhook_keys_v13',
        'hx_authority.fake_financial_webhook_key_revocations_v13',
        'hx_authority.fake_financial_webhook_verifications_v13',
        'public.provider_event_inbox_observations',
        'public.provider_event_inbox_receipts',
        'public.provider_event_processing_state',
      ]) {
        await expect(client.query(`SELECT * FROM ${relation}`)).rejects.toMatchObject({
          code: '42501',
        });
      }
      await expect(
        client.query(
          'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
          [hook.keyId]
        )
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        client.query(
          `INSERT INTO hx_authority.fake_financial_webhook_keys_v13(key_id,target_authority_id,key_material,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
          [randomUUID(), hook.binding.targetAuthorityId, randomBytes(32)]
        )
      ).rejects.toMatchObject({ code: '42501' });
      if (role !== 'apiRole')
        await expect(hook.send(hook.body, hook.sign(), null, client)).rejects.toMatchObject({
          code: '42501',
        });
    }
  });

  it('rejects invalid signatures, target transplants, malformed payloads and key revocation without inbox writes', async () => {
    const hook = await webhookFixture();
    const altered = Buffer.from(JSON.stringify({ ...hook.payload, amountCents: 1 }));
    await expect(hook.send(altered, hook.sign())).rejects.toThrow('SIGNATURE_INVALID');
    for (const scope of [
      { ...hook.binding, keyId: randomUUID() },
      { ...hook.binding, targetAuthorityId: randomUUID() },
      { ...hook.binding, targetAuthorityVersion: 2 },
      { ...hook.binding, targetDatabaseName: 'hx_other_test' },
      { ...hook.binding, environment: 'staging' as const },
      { ...hook.binding, releaseManifestSha256: 'sha256:' + 'e'.repeat(64) },
    ]) {
      await expect(hook.send(hook.body, hook.sign(hook.body, scope))).rejects.toThrow(
        'SIGNATURE_INVALID'
      );
    }
    const malformed = [
      Buffer.from('{}'),
      Buffer.from(JSON.stringify({ ...hook.payload, observedProviderVersion: 3 })),
      Buffer.from(JSON.stringify({ ...hook.payload, amountCents: null, currency: null })),
      Buffer.from(JSON.stringify({ ...hook.payload, actorId: randomUUID() })),
      Buffer.from(
        JSON.stringify(hook.payload).replace(
          '"amountCents":12000',
          '"amountCents":12000,"amountCents":1'
        )
      ),
    ];
    for (const raw of malformed)
      await expect(hook.send(raw, hook.sign(raw))).rejects.toThrow('PAYLOAD_INVALID');
    await clients
      .get('migrationRole')!
      .query(
        'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
        [hook.keyId]
      );
    await expect(hook.send()).rejects.toThrow('SIGNATURE_INVALID');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.provider_event_inbox_observations WHERE operation_id=$1',
          [hook.payload.operationId]
        )
      ).rows[0].count
    ).toBe(0);
  });

  it('preserves the original receipt after commit acknowledgement loss and rolls back incomplete inbox transactions', async () => {
    const hook = await webhookFixture(),
      api = clients.get('apiRole')!;
    await api.query('BEGIN');
    await api.query('SAVEPOINT webhook_before_record');
    const tentative = await hook.send();
    await api.query('RELEASE SAVEPOINT webhook_before_record');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE receipt_id=$1',
          [tentative.receiptId]
        )
      ).rows[0].count
    ).toBe(0);
    await api.query('ROLLBACK');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.provider_event_inbox_observations WHERE observation_id=$1',
          [tentative.observationId]
        )
      ).rows[0].count
    ).toBe(0);
    await api.query('BEGIN');
    const committed = await hook.send();
    await api.query('COMMIT'); // Deliberately discard acknowledgement/result at caller boundary.
    expect(await hook.send()).toEqual({
      ...committed,
      observationReplayed: true,
      idempotencyReplayed: true,
    });
  });

  it('serializes duplicate signed deliveries from separate API connections and refuses conflicting identities', async () => {
    const hook = await webhookFixture();
    const url = new URL(fixture.databaseUrl);
    url.username = roles.apiRole;
    url.password = password;
    const other = new pg.Client({ connectionString: url.toString() });
    await other.connect();
    try {
      const receipts = await Promise.all([
        hook.send(),
        hook.send(hook.body, hook.sign(), null, other),
      ]);
      expect(receipts[0].receiptId).toBe(receipts[1].receiptId);
      expect(receipts.filter((r) => r.idempotencyReplayed)).toHaveLength(1);
      const changed = Buffer.from(JSON.stringify({ ...hook.payload, amountCents: 13000 }));
      await expect(hook.send(changed, hook.sign(changed))).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await expect(
        hook.send(changed, hook.sign(changed), 'other-delivery:' + randomUUID())
      ).rejects.toThrow('EVENT_CONFLICT');
    } finally {
      await other.end();
    }
  });

  it('refuses a substituted HMAC implementation even when its SQL name is unchanged', async () => {
    const hook = await webhookFixture(),
      admin = await fixture.pool.connect();
    try {
      await admin.query('BEGIN');
      await admin.query(
        `ALTER FUNCTION public.hmac(bytea,bytea,text) RENAME TO original_hmac_v13_test`
      );
      await admin.query(
        `CREATE FUNCTION public.hmac(bytea,bytea,text) RETURNS bytea LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT decode(repeat(''00'',32),''hex'')'`
      );
      await admin.query(`SET LOCAL ROLE ${quote(roles.apiRole)}`);
      await expect(
        admin.query(
          'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4)',
          [hook.keyId, hook.body, '0'.repeat(64), null]
        )
      ).rejects.toThrow('VERIFIER_UNAVAILABLE');
    } finally {
      await admin.query('ROLLBACK');
      admin.release();
    }
  });

  it('authenticates the actual HTTP route with a restricted API database and no API-held webhook key', async () => {
    const hook = await webhookFixture(),
      priorSecret = process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET;
    delete process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET;
    const spies = [
      vi
        .spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized')
        .mockReturnValue({ environment: 'local' } as never),
      vi
        .spyOn(manifestAuthority, 'releaseManifestDigest')
        .mockReturnValue(hook.binding.releaseManifestSha256),
      vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
        expectedTarget: { environment: 'local', databaseName: hook.binding.targetDatabaseName },
        targetDigest: 'synthetic-webhook-http-target',
      } as never),
      vi
        .spyOn(runtimeDb, 'transaction')
        .mockImplementation(preparationDatabase(clients.get('apiRole')!).transaction),
    ];
    try {
      const app = new Hono();
      app.post('/webhooks/fake-financial', syntheticFinancialWebhook);
      const headers = {
        'x-hustlexp-fake-finance-key-id': hook.keyId,
        'x-hustlexp-fake-finance-signature': hook.sign(),
      };
      const accepted = await app.request('/webhooks/fake-financial', {
        method: 'POST',
        headers,
        body: hook.body,
      });
      expect(accepted.status).toBe(202);
      const receipt = (await accepted.json()) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        received: true,
        queued: true,
        operationId: hook.payload.operationId,
        observationReplayed: false,
      });
      const replay = await app.request('/webhooks/fake-financial', {
        method: 'POST',
        headers,
        body: hook.body,
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual({
        ...receipt,
        observationReplayed: true,
        idempotencyReplayed: true,
      });
      const rejected = await app.request('/webhooks/fake-financial', {
        method: 'POST',
        headers: { ...headers, 'x-hustlexp-fake-finance-signature': '0'.repeat(64) },
        body: hook.body,
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ error: 'Invalid signature' });
      expect(JSON.stringify(receipt)).not.toContain(hook.key.toString('hex'));
    } finally {
      for (const spy of spies) spy.mockRestore();
      if (priorSecret === undefined) delete process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET;
      else process.env.HX_FAKE_FINANCIAL_WEBHOOK_SECRET = priorSecret;
    }
  });

  it('observes committed key revocation after waiting for the revoker transaction', async () => {
    const hook = await webhookFixture(),
      migration = clients.get('migrationRole')!,
      api = clients.get('apiRole')!;
    const apiPid = (await api.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await migration.query('BEGIN');
    let pending: Promise<unknown> | undefined;
    try {
      await migration.query(
        'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
        [hook.keyId]
      );
      pending = hook.send().then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        blocked = (
          await fixture.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [
            apiPid,
          ])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await migration.query('COMMIT');
      expect(await pending).toMatchObject({
        error: { message: 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' },
      });
    } finally {
      await migration.query('ROLLBACK');
      if (pending) await pending;
    }
  });

  it('refuses a new key in the provisioning transaction even after a released savepoint', async () => {
    const hook = await webhookFixture(),
      admin = await fixture.pool.connect(),
      keyId = randomUUID();
    try {
      await admin.query('BEGIN');
      await admin.query('SAVEPOINT key_provisioned');
      await admin.query(
        `INSERT INTO hx_authority.fake_financial_webhook_keys_v13(key_id,target_authority_id,key_material,expires_at)
        VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')`,
        [keyId, hook.binding.targetAuthorityId, hook.key]
      );
      await admin.query('RELEASE SAVEPOINT key_provisioned');
      await admin.query(`SET LOCAL ROLE ${quote(roles.apiRole)}`);
      await expect(
        admin.query(
          'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4)',
          [keyId, hook.body, hook.sign(hook.body, { ...hook.binding, keyId }), null]
        )
      ).rejects.toThrow('SIGNATURE_INVALID');
    } finally {
      await admin.query('ROLLBACK');
      admin.release();
    }
  });

  it('rechecks key expiry after an inbox lock wait', async () => {
    const hook = await webhookFixture(),
      keyId = randomUUID(),
      admin = await fixture.pool.connect(),
      api = clients.get('apiRole')!;
    await clients.get('migrationRole')!.query(
      `INSERT INTO hx_authority.fake_financial_webhook_keys_v13
      (key_id,target_authority_id,key_material,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 second')`,
      [keyId, hook.binding.targetAuthorityId, hook.key]
    );
    const apiPid = (await api.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<unknown> | undefined;
    try {
      await admin.query('BEGIN');
      await admin.query(
        "SELECT pg_advisory_xact_lock(hashtext('provider-event-inbox-v1'),hashtext($1))",
        ['event:FAKE:' + hook.payload.providerEventReference]
      );
      pending = api
        .query('SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4)', [
          keyId,
          hook.body,
          hook.sign(hook.body, { ...hook.binding, keyId }),
          null,
        ])
        .then(
          (value) => ({ value }),
          (error) => ({ error })
        );
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        blocked = (
          await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [apiPid])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await admin.query('SELECT pg_sleep(1.05)');
      await admin.query('COMMIT');
      expect(await pending).toMatchObject({
        error: { message: 'HXUV1-FINHOOK-13: SIGNATURE_INVALID' },
      });
    } finally {
      await admin.query('ROLLBACK');
      if (pending) await pending;
      admin.release();
    }
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'])(
    'refuses a historical %s snapshot for new webhook verification',
    async (isolation) => {
      const hook = await webhookFixture(),
        api = clients.get('apiRole')!;
      await api.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      try {
        await api.query('SELECT current_timestamp');
        await clients
          .get('migrationRole')!
          .query(
            'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
            [hook.keyId]
          );
        await expect(hook.send()).rejects.toThrow('CURRENT_SNAPSHOT_REQUIRED');
      } finally {
        await api.query('ROLLBACK');
      }
    }
  );

  async function pendingResolutionFixture(expirySeconds = 3600) {
    const owner = await createClaimedTaskDraftFixture(
      preparationDatabase(),
      fixture.pool,
      'pending-resolution'
    );
    let preparedInput = preparationInput(owner);
    const canonical = canonicalFinancialProviderRequestJson({
      operationId: preparedInput.operationId,
      idempotencyKey: preparedInput.idempotencyKey,
      expectedVersion: 0,
      customerId: owner.posterUserId,
      scenario: 'TIMEOUT',
    });
    preparedInput = {
      ...preparedInput,
      providerRequestSha256: createHash('sha256').update(canonical).digest('hex'),
    };
    const prepared = await preparationAuthority().prepare(
      preparedInput,
      await preparationAttestation(owner.posterUserId)
    );
    const [, identity] = preparationRequest(preparedInput, prepared);
    const requested = (
      await clients
        .get('apiRole')!
        .query('SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)', [
          canonical,
          identity,
        ])
    ).rows[0];
    const worker = clients.get('workerRole')!;
    const claim = (
      await worker.query('SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)', [
        randomUUID(),
      ])
    ).rows[0];
    expect(claim.command_id).toBe(requested.command_id);
    // Synthetic stored-transport acknowledgement. This fixture proves the exact
    // restricted database ports; prior Redis journeys remain separate evidence.
    await worker.query(
      "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
      [claim.publish_claim_id, claim.bullmq_job_id, claim.job_authority_sha256]
    );
    const workerId = randomUUID();
    const admission = (
      await worker.query(
        'SELECT * FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13($1,$2,$3,$4,0,3,2)',
        [claim.outbox_request_id, claim.bullmq_job_id, claim.job_authority_sha256, workerId]
      )
    ).rows[0];
    const original = (
      await worker.query(
        'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
        [admission.job_validation_id, workerId]
      )
    ).rows[0];
    expect(original).toMatchObject({ state: 'PENDING', retryable: true });
    const outcomeSql = 'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)';
    const initialArgs = [admission.job_validation_id, workerId, admission.recovery_lease_id];
    const initial = (await worker.query(outcomeSql, initialArgs)).rows[0];
    const hook = await webhookFixture(expirySeconds);
    const occurred = (
      await fixture.pool.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`
      )
    ).rows[0].time;
    const payload = {
      ...hook.payload,
      operationId: original.operation_id,
      operationKind: original.operation_kind,
      predecessorProviderVersion: Number(original.event_version) - 1,
      observedProviderVersion: Number(original.event_version),
      externalReference: original.external_reference,
      amountCents: null,
      currency: null,
      providerOccurredAt: occurred,
    };
    const body = Buffer.from(
      JSON.stringify(payload).replace(
        '"observedProviderVersion":1',
        '"observedProviderVersion":1.0'
      )
    );
    const send = (raw = body) =>
      hook.send(raw, hook.sign(raw), 'terminal-resolution:' + randomUUID());
    const reconcile = async () => {
      await fixture.pool.query(
        'SELECT pg_sleep_until(expires_at) FROM public.financial_provider_command_recovery_leases WHERE recovery_lease_id=$1',
        [admission.recovery_lease_id]
      );
      const args = [admission.job_validation_id, randomUUID(), randomUUID()];
      await worker.query(
        'SELECT * FROM public.hxos_acquire_fake_financial_reconcile_lease_v13($1,$2,$3,30)',
        args
      );
      return args;
    };
    const binding = { jobId: claim.bullmq_job_id, payload: claim.job_payload };
    const readerAuthority = {
      environment: 'local' as const,
      databaseName: hook.binding.targetDatabaseName,
      targetDigest: 'synthetic-resolution',
      manifestDigest: hook.binding.releaseManifestSha256,
    };
    return {
      worker,
      admission,
      original,
      initial,
      initialArgs,
      outcomeSql,
      hook,
      payload,
      body,
      send,
      reconcile,
      binding,
      readerAuthority,
    };
  }

  it.each([
    'normal',
    'compensation',
    'lost_before_admission',
    'lost_after_outcome',
    'lost_after_admission',
    'retained_after_admission',
  ] as const)(
    'submits PREPARE, AUTHORIZE and SECURE through restricted API/worker ports: %s',
    async (scenario) => {
      if (process.env.REDIS_URL !== 'redis://127.0.0.1:16379')
        throw new Error('EXACT_SYNTHETIC_REDIS_REQUIRED');
      const apiDatabase = preparationDatabase(clients.get('apiRole')!);
      const phaseFixture = await createPreparedWorkOrderFixture(
        preparationDatabase(),
        fixture.pool,
        apiDatabase,
        clients.get('attesterRole')!,
        roles.attesterRole,
        'sha256:' + 'b'.repeat(64),
        'api-worker'
      );
      const { lane, phase, key } = phaseFixture;
      const foreground = scenario === 'normal' || scenario === 'compensation';
      const workerUrl = new URL(fixture.databaseUrl);
      workerUrl.username = roles.workerRole;
      workerUrl.password = password;
      const workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 4 });
      const workerDatabase = preparationDatabase(workerPool);
      const prefix = 'hx-ci-api-worker-' + randomUUID();
      const connection = { host: '127.0.0.1', port: 16379, maxRetriesPerRequest: null };
      const queue = new Queue('synthetic_finance', { prefix, connection });
      const events = new QueueEvents('synthetic_finance', { prefix, connection });
      const processor = new SyntheticFinancialCommandProcessor();
      const worker = new Worker('synthetic_finance', (job) => processor.process(job), {
        prefix,
        connection,
        autorun: false,
        concurrency: 1,
      });
      const runtimeErrors: Error[] = [];
      worker.on('error', (error) => {
        runtimeErrors.push(error);
      });
      events.on('error', (error) => {
        runtimeErrors.push(error);
      });
      queue.on('error', (error) => {
        runtimeErrors.push(error);
      });
      const release = {
        manifestDigest: 'sha256:' + 'b'.repeat(64),
        releaseId: 'synthetic.api.worker',
        revision: 'd'.repeat(40),
        environment: 'local' as const,
        authenticationStatus: 'VERIFIED' as const,
      };
      // Synthetic installed release and identity only. Application commands,
      // PostgreSQL roles/receipts, Redis transport and the BullMQ consumer are real.
      const manifest = {
        releaseId: release.releaseId,
        environment: 'local',
        components: {
          backend: { revision: release.revision },
          worker: { revision: release.revision },
        },
      } as unknown as ReturnType<
        typeof financialAuthorization.assertNonproductionFakeFinanceAuthorized
      >;
      const service = new requestApplication.UniversalV1FinancialRequestService(
        new PostgresUniversalV1PreparedFinancialCommandAuthority(apiDatabase),
        new PostgresFinancialProviderCommandJournal(apiDatabase),
        () => release,
        new PostgresUniversalV1FinancialRequestProgressReader(apiDatabase),
        new PostgresUniversalV1FinancialPredecessorReader(apiDatabase)
      );
      let injectMaterializationFailure = scenario === 'lost_after_outcome';
      let injectExecutionFailure = ['lost_after_admission', 'retained_after_admission'].includes(
        scenario
      );
      let abandonedAdmission: { job_validation_id: string; workerInstanceId: string } | undefined;
      const spies = [
        vi.spyOn(runtimeDb, 'transaction').mockImplementation((callback) =>
          workerDatabase.transaction((query) =>
            callback(async <T>(sql: string, params?: unknown[]) => {
              if (
                injectExecutionFailure &&
                sql.includes('record_fake_financial_job_dispatch_evidence_v13')
              ) {
                const bounded = [...params!];
                bounded[5] = 3;
                bounded[6] = 2;
                const receipt = await query<T>(sql, bounded);
                abandonedAdmission = {
                  job_validation_id: (receipt.rows[0] as { job_validation_id: string })
                    .job_validation_id,
                  workerInstanceId: String(bounded[3]),
                };
                return receipt;
              }
              if (
                injectExecutionFailure &&
                sql.includes('hxos_read_admitted_fake_financial_request_v13')
              ) {
                injectExecutionFailure = false;
                throw new Error('SYNTHETIC_EXECUTION_INTERRUPTED_AFTER_ADMISSION');
              }
              if (
                injectMaterializationFailure &&
                sql.includes('public.hxos_materialize_fake_financial_event_v13')
              ) {
                injectMaterializationFailure = false;
                throw new Error('SYNTHETIC_MATERIALIZATION_INTERRUPTED');
              }
              return query<T>(sql, params);
            })
          )
        ),
        vi
          .spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized')
          .mockReturnValue(manifest),
        vi
          .spyOn(manifestAuthority, 'releaseManifestDigest')
          .mockReturnValue(release.manifestDigest),
        vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
          expectedTarget: { environment: 'local', databaseName: workerUrl.pathname.slice(1) },
          targetDigest: 'sha256:' + 'e'.repeat(64),
        } as ReturnType<typeof databaseStartup.configuredRuntimeDatabaseStartup>),
        vi
          .spyOn(requestApplication, 'createUniversalV1FinancialRequestService')
          .mockReturnValue(service),
      ];
      const captureRequest = vi.spyOn(service, 'requestFinancialEvent');
      spies.push(captureRequest as never);
      let running: Promise<void> | undefined;
      let journeyError: unknown;
      try {
        await events.waitUntilReady();
        await worker.waitUntilReady();
        await queue.waitUntilReady();
        const user = (
          await fixture.pool.query('SELECT * FROM public.users WHERE id=$1', [lane.posterUserId])
        ).rows[0] as NonNullable<Context['user']>;
        const caller = universalFinanceRouter.createCaller({
          user,
          firebaseUid: user.firebase_uid ?? null,
          ip: '127.0.0.1',
          actorAttestation: await preparationAttestation(lane.posterUserId),
        });
        const workOrderRepository = new PostgresUniversalV1WorkOrderRepository(apiDatabase);
        const workOrderApplication = new UniversalV1WorkOrderApplication(
          undefined,
          workOrderRepository,
          () => service,
          new PostgresUniversalV1WorkOrderHistoryReader(apiDatabase, () => release)
        );
        const workOrderRouter = createUniversalContractRouter({} as never, workOrderApplication);
        const resumeWorkOrder = async () =>
          workOrderRouter
            .createCaller({
              user,
              firebaseUid: user.firebase_uid ?? null,
              ip: '127.0.0.1',
              actorAttestation: await preparationAttestation(lane.posterUserId),
            })
            .secureAndMaterializeFakeWorkOrder({
              conditional_hold_id: phase.context.conditional_hold_id,
              expected_eligibility_version: phase.context.eligibility_version,
              idempotency_key: key,
              client_ts: new Date().toISOString(),
            });
        const publisher = new FakeFinancialOutboxPublisher(
          new PostgresFakeFinancialOutboxRepository(workerDatabase),
          createFakeFinancialOutboxTransport({ redisUrl: process.env.REDIS_URL, prefix }),
          () => {
            financialAuthorization.assertNonproductionFakeFinanceAuthorized({
              component: 'worker',
            });
          },
          { publisherId: randomUUID(), batchLimit: 1 }
        );
        const recoveryResults: Array<
          Awaited<ReturnType<SyntheticFinancialCommandProcessor['recover']>>
        > = [];
        const durableRepository = new PostgresFakeFinancialDurableRecoveryRepository();
        const durableRecovery = new FakeFinancialDurableRecovery({
          repository: durableRepository,
          transport: createFakeFinancialOutboxTransport({
            redisUrl: process.env.REDIS_URL,
            prefix,
          }),
          recover: async (binding) => {
            const result = await new SyntheticFinancialCommandProcessor().recover(binding);
            recoveryResults.push(result);
            return result;
          },
          assertAuthorized: () => {
            financialAuthorization.assertNonproductionFakeFinanceAuthorized({
              component: 'worker',
            });
          },
        });
        const common = {
          providerKind: 'FAKE' as const,
          providerExpectedVersion: 0,
          taskDraftId: lane.draftId,
          taskId: lane.taskId,
          eligibilityDecisionId: lane.eligibilityDecisionId,
          scopeVersionId: lane.scopeVersionId,
          occurredAt: phase.occurredAt,
        };
        let predecessor:
          | { operationId: string; financialEventId: string; externalReference: string }
          | undefined;
        for (const kind of ['PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE'] as const) {
          const operationId = deterministicUuid(
            key,
            kind === 'PREPARE_PAYMENT_METHOD' ? 'prepare' : kind.toLowerCase()
          );
          const input: Parameters<typeof caller.enqueueEvent>[0] =
            kind === 'PREPARE_PAYMENT_METHOD'
              ? {
                  ...common,
                  operationKind: kind,
                  operationId,
                  idempotencyKey: key + ':prep',
                  lifecycleExpectedVersion: 0,
                  customerId: lane.posterUserId,
                }
              : {
                  ...common,
                  operationKind: kind,
                  operationId,
                  idempotencyKey: key + (kind === 'AUTHORIZE' ? ':auth' : ':secure'),
                  lifecycleExpectedVersion: kind === 'AUTHORIZE' ? 1 : 2,
                  predecessorEventId: predecessor!.financialEventId,
                  relatedOperationId: predecessor!.operationId,
                  amountCents: Number(phase.context.customer_total_cents),
                  currency: phase.context.currency.toLowerCase(),
                  ...(kind === 'AUTHORIZE'
                    ? { paymentMethodReference: predecessor!.externalReference }
                    : { authorizationOperationId: predecessor!.operationId }),
                };
          const predecessorPayload = {
            operationKind: kind,
            operationId,
            taskDraftId: lane.draftId,
            idempotencyKey: input.idempotencyKey,
          };
          expect(
            await service.readPredecessor(
              predecessorPayload,
              lane.posterUserId,
              await preparationAttestation(lane.posterUserId)
            )
          ).toBeNull();
          const requested = foreground
            ? await (async () => {
                const status = await resumeWorkOrder();
                expect(status).toMatchObject({
                  status: 'PENDING',
                  hard_assignment_created: false,
                  payment_creation_performed: false,
                });
                expect(captureRequest).toHaveBeenCalledTimes(
                  kind === 'PREPARE_PAYMENT_METHOD' ? 1 : kind === 'AUTHORIZE' ? 2 : 3
                );
                const last = captureRequest.mock.results.at(-1);
                if (last?.type !== 'return') throw Error('WORK_ORDER_REQUEST_RECEIPT_MISSING');
                return await last.value;
              })()
            : await caller.enqueueEvent(input);
          expect(
            await service.readPredecessor(
              predecessorPayload,
              lane.posterUserId,
              await preparationAttestation(lane.posterUserId)
            )
          ).toMatchObject({
            idempotencyKey: input.idempotencyKey,
            progress: {
              commandId: requested.commandId,
              progressState: 'REQUESTED',
              financialEvent: null,
            },
            predecessor: null,
          });
          expect(await caller.requestProgress({ commandId: requested.commandId })).toMatchObject({
            commandId: requested.commandId,
            operationId,
            progressState: 'REQUESTED',
            financialEvent: null,
          });
          if (scenario === 'normal' && kind === 'PREPARE_PAYMENT_METHOD') {
            const other = await createClaimedTaskDraftFixture(
              preparationDatabase(),
              fixture.pool,
              'progress-other'
            );
            const otherAttestation = await preparationAttestation(other.posterUserId);
            const providerAttestation = await preparationAttestation(lane.providerUserId);
            const locked = await fixture.pool.connect();
            try {
              await locked.query('BEGIN');
              await locked.query(
                "SELECT pg_advisory_xact_lock(hashtext('financial-provider-command-recovery-v1'),hashtext($1))",
                [requested.commandId]
              );
              await locked.query('SELECT id FROM public.task_drafts WHERE id=$1 FOR UPDATE', [
                lane.draftId,
              ]);
              await clients.get('apiRole')!.query("SET statement_timeout='3s'");
              // A denied reader never enters finance or locks another customer's draft.
              expect(
                await service.readPredecessor(
                  predecessorPayload,
                  other.posterUserId,
                  otherAttestation
                )
              ).toBeNull();
              expect(
                await service.readPredecessor(
                  predecessorPayload,
                  lane.providerUserId,
                  providerAttestation
                )
              ).toBeNull();
              expect(
                await service.readPredecessor(
                  { ...predecessorPayload, taskDraftId: other.draftId },
                  other.posterUserId,
                  otherAttestation
                )
              ).toBeNull();
              expect(
                await service.readProgress(
                  requested.commandId,
                  other.posterUserId,
                  otherAttestation
                )
              ).toBeNull();
              expect(
                await service.readProgress(
                  requested.commandId,
                  lane.providerUserId,
                  providerAttestation
                )
              ).toBeNull();
              expect(
                await service.readProgress(randomUUID(), other.posterUserId, otherAttestation)
              ).toBeNull();
            } finally {
              await clients.get('apiRole')!.query('SET statement_timeout=DEFAULT');
              await locked.query('ROLLBACK');
              locked.release();
            }
          }
          expect(requested).toMatchObject({
            operationId,
            requestState: 'REQUESTED',
            idempotencyReplayed: false,
          });
          if (foreground) {
            const count = captureRequest.mock.calls.length;
            expect(await resumeWorkOrder()).toMatchObject({ status: 'PENDING' });
            expect(captureRequest).toHaveBeenCalledTimes(count);
          } else
            expect(await caller.enqueueEvent(input)).toEqual({
              ...requested,
              idempotencyReplayed: true,
            });
          const outbox = (
            await fixture.pool.query(
              `SELECT bullmq_job_id,jsonb_build_object('version',payload_contract_version,
              'kind','UNIVERSAL_V1_FAKE_FINANCIAL_COMMAND','outboxRequestId',outbox_request_id,
              'commandId',command_id,'jobAuthoritySha256',job_authority_sha256) AS job_payload
             FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$1`,
              [requested.commandId]
            )
          ).rows[0];
          expect(Object.keys(outbox.job_payload).sort()).toEqual([
            'commandId',
            'jobAuthoritySha256',
            'kind',
            'outboxRequestId',
            'version',
          ]);
          if (running) await worker.pause();
          expect(
            (await durableRepository.scan({ afterOutboxRequestId: null, limit: 100 })).some(
              (row) => row.command_id === requested.commandId
            )
          ).toBe(true);
          expect(await publisher.runOnce()).toEqual({
            claimed: 1,
            confirmed: 1,
            retryableFailures: 0,
            terminalFailures: 0,
            persistenceErrors: 0,
          });
          let queued = await queue.getJob(outbox.bullmq_job_id);
          expect(await caller.requestProgress({ commandId: requested.commandId })).toMatchObject({
            progressState: 'PUBLISHED',
            financialEvent: null,
          });
          if (scenario === 'lost_before_admission' && kind === 'PREPARE_PAYMENT_METHOD') {
            await queued!.remove();
            expect(await queue.getJob(outbox.bullmq_job_id)).toBeUndefined();
            // Historical confirmation is not a claim that Redis still has it.
            expect(await caller.requestProgress({ commandId: requested.commandId })).toMatchObject({
              progressState: 'PUBLISHED',
              financialEvent: null,
            });
            expect((await publisher.runOnce()).claimed).toBe(0);
            expect(await durableRecovery.runOnce()).toMatchObject({
              transportConfirmed: 1,
              errors: 0,
              held: 0,
            });
            queued = await queue.getJob(outbox.bullmq_job_id);
          }
          expect(queued).toBeDefined();
          expect(queued!.data).toEqual(outbox.job_payload);
          const recoveringLostOutcome =
            scenario === 'lost_after_outcome' && kind === 'PREPARE_PAYMENT_METHOD';
          const recoveringAbandonment =
            ['lost_after_admission', 'retained_after_admission'].includes(scenario) &&
            kind === 'PREPARE_PAYMENT_METHOD';
          const failed =
            recoveringLostOutcome || recoveringAbandonment
              ? once(worker, 'failed', { signal: AbortSignal.timeout(20_000) })
              : undefined;
          // Keep an early rejection handled while startup is awaited; the actual
          // await below still rejects and reaches unconditional fixture cleanup.
          void failed?.catch(() => undefined);
          const finished =
            recoveringLostOutcome || recoveringAbandonment
              ? undefined
              : queued!.waitUntilFinished(events, 20_000);
          if (!running)
            running = worker.run().catch((error) => {
              runtimeErrors.push(error as Error);
            });
          else worker.resume();
          let materialized: Awaited<ReturnType<SyntheticFinancialCommandProcessor['recover']>>;
          if (recoveringAbandonment) {
            const [failedJob, failure] = (await failed)!;
            expect(failedJob.id).toBe(outbox.bullmq_job_id);
            expect(failure.message).toBe('SYNTHETIC_EXECUTION_INTERRUPTED_AFTER_ADMISSION');
            await worker.pause();
            expect(
              (
                await fixture.pool.query(
                  'SELECT count(*)::int AS n FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1',
                  [operationId]
                )
              ).rows[0].n
            ).toBe(0);
            queued = await queue.getJob(outbox.bullmq_job_id);
            if (scenario === 'lost_after_admission') {
              await queued!.remove();
              expect(await queue.getJob(outbox.bullmq_job_id)).toBeUndefined();
            }
            await fixture.pool.query(
              'SELECT pg_sleep_until(outcome_deadline_at) FROM public.financial_provider_command_dispatch_attempts WHERE command_id=$1',
              [requested.commandId]
            );
            expect(await durableRecovery.runOnce()).toMatchObject({
              recovered: 0,
              transportConfirmed: 0,
              deferred: 1,
              errors: 0,
            });
            expect(recoveryResults.at(-1)).toMatchObject({
              commandId: requested.commandId,
              state: 'REDISPATCH_REQUIRED',
            });
            const fence = (
              await fixture.pool.query(
                "SELECT * FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND failure_code='FAKE_ADMISSION_FENCED_NO_EFFECT'",
                [requested.commandId]
              )
            ).rows[0];
            expect(fence).toMatchObject({
              outcome_kind: 'FAILED',
              effect_certainty: 'CONFIRMED_NO_EFFECT',
              retryable: true,
            });
            await expect(
              workerPool.query(
                'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
                [abandonedAdmission!.job_validation_id, abandonedAdmission!.workerInstanceId]
              )
            ).rejects.toThrow(/DISPATCH_NOT_OPEN|EXECUTION_WINDOW_EXPIRED/);
            await fixture.pool.query('SELECT pg_sleep_until($1::timestamptz)', [
              fence.recovery_not_before,
            ]);
            expect(await durableRecovery.runOnce()).toMatchObject({
              recovered: 0,
              transportConfirmed: 1,
              errors: 0,
              held: 0,
            });
            queued = await queue.getJob(outbox.bullmq_job_id);
            const actualAttempt = scenario === 'lost_after_admission' ? 0 : 1;
            expect(queued!.attemptsMade).toBe(actualAttempt);
            const recoveredFinish = queued!.waitUntilFinished(events, 20_000);
            worker.resume();
            materialized = await recoveredFinish;
            expect(
              (
                await fixture.pool.query(
                  'SELECT bullmq_attempt_number FROM hx_authority.fake_financial_job_validations_v13 WHERE command_id=$1 ORDER BY validated_at',
                  [requested.commandId]
                )
              ).rows.map((row) => row.bullmq_attempt_number)
            ).toEqual([0, actualAttempt]);
          } else if (recoveringLostOutcome) {
            const [failedJob, failure] = (await failed)!;
            expect(failedJob.id).toBe(outbox.bullmq_job_id);
            expect(failure.message).toBe('SYNTHETIC_MATERIALIZATION_INTERRUPTED');
            expect(injectMaterializationFailure).toBe(false);
            expect(await caller.requestProgress({ commandId: requested.commandId })).toMatchObject({
              progressState: 'RECOVERY_REQUIRED',
              financialEvent: null,
            });
            await worker.pause();
            queued = await queue.getJob(outbox.bullmq_job_id);
            await queued!.remove();
            expect(await durableRecovery.runOnce()).toMatchObject({
              recovered: 1,
              transportConfirmed: 0,
              errors: 0,
            });
            materialized = recoveryResults.at(-1)!;
            expect(await queue.getJob(outbox.bullmq_job_id)).toBeUndefined();
          } else materialized = await finished;
          expect(materialized).toMatchObject({
            commandId: requested.commandId,
            state: 'MATERIALIZED',
            idempotencyReplayed: false,
          });
          if (materialized.state !== 'MATERIALIZED') throw new Error('MATERIALIZED_REQUIRED');
          const publicProgress = await caller.requestProgress({ commandId: requested.commandId });
          expect(publicProgress).toMatchObject({
            commandId: requested.commandId,
            operationId,
            operationKind: kind,
            requestState: 'REQUESTED',
            progressState: 'MATERIALIZED',
            financialEvent: { id: materialized.financialEventId, status: 'SUCCEEDED' },
          });
          expect(Object.keys(publicProgress).sort()).toEqual([
            'commandId',
            'financialEvent',
            'observedAt',
            'operationId',
            'operationKind',
            'progressState',
            'requestState',
            'requestedAt',
            'taskDraftId',
            'taskId',
          ]);
          const raw = (
            await fixture.pool.query(
              'SELECT operation_id,external_reference,state FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1',
              [operationId]
            )
          ).rows;
          expect(raw).toHaveLength(1);
          expect(raw[0].state).toBe('SUCCEEDED');
          const historical = await service.readPredecessor(
            predecessorPayload,
            lane.posterUserId,
            await preparationAttestation(lane.posterUserId)
          );
          expect(historical).toMatchObject({
            progress: { commandId: requested.commandId, progressState: 'MATERIALIZED' },
            predecessor: {
              commandId: requested.commandId,
              preparedCommandId: requested.preparedCommandId,
              operationId,
              operationKind: kind,
              financialEventId: materialized.financialEventId,
              taskDraftId: lane.draftId,
              taskId: lane.taskId,
              scopeVersionId: lane.scopeVersionId,
              eligibilityDecisionId: lane.eligibilityDecisionId,
              externalReference:
                kind === 'PREPARE_PAYMENT_METHOD' ? raw[0].external_reference : null,
            },
          });
          // PREPARE remains readable after later AUTHORIZE/SECURE events exist.
          const original = await service.readPredecessor(
            {
              operationKind: 'PREPARE_PAYMENT_METHOD',
              operationId: deterministicUuid(key, 'prepare'),
              taskDraftId: lane.draftId,
              idempotencyKey: key + ':prep',
            },
            lane.posterUserId,
            await preparationAttestation(lane.posterUserId)
          );
          expect(original?.predecessor).toMatchObject({
            operationKind: 'PREPARE_PAYMENT_METHOD',
            lifecycleExpectedVersion: 0,
          });
          expect(original?.predecessor?.externalReference).toBeTruthy();
          expect(
            await service.readPredecessor(
              { ...predecessorPayload, idempotencyKey: 'wrong-idempotency-key:prep' },
              lane.posterUserId,
              await preparationAttestation(lane.posterUserId)
            )
          ).toBeNull();
          const retained = await queue.getJob(outbox.bullmq_job_id);
          if (!recoveringLostOutcome) {
            expect(await retained!.getState()).toBe('completed');
            expect(await new SyntheticFinancialCommandProcessor().process(retained!)).toEqual({
              ...materialized,
              idempotencyReplayed: true,
            });
          }
          const counts = (
            await fixture.pool.query(
              `SELECT (SELECT count(*)::int FROM hx_authority.fake_financial_dispatch_admissions_v13 WHERE command_id=$1) AS admissions,
             (SELECT count(*)::int FROM hx_authority.fake_financial_outbox_publish_claims_v13 WHERE outbox_request_id=$2) AS claims,
             (SELECT count(*)::int FROM hx_authority.fake_financial_outbox_publish_outcomes_v13 WHERE outbox_request_id=$2) AS publications`,
              [requested.commandId, outbox.job_payload.outboxRequestId]
            )
          ).rows[0];
          expect(counts).toEqual({
            admissions: recoveringAbandonment ? 2 : 1,
            claims: 1,
            publications: 1,
          });
          expect(
            (await durableRepository.scan({ afterOutboxRequestId: null, limit: 100 })).some(
              (r) => r.command_id === requested.commandId
            )
          ).toBe(false);
          predecessor = {
            operationId,
            externalReference: raw[0].external_reference,
            financialEventId: materialized.financialEventId,
          };
        }
        expect(
          (
            await fixture.pool.query(
              'SELECT count(*)::int AS n FROM public.task_financial_security_events WHERE task_draft_id=$1',
              [lane.draftId]
            )
          ).rows[0].n
        ).toBe(3);
        if (scenario === 'normal') {
          const materialized = await resumeWorkOrder();
          expect(materialized).toMatchObject({
            status: 'MATERIALIZED',
            replayed: false,
            financial_security_event_id: predecessor!.financialEventId,
            hard_assignment_created: false,
            payment_creation_performed: false,
          });
          const replay = await resumeWorkOrder();
          expect(replay).toEqual({ ...materialized, replayed: true });
          expect(captureRequest).toHaveBeenCalledTimes(3);
          const task = (
            await fixture.pool.query(
              'SELECT work_order_id,worker_id,universal_payment_posture FROM public.tasks WHERE id=$1',
              [lane.taskId]
            )
          ).rows[0];
          expect(task).toMatchObject({
            worker_id: null,
            universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
          });
          if (materialized.status !== 'MATERIALIZED') throw Error('WORK_ORDER_NOT_MATERIALIZED');
          expect(task.work_order_id).toBe(materialized.work_order_id);
        }
        if (scenario === 'compensation') {
          const rejectFinalize = vi
            .spyOn(workOrderRepository, 'finalizeMaterialization')
            .mockRejectedValueOnce(Error('INJECTED_FINALIZE_FAILURE'));
          try {
            await worker.pause();
            expect(await resumeWorkOrder()).toMatchObject({
              status: 'COMPENSATING',
              stage: 'COMPENSATION',
            });
            expect(captureRequest).toHaveBeenCalledTimes(4);
            const requestedVoid = await captureRequest.mock.results.at(-1)!.value;
            expect(await resumeWorkOrder()).toMatchObject({ status: 'COMPENSATING' });
            expect(captureRequest).toHaveBeenCalledTimes(4);
            const outbox = (
              await fixture.pool.query(
                'SELECT bullmq_job_id FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$1',
                [requestedVoid.commandId]
              )
            ).rows[0];
            expect(await publisher.runOnce()).toMatchObject({
              claimed: 1,
              confirmed: 1,
              persistenceErrors: 0,
            });
            const job = await queue.getJob(outbox.bullmq_job_id);
            expect(job).toBeDefined();
            const finished = job!.waitUntilFinished(events, 20_000);
            worker.resume();
            await finished;
            expect(await resumeWorkOrder()).toMatchObject({
              status: 'COMPENSATED',
              stage: 'COMPENSATION',
              retry_after_ms: null,
            });
            expect(await resumeWorkOrder()).toMatchObject({ status: 'COMPENSATED' });
            expect(captureRequest).toHaveBeenCalledTimes(4);
            const task = (
              await fixture.pool.query(
                'SELECT work_order_id,worker_id FROM public.tasks WHERE id=$1',
                [lane.taskId]
              )
            ).rows[0];
            expect(task).toEqual({ work_order_id: null, worker_id: null });
            const counts = (
              await fixture.pool.query(
                "SELECT (SELECT count(*)::int FROM public.universal_v1_work_order_compensation_commands WHERE task_id=$1) AS claims,(SELECT count(*)::int FROM public.task_financial_security_events WHERE task_id=$1 AND event_kind='VOIDED' AND status='SUCCEEDED') AS voids",
                [lane.taskId]
              )
            ).rows[0];
            expect(counts).toEqual({ claims: 1, voids: 1 });
          } finally {
            rejectFinalize.mockRestore();
          }
        }
        expect(await queue.getJobCounts('completed', 'failed')).toMatchObject({
          completed: scenario === 'lost_after_outcome' ? 2 : scenario === 'compensation' ? 4 : 3,
          failed: 0,
        });
        expect(runtimeErrors).toEqual([]);
      } catch (error) {
        journeyError = error;
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        try {
          for (const close of [
            () => worker.close(),
            async () => {
              if (running) await running;
            },
            () => events.close(),
            () => queue.obliterate({ force: true }),
            () => queue.close(),
            () => workerPool.end(),
          ]) {
            try {
              await close();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
        if (cleanupErrors.length)
          throw new AggregateError(
            journeyError ? [journeyError, ...cleanupErrors] : cleanupErrors,
            'SYNTHETIC_JOURNEY_CLEANUP_FAILED'
          );
      }
    },
    60_000
  );

  /** Restricted financial execution; proposal/approval/Phase A are explicitly
   * owner-backed setup until the change-order domain ports are sealed. */
  async function changeOrderWorkOrderFixture() {
    const apiDatabase = preparationDatabase(clients.get('apiRole')!);
    const { lane, phase, key } = await createPreparedWorkOrderFixture(
      preparationDatabase(),
      fixture.pool,
      apiDatabase,
      clients.get('attesterRole')!,
      roles.attesterRole,
      'sha256:' + 'b'.repeat(64),
      'adjust-execution'
    );
    const release = {
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      releaseId: 'synthetic.adjust.execution',
      revision: 'd'.repeat(40),
      environment: 'local' as const,
      authenticationStatus: 'VERIFIED' as const,
    };
    const service = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(apiDatabase),
      new PostgresFinancialProviderCommandJournal(apiDatabase),
      () => release,
      new PostgresUniversalV1FinancialRequestProgressReader(apiDatabase),
      new PostgresUniversalV1FinancialPredecessorReader(apiDatabase)
    );
    const worker = clients.get('workerRole')!;
    const request = async (input: ExecuteUniversalV1FinancialEventCommand) =>
      service.requestFinancialEvent(input, await preparationAttestation(lane.posterUserId));
    const admit = async (commandId: string) => {
      const claim = (
        await worker.query('SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)', [
          randomUUID(),
        ])
      ).rows[0];
      expect(claim?.command_id).toBe(commandId);
      await worker.query(
        "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
        [claim.publish_claim_id, claim.bullmq_job_id, claim.job_authority_sha256]
      );
      const workerId = randomUUID();
      const admission = (
        await worker.query(
          'SELECT * FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13($1,$2,$3,$4,0,30,2)',
          [claim.outbox_request_id, claim.bullmq_job_id, claim.job_authority_sha256, workerId]
        )
      ).rows[0];
      return { admission, workerId };
    };
    const execute = async (binding: Awaited<ReturnType<typeof admit>>, client = worker) =>
      (
        await client.query(
          'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
          [binding.admission.job_validation_id, binding.workerId]
        )
      ).rows[0];
    const complete = async (input: ExecuteUniversalV1FinancialEventCommand) => {
      const requested = await request(input),
        binding = await admit(requested.commandId);
      await execute(binding);
      const outcome = (
        await worker.query(
          'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
          [
            binding.admission.job_validation_id,
            binding.workerId,
            binding.admission.recovery_lease_id,
          ]
        )
      ).rows[0];
      return (
        await worker.query(
          'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
          [binding.admission.job_validation_id, outcome.outcome_fact.outcome_fact_id]
        )
      ).rows[0].financial_event;
    };
    const common = {
      providerKind: 'FAKE' as const,
      providerExpectedVersion: 0,
      taskDraftId: lane.draftId,
      taskId: lane.taskId,
      eligibilityDecisionId: lane.eligibilityDecisionId,
      scopeVersionId: lane.scopeVersionId,
      occurredAt: phase.occurredAt,
      recordedBy: lane.posterUserId,
      scenario: 'SUCCESS' as const,
    };
    const prepared = await complete({
      ...common,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId: deterministicUuid(key, 'prepare'),
      idempotencyKey: key + ':prep',
      lifecycleExpectedVersion: 0,
      customerId: lane.posterUserId,
    });
    const authorized = await complete({
      ...common,
      operationKind: 'AUTHORIZE',
      operationId: deterministicUuid(key, 'authorize'),
      idempotencyKey: key + ':auth',
      lifecycleExpectedVersion: 1,
      predecessorEventId: prepared.id,
      relatedOperationId: prepared.operation_id,
      amountCents: phase.context.customer_total_cents,
      currency: phase.context.currency.toLowerCase(),
      paymentMethodReference: prepared.external_reference,
    });
    const secured = await complete({
      ...common,
      operationKind: 'SECURE',
      operationId: deterministicUuid(key, 'secure'),
      idempotencyKey: key + ':secure',
      lifecycleExpectedVersion: 2,
      predecessorEventId: authorized.id,
      relatedOperationId: authorized.operation_id,
      authorizationOperationId: authorized.operation_id,
      amountCents: phase.context.customer_total_cents,
      currency: phase.context.currency.toLowerCase(),
    });
    const assertion = await (
      await preparationAttestation(lane.posterUserId)
    ).issue({
      commandKind: 'MATERIALIZE_FAKE_WORK_ORDER',
      commandPayload: {
        idempotency_key: key,
        request_sha256: phase.requestSha256,
        secured_event_id: secured.id,
      },
    });
    const workOrder = await new PostgresUniversalV1WorkOrderRepository(
      apiDatabase
    ).finalizeMaterialization(phase, secured.id, assertion.actor_assertion_token);
    return { apiDatabase, lane, release, common, request, admit, execute, workOrder };
  }

  async function changeOrderCommandFixture() {
    const setup = await changeOrderWorkOrderFixture();
    const commands = new PostgresUniversalV1ChangeOrderCommands(setup.apiDatabase);
    const { PostgresUniversalV1ChangeOrderHistoryReader } =
      await import('../../src/services/UniversalV1ChangeOrderHistory.js');
    const materialization = materializationFixturePort(setup.apiDatabase, () => setup.release);
    const history = new PostgresUniversalV1ChangeOrderHistoryReader(
      setup.apiDatabase,
      () => setup.release
    );
    const finance = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(setup.apiDatabase),
      new PostgresFinancialProviderCommandJournal(setup.apiDatabase),
      () => setup.release,
      new PostgresUniversalV1FinancialRequestProgressReader(setup.apiDatabase)
    );
    const application = new UniversalV1ChangeOrderApplication(
      materialization,
      () => finance,
      Date.now,
      commands,
      history
    );
    const router = createUniversalContractRouter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      application
    );
    const caller = async (actor: string) => {
      const user = (await fixture.pool.query('SELECT * FROM public.users WHERE id=$1', [actor]))
        .rows[0] as NonNullable<Context['user']>;
      return router.createCaller({
        user,
        firebaseUid: user.firebase_uid ?? null,
        ip: '127.0.0.1',
        actorAttestation: await preparationAttestation(actor),
      });
    };
    const economics = (
      await fixture.pool.query(
        'SELECT customer_total_cents,hustler_payout_cents FROM public.task_scope_versions WHERE id=$1',
        [setup.lane.scopeVersionId]
      )
    ).rows[0];
    const input: ProposeUniversalV1ChangeOrderPublic = {
      work_order_id: setup.workOrder.work_order_id,
      expected_scope_version: setup.lane.scopeVersion,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'The customer requests one additional debris load.',
      proposed_scope: {
        title: 'Cleanup with additional debris hauling',
        description: 'Complete the accepted cleanup and haul one additional approved debris load.',
        requirements: null,
        checklist: ['Complete accepted cleanup', 'Haul approved debris'],
      },
      change_order_kind: 'PRICE_AND_SCOPE',
      proposed_customer_total_cents: Number(economics.customer_total_cents) + 3000,
      proposed_provider_payout_cents: Number(economics.hustler_payout_cents) + 2000,
      idempotency_key: 'command:proposal:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    const state = async () =>
      (
        await fixture.pool.query(
          'SELECT (SELECT count(*)::int FROM public.task_scope_change_proposals WHERE task_id=$1) proposals, (SELECT count(*)::int FROM public.task_scope_change_approvals a JOIN public.task_scope_change_proposals p ON p.id=a.proposal_id WHERE p.task_id=$1) approvals, (SELECT count(*)::int FROM public.task_financial_security_events WHERE task_id=$1) financial, (SELECT count(*)::int FROM public.task_work_order_amendments WHERE work_order_id=$2) amendments, worker_id FROM public.tasks WHERE id=$1',
          [setup.lane.taskId, setup.workOrder.work_order_id]
        )
      ).rows[0];
    return { ...setup, commands, caller, input, state, materialization, history, finance };
  }

  it('change order commands accept public provider proposals and independent approvals without financial effects', async () => {
    const f = await changeOrderCommandFixture(),
      before = await f.state();
    const provider = await f.caller(f.lane.providerUserId),
      customer = await f.caller(f.lane.posterUserId);
    const proposal = await provider.proposeChangeOrder(f.input);
    expect(proposal).toMatchObject({
      proposal_version: 1,
      proposer_party: 'PROVIDER',
      change_order_kind: 'PRICE_AND_SCOPE',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    for (const caller of [provider, customer]) {
      const approval = await caller.decideChangeOrder({
        proposal_id: proposal.proposal_id,
        expected_proposal_version: 1,
        decision: 'APPROVED',
        reason: 'Approve this exact changed scope and price.',
        idempotency_key: 'command:approve:' + randomUUID(),
        client_ts: new Date().toISOString(),
      });
      expect(approval).toMatchObject({
        decision: 'APPROVED',
        proposal_status: 'PENDING',
        payment_creation_performed: false,
        hard_assignment_created: false,
      });
    }
    expect(await f.state()).toEqual({
      ...before,
      proposals: before.proposals + 1,
      approvals: before.approvals + 2,
    });
    const stored = (
      await fixture.pool.query(
        'SELECT status,approved_version_id,proposed_by,request_sha256,proposed_scope_sha256 FROM public.task_scope_change_proposals WHERE id=$1',
        [proposal.proposal_id]
      )
    ).rows[0];
    expect(stored).toMatchObject({
      status: 'PENDING',
      approved_version_id: null,
      proposed_by: f.lane.providerUserId,
      proposed_scope_sha256: proposal.proposed_scope_sha256,
    });
    expect(stored.request_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('change order commands replay with fresh timestamps and reject conflicting payloads', async () => {
    const f = await changeOrderCommandFixture(),
      customer = await f.caller(f.lane.posterUserId);
    const proposal = await customer.proposeChangeOrder(f.input),
      state = await f.state();
    const replay = await customer.proposeChangeOrder({
      ...f.input,
      client_ts: new Date(Date.now() + 1000).toISOString(),
    });
    expect(replay).toEqual({ ...proposal, replayed: true });
    await expect(
      customer.proposeChangeOrder({
        ...f.input,
        observed_scope_summary: 'A conflicting description using the same key.',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      customer.proposeChangeOrder({
        ...f.input,
        expected_scope_version: f.input.expected_scope_version + 1,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await f.state()).toEqual(state);
    const decision = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: 1,
      decision: 'APPROVED' as const,
      reason: 'Approve the exact scope.',
      idempotency_key: 'command:replay:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    const approval = await customer.decideChangeOrder(decision);
    expect(
      await customer.decideChangeOrder({
        ...decision,
        client_ts: new Date(Date.now() + 1000).toISOString(),
      })
    ).toEqual({ ...approval, replayed: true });
    await expect(
      customer.decideChangeOrder({ ...decision, decision: 'REJECTED' })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('change order commands atomically reject scope-only proposals and keep money fields empty', async () => {
    const f = await changeOrderCommandFixture(),
      before = await f.state(),
      customer = await f.caller(f.lane.posterUserId);
    const {
      proposed_customer_total_cents: _total,
      proposed_provider_payout_cents: _payout,
      ...rest
    } = f.input as Extract<
      ProposeUniversalV1ChangeOrderPublic,
      { change_order_kind: 'PRICE_AND_SCOPE' }
    >;
    const proposal = await customer.proposeChangeOrder({
      ...rest,
      change_order_kind: 'SCOPE_ONLY',
    });
    const provider = await f.caller(f.lane.providerUserId);
    const decision = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: 1,
      decision: 'REJECTED' as const,
      reason: 'The proposed extra work is unavailable.',
      idempotency_key: 'command:reject:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    const rejected = await provider.decideChangeOrder(decision);
    expect(rejected).toMatchObject({
      proposal_status: 'REJECTED',
      decision: 'REJECTED',
      approver_party: 'PROVIDER',
    });
    expect(
      await provider.decideChangeOrder({ ...decision, client_ts: new Date().toISOString() })
    ).toEqual({ ...rejected, replayed: true });
    expect(
      (
        await fixture.pool.query(
          'SELECT status,reviewed_by,decision_reason,proposed_customer_total_cents,proposed_provider_payout_cents,financial_adjustment_required FROM public.task_scope_change_proposals WHERE id=$1',
          [proposal.proposal_id]
        )
      ).rows[0]
    ).toEqual({
      status: 'REJECTED',
      reviewed_by: f.lane.providerUserId,
      decision_reason: decision.reason,
      proposed_customer_total_cents: null,
      proposed_provider_payout_cents: null,
      financial_adjustment_required: false,
    });
    expect(await f.state()).toEqual({
      ...before,
      proposals: before.proposals + 1,
      approvals: before.approvals + 1,
    });
  });

  it('change order commands refuse raw DML and foreign actors before domain writes', async () => {
    const f = await changeOrderCommandFixture(),
      other = await claimedPreparation('change-order-foreign'),
      before = await f.state();
    const caller = await f.caller(other.owner.posterUserId);
    await expect(caller.proposeChangeOrder(f.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      clients
        .get('apiRole')!
        .query('INSERT INTO public.task_scope_change_proposals (task_id) VALUES ($1)', [
          f.lane.taskId,
        ])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      clients
        .get('apiRole')!
        .query("UPDATE public.task_scope_change_proposals SET status='REJECTED' WHERE task_id=$1", [
          f.lane.taskId,
        ])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      clients
        .get('apiRole')!
        .query('SELECT * FROM hx_authority.lock_change_order_write_context_v13($1,$2,$3)', [
          'PROPOSE_FAKE_CHANGE_ORDER',
          f.workOrder.work_order_id,
          f.lane.posterUserId,
        ])
    ).rejects.toMatchObject({ code: '42501' });
    expect(await f.state()).toEqual(before);
  });

  it('change order commands keep SQL Unicode length validation aligned with the signed public schema', async () => {
    const f = await changeOrderCommandFixture(),
      { client_ts, ...rest } = f.input;
    const payload = {
      ...rest,
      client_timestamp_epoch_ms: Date.parse(client_ts),
      proposed_scope: { ...rest.proposed_scope, title: '😀'.repeat(100) },
    };
    const api = clients.get('apiRole')!;
    const built = (
      await api.query('SELECT * FROM public.hxos_build_change_order_actor_request_v13($1,$2)', [
        'PROPOSE_FAKE_CHANGE_ORDER',
        payload,
      ])
    ).rows[0];
    expect(built.canonical_request.command_payload).toEqual(payload);
    for (const title of ['😀'.repeat(101), '\u00a0Untrimmed title', '\ufeffUntrimmed title']) {
      await expect(
        api.query('SELECT * FROM public.hxos_build_change_order_actor_request_v13($1,$2)', [
          'PROPOSE_FAKE_CHANGE_ORDER',
          { ...payload, proposed_scope: { ...payload.proposed_scope, title } },
        ])
      ).rejects.toThrow('PAYLOAD_INVALID');
    }
  });

  it('change order commands prevent new memberships from appearing before command commit', async () => {
    const f = await changeOrderCommandFixture(),
      api = clients.get('apiRole')!;
    const organization = (
      await fixture.pool.query(
        "INSERT INTO public.business_organizations (legal_name,display_name,client_enabled,created_by,creation_idempotency_key) VALUES ('Synthetic membership race','Synthetic membership race',true,$1,$2) RETURNING id",
        [f.lane.posterUserId, 'command:org:' + randomUUID()]
      )
    ).rows[0];
    const { client_ts, ...rest } = f.input;
    const command = {
      commandKind: 'PROPOSE_FAKE_CHANGE_ORDER' as const,
      commandPayload: { ...rest, client_timestamp_epoch_ms: Date.parse(client_ts) },
    };
    const assertion = await (await preparationAttestation(f.lane.providerUserId)).issue(command);
    const membership = await fixture.pool.connect();
    try {
      await api.query('BEGIN');
      const receipt = (
        await api.query('SELECT * FROM public.hxos_propose_authenticated_change_order_v13($1,$2)', [
          assertion.actor_assertion_token,
          command.commandPayload,
        ])
      ).rows[0];
      expect(receipt.result.proposer_party).toBe('PROVIDER');
      await membership.query('BEGIN');
      await membership.query("SET LOCAL lock_timeout='150ms'");
      await expect(
        membership.query(
          "INSERT INTO public.business_memberships (organization_id,user_id,role,status,invited_by) VALUES ($1,$2,'OWNER','ACTIVE',$3)",
          [organization.id, f.lane.providerUserId, f.lane.posterUserId]
        )
      ).rejects.toMatchObject({ code: '55P03' });
      await membership.query('ROLLBACK');
      await api.query('COMMIT');
      await membership.query(
        "INSERT INTO public.business_memberships (organization_id,user_id,role,status,invited_by) VALUES ($1,$2,'OWNER','ACTIVE',$3)",
        [organization.id, f.lane.providerUserId, f.lane.posterUserId]
      );
      expect((await f.state()).proposals).toBe(1);
    } finally {
      await api.query('ROLLBACK');
      await membership.query('ROLLBACK');
      membership.release();
    }
  });

  it('change order commands recheck actor revocation after assertion issuance without creating a proposal', async () => {
    const f = await changeOrderCommandFixture(),
      before = await f.state(),
      { client_ts, ...rest } = f.input;
    const command = {
      commandKind: 'PROPOSE_FAKE_CHANGE_ORDER' as const,
      commandPayload: { ...rest, client_timestamp_epoch_ms: Date.parse(client_ts) },
    };
    const assertion = await (await preparationAttestation(f.lane.posterUserId)).issue(command);
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      f.lane.posterUserId,
    ]);
    await expect(
      clients
        .get('apiRole')!
        .query('SELECT * FROM public.hxos_propose_authenticated_change_order_v13($1,$2)', [
          assertion.actor_assertion_token,
          command.commandPayload,
        ])
    ).rejects.toThrow();
    expect(await f.state()).toEqual(before);
  });

  // Preserve synthetic database diagnostics when the production command client
  // deliberately redacts its public error. This wrapper performs no retry.
  function materializationFixturePort(
    database: Database,
    authorize: ConstructorParameters<typeof PostgresUniversalV1ChangeOrderMaterialization>[1]
  ) {
    let databaseFailure: unknown;
    const diagnosticDatabase = {
      ...database,
      transaction: async (callback) => {
        try {
          return await database.transaction(callback);
        } catch (error) {
          databaseFailure = error;
          throw error;
        }
      },
    } as Database;
    const port = new PostgresUniversalV1ChangeOrderMaterialization(diagnosticDatabase, authorize);
    async function invoke<T>(work: () => Promise<T>): Promise<T> {
      databaseFailure = undefined;
      try {
        return await work();
      } catch (error) {
        throw databaseFailure ?? error;
      }
    }
    return {
      readKind: (...args: Parameters<typeof port.readKind>) => invoke(() => port.readKind(...args)),
      prepare: (...args: Parameters<typeof port.prepare>) => invoke(() => port.prepare(...args)),
      finalize: (...args: Parameters<typeof port.finalize>) => invoke(() => port.finalize(...args)),
    };
  }

  async function changeOrderDelegateFixture(
    authenticated:
      | boolean
      | 'public'
      | 'public_future'
      | 'public_lost_prepare'
      | 'public_lost_request' = false
  ) {
    const f = await changeOrderCommandFixture();
    const delegate = (await claimedPreparation('change-order-organization-delegate')).owner
      .posterUserId;
    const organization = (
      await fixture.pool.query(
        "SELECT * FROM public.create_business_organization($1,'Synthetic client','Synthetic client',FALSE,TRUE,$2)",
        [f.lane.posterUserId, 'delegate:org:' + randomUUID()]
      )
    ).rows[0];
    const organizationId = organization.organization_id;
    expect(typeof organizationId).toBe('string');
    await fixture.pool.query("SELECT * FROM public.set_business_member_role($1,$2,$3,'ADMIN')", [
      organizationId,
      f.lane.posterUserId,
      delegate,
    ]);
    expect(
      (
        await fixture.pool.query(
          'UPDATE public.tasks SET business_organization_id=$1 WHERE id=$2 AND work_order_id=$3 AND business_organization_id IS NULL AND universal_contract_version=1 AND worker_id IS NULL',
          [organizationId, f.lane.taskId, f.workOrder.work_order_id]
        )
      ).rowCount
    ).toBe(1);
    const proposal = await (await f.caller(f.lane.providerUserId)).proposeChangeOrder(f.input);
    for (const actorId of [delegate, f.lane.providerUserId])
      await (
        await f.caller(actorId)
      ).decideChangeOrder({
        proposal_id: proposal.proposal_id,
        expected_proposal_version: 1,
        decision: 'APPROVED',
        reason: 'Approve the exact delegated scope and price.',
        idempotency_key: 'delegate:approval:' + randomUUID(),
        client_ts: new Date().toISOString(),
      });
    const materialization = f.materialization;
    const materializationInput = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: 1,
      expected_scope_version: f.lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: 1,
      expected_financial_version: 2,
      idempotency_key: 'delegate:phase:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    let publicResult;
    if (authenticated === 'public_future')
      materializationInput.client_ts = new Date(Date.now() + 299_000).toISOString();
    if (authenticated === 'public_lost_prepare') {
      const original = materialization.prepare.bind(materialization);
      vi.spyOn(materialization, 'prepare').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('SIMULATED_LOST_PREPARATION_COMMIT_RESPONSE');
      });
    }
    if (authenticated === 'public_lost_request') {
      const original = f.finance.requestFinancialEvent.bind(f.finance);
      vi.spyOn(f.finance, 'requestFinancialEvent').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('SIMULATED_LOST_REQUEST_COMMIT_RESPONSE');
      });
    }
    if (typeof authenticated === 'string') {
      publicResult = await (
        await f.caller(delegate)
      ).authorizeAndMaterializeFakeChangeOrder(materializationInput);
      if (authenticated === 'public_lost_prepare') {
        expect(publicResult).toMatchObject({ status: 'RECOVERY_REQUIRED' });
        publicResult = await (
          await f.caller(delegate)
        ).authorizeAndMaterializeFakeChangeOrder({
          ...materializationInput,
          client_ts: new Date().toISOString(),
        });
      }
      expect(publicResult).toMatchObject({
        status: 'PENDING',
        stage: 'ADJUSTMENT',
        retry_after_ms: 1000,
      });
    }
    const { client_ts: _historyTime, ...historyInput } = materializationInput;
    const recorded =
      typeof authenticated === 'string'
        ? await f.history.read(historyInput, delegate, await preparationAttestation(delegate))
        : null;
    if (typeof authenticated === 'string' && recorded?.state !== 'PREPARED')
      throw Error('PUBLIC_PREPARATION_HISTORY_MISSING');
    if (authenticated === 'public_future') {
      if (!recorded) throw Error('PUBLIC_PREPARATION_HISTORY_MISSING');
      expect(Date.parse(recorded.phase.context.occurredAt)).toBeLessThan(
        Date.parse(materializationInput.client_ts)
      );
      expect(Date.parse(recorded.observedAt)).toBeGreaterThanOrEqual(
        Date.parse(recorded.phase.context.occurredAt)
      );
    }
    const phase = recorded
      ? recorded.phase
      : authenticated
        ? await materialization.prepare(
            delegate,
            materializationInput,
            await preparationAttestation(delegate)
          )
        : await new PostgresUniversalV1ChangeOrderRepository(
            preparationDatabase()
          ).preparePriceAndScopeMaterialization(delegate, materializationInput);
    if (phase.completed) throw Error('UNEXPECTED_DELEGATE_COMPLETION');
    const service = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(f.apiDatabase),
      new PostgresFinancialProviderCommandJournal(f.apiDatabase),
      () => f.release,
      new PostgresUniversalV1FinancialRequestProgressReader(f.apiDatabase)
    );
    const c = phase.context;
    const input: ExecuteUniversalV1FinancialEventCommand = {
      providerKind: 'FAKE',
      operationKind: 'ADJUST',
      operationId: c.adjustmentOperationId,
      idempotencyKey: phase.idempotencyKey + ':adjust',
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: c.expectedFinancialVersion + 1,
      taskDraftId: c.taskDraftId,
      taskId: c.taskId,
      eligibilityDecisionId: c.eligibilityDecisionId,
      scopeVersionId: c.scopeVersionId,
      predecessorEventId: c.predecessorEventId,
      relatedOperationId: c.predecessorOperationId,
      changeOrderId: c.proposalId,
      amountCents: c.customerTotalCents,
      currency: c.currency.toLowerCase(),
      recordedBy: delegate,
      occurredAt: c.occurredAt,
      scenario: 'SUCCESS',
    };

    const request = async (value = input) =>
      service.requestFinancialEvent(value, await preparationAttestation(value.recordedBy));
    const read = async (actorId = delegate) =>
      service.readProgress(requestedId, actorId, await preparationAttestation(actorId));
    let requestedId = '';
    const setMembership = async (status: 'ACTIVE' | 'REVOKED') =>
      fixture.pool.query(
        'UPDATE public.business_memberships SET status=$1 WHERE organization_id=$2 AND user_id=$3',
        [status, organizationId, delegate]
      );
    const effects = async () =>
      (
        await fixture.pool.query(
          'SELECT (SELECT count(*)::int FROM public.universal_v1_prepared_financial_commands WHERE operation_id=$1) AS preparations,(SELECT count(*)::int FROM public.financial_provider_command_journal WHERE operation_id=$1) AS commands,(SELECT count(*)::int FROM public.hxos_fake_financial_operations_v1 WHERE operation_id=$1) AS operations,(SELECT count(*)::int FROM public.task_financial_security_events WHERE operation_id=$1::text) AS events',
          [c.adjustmentOperationId]
        )
      ).rows[0];
    return {
      f,
      delegate,
      organizationId,
      phase,
      input,
      request,
      read,
      setMembership,
      effects,
      materialization,
      materializationInput,
      publicResult,
      setRequested: (id: string) => {
        requestedId = id;
      },
    };
  }

  it.each(['revoked_membership', 'foreign_actor', 'altered_operation', 'non_adjustment'] as const)(
    'change order materialization denies delegated preparation without exact authority: %s',
    async (kind) => {
      const setup = await changeOrderDelegateFixture();
      let input = setup.input;
      if (kind === 'revoked_membership') await setup.setMembership('REVOKED');
      if (kind === 'foreign_actor') input = { ...input, recordedBy: setup.f.lane.posterUserId };
      if (kind === 'altered_operation') input = { ...input, operationId: randomUUID() };
      if (kind === 'non_adjustment')
        input = {
          ...input,
          operationKind: 'VOID',
          changeOrderId: undefined,
          scopeVersionId: setup.f.lane.scopeVersionId,
        };
      const before = await setup.effects();
      await expect(setup.request(input)).rejects.toThrow('CUSTOMER_AUTHORITY_REVOKED');
      expect(await setup.effects()).toEqual(before);
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.universal_v1_prepared_financial_commands WHERE task_draft_id=$1 AND recorded_by=$2',
            [setup.f.lane.draftId, setup.delegate]
          )
        ).rows[0]
      ).toEqual({ count: 0 });
    },
    60_000
  );

  it.each(['active', 'revoked_before_execution', 'progress_revocation_race'] as const)(
    'change order materialization preserves exact delegate authority through ADJUST and progress: %s',
    async (kind) => {
      const setup = await changeOrderDelegateFixture();
      const requested = await setup.request();
      setup.setRequested(requested.commandId);
      const binding = await setup.f.admit(requested.commandId);
      if (kind === 'revoked_before_execution') {
        await setup.setMembership('REVOKED');
        const before = await setup.effects();
        await expect(setup.f.execute(binding)).rejects.toThrow('ADJUSTMENT_AUTHORITY_REVOKED');
        await expect(setup.request()).rejects.toThrow('CUSTOMER_AUTHORITY_REVOKED');
        await expect(setup.read()).resolves.toBeNull();
        expect(await setup.effects()).toEqual(before);
        await setup.setMembership('ACTIVE');
      }
      await setup.f.execute(binding);
      const worker = clients.get('workerRole')!;
      const outcome = (
        await worker.query(
          'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
          [
            binding.admission.job_validation_id,
            binding.workerId,
            binding.admission.recovery_lease_id,
          ]
        )
      ).rows[0];
      const event = (
        await worker.query(
          'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
          [binding.admission.job_validation_id, outcome.outcome_fact.outcome_fact_id]
        )
      ).rows[0].financial_event;
      const expected = {
        commandId: requested.commandId,
        progressState: 'MATERIALIZED',
        financialEvent: { id: event.id, status: 'SUCCEEDED' },
      };
      await expect(setup.read()).resolves.toMatchObject(expected);
      // A different active organization approver, including the original task
      // poster, cannot inspect a command issued by this immutable Phase A actor.
      await expect(setup.read(setup.f.lane.posterUserId)).resolves.toBeNull();
      await expect(setup.read(setup.f.lane.providerUserId)).resolves.toBeNull();
      expect(
        (
          await fixture.pool.query(
            'SELECT recorded_by FROM public.universal_v1_prepared_financial_commands WHERE prepared_command_id=$1',
            [requested.preparedCommandId]
          )
        ).rows[0].recorded_by
      ).toBe(setup.delegate);
      if (kind === 'progress_revocation_race') {
        const api = clients.get('apiRole')!;
        const apiPid = (await api.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const holder = await fixture.pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await holder.query('BEGIN');
          await holder.query(
            "SELECT pg_advisory_xact_lock(hashtext('financial-provider-command-recovery-v1'),hashtext($1::text))",
            [requested.commandId]
          );
          pending = setup.read().then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          let blocked = false;
          for (let attempt = 0; attempt < 50; attempt++) {
            blocked = (
              await fixture.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [
                apiPid,
              ])
            ).rows[0].blocked;
            if (blocked) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(blocked).toBe(true);
          await holder.query('SAVEPOINT revoke_membership');
          await expect(
            holder.query(
              'SELECT id FROM public.business_memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE NOWAIT',
              [setup.organizationId, setup.delegate]
            )
          ).rejects.toMatchObject({ code: '55P03' });
          await holder.query('ROLLBACK TO SAVEPOINT revoke_membership');
          await holder.query('COMMIT');
          expect(await pending).toMatchObject({ value: expected });
        } finally {
          await holder.query('ROLLBACK');
          if (pending) await pending;
          holder.release();
        }
      }
      await setup.setMembership('REVOKED');
      await expect(setup.read()).resolves.toBeNull();
      expect(await setup.effects()).toEqual({
        preparations: 1,
        commands: 1,
        operations: 1,
        events: 1,
      });
    },
    60_000
  );

  it('authenticated change order materialization commits SCOPE_ONLY through the API without financial authorization', async () => {
    const f = await changeOrderCommandFixture();
    const {
      proposed_customer_total_cents: _customer,
      proposed_provider_payout_cents: _provider,
      ...scopeInput
    } = f.input;
    const proposal = await (
      await f.caller(f.lane.providerUserId)
    ).proposeChangeOrder({ ...scopeInput, change_order_kind: 'SCOPE_ONLY' });
    for (const actor of [f.lane.posterUserId, f.lane.providerUserId])
      await (
        await f.caller(actor)
      ).decideChangeOrder({
        proposal_id: proposal.proposal_id,
        expected_proposal_version: 1,
        decision: 'APPROVED',
        reason: 'Approve exact scope with unchanged economics.',
        idempotency_key: 'scope:decision:' + randomUUID(),
        client_ts: new Date().toISOString(),
      });
    const finance = vi.fn(() => {
      throw Error('SCOPE_ONLY_FINANCE_FORBIDDEN');
    });
    const materialization = materializationFixturePort(f.apiDatabase, finance);
    const input = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: 1,
      expected_scope_version: f.lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: 1,
      expected_financial_version: 2,
      idempotency_key: 'scope:phase:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    await expect(
      materialization.readKind(
        f.lane.posterUserId,
        proposal.proposal_id,
        await preparationAttestation(f.lane.posterUserId)
      )
    ).resolves.toBe('SCOPE_ONLY');
    const result = await materialization.prepare(
      f.lane.posterUserId,
      input,
      await preparationAttestation(f.lane.posterUserId)
    );
    expect(result).toMatchObject({
      completed: true,
      result: {
        proposal_id: proposal.proposal_id,
        amendment_version: 1,
        scope_version: f.lane.scopeVersion + 1,
        adjustment_event_id: null,
        provider_kind: null,
        payment_creation_performed: false,
        hard_assignment_created: false,
        replayed: false,
      },
    });
    await expect(
      materialization.prepare(
        f.lane.posterUserId,
        { ...input, client_ts: new Date().toISOString() },
        await preparationAttestation(f.lane.posterUserId)
      )
    ).resolves.toEqual({
      ...result,
      result: { ...(result.completed ? result.result : {}), replayed: true },
    });
    expect(finance).not.toHaveBeenCalled();
    expect(await f.state()).toMatchObject({ financial: 3, amendments: 1, worker_id: null });
  }, 60_000);

  it('authenticated change order materialization prepares and finalizes an exact delegated ADJUST through API commit', async () => {
    const setup = await changeOrderDelegateFixture(true);
    const requested = await setup.request();
    setup.setRequested(requested.commandId);
    const binding = await setup.f.admit(requested.commandId);
    await setup.f.execute(binding);
    const worker = clients.get('workerRole')!;
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        binding.admission.job_validation_id,
        binding.workerId,
        binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    const phaseBefore = (
      await fixture.pool.query(
        'SELECT * FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
        [setup.phase.context.proposalId]
      )
    ).rows[0];
    const finalTime = new Date().toISOString();
    const result = await setup.materialization.finalize(
      setup.delegate,
      setup.materializationInput,
      setup.phase.requestSha256,
      event.id,
      finalTime,
      await preparationAttestation(setup.delegate)
    );
    expect(result).toMatchObject({
      proposal_id: setup.phase.context.proposalId,
      amendment_version: 1,
      scope_version: setup.phase.context.scopeVersion,
      adjustment_event_id: event.id,
      provider_kind: 'FAKE',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(
      (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
          [setup.phase.context.proposalId]
        )
      ).rows[0]
    ).toEqual(phaseBefore);
    const execution = (
      await fixture.pool.query(
        "SELECT client_occurred_at,actor_user_id FROM public.task_work_order_execution_facts WHERE work_order_amendment_id=$1 AND transition_kind='APPLY_AMENDMENT'",
        [result.amendment_id]
      )
    ).rows[0];
    expect(new Date(execution.client_occurred_at).toISOString()).toBe(finalTime);
    expect(execution.actor_user_id).toBe(setup.delegate);
    await expect(
      setup.materialization.finalize(
        setup.delegate,
        setup.materializationInput,
        setup.phase.requestSha256,
        event.id,
        new Date().toISOString(),
        await preparationAttestation(setup.delegate)
      )
    ).resolves.toEqual({ ...result, replayed: true });
    expect(await setup.f.state()).toMatchObject({ financial: 4, amendments: 1, worker_id: null });
  }, 60_000);

  it('public change order resume commits and replays scope-only through the authenticated router', async () => {
    const f = await changeOrderCommandFixture();
    const {
      proposed_customer_total_cents: _total,
      proposed_provider_payout_cents: _payout,
      ...input
    } = f.input as Extract<
      ProposeUniversalV1ChangeOrderPublic,
      { change_order_kind: 'PRICE_AND_SCOPE' }
    >;
    const proposal = await (
      await f.caller(f.lane.providerUserId)
    ).proposeChangeOrder({ ...input, change_order_kind: 'SCOPE_ONLY' });
    for (const actor of [f.lane.posterUserId, f.lane.providerUserId])
      await (
        await f.caller(actor)
      ).decideChangeOrder({
        proposal_id: proposal.proposal_id,
        expected_proposal_version: 1,
        decision: 'APPROVED',
        reason: 'Approve this exact scope-only amendment.',
        idempotency_key: 'public:scope:approve:' + randomUUID(),
        client_ts: new Date().toISOString(),
      });
    const finalization = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: 1,
      expected_scope_version: f.lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: 1,
      expected_financial_version: 2,
      idempotency_key: 'public:scope:finalize:' + randomUUID(),
      client_ts: new Date().toISOString(),
    };
    const requestSpy = vi.spyOn(f.finance, 'requestFinancialEvent');
    const result = await (
      await f.caller(f.lane.posterUserId)
    ).authorizeAndMaterializeFakeChangeOrder(finalization);
    expect(result).toMatchObject({
      status: 'MATERIALIZED',
      adjustment_event_id: null,
      provider_kind: null,
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(
      await (
        await f.caller(f.lane.posterUserId)
      ).authorizeAndMaterializeFakeChangeOrder({
        ...finalization,
        client_ts: new Date().toISOString(),
      })
    ).toEqual({ ...result, replayed: true });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(await f.state()).toMatchObject({ financial: 3, amendments: 1, worker_id: null });
  }, 60_000);

  it.each([
    'normal',
    'lost_final_commit',
    'old_phase_time',
    'lost_prepare_commit',
    'future_client_time',
    'lost_request_commit',
  ] as const)(
    'public change order resume completes delegated ADJUST: %s',
    async (mode) => {
      const setup = await changeOrderDelegateFixture(
        mode === 'lost_prepare_commit'
          ? 'public_lost_prepare'
          : mode === 'future_client_time'
            ? 'public_future'
            : mode === 'lost_request_commit'
              ? 'public_lost_request'
              : 'public'
      );
      const { f } = setup;
      const journal = (
        await fixture.pool.query(
          'SELECT command_id FROM public.financial_provider_command_journal WHERE operation_id=$1 AND idempotency_key=$2',
          [setup.phase.context.adjustmentOperationId, setup.phase.idempotencyKey + ':adjust']
        )
      ).rows;
      expect(journal).toHaveLength(1);
      expect(await setup.effects()).toEqual({
        preparations: 1,
        commands: 1,
        operations: 0,
        events: 0,
      });
      const run = () =>
        f.caller(setup.delegate).then((caller) =>
          caller.authorizeAndMaterializeFakeChangeOrder({
            ...setup.materializationInput,
            client_ts: new Date().toISOString(),
          })
        );
      expect(await run()).toMatchObject({ status: 'PENDING', stage: 'ADJUSTMENT' });
      expect(await setup.effects()).toEqual({
        preparations: 1,
        commands: 1,
        operations: 0,
        events: 0,
      });
      const phaseBefore = (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
          [setup.phase.context.proposalId]
        )
      ).rows[0];
      const binding = await f.admit(journal[0].command_id);
      await f.execute(binding);
      const worker = clients.get('workerRole')!;
      const outcome = (
        await worker.query(
          'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
          [
            binding.admission.job_validation_id,
            binding.workerId,
            binding.admission.recovery_lease_id,
          ]
        )
      ).rows[0];
      const event = (
        await worker.query(
          'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
          [binding.admission.job_validation_id, outcome.outcome_fact.outcome_fact_id]
        )
      ).rows[0].financial_event;
      if (mode === 'old_phase_time') {
        // PostgreSQL owns Phase A time. Cross the real freshness window without
        // rewriting stored facts, changing database time, or relaxing guards.
        const phaseTime = Date.parse(setup.phase.context.occurredAt);
        const deadline = phaseTime + 300_100;
        let observed = phaseTime;
        while (observed < deadline) {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(30_000, deadline - observed))
          );
          observed = Number(
            (
              await fixture.pool.query(
                'SELECT floor(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS observed_ms'
              )
            ).rows[0].observed_ms
          );
        }
        expect(observed - phaseTime).toBeGreaterThan(300_000);
      }
      if (mode === 'lost_final_commit') {
        const original = f.materialization.finalize.bind(f.materialization);
        vi.spyOn(f.materialization, 'finalize').mockImplementationOnce(async (...args) => {
          await original(...args);
          throw Error('SIMULATED_LOST_FINAL_COMMIT_RESPONSE');
        });
      }
      const result = await run();
      expect(result).toMatchObject({
        status: 'MATERIALIZED',
        adjustment_event_id: event.id,
        replayed: mode === 'lost_final_commit',
        payment_creation_performed: false,
        hard_assignment_created: false,
      });
      expect(await run()).toEqual({ ...result, replayed: true });
      expect(await setup.effects()).toEqual({
        preparations: 1,
        commands: 1,
        operations: 1,
        events: 1,
      });
      expect(await f.state()).toMatchObject({ financial: 4, amendments: 1, worker_id: null });
      expect(
        (
          await fixture.pool.query(
            'SELECT * FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
            [setup.phase.context.proposalId]
          )
        ).rows[0]
      ).toEqual(phaseBefore);
      if (result.status !== 'MATERIALIZED') throw Error('MATERIALIZATION_RESULT_MISSING');
      const execution = (
        await fixture.pool.query(
          'SELECT client_occurred_at,actor_user_id FROM public.task_work_order_execution_facts WHERE work_order_amendment_id=$1',
          [result.amendment_id]
        )
      ).rows[0];
      expect(execution.actor_user_id).toBe(setup.delegate);
      if (mode === 'old_phase_time')
        expect(
          new Date(execution.client_occurred_at).getTime() -
            Date.parse(setup.phase.context.occurredAt)
        ).toBeGreaterThan(300_000);
    },
    360_000
  );

  async function adjustmentWitnessFixture() {
    const { apiDatabase, release, lane, common, request, admit, execute, workOrder } =
      await changeOrderWorkOrderFixture();
    const changeOrders = new PostgresUniversalV1ChangeOrderRepository(preparationDatabase());
    const economics = (
      await fixture.pool.query(
        'SELECT customer_total_cents,hustler_payout_cents FROM public.task_scope_versions WHERE id=$1',
        [lane.scopeVersionId]
      )
    ).rows[0];
    const proposal = await changeOrders.proposeChangeOrder(lane.posterUserId, {
      work_order_id: workOrder.work_order_id,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'The customer requests one additional debris load.',
      proposed_scope: {
        title: 'Approved cleanup with additional debris hauling',
        description:
          'Complete the accepted yard cleanup and haul one additional approved debris load.',
        requirements: null,
        checklist: ['Complete accepted cleanup', 'Haul approved debris'],
      },
      change_order_kind: 'PRICE_AND_SCOPE',
      proposed_customer_total_cents: Number(economics.customer_total_cents) + 3000,
      proposed_provider_payout_cents: Number(economics.hustler_payout_cents) + 2000,
      idempotency_key: 'adjust:proposal:' + randomUUID(),
      client_ts: new Date().toISOString(),
    });
    for (const actor of [lane.providerUserId, lane.posterUserId]) {
      await changeOrders.decideChangeOrder(actor, {
        proposal_id: proposal.proposal_id,
        expected_proposal_version: proposal.proposal_version,
        decision: 'APPROVED',
        reason: 'Approve the exact new scope and economics.',
        idempotency_key: 'adjust:approval:' + randomUUID(),
        client_ts: new Date().toISOString(),
      });
    }
    const changePhase = await changeOrders.preparePriceAndScopeMaterialization(lane.posterUserId, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: 1,
      expected_financial_version: 2,
      idempotency_key: 'adjust:materialize:' + randomUUID(),
      client_ts: new Date().toISOString(),
    });
    if (changePhase.completed) throw Error('ADJUSTMENT_FIXTURE_ALREADY_COMPLETED');
    const c = changePhase.context;
    const adjustmentInput = (
      scenario: 'SUCCESS' | 'DECLINE' = 'SUCCESS'
    ): ExecuteUniversalV1FinancialEventCommand => ({
      ...common,
      operationKind: 'ADJUST',
      operationId: c.adjustmentOperationId,
      idempotencyKey: changePhase.idempotencyKey + ':adjust',
      lifecycleExpectedVersion: 3,
      scopeVersionId: c.scopeVersionId,
      changeOrderId: c.proposalId,
      predecessorEventId: c.predecessorEventId,
      relatedOperationId: c.predecessorOperationId,
      amountCents: c.customerTotalCents,
      currency: c.currency.toLowerCase(),
      occurredAt: c.occurredAt,
      scenario,
    });
    return {
      apiDatabase,
      release,
      lane,
      changeOrders,
      admit,
      executeBinding: execute,
      changePhase,
      workOrder,
      adjustmentInput,
      requestAdjustment: (scenario: 'SUCCESS' | 'DECLINE' = 'SUCCESS') =>
        request(adjustmentInput(scenario)),
      effects: async () =>
        (
          await fixture.pool.query(
            `SELECT
          (SELECT count(*)::integer FROM public.hxos_fake_financial_operations_v1 WHERE operation_id=$1) AS operations,
          (SELECT count(*)::integer FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS events`,
            [c.adjustmentOperationId]
          )
        ).rows[0],
    };
  }

  async function adjustmentExecutionFixture() {
    const setup = await adjustmentWitnessFixture();
    const requested = await setup.requestAdjustment();
    const binding = await setup.admit(requested.commandId);
    return {
      ...setup,
      requested,
      binding,
      execute: (client?: pg.Client) => setup.executeBinding(binding, client),
    };
  }

  it.each([
    'success',
    'customer_revoked',
    'provider_revoked',
    'provider_trust_hold',
    'replay_after_revocation',
  ] as const)(
    'adjustment execution revalidates current authority: %s',
    async (scenario) => {
      const setup = await adjustmentExecutionFixture();
      if (scenario === 'success' || scenario === 'replay_after_revocation') {
        const result = await setup.execute();
        expect(result).toMatchObject({
          operation_kind: 'ADJUST',
          state: 'SUCCEEDED',
          idempotency_replayed: false,
        });
        expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
        if (scenario === 'replay_after_revocation') {
          await fixture.pool.query(
            "UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1",
            [setup.lane.posterUserId]
          );
          expect(await setup.execute()).toMatchObject({
            event_id: result.event_id,
            idempotency_replayed: true,
          });
          expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
        }
        return;
      }
      const actor =
        scenario === 'customer_revoked' ? setup.lane.posterUserId : setup.lane.providerUserId;
      await fixture.pool.query(
        scenario === 'provider_trust_hold'
          ? 'UPDATE public.users SET trust_hold=true,trust_hold_until=NULL WHERE id=$1'
          : "UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1",
        [actor]
      );
      await expect(setup.execute()).rejects.toThrow(
        /HXUV1-FINEXEC-13-ADJUSTMENT_AUTHORITY_REVOKED/u
      );
      expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
      const retained = (
        await fixture.pool.query(
          `SELECT (SELECT count(*)::integer FROM public.financial_provider_command_journal WHERE command_id=$1) AS requests,
                (SELECT count(*)::integer FROM hx_authority.fake_financial_dispatch_admissions_v13 WHERE command_id=$1) AS admissions`,
          [setup.requested.commandId]
        )
      ).rows[0];
      expect(retained).toEqual({ requests: 1, admissions: 1 });
      await fixture.pool.query(
        scenario === 'provider_trust_hold'
          ? 'UPDATE public.users SET trust_hold=false,trust_hold_until=NULL WHERE id=$1'
          : "UPDATE public.users SET account_status='ACTIVE' WHERE id=$1",
        [actor]
      );
      expect(await setup.execute()).toMatchObject({
        state: 'SUCCEEDED',
        idempotency_replayed: false,
      });
      expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
    },
    60_000
  );

  it.each(['proposal', 'fulfillment', 'provider_row'] as const)(
    'adjustment execution refuses domain lock contention and retries after release: %s',
    async (lock) => {
      const setup = await adjustmentExecutionFixture();
      const holder = await fixture.pool.connect();
      try {
        await holder.query('BEGIN');
        if (lock === 'provider_row') {
          await holder.query('UPDATE public.users SET trust_hold=trust_hold WHERE id=$1', [
            setup.lane.providerUserId,
          ]);
        } else {
          await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            lock === 'proposal'
              ? 'universal-v1-change-order-proposal:' + setup.changePhase.context.proposalId
              : 'fulfillment:' + setup.workOrder.work_order_id,
          ]);
        }
        await expect(setup.execute()).rejects.toThrow(
          lock === 'provider_row'
            ? /could not obtain lock/u
            : /HXUV1-FINEXEC-13-ADJUSTMENT_LOCK_BUSY/u
        );
        expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await setup.execute()).toMatchObject({
        state: 'SUCCEEDED',
        idempotency_replayed: false,
      });
      expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
    },
    60_000
  );

  async function claimChangeOrderRecovery(
    client: pg.Client | pg.Pool,
    leaseOwnerId = randomUUID(),
    overrides: unknown[] = [],
    leaseDurationSeconds = 300
  ) {
    const target = (
      await fixture.pool.query(
        'SELECT target_authority_id,target_database_name,environment,release_manifest_sha256 FROM hx_authority.universal_v1_work_order_target_authority_facts t WHERE NOT EXISTS(SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts s WHERE s.supersedes_target_authority_id=t.target_authority_id)'
      )
    ).rows[0];
    return client.query(
      'SELECT * FROM public.hxos_claim_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8)',
      overrides.length
        ? overrides
        : [
            target.target_authority_id,
            target.target_database_name,
            target.environment,
            target.release_manifest_sha256,
            leaseOwnerId,
            100,
            leaseDurationSeconds,
            5,
          ]
    );
  }

  async function observeChangeOrderRecovery(
    lease: pg.QueryResultRow,
    client = clients.get('workerRole')!,
    overrides: unknown[] = []
  ) {
    return client.query(
      'SELECT * FROM public.hxos_observe_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      overrides.length
        ? overrides
        : [
            lease.target_authority_id,
            new URL(fixture.databaseUrl).pathname.slice(1),
            'local',
            lease.release_manifest_digest,
            lease.proposal_id,
            lease.recovery_lease_id,
            lease.lease_owner_id,
            lease.witness_request_sha256,
            lease.work_order_id,
          ]
    );
  }

  async function recoveryObservationLease(
    setup: Pick<Awaited<ReturnType<typeof adjustmentWitnessFixture>>, 'changePhase'>,
    leaseDurationSeconds = 300
  ) {
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.changePhase.context.proposalId]
    );
    const result = await claimChangeOrderRecovery(
      clients.get('workerRole')!,
      undefined,
      [],
      leaseDurationSeconds
    );
    const lease = result.rows.find(
      (row) => row.proposal_id === setup.changePhase.context.proposalId
    )!;
    expect(lease).toBeDefined();
    return lease;
  }

  async function compensationWinnerFixture(leaseDurationSeconds = 300) {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    await setup.execute();
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        setup.binding.admission.job_validation_id,
        setup.binding.workerId,
        setup.binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        setup.binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    const lease = await recoveryObservationLease(setup, leaseDurationSeconds);
    return { setup, event, lease };
  }

  async function claimCompensationWinner(
    lease: pg.QueryResultRow,
    eventId: string,
    client = clients.get('workerRole')!,
    overrides: unknown[] = []
  ) {
    return client.query(
      'SELECT * FROM public.hxos_claim_fake_financial_change_order_compensation_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      overrides.length
        ? overrides
        : [
            lease.target_authority_id,
            new URL(fixture.databaseUrl).pathname.slice(1),
            'local',
            lease.release_manifest_digest,
            lease.proposal_id,
            lease.recovery_lease_id,
            lease.lease_owner_id,
            lease.witness_request_sha256,
            lease.work_order_id,
            eventId,
          ]
    );
  }

  it('worker change order reversal prepares without participant reauthorization', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const winner = (await claimCompensationWinner(lease, event.id)).rows[0].resolution.command;
    const request = {
      amountCents: Number(winner.amount_cents),
      currency: winner.currency.toLowerCase(),
      expectedVersion: 0,
      idempotencyKey: winner.reversal_idempotency_key,
      operationId: winner.reversal_operation_id,
      relatedOperationId: winner.adjustment_operation_id,
      scenario: 'REVERSAL',
    };
    const canonical = JSON.stringify(request);
    const args = [
      lease.target_authority_id,
      new URL(fixture.databaseUrl).pathname.slice(1),
      'local',
      lease.release_manifest_digest,
      winner.compensation_command_id,
      canonical,
    ];
    const sql =
      'SELECT * FROM public.hxos_prepare_change_order_compensation_reversal_v13($1,$2,$3,$4,$5,$6)';
    const result = await clients.get('workerRole')!.query(sql, args);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      idempotency_replayed: false,
      prepared_command: {
        operation_kind: 'REVERSAL',
        operation_id: winner.reversal_operation_id,
        recorded_by: setup.lane.posterUserId,
        scope_version_id: winner.base_scope_version_id,
        change_order_id: null,
        completion_fact_id: null,
        predecessor_event_id: event.id,
        related_operation_id: winner.adjustment_operation_id,
        lifecycle_expected_version: winner.lifecycle_expected_version,
      },
      worker_provenance: {
        compensation_command_id: winner.compensation_command_id,
        service_database_role: roles.workerRole,
        target_authority_id: lease.target_authority_id,
      },
    });
    const replay = await clients.get('workerRole')!.query(sql, args);
    expect(replay.rows[0]).toEqual({ ...result.rows[0], idempotency_replayed: true });
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.financial_provider_command_journal WHERE operation_id=$1',
          [winner.reversal_operation_id]
        )
      ).rows[0].n
    ).toBe(0);
  }, 60_000);

  async function workerReversalFixture(leaseSeconds = 300) {
    const f = await compensationWinnerFixture(leaseSeconds);
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      f.setup.lane.posterUserId,
    ]);
    const winner = (await claimCompensationWinner(f.lease, f.event.id)).rows[0].resolution.command;
    const request = {
      amountCents: Number(winner.amount_cents),
      currency: winner.currency.toLowerCase(),
      expectedVersion: 0,
      idempotencyKey: winner.reversal_idempotency_key,
      operationId: winner.reversal_operation_id,
      relatedOperationId: winner.adjustment_operation_id,
      scenario: 'REVERSAL',
    };
    const prepareArgs = [
      f.lease.target_authority_id,
      new URL(fixture.databaseUrl).pathname.slice(1),
      'local',
      f.lease.release_manifest_digest,
      winner.compensation_command_id,
      JSON.stringify(request),
    ];
    const prepare = async (client = clients.get('workerRole')!, args = prepareArgs) =>
      (
        await client.query(
          'SELECT * FROM public.hxos_prepare_change_order_compensation_reversal_v13($1,$2,$3,$4,$5,$6)',
          args
        )
      ).rows[0];
    const journalInput = (p: pg.QueryResultRow) => ({
      operationKind: 'REVERSAL' as const,
      operationId: winner.reversal_operation_id,
      providerKind: 'FAKE' as const,
      idempotencyKey: winner.reversal_idempotency_key,
      providerExpectedVersion: 0,
      exactRequest: request,
      evidence: {
        preparedFinancialCommandId: p.prepared_command_id,
        preparedAuthoritySha256: p.authority_context_sha256,
        taskDraftId: winner.task_draft_id,
        taskId: winner.task_id,
        workOrderId: winner.work_order_id,
        relatedOperationId: winner.adjustment_operation_id,
        amountCents: Number(winner.amount_cents),
        currency: winner.currency,
      },
      actor: { actorId: winner.requested_by, actorKind: 'PARTICIPANT' as const },
      release: {
        manifestDigest: f.lease.release_manifest_digest,
        releaseId: 'synthetic.worker.reversal',
        revision: 'd'.repeat(40),
        environment: 'local' as const,
        authenticationStatus: 'VERIFIED' as const,
      },
    });
    const requested = async (p: pg.QueryResultRow, client = clients.get('workerRole')!) =>
      new PostgresFinancialProviderCommandJournal(preparationDatabase(client)).recordRequested(
        journalInput(p)
      );
    const counts = async () =>
      (
        await fixture.pool.query(
          `SELECT
      (SELECT count(*)::int FROM public.universal_v1_prepared_financial_commands WHERE operation_id=$1) AS preparations,
      (SELECT count(*)::int FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE compensation_command_id=$2) AS origins,
      (SELECT count(*)::int FROM public.financial_provider_command_journal WHERE operation_id=$1) AS requests,
      (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS events`,
          [winner.reversal_operation_id, winner.compensation_command_id]
        )
      ).rows[0];
    return { ...f, winner, request, prepareArgs, prepare, journalInput, requested, counts };
  }

  async function completedWorkerReversalFixture(leaseSeconds = 300) {
    const f = await workerReversalFixture(leaseSeconds);
    const prepared = await f.prepare();
    const requested = await f.requested(prepared.prepared_command);
    const binding = await f.setup.admit(requested.commandId);
    await f.setup.executeBinding(binding);
    const worker = clients.get('workerRole')!;
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        binding.admission.job_validation_id,
        binding.workerId,
        binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const reversalEvent = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    return { ...f, reversalEvent };
  }

  it.each(['PREPARED', 'REQUESTED'] as const)(
    'worker reversal adapter resumes lost %s acknowledgement through real Redis delivery',
    async (lostPhase) => {
      const f = await workerReversalFixture();
      const workerUrl = new URL(fixture.databaseUrl);
      workerUrl.username = roles.workerRole;
      workerUrl.password = password;
      const workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 4 });
      const workerDatabase = preparationDatabase(workerPool);
      const release = {
        manifestDigest: f.lease.release_manifest_digest as string,
        releaseId: 'synthetic.worker.reversal',
        revision: 'd'.repeat(40),
        environment: 'local' as const,
        authenticationStatus: 'VERIFIED' as const,
      };
      const prefix = 'hx-ci-worker-reversal-' + randomUUID();
      const connection = { host: '127.0.0.1', port: 16379, maxRetriesPerRequest: null };
      const queue = new Queue('synthetic_finance', { prefix, connection });
      const events = new QueueEvents('synthetic_finance', { prefix, connection });
      const processor = new SyntheticFinancialCommandProcessor();
      const consumer = new Worker('synthetic_finance', (job) => processor.process(job), {
        prefix,
        connection,
        autorun: false,
        concurrency: 1,
      });
      const runtimeErrors: unknown[] = [];
      const recordError = (error: Error) => {
        runtimeErrors.push(error);
      };
      queue.on('error', recordError);
      events.on('error', recordError);
      consumer.on('error', recordError);
      const processorSql: string[] = [];
      const spies = [
        vi.spyOn(runtimeDb, 'transaction').mockImplementation((callback) =>
          workerDatabase.transaction((query) =>
            callback(async <Row>(sql: string, params?: unknown[]) => {
              processorSql.push(sql);
              return query<Row>(sql, params);
            })
          )
        ),
        vi
          .spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized')
          .mockReturnValue({
            releaseId: release.releaseId,
            environment: 'local',
            components: {
              backend: { revision: 'c'.repeat(40) },
              worker: { revision: release.revision },
            },
          } as ReturnType<typeof financialAuthorization.assertNonproductionFakeFinanceAuthorized>),
        vi
          .spyOn(manifestAuthority, 'releaseManifestDigest')
          .mockReturnValue(release.manifestDigest),
        vi
          .spyOn(manifestAuthority, 'readReleaseManifest')
          .mockReturnValue({ digest: release.manifestDigest } as ReturnType<
            typeof manifestAuthority.readReleaseManifest
          >),
        vi.spyOn(manifestAuthority, 'isAuthenticatedReleaseManifest').mockReturnValue(true),
        vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
          expectedTarget: { environment: 'local', databaseName: workerUrl.pathname.slice(1) },
          target: { serviceLogin: roles.workerRole },
          targetDigest: 'sha256:' + 'e'.repeat(64),
        } as ReturnType<typeof databaseStartup.configuredRuntimeDatabaseStartup>),
      ];
      let running: Promise<void> | undefined, journeyError: unknown;
      try {
        const winner = await new PostgresUniversalV1ChangeOrderRecoveryCompensation(
          workerDatabase
        ).claim(
          {
            ...f.lease,
            acquired_at: f.lease.acquired_at.toISOString(),
            expires_at: f.lease.expires_at.toISOString(),
          } as Parameters<PostgresUniversalV1ChangeOrderRecoveryCompensation['claim']>[0],
          f.event.id
        );
        if (!winner || winner.resolution.kind !== 'COMPENSATE' || !winner.workerOrigin)
          throw Error('WORKER_WINNER_MISSING');
        const originalWinner = structuredClone(winner);
        let armed = true;
        const interrupted: Pick<Database, 'transaction'> = {
          transaction: async (work) => {
            let phaseCommitted = false;
            const result = await workerDatabase.transaction((query) =>
              work(async <Row>(sql: string, params?: unknown[]) => {
                const reply = await query<Row>(sql, params);
                if (
                  sql.includes(
                    lostPhase === 'PREPARED'
                      ? 'hxos_prepare_change_order_compensation_reversal_v13'
                      : 'hxos_request_fake_financial_command_v13'
                  )
                )
                  phaseCommitted = true;
                return reply;
              })
            );
            // Inject loss after actual COMMIT, never from inside its callback.
            if (armed && phaseCommitted) {
              armed = false;
              throw Error('SYNTHETIC_COMMIT_ACK_LOST');
            }
            return result;
          },
        };
        await expect(
          new PostgresUniversalV1ChangeOrderReversalRequests(interrupted).requestReversal(winner)
        ).rejects.toThrow('SYNTHETIC_COMMIT_ACK_LOST');
        expect(await f.counts()).toEqual({
          preparations: 1,
          origins: 1,
          requests: lostPhase === 'REQUESTED' ? 1 : 0,
          events: 0,
        });
        const retainedPreparation = (
          await fixture.pool.query(
            'SELECT prepared_command_id,authority_context_sha256 FROM public.universal_v1_prepared_financial_commands WHERE operation_id=$1',
            [f.winner.reversal_operation_id]
          )
        ).rows[0];
        const port = new PostgresUniversalV1ChangeOrderReversalRequests(workerDatabase);
        const requested = await port.requestReversal(winner);
        expect(requested).toMatchObject({
          requestState: 'REQUESTED',
          preparationReplayed: true,
          idempotencyReplayed: lostPhase === 'REQUESTED',
          preparedCommandId: retainedPreparation.prepared_command_id,
          preparedAuthoritySha256: retainedPreparation.authority_context_sha256,
          compensationCommandId: f.winner.compensation_command_id,
          operationId: f.winner.reversal_operation_id,
        });
        expect(await port.requestReversal(winner)).toEqual({
          ...requested,
          idempotencyReplayed: true,
        });
        const counts = async () =>
          (
            await fixture.pool.query(
              `SELECT
        (SELECT count(*)::int FROM public.universal_v1_prepared_financial_commands WHERE operation_id=$1) AS preparations,
        (SELECT count(*)::int FROM hx_authority.fake_financial_change_order_reversal_preparations_v13 WHERE compensation_command_id=$4) AS worker_provenance,
        (SELECT count(*)::int FROM hx_authority.fake_financial_preparation_authority_v13 WHERE prepared_command_id=$5) AS human_provenance,
        (SELECT count(*)::int FROM public.financial_provider_command_journal WHERE operation_id=$1) AS requests,
        (SELECT count(*)::int FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$2) AS outbox,
        (SELECT count(*)::int FROM hx_authority.fake_financial_dispatch_admissions_v13 WHERE command_id=$2) AS admissions,
        (SELECT count(*)::int FROM public.financial_provider_command_dispatch_attempts WHERE command_id=$2) AS dispatches,
        (SELECT count(*)::int FROM public.hxos_fake_financial_operations_v1 WHERE operation_id=$1) AS operations,
        (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS provider_events,
        (SELECT count(*)::int FROM public.financial_provider_command_outcome_facts WHERE command_id=$2) AS outcomes,
        (SELECT count(*)::int FROM public.universal_v1_fake_financial_lifecycle_bridges WHERE command_id=$2) AS bridges,
        (SELECT count(*)::int FROM public.task_financial_security_events WHERE operation_id=$1::text AND event_kind='REVERSED' AND status='SUCCEEDED') AS reversals,
        (SELECT count(*)::int FROM public.task_work_order_amendments WHERE change_order_id=$3) AS amendments,
        (SELECT count(*)::int FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$3) AS terminals`,
              [
                f.winner.reversal_operation_id,
                requested.commandId,
                f.winner.proposal_id,
                f.winner.compensation_command_id,
                requested.preparedCommandId,
              ]
            )
          ).rows[0];
        const before = {
          preparations: 1,
          worker_provenance: 1,
          human_provenance: 0,
          requests: 1,
          outbox: 1,
          admissions: 0,
          dispatches: 0,
          operations: 0,
          provider_events: 0,
          outcomes: 0,
          bridges: 0,
          reversals: 0,
          amendments: 0,
          terminals: 0,
        };
        expect(await counts()).toEqual(before);
        await Promise.all([
          events.waitUntilReady(),
          consumer.waitUntilReady(),
          queue.waitUntilReady(),
        ]);
        const publisher = new FakeFinancialOutboxPublisher(
          new PostgresFakeFinancialOutboxRepository(workerDatabase),
          createFakeFinancialOutboxTransport({ redisUrl: process.env.REDIS_URL, prefix }),
          () => {
            financialAuthorization.assertNonproductionFakeFinanceAuthorized({
              component: 'worker',
            });
          },
          { publisherId: randomUUID(), batchLimit: 1 }
        );
        const outbox = (
          await fixture.pool.query(
            'SELECT bullmq_job_id FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$1',
            [requested.commandId]
          )
        ).rows[0];
        expect(await publisher.runOnce()).toMatchObject({
          claimed: 1,
          confirmed: 1,
          persistenceErrors: 0,
        });
        const job = await queue.getJob(outbox.bullmq_job_id);
        if (!job) throw Error('WORKER_REVERSAL_QUEUE_JOB_MISSING');
        const finished = job.waitUntilFinished(events, 20_000);
        running = consumer.run().catch(recordError);
        await finished;
        const after = {
          ...before,
          admissions: 1,
          dispatches: 1,
          operations: 1,
          provider_events: 1,
          outcomes: 1,
          bridges: 1,
          reversals: 1,
        };
        expect(await counts()).toEqual(after);
        const callCount = (name: string) =>
          processorSql.filter((sql) => sql.includes(name + '(')).length;
        const executionPorts = [
          'record_fake_financial_job_dispatch_evidence_v13',
          'hxos_read_admitted_fake_financial_request_v13',
          'hxos_execute_admitted_fake_financial_request_v13',
          'hxos_record_fake_financial_outcome_v13',
        ];
        for (const name of executionPorts) expect(callCount(name), name).toBe(1);
        expect(callCount('hxos_read_fake_financial_progress_v13')).toBe(1);
        expect(callCount('hxos_materialize_fake_financial_event_v13')).toBe(1);
        await consumer.pause();
        await job.retry('completed');
        const replay = job.waitUntilFinished(events, 20_000);
        consumer.resume();
        await replay;
        expect(await counts()).toEqual(after);
        for (const name of executionPorts) expect(callCount(name), name).toBe(1);
        expect(callCount('hxos_read_fake_financial_progress_v13')).toBe(2);
        expect(callCount('hxos_materialize_fake_financial_event_v13')).toBe(2);
        expect(await port.requestReversal(winner)).toEqual({
          ...requested,
          idempotencyReplayed: true,
        });
        expect(winner).toEqual(originalWinner);
        expect(
          (
            await fixture.pool.query(
              'SELECT worker_id,universal_payment_posture FROM public.tasks WHERE id=$1',
              [f.winner.task_id]
            )
          ).rows[0]
        ).toEqual({ worker_id: null, universal_payment_posture: 'PAYMENT_CREATION_FROZEN' });
        expect(
          (
            await fixture.pool.query('SELECT is_banned FROM public.users WHERE id=$1', [
              f.winner.requested_by,
            ])
          ).rows[0].is_banned
        ).toBe(true);
        expect(runtimeErrors).toEqual([]);
      } catch (error) {
        journeyError = error;
        throw error;
      } finally {
        const cleanupErrors: unknown[] = [];
        try {
          for (const close of [
            () => consumer.close(),
            async () => {
              if (running) await running;
            },
            () => events.close(),
            () => queue.obliterate({ force: true }),
            () => queue.close(),
            () => workerPool.end(),
          ]) {
            try {
              await close();
            } catch (error) {
              cleanupErrors.push(error);
            }
          }
        } finally {
          for (const spy of spies) spy.mockRestore();
        }
        if (!journeyError && cleanupErrors.length)
          throw new AggregateError(cleanupErrors, 'WORKER_REVERSAL_TRANSPORT_CLEANUP_FAILED');
      }
    },
    60_000
  );

  it('worker change order reversal commits request and admitted effect after origin lease expiry', async () => {
    const f = await workerReversalFixture(5),
      worker = clients.get('workerRole')!;
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.05))',
      [f.lease.expires_at]
    );
    expect((await observeChangeOrderRecovery(f.lease)).rows).toHaveLength(0);
    const p = await f.prepare(),
      requested = await f.requested(p.prepared_command),
      binding = await f.setup.admit(requested.commandId);
    const raw = await f.setup.executeBinding(binding);
    expect(raw).toMatchObject({
      operation_kind: 'REVERSAL',
      state: 'REVERSED',
      idempotency_replayed: false,
    });
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        binding.admission.job_validation_id,
        binding.workerId,
        binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const materialized = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0];
    expect(materialized.financial_event).toMatchObject({
      event_kind: 'REVERSED',
      status: 'SUCCEEDED',
      expected_version: Number(f.winner.lifecycle_expected_version),
      scope_version_id: f.winner.base_scope_version_id,
    });
    expect(await f.prepare()).toEqual({ ...p, idempotency_replayed: true });
    expect(await f.requested(p.prepared_command)).toEqual({
      ...requested,
      idempotencyReplayed: true,
    });
    await expect(f.setup.executeBinding(binding)).rejects.toThrow('DISPATCH_NOT_OPEN');
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 1, events: 1 });
    expect(
      (
        await fixture.pool.query(
          'SELECT worker_id,universal_payment_posture FROM public.tasks WHERE id=$1',
          [f.winner.task_id]
        )
      ).rows[0]
    ).toEqual({ worker_id: null, universal_payment_posture: 'PAYMENT_CREATION_FROZEN' });
  }, 60_000);

  it('worker change order reversal denies API preparation and request including replay', async () => {
    const f = await workerReversalFixture();
    for (const role of ['apiRole', 'attesterRole'] as const)
      await expect(f.prepare(clients.get(role)!)).rejects.toThrow(/permission denied/u);
    const p = await f.prepare();
    await expect(f.requested(p.prepared_command, clients.get('apiRole')!)).rejects.toThrow(
      'WORKER_REQUEST_REQUIRED'
    );
    const r = await f.requested(p.prepared_command);
    await f.setup.admit(r.commandId);
    await expect(f.requested(p.prepared_command, clients.get('apiRole')!)).rejects.toThrow(
      'WORKER_REQUEST_REQUIRED'
    );
    expect(await f.requested(p.prepared_command)).toEqual({ ...r, idempotencyReplayed: true });
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 1, events: 0 });
  }, 60_000);

  it('worker change order reversal rejects substituted request and exact preparation conflicts', async () => {
    const f = await workerReversalFixture();
    for (const patch of [
      { amountCents: f.request.amountCents + 1 },
      { currency: 'eur' },
      { operationId: randomUUID() },
      { relatedOperationId: randomUUID() },
      { idempotencyKey: 'substituted:reversal:' + randomUUID() },
      { expectedVersion: 1 },
    ]) {
      const args = [...f.prepareArgs];
      args[5] = JSON.stringify({ ...f.request, ...patch });
      await expect(f.prepare(clients.get('workerRole')!, args)).rejects.toThrow(
        /REQUEST_IDENTITY_INVALID|REQUEST_INVALID/u
      );
    }
    const p = await f.prepare(),
      args = [...f.prepareArgs];
    args[5] = JSON.stringify({ ...f.request, scenario: 'DECLINE' });
    await expect(f.prepare(clients.get('workerRole')!, args)).rejects.toThrow(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(await f.prepare()).toEqual({ ...p, idempotency_replayed: true });
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 0, events: 0 });
  }, 60_000);

  it('worker change order reversal rolls back preparation and refuses participant adoption after restoration', async () => {
    const f = await workerReversalFixture(),
      worker = clients.get('workerRole')!;
    await worker.query('BEGIN');
    try {
      await f.prepare();
    } finally {
      await worker.query('ROLLBACK');
    }
    expect(await f.counts()).toEqual({ preparations: 0, origins: 0, requests: 0, events: 0 });
    await fixture.pool.query('UPDATE public.users SET is_banned=FALSE WHERE id=$1', [
      f.winner.requested_by,
    ]);
    const authority = new PostgresUniversalV1PreparedFinancialCommandAuthority(
      preparationDatabase(clients.get('apiRole')!)
    );
    await expect(
      authority.prepare(
        {
          operationKind: 'REVERSAL',
          operationId: f.winner.reversal_operation_id,
          providerKind: 'FAKE',
          idempotencyKey: f.winner.reversal_idempotency_key,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: Number(f.winner.lifecycle_expected_version),
          providerRequestSha256: createHash('sha256')
            .update(JSON.stringify(f.request))
            .digest('hex'),
          taskDraftId: f.winner.task_draft_id,
          taskId: f.winner.task_id,
          eligibilityDecisionId: f.winner.eligibility_decision_id,
          scopeVersionId: f.winner.base_scope_version_id,
          changeOrderId: null,
          predecessorEventId: f.winner.adjustment_event_id,
          completionFactId: null,
          relatedOperationId: f.winner.adjustment_operation_id,
          amountCents: Number(f.winner.amount_cents),
          currency: f.winner.currency,
          recordedBy: f.winner.requested_by,
        },
        await preparationAttestation(f.winner.requested_by)
      )
    ).rejects.toThrow('WORKER_PREPARATION_REQUIRED');
    expect(await f.counts()).toEqual({ preparations: 0, origins: 0, requests: 0, events: 0 });
    await f.prepare();
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 0, events: 0 });
  }, 60_000);

  it('worker change order reversal refuses privileged domain corruption at request and first execution', async () => {
    const f = await workerReversalFixture(),
      p = await f.prepare();
    // Owner-only fault injection: the ordinary task writer correctly refuses this immutable change.
    // Test the independent worker boundary against already-corrupt domain state.
    const classify = async (value: string) => {
      const owner = await fixture.pool.connect();
      try {
        await owner.query('BEGIN');
        await owner.query("SET LOCAL session_replication_role='replica'");
        await owner.query('UPDATE public.tasks SET automation_classification=$1 WHERE id=$2', [
          value,
          f.winner.task_id,
        ]);
        await owner.query('COMMIT');
      } finally {
        await owner.query('ROLLBACK');
        owner.release();
      }
    };
    await classify('UNCLASSIFIED');
    await expect(f.requested(p.prepared_command)).rejects.toThrow('DOMAIN_AUTHORITY_CHANGED');
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 0, events: 0 });
    await classify('CONTROLLED_TEST');
    const r = await f.requested(p.prepared_command),
      binding = await f.setup.admit(r.commandId);
    await classify('UNCLASSIFIED');
    expect(await f.requested(p.prepared_command)).toEqual({ ...r, idempotencyReplayed: true });
    await expect(f.setup.executeBinding(binding)).rejects.toThrow('DOMAIN_AUTHORITY_CHANGED');
    expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 1, events: 0 });
    await classify('CONTROLLED_TEST');
    const raw = await f.setup.executeBinding(binding);
    await classify('UNCLASSIFIED');
    expect(await f.setup.executeBinding(binding)).toMatchObject({
      event_id: raw.event_id,
      idempotency_replayed: true,
    });
  }, 60_000);

  it('worker change order reversal refuses preparation and request lock inversion', async () => {
    const f = await workerReversalFixture(),
      holder = await fixture.pool.connect();
    try {
      for (const [family, key] of [
        ['domain', 'universal-v1-change-order-proposal:' + f.winner.proposal_id],
        ['domain', 'fulfillment:' + f.winner.work_order_id],
        ['financial-provider-command-recovery-v1', f.setup.requested.commandId],
        ['fake-financial-operation', f.winner.adjustment_operation_id],
        [
          'universal-v1-prepared-financial-command-v1',
          'idempotency:' + f.winner.reversal_idempotency_key,
        ],
      ]) {
        await holder.query('BEGIN');
        await holder.query(
          family === 'domain'
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
          family === 'domain' ? [key] : [family, key]
        );
        await expect(f.prepare()).rejects.toThrow('LOCK_BUSY');
        await holder.query('ROLLBACK');
      }
      const p = await f.prepare();
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('financial-provider-command-journal-v1'),hashtext($1))",
        ['idempotency:' + f.winner.reversal_idempotency_key]
      );
      await expect(f.requested(p.prepared_command)).rejects.toThrow('REQUEST_LOCK_BUSY');
      await holder.query('ROLLBACK');
      const r = await f.requested(p.prepared_command);
      await f.setup.admit(r.commandId);
      expect(await f.counts()).toEqual({ preparations: 1, origins: 1, requests: 1, events: 0 });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);

  it('worker change order compensation creates one immutable winner after customer revocation', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const result = await claimCompensationWinner(lease, event.id);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      target_authority_id: lease.target_authority_id,
      release_manifest_digest: lease.release_manifest_digest,
      resolution: {
        kind: 'COMPENSATE',
        command: {
          proposal_id: lease.proposal_id,
          witness_request_sha256: lease.witness_request_sha256,
          adjustment_event_id: event.id,
          requested_by: setup.lane.posterUserId,
          lifecycle_expected_version: setup.changePhase.context.expectedFinancialVersion + 2,
          amount_cents: setup.changePhase.context.customerTotalCents,
          semantic_limitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
        },
      },
    });
    const before = (
      await fixture.pool.query(
        'SELECT to_jsonb(c) AS command FROM public.universal_v1_change_order_compensation_commands c WHERE proposal_id=$1',
        [lease.proposal_id]
      )
    ).rows[0].command;
    const origins = await fixture.pool.query(
      'SELECT * FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE compensation_command_id=$1',
      [before.compensation_command_id]
    );
    expect(origins.rows).toHaveLength(1);
    expect(origins.rows[0]).toMatchObject({
      target_authority_id: lease.target_authority_id,
      service_database_role: roles.workerRole,
      recovery_lease_id: lease.recovery_lease_id,
      witness_request_sha256: lease.witness_request_sha256,
      adjustment_event_id: event.id,
      revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
    });
    await fixture.pool.query('UPDATE public.users SET is_banned=FALSE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    expect((await claimCompensationWinner(lease, event.id)).rows[0].resolution.command).toEqual(
      before
    );
    expect(
      (
        await fixture.pool.query(
          'SELECT * FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE compensation_command_id=$1',
          [before.compensation_command_id]
        )
      ).rows
    ).toEqual(origins.rows);
    expect((await observeChangeOrderRecovery(lease)).rows[0].observation.recovery_state).toBe(
      'COMPENSATION_READY'
    );
    expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
  }, 60_000);

  it('worker change order compensation refuses active authority, temporary holds and mismatched bindings', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    await expect(claimCompensationWinner(lease, event.id)).rejects.toThrow(
      'PERMANENT_REVOCATION_REQUIRED'
    );
    await fixture.pool.query(
      'UPDATE public.users SET trust_hold=TRUE,trust_hold_until=NULL WHERE id=$1',
      [setup.lane.providerUserId]
    );
    await expect(claimCompensationWinner(lease, event.id)).rejects.toThrow(
      'PERMANENT_REVOCATION_REQUIRED'
    );
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    for (const role of ['apiRole', 'attesterRole'] as const)
      await expect(claimCompensationWinner(lease, event.id, clients.get(role)!)).rejects.toThrow(
        /permission denied/u
      );
    const args: unknown[] = [
      lease.target_authority_id,
      new URL(fixture.databaseUrl).pathname.slice(1),
      'local',
      lease.release_manifest_digest,
      lease.proposal_id,
      lease.recovery_lease_id,
      lease.lease_owner_id,
      lease.witness_request_sha256,
      lease.work_order_id,
      event.id,
    ];
    for (const [index, value] of [
      [0, randomUUID()],
      [1, 'wrong_database'],
      [2, 'staging'],
      [3, 'sha256:' + 'c'.repeat(64)],
      [4, randomUUID()],
      [5, randomUUID()],
      [6, randomUUID()],
      [7, 'a'.repeat(64)],
      [8, randomUUID()],
      [9, randomUUID()],
      [9, null],
    ] as const) {
      const altered = [...args];
      altered[index] = value;
      await expect(
        claimCompensationWinner(lease, event.id, clients.get('workerRole')!, altered)
      ).rejects.toThrow();
    }
    const counts = (
      await fixture.pool.query(
        `SELECT
      (SELECT count(*)::int FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1) AS winners,
      (SELECT count(*)::int FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE proposal_id=$1) AS origins`,
        [lease.proposal_id]
      )
    ).rows[0];
    expect(counts).toEqual({ winners: 0, origins: 0 });
    expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
  }, 60_000);

  it('worker change order compensation locks authority and rolls back winner with its origin', async () => {
    const { setup, event, lease } = await compensationWinnerFixture(),
      worker = clients.get('workerRole')!;
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const holder = await fixture.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('UPDATE public.users SET is_banned=FALSE WHERE id=$1', [
        setup.lane.posterUserId,
      ]);
      await expect(claimCompensationWinner(lease, event.id)).rejects.toThrow('LOCK_BUSY');
      await holder.query('COMMIT');
      await expect(claimCompensationWinner(lease, event.id)).rejects.toThrow(
        'PERMANENT_REVOCATION_REQUIRED'
      );
      await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
        setup.lane.posterUserId,
      ]);
      await worker.query('BEGIN');
      const provisional = (await claimCompensationWinner(lease, event.id)).rows[0];
      expect(provisional.resolution.created).toBe(true);
      expect(
        (
          await holder.query(
            'SELECT count(*)::int AS count FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1',
            [lease.proposal_id]
          )
        ).rows[0].count
      ).toBe(0);
      await worker.query('ROLLBACK');
      const counts = (
        await holder.query(
          `SELECT
        (SELECT count(*)::int FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1) AS winners,
        (SELECT count(*)::int FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE proposal_id=$1) AS origins`,
          [lease.proposal_id]
        )
      ).rows[0];
      expect(counts).toEqual({ winners: 0, origins: 0 });
      const committed = (await claimCompensationWinner(lease, event.id)).rows[0];
      expect(committed.resolution.command.compensation_command_id).toBe(
        provisional.resolution.command.compensation_command_id
      );
      expect(committed.resolution.created).toBe(true);
    } finally {
      await worker.query('ROLLBACK');
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);

  it('worker change order compensation fences new membership insertion until commit', async () => {
    const { setup, event, lease } = await compensationWinnerFixture(),
      worker = clients.get('workerRole')!;
    const organization = (
      await fixture.pool.query(
        "INSERT INTO public.business_organizations(legal_name,display_name,client_enabled,created_by,creation_idempotency_key) VALUES('Synthetic compensation race','Synthetic compensation race',true,$1,$2) RETURNING id",
        [setup.lane.posterUserId, 'compensation:org:' + randomUUID()]
      )
    ).rows[0];
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const member = await fixture.pool.connect();
    const insert =
      "INSERT INTO public.business_memberships(organization_id,user_id,role,status,invited_by) VALUES($1,$2,'OWNER','ACTIVE',$3)";
    const params = [organization.id, setup.lane.providerUserId, setup.lane.posterUserId];
    try {
      await worker.query('BEGIN');
      await claimCompensationWinner(lease, event.id);
      await member.query('BEGIN');
      await member.query("SET LOCAL lock_timeout='150ms'");
      await expect(member.query(insert, params)).rejects.toMatchObject({ code: '55P03' });
      await member.query('ROLLBACK');
      await worker.query('COMMIT');
      await member.query(insert, params);
      expect((await claimCompensationWinner(lease, event.id)).rows[0].resolution.created).toBe(
        false
      );
    } finally {
      await worker.query('ROLLBACK');
      await member.query('ROLLBACK');
      member.release();
    }
  }, 60_000);

  function recordChangeOrderTerminal(
    kind: 'materialized' | 'compensated' | 'no_effect',
    lease: pg.QueryResultRow,
    evidence: [string | null, string | null],
    client = clients.get('workerRole')!,
    overrides?: unknown[]
  ) {
    return client.query(
      `SELECT * FROM public.hxos_record_fake_financial_change_order_${kind}_v13($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      overrides ?? [
        lease.target_authority_id,
        new URL(fixture.databaseUrl).pathname.slice(1),
        'local',
        lease.release_manifest_digest,
        lease.proposal_id,
        lease.recovery_lease_id,
        lease.lease_owner_id,
        lease.witness_request_sha256,
        lease.work_order_id,
        ...evidence,
      ]
    );
  }

  async function preparedAdjustmentRequestFixture() {
    const setup = await adjustmentWitnessFixture();
    let captured: { sql: string; params: unknown[] } | undefined;
    const journalDatabase: Pick<Database, 'transaction'> = {
      transaction: async (work) =>
        work(async (sql, params) => {
          if (!sql.includes('hxos_request_fake_financial_command_v13') || !params)
            throw new Error('UNEXPECTED_JOURNAL_QUERY');
          captured = { sql, params };
          throw new Error('REQUEST_CAPTURED_BEFORE_EXECUTION');
        }),
    };
    const service = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(setup.apiDatabase),
      new PostgresFinancialProviderCommandJournal(journalDatabase),
      () => setup.release,
      new PostgresUniversalV1FinancialRequestProgressReader(setup.apiDatabase),
      new PostgresUniversalV1FinancialPredecessorReader(setup.apiDatabase)
    );
    // The real service commits authenticated preparation; intercept only the
    // later request call so tests can control its outer database transaction.
    await expect(
      service.requestFinancialEvent(
        setup.adjustmentInput(),
        await preparationAttestation(setup.lane.posterUserId)
      )
    ).rejects.toThrow('REQUEST_CAPTURED_BEFORE_EXECUTION');
    if (!captured) throw new Error('REQUEST_NOT_CAPTURED');
    const request = captured;
    return {
      ...setup,
      request: (client = clients.get('apiRole')!) => client.query(request.sql, request.params),
    };
  }

  async function waitForDatabaseLock(pid: number) {
    let waiting = false;
    for (let i = 0; i < 60 && !waiting; i++) {
      waiting = (
        await fixture.pool.query(
          'SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted) AS waiting',
          [pid]
        )
      ).rows[0].waiting;
      if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(waiting).toBe(true);
  }

  it('worker change order terminal fences a concurrent new request after cancellation commits', async () => {
    const setup = await preparedAdjustmentRequestFixture();
    const lease = await recoveryObservationLease(setup);
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const worker = clients.get('workerRole')!;
    const api = clients.get('apiRole')!;
    const apiPid = (await api.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<{ error?: unknown; value?: pg.QueryResult }> | undefined;
    try {
      await worker.query('BEGIN');
      await recordChangeOrderTerminal(
        'no_effect',
        lease,
        [null, 'CUSTOMER_ACTOR_AUTHORITY_REVOKED'],
        worker
      );
      pending = setup.request(api).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      await waitForDatabaseLock(apiPid);
      await worker.query('COMMIT');
      expect((await pending).error).toMatchObject({
        message: expect.stringContaining('HXUV1-CHANGE-RECOVERY-18:'),
      });
      expect(
        (
          await fixture.pool.query(
            `SELECT
          (SELECT count(*)::int FROM public.financial_provider_command_journal WHERE operation_id=$1) AS requests,
          (SELECT count(*)::int FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE operation_id=$1) AS outbox,
          (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS effects`,
            [setup.changePhase.context.adjustmentOperationId]
          )
        ).rows[0]
      ).toEqual({ requests: 0, outbox: 0, effects: 0 });
    } finally {
      await worker.query('ROLLBACK');
      if (pending) await pending;
    }
  }, 60_000);

  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)(
    'worker change order terminal prevents a new ADJUST from a stale %s snapshot',
    async (isolation) => {
      const setup = await preparedAdjustmentRequestFixture();
      const lease = await recoveryObservationLease(setup);
      const api = clients.get('apiRole')!;
      try {
        await api.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await api.query('SELECT transaction_timestamp()');
        await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
          setup.lane.posterUserId,
        ]);
        await recordChangeOrderTerminal('no_effect', lease, [
          null,
          'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
        ]);
        await expect(setup.request(api)).rejects.toThrow(/READ_COMMITTED_REQUIRED|serialize/u);
      } finally {
        await api.query('ROLLBACK');
      }
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS n FROM public.financial_provider_command_journal WHERE operation_id=$1',
            [setup.changePhase.context.adjustmentOperationId]
          )
        ).rows[0].n
      ).toBe(0);
    },
    60_000
  );

  it.each(['terminal_first', 'admission_first'] as const)(
    'worker change order terminal serializes first admission: %s',
    async (order) => {
      const setup = await preparedAdjustmentRequestFixture();
      const requested = (await setup.request()).rows[0];
      const worker = clients.get('workerRole')!;
      const claim = (
        await worker.query('SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)', [
          randomUUID(),
        ])
      ).rows[0];
      expect(claim.command_id).toBe(requested.command_id);
      await worker.query(
        "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
        [claim.publish_claim_id, claim.bullmq_job_id, claim.job_authority_sha256]
      );
      const workerUrl = new URL(fixture.databaseUrl);
      workerUrl.username = roles.workerRole;
      workerUrl.password = password;
      const consumer = new pg.Client({ connectionString: workerUrl.toString() });
      await consumer.connect();
      const consumerPid = (await consumer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const admission = () =>
        consumer.query(
          'SELECT * FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13($1,$2,$3,$4,0,30,2)',
          [claim.outbox_request_id, claim.bullmq_job_id, claim.job_authority_sha256, randomUUID()]
        );
      const lease = await recoveryObservationLease(setup);
      await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
        setup.lane.posterUserId,
      ]);
      let pending: Promise<{ error?: unknown; value?: pg.QueryResult }> | undefined;
      try {
        if (order === 'terminal_first') {
          await worker.query('BEGIN');
          await recordChangeOrderTerminal(
            'no_effect',
            lease,
            [null, 'CUSTOMER_ACTOR_AUTHORITY_REVOKED'],
            worker
          );
          pending = admission().then(
            (value) => ({ value }),
            (error) => ({ error })
          );
          await waitForDatabaseLock(consumerPid);
          await worker.query('COMMIT');
          expect((await pending).error).toMatchObject({
            message: expect.stringContaining('HXUV1-CHANGE-RECOVERY-18:'),
          });
          const replay = (await setup.request()).rows[0];
          expect(replay.command_id).toBe(requested.command_id);
          expect(replay.idempotency_replayed).toBe(true);
        } else {
          await admission();
          await expect(
            recordChangeOrderTerminal('no_effect', lease, [
              null,
              'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
            ])
          ).rejects.toThrow('NO_DISPATCH_REVOCATION_REQUIRED');
        }
        expect(
          (
            await fixture.pool.query(
              `SELECT
            (SELECT count(*)::int FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$1) AS terminals,
            (SELECT count(*)::int FROM hx_authority.fake_financial_dispatch_admissions_v13 WHERE command_id=$2) AS admissions,
            (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$3) AS effects`,
              [
                lease.proposal_id,
                requested.command_id,
                setup.changePhase.context.adjustmentOperationId,
              ]
            )
          ).rows[0]
        ).toEqual({
          terminals: order === 'terminal_first' ? 1 : 0,
          admissions: order === 'terminal_first' ? 0 : 1,
          effects: 0,
        });
      } finally {
        await worker.query('ROLLBACK');
        if (pending) await pending;
        await consumer.end();
      }
    },
    60_000
  );

  it.each(['confirmed_decline', 'unknown'] as const)(
    'worker change order terminal requires an admitted nonretryable no-effect outcome: %s',
    async (kind) => {
      const setup = await adjustmentWitnessFixture();
      const requested = await setup.requestAdjustment(
        kind === 'confirmed_decline' ? 'DECLINE' : 'SUCCESS'
      );
      const binding = await setup.admit(requested.commandId);
      if (kind === 'confirmed_decline') await setup.executeBinding(binding);
      const worker = clients.get('workerRole')!;
      const outcome = (
        await worker.query(
          'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
          [
            binding.admission.job_validation_id,
            binding.workerId,
            binding.admission.recovery_lease_id,
          ]
        )
      ).rows[0];
      const lease = await recoveryObservationLease(setup);
      if (kind === 'unknown') {
        expect(outcome.outcome_fact.effect_certainty).toBe('UNKNOWN');
        await expect(
          recordChangeOrderTerminal('no_effect', lease, [
            outcome.outcome_fact.outcome_fact_id,
            null,
          ])
        ).rejects.toThrow('ADMITTED_NO_EFFECT_REQUIRED');
        expect(
          (
            await fixture.pool.query(
              'SELECT count(*)::int AS n FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$1',
              [lease.proposal_id]
            )
          ).rows[0].n
        ).toBe(0);
      } else {
        expect(outcome.outcome_fact).toMatchObject({
          effect_certainty: 'CONFIRMED_NO_EFFECT',
          retryable: false,
        });
        const result = (
          await recordChangeOrderTerminal('no_effect', lease, [
            outcome.outcome_fact.outcome_fact_id,
            null,
          ])
        ).rows[0];
        expect(result.terminal_fact).toMatchObject({
          outcome_state: 'CANCELLED',
          resolution_evidence_kind: 'NO_EFFECT',
          no_effect_outcome_fact_id: outcome.outcome_fact.outcome_fact_id,
          authority_revocation_reason: null,
          adjustment_event_id: null,
          execution_resume_authorized: false,
          capture_resume_authorized: false,
        });
        expect(
          (
            await recordChangeOrderTerminal('no_effect', lease, [
              outcome.outcome_fact.outcome_fact_id,
              null,
            ])
          ).rows[0].terminal_fact
        ).toEqual(result.terminal_fact);
      }
    },
    60_000
  );

  it('worker change order terminal rejects wrong bindings and busy domain and financial locks', async () => {
    const setup = await adjustmentWitnessFixture();
    const lease = await recoveryObservationLease(setup);
    const args = [
      lease.target_authority_id,
      new URL(fixture.databaseUrl).pathname.slice(1),
      'local',
      lease.release_manifest_digest,
      lease.proposal_id,
      lease.recovery_lease_id,
      lease.lease_owner_id,
      lease.witness_request_sha256,
      lease.work_order_id,
      null,
      'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
    ];
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    for (const [index, value] of [
      [0, randomUUID()],
      [1, 'wrong_db'],
      [2, 'staging'],
      [3, 'sha256:' + 'e'.repeat(64)],
      [4, randomUUID()],
      [5, randomUUID()],
      [6, randomUUID()],
      [7, 'f'.repeat(64)],
      [8, randomUUID()],
      [10, 'FINANCIAL_CHAIN_CHANGED'],
    ] as const) {
      const altered = [...args];
      altered[index] = value;
      await expect(
        recordChangeOrderTerminal(
          'no_effect',
          lease,
          [null, args[10]],
          clients.get('workerRole')!,
          altered
        )
      ).rejects.toThrow();
    }
    const holder = await fixture.pool.connect();
    try {
      for (const [family, key] of [
        ['domain', 'universal-v1-change-order-proposal:' + lease.proposal_id],
        ['domain', 'fulfillment:' + lease.work_order_id],
        [
          'financial-provider-command-journal-v1',
          'idempotency:' + setup.changePhase.idempotencyKey + ':adjust',
        ],
        [
          'financial-provider-command-journal-v1',
          'operation-version:FAKE:ADJUST:' + setup.changePhase.context.adjustmentOperationId + ':0',
        ],
        ['fake-financial-operation', setup.changePhase.context.adjustmentOperationId],
      ]) {
        await holder.query('BEGIN');
        await holder.query(
          family === 'domain'
            ? 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))'
            : 'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
          family === 'domain' ? [key] : [family, key]
        );
        await expect(
          recordChangeOrderTerminal('no_effect', lease, [null, 'CUSTOMER_ACTOR_AUTHORITY_REVOKED'])
        ).rejects.toThrow('LOCK_BUSY');
        await holder.query('ROLLBACK');
      }
      await holder.query('BEGIN');
      await holder.query('UPDATE public.users SET is_banned=is_banned WHERE id=$1', [
        setup.lane.posterUserId,
      ]);
      await expect(
        recordChangeOrderTerminal('no_effect', lease, [null, 'CUSTOMER_ACTOR_AUTHORITY_REVOKED'])
      ).rejects.toThrow('LOCK_BUSY');
      await holder.query('ROLLBACK');
      expect(
        (
          await recordChangeOrderTerminal('no_effect', lease, [
            null,
            'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
          ])
        ).rows[0].idempotency_replayed
      ).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);

  it.each(['target', 'persistence'] as const)(
    'worker change order terminal rolls back when the lease expires during a %s wait',
    async (lock) => {
      const setup = await adjustmentWitnessFixture();
      const lease = await recoveryObservationLease(setup, 5);
      await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
        setup.lane.posterUserId,
      ]);
      const worker = clients.get('workerRole')!;
      const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const holder = await fixture.pool.connect();
      let pending: Promise<{ error?: unknown; value?: pg.QueryResult }> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query(
          lock === 'target'
            ? "SELECT pg_advisory_xact_lock(hashtextextended('hxuv1-work-order-target-authority-v1',0))"
            : 'LOCK TABLE public.universal_v1_change_order_recovery_terminal_facts IN SHARE MODE'
        );
        pending = recordChangeOrderTerminal('no_effect', lease, [
          null,
          'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
        ]).then(
          (value) => ({ value }),
          (error) => ({ error })
        );
        await waitForDatabaseLock(pid);
        await holder.query(
          'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.05))',
          [lease.expires_at]
        );
        await holder.query('COMMIT');
        expect((await pending).error).toMatchObject({
          message: expect.stringMatching(
            /LEASE_EXPIRED|exact immutable Phase-A witness and lease/u
          ),
        });
        expect(
          (
            await fixture.pool.query(
              'SELECT count(*)::int AS n FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$1',
              [lease.proposal_id]
            )
          ).rows[0].n
        ).toBe(0);
      } finally {
        await holder.query('ROLLBACK');
        if (pending) await pending;
        holder.release();
      }
    },
    60_000
  );

  it.each(['materialized', 'compensated', 'no_effect'] as const)(
    'worker change order terminal records %s once and replays after lease expiry',
    async (kind) => {
      let lease: pg.QueryResultRow;
      let evidence: [string | null, string | null];
      let actorId: string;
      let adjustmentEventId: string | null = null;
      if (kind === 'materialized') {
        const f = await compensationWinnerFixture(5);
        const completed = await f.setup.changeOrders.finalizePriceAndScopeMaterialization(
          f.setup.changePhase,
          f.event.id,
          f.setup.lane.posterUserId
        );
        lease = f.lease;
        evidence = [completed.amendment_id, f.event.id];
        adjustmentEventId = f.event.id;
        actorId = f.setup.lane.posterUserId;
      } else if (kind === 'compensated') {
        const f = await workerReversalFixture(5);
        const prepared = await f.prepare();
        const requested = await f.requested(prepared.prepared_command);
        const binding = await f.setup.admit(requested.commandId);
        await f.setup.executeBinding(binding);
        const worker = clients.get('workerRole')!;
        const outcome = (
          await worker.query(
            'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
            [
              binding.admission.job_validation_id,
              binding.workerId,
              binding.admission.recovery_lease_id,
            ]
          )
        ).rows[0];
        const event = (
          await worker.query(
            'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)',
            [binding.admission.job_validation_id, outcome.outcome_fact.outcome_fact_id]
          )
        ).rows[0].financial_event;
        lease = f.lease;
        evidence = [f.winner.compensation_command_id, event.id];
        adjustmentEventId = f.event.id;
        actorId = f.setup.lane.posterUserId;
      } else {
        const setup = await adjustmentWitnessFixture();
        actorId = setup.lane.posterUserId;
        await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [actorId]);
        await fixture.pool.query(
          'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
          [setup.changePhase.context.proposalId]
        );
        lease = (
          await claimChangeOrderRecovery(clients.get('workerRole')!, undefined, [], 5)
        ).rows.find((row) => row.proposal_id === setup.changePhase.context.proposalId)!;
        expect(lease).toBeDefined();
        evidence = [null, 'CUSTOMER_ACTOR_AUTHORITY_REVOKED'];
      }
      // Immutable historical attribution remains valid after participant revocation.
      await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [actorId]);
      for (const role of ['apiRole', 'attesterRole'] as const) {
        await expect(
          recordChangeOrderTerminal(kind, lease, evidence, clients.get(role)!)
        ).rejects.toThrow(/permission denied/u);
      }
      const typedLease = {
        proposal_id: lease.proposal_id,
        recovery_lease_id: lease.recovery_lease_id,
        lease_owner_id: lease.lease_owner_id,
        witness_request_sha256: lease.witness_request_sha256,
        work_order_id: lease.work_order_id,
        acquired_at: lease.acquired_at.toISOString(),
        expires_at: lease.expires_at.toISOString(),
        target_authority_id: lease.target_authority_id,
        release_manifest_digest: lease.release_manifest_digest,
      };
      const input: ChangeOrderTerminalCommand =
        kind === 'materialized'
          ? {
              kind: 'MATERIALIZED',
              lease: typedLease,
              actorUserId: actorId,
              amendmentId: evidence[0]!,
              adjustmentEventId: adjustmentEventId!,
            }
          : kind === 'compensated'
            ? {
                kind: 'COMPENSATED',
                lease: typedLease,
                actorUserId: actorId,
                compensationCommandId: evidence[0]!,
                compensationEventId: evidence[1]!,
                adjustmentEventId: adjustmentEventId!,
              }
            : {
                kind: 'NO_EFFECT',
                lease: typedLease,
                actorUserId: actorId,
                adjustmentEventId: null,
                noEffectOutcomeFactId: null,
                authorityRevocationReason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
              };
      const authorize = () => ({
        databaseName: new URL(fixture.databaseUrl).pathname.slice(1),
        serviceLogin: roles.workerRole,
        environment: 'local' as const,
        manifestDigest: lease.release_manifest_digest,
        targetDigest: 'sha256:' + 'd'.repeat(64),
      });
      const database = preparationDatabase(clients.get('workerRole')!);
      const lost = new PostgresUniversalV1ChangeOrderRecoveryTerminals(
        {
          transaction: async (work) => {
            await database.transaction(work);
            throw new Error('TERMINAL_COMMIT_ACKNOWLEDGEMENT_LOST');
          },
        },
        authorize
      );
      // Inject loss only after the actual outer COMMIT on the restricted login.
      await expect(lost.record(input)).rejects.toThrow('TERMINAL_COMMIT_ACKNOWLEDGEMENT_LOST');
      const result = await recordChangeOrderTerminal(kind, lease, evidence);
      expect(result.rows).toHaveLength(1);
      const original = result.rows[0];
      expect(original).toMatchObject({
        idempotency_replayed: true,
        target_authority_id: lease.target_authority_id,
        release_manifest_digest: lease.release_manifest_digest,
        terminal_fact: {
          proposal_id: lease.proposal_id,
          witness_request_sha256: lease.witness_request_sha256,
          recovery_lease_id: lease.recovery_lease_id,
          lease_owner_id: lease.lease_owner_id,
          recorded_by: actorId,
          outcome_state: kind === 'materialized' ? 'MATERIALIZED' : 'CANCELLED',
          recovery_state: kind === 'materialized' ? 'NOT_REQUIRED' : 'RECOVERY_REQUIRED',
          resolution_evidence_kind:
            kind === 'materialized'
              ? 'AMENDMENT'
              : kind === 'compensated'
                ? 'REVERSAL'
                : 'NO_EFFECT',
          execution_resume_authorized: kind === 'materialized',
          prior_secured_state_restored: false,
          capture_resume_authorized: false,
          payment_creation_performed: false,
          hard_assignment_created: false,
        },
      });
      await fixture.pool.query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.05))',
        [lease.expires_at]
      );
      // Restoring a user cannot change an already committed no-effect decision.
      await fixture.pool.query('UPDATE public.users SET is_banned=FALSE WHERE id=$1', [actorId]);
      const replay = await new PostgresUniversalV1ChangeOrderRecoveryTerminals(
        database,
        authorize
      ).record(input);
      expect(replay.terminalFact).toEqual(original.terminal_fact);
      expect(replay.idempotencyReplayed).toBe(true);
      await expect(
        recordChangeOrderTerminal(kind, lease, [randomUUID(), evidence[1]])
      ).rejects.toThrow(/CONFLICT|INPUT_INVALID/u);
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS n FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$1',
            [lease.proposal_id]
          )
        ).rows[0].n
      ).toBe(1);
      expect((await observeChangeOrderRecovery(lease)).rows).toHaveLength(0);
    },
    60_000
  );

  it('worker change order compensation preserves an amendment winner and suppresses terminal lease observation', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    const completed = await setup.changeOrders.finalizePriceAndScopeMaterialization(
      setup.changePhase,
      event.id,
      setup.lane.posterUserId
    );
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    expect((await claimCompensationWinner(lease, event.id)).rows[0].resolution).toEqual({
      kind: 'AMENDMENT_MATERIALIZED',
      amendmentId: completed.amendment_id,
      adjustmentEventId: event.id,
    });
    // Historical setup intentionally exercises the retained owner-only terminal writer.
    await fixture.pool.query(
      'SELECT * FROM public.record_universal_v1_change_order_materialized_recovery_v1($1,$2,$3,$4,$5)',
      [
        lease.proposal_id,
        lease.recovery_lease_id,
        lease.lease_owner_id,
        completed.amendment_id,
        event.id,
      ]
    );
    expect((await observeChangeOrderRecovery(lease)).rows).toHaveLength(0);
    expect((await claimCompensationWinner(lease, event.id)).rows).toHaveLength(0);
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1',
          [lease.proposal_id]
        )
      ).rows[0].count
    ).toBe(0);
  }, 60_000);

  it('worker change order compensation preserves legacy winner without inventing worker origin', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    const legacy = (
      await fixture.pool.query(
        'SELECT * FROM public.claim_universal_v1_change_order_compensation_v1($1,$2,$3,$4)',
        [lease.proposal_id, lease.recovery_lease_id, lease.lease_owner_id, event.id]
      )
    ).rows[0];
    await fixture.pool.query("UPDATE public.users SET account_status='ACTIVE' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    const result = (await claimCompensationWinner(lease, event.id)).rows[0].resolution;
    expect(result).toMatchObject({
      kind: 'COMPENSATE',
      created: false,
      workerOrigin: null,
      command: {
        compensation_command_id: legacy.compensation_command_id,
        recovery_lease_id: lease.recovery_lease_id,
      },
    });
  }, 60_000);

  it('worker change order compensation refuses downstream financial lock inversion', async () => {
    const { setup, event, lease } = await compensationWinnerFixture();
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const holder = await fixture.pool.connect();
    try {
      for (const [family, key] of [
        ['financial-provider-command-recovery-v1', setup.requested.commandId],
        ['fake-financial-operation', setup.changePhase.context.adjustmentOperationId],
      ]) {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
          family,
          key,
        ]);
        await expect(claimCompensationWinner(lease, event.id)).rejects.toThrow('LOCK_BUSY');
        await holder.query('ROLLBACK');
      }
      expect((await claimCompensationWinner(lease, event.id)).rows[0].resolution.created).toBe(
        true
      );
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);

  it('worker change order compensation rolls back both facts when lease expires during persistence', async () => {
    const { setup, event, lease } = await compensationWinnerFixture(5),
      worker = clients.get('workerRole')!;
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    const holder = await fixture.pool.connect();
    const pid = (await worker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let pending: Promise<{ value?: pg.QueryResult; error?: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        'LOCK TABLE hx_authority.fake_financial_change_order_compensation_origins_v13 IN SHARE MODE'
      );
      pending = claimCompensationWinner(lease, event.id).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      let waiting = false;
      for (let i = 0; i < 40 && !waiting; i++) {
        waiting = (
          await holder.query(
            "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation='hx_authority.fake_financial_change_order_compensation_origins_v13'::regclass AND NOT granted) AS waiting",
            [pid]
          )
        ).rows[0].waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await holder.query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))+0.1))',
        [lease.expires_at]
      );
      await holder.query('COMMIT');
      expect((await pending).error).toMatchObject({
        message: expect.stringContaining('LEASE_EXPIRED'),
      });
      expect((await observeChangeOrderRecovery(lease)).rows).toHaveLength(0);
      expect((await claimCompensationWinner(lease, event.id)).rows).toHaveLength(0);
      const counts = (
        await holder.query(
          `SELECT
        (SELECT count(*)::int FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1) AS winners,
        (SELECT count(*)::int FROM hx_authority.fake_financial_change_order_compensation_origins_v13 WHERE proposal_id=$1) AS origins`,
          [lease.proposal_id]
        )
      ).rows[0];
      expect(counts).toEqual({ winners: 0, origins: 0 });
    } finally {
      await holder.query('ROLLBACK');
      if (pending) await pending;
      holder.release();
    }
  }, 60_000);

  it('worker change order compensation records revoked delegate identity through the typed port', async () => {
    const setup = await changeOrderDelegateFixture('public'),
      { f } = setup,
      worker = clients.get('workerRole')!;
    const journal = (
      await fixture.pool.query(
        'SELECT command_id FROM public.financial_provider_command_journal WHERE operation_id=$1',
        [setup.phase.context.adjustmentOperationId]
      )
    ).rows[0];
    const binding = await f.admit(journal.command_id);
    await f.execute(binding);
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        binding.admission.job_validation_id,
        binding.workerId,
        binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    await setup.setMembership('REVOKED');
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.phase.context.proposalId]
    );
    const lease = (await claimChangeOrderRecovery(worker)).rows.find(
      (row) => row.proposal_id === setup.phase.context.proposalId
    )!;
    expect(lease).toBeDefined();
    const { PostgresUniversalV1ChangeOrderRecoveryCompensation } =
      await import('../../src/services/UniversalV1ChangeOrderRecoveryCompensation.js');
    const port = new PostgresUniversalV1ChangeOrderRecoveryCompensation(
      preparationDatabase(worker),
      () => ({
        databaseName: new URL(fixture.databaseUrl).pathname.slice(1),
        serviceLogin: roles.workerRole,
        environment: 'local',
        manifestDigest: lease.release_manifest_digest,
        targetDigest: 'sha256:' + 'd'.repeat(64),
      })
    );
    const result = await port.claim(
      {
        ...lease,
        acquired_at: lease.acquired_at.toISOString(),
        expires_at: lease.expires_at.toISOString(),
      },
      event.id
    );
    expect(result).toMatchObject({
      created: true,
      resolution: {
        kind: 'COMPENSATE',
        command: {
          requestedBy: setup.delegate,
          adjustmentEventId: event.id,
          semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
        },
      },
      workerOrigin: {
        service_database_role: roles.workerRole,
        revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.resolution)).toBe(true);
    expect(Object.isFrozen(result!.workerOrigin)).toBe(true);
    expect(await setup.effects()).toMatchObject({ operations: 1, events: 1 });
  }, 60_000);

  it('worker change order recovery observes exact adjustment and amendment progression', async () => {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    // Complete provider execution within the original admission window. Recovery
    // observation starts later and must wait for the separate durable outcome.
    await setup.execute();
    const lease = await recoveryObservationLease(setup);
    const state = async () =>
      (await observeChangeOrderRecovery(lease)).rows[0].observation.recovery_state;
    expect(await state()).toBe('ADJUST_RECONCILE_ONLY');
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        setup.binding.admission.job_validation_id,
        setup.binding.workerId,
        setup.binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    expect(await state()).toBe('ADJUST_REPLAYABLE');
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        setup.binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    expect(await state()).toBe('ADJUSTMENT_SUCCEEDED');
    const completed = await setup.changeOrders.finalizePriceAndScopeMaterialization(
      setup.changePhase,
      event.id,
      setup.lane.posterUserId
    );
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    const observation = (await observeChangeOrderRecovery(lease)).rows[0].observation;
    expect(observation).toMatchObject({
      recovery_state: 'AMENDMENT_MATERIALIZED',
      amendment_id: completed.amendment_id,
      adjustment_event_id: event.id,
      compensation_command_id: null,
    });
    expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
  }, 60_000);

  it('worker change order recovery observes only its exact active lease and current release', async () => {
    const setup = await changeOrderHistoryFixture(),
      lease = await recoveryObservationLease(setup);
    for (const role of ['apiRole', 'attesterRole'] as const)
      await expect(observeChangeOrderRecovery(lease, clients.get(role)!)).rejects.toThrow(
        /permission denied/u
      );
    const args = [
      lease.target_authority_id,
      new URL(fixture.databaseUrl).pathname.slice(1),
      'local',
      lease.release_manifest_digest,
      lease.proposal_id,
      lease.recovery_lease_id,
      lease.lease_owner_id,
      lease.witness_request_sha256,
      lease.work_order_id,
    ];
    for (const [index, value] of [
      [0, randomUUID()],
      [1, 'wrong_database'],
      [2, 'staging'],
      [3, 'sha256:' + 'e'.repeat(64)],
      [4, randomUUID()],
      [5, randomUUID()],
      [6, randomUUID()],
      [7, 'f'.repeat(64)],
      [8, randomUUID()],
      [7, null],
    ] as const) {
      const altered = [...args];
      altered[index] = value;
      await expect(
        observeChangeOrderRecovery(lease, clients.get('workerRole')!, altered)
      ).rejects.toThrow();
    }
    const holder = await fixture.pool.connect();
    try {
      for (const lock of [
        'universal-v1-change-order-proposal:' + lease.proposal_id,
        'fulfillment:' + lease.work_order_id,
      ]) {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lock]);
        await expect(observeChangeOrderRecovery(lease)).rejects.toThrow('OBSERVATION_LOCK_BUSY');
        await holder.query('ROLLBACK');
      }
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect((await observeChangeOrderRecovery(lease)).rows).toHaveLength(1);
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
  }, 60_000);

  it('worker change order recovery observes revoked customer through a scoped lease port', async () => {
    const setup = await changeOrderHistoryFixture();
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.changePhase.context.proposalId]
    );
    const worker = clients.get('workerRole')!;
    const leases = await claimChangeOrderRecovery(worker);
    const lease = leases.rows.find((row) => row.proposal_id === setup.payload.proposal_id)!;
    expect(lease).toBeDefined();
    const result = await worker.query(
      'SELECT * FROM public.hxos_observe_fake_financial_change_order_recovery_v13($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        lease.target_authority_id,
        new URL(fixture.databaseUrl).pathname.slice(1),
        'local',
        lease.release_manifest_digest,
        lease.proposal_id,
        lease.recovery_lease_id,
        lease.lease_owner_id,
        lease.witness_request_sha256,
        lease.work_order_id,
      ]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].observation).toMatchObject({
      proposal_id: lease.proposal_id,
      recovery_lease_id: lease.recovery_lease_id,
      lease_owner_id: lease.lease_owner_id,
      request_sha256: lease.witness_request_sha256,
      recovery_state: 'ADJUST_RECONCILE_ONLY',
      authority_revocation_reason: 'CUSTOMER_ACTOR_AUTHORITY_REVOKED',
      adjustment_event_id: null,
      compensation_command_id: null,
    });
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
    const { PostgresUniversalV1ChangeOrderRecoveryObservation } =
      await import('../../src/services/UniversalV1ChangeOrderRecoveryObservation.js');
    const reader = new PostgresUniversalV1ChangeOrderRecoveryObservation(
      preparationDatabase(worker),
      () => ({
        databaseName: new URL(fixture.databaseUrl).pathname.slice(1),
        serviceLogin: roles.workerRole,
        environment: 'local',
        manifestDigest: lease.release_manifest_digest,
        targetDigest: 'sha256:' + 'd'.repeat(64),
      })
    );
    const typed = await reader.observe({
      ...lease,
      acquired_at: lease.acquired_at.toISOString(),
      expires_at: lease.expires_at.toISOString(),
    });
    expect(typed).toMatchObject({
      observation: 'ADJUST_RECONCILE_ONLY',
      authorityRevocationReason: null,
      witnessRequestSha256: lease.witness_request_sha256,
      recoveryLeaseId: lease.recovery_lease_id,
    });
    expect(Object.isFrozen(typed)).toBe(true);
  }, 60_000);

  it('worker change order recovery claims an immutable witness after customer revocation without an actor assertion', async () => {
    const setup = await changeOrderHistoryFixture();
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      setup.lane.posterUserId,
    ]);
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.changePhase.context.proposalId]
    );
    const leaseOwnerId = randomUUID();
    const result = await claimChangeOrderRecovery(clients.get('workerRole')!, leaseOwnerId);
    expect(result.rows.find((row) => row.proposal_id === setup.payload.proposal_id)).toMatchObject({
      lease_owner_id: leaseOwnerId,
      witness_request_sha256: setup.changePhase.requestSha256,
      work_order_id: setup.workOrder.work_order_id,
    });
    const leases = await fixture.pool.query(
      'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE proposal_id=$1',
      [setup.payload.proposal_id]
    );
    expect(leases.rows).toHaveLength(1);
    expect(
      new Date(leases.rows[0].expires_at).getTime() - new Date(leases.rows[0].acquired_at).getTime()
    ).toBe(300_000);
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
  }, 60_000);

  it.each(['proposal', 'witness'] as const)(
    'worker change order recovery skips a busy %s and claims unrelated work',
    async (kind) => {
      const first = await changeOrderHistoryFixture(),
        second = await changeOrderHistoryFixture();
      await fixture.pool.query(
        'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
        [second.payload.proposal_id]
      );
      const holder = await fixture.pool.connect();
      try {
        await holder.query('BEGIN');
        if (kind === 'proposal')
          await holder.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('universal-v1-change-order-proposal:'||$1::text,0))",
            [first.payload.proposal_id]
          );
        else
          await holder.query(
            'SELECT proposal_id FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1 FOR UPDATE',
            [first.payload.proposal_id]
          );
        const owner = randomUUID();
        const worker = clients.get('workerRole')!;
        if (kind === 'witness') await worker.query('BEGIN');
        const result = await claimChangeOrderRecovery(worker, owner);
        expect(result.rows.some((row) => row.proposal_id === first.payload.proposal_id)).toBe(
          false
        );
        expect(result.rows.some((row) => row.proposal_id === second.payload.proposal_id)).toBe(
          true
        );
        if (kind === 'witness') {
          // Skipped candidates must release their proposal locks, while the
          // successfully claimed witness remains locked until worker COMMIT.
          for (const [proposal, expected] of [
            [first.payload.proposal_id, true],
            [second.payload.proposal_id, false],
          ] as const)
            expect(
              (
                await holder.query(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended('universal-v1-change-order-proposal:'||$1::text,0)) AS acquired",
                  [proposal]
                )
              ).rows[0].acquired
            ).toBe(expected);
          await worker.query('COMMIT');
        }
        await holder.query('ROLLBACK');
        const next = await claimChangeOrderRecovery(clients.get('workerRole')!, owner);
        expect(next.rows.some((row) => row.proposal_id === first.payload.proposal_id)).toBe(true);
        expect(next.rows.some((row) => row.proposal_id === second.payload.proposal_id)).toBe(false);
      } finally {
        await holder.query('ROLLBACK');
        await clients.get('workerRole')!.query('ROLLBACK');
        holder.release();
      }
    },
    60_000
  );

  it('worker change order recovery enforces roles, bounds, current target and rollback', async () => {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.payload.proposal_id]
    );
    for (const role of ['apiRole', 'attesterRole'] as const)
      await expect(claimChangeOrderRecovery(clients.get(role)!)).rejects.toMatchObject({
        code: '42501',
      });
    await expect(
      worker.query('SELECT * FROM public.universal_v1_change_order_recovery_leases')
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      worker.query('SELECT * FROM public.claim_universal_v1_change_order_recovery_v1($1,1,300,5)', [
        randomUUID(),
      ])
    ).rejects.toMatchObject({ code: '42501' });
    const target = (
      await fixture.pool.query(
        'SELECT * FROM hx_authority.universal_v1_work_order_target_authority_facts'
      )
    ).rows[0];
    const args = [
      target.target_authority_id,
      target.target_database_name,
      target.environment,
      target.release_manifest_sha256,
      randomUUID(),
      100,
      300,
      5,
    ];
    for (const [index, value] of [
      [0, randomUUID()],
      [1, 'wrong_database'],
      [2, 'production'],
      [3, 'sha256:' + '0'.repeat(64)],
      [4, null],
      [5, 0],
      [5, 101],
      [5, null],
      [6, 4],
      [6, 901],
      [7, 4],
      [7, 3601],
    ] as const) {
      const invalid = [...args];
      invalid[index] = value;
      await expect(claimChangeOrderRecovery(worker, randomUUID(), invalid)).rejects.toThrow();
    }
    await worker.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await expect(claimChangeOrderRecovery(worker)).rejects.toThrow('CLAIM_INPUT_INVALID');
    } finally {
      await worker.query('ROLLBACK');
    }
    await worker.query('BEGIN');
    try {
      expect(
        (await claimChangeOrderRecovery(worker)).rows.some(
          (row) => row.proposal_id === setup.payload.proposal_id
        )
      ).toBe(true);
    } finally {
      await worker.query('ROLLBACK');
    }
    expect(
      (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE proposal_id=$1',
          [setup.payload.proposal_id]
        )
      ).rows
    ).toHaveLength(0);
    const { PostgresUniversalV1ChangeOrderRecoveryClaims } =
      await import('../../src/services/UniversalV1ChangeOrderRecoveryClaims.js');
    const authority = {
      databaseName: target.target_database_name,
      serviceLogin: roles.workerRole,
      environment: 'local' as const,
      manifestDigest: target.release_manifest_sha256,
      targetDigest: 'sha256:' + 'a'.repeat(64),
    };
    const repository = new PostgresUniversalV1ChangeOrderRecoveryClaims(
      preparationDatabase(worker),
      () => authority
    );
    const claims = await repository.claimDue({
      leaseOwnerId: randomUUID(),
      limit: 100,
      leaseDurationSeconds: 300,
      minimumAgeSeconds: 5,
    });
    expect(claims.some((row) => row.proposal_id === setup.payload.proposal_id)).toBe(true);
    expect(Object.isFrozen(claims)).toBe(true);
    expect(
      (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE proposal_id=$1',
          [setup.payload.proposal_id]
        )
      ).rows
    ).toHaveLength(1);
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
  }, 60_000);

  it('worker change order recovery serializes competing workers and preserves immutable expired leases', async () => {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.payload.proposal_id]
    );
    const target = (
      await fixture.pool.query(
        'SELECT * FROM hx_authority.universal_v1_work_order_target_authority_facts'
      )
    ).rows[0];
    const owner = randomUUID(),
      args = [
        target.target_authority_id,
        target.target_database_name,
        target.environment,
        target.release_manifest_sha256,
        owner,
        100,
        5,
        5,
      ];
    const url = new URL(fixture.databaseUrl);
    url.username = roles.workerRole;
    url.password = password;
    const contender = new pg.Client({ connectionString: url.toString() });
    await contender.connect();
    let pending: Promise<pg.QueryResult> | undefined;
    try {
      await worker.query('BEGIN');
      const first = (await claimChangeOrderRecovery(worker, owner, args)).rows.find(
        (row) => row.proposal_id === setup.payload.proposal_id
      );
      expect(first).toBeDefined();
      const original = (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE proposal_id=$1',
          [setup.payload.proposal_id]
        )
      ).rows;
      expect(original).toHaveLength(0); // Separate connection cannot see the uncommitted lease.
      const pid = (await contender.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = claimChangeOrderRecovery(contender).then((value) => value);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        blocked = (
          await fixture.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await worker.query('COMMIT');
      expect(
        (await pending).rows.some((row) => row.proposal_id === setup.payload.proposal_id)
      ).toBe(false);
      pending = undefined;
      const prior = (
        await fixture.pool.query(
          'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE recovery_lease_id=$1',
          [first.recovery_lease_id]
        )
      ).rows[0];
      await fixture.pool.query(
        'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))+0.05)) FROM public.universal_v1_change_order_recovery_leases WHERE recovery_lease_id=$1',
        [first.recovery_lease_id]
      );
      const renewed = (await claimChangeOrderRecovery(contender)).rows.find(
        (row) => row.proposal_id === setup.payload.proposal_id
      );
      expect(renewed.recovery_lease_id).not.toBe(first.recovery_lease_id);
      expect(
        (
          await fixture.pool.query(
            'SELECT * FROM public.universal_v1_change_order_recovery_leases WHERE recovery_lease_id=$1',
            [first.recovery_lease_id]
          )
        ).rows[0]
      ).toEqual(prior);
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.universal_v1_change_order_recovery_leases WHERE proposal_id=$1 AND expires_at>clock_timestamp()',
            [setup.payload.proposal_id]
          )
        ).rows[0].count
      ).toBe(1);
    } finally {
      await worker.query('ROLLBACK');
      if (pending) await pending;
      await contender.end();
    }
  }, 60_000);

  async function changeOrderHistoryFixture() {
    const setup = await adjustmentExecutionFixture();
    const payload = {
      proposal_id: setup.changePhase.context.proposalId,
      expected_proposal_version: 1,
      expected_scope_version: setup.lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: 1,
      expected_financial_version: 2,
      idempotency_key: setup.changePhase.idempotencyKey,
    };
    const { PostgresUniversalV1ChangeOrderHistoryReader } =
      await import('../../src/services/UniversalV1ChangeOrderHistory.js');
    const reader = new PostgresUniversalV1ChangeOrderHistoryReader(
      preparationDatabase(clients.get('apiRole')!),
      () => ({
        manifestDigest: 'sha256:' + 'b'.repeat(64),
        releaseId: 'synthetic.adjust.execution',
        revision: 'd'.repeat(40),
        environment: 'local',
        authenticationStatus: 'VERIFIED',
      })
    );
    return {
      ...setup,
      payload,
      reader,
      read: async (actor = setup.lane.posterUserId) =>
        reader.read(payload, actor, await preparationAttestation(actor)),
    };
  }

  it('change order history exposes an exact authenticated builder for the committed Phase A', async () => {
    const { payload } = await changeOrderHistoryFixture();
    const result = await clients
      .get('apiRole')!
      .query('SELECT * FROM public.hxos_build_change_order_history_actor_request_v13($1,$2)', [
        'READ_FAKE_CHANGE_ORDER_HISTORY',
        payload,
      ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].canonical_request.command_payload).toEqual(payload);
  }, 60_000);

  it('change order history preserves the original witness and reads committed progress after provider revocation', async () => {
    const setup = await changeOrderHistoryFixture();
    const first = await setup.read();
    expect(first).toMatchObject({
      state: 'PREPARED',
      actorUserId: setup.lane.posterUserId,
      identity: setup.payload,
      phase: { requestSha256: setup.changePhase.requestSha256 },
      adjustmentProgress: {
        commandId: setup.requested.commandId,
        operationKind: 'ADJUST',
        progressState: 'PROCESSING',
      },
    });
    if (first?.state !== 'PREPARED') throw Error('EXPECTED_PREPARED_HISTORY');
    expect(Date.parse(first.phase.context.occurredAt)).toBe(
      Date.parse(setup.changePhase.context.occurredAt)
    );
    expect(Object.isFrozen(first.phase.context)).toBe(true);
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    const later = await setup.read();
    expect(later?.phase).toEqual(first.phase);
    expect(later?.state).toBe('PREPARED');
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
  }, 60_000);

  it('change order history conceals another actor and refuses an altered original version', async () => {
    const setup = await changeOrderHistoryFixture();
    expect(await setup.read(setup.lane.providerUserId)).toBeNull();
    expect(
      await setup.reader.read(
        { ...setup.payload, proposal_id: randomUUID() },
        setup.lane.posterUserId,
        await preparationAttestation(setup.lane.posterUserId)
      )
    ).toBeNull();
    await expect(
      setup.reader.read(
        { ...setup.payload, expected_scope_version: setup.payload.expected_scope_version + 1 },
        setup.lane.posterUserId,
        await preparationAttestation(setup.lane.posterUserId)
      )
    ).rejects.toThrow('CHANGE_ORDER_HISTORY_UNAVAILABLE');
    expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
  }, 60_000);

  it('change order history replays a completed amendment after later provider restriction', async () => {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    await setup.execute();
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        setup.binding.admission.job_validation_id,
        setup.binding.workerId,
        setup.binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        setup.binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    // Owner-backed finalization is setup for this historical read test. The
    // public sealed finalization surface is a separate pending integration.
    const completed = await setup.changeOrders.finalizePriceAndScopeMaterialization(
      setup.changePhase,
      event.id,
      setup.lane.posterUserId
    );
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    expect(await setup.read()).toMatchObject({
      state: 'COMPLETED',
      result: { ...completed, replayed: true },
    });
    expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
  }, 60_000);

  it('change order history holds customer read authority across a financial lock wait', async () => {
    const setup = await changeOrderHistoryFixture(),
      api = clients.get('apiRole')!;
    const apiPid = (await api.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const holder = await fixture.pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.query('BEGIN');
      await holder.query(
        "SELECT pg_advisory_xact_lock(hashtext('financial-provider-command-recovery-v1'),hashtext($1::text))",
        [setup.requested.commandId]
      );
      pending = setup.read().then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      let blocked = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        blocked = (
          await fixture.pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [
            apiPid,
          ])
        ).rows[0].blocked;
        if (blocked) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await holder.query('SAVEPOINT revocation');
      await expect(
        holder.query('SELECT id FROM public.users WHERE id=$1 FOR UPDATE NOWAIT', [
          setup.lane.posterUserId,
        ])
      ).rejects.toMatchObject({ code: '55P03' });
      await holder.query('ROLLBACK TO SAVEPOINT revocation');
      await holder.query('COMMIT');
      expect(await pending).toMatchObject({ value: { state: 'PREPARED' } });
      await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
        setup.lane.posterUserId,
      ]);
      await expect(setup.read()).rejects.toThrow('CHANGE_ORDER_HISTORY_UNAVAILABLE');
      expect(await setup.effects()).toEqual({ operations: 0, events: 0 });
    } finally {
      await holder.query('ROLLBACK');
      if (pending) await pending;
      holder.release();
    }
  }, 60_000);

  it('public change order resume retains an immutable compensation claim and requests only its reversal', async () => {
    const setup = await changeOrderHistoryFixture(),
      worker = clients.get('workerRole')!;
    await setup.execute();
    const outcome = (
      await worker.query('SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)', [
        setup.binding.admission.job_validation_id,
        setup.binding.workerId,
        setup.binding.admission.recovery_lease_id,
      ])
    ).rows[0];
    const event = (
      await worker.query('SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)', [
        setup.binding.admission.job_validation_id,
        outcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    await fixture.pool.query("UPDATE public.users SET account_status='SUSPENDED' WHERE id=$1", [
      setup.lane.providerUserId,
    ]);
    const { PostgresUniversalV1ChangeOrderRecoveryRepository } =
      await import('../../src/services/UniversalV1ChangeOrderRecovery.js');
    const recovery = new PostgresUniversalV1ChangeOrderRecoveryRepository(preparationDatabase());
    await fixture.pool.query(
      'SELECT pg_sleep(GREATEST(0,5.05-EXTRACT(EPOCH FROM (clock_timestamp()-prepared_at)))) FROM public.universal_v1_change_order_materialization_commands WHERE proposal_id=$1',
      [setup.changePhase.context.proposalId]
    );
    const claims = await recovery.claimDue({
      leaseOwnerId: randomUUID(),
      limit: 100,
      leaseDurationSeconds: 300,
      minimumAgeSeconds: 5,
    });
    const claim = claims.find((item) => item.proposalId === setup.changePhase.context.proposalId);
    if (!claim) throw Error('EXPECTED_CHANGE_ORDER_RECOVERY_CLAIM');
    const compensation = await recovery.claimCompensation(claim, event.id);
    if (compensation.kind !== 'COMPENSATE') throw Error('EXPECTED_COMPENSATION');
    expect(await setup.read()).toMatchObject({
      state: 'COMPENSATION_CLAIM',
      phase: { requestSha256: setup.changePhase.requestSha256 },
      compensation: {
        compensationCommandId: compensation.command.compensationCommandId,
        semanticLimitation: 'PRIOR_SECURED_STATE_NOT_RESTORED',
      },
      reversalRequestState: 'NOT_REQUESTED',
      reversalProgress: null,
    });
    expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
    // Claim creation above remains owner-seeded recovery evidence. From here the
    // public router, request admission, Redis delivery and restricted worker are real.
    if (process.env.REDIS_URL !== 'redis://127.0.0.1:16379')
      throw Error('EXACT_SYNTHETIC_REDIS_REQUIRED');
    const apiDatabase = preparationDatabase(clients.get('apiRole')!);
    const release = {
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      releaseId: 'synthetic.changeorder.reversal',
      revision: 'd'.repeat(40),
      environment: 'local' as const,
      authenticationStatus: 'VERIFIED' as const,
    };
    const finance = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(apiDatabase),
      new PostgresFinancialProviderCommandJournal(apiDatabase),
      () => release,
      new PostgresUniversalV1FinancialRequestProgressReader(apiDatabase),
      new PostgresUniversalV1FinancialPredecessorReader(apiDatabase)
    );
    const app = new UniversalV1ChangeOrderApplication(
      materializationFixturePort(apiDatabase, () => release),
      () => finance,
      Date.now,
      new PostgresUniversalV1ChangeOrderCommands(apiDatabase),
      setup.reader
    );
    const router = createUniversalContractRouter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      app
    );
    const user = (
      await fixture.pool.query('SELECT * FROM public.users WHERE id=$1', [setup.lane.posterUserId])
    ).rows[0] as NonNullable<Context['user']>;
    const resume = async () =>
      router
        .createCaller({
          user,
          firebaseUid: user.firebase_uid ?? null,
          ip: '127.0.0.1',
          actorAttestation: await preparationAttestation(user.id),
        })
        .authorizeAndMaterializeFakeChangeOrder({
          ...setup.payload,
          client_ts: new Date().toISOString(),
        });
    const requestSpy = vi.spyOn(finance, 'requestFinancialEvent');
    expect(await resume()).toMatchObject({ status: 'COMPENSATING', stage: 'COMPENSATION' });
    expect(await resume()).toMatchObject({ status: 'COMPENSATING', stage: 'COMPENSATION' });
    expect(requestSpy).toHaveBeenCalledOnce();
    expect(requestSpy.mock.calls[0]![0]).not.toHaveProperty('changeOrderId');
    const requested = await requestSpy.mock.results[0]!.value;
    const command = compensation.command;
    expect(requested.operationId).toBe(command.reversalOperationId);
    const originalClaim = (
      await fixture.pool.query(
        'SELECT * FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1',
        [setup.payload.proposal_id]
      )
    ).rows[0];
    const workerUrl = new URL(fixture.databaseUrl);
    workerUrl.username = roles.workerRole;
    workerUrl.password = password;
    const workerPool = new pg.Pool({ connectionString: workerUrl.toString(), max: 4 });
    const workerDatabase = preparationDatabase(workerPool);
    const prefix = 'hx-ci-changeorder-reversal-' + randomUUID(),
      connection = { host: '127.0.0.1', port: 16379, maxRetriesPerRequest: null };
    const queue = new Queue('synthetic_finance', { prefix, connection }),
      events = new QueueEvents('synthetic_finance', { prefix, connection });
    const processor = new SyntheticFinancialCommandProcessor();
    const consumer = new Worker('synthetic_finance', (job) => processor.process(job), {
      prefix,
      connection,
      autorun: false,
      concurrency: 1,
    });
    const runtimeErrors: unknown[] = [];
    const recordRuntimeError = (error: Error) => {
      runtimeErrors.push(error);
    };
    queue.on('error', recordRuntimeError);
    events.on('error', recordRuntimeError);
    consumer.on('error', recordRuntimeError);
    const spies = [
      vi
        .spyOn(runtimeDb, 'transaction')
        .mockImplementation((callback) => workerDatabase.transaction((query) => callback(query))),
      vi.spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized').mockReturnValue({
        releaseId: release.releaseId,
        environment: 'local',
        components: {
          backend: { revision: release.revision },
          worker: { revision: release.revision },
        },
      } as ReturnType<typeof financialAuthorization.assertNonproductionFakeFinanceAuthorized>),
      vi.spyOn(manifestAuthority, 'releaseManifestDigest').mockReturnValue(release.manifestDigest),
      vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
        expectedTarget: { environment: 'local', databaseName: workerUrl.pathname.slice(1) },
        targetDigest: 'sha256:' + 'e'.repeat(64),
      } as ReturnType<typeof databaseStartup.configuredRuntimeDatabaseStartup>),
    ];
    let running: Promise<void> | undefined, journeyError: unknown;
    try {
      await Promise.all([
        events.waitUntilReady(),
        consumer.waitUntilReady(),
        queue.waitUntilReady(),
      ]);
      const publisher = new FakeFinancialOutboxPublisher(
        new PostgresFakeFinancialOutboxRepository(workerDatabase),
        createFakeFinancialOutboxTransport({ redisUrl: process.env.REDIS_URL, prefix }),
        () => {
          financialAuthorization.assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
        },
        { publisherId: randomUUID(), batchLimit: 1 }
      );
      const outbox = (
        await fixture.pool.query(
          'SELECT bullmq_job_id FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$1',
          [requested.commandId]
        )
      ).rows[0];
      expect(await publisher.runOnce()).toMatchObject({
        claimed: 1,
        confirmed: 1,
        persistenceErrors: 0,
      });
      const job = await queue.getJob(outbox.bullmq_job_id);
      if (!job) throw Error('REVERSAL_QUEUE_JOB_MISSING');
      const finished = job.waitUntilFinished(events, 20_000);
      running = consumer.run().catch((error) => {
        runtimeErrors.push(error);
      });
      await finished;
      expect(await setup.read()).toMatchObject({
        state: 'COMPENSATION_CLAIM',
        reversalRequestState: 'OUTBOX_RECORDED',
        reversalProgress: {
          progressState: 'MATERIALIZED',
          financialEvent: { eventKind: 'REVERSED', status: 'SUCCEEDED' },
        },
      });
      expect(await resume()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        stage: 'COMPENSATION',
        retry_after_ms: null,
      });
      await consumer.pause();
      await job.retry('completed');
      const replay = job.waitUntilFinished(events, 20_000);
      consumer.resume();
      await replay;
      expect(await resume()).toMatchObject({ status: 'RECOVERY_REQUIRED', stage: 'COMPENSATION' });
      expect(requestSpy).toHaveBeenCalledOnce();
      const counts = (
        await fixture.pool.query(
          `SELECT
        (SELECT count(*)::int FROM public.universal_v1_prepared_financial_commands WHERE operation_id=$1) AS preparations,
        (SELECT count(*)::int FROM public.financial_provider_command_journal WHERE operation_id=$1) AS requests,
        (SELECT count(*)::int FROM hx_authority.fake_financial_command_outbox_requests_v13 WHERE command_id=$2) AS outbox,
        (SELECT count(*)::int FROM hx_authority.fake_financial_dispatch_admissions_v13 WHERE command_id=$2) AS admissions,
        (SELECT count(*)::int FROM public.hxos_fake_financial_operations_v1 WHERE operation_id=$1) AS operations,
        (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS provider_events,
        (SELECT count(*)::int FROM public.task_financial_security_events WHERE operation_id=$1::text AND event_kind='REVERSED' AND status='SUCCEEDED') AS reversals,
        (SELECT count(*)::int FROM public.task_work_order_amendments WHERE change_order_id=$3) AS amendments,
        (SELECT count(*)::int FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$3) AS terminals`,
          [command.reversalOperationId, requested.commandId, setup.payload.proposal_id]
        )
      ).rows[0];
      expect(counts).toEqual({
        preparations: 1,
        requests: 1,
        outbox: 1,
        admissions: 1,
        operations: 1,
        provider_events: 1,
        reversals: 1,
        amendments: 0,
        terminals: 0,
      });
      expect(
        (
          await fixture.pool.query(
            'SELECT * FROM public.universal_v1_change_order_compensation_commands WHERE proposal_id=$1',
            [setup.payload.proposal_id]
          )
        ).rows[0]
      ).toEqual(originalClaim);
      expect(
        (
          await fixture.pool.query(
            'SELECT worker_id,universal_payment_posture FROM public.tasks WHERE id=$1',
            [setup.lane.taskId]
          )
        ).rows[0]
      ).toEqual({ worker_id: null, universal_payment_posture: 'PAYMENT_CREATION_FROZEN' });
      expect(
        (
          await fixture.pool.query('SELECT account_status FROM public.users WHERE id=$1', [
            setup.lane.providerUserId,
          ])
        ).rows[0].account_status
      ).toBe('SUSPENDED');
      expect(runtimeErrors).toEqual([]);
    } catch (error) {
      journeyError = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        for (const close of [
          () => consumer.close(),
          async () => {
            if (running) await running;
          },
          () => events.close(),
          () => queue.obliterate({ force: true }),
          () => queue.close(),
          () => workerPool.end(),
        ])
          try {
            await close();
          } catch (error) {
            cleanupErrors.push(error);
          }
      } finally {
        for (const spy of spies) spy.mockRestore();
        requestSpy.mockRestore();
      }
      if (!journeyError && cleanupErrors.length)
        throw new AggregateError(cleanupErrors, 'REVERSAL_TRANSPORT_CLEANUP_FAILED');
    }
  }, 60_000);

  it('adjustment execution serializes concurrent workers into one immutable effect', async () => {
    const setup = await adjustmentExecutionFixture();
    const url = new URL(fixture.databaseUrl);
    url.username = roles.workerRole;
    url.password = password;
    const other = new pg.Client({ connectionString: url.toString() });
    await other.connect();
    try {
      const results = await Promise.all([setup.execute(), setup.execute(other)]);
      expect(results[0].event_id).toBe(results[1].event_id);
      expect(results.map((result) => result.idempotency_replayed).sort()).toEqual([false, true]);
      expect(await setup.effects()).toEqual({ operations: 1, events: 1 });
    } finally {
      await other.end();
    }
  }, 60_000);

  async function resolvedAuthorizationFixture(
    acquireLease = true,
    allowQueuedFixtureClaims = false
  ) {
    const apiDatabase = preparationDatabase(clients.get('apiRole')!);
    const { lane, phase, key } = await createPreparedWorkOrderFixture(
      preparationDatabase(),
      fixture.pool,
      apiDatabase,
      clients.get('attesterRole')!,
      roles.attesterRole,
      'sha256:' + 'b'.repeat(64),
      'resolved-money'
    );
    const release = {
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      releaseId: 'synthetic.resolved.money',
      revision: 'd'.repeat(40),
      environment: 'local' as const,
      authenticationStatus: 'VERIFIED' as const,
    };
    const service = new requestApplication.UniversalV1FinancialRequestService(
      new PostgresUniversalV1PreparedFinancialCommandAuthority(apiDatabase),
      new PostgresFinancialProviderCommandJournal(apiDatabase),
      () => release,
      new PostgresUniversalV1FinancialRequestProgressReader(apiDatabase),
      new PostgresUniversalV1FinancialPredecessorReader(apiDatabase)
    );
    const requestThroughApi = async (
      command: Parameters<
        ReturnType<typeof universalFinanceRouter.createCaller>['enqueueEvent']
      >[0] & {
        recordedBy: string;
      }
    ) => {
      const user = (
        await fixture.pool.query('SELECT * FROM public.users WHERE id=$1', [lane.posterUserId])
      ).rows[0] as NonNullable<Context['user']>;
      const caller = universalFinanceRouter.createCaller({
        user,
        firebaseUid: user.firebase_uid ?? null,
        ip: '127.0.0.1',
        actorAttestation: await preparationAttestation(lane.posterUserId),
      });
      const { recordedBy, ...input } = command;
      expect(recordedBy).toBe(user.id);
      const factory = vi
        .spyOn(requestApplication, 'createUniversalV1FinancialRequestService')
        .mockReturnValue(service);
      try {
        return await caller.enqueueEvent(input);
      } finally {
        factory.mockRestore();
      }
    };
    const readProgress = async () => {
      const user = (
        await fixture.pool.query('SELECT * FROM public.users WHERE id=$1', [lane.posterUserId])
      ).rows[0] as NonNullable<Context['user']>;
      const caller = universalFinanceRouter.createCaller({
        user,
        firebaseUid: user.firebase_uid ?? null,
        ip: '127.0.0.1',
        actorAttestation: await preparationAttestation(lane.posterUserId),
      });
      const factory = vi
        .spyOn(requestApplication, 'createUniversalV1FinancialRequestService')
        .mockReturnValue(service);
      try {
        return await caller.requestProgress({ commandId: requested.commandId });
      } finally {
        factory.mockRestore();
      }
    };
    const worker = clients.get('workerRole')!;
    const outcomeSql = 'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)';
    const materializeSql = 'SELECT * FROM public.hxos_materialize_fake_financial_event_v13($1,$2)';
    const common = {
      providerKind: 'FAKE' as const,
      providerExpectedVersion: 0,
      taskDraftId: lane.draftId,
      taskId: lane.taskId,
      eligibilityDecisionId: lane.eligibilityDecisionId,
      scopeVersionId: lane.scopeVersionId,
      occurredAt: phase.occurredAt,
      recordedBy: lane.posterUserId,
    };
    const dispatch = async (commandId: string) => {
      let claim;
      for (let attempt = 0; attempt < 64; attempt += 1) {
        claim = (
          await worker.query('SELECT * FROM public.hxos_claim_fake_financial_outbox_v13($1,300)', [
            randomUUID(),
          ])
        ).rows[0];
        expect(claim).toBeDefined();
        if (claim.command_id === commandId || !allowQueuedFixtureClaims) break;
        // The last rollover case may follow admission-only fixtures. Keep their
        // bounded claims leased, without inventing publication or dispatch.
        // The real FIFO port must reach this case's exact newly requested ID.
      }
      expect(claim.command_id).toBe(commandId);
      // Restricted SQL ports with explicit synthetic stored transport acknowledgement.
      await worker.query(
        "SELECT public.hxos_record_fake_financial_publish_outcome_v13($1,'BULLMQ_CONFIRMED',$2,$3,NULL,NULL)",
        [claim.publish_claim_id, claim.bullmq_job_id, claim.job_authority_sha256]
      );
      const workerId = randomUUID();
      const admission = (
        await worker.query(
          'SELECT * FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13($1,$2,$3,$4,0,3,2)',
          [claim.outbox_request_id, claim.bullmq_job_id, claim.job_authority_sha256, workerId]
        )
      ).rows[0];
      const raw = (
        await worker.query(
          'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
          [admission.job_validation_id, workerId]
        )
      ).rows[0];
      return { claim, admission, raw, workerId };
    };
    const requestedPreparation = await requestThroughApi({
      ...common,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      operationId: deterministicUuid(key, 'prepare'),
      idempotencyKey: key + ':prep',
      lifecycleExpectedVersion: 0,
      customerId: lane.posterUserId,
    });
    const prep = await dispatch(requestedPreparation.commandId);
    const prepOutcome = (
      await worker.query(outcomeSql, [
        prep.admission.job_validation_id,
        prep.workerId,
        prep.admission.recovery_lease_id,
      ])
    ).rows[0];
    const predecessor = (
      await worker.query(materializeSql, [
        prep.admission.job_validation_id,
        prepOutcome.outcome_fact.outcome_fact_id,
      ])
    ).rows[0].financial_event;
    expect(predecessor).toMatchObject({
      event_kind: 'PAYMENT_METHOD_PREPARED',
      status: 'SUCCEEDED',
    });
    const amount = Number(phase.context.customer_total_cents),
      currency = phase.context.currency.toLowerCase();
    const requested = await requestThroughApi({
      ...common,
      operationKind: 'AUTHORIZE',
      operationId: deterministicUuid(key, 'authorize'),
      idempotencyKey: key + ':auth',
      lifecycleExpectedVersion: 1,
      predecessorEventId: predecessor.id,
      relatedOperationId: predecessor.operation_id,
      amountCents: amount,
      currency,
      paymentMethodReference: predecessor.external_reference,
      scenario: 'TIMEOUT',
    });
    const dispatched = await dispatch(requested.commandId);
    expect(dispatched.raw).toMatchObject({ state: 'PENDING', retryable: true, expires_at: null });
    const pending = (
      await worker.query(outcomeSql, [
        dispatched.admission.job_validation_id,
        dispatched.workerId,
        dispatched.admission.recovery_lease_id,
      ])
    ).rows[0];
    const hook = await webhookFixture();
    const occurred = (
      await fixture.pool.query(
        'SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\',\'YYYY-MM-DD"T"HH24:MI:SS.US"Z"\') AS time'
      )
    ).rows[0].time;
    const body = Buffer.from(
      JSON.stringify({
        ...hook.payload,
        operationId: dispatched.raw.operation_id,
        operationKind: 'AUTHORIZE',
        externalReference: dispatched.raw.external_reference,
        amountCents: amount,
        currency: currency.toUpperCase(),
        providerOccurredAt: occurred,
      }).replace('"amountCents":' + amount, '"amountCents":' + amount + '.0')
    );
    const receipt = await hook.send(body, hook.sign(body), 'money-resolution:' + randomUUID());
    await fixture.pool.query(
      'SELECT pg_sleep_until(expires_at) FROM public.financial_provider_command_recovery_leases WHERE recovery_lease_id=$1',
      [dispatched.admission.recovery_lease_id]
    );
    const reconcileArgs = [dispatched.admission.job_validation_id, randomUUID(), randomUUID()];
    if (acquireLease)
      await worker.query(
        'SELECT * FROM public.hxos_acquire_fake_financial_reconcile_lease_v13($1,$2,$3,30)',
        reconcileArgs
      );
    return {
      worker,
      readProgress,
      release,
      ownerActorId: lane.posterUserId,
      readPredecessorSql: async () => {
        const payload = {
          operationKind: 'AUTHORIZE' as const,
          operationId: deterministicUuid(key, 'authorize'),
          taskDraftId: lane.draftId,
          idempotencyKey: key + ':auth',
        };
        const assertion = await (
          await preparationAttestation(lane.posterUserId)
        ).issue({
          commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR',
          commandPayload: payload,
        });
        return apiDatabase.transaction(
          async (query) =>
            (
              await query<{ financial_facts: unknown }>(
                'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
                [assertion.actor_assertion_token, payload]
              )
            ).rows[0].financial_facts
        );
      },
      readPredecessor: async () =>
        service.readPredecessor(
          {
            operationKind: 'AUTHORIZE',
            operationId: deterministicUuid(key, 'authorize'),
            taskDraftId: lane.draftId,
            idempotencyKey: key + ':auth',
          },
          lane.posterUserId,
          await preparationAttestation(lane.posterUserId)
        ),
      outcomeSql,
      materializeSql,
      pending,
      receipt,
      amount,
      occurred,
      hook,
      reconcileArgs,
      ...dispatched,
      binding: { jobId: dispatched.claim.bullmq_job_id, payload: dispatched.claim.job_payload },
      readerAuthority: {
        environment: 'local' as const,
        databaseName: hook.binding.targetDatabaseName,
        targetDigest: 'synthetic-money-resolution',
        manifestDigest: release.manifestDigest,
      },
    };
  }

  it('materializes signed money-valued authorization resolution while preserving pending raw bytes and fixed provider expiry', async () => {
    const f = await resolvedAuthorizationFixture();
    let resolved;
    try {
      await f.worker.query('BEGIN');
      await f.worker.query('SAVEPOINT outcome');
      resolved = (await f.worker.query(f.outcomeSql, f.reconcileArgs)).rows[0];
      await f.worker.query('RELEASE SAVEPOINT outcome');
      await expect(
        f.worker.query(f.materializeSql, [
          f.admission.job_validation_id,
          resolved.outcome_fact.outcome_fact_id,
        ])
      ).rejects.toThrow('COMMITTED_OUTCOME_REQUIRED');
    } finally {
      await f.worker.query('ROLLBACK');
    }
    resolved = (await f.worker.query(f.outcomeSql, f.reconcileArgs)).rows[0];
    const args = [f.admission.job_validation_id, resolved.outcome_fact.outcome_fact_id];
    expect(await f.readProgress()).toMatchObject({
      commandId: f.binding.payload.commandId,
      progressState: 'RECOVERY_REQUIRED',
      financialEvent: null,
    });
    expect(await f.readPredecessorSql()).toMatchObject({
      progress: { progressState: 'RECOVERY_REQUIRED', financialEvent: null },
      predecessor: null,
    });
    expect(await f.readPredecessor()).toMatchObject({
      progress: { progressState: 'RECOVERY_REQUIRED', financialEvent: null },
      predecessor: null,
    });
    let tentative;
    try {
      await f.worker.query('BEGIN');
      tentative = (await f.worker.query(f.materializeSql, args)).rows[0];
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.task_financial_security_events WHERE operation_id=$1',
            [f.raw.operation_id]
          )
        ).rows
      ).toEqual([{ count: 0 }]);
    } finally {
      await f.worker.query('ROLLBACK');
    }
    expect(tentative.financial_event.amount_cents).toBe(f.amount);
    expect(await f.readProgress()).toMatchObject({
      progressState: 'RECOVERY_REQUIRED',
      financialEvent: null,
    });
    const result = (await f.worker.query(f.materializeSql, args)).rows[0];
    const decoded = decodeFakeFinancialMaterializationRow(
      result,
      { ...f.binding, jobValidationId: args[0], outcomeFactId: args[1] },
      f.readerAuthority
    );
    expect(decoded.observation?.event).toMatchObject({
      state: 'PENDING',
      expiresAt: null,
      responseSha256: f.raw.response_sha256,
    });
    expect(decoded.financialEvent).toMatchObject({
      event_kind: 'AUTHORIZED',
      status: 'SUCCEEDED',
      amount_cents: f.amount,
      expected_version: 1,
    });
    expect(decoded.lifecycleBridge).toMatchObject({
      fake_operation_event_id: f.raw.event_id,
      fake_provider_state: 'SUCCEEDED',
      fake_event_response_sha256: f.raw.response_sha256,
      resolution_contract_version: 1,
      resolution_observation_id: f.receipt.observationId,
      resolution_receipt_id: f.receipt.receiptId,
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT (occurred_at=$2::TIMESTAMPTZ) AS exact_time,(expires_at=occurred_at+interval '15 minutes') AS exact_expiry FROM public.task_financial_security_events WHERE operation_id=$1",
          [f.raw.operation_id, f.occurred]
        )
      ).rows
    ).toEqual([{ exact_time: true, exact_expiry: true }]);
    const historical = await f.readPredecessor();
    expect(historical?.predecessor).toMatchObject({
      commandId: f.binding.payload.commandId,
      operationKind: 'AUTHORIZE',
      financialEventId: result.financial_event.id,
      amountCents: f.amount,
      externalReference: null,
      occurredAt: result.financial_event.occurred_at,
      expiresAt: result.financial_event.expires_at,
    });
    const publicProgress = await f.readProgress();
    expect(publicProgress).toEqual({
      commandId: f.binding.payload.commandId,
      operationId: f.raw.operation_id,
      operationKind: 'AUTHORIZE',
      taskDraftId: result.financial_event.task_draft_id,
      taskId: result.financial_event.task_id,
      requestedAt: expect.any(String),
      observedAt: expect.any(String),
      requestState: 'REQUESTED',
      progressState: 'MATERIALIZED',
      financialEvent: {
        id: result.financial_event.id,
        eventKind: 'AUTHORIZED',
        status: 'SUCCEEDED',
      },
    });
    expect(JSON.stringify(publicProgress)).not.toContain(f.raw.external_reference);
    const replay = (await f.worker.query(f.materializeSql, args)).rows[0];
    expect(replay).toEqual({ ...result, idempotency_replayed: true });
    expect(
      (
        await fixture.pool.query(
          'SELECT state,expires_at,response_sha256 FROM public.hxos_fake_financial_operation_events_v1 WHERE event_id=$1',
          [f.raw.event_id]
        )
      ).rows
    ).toEqual([{ state: 'PENDING', expires_at: null, response_sha256: f.raw.response_sha256 }]);
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.financial_provider_command_dispatch_attempts WHERE command_id=$1',
          [f.binding.payload.commandId]
        )
      ).rows
    ).toEqual([{ count: 1 }]);
  });

  it('serializes concurrent resolved authorization materialization and preserves replay after a later signed conflict', async () => {
    const f = await resolvedAuthorizationFixture();
    const resolved = (await f.worker.query(f.outcomeSql, f.reconcileArgs)).rows[0];
    const args = [f.admission.job_validation_id, resolved.outcome_fact.outcome_fact_id];
    const url = new URL(fixture.databaseUrl);
    url.username = roles.workerRole;
    url.password = password;
    const other = new pg.Client({ connectionString: url.toString() });
    await other.connect();
    let result;
    try {
      const responses = await Promise.all([
        f.worker.query(f.materializeSql, args),
        other.query(f.materializeSql, args),
      ]);
      const rows = responses.map((response) => response.rows[0]);
      expect(rows.map((row) => row.idempotency_replayed).sort()).toEqual([false, true]);
      expect(rows[0].financial_event).toEqual(rows[1].financial_event);
      expect(rows[0].lifecycle_bridge).toEqual(rows[1].lifecycle_bridge);
      result = rows[0];
    } finally {
      await other.end();
    }
    const body = Buffer.from(
      JSON.stringify({
        ...JSON.parse(resolved.provider_event.resolution.raw_payload),
        providerEventReference: 'later-money-conflict:' + randomUUID(),
        observedState: 'FAILED',
      })
    );
    await f.hook.send(body, f.hook.sign(body), 'later-money:' + randomUUID());
    await clients
      .get('migrationRole')!
      .query(
        'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
        [f.hook.keyId]
      );
    await f.worker.query('BEGIN');
    try {
      await f.worker.query(f.materializeSql, args);
      await f.worker.query('COMMIT'); // Caller deliberately discards acknowledgement.
    } finally {
      await f.worker.query('ROLLBACK');
    }
    expect((await f.worker.query(f.materializeSql, args)).rows[0]).toEqual({
      ...result,
      idempotency_replayed: true,
    });
    expect((await f.readPredecessor())?.predecessor).toMatchObject({
      financialEventId: result.financial_event.id,
      operationKind: 'AUTHORIZE',
      externalReference: null,
    });
    // Fresh human read retains the committed historical result after later
    // signed conflict and key revocation; it cannot create another admission.
    expect(await f.readProgress()).toMatchObject({
      commandId: f.binding.payload.commandId,
      progressState: 'MATERIALIZED',
      financialEvent: {
        id: result.financial_event.id,
        eventKind: 'AUTHORIZED',
        status: 'SUCCEEDED',
      },
    });
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.universal_v1_fake_financial_lifecycle_bridges WHERE command_id=$1',
          [f.binding.payload.commandId]
        )
      ).rows
    ).toEqual([{ count: 1 }]);
  });

  it('rejects substituted resolved bridge provenance and one-microsecond lifecycle time drift in PostgreSQL', async () => {
    const f = await resolvedAuthorizationFixture();
    const resolved = (await f.worker.query(f.outcomeSql, f.reconcileArgs)).rows[0];
    const args = [f.admission.job_validation_id, resolved.outcome_fact.outcome_fact_id];
    let template;
    try {
      await f.worker.query('BEGIN');
      template = (await f.worker.query(f.materializeSql, args)).rows[0];
    } finally {
      await f.worker.query('ROLLBACK');
    }
    // Owner-backed adversarial inserts exercise the triggers. Runtime roles
    // cannot insert either table; the production port accepts only two IDs.
    const connection = await fixture.pool.connect();
    try {
      for (const field of [
        'resolution_contract_version',
        'resolution_observation_id',
        'resolution_receipt_id',
        'resolution_identity_sha256',
        'occurred_at',
        'expires_at',
      ]) {
        await connection.query('BEGIN');
        try {
          const altered = { ...template.lifecycle_bridge };
          if (field === 'resolution_contract_version') altered[field] = 2;
          else if (field === 'resolution_identity_sha256') altered[field] = '9'.repeat(64);
          else if (field.startsWith('resolution_')) altered[field] = randomUUID();
          const timeField = field === 'occurred_at' || field === 'expires_at' ? field : null;
          await connection.query(
            "INSERT INTO public.task_financial_security_events SELECT (jsonb_populate_record(NULL::public.task_financial_security_events,CASE WHEN $2::TEXT IS NULL THEN $1::JSONB ELSE jsonb_set($1::JSONB,ARRAY[$2]::TEXT[],to_jsonb(($1::JSONB->>$2)::TIMESTAMPTZ+interval '1 microsecond'),false) END)).*",
            [JSON.stringify(template.financial_event), timeField]
          );
          await expect(
            connection.query(
              'INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges SELECT (jsonb_populate_record(NULL::public.universal_v1_fake_financial_lifecycle_bridges,$1::JSONB)).*',
              [JSON.stringify(altered)]
            )
          ).rejects.toThrow(/BRIDGE_RESOLUTION_MISMATCH|exact raw fake-provider facts/u);
        } finally {
          await connection.query('ROLLBACK');
        }
      }
    } finally {
      connection.release();
    }
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.task_financial_security_events WHERE operation_id=$1',
          [f.raw.operation_id]
        )
      ).rows
    ).toEqual([{ count: 0 }]);
    expect((await f.worker.query(f.materializeSql, args)).rows[0].financial_event.status).toBe(
      'SUCCEEDED'
    );
  });

  it('recovers a signed authorization through the normal worker implementation after protected API requests', async () => {
    const f = await resolvedAuthorizationFixture(false);
    const workerDatabase = preparationDatabase(f.worker);
    const manifest = {
      releaseId: 'synthetic.resolved.worker',
      environment: 'local',
      components: { backend: { revision: 'd'.repeat(40) }, worker: { revision: 'd'.repeat(40) } },
    } as unknown as ReturnType<
      typeof financialAuthorization.assertNonproductionFakeFinanceAuthorized
    >;
    // The fixture injects authenticated tRPC context, uses fresh synthetic actor
    // assertions, and records the initial transport/admission/execution directly.
    // Recovery uses default worker ports and restricted PostgreSQL; release and
    // runtime installation below are synthetic. This does not exercise HTTP,
    // Firebase, actual Redis delivery, initial processor execution or OS restart.
    const spies = [
      vi
        .spyOn(runtimeDb, 'transaction')
        .mockImplementation((callback) => workerDatabase.transaction(callback)),
      vi
        .spyOn(financialAuthorization, 'assertNonproductionFakeFinanceAuthorized')
        .mockReturnValue(manifest),
      vi
        .spyOn(manifestAuthority, 'releaseManifestDigest')
        .mockReturnValue(f.readerAuthority.manifestDigest),
      vi.spyOn(databaseStartup, 'configuredRuntimeDatabaseStartup').mockReturnValue({
        expectedTarget: { environment: 'local', databaseName: f.readerAuthority.databaseName },
        targetDigest: 'sha256:' + 'e'.repeat(64),
      } as ReturnType<typeof databaseStartup.configuredRuntimeDatabaseStartup>),
    ];
    try {
      const result = await new SyntheticFinancialCommandProcessor().recover(f.binding);
      expect(result).toMatchObject({ state: 'MATERIALIZED', idempotencyReplayed: false });
      const replay = await new SyntheticFinancialCommandProcessor().recover(f.binding);
      expect(replay).toEqual({ ...result, idempotencyReplayed: true });
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.financial_provider_command_dispatch_attempts WHERE command_id=$1',
            [f.binding.payload.commandId]
          )
        ).rows
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.universal_v1_fake_financial_lifecycle_bridges WHERE command_id=$1',
            [f.binding.payload.commandId]
          )
        ).rows
      ).toEqual([{ count: 1 }]);
      expect(
        (
          await fixture.pool.query(
            'SELECT state,response_sha256 FROM public.hxos_fake_financial_operation_events_v1 WHERE event_id=$1',
            [f.raw.event_id]
          )
        ).rows
      ).toEqual([{ state: 'PENDING', response_sha256: f.raw.response_sha256 }]);
    } finally {
      for (const spy of spies.reverse()) spy.mockRestore();
    }
  });

  // These resolution-only cases intentionally retain pending or unmaterialized
  // commands. Run them after the shared-database transport recovery cohort,
  // whose scan covers all unfinished commands. No source assertion is weakened.
  it('resolves an admitted pending operation through committed signed evidence without rewriting its raw event or dispatch', async () => {
    const f = await pendingResolutionFixture(1);
    const receipt = await f.send();
    // A committed signature remains historical evidence after revocation/expiry.
    await clients
      .get('migrationRole')!
      .query(
        'INSERT INTO hx_authority.fake_financial_webhook_key_revocations_v13(key_id) VALUES($1)',
        [f.hook.keyId]
      );
    const args = await f.reconcile();
    expect(
      (
        await fixture.pool.query(
          'SELECT clock_timestamp()>=expires_at AS expired FROM hx_authority.fake_financial_webhook_keys_v13 WHERE key_id=$1',
          [f.hook.keyId]
        )
      ).rows
    ).toEqual([{ expired: true }]);
    const resolved = (await f.worker.query(f.outcomeSql, args)).rows[0];
    expect(resolved.outcome_fact).toMatchObject({
      provider_state: 'SUCCEEDED',
      retryable: false,
      effect_certainty: 'CONFIRMED_EFFECT',
    });
    expect(resolved.provider_event).toMatchObject({
      kind: 'HX_FAKE_TERMINAL_OBSERVATION_V13',
      original_event: { event_id: f.original.event_id, state: 'PENDING' },
      resolution: { observation_id: receipt.observationId, receipt_id: receipt.receiptId },
    });
    const decoded = decodeFakeFinancialOutcomeRow(
      resolved,
      {
        ...f.binding,
        jobValidationId: args[0],
        workerInstanceId: args[1],
        recoveryLeaseId: args[2],
      },
      f.readerAuthority
    );
    expect(decoded.observation?.event.state).toBe('PENDING');
    expect(decoded.resolution?.providerResult).toMatchObject({
      state: 'SUCCEEDED',
      version: 1,
      recordedAt: resolved.provider_event.resolution.provider_occurred_at,
      expiresAt: null,
    });
    const old = (await f.worker.query(f.outcomeSql, f.initialArgs)).rows[0];
    expect(old).toEqual({ ...f.initial, idempotency_replayed: true });
    const progress = (
      await f.worker.query('SELECT * FROM public.hxos_read_fake_financial_progress_v13($1,$2,$3)', [
        f.binding.payload.outboxRequestId,
        f.binding.jobId,
        f.binding.payload.jobAuthoritySha256,
      ])
    ).rows[0];
    expect(
      decodeFakeFinancialProgressRow(progress, f.binding, f.readerAuthority).recordedOutcome
        ?.outcome.provider_state
    ).toBe('SUCCEEDED');
    // Later evidence cannot retroactively change the receipt chosen by a
    // committed outcome. Conflict handling for new commands is separate.
    const laterHook = await webhookFixture();
    const laterBody = Buffer.from(
      JSON.stringify({
        ...f.payload,
        providerEventReference: 'later-conflict:' + randomUUID(),
        observedState: 'FAILED',
      })
    );
    await laterHook.send(laterBody, laterHook.sign(laterBody), 'later:' + randomUUID());
    const replay = (await f.worker.query(f.outcomeSql, args)).rows[0];
    expect(replay).toEqual({ ...resolved, idempotency_replayed: true });
    expect(
      (
        await f.worker.query(
          'SELECT * FROM public.hxos_read_fake_financial_progress_v13($1,$2,$3)',
          [f.binding.payload.outboxRequestId, f.binding.jobId, f.binding.payload.jobAuthoritySha256]
        )
      ).rows[0]
    ).toEqual(progress);
    const facts = (
      await fixture.pool.query(
        `SELECT
      (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1 WHERE operation_id=$1) AS raw_events,
      (SELECT count(*)::int FROM public.financial_provider_command_dispatch_attempts WHERE command_id=$2) AS dispatches,
      (SELECT count(*)::int FROM public.financial_provider_command_outcome_facts WHERE command_id=$2 AND resolution_contract_version=1) AS resolutions,
      (SELECT count(*)::int FROM public.task_financial_security_events WHERE operation_id=$1::TEXT) AS lifecycle_events`,
        [f.original.operation_id, f.binding.payload.commandId]
      )
    ).rows[0];
    expect(facts).toEqual({ raw_events: 1, dispatches: 1, resolutions: 1, lifecycle_events: 0 });
    expect(
      (
        await fixture.pool.query(
          'SELECT state,response_sha256 FROM public.hxos_fake_financial_operation_events_v1 WHERE event_id=$1',
          [f.original.event_id]
        )
      ).rows[0]
    ).toEqual({ state: 'PENDING', response_sha256: f.original.response_sha256 });
  });

  it('ignores unrelated signed versions/value references while selecting the exact dispatched result', async () => {
    const f = await pendingResolutionFixture();
    for (const change of [
      { predecessorProviderVersion: 1, observedProviderVersion: 2 },
      { externalReference: 'unrelated-reference' },
      { operationKind: 'AUTHORIZE', amountCents: 12000, currency: 'USD' },
      { providerOccurredAt: '2020-01-01T00:00:00Z' },
    ]) {
      await f.send(
        Buffer.from(
          JSON.stringify({
            ...f.payload,
            providerEventReference: 'unrelated:' + randomUUID(),
            ...change,
          })
        )
      );
    }
    const receipt = await f.send();
    const args = await f.reconcile();
    const resolved = (await f.worker.query(f.outcomeSql, args)).rows[0];
    expect(resolved.provider_event.resolution.observation_id).toBe(receipt.observationId);
    expect(resolved.outcome_fact.provider_state).toBe('SUCCEEDED');
  });

  it.each(['state', 'provider_time'] as const)(
    'holds conflicting authenticated terminal %s without committing a terminal outcome',
    async (conflict) => {
      const f = await pendingResolutionFixture();
      await f.send();
      const time = (
        await fixture.pool.query(
          `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS time`
        )
      ).rows[0].time;
      await f.send(
        Buffer.from(
          JSON.stringify({
            ...f.payload,
            providerEventReference: 'conflict:' + randomUUID(),
            ...(conflict === 'state' ? { observedState: 'FAILED' } : { providerOccurredAt: time }),
          })
        )
      );
      const args = await f.reconcile();
      await expect(f.worker.query(f.outcomeSql, args)).rejects.toThrow(
        'CONFLICTING_TERMINAL_OBSERVATIONS'
      );
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND resolution_contract_version=1',
            [f.binding.payload.commandId]
          )
        ).rows[0].count
      ).toBe(0);
    }
  );

  it.each(['2026-09-05T00:00:00.1234567Z', '2026-09-05T24:00:00Z', '2026-09-05T00:00:60Z'])(
    'rejects signed timestamp %s outside the decoder contract before storing resolution evidence',
    async (providerOccurredAt) => {
      const f = await pendingResolutionFixture();
      const raw = Buffer.from(JSON.stringify({ ...f.payload, providerOccurredAt }));
      await expect(f.send(raw)).rejects.toThrow('PAYLOAD_INVALID');
    }
  );

  it('requires a prior outer COMMIT of signed verification even after a released savepoint', async () => {
    const f = await pendingResolutionFixture();
    const connection = await fixture.pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SAVEPOINT ingress');
      // Only this adversarial owner-backed test can switch among the isolated
      // API/finance roles inside one connection. Runtime logins cannot do so.
      await connection.query('SET LOCAL ROLE ' + quote(roles.apiRole));
      const receipt = (
        await connection.query(
          'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4) AS receipt',
          [f.hook.keyId, f.body, f.hook.sign(f.body), 'same-outer:' + randomUUID()]
        )
      ).rows[0].receipt;
      await connection.query('RELEASE SAVEPOINT ingress');
      await connection.query('RESET ROLE');
      await connection.query('SET LOCAL ROLE ' + quote(roles.financeOwnerRole));
      await expect(
        connection.query(
          'SELECT hx_authority.read_fake_financial_terminal_observation_v13($1,$2,$3)',
          [f.admission.job_validation_id, receipt.observationId, receipt.receiptId]
        )
      ).rejects.toThrow('COMMITTED_VERIFICATION_REQUIRED');
    } finally {
      await connection.query('ROLLBACK');
      connection.release();
    }
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE key_id=$1',
          [f.hook.keyId]
        )
      ).rows
    ).toEqual([{ count: 0 }]);
  });

  it('rolls back tentative terminal outcomes and exactly replays after a discarded COMMIT acknowledgement', async () => {
    const f = await pendingResolutionFixture();
    await f.send();
    const args = await f.reconcile();
    const count = async () =>
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND resolution_contract_version=1',
          [f.binding.payload.commandId]
        )
      ).rows[0].count;
    try {
      await f.worker.query('BEGIN');
      await f.worker.query('SAVEPOINT terminal_outcome');
      const tentative = (await f.worker.query(f.outcomeSql, args)).rows[0];
      expect(tentative.outcome_fact.provider_state).toBe('SUCCEEDED');
      await f.worker.query('RELEASE SAVEPOINT terminal_outcome');
      expect(await count()).toBe(0);
    } finally {
      await f.worker.query('ROLLBACK');
    }
    expect(await count()).toBe(0);
    let committed;
    try {
      await f.worker.query('BEGIN');
      committed = (await f.worker.query(f.outcomeSql, args)).rows[0];
      await f.worker.query('COMMIT'); // Discard acknowledgement at caller boundary.
    } finally {
      await f.worker.query('ROLLBACK');
    }
    expect(await count()).toBe(1);
    expect((await f.worker.query(f.outcomeSql, args)).rows[0]).toEqual({
      ...committed,
      idempotency_replayed: true,
    });
  });

  it('serializes concurrent restricted-worker resolution into one immutable terminal outcome', async () => {
    const f = await pendingResolutionFixture();
    await f.send();
    const args = await f.reconcile();
    const url = new URL(fixture.databaseUrl);
    url.username = roles.workerRole;
    url.password = password;
    const other = new pg.Client({ connectionString: url.toString() });
    await other.connect();
    try {
      const results = await Promise.all([
        f.worker.query(f.outcomeSql, args),
        other.query(f.outcomeSql, args),
      ]);
      const rows = results.map((result) => result.rows[0]);
      expect(rows.map((row) => row.idempotency_replayed).sort()).toEqual([false, true]);
      expect(rows[0].outcome_fact).toEqual(rows[1].outcome_fact);
      expect(rows[0].provider_event).toEqual(rows[1].provider_event);
      expect(
        (
          await fixture.pool.query(
            'SELECT count(*)::int AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND resolution_contract_version=1',
            [f.binding.payload.commandId]
          )
        ).rows
      ).toEqual([{ count: 1 }]);
    } finally {
      await other.end();
    }
  });

  it('keeps an admitted command pending when legacy caller-VERIFIED receipts have no independent verification', async () => {
    const f = await pendingResolutionFixture();
    const observationId = randomUUID(),
      receiptId = randomUUID();
    const rawHash = createHash('sha256').update(f.body).digest('hex');
    const ingressKey = 'legacy-resolution:' + randomUUID();
    const authenticationHash = fakeFinancialWebhookAuthenticationEvidence(
      fakeFinancialWebhookSignedBytes(f.hook.binding, f.body),
      f.hook.sign(f.body)
    );
    // Owner-backed legacy fixture has otherwise exact bytes and hashes, but no
    // sealed verification. It must never be promoted into an authoritative result.
    await preparationDatabase().transaction(async (query) => {
      await query(
        "INSERT INTO public.provider_event_inbox_observations(observation_id,provider_kind,provider_event_reference,provider_event_kind,operation_id,raw_payload,raw_payload_sha256,raw_payload_bytes) VALUES($1,'FAKE',$2,'FINANCIAL_OPERATION_OBSERVED',$3,$4,$5,$6)",
        [
          observationId,
          f.payload.providerEventReference,
          f.payload.operationId,
          f.body,
          rawHash,
          f.body.length,
        ]
      );
      await query(
        "INSERT INTO public.provider_event_inbox_receipts(receipt_id,observation_id,ingress_idempotency_key,request_sha256,authentication_status,authentication_scheme,authentication_evidence_sha256,authenticated_at) VALUES($1,$2,$3,hx_authority.fake_financial_job_digest_v13($4::TEXT[]),'VERIFIED','HMAC_SHA256_TARGET_V13',$5,clock_timestamp())",
        [
          receiptId,
          observationId,
          ingressKey,
          [
            'HX_FAKE_WEBHOOK_RECEIPT_V13',
            f.hook.keyId,
            f.hook.binding.targetAuthorityId,
            ingressKey,
            rawHash,
            authenticationHash,
          ],
          authenticationHash,
        ]
      );
    });
    const result = (await f.worker.query(f.outcomeSql, await f.reconcile())).rows[0];
    expect(result.outcome_fact).toMatchObject({ provider_state: 'PENDING', retryable: true });
    expect(result.provider_event).not.toHaveProperty('resolution');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS count FROM public.financial_provider_command_outcome_facts WHERE command_id=$1 AND resolution_contract_version=1',
          [f.binding.payload.commandId]
        )
      ).rows
    ).toEqual([{ count: 0 }]);
  });

  it('admits authenticated preparation into REQUESTED and replays with exactly one outbox entry through the API login', async () => {
    const { input } = await claimedPreparation('auth-requested');
    const receipt = await preparationAuthority().prepare(
      input,
      await preparationAttestation(input.recordedBy)
    );
    const params = preparationRequest(input, receipt);
    const api = clients.get('apiRole')!;
    const first = await api.query(
      'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
      params
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].idempotency_replayed).toBe(false);
    const replay = await api.query(
      'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
      params
    );
    expect(replay.rows).toEqual([{ ...first.rows[0], idempotency_replayed: true }]);
    const facts = await fixture.pool.query(
      `SELECT journal.command_id, outbox.command_id AS outbox_command_id
       FROM public.financial_provider_command_journal journal
       JOIN hx_authority.fake_financial_command_outbox_requests_v13 outbox USING(command_id)
       WHERE journal.prepared_financial_command_id=$1`,
      [receipt.preparedCommandId]
    );
    expect(facts.rows).toEqual([
      {
        command_id: first.rows[0].command_id,
        outbox_command_id: first.rows[0].command_id,
      },
    ]);
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.task_financial_security_events WHERE task_draft_id=$1',
          [input.taskDraftId]
        )
      ).rows[0].n
    ).toBe(0);
  });

  it('refuses REQUESTED for an otherwise valid legacy owner-created preparation without authenticated provenance', async () => {
    const { input } = await claimedPreparation('legacy-preparation');
    // Deliberately exercise historical owner setup as negative evidence. Runtime
    // logins have no access to this port and must use authenticated preparation.
    const legacy = await fixture.pool.query(
      `SELECT prepared_command_id, authority_context_sha256
       FROM public.hxos_prepare_universal_v1_financial_command_v1(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
       )`,
      [
        randomUUID(),
        input.operationKind,
        input.operationId,
        input.providerKind,
        input.idempotencyKey,
        input.providerExpectedVersion,
        input.lifecycleExpectedVersion,
        input.providerRequestSha256,
        input.taskDraftId,
        input.taskId,
        input.eligibilityDecisionId,
        input.scopeVersionId,
        input.changeOrderId,
        input.predecessorEventId,
        input.completionFactId,
        input.relatedOperationId,
        input.amountCents,
        input.currency,
        input.recordedBy,
      ]
    );
    const receipt = {
      preparedCommandId: legacy.rows[0].prepared_command_id as string,
      authorityContextSha256: legacy.rows[0].authority_context_sha256 as string,
    };
    await expect(
      clients
        .get('apiRole')!
        .query(
          'SELECT * FROM public.hxos_request_fake_financial_command_v13($1,$2)',
          preparationRequest(input, receipt)
        )
    ).rejects.toThrow('AUTHENTICATED_PREPARATION_REQUIRED');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.financial_provider_command_journal WHERE prepared_financial_command_id=$1',
          [receipt.preparedCommandId]
        )
      ).rows[0].n
    ).toBe(0);
  });

  it('prepares and exactly replays through real API and attester logins with immutable provenance', async () => {
    const { input } = await claimedPreparation('auth-prep-success');
    const first = await preparationAuthority().prepare(
      input,
      await preparationAttestation(input.recordedBy)
    );
    const replay = await preparationAuthority().prepare(
      input,
      await preparationAttestation(input.recordedBy)
    );
    expect(replay).toEqual({ ...first, idempotencyReplayed: true });
    expect(first).toMatchObject({
      commandState: 'PREPARED',
      recordedBy: input.recordedBy,
      taskDraftId: input.taskDraftId,
      providerExpectedVersion: 0,
      eventKind: 'PAYMENT_METHOD_PREPARED',
    });
    const facts = await fixture.pool.query(
      'SELECT * FROM hx_authority.fake_financial_preparation_authority_v13 WHERE prepared_command_id=$1',
      [first.preparedCommandId]
    );
    expect(facts.rows).toHaveLength(1);
    expect(facts.rows[0]).toMatchObject({
      actor_user_id: input.recordedBy,
      release_manifest_sha256: 'sha256:' + 'b'.repeat(64),
    });
    await expect(
      fixture.pool.query(
        'UPDATE hx_authority.fake_financial_preparation_authority_v13 SET actor_user_id=actor_user_id WHERE prepared_command_id=$1',
        [first.preparedCommandId]
      )
    ).rejects.toThrow();
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.task_financial_security_events WHERE task_draft_id=$1',
          [input.taskDraftId]
        )
      ).rows[0].n
    ).toBe(0);
  });
  it('preserves exact authenticated unbound preparation replay after real estimate acceptance binds the draft', async () => {
    let input: PrepareUniversalV1FinancialCommandInput | undefined;
    let original:
      | Awaited<ReturnType<PostgresUniversalV1PreparedFinancialCommandAuthority['prepare']>>
      | undefined;
    const lane = await createAcceptedEstimateFixture(
      preparationDatabase(),
      fixture.pool,
      'auth-replay-bound',
      false,
      async (owner) => {
        input = preparationInput(owner);
        original = await preparationAuthority().prepare(
          input,
          await preparationAttestation(owner.posterUserId)
        );
      }
    );
    expect(
      (
        await fixture.pool.query('SELECT task_id FROM public.task_drafts WHERE id=$1', [
          lane.draftId,
        ])
      ).rows[0].task_id
    ).toBe(lane.taskId);
    const replay = await preparationAuthority().prepare(
      input!,
      await preparationAttestation(lane.posterUserId)
    );
    expect(replay).toEqual({ ...original, idempotencyReplayed: true });
    expect(replay.taskId).toBeNull();
  });
  it('rolls back assertion consumption and preparation when an authenticated different customer submits', async () => {
    const first = await claimedPreparation('auth-owner'),
      other = await claimedPreparation('auth-other');
    const handle = await preparationAttestation(other.input.recordedBy);
    const { recordedBy: _actor, ...payload } = first.input;
    const assertion = await handle.issue({
      commandKind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
      commandPayload: FakeFinancialPreparationPayloadSchema.parse(payload),
    });
    await expect(
      clients
        .get('apiRole')!
        .query(
          'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
          [assertion.actor_assertion_token, payload]
        )
    ).rejects.toThrow('CUSTOMER_AUTHORITY_REVOKED');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.universal_v1_prepared_financial_commands WHERE idempotency_key=$1',
          [first.input.idempotencyKey]
        )
      ).rows[0].n
    ).toBe(0);
    const count = await fixture.pool.query(
      "SELECT count(*)::int AS n FROM hx_authority.universal_v1_actor_assertion_consumption_facts c JOIN hx_authority.universal_v1_actor_assertion_issuance_facts i USING(assertion_id) WHERE i.token_sha256=encode(sha256(convert_to($1,'UTF8')),'hex')",
      [assertion.actor_assertion_token]
    );
    expect(count.rows[0].n).toBe(0);
  });
  it('binds all fields to the assertion and refuses token reuse after one committed preparation', async () => {
    const { input } = await claimedPreparation('auth-exact-assertion');
    const { recordedBy: _actor, ...payload } = input;
    const handle = await preparationAttestation(input.recordedBy);
    const assertion = await handle.issue({
      commandKind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
      commandPayload: FakeFinancialPreparationPayloadSchema.parse(payload),
    });
    const api = clients.get('apiRole')!;
    await expect(
      api.query(
        'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
        [assertion.actor_assertion_token, { ...payload, providerRequestSha256: 'f'.repeat(64) }]
      )
    ).rejects.toThrow();
    const first = await api.query(
      'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
      [assertion.actor_assertion_token, payload]
    );
    expect(first.rows[0].idempotency_replayed).toBe(false);
    await expect(
      api.query(
        'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
        [assertion.actor_assertion_token, payload]
      )
    ).rejects.toThrow();
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.universal_v1_prepared_financial_commands WHERE idempotency_key=$1',
          [input.idempotencyKey]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('refuses nonzero PREPARE provider version at the public canonical builder', async () => {
    const { input } = await claimedPreparation('auth-version');
    const { recordedBy: _actor, ...payload } = input;
    await expect(
      clients
        .get('apiRole')!
        .query(
          'SELECT * FROM public.hxos_build_fake_financial_preparation_actor_request_v13($1,$2)',
          ['PREPARE_FAKE_FINANCIAL_COMMAND', { ...payload, providerExpectedVersion: 1 }]
        )
    ).rejects.toThrow('BINDING_INVALID');
  });
  it('binds predecessor reads to the complete tuple and one-use command-kind assertion', async () => {
    const { owner } = await claimedPreparation('predecessor-assertion');
    const handle = await preparationAttestation(owner.posterUserId);
    const payload = {
      operationKind: 'PREPARE_PAYMENT_METHOD' as const,
      operationId: randomUUID(),
      taskDraftId: owner.draftId,
      idempotencyKey: 'predecessor:' + randomUUID(),
    };
    const assertion = await handle.issue({
      commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR',
      commandPayload: payload,
    });
    const read = (token: string, body: unknown) =>
      clients
        .get('apiRole')!
        .query(
          'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
          [token, body]
        );
    for (const change of [
      { operationId: randomUUID() },
      { operationKind: 'AUTHORIZE' },
      { taskDraftId: randomUUID() },
      { idempotencyKey: 'different:' + randomUUID() },
    ]) {
      await expect(
        read(assertion.actor_assertion_token, { ...payload, ...change })
      ).rejects.toThrow();
    }
    await expect(
      read(assertion.actor_assertion_token, { ...payload, actorId: owner.posterUserId })
    ).rejects.toThrow('PAYLOAD_INVALID');
    const wrongKind = await handle.issue({
      commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
      commandPayload: { commandId: randomUUID() },
    });
    await expect(read(wrongKind.actor_assertion_token, payload)).rejects.toThrow();
    const first = await read(assertion.actor_assertion_token, payload);
    expect(first.rows[0]).toMatchObject({
      financial_facts: null,
      actor_user_id: owner.posterUserId,
      actor_request_sha256: assertion.canonical_request_sha256,
    });
    await expect(read(assertion.actor_assertion_token, payload)).rejects.toThrow();
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM hx_authority.universal_v1_actor_assertion_consumption_facts c JOIN hx_authority.universal_v1_actor_assertion_issuance_facts i USING(assertion_id) WHERE i.token_sha256=encode(sha256(convert_to($1,'UTF8')),'hex')",
          [assertion.actor_assertion_token]
        )
      ).rows
    ).toEqual([{ n: 1 }]);
  });
  it('rechecks a revoked actor at the predecessor read port without consuming its assertion', async () => {
    const { owner } = await claimedPreparation('predecessor-revoked');
    const payload = {
      operationKind: 'PREPARE_PAYMENT_METHOD' as const,
      operationId: randomUUID(),
      taskDraftId: owner.draftId,
      idempotencyKey: 'predecessor:' + randomUUID(),
    };
    const assertion = await (
      await preparationAttestation(owner.posterUserId)
    ).issue({
      commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR',
      commandPayload: payload,
    });
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      owner.posterUserId,
    ]);
    await expect(
      clients
        .get('apiRole')!
        .query(
          'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
          [assertion.actor_assertion_token, payload]
        )
    ).rejects.toThrow();
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM hx_authority.universal_v1_actor_assertion_consumption_facts c JOIN hx_authority.universal_v1_actor_assertion_issuance_facts i USING(assertion_id) WHERE i.token_sha256=encode(sha256(convert_to($1,'UTF8')),'hex')",
          [assertion.actor_assertion_token]
        )
      ).rows
    ).toEqual([{ n: 0 }]);
  });
  it.each(['REPEATABLE READ', 'SERIALIZABLE'] as const)(
    'refuses a historical %s snapshot for a fresh predecessor read',
    async (isolation) => {
      const api = clients.get('apiRole')!;
      await api.query('BEGIN ISOLATION LEVEL ' + isolation);
      try {
        await expect(
          api.query(
            'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
            [
              'a'.repeat(64),
              {
                operationKind: 'AUTHORIZE',
                operationId: randomUUID(),
                taskDraftId: randomUUID(),
                idempotencyKey: 'predecessor:' + randomUUID(),
              },
            ]
          )
        ).rejects.toThrow('READ_COMMITTED_REQUIRED');
      } finally {
        await api.query('ROLLBACK');
      }
    }
  );
  it('limits the authenticated predecessor read to API and keeps its internal financial projection sealed', async () => {
    const payload = {
      operationKind: 'AUTHORIZE',
      operationId: randomUUID(),
      taskDraftId: randomUUID(),
      idempotencyKey: 'predecessor:' + randomUUID(),
    };
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = clients.get(key)!;
      await expect(
        client.query('SELECT hx_authority.read_fake_financial_predecessor_v13($1)', [payload])
      ).rejects.toThrow(/permission denied/u);
      for (const table of [
        'public.financial_provider_command_journal',
        'public.task_financial_security_events',
        'hx_authority.fake_financial_command_outbox_requests_v13',
      ]) {
        await expect(client.query('SELECT * FROM ' + table)).rejects.toThrow(/permission denied/u);
      }
      if (key !== 'apiRole') {
        await expect(
          client.query(
            'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
            ['a'.repeat(64), payload]
          )
        ).rejects.toThrow(/permission denied/u);
        await expect(
          client.query(
            'SELECT * FROM public.hxos_build_fake_financial_predecessor_actor_request_v13($1,$2)',
            ['READ_FAKE_FINANCIAL_PREDECESSOR', payload]
          )
        ).rejects.toThrow(/permission denied/u);
      }
    }
  });
  it('binds progress to the exact command and one-use assertion, including absent commands', async () => {
    const { owner, input } = await claimedPreparation('progress-assertion');
    const handle = await preparationAttestation(owner.posterUserId);
    const api = clients.get('apiRole')!;
    const payload = { commandId: randomUUID() };
    const assertion = await handle.issue({
      commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
      commandPayload: payload,
    });
    const read = (token: string, body: unknown) =>
      api.query('SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)', [
        token,
        body,
      ]);
    await expect(
      read(assertion.actor_assertion_token, { commandId: randomUUID() })
    ).rejects.toThrow();
    await expect(
      read(assertion.actor_assertion_token, { ...payload, actorId: owner.posterUserId })
    ).rejects.toThrow('PAYLOAD_INVALID');
    const first = await read(assertion.actor_assertion_token, payload);
    expect(first.rows[0]).toMatchObject({
      progress: null,
      actor_user_id: owner.posterUserId,
      actor_request_sha256: assertion.canonical_request_sha256,
    });
    await expect(read(assertion.actor_assertion_token, payload)).rejects.toThrow();
    const { recordedBy: _actor, ...intent } = input;
    const wrongKind = await handle.issue({
      commandKind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
      commandPayload: FakeFinancialPreparationPayloadSchema.parse(intent),
    });
    await expect(read(wrongKind.actor_assertion_token, payload)).rejects.toThrow();
  });
  it('rechecks a revoked actor when consuming a previously issued progress assertion', async () => {
    const { owner } = await claimedPreparation('progress-revoked');
    const handle = await preparationAttestation(owner.posterUserId);
    const payload = { commandId: randomUUID() };
    const assertion = await handle.issue({
      commandKind: 'READ_FAKE_FINANCIAL_REQUEST_PROGRESS',
      commandPayload: payload,
    });
    await fixture.pool.query('UPDATE public.users SET is_banned=TRUE WHERE id=$1', [
      owner.posterUserId,
    ]);
    await expect(
      clients
        .get('apiRole')!
        .query('SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)', [
          assertion.actor_assertion_token,
          payload,
        ])
    ).rejects.toThrow();
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS n FROM hx_authority.universal_v1_actor_assertion_consumption_facts c JOIN hx_authority.universal_v1_actor_assertion_issuance_facts i USING(assertion_id) WHERE i.token_sha256=encode(sha256(convert_to($1,'UTF8')),'hex')",
          [assertion.actor_assertion_token]
        )
      ).rows[0].n
    ).toBe(0);
  });
  it('limits authenticated progress to the API and keeps the internal projection sealed', async () => {
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = clients.get(key)!;
      await expect(
        client.query('SELECT hx_authority.read_fake_financial_public_progress_v13($1)', [
          randomUUID(),
        ])
      ).rejects.toThrow(/permission denied/u);
      if (key !== 'apiRole') {
        await expect(
          client.query(
            'SELECT * FROM public.hxos_read_authenticated_fake_financial_progress_v13($1,$2)',
            ['a'.repeat(64), { commandId: randomUUID() }]
          )
        ).rejects.toThrow(/permission denied/u);
        await expect(
          client.query(
            'SELECT * FROM public.hxos_build_fake_financial_progress_actor_request_v13($1,$2)',
            ['READ_FAKE_FINANCIAL_REQUEST_PROGRESS', { commandId: randomUUID() }]
          )
        ).rejects.toThrow(/permission denied/u);
      }
    }
  });
  it('denies raw preparation/provenance reads and the legacy actor-supplied insert port to runtime logins', async () => {
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = clients.get(key)!;
      for (const relation of [
        'public.universal_v1_prepared_financial_commands',
        'hx_authority.fake_financial_preparation_authority_v13',
      ]) {
        await expect(client.query('SELECT * FROM ' + relation)).rejects.toThrow(
          /permission denied/u
        );
        await expect(client.query('INSERT INTO ' + relation + ' DEFAULT VALUES')).rejects.toThrow(
          /permission denied/u
        );
      }
      expect(
        (
          await client.query(
            "SELECT has_function_privilege(current_user,'public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)','EXECUTE') AS allowed"
          )
        ).rows[0].allowed
      ).toBe(false);
    }
  });

  it('work order history reads the exact committed Phase A through the restricted API login', async () => {
    const api = preparationDatabase(clients.get('apiRole')!);
    const lane = await createPreparedWorkOrderFixture(
      preparationDatabase(),
      fixture.pool,
      api,
      clients.get('attesterRole')!,
      roles.attesterRole,
      'sha256:' + 'b'.repeat(64),
      'history-read'
    );
    const release = {
      manifestDigest: 'sha256:' + 'b'.repeat(64),
      releaseId: 'synthetic.history',
      revision: 'c'.repeat(40),
      environment: 'local' as const,
      authenticationStatus: 'VERIFIED' as const,
    };
    const reader = new PostgresUniversalV1WorkOrderHistoryReader(api, () => release);
    const payload = {
      conditional_hold_id: lane.hold.conditional_hold_id,
      expected_eligibility_version: lane.interest.eligibility_version,
      idempotency_key: lane.key,
    };
    const attestation = (actor: string) =>
      createSyntheticActorAttestation(
        fixture.pool,
        api,
        clients.get('attesterRole')!,
        roles.attesterRole,
        release.manifestDigest,
        actor
      );
    const history = await reader.read(
      payload,
      lane.lane.posterUserId,
      await attestation(lane.lane.posterUserId)
    );
    expect(history).toMatchObject({
      state: 'PREPARED',
      phase: {
        idempotencyKey: lane.key,
        requestSha256: lane.phase.requestSha256,
        context: {
          conditional_hold_id: lane.hold.conditional_hold_id,
          eligibility_decision_id: lane.phase.context.eligibility_decision_id,
          customer_total_cents: lane.phase.context.customer_total_cents,
        },
      },
      source: { releaseSha256: release.manifestDigest },
    });
    expect(Date.parse(history!.phase.occurredAt)).toBe(Date.parse(lane.phase.occurredAt));
    expect(Object.isFrozen(history!.phase.context)).toBe(true);
    await expect(
      reader.read(payload, lane.lane.providerUserId, await attestation(lane.lane.providerUserId))
    ).resolves.toBeNull();
    await expect(
      reader.read(
        { ...payload, idempotency_key: lane.key + ':missing' },
        lane.lane.posterUserId,
        await attestation(lane.lane.posterUserId)
      )
    ).resolves.toBeNull();
    await expect(
      reader.read(
        { ...payload, conditional_hold_id: randomUUID() },
        lane.lane.posterUserId,
        await attestation(lane.lane.posterUserId)
      )
    ).rejects.toThrow('WORK_ORDER_HISTORY_UNAVAILABLE');
    await expect(
      reader.read(
        { ...payload, expected_eligibility_version: payload.expected_eligibility_version + 1 },
        lane.lane.posterUserId,
        await attestation(lane.lane.posterUserId)
      )
    ).rejects.toThrow('WORK_ORDER_HISTORY_UNAVAILABLE');
    const sql = 'SELECT * FROM public.hxos_read_authenticated_work_order_history_v13($1,$2)';
    const token = await (
      await attestation(lane.lane.posterUserId)
    ).issue({ commandKind: 'READ_FAKE_WORK_ORDER_HISTORY', commandPayload: payload });
    await clients.get('apiRole')!.query(sql, [token.actor_assertion_token, payload]);
    await expect(
      clients.get('apiRole')!.query(sql, [token.actor_assertion_token, payload])
    ).rejects.toThrow();
    const substituted = await (
      await attestation(lane.lane.posterUserId)
    ).issue({ commandKind: 'READ_FAKE_WORK_ORDER_HISTORY', commandPayload: payload });
    await expect(
      clients
        .get('apiRole')!
        .query(sql, [
          substituted.actor_assertion_token,
          { ...payload, idempotency_key: lane.key + ':other' },
        ])
    ).rejects.toThrow();
    const snapshot = await (
      await attestation(lane.lane.posterUserId)
    ).issue({ commandKind: 'READ_FAKE_WORK_ORDER_HISTORY', commandPayload: payload });
    await clients.get('apiRole')!.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try {
      await expect(
        clients.get('apiRole')!.query(sql, [snapshot.actor_assertion_token, payload])
      ).rejects.toThrow('READ_COMMITTED_REQUIRED');
    } finally {
      await clients.get('apiRole')!.query('ROLLBACK');
    }
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      await expect(
        clients.get(key)!.query('SELECT * FROM public.task_work_order_command_requests')
      ).rejects.toThrow('permission denied');
    }
    for (const key of ['workerRole', 'attesterRole'] as const)
      await expect(
        clients.get(key)!.query(sql, [snapshot.actor_assertion_token, payload])
      ).rejects.toThrow('permission denied');
  });

  it.each(loginKeys)('certifies the exact full catalog through the real %s login', async (key) => {
    const client = clients.get(key)!;
    const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    };
    const report = await verifyWorkOrderCommandAuthority(
      createWorkOrderCommandAuthorityTransaction(async () => ({ query, release: () => undefined })),
      environment,
      key
    );
    expect(report.reasons).toEqual([]);
    expect(report).toMatchObject({
      status: 'READY',
      actorBindingProven: true,
      currentRole: roles[key],
      sessionRole: roles[key],
    });
  });
  it('limits durable discovery and restoration to the worker login without exposing table access', async () => {
    for (const key of ['apiRole', 'attesterRole'] as const) {
      const client = clients.get(key)!;
      await expect(
        client.query('SELECT * FROM public.hxos_scan_fake_financial_recovery_v13(NULL,1)')
      ).rejects.toThrow('permission denied');
      await expect(
        client.query('SELECT * FROM public.hxos_read_fake_financial_restoration_v13($1,$2,$3)', [
          randomUUID(),
          'missing',
          'a'.repeat(64),
        ])
      ).rejects.toThrow('permission denied');
    }
    expect(
      (
        await clients
          .get('workerRole')!
          .query('SELECT * FROM public.hxos_scan_fake_financial_recovery_v13(NULL,1)')
      ).rows.length
    ).toBeLessThanOrEqual(1);
  });
  it('keeps all runtime logins outside the v13 relations and NOLOGIN owners', async () => {
    for (const key of loginKeys) {
      const client = clients.get(key)!;
      for (const relation of FAKE_FINANCIAL_OUTBOX_RELATIONS) {
        await expect(client.query(`SELECT * FROM ${relation}`)).rejects.toThrow(
          /permission denied/u
        );
        await expect(client.query(`INSERT INTO ${relation} DEFAULT VALUES`)).rejects.toThrow(
          /permission denied/u
        );
      }
      for (const owner of [
        roles.commandOwnerRole,
        roles.assertionOwnerRole,
        roles.financeOwnerRole,
        roles.telemetryOwnerRole,
      ]) {
        await expect(client.query(`SET ROLE ${quote(owner)}`)).rejects.toThrow(
          /permission denied/u
        );
      }
    }
  });

  it.each(['apiRole', 'workerRole', 'attesterRole'] as const)(
    'verifies every production startup migration through the genuine %s login',
    async (key) => {
      const client = clients.get(key)!;
      const query: QueryFn = async <T>(sql: string, params?: unknown[]) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
      };
      const log = {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        warn: () => undefined,
      };
      await expect(
        runStartupMigrations(log, productionStartupMigrationRuntime(query))
      ).resolves.toBeUndefined();
      await expect(
        client.query('SELECT name, sha256 FROM public.applied_migrations')
      ).rejects.toThrow(/permission denied/u);
    }
  );

  it('reads exact metadata through real runtime logins while denying raw evidence access', async () => {
    const expected = await Promise.all(
      CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map(async (entry) => {
        const bytes = await readFile(
          new URL(`../../database/migrations/${entry.fileName}`, import.meta.url)
        );
        const digest = createHash('sha256').update(bytes).digest('hex');
        return { migration_name: entry.name, evidence_sha256: digest, applied_sha256: digest };
      })
    );
    expected.sort((left, right) => left.migration_name.localeCompare(right.migration_name));
    const ledger = await fixture.pool.query(
      'SELECT name AS migration_name,btrim(sha256) AS applied_sha256 FROM public.applied_migrations ORDER BY name'
    );
    for (const key of ['apiRole', 'workerRole', 'attesterRole'] as const) {
      const client = clients.get(key)!;
      expect(
        (await client.query('SELECT * FROM public.hxos_read_fake_financial_schema_evidence_v13()'))
          .rows
      ).toEqual(expected);
      expect(
        (
          await client.query(
            'SELECT * FROM public.hxos_read_fake_financial_applied_migrations_v13()'
          )
        ).rows
      ).toEqual(ledger.rows);
      expect(
        (
          await client.query(
            'SELECT * FROM public.hxos_read_fake_financial_bootstrap_completion_v13($1,$2)',
            [`sha256:${'b'.repeat(64)}`, `sha256:${'c'.repeat(64)}`]
          )
        ).rows
      ).toEqual([
        {
          release_id: 'synthetic-metadata-port',
          release_environment: 'local',
          required_migration_count: REQUIRED_MIGRATION_FILES.length,
          financial_migration_status: 'applied',
          completed_at: new Date('2026-09-04T00:00:00Z'),
        },
      ]);
      expect(
        (
          await client.query(
            'SELECT * FROM public.hxos_read_fake_financial_bootstrap_completion_v13($1,$2)',
            [`sha256:${'b'.repeat(64)}`, `sha256:${'d'.repeat(64)}`]
          )
        ).rows
      ).toEqual([]);
      for (const relation of [
        ...FAKE_FINANCIAL_BOOTSTRAP_METADATA_RELATIONS,
        'public.applied_migrations',
        'public.hxos_fake_financial_schema_evidence_v12',
        'public.hxos_work_order_bootstrap_seal_evidence_v1',
        'public.hxos_fake_financial_schema_evidence_v13',
      ]) {
        await expect(client.query(`SELECT * FROM ${relation}`)).rejects.toThrow(
          /permission denied/u
        );
        await expect(client.query(`INSERT INTO ${relation} DEFAULT VALUES`)).rejects.toThrow(
          /permission denied/u
        );
      }
      await expect(
        client.query('SELECT applied_at FROM public.applied_migrations')
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it('preserves missing, null and duplicate applied receipts in the metadata output', async () => {
    const admin = await fixture.pool.connect();
    const migrationName = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[0]!.name;
    try {
      await admin.query('BEGIN');
      await admin.query('DELETE FROM public.applied_migrations WHERE name=$1', [migrationName]);
      expect(
        (
          await admin.query(
            'SELECT * FROM public.hxos_read_fake_financial_schema_evidence_v13() WHERE migration_name=$1',
            [migrationName]
          )
        ).rows
      ).toEqual([
        {
          migration_name: migrationName,
          evidence_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          applied_sha256: null,
        },
      ]);
      await admin.query('INSERT INTO public.applied_migrations(name,sha256) VALUES ($1,NULL)', [
        migrationName,
      ]);
      expect(
        (
          await admin.query(
            'SELECT * FROM public.hxos_read_fake_financial_applied_migrations_v13() WHERE migration_name=$1',
            [migrationName]
          )
        ).rows
      ).toEqual([{ migration_name: migrationName, applied_sha256: null }]);
      await admin.query(
        'ALTER TABLE public.applied_migrations DROP CONSTRAINT applied_migrations_pkey'
      );
      await admin.query('INSERT INTO public.applied_migrations(name,sha256) VALUES ($1,$2)', [
        migrationName,
        'f'.repeat(64),
      ]);
      const evidence = await admin.query(
        'SELECT * FROM public.hxos_read_fake_financial_schema_evidence_v13() WHERE migration_name=$1',
        [migrationName]
      );
      expect(evidence.rows).toHaveLength(2);
      expect(evidence.rows.map((row) => row.applied_sha256)).toEqual(
        expect.arrayContaining([null, 'f'.repeat(64)])
      );
    } finally {
      await admin.query('ROLLBACK');
      admin.release();
    }
  });

  it.each(['api', 'attester'] as const)(
    'runs bounded multiquery attestation through the real %s data plane with a stable read-only snapshot',
    async (component) => {
      const url = new URL(fixture.databaseUrl);
      url.username = roles[`${component}Role`];
      url.password = password;
      url.searchParams.set('sslmode', 'disable');
      const observed = await fixture.pool.query(`SELECT host(inet_server_addr()) AS address,
      inet_server_port() AS port,current_database() AS database`);
      const expectedTarget = {
        environment: 'local' as const,
        databaseName: observed.rows[0]!.database as string,
        hostname: url.hostname,
        port: observed.rows[0]!.port as number,
        serverAddress: observed.rows[0]!.address as string,
        tlsMode: 'disable' as const,
        channelBinding: 'disabled' as const,
      };
      const target: RuntimeDatabaseTargetBinding = {
        ...expectedTarget,
        component,
        serviceLogin: roles[`${component}Role`],
        roleTopologyDigest: runtimeDatabaseRoleTopologyDigest(roles),
      };
      const adapter = createPgRuntimeDatabaseAuthorityAdapter({
        primaryDatabaseUrl: url.toString(),
        target,
        poolConfig: { max: 2 },
      });
      try {
        // Release signing is a separate gate. This synthetic proof isolates the genuine
        // production database-catalog, target, transport, and snapshot checks below.
        const capability = await attestRuntimeDatabaseAuthority(
          {
            component,
            primaryDatabaseUrl: url.toString(),
            replicaDatabaseUrl: null,
            expectedTarget,
            expectedTargetDigest: runtimeDatabaseTargetDigest(target),
            roleTopology: roles,
            releasePins: {
              manifestDigest: `sha256:${'b'.repeat(64)}`,
              signerKeyId: 'synthetic-only',
              signerKeyFingerprint: `sha256:${'d'.repeat(64)}`,
              revision: 'e'.repeat(40),
              artifactDigest: `sha256:${'f'.repeat(64)}`,
            },
          },
          adapter,
          {
            verifyReleaseAuthority: async (request) => {
              const build = {
                releaseManifestDigest: request.pins.manifestDigest,
                environment: request.environment,
                component: request.releaseComponent,
                revision: request.pins.revision,
                artifactDigest: request.pins.artifactDigest,
                databaseTargetDigest: request.databaseTargetDigest,
              };
              return {
                schemaVersion: 1,
                signatureAlgorithm: 'ed25519',
                canonicalManifestDigest: request.pins.manifestDigest,
                manifestDigest: request.pins.manifestDigest,
                signerKeyId: request.pins.signerKeyId,
                signerKeyFingerprint: request.pins.signerKeyFingerprint,
                environment: request.environment,
                component: request.releaseComponent,
                revision: request.pins.revision,
                artifactDigest: request.pins.artifactDigest,
                databaseTargetDigest: request.databaseTargetDigest,
                build: { ...build, identityDigest: runtimeDatabaseBuildProofDigest(build) },
              };
            },
          }
        );
        const plane = createRuntimeDatabaseDataPlane({
          primaryDatabaseUrl: url.toString(),
          target,
          adapter,
          capability,
        });
        await runStartupMigrations(
          {
            debug: () => undefined,
            error: () => undefined,
            info: () => undefined,
            warn: () => undefined,
          },
          productionStartupMigrationRuntime(async <T>(sql: string, params?: unknown[]) => {
            const result = await plane.readQuery(sql, params);
            return { rows: result.rows as T[], rowCount: result.rowCount };
          })
        );
        if (component === 'attester') {
          const issuer = new PostgresUniversalV1ActorAssertionIssuer({
            env: {
              ...environment,
              HX_ENVIRONMENT: 'local',
              SERVICE_ROLE: 'attester',
              HX_PAYMENT_CREATION_MODE: 'frozen',
              STRIPE_MODE: 'test',
              ENGINE_API_MODE: 'test',
              HX_EXTERNAL_VALUE: 'false',
            },
            query: async <Row>(sql: string, params?: readonly unknown[]) => {
              const result = await plane.query(sql, params);
              return { rows: result.rows as Row[], rowCount: result.rowCount };
            },
          });
          await expect(issuer.readiness()).resolves.toMatchObject({
            databaseRole: roles.attesterRole,
            databaseName: expectedTarget.databaseName,
          });
          const targetFact = await fixture.pool.query(
            'SELECT target_authority_id FROM hx_authority.universal_v1_work_order_target_authority_facts'
          );
          const clock = (await fixture.pool.query('SELECT clock_timestamp() AS now')).rows[0]!
            .now as Date;
          const verifiedAt = new Date(clock.getTime() - 1_000).toISOString();
          const canonicalRequest: UniversalV1CanonicalActorRequest = {
            schema_version: 1,
            command_kind: 'EXPRESS_POST_ESTIMATE_INTEREST',
            release_manifest_sha256: `sha256:${'b'.repeat(64)}`,
            target_authority: {
              id: targetFact.rows[0]!.target_authority_id as string,
              version: 1,
              database: expectedTarget.databaseName,
              environment: 'local',
              release: `sha256:${'b'.repeat(64)}`,
            },
            authentication_requirements: {
              mfa_required: false,
              step_up_required: false,
              max_auth_age_seconds: 300,
              max_step_up_age_seconds: null,
            },
            command_payload: {
              task_id: randomUUID(),
              expected_scope_version: 1,
              idempotency_key: `attester-plane-${randomUUID()}`,
              client_timestamp_epoch_ms: clock.getTime(),
            },
          };
          const digest = (
            await plane.readQuery<{ digest: string }>(
              "SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($1::jsonb::text,'UTF8')),'hex') AS digest",
              [canonicalRequest]
            )
          ).rows[0]!.digest;
          const issueRequest = {
            opaqueToken: createHash('sha256').update(randomUUID()).digest('hex'),
            environment: 'local' as const,
            commandKind: 'EXPRESS_POST_ESTIMATE_INTEREST' as const,
            canonicalRequest,
            canonicalRequestSha256: digest,
            authenticationFacts: {
              schema_version: 1 as const,
              verified_subject: `synthetic:${randomUUID()}`,
              issuer: 'https://synthetic.invalid/issuer',
              audience: 'synthetic-attester-test',
              release_manifest_sha256: `sha256:${'b'.repeat(64)}`,
              verified_at: verifiedAt,
              bearer_expires_at: new Date(clock.getTime() + 120_000).toISOString(),
              auth_time: verifiedAt,
              revocation_checked_at: verifiedAt,
              amr: ['password'],
              mfa_verified: false,
              step_up: { satisfied: false, method: null, verified_at: null },
            },
            requestedExpiresAt: new Date(clock.getTime() + 55_000),
          };
          const assertion = await issuer.issue(issueRequest);
          expect(assertion.canonicalRequestSha256).toBe(digest);
          expect(assertion.expiresAt.getTime()).toBeLessThanOrEqual(
            issueRequest.requestedExpiresAt.getTime()
          );
          expect(
            (
              await fixture.pool.query(
                'SELECT canonical_request_sha256,release_manifest_sha256,verified_subject FROM hx_authority.universal_v1_actor_assertion_issuance_facts WHERE assertion_id=$1',
                [assertion.assertionId]
              )
            ).rows
          ).toEqual([
            {
              canonical_request_sha256: digest,
              release_manifest_sha256: `sha256:${'b'.repeat(64)}`,
              verified_subject: issueRequest.authenticationFacts.verified_subject,
            },
          ]);
          await expect(issuer.issue(issueRequest)).rejects.toThrow(
            'HXUV1-ACTOR-14: assertion token digest already exists'
          );
          await expect(
            plane.query('SELECT * FROM hx_authority.universal_v1_actor_assertion_issuance_facts')
          ).rejects.toThrow(/permission denied/u);
          await issuer.close();
          // Issuer shutdown must not close the process-owned data plane.
          await expect(plane.query('SELECT 1 AS value')).resolves.toMatchObject({
            rows: [{ value: 1 }],
          });
        }
        await fixture.pool
          .query(`CREATE TABLE public.hx_ci_attestation_snapshot_probe(value integer);
        INSERT INTO public.hx_ci_attestation_snapshot_probe VALUES (1);
        GRANT SELECT, INSERT ON public.hx_ci_attestation_snapshot_probe TO ${quote(roles[`${component}Role`])}`);
        await plane.readOnlyAttestationTransaction(async (query) => {
          const metadataBefore = await query(
            'SELECT * FROM public.hxos_read_fake_financial_applied_migrations_v13()'
          );
          const schema = await query(
            'SELECT * FROM public.hxos_read_fake_financial_schema_evidence_v13()'
          );
          expect(schema.rows).toHaveLength(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.length);
          const first =
            await query(`SELECT pg_backend_pid() AS pid,pg_current_snapshot()::text AS snapshot,
          current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
          current_setting('search_path') AS path,current_setting('statement_timeout') AS statement_timeout,
          current_setting('lock_timeout') AS lock_timeout,
          (SELECT count(*)::integer FROM public.hx_ci_attestation_snapshot_probe) AS count`);
          expect(first.rows[0]).toMatchObject({
            isolation: 'repeatable read',
            read_only: 'on',
            path: 'pg_catalog',
            statement_timeout: '1s',
            lock_timeout: '250ms',
            count: 1,
          });
          await fixture.pool.query(
            'INSERT INTO public.hx_ci_attestation_snapshot_probe VALUES (2)'
          );
          await fixture.pool.query(
            "INSERT INTO public.applied_migrations(name,sha256) VALUES ('hx_ci_metadata_snapshot_probe',$1)",
            ['f'.repeat(64)]
          );
          expect(
            (await query('SELECT * FROM public.hxos_read_fake_financial_applied_migrations_v13()'))
              .rows
          ).toEqual(metadataBefore.rows);
          const second =
            await query(`SELECT pg_backend_pid() AS pid,pg_current_snapshot()::text AS snapshot,
          (SELECT count(*)::integer FROM public.hx_ci_attestation_snapshot_probe) AS count`);
          expect(second.rows[0]).toEqual({
            pid: first.rows[0]!.pid,
            snapshot: first.rows[0]!.snapshot,
            count: 1,
          });
        });
        await expect(
          plane.readOnlyAttestationTransaction(async (query) =>
            query('INSERT INTO public.hx_ci_attestation_snapshot_probe VALUES (3)')
          )
        ).rejects.toThrow(/read-only transaction/u);
        await expect(
          plane.readOnlyAttestationTransaction(async (query) => query('COMMIT'))
        ).rejects.toMatchObject({ code: 'APPLICATION_SQL_TRANSACTION_CONTROL_FORBIDDEN' });
        expect(
          (
            await fixture.pool.query(
              'SELECT count(*)::integer AS count FROM public.hx_ci_attestation_snapshot_probe'
            )
          ).rows
        ).toEqual([{ count: 2 }]);
      } finally {
        try {
          await adapter.close();
        } finally {
          await fixture.pool.query('DROP TABLE IF EXISTS public.hx_ci_attestation_snapshot_probe');
          await fixture.pool.query(
            "DELETE FROM public.applied_migrations WHERE name='hx_ci_metadata_snapshot_probe'"
          );
        }
      }
    },
    30_000
  );
  it('preserves committed predecessor source identity under fresh read authority after target rollover', async () => {
    // Last case: the isolated fixture advances its append-only target authority.
    // Earlier cases intentionally certify the original complete startup catalog.
    const f = await resolvedAuthorizationFixture(true, true);
    const resolved = (await f.worker.query(f.outcomeSql, f.reconcileArgs)).rows[0];
    await f.worker.query(f.materializeSql, [
      f.admission.job_validation_id,
      resolved.outcome_fact.outcome_fact_id,
    ]);
    // First let the existing rollover fixture lease older queued-only requests.
    const completedReversal = await completedWorkerReversalFixture();
    const declinedAdjustment = await adjustmentWitnessFixture();
    const declineRequest = await declinedAdjustment.requestAdjustment('DECLINE');
    const declineBinding = await declinedAdjustment.admit(declineRequest.commandId);
    await declinedAdjustment.executeBinding(declineBinding);
    const declineOutcome = (
      await f.worker.query(
        'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
        [
          declineBinding.admission.job_validation_id,
          declineBinding.workerId,
          declineBinding.admission.recovery_lease_id,
        ]
      )
    ).rows[0];
    const declineLease = await recoveryObservationLease(declinedAdjustment);
    const unpreparedReversal = await workerReversalFixture(),
      preparedReversal = await workerReversalFixture();
    const beforeReversal = await preparedReversal.prepare();
    const before = await f.readPredecessor();
    expect(before?.predecessor).not.toBeNull();
    const fact = before!.predecessor!;
    const payload = {
      operationKind: 'AUTHORIZE' as const,
      operationId: fact.operationId,
      taskDraftId: fact.taskDraftId,
      idempotencyKey: fact.idempotencyKey,
    };
    const stale = await (
      await preparationAttestation(f.ownerActorId)
    ).issue({
      commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR',
      commandPayload: payload,
    });
    const newRelease = 'sha256:' + '8'.repeat(64);
    const next = (
      await fixture.pool.query(
        'INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts (' +
          'authority_version,target_database_name,environment,release_manifest_sha256,' +
          'activation_request_sha256,supersedes_target_authority_id) ' +
          'SELECT authority_version+1,current_database(),environment,$2,$3,target_authority_id ' +
          'FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE target_authority_id=$1 ' +
          'RETURNING target_authority_id',
        [
          fact.sourceTargetAuthorityId,
          newRelease,
          createHash('sha256').update(randomUUID()).digest('hex'),
        ]
      )
    ).rows[0];
    const compensated = (
      await recordChangeOrderTerminal(
        'compensated',
        {
          ...completedReversal.lease,
          target_authority_id: next.target_authority_id,
          release_manifest_digest: newRelease,
        },
        [completedReversal.winner.compensation_command_id, completedReversal.reversalEvent.id]
      )
    ).rows[0];
    expect(compensated).toMatchObject({
      target_authority_id: next.target_authority_id,
      release_manifest_digest: newRelease,
      terminal_fact: {
        compensation_command_id: completedReversal.winner.compensation_command_id,
        compensation_event_id: completedReversal.reversalEvent.id,
        resolution_evidence_kind: 'REVERSAL',
        prior_secured_state_restored: false,
        capture_resume_authorized: false,
      },
    });
    // A committed compensation origin survives target succession. A PREPARED record cannot retarget.
    const freshReversalArgs = [...unpreparedReversal.prepareArgs];
    freshReversalArgs[0] = next.target_authority_id;
    freshReversalArgs[3] = newRelease;
    const successorPrepared = await unpreparedReversal.prepare(f.worker, freshReversalArgs);
    expect(successorPrepared.worker_provenance).toMatchObject({
      target_authority_id: next.target_authority_id,
      release_manifest_sha256: newRelease,
    });
    await expect(preparedReversal.prepare()).rejects.toThrow();
    const retargetedArgs = [...preparedReversal.prepareArgs];
    retargetedArgs[0] = next.target_authority_id;
    retargetedArgs[3] = newRelease;
    await expect(preparedReversal.prepare(f.worker, retargetedArgs)).rejects.toThrow(
      'PREPARATION_IDENTITY_INVALID'
    );
    await expect(preparedReversal.requested(beforeReversal.prepared_command)).rejects.toThrow();
    expect(await preparedReversal.counts()).toEqual({
      preparations: 1,
      origins: 1,
      requests: 0,
      events: 0,
    });
    const api = clients.get('apiRole')!;
    await expect(
      api.query(
        'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
        [stale.actor_assertion_token, payload]
      )
    ).rejects.toThrow();
    const handle = await createSyntheticActorAttestation(
      fixture.pool,
      preparationDatabase(api),
      clients.get('attesterRole')!,
      roles.attesterRole,
      newRelease,
      f.ownerActorId
    );
    const fresh = await handle.issue({
      commandKind: 'READ_FAKE_FINANCIAL_PREDECESSOR',
      commandPayload: payload,
    });
    const read = (
      await api.query(
        'SELECT * FROM public.hxos_read_authenticated_fake_financial_predecessor_v13($1,$2)',
        [fresh.actor_assertion_token, payload]
      )
    ).rows[0];
    const expectedFacts = {
      ...before!,
      progress: { ...before!.progress, observedAt: expect.any(String) },
    };
    expect(read.financial_facts.predecessor).toEqual(fact);
    expect(Date.parse(read.financial_facts.progress.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(before!.progress.observedAt)
    );
    expect(read).toMatchObject({
      financial_facts: expectedFacts,
      actor_user_id: f.ownerActorId,
      target_authority_id: next.target_authority_id,
      reader_release_sha256: newRelease,
      actor_request_sha256: fresh.canonical_request_sha256,
    });
    expect(read.financial_facts.predecessor.sourceTargetAuthorityId).not.toBe(
      next.target_authority_id
    );
    expect(read.financial_facts.predecessor.sourceReleaseSha256).toBe(f.release.manifestDigest);
    const reader = new PostgresUniversalV1FinancialPredecessorReader(preparationDatabase(api));
    await expect(
      reader.read(payload, f.ownerActorId, handle, { ...f.release, manifestDigest: newRelease })
    ).resolves.toEqual(expectedFacts);
    await expect(reader.read(payload, f.ownerActorId, handle, f.release)).rejects.toThrow(
      'RECEIPT_BINDING_MISMATCH'
    );
    // Historical admitted outcomes cannot authorize a different environment.
    const previewRelease = 'sha256:' + '9'.repeat(64);
    const preview = (
      await fixture.pool.query(
        `INSERT INTO hx_authority.universal_v1_work_order_target_authority_facts
        (authority_version,target_database_name,environment,release_manifest_sha256,activation_request_sha256,supersedes_target_authority_id)
       SELECT authority_version+1,current_database(),'preview',$2,$3,target_authority_id
         FROM hx_authority.universal_v1_work_order_target_authority_facts WHERE target_authority_id=$1
       RETURNING target_authority_id`,
        [
          next.target_authority_id,
          previewRelease,
          createHash('sha256').update(randomUUID()).digest('hex'),
        ]
      )
    ).rows[0];
    await expect(
      recordChangeOrderTerminal(
        'no_effect',
        declineLease,
        [declineOutcome.outcome_fact.outcome_fact_id, null],
        f.worker,
        [
          preview.target_authority_id,
          new URL(fixture.databaseUrl).pathname.slice(1),
          'preview',
          previewRelease,
          declineLease.proposal_id,
          declineLease.recovery_lease_id,
          declineLease.lease_owner_id,
          declineLease.witness_request_sha256,
          declineLease.work_order_id,
          declineOutcome.outcome_fact.outcome_fact_id,
          null,
        ]
      )
    ).rejects.toThrow('HISTORICAL_TARGET_MISMATCH');
    expect(
      (
        await fixture.pool.query(
          'SELECT count(*)::int AS n FROM public.universal_v1_change_order_recovery_terminal_facts WHERE proposal_id=$1',
          [declineLease.proposal_id]
        )
      ).rows[0].n
    ).toBe(0);
  }, 60_000);
});
