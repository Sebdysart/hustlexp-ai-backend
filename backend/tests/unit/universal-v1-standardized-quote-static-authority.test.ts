import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const application = readFileSync(
  resolve(process.cwd(), 'backend/src/services/UniversalV1StandardizedQuoteApplication.ts'),
  'utf8'
);
const contracts = readFileSync(
  resolve(process.cwd(), 'backend/src/services/UniversalV1StandardizedQuoteContracts.ts'),
  'utf8'
);
const repository = [
  'UniversalV1StandardizedQuotePostgresSupport.ts',
  'UniversalV1StandardizedQuotePostgresSql.ts',
  'UniversalV1StandardizedQuotePostgresQuoteStore.ts',
  'UniversalV1StandardizedQuotePostgresAcceptanceReadinessStore.ts',
  'UniversalV1StandardizedQuotePostgresRepository.ts',
]
  .map((fileName) =>
    readFileSync(resolve(process.cwd(), 'backend/src/services', fileName), 'utf8')
  )
  .join('\n');
const router = readFileSync(
  resolve(process.cwd(), 'backend/src/routers/universalV1StandardizedQuotes.ts'),
  'utf8'
);

function sourceBlock(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('Universal V1 standardized quote static authority and concurrency contracts', () => {
  it.each([
    ['async prepareQuote(', 'async getCurrent(', 'findQuoteReplay'],
    ['async acceptQuote(', 'async prepareFakePaymentMethod(', 'findAcceptanceReplay'],
    ['async prepareFakePaymentMethod(', '\n}', 'findFakePaymentMethodReplay'],
  ] as const)(
    'looks up a committed replay before freshness and current-release evidence in %s',
    (start, end, replayMethod) => {
      const block = sourceBlock(application, start, end);
      expect(block.indexOf(replayMethod)).toBeGreaterThanOrEqual(0);
      expect(block.indexOf(replayMethod)).toBeLessThan(block.indexOf('assertFresh('));
      expect(block.indexOf('assertFresh(')).toBeLessThan(block.indexOf('runtimeEvidence()'));
    }
  );

  it('keeps idempotency identity stable across a deployment witness change', () => {
    const stableIntentBlocks = [
      sourceBlock(
        contracts,
        'export function universalV1StandardizedQuoteRequestSha256(',
        'export function universalV1StandardizedQuoteAcceptanceRequestSha256('
      ),
      sourceBlock(
        contracts,
        'export function universalV1StandardizedQuoteAcceptanceRequestSha256(',
        'export function universalV1FakePaymentMethodReference('
      ),
      sourceBlock(
        contracts,
        'export function universalV1FakePaymentMethodReference(',
        'export function universalV1FakePaymentMethodReferenceSha256('
      ),
      sourceBlock(
        contracts,
        'export function universalV1FakePaymentMethodReadinessRequestSha256(',
        '\n}'
      ),
    ];
    for (const block of stableIntentBlocks) {
      expect(block).not.toMatch(
        /buildCommitSha|releaseManifestDigest|capabilityPolicyDigest|RuntimeEvidence/u
      );
    }
  });

  it('serializes every mutation on one TaskDraft lifecycle lock and retries conflicts finitely', () => {
    expect(
      repository.match(/standardized-quote-lifecycle:\$\{command\.input\.taskDraftId\}/gu)
    ).toHaveLength(3);
    expect(repository).toContain('const maximumAttempts = 3');
    expect(repository).toContain("['40001', '40P01']");
    expect(repository).toContain(
      'The standardized quote lifecycle changed concurrently; retry the exact command.'
    );
  });

  it('binds acceptance/readiness inserts to TaskDraft and reports DB-derived actionability', () => {
    expect(repository).toMatch(
      /task_draft_standardized_quote_acceptance_facts\([\s\S]*?task_draft_id, quote_version_id/u
    );
    expect(repository).toMatch(
      /task_draft_payment_method_readiness_facts\([\s\S]*?task_draft_id, acceptance_fact_id/u
    );
    for (const state of [
      'routing_current',
      'quote_unexpired',
      'readiness_chain_head',
      'readiness_unexpired',
      'acceptanceOpen',
      'priceLocked',
      'fakePaymentMethodReady',
      'PREPARE_OR_RENEW_FAKE_PAYMENT_METHOD',
      'READY_FOR_PROVIDER_DISCOVERY',
    ]) {
      expect(repository).toContain(state);
    }
    expect(repository).toContain(
      'readiness.expires_at > clock_timestamp() AS readiness_unexpired'
    );
    expect(repository).toContain("'ROUTE_REVIEW_REQUIRED' as const");
    expect(repository).toContain("'SUPERSEDED' as const");
    expect(repository).toContain("'EXPIRED' as const");
  });

  it('keeps every standardized-quote command source outside held downstream relations', () => {
    const heldRelations = [
      'task_work_order_command_requests',
      'task_provider_eligibility_decisions',
      'task_work_orders',
      'task_work_order_execution_facts',
      'task_reservations',
      'task_applications',
    ];
    for (const [label, source] of [
      ['application', application],
      ['contracts', contracts],
      ['repository', repository],
      ['router', router],
    ] as const) {
      for (const relation of heldRelations) {
        expect(source, `${label} must not reference held relation ${relation}`).not.toMatch(
          new RegExp(`\\b${relation}\\b`, 'u')
        );
      }
    }
  });
});
