import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import { decryptCustomerAddress, formatServiceAddress } from './CustomerAddressCrypto.js';
import { decryptTaskLocation, type StoredEncryptedTaskLocation } from './TaskLocationCrypto.js';

export interface QuoteAddressRow extends StoredEncryptedTaskLocation {
  task_id: string | null;
  locked_at: Date | null;
}

export async function lockQuoteAddressForPayment(quoteId: string, quoteVersionId: string, userId: string): Promise<void> {
  await db.transaction(async (query) => {
    const quote = await query<{ id: string }>(
      `SELECT q.id FROM quotes q JOIN task_drafts d ON d.id = q.task_draft_id
       WHERE q.id = $1 AND q.active_version_id = $2 AND d.poster_user_id = $3
         AND d.quote_id = q.id AND q.status IN ('quote_ready', 'quote_send_ready')
       FOR UPDATE OF q, d`, [quoteId, quoteVersionId, userId],
    );
    if (!quote.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote is no longer available for payment.' });
    try {
      await readQuoteServiceLocation(query, quoteVersionId, userId);
    } catch {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Confirm your service address before payment. If it cannot be loaded, contact support before retrying payment.' });
    }
    await query(`UPDATE quote_service_addresses SET locked_at = COALESCE(locked_at, NOW()), updated_at = NOW()
      WHERE quote_version_id = $1 AND user_id = $2`, [quoteVersionId, userId]);
  });
}

export async function readQuoteServiceLocation(query: QueryFn, quoteVersionId: string, userId: string): Promise<string> {
  const result = await query<QuoteAddressRow>(
    `SELECT * FROM quote_service_addresses WHERE quote_version_id = $1 AND user_id = $2 FOR UPDATE`,
    [quoteVersionId, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('SERVICE_ADDRESS_REQUIRED');
  try {
    // Recovery after task materialization committed but funding did not finish.
    // The vault is now the sole source; never recreate or overwrite its address.
    if (row.task_id) {
      const vault = await query<StoredEncryptedTaskLocation>(
        `SELECT v.* FROM task_location_vault v JOIN tasks t ON t.id = v.task_id
         WHERE v.task_id = $1 AND t.poster_id = $2`, [row.task_id, userId],
      );
      if (!vault.rows[0]) throw new Error('SERVICE_ADDRESS_UNAVAILABLE');
      return decryptTaskLocation(row.task_id, vault.rows[0]);
    }
    return formatServiceAddress(decryptCustomerAddress(`checkout:${userId}:${quoteVersionId}`, row));
  } catch {
    throw new Error('SERVICE_ADDRESS_UNAVAILABLE');
  }
}

export async function consumeQuoteServiceAddress(query: QueryFn, quoteVersionId: string, userId: string, taskId: string): Promise<void> {
  await query(`UPDATE quote_service_addresses SET task_id = $3, location_ciphertext = NULL,
    location_nonce = NULL, location_auth_tag = NULL, location_key_id = NULL, updated_at = NOW()
    WHERE quote_version_id = $1 AND user_id = $2`, [quoteVersionId, userId, taskId]);
}
