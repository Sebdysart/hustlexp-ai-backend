import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  fakeFinancialWebhookAuthenticationEvidence,
  fakeFinancialWebhookSignedBytes,
  fakeFinancialWebhookTargetSchema,
} from '../../src/services/payment/FakeFinancialWebhookAuthentication.js';
import {
  createFinancialReadinessDatabase,
  type FinancialReadinessDatabase,
} from '../helpers/universal-v1-financial-readiness-database.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe
  .skipIf(!process.env.DATABASE_URL)
  .sequential('current sealed provider-observation authority', () => {
    let context: FinancialReadinessDatabase;
    beforeAll(async () => {
      context = await createFinancialReadinessDatabase();
    }, 120_000);
    afterAll(async () => {
      await context?.close();
    }, 30_000);

    async function webhook() {
      const targets = await context.fixture.pool.query(`SELECT *
      FROM hx_authority.universal_v1_work_order_target_authority_facts t
      WHERE NOT EXISTS (SELECT 1 FROM hx_authority.universal_v1_work_order_target_authority_facts s
        WHERE s.supersedes_target_authority_id=t.target_authority_id)`);
      expect(targets.rows).toHaveLength(1);
      const target = targets.rows[0];
      const keyId = randomUUID();
      const key = randomBytes(32);
      const binding = fakeFinancialWebhookTargetSchema.parse({
        keyId,
        targetAuthorityId: target.target_authority_id,
        targetAuthorityVersion: target.authority_version,
        targetDatabaseName: target.target_database_name,
        environment: target.environment,
        releaseManifestSha256: target.release_manifest_sha256,
      });
      // This key is synthetic and held only in this disposable test. Provisioning
      // and ingress use distinct actual LOGIN roles; no caller supplies VERIFIED.
      await context.clients.get('migrationRole')!.query(
        `INSERT INTO hx_authority.fake_financial_webhook_keys_v13
        (key_id,target_authority_id,key_material,expires_at)
       VALUES($1,$2,$3,clock_timestamp()+INTERVAL '1 hour')`,
        [keyId, binding.targetAuthorityId, key]
      );
      const payload = {
        version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
        kind: 'FINANCIAL_OPERATION_OBSERVED',
        providerKind: 'FAKE',
        providerEventReference: 'current-observation:' + randomUUID(),
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
      const body = Buffer.from(JSON.stringify(payload));
      const sign = (raw = body) =>
        createHmac('sha256', key)
          .update(fakeFinancialWebhookSignedBytes(binding, raw))
          .digest('hex');
      const send = async (raw = body, signature = sign(raw), ingressKey: string | null = null) => {
        const result = await context.clients.get('apiRole')!.query<{
          receipt: Record<string, unknown> & { observationId: string; receiptId: string };
        }>('SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4) AS receipt', [keyId, raw, signature, ingressKey]);
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!.receipt;
      };
      return { keyId, binding, payload, body, sign, send };
    }

    async function expectNoFinancialOrNormalizationEffects() {
      const result = await context.fixture.pool.query(`SELECT
      (SELECT count(*)::int FROM public.task_financial_operations) AS lifecycle_operations,
      (SELECT count(*)::int FROM public.task_financial_security_events) AS lifecycle_events,
      (SELECT count(*)::int FROM public.hxos_fake_financial_operations_v1) AS fake_operations,
      (SELECT count(*)::int FROM public.hxos_fake_financial_operation_events_v1) AS fake_events,
      (SELECT count(*)::int FROM public.financial_provider_command_outcome_facts) AS outcomes,
      (SELECT count(*)::int FROM public.provider_financial_observation_normalizations) AS normalizations`);
      expect(result.rows).toEqual([
        {
          lifecycle_operations: 0,
          lifecycle_events: 0,
          fake_operations: 0,
          fake_events: 0,
          outcomes: 0,
          normalizations: 0,
        },
      ]);
    }

    it('preserves exact signed bytes and replay identity without fabricating unbound lifecycle success', async () => {
      const hook = await webhook();
      const receipt = await hook.send();
      expect(receipt).toMatchObject({
        providerKind: 'FAKE',
        operationId: hook.payload.operationId,
        keyId: hook.keyId,
        environment: 'local',
        rawPayloadSha256: hash(hook.body),
        authenticationScheme: 'HMAC_SHA256_TARGET_V13',
        observationReplayed: false,
        idempotencyReplayed: false,
      });
      expect(await hook.send()).toEqual({
        ...receipt,
        observationReplayed: true,
        idempotencyReplayed: true,
      });
      const delivery = await hook.send(hook.body, hook.sign(), 'delivery:' + randomUUID());
      expect(delivery.observationId).toBe(receipt.observationId);
      expect(delivery.receiptId).not.toBe(receipt.receiptId);
      const evidence = await context.fixture.pool.query(
        `SELECT encode(o.raw_payload,'hex') AS bytes,
      p.processing_state, count(v.receipt_id)::int AS verifications
      FROM public.provider_event_inbox_observations o
      JOIN public.provider_event_processing_state p USING(observation_id)
      JOIN hx_authority.fake_financial_webhook_verifications_v13 v USING(observation_id)
      WHERE o.observation_id=$1 GROUP BY o.raw_payload,p.processing_state`,
        [receipt.observationId]
      );
      expect(evidence.rows).toEqual([
        { bytes: hook.body.toString('hex'), processing_state: 'PENDING', verifications: 2 },
      ]);
      const changed = Buffer.from(
        JSON.stringify({ ...hook.payload, externalReference: 'altered' })
      );
      await expect(hook.send(changed, hook.sign())).rejects.toThrow(/SIGNATURE_INVALID/u);
      await expect(
        context.clients
          .get('workerRole')!
          .query('SELECT public.normalize_financial_provider_observation_v1($1)', [
            receipt.observationId,
          ])
      ).rejects.toMatchObject({ code: '42501' });
      await expectNoFinancialOrNormalizationEffects();
    });

    it('does not upgrade a caller-VERIFIED historical receipt into independent verification', async () => {
      const hook = await webhook();
      const ingressKey = 'legacy-observation:' + randomUUID();
      const observationId = randomUUID();
      const receiptId = randomUUID();
      const authenticationHash = fakeFinancialWebhookAuthenticationEvidence(
        fakeFinancialWebhookSignedBytes(hook.binding, hook.body),
        hook.sign()
      );
      // Only the fixture owner may represent a pre-existing historical receipt.
      const owner = await context.fixture.pool.connect();
      try {
        await owner.query('BEGIN');
        await owner.query(
          `INSERT INTO public.provider_event_inbox_observations
        (observation_id,provider_kind,provider_event_reference,provider_event_kind,operation_id,
         raw_payload,raw_payload_sha256,raw_payload_bytes)
        VALUES($1,'FAKE',$2,'FINANCIAL_OPERATION_OBSERVED',$3,$4,$5,$6)`,
          [
            observationId,
            hook.payload.providerEventReference,
            hook.payload.operationId,
            hook.body,
            hash(hook.body),
            hook.body.length,
          ]
        );
        await owner.query(
          `INSERT INTO public.provider_event_inbox_receipts
        (receipt_id,observation_id,ingress_idempotency_key,request_sha256,authentication_status,
         authentication_scheme,authentication_evidence_sha256,authenticated_at)
        VALUES($1,$2,$3,hx_authority.fake_financial_job_digest_v13($4::TEXT[]),
          'VERIFIED','HMAC_SHA256_TARGET_V13',$5,clock_timestamp())`,
          [
            receiptId,
            observationId,
            ingressKey,
            [
              'HX_FAKE_WEBHOOK_RECEIPT_V13',
              hook.keyId,
              hook.binding.targetAuthorityId,
              ingressKey,
              hash(hook.body),
              authenticationHash,
            ],
            authenticationHash,
          ]
        );
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      } finally {
        owner.release();
      }
      await expect(hook.send(hook.body, hook.sign(), ingressKey)).rejects.toThrow(
        'IDEMPOTENCY_CONFLICT'
      );
      await expect(
        context.fixture.pool.query(
          'SELECT count(*)::int AS count FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE observation_id=$1',
          [observationId]
        )
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
      const fresh = await hook.send(hook.body, hook.sign(), 'fresh-observation:' + randomUUID());
      expect(fresh).toMatchObject({
        observationId,
        observationReplayed: true,
        idempotencyReplayed: false,
      });
      expect(fresh.receiptId).not.toBe(receiptId);
      await expect(
        context.fixture.pool.query(
          'SELECT receipt_id FROM hx_authority.fake_financial_webhook_verifications_v13 WHERE observation_id=$1',
          [observationId]
        )
      ).resolves.toMatchObject({ rows: [{ receipt_id: fresh.receiptId }] });
      await expect(hook.send(hook.body, hook.sign(), ingressKey)).rejects.toThrow(
        'IDEMPOTENCY_CONFLICT'
      );
      await expectNoFinancialOrNormalizationEffects();
    });
  });
