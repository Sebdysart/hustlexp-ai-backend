import { createHash, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import {
  PostgresProviderEventInboxRepository,
  type RecordProviderEventInput,
} from '../../src/services/payment/ProviderEventInbox.js';

const describePg = describe.sequential.skipIf(!hasDb);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function eventInput(overrides: Partial<RecordProviderEventInput> = {}): RecordProviderEventInput {
  const providerEventReference = `evt_${randomUUID()}`;
  const rawPayload = Buffer.from(JSON.stringify({
    id: providerEventReference,
    type: 'financial_security.authorized',
  }));
  return {
    providerKind: 'FAKE',
    providerEventReference,
    providerEventKind: 'financial_security.authorized',
    operationId: randomUUID(),
    ingressIdempotencyKey: `provider-event:${randomUUID()}`,
    rawPayload,
    authentication: {
      status: 'VERIFIED',
      scheme: 'HMAC_SHA256',
      evidenceSha256: sha256(`signature:${providerEventReference}`),
      verifiedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

describePg('provider-event inbox PostgreSQL authority', () => {
  const repository = new PostgresProviderEventInboxRepository(db);

  it('keeps one observation when the same authenticated event arrives under another idempotency key', async () => {
    const firstInput = eventInput();
    const first = await repository.recordAuthenticatedEvent(firstInput);
    const replayInput: RecordProviderEventInput = {
      ...firstInput,
      ingressIdempotencyKey: `provider-event:${randomUUID()}`,
      authentication: {
        ...firstInput.authentication,
        evidenceSha256: sha256(`second-valid-signature:${firstInput.providerEventReference}`),
      },
    };
    const replay = await repository.recordAuthenticatedEvent(replayInput);
    const exactReplay = await repository.recordAuthenticatedEvent(replayInput);

    expect(first).toMatchObject({ observationReplayed: false, idempotencyReplayed: false });
    expect(replay).toMatchObject({
      observationId: first.observationId,
      observationReplayed: true,
      idempotencyReplayed: false,
    });
    expect(exactReplay).toMatchObject({
      observationId: first.observationId,
      receiptId: replay.receiptId,
      observationReplayed: true,
      idempotencyReplayed: true,
    });

    const counts = await db.query<{ observations: number; receipts: number }>(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM public.provider_event_inbox_observations
           WHERE provider_kind=$1 AND provider_event_reference=$2) AS observations,
         (SELECT COUNT(*)::integer
            FROM public.provider_event_inbox_receipts receipt
            JOIN public.provider_event_inbox_observations observation
              ON observation.observation_id=receipt.observation_id
           WHERE observation.provider_kind=$1
             AND observation.provider_event_reference=$2) AS receipts`,
      [firstInput.providerKind, firstInput.providerEventReference],
    );
    expect(counts.rows[0]).toEqual({ observations: 1, receipts: 2 });
  });

  it('replays one ingress receipt when redelivery verification happens later', async () => {
    const original = eventInput({
      authentication: {
        status: 'VERIFIED',
        scheme: 'HMAC_SHA256',
        evidenceSha256: sha256('same-signed-delivery'),
        verifiedAt: new Date(Date.now() - 2_000).toISOString(),
      },
    });
    const first = await repository.recordAuthenticatedEvent(original);
    const replay = await repository.recordAuthenticatedEvent({
      ...original,
      authentication: {
        ...original.authentication,
        verifiedAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });

    expect(replay).toMatchObject({
      observationId: first.observationId,
      receiptId: first.receiptId,
      authenticatedAt: first.authenticatedAt,
      observationReplayed: true,
      idempotencyReplayed: true,
    });
    const count = await db.query<{ receipts: number }>(
      `SELECT COUNT(*)::integer AS receipts
         FROM public.provider_event_inbox_receipts
        WHERE ingress_idempotency_key=$1`,
      [original.ingressIdempotencyKey],
    );
    expect(count.rows[0]?.receipts).toBe(1);
  });

  it('serializes concurrent deliveries without duplicating their provider observation', async () => {
    const base = eventInput();
    const deliveries = Array.from({ length: 6 }, () => ({
      ...base,
      ingressIdempotencyKey: `provider-event:${randomUUID()}`,
    }));
    const results = await Promise.all(
      deliveries.map((delivery) => repository.recordAuthenticatedEvent(delivery)),
    );
    expect(new Set(results.map(({ observationId }) => observationId)).size).toBe(1);
    expect(results.filter(({ observationReplayed }) => !observationReplayed)).toHaveLength(1);

    const counts = await db.query<{ observations: number; receipts: number }>(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM public.provider_event_inbox_observations
           WHERE provider_kind=$1 AND provider_event_reference=$2) AS observations,
         (SELECT COUNT(*)::integer
            FROM public.provider_event_inbox_receipts receipt
            JOIN public.provider_event_inbox_observations observation
              ON observation.observation_id=receipt.observation_id
           WHERE observation.provider_kind=$1
             AND observation.provider_event_reference=$2) AS receipts`,
      [base.providerKind, base.providerEventReference],
    );
    expect(counts.rows[0]).toEqual({ observations: 1, receipts: deliveries.length });
  });

  it('rejects conflicting event evidence and reuse of an ingress idempotency key', async () => {
    const original = eventInput();
    const recorded = await repository.recordAuthenticatedEvent(original);

    await expect(repository.recordAuthenticatedEvent({
      ...original,
      ingressIdempotencyKey: `provider-event:${randomUUID()}`,
      rawPayload: Buffer.from('{"different":true}'),
    })).rejects.toThrow('PROVIDER_EVENT_INBOX_EVENT_CONFLICT');
    await expect(repository.recordAuthenticatedEvent(eventInput({
      ingressIdempotencyKey: original.ingressIdempotencyKey,
    }))).rejects.toThrow('PROVIDER_EVENT_INBOX_IDEMPOTENCY_CONFLICT');

    await expect(db.query(
      `UPDATE public.provider_event_inbox_observations
          SET provider_event_kind='mutated'
        WHERE observation_id=$1`,
      [recorded.observationId],
    )).rejects.toThrow(/append-only/iu);
    await expect(db.query(
      `DELETE FROM public.provider_event_inbox_receipts WHERE receipt_id=$1`,
      [recorded.receiptId],
    )).rejects.toThrow(/append-only/iu);
    await expect(db.query(
      'TRUNCATE TABLE public.provider_event_inbox_receipts',
    )).rejects.toThrow(/append-only/iu);
  });

  it('rejects a raw payload whose claimed digest does not match its exact bytes', async () => {
    await expect(db.query(
      `INSERT INTO public.provider_event_inbox_observations (
         provider_kind, provider_event_reference, provider_event_kind,
         operation_id, raw_payload, raw_payload_sha256, raw_payload_bytes
       ) VALUES ('FAKE',$1,'test.event',$2,$3,$4,$5)`,
      [
        `evt_${randomUUID()}`,
        randomUUID(),
        Buffer.from('{"tampered":true}'),
        '0'.repeat(64),
        Buffer.byteLength('{"tampered":true}'),
      ],
    )).rejects.toMatchObject({ code: '23514' });
  });

  it('requires explicit verified authentication evidence for every delivery receipt', async () => {
    const recorded = await repository.recordAuthenticatedEvent(eventInput());
    const values = [
      recorded.observationId,
      `provider-event:${randomUUID()}`,
      sha256('direct-receipt-request'),
      'HMAC_SHA256',
      sha256('direct-receipt-evidence'),
      new Date().toISOString(),
    ];
    await expect(db.query(
      `INSERT INTO public.provider_event_inbox_receipts (
         observation_id, ingress_idempotency_key, request_sha256,
         authentication_scheme, authentication_evidence_sha256, authenticated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz)`,
      values,
    )).rejects.toMatchObject({ code: '23502' });
    await expect(db.query(
      `INSERT INTO public.provider_event_inbox_receipts (
         observation_id, ingress_idempotency_key, request_sha256,
         authentication_status, authentication_scheme,
         authentication_evidence_sha256, authenticated_at
       ) VALUES ($1,$2,$3,'UNVERIFIED',$4,$5,$6::timestamptz)`,
      values,
    )).rejects.toMatchObject({ code: '23514' });
  });
});
