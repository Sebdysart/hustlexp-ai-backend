import { describe, expect, it, vi } from 'vitest';

import {
  createPendingPhoneClaimInTransaction,
  type PendingPhoneClaimDiagnosticEvent,
} from '../../src/services/CustomerDraftClaimService.js';

describe('pending phone claim creation diagnostics', () => {
  it('reports claim persistence boundaries without exposing the phone or queuing SMS', async () => {
    const events: PendingPhoneClaimDiagnosticEvent[] = [];
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('INSERT INTO pending_phone_draft_claims')) {
        return { rows: [{ id: '11111111-1111-4111-8111-111111111111' }], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await createPendingPhoneClaimInTransaction(query, {
      taskDraftId: '33333333-3333-4333-8333-333333333333',
      normalizedPhone: '+12065550123',
      createdByOpsUserId: '44444444-4444-4444-8444-444444444444',
      onDiagnosticStage: (event) => events.push(event),
    });

    expect(events.map((event) => event.stage)).toEqual([
      'pending_claim_create_start',
      'pending_claim_create_success',
    ]);
    expect(JSON.stringify(events)).not.toContain('+12065550123');
    expect(events.at(-1)).toMatchObject({
      claimId: '11111111-1111-4111-8111-111111111111',
    });
    expect(calls.some((sql) => sql.includes('sms_outbox'))).toBe(false);
    expect(calls.some((sql) => sql.includes('outbox_events'))).toBe(false);
  });
});
