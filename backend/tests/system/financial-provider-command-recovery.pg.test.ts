import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { db, hasDb } from '../../src/db.js';
import { financialProviderOutcomeProjectionSha256 } from '../../src/jobs/financial-provider-command-recovery-worker.js';
import {
  PostgresFinancialProviderCommandJournal,
  type FinancialProviderCommandReceipt,
  type RecordFinancialProviderCommandInput,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  FinancialProviderCommandRecoveryError,
  PostgresFinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import type {
  FinancialOperationResult,
  FinancialOperationState,
} from '../../src/services/payment/FinancialProviderPorts.js';

const describePg = describe.sequential.skipIf(!hasDb);
const preparedCommandMigration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260918_universal_v1_prepared_financial_command_v1.sql'
  ),
  'utf8'
);
const migration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260920_financial_provider_command_recovery_v1.sql'
  ),
  'utf8'
);

function command(
  overrides: Partial<RecordFinancialProviderCommandInput<Record<string, unknown>>> = {}
): RecordFinancialProviderCommandInput<Record<string, unknown>> {
  const operationId = randomUUID();
  return {
    // RECONCILE is provider-neutral but intentionally outside the lifecycle
    // preparation trigger; this isolates recovery-state authority from the
    // separate prepared-command fixture cohort owned by migration 20260918.
    operationKind: 'RECONCILE',
    operationId,
    providerKind: 'FAKE',
    idempotencyKey: `finance-recovery:${randomUUID()}`,
    providerExpectedVersion: 0,
    exactRequest: {
      operationId,
      expectedVersion: 0,
      amountCents: 4_200,
      currency: 'usd',
      paymentMethodReference: `pm_secret_${randomUUID()}`,
    },
    evidence: {
      taskDraftId: randomUUID(),
      taskId: randomUUID(),
      amountCents: 4_200,
      currency: 'usd',
    },
    ...overrides,
  };
}

function observedProjection(
  commandReceipt: FinancialProviderCommandReceipt,
  state: FinancialOperationState,
  retryable: boolean,
  options: {
    amountCents?: number | null;
    currency?: string | null;
    version?: number;
    externalReference?: string;
  } = {}
): Pick<
  FinancialOperationResult,
  'amountCents' | 'currency'
> & {
  providerResultSha256: string;
  externalReferenceSha256: string;
} {
  const externalReference = options.externalReference ?? `fake_recovery_${randomUUID()}`;
  const result: FinancialOperationResult = {
    operationId: commandReceipt.operationId,
    operationKind: commandReceipt.operationKind,
    providerKind: 'FAKE',
    state,
    version: options.version ?? commandReceipt.providerExpectedVersion + 1,
    amountCents: options.amountCents ?? null,
    currency: options.currency ?? null,
    externalReference,
    idempotencyReplayed: false,
    retryable,
  };
  return {
    amountCents: result.amountCents,
    currency: result.currency,
    externalReferenceSha256: createHash('sha256')
      .update(externalReference, 'utf8')
      .digest('hex'),
    providerResultSha256: financialProviderOutcomeProjectionSha256(result),
  };
}

describePg('financial provider command recovery PostgreSQL authority', () => {
  const journal = new PostgresFinancialProviderCommandJournal(db);
  const repository = new PostgresFinancialProviderCommandRecoveryRepository(db);

  beforeAll(async () => {
    const preparedAuthority = await db.query<{ relation_name: string | null }>(
      `SELECT to_regclass('public.universal_v1_prepared_financial_commands')::TEXT
              AS relation_name`
    );
    if (preparedAuthority.rows[0]?.relation_name === null) {
      await db.query(preparedCommandMigration);
    }
    await db.query(migration);
  });

  it('leases once under concurrency, commits the crash boundary, and reconciles unknown to terminal', async () => {
    const requested = await journal.recordRequested(command());
    await expect(
      repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    ).resolves.toEqual([]);

    const firstClaims = await Promise.all([
      repository.acquireLease({
        commandId: requested.commandId,
        recoveryAction: 'DISPATCH',
        leaseOwnerId: randomUUID(),
      }),
      repository.acquireLease({
        commandId: requested.commandId,
        recoveryAction: 'DISPATCH',
        leaseOwnerId: randomUUID(),
      }),
    ]);
    const dispatchLeases = firstClaims.filter((lease) => lease !== null);
    expect(dispatchLeases).toHaveLength(1);
    const dispatchLease = dispatchLeases[0]!;
    expect(dispatchLease.recoveryAction).toBe('DISPATCH');

    const attempted = await repository.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: dispatchLease.recoveryLeaseId,
      outcomeTimeoutSeconds: 0,
    });
    expect(attempted).toMatchObject({ attemptNumber: 1, idempotencyReplayed: false });
    await expect(
      repository.recordDispatchAttempted({
        commandId: requested.commandId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        outcomeTimeoutSeconds: 0,
      })
    ).resolves.toEqual({ ...attempted, idempotencyReplayed: true });

    const unknownKey = `finance-recovery:${dispatchLease.recoveryLeaseId}`;
    const unknown = await repository.recordOutcome({
      kind: 'OUTCOME_UNKNOWN',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: dispatchLease.recoveryLeaseId,
      observationIdempotencyKey: unknownKey,
      failureCode: 'FAKE_OUTCOME_NOT_VISIBLE',
      recoveryDelaySeconds: 1,
    });
    expect(unknown).toMatchObject({
      outcomeKind: 'OUTCOME_UNKNOWN',
      retryable: true,
      effectCertainty: 'UNKNOWN',
      idempotencyReplayed: false,
    });
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_UNKNOWN',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        observationIdempotencyKey: unknownKey,
        failureCode: 'FAKE_OUTCOME_NOT_VISIBLE',
        recoveryDelaySeconds: 1,
      })
    ).resolves.toEqual({ ...unknown, idempotencyReplayed: true });
    await db.query('SELECT pg_sleep(1.05)');

    const reconcileClaims = (
      await Promise.all([
        repository.claimRecoverable({
          commandId: requested.commandId,
          leaseOwnerId: randomUUID(),
        }),
        repository.claimRecoverable({
          commandId: requested.commandId,
          leaseOwnerId: randomUUID(),
        }),
      ])
    ).flat();
    expect(reconcileClaims).toHaveLength(1);
    const reconcileClaim = reconcileClaims[0]!;
    expect(reconcileClaim.lease.recoveryAction).toBe('RECONCILE');
    expect(reconcileClaim.lastDispatchAttempt?.dispatchAttemptId).toBe(attempted.dispatchAttemptId);

    const terminalInput = {
      kind: 'OUTCOME_OBSERVED',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: reconcileClaim.lease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${reconcileClaim.lease.recoveryLeaseId}`,
      ...observedProjection(requested, 'MATCHED', false),
      providerState: 'MATCHED',
      providerResultVersion: 1,
      effectCertainty: 'CONFIRMED_NO_EFFECT',
      retryable: false,
      recoveryDelaySeconds: null,
    } as const;
    const observed = await repository.recordOutcome(terminalInput);
    expect(observed).toMatchObject({ outcomeKind: 'OUTCOME_OBSERVED', retryable: false });
    await expect(repository.recordOutcome(terminalInput)).resolves.toEqual({
      ...observed,
      idempotencyReplayed: true,
    });
    await expect(
      repository.recordOutcome({
        ...terminalInput,
        observationIdempotencyKey: `finance-recovery:unrelated-${randomUUID()}`,
      })
    ).rejects.toEqual(new FinancialProviderCommandRecoveryError('TERMINAL_OUTCOME_CONFLICT'));
    await expect(
      repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    ).resolves.toEqual([]);

    const facts = await db.query<{
      attempts: number;
      unknowns: number;
      terminals: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER
            FROM public.financial_provider_command_dispatch_attempts
           WHERE command_id=$1) AS attempts,
         (SELECT COUNT(*)::INTEGER
            FROM public.financial_provider_command_outcome_facts
           WHERE command_id=$1 AND outcome_kind='OUTCOME_UNKNOWN') AS unknowns,
         (SELECT COUNT(*)::INTEGER
            FROM public.financial_provider_command_outcome_facts
           WHERE command_id=$1 AND outcome_kind='OUTCOME_OBSERVED') AS terminals`,
      [requested.commandId]
    );
    expect(facts.rows[0]).toEqual({ attempts: 1, unknowns: 1, terminals: 1 });
  });

  it('makes background recovery reconcile retryable no-effect facts and leaves redispatch explicit', async () => {
    const requested = await journal.recordRequested(command());
    const firstLease = (await repository.acquireLease({
      commandId: requested.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: randomUUID(),
    }))!;
    const firstAttempt = await repository.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: firstLease.recoveryLeaseId,
      outcomeTimeoutSeconds: 0,
    });
    await repository.recordOutcome({
      kind: 'FAILED',
      commandId: requested.commandId,
      dispatchAttemptId: firstAttempt.dispatchAttemptId,
      recoveryLeaseId: firstLease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${firstLease.recoveryLeaseId}`,
      failureCode: 'FAKE_DEFINITE_NO_EFFECT',
      retryable: true,
      recoveryDelaySeconds: 1,
    });
    await db.query('SELECT pg_sleep(1.05)');

    const reconciliationClaim = (
      await repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    )[0]!;
    expect(reconciliationClaim.lease.recoveryAction).toBe('RECONCILE');
    await repository.recordOutcome({
      kind: 'FAILED',
      commandId: requested.commandId,
      dispatchAttemptId: firstAttempt.dispatchAttemptId,
      recoveryLeaseId: reconciliationClaim.lease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${reconciliationClaim.lease.recoveryLeaseId}`,
      failureCode: 'FAKE_RECONCILED_NO_EFFECT',
      retryable: true,
      recoveryDelaySeconds: 1,
    });
    await db.query('SELECT pg_sleep(1.05)');

    const retryLease = (await repository.acquireLease({
      commandId: requested.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: randomUUID(),
    }))!;
    const secondAttempt = await repository.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: retryLease.recoveryLeaseId,
      outcomeTimeoutSeconds: 0,
    });
    expect(secondAttempt.attemptNumber).toBe(2);
    await repository.recordOutcome({
      kind: 'FAILED',
      commandId: requested.commandId,
      dispatchAttemptId: secondAttempt.dispatchAttemptId,
      recoveryLeaseId: retryLease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${retryLease.recoveryLeaseId}`,
      failureCode: 'FAKE_DEFINITE_TERMINAL_FAILURE',
      retryable: false,
    });
    await expect(
      repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    ).resolves.toEqual([]);
  });

  it('keeps observed pending evidence nonterminal and recoverable without redispatch', async () => {
    const requested = await journal.recordRequested(command({ operationKind: 'INGEST_WEBHOOK' }));
    const dispatchLease = (await repository.acquireLease({
      commandId: requested.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: randomUUID(),
    }))!;
    const attempted = await repository.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: dispatchLease.recoveryLeaseId,
      outcomeTimeoutSeconds: 0,
    });
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_OBSERVED',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
        ...observedProjection(requested, 'PENDING', true, { version: 2 }),
        providerState: 'PENDING',
        providerResultVersion: 2,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        recoveryDelaySeconds: 1,
      })
    ).rejects.toThrow(/provider version does not advance exact command version/iu);
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_OBSERVED',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
        ...observedProjection(requested, 'PENDING', true),
        providerResultSha256: 'f'.repeat(64),
        providerState: 'PENDING',
        providerResultVersion: 1,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        recoveryDelaySeconds: 1,
      })
    ).rejects.toThrow(/provider projection digest mismatch/iu);
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_OBSERVED',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
        ...observedProjection(requested, 'PENDING', true, {
          amountCents: 4_200,
          currency: 'USD',
        }),
        providerState: 'PENDING',
        providerResultVersion: 1,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        recoveryDelaySeconds: 1,
      })
    ).rejects.toThrow(/non-money provider outcome cannot project value/iu);
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_OBSERVED',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: dispatchLease.recoveryLeaseId,
        observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
        ...observedProjection(requested, 'REFUNDED', false),
        providerState: 'REFUNDED',
        providerResultVersion: 1,
        effectCertainty: 'CONFIRMED_EFFECT',
        retryable: false,
        recoveryDelaySeconds: null,
      })
    ).rejects.toThrow(/observed provider state is invalid for command operation/iu);
    const pending = await repository.recordOutcome({
      kind: 'OUTCOME_OBSERVED',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: dispatchLease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
      ...observedProjection(requested, 'PENDING', true),
      providerState: 'PENDING',
      providerResultVersion: 1,
      effectCertainty: 'UNKNOWN',
      retryable: true,
      recoveryDelaySeconds: 1,
    });
    expect(pending).toMatchObject({
      outcomeKind: 'OUTCOME_OBSERVED',
      providerState: 'PENDING',
      effectCertainty: 'UNKNOWN',
      retryable: true,
    });
    await db.query('SELECT pg_sleep(1.05)');

    const reconciliationClaim = (
      await repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    )[0]!;
    expect(reconciliationClaim).toMatchObject({
      lease: { recoveryAction: 'RECONCILE' },
      lastDispatchAttempt: { dispatchAttemptId: attempted.dispatchAttemptId },
    });
    await expect(
      repository.recordOutcome({
        kind: 'OUTCOME_OBSERVED',
        commandId: requested.commandId,
        dispatchAttemptId: attempted.dispatchAttemptId,
        recoveryLeaseId: reconciliationClaim.lease.recoveryLeaseId,
        observationIdempotencyKey: `finance-recovery:${dispatchLease.recoveryLeaseId}`,
        ...observedProjection(requested, 'PENDING', true),
        providerState: 'PENDING',
        providerResultVersion: 1,
        effectCertainty: 'UNKNOWN',
        retryable: true,
        recoveryDelaySeconds: 1,
      })
    ).rejects.toEqual(
      new FinancialProviderCommandRecoveryError('OUTCOME_IDEMPOTENCY_CONFLICT')
    );
    await repository.recordOutcome({
      kind: 'OUTCOME_OBSERVED',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: reconciliationClaim.lease.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${reconciliationClaim.lease.recoveryLeaseId}`,
      ...observedProjection(requested, 'ACCEPTED', false),
      providerState: 'ACCEPTED',
      providerResultVersion: 1,
      effectCertainty: 'CONFIRMED_EFFECT',
      retryable: false,
      recoveryDelaySeconds: null,
    });
    await expect(
      repository.claimRecoverable({
        commandId: requested.commandId,
        leaseOwnerId: randomUUID(),
      })
    ).resolves.toEqual([]);
  });

  it('overrides caller-supplied clocks and deadlines at every direct-DML boundary', async () => {
    const requested = await journal.recordRequested(command());
    const spoofed = '2000-01-01T00:00:00.000Z';
    const before = Date.now();
    const leaseResult = await db.query<{
      recovery_lease_id: string;
      acquired_at: Date | string;
      expires_at: Date | string;
    }>(
      `INSERT INTO public.financial_provider_command_recovery_leases (
         command_id, recovery_action, lease_owner_id, lease_duration_seconds,
         acquired_at, expires_at
       ) VALUES ($1, 'DISPATCH', $2, 60, $3, $3::TIMESTAMPTZ + INTERVAL '60 seconds')
       RETURNING recovery_lease_id, acquired_at, expires_at`,
      [requested.commandId, randomUUID(), spoofed]
    );
    const lease = leaseResult.rows[0]!;
    const acquiredAt = new Date(lease.acquired_at).getTime();
    expect(acquiredAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(new Date(lease.expires_at).getTime() - acquiredAt).toBe(60_000);

    const attemptResult = await db.query<{
      dispatch_attempt_id: string;
      attempted_at: Date | string;
      outcome_deadline_at: Date | string;
    }>(
      `INSERT INTO public.financial_provider_command_dispatch_attempts (
         command_id, recovery_lease_id, attempt_number, request_sha256,
         outcome_timeout_seconds, attempted_at, outcome_deadline_at
       ) VALUES ($1, $2, 1, $3, 10, $4, $4::TIMESTAMPTZ + INTERVAL '10 seconds')
       RETURNING dispatch_attempt_id, attempted_at, outcome_deadline_at`,
      [requested.commandId, lease.recovery_lease_id, requested.requestSha256, spoofed]
    );
    const attempted = attemptResult.rows[0]!;
    const attemptedAt = new Date(attempted.attempted_at).getTime();
    expect(attemptedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(new Date(attempted.outcome_deadline_at).getTime() - attemptedAt).toBe(10_000);

    const outcomeResult = await db.query<{
      recorded_at: Date | string;
      recovery_not_before: Date | string;
    }>(
      `INSERT INTO public.financial_provider_command_outcome_facts (
         command_id, dispatch_attempt_id, recovery_lease_id, outcome_kind,
         observation_idempotency_key, effect_certainty, retryable, failure_code,
         recovery_delay_seconds, recovery_not_before, recorded_at
       ) VALUES ($1, $2, $3, 'OUTCOME_UNKNOWN', $4, 'UNKNOWN', TRUE,
                 'FAKE_DIRECT_DML_UNKNOWN', 15,
                 $5::TIMESTAMPTZ + INTERVAL '15 seconds', $5)
       RETURNING recorded_at, recovery_not_before`,
      [
        requested.commandId,
        attempted.dispatch_attempt_id,
        lease.recovery_lease_id,
        `finance-recovery:${lease.recovery_lease_id}`,
        spoofed,
      ]
    );
    const outcome = outcomeResult.rows[0]!;
    const recordedAt = new Date(outcome.recorded_at).getTime();
    expect(recordedAt).toBeGreaterThanOrEqual(before - 1_000);
    expect(new Date(outcome.recovery_not_before).getTime() - recordedAt).toBe(15_000);
  });

  it('makes approved-provider leases unavailable in both repository and SQL', async () => {
    const approved = await journal.recordRequested(
      command({
        providerKind: 'APPROVED_PROVIDER',
        actor: { actorId: randomUUID(), actorKind: 'NAMED_OPERATOR' },
        release: {
          manifestDigest: `sha256:${'b'.repeat(64)}`,
          releaseId: 'release.recovery.pg.0001',
          revision: 'c'.repeat(40),
          environment: 'staging',
          authenticationStatus: 'VERIFIED',
        },
      })
    );
    await expect(
      repository.claimRecoverable({
        commandId: approved.commandId,
        leaseOwnerId: randomUUID(),
      })
    ).resolves.toEqual([]);
    await expect(
      repository.acquireLease({
        commandId: approved.commandId,
        recoveryAction: 'DISPATCH',
        leaseOwnerId: randomUUID(),
      })
    ).rejects.toEqual(new FinancialProviderCommandRecoveryError('APPROVED_PROVIDER_UNAVAILABLE'));
    await expect(
      db.query(
        `WITH timing AS (SELECT clock_timestamp() AS now)
         INSERT INTO public.financial_provider_command_recovery_leases (
           command_id, recovery_action, lease_owner_id, lease_duration_seconds,
           acquired_at, expires_at
         )
         SELECT $1, 'DISPATCH', $2, 60, timing.now,
                timing.now + INTERVAL '60 seconds'
           FROM timing`,
        [approved.commandId, randomUUID()]
      )
    ).rejects.toThrow(/approved-provider recovery is unavailable/iu);
  });

  it('denies mutation and never persists raw command or provider reference material', async () => {
    const paymentMethodReference = `pm_recovery_secret_${randomUUID()}`;
    const requested = await journal.recordRequested(
      command({
        exactRequest: {
          operationId: randomUUID(),
          paymentMethodReference,
          providerAccountReference: `acct_recovery_secret_${randomUUID()}`,
        },
      })
    );
    const lease = await repository.acquireLease({
      commandId: requested.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: randomUUID(),
    });
    const attempted = await repository.recordDispatchAttempted({
      commandId: requested.commandId,
      recoveryLeaseId: lease!.recoveryLeaseId,
      outcomeTimeoutSeconds: 0,
    });
    await repository.recordOutcome({
      kind: 'OUTCOME_UNKNOWN',
      commandId: requested.commandId,
      dispatchAttemptId: attempted.dispatchAttemptId,
      recoveryLeaseId: lease!.recoveryLeaseId,
      observationIdempotencyKey: `finance-recovery:${lease!.recoveryLeaseId}`,
      failureCode: 'FAKE_MUTATION_TEST_UNKNOWN',
      recoveryDelaySeconds: 60,
    });

    const stored = await db.query<{ serialized: string }>(
      `SELECT jsonb_build_object(
         'lease', (SELECT to_jsonb(value) FROM public.financial_provider_command_recovery_leases value
                    WHERE value.command_id=$1 LIMIT 1),
         'attempt', (SELECT to_jsonb(value) FROM public.financial_provider_command_dispatch_attempts value
                      WHERE value.command_id=$1 LIMIT 1),
         'outcome', (SELECT to_jsonb(value) FROM public.financial_provider_command_outcome_facts value
                      WHERE value.command_id=$1 LIMIT 1)
       )::TEXT AS serialized`,
      [requested.commandId]
    );
    expect(stored.rows[0]?.serialized).not.toContain(paymentMethodReference);
    expect(stored.rows[0]?.serialized).not.toContain('paymentMethodReference');
    expect(stored.rows[0]?.serialized).not.toContain('providerAccountReference');

    await expect(
      db.query(
        `UPDATE public.financial_provider_command_dispatch_attempts
            SET attempt_number=attempt_number
          WHERE dispatch_attempt_id=$1`,
        [attempted.dispatchAttemptId]
      )
    ).rejects.toThrow(/append-only/iu);
    await expect(
      db.query(
        `DELETE FROM public.financial_provider_command_recovery_leases
          WHERE recovery_lease_id=$1`,
        [lease!.recoveryLeaseId]
      )
    ).rejects.toThrow(/append-only/iu);
    await expect(
      // The nonproduction lifecycle bridge adds a restrictive foreign key to
      // this evidence table. CASCADE lets PostgreSQL reach the table's own
      // BEFORE TRUNCATE guard instead of rejecting first at FK planning.
      db.query('TRUNCATE TABLE public.financial_provider_command_outcome_facts CASCADE')
    ).rejects.toThrow(/append-only/iu);
  });
});
