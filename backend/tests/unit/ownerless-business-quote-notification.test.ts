import { describe, expect, it, vi } from 'vitest';

const notify = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: { createInTransaction: notify },
}));

import { publishBusinessQuoteInTransaction } from '../../src/services/BusinessQuoteActivationService.js';

describe('ownerless business quote publication', () => {
  it('persists publication without fabricating a customer notification', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'quote-1' }], rowCount: 1 }));
    await expect(publishBusinessQuoteInTransaction(query, {
      quoteId: 'quote-1', taskDraftId: 'draft-1', posterUserId: null, fromStatus: 'draft',
    })).resolves.toBe(true);
    expect(notify).not.toHaveBeenCalled();
  });
});
