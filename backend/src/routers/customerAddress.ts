import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db, type QueryFn } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';
import { CustomerAddressSchema, decryptCustomerAddress, encryptCustomerAddress, type CustomerAddress } from '../services/CustomerAddressCrypto.js';
import type { StoredEncryptedTaskLocation } from '../services/TaskLocationCrypto.js';
import type { QuoteAddressRow } from '../services/QuoteServiceAddressService.js';

const quoteInput = z.object({ quoteId: z.string().uuid(), quoteVersionId: z.string().uuid() }).strict();

async function saveAddress(query: QueryFn, userId: string, address: CustomerAddress) {
  const id = randomUUID();
  const encrypted = encryptCustomerAddress(`saved:${userId}:${id}`, address);
  await query(`INSERT INTO customer_saved_addresses
    (id, user_id, location_ciphertext, location_nonce, location_auth_tag, location_key_id)
    VALUES ($1, $2, $3, $4, $5, $6)`,
  [id, userId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId]);
  return { id, ...address };
}

export const customerAddressRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const result = await db.query<StoredEncryptedTaskLocation & { id: string }>(
      'SELECT * FROM customer_saved_addresses WHERE user_id = $1 ORDER BY created_at DESC', [ctx.user.id],
    );
    return result.rows.map((row) => ({ id: row.id, ...decryptCustomerAddress(`saved:${ctx.user.id}:${row.id}`, row) }));
  }),
  create: protectedProcedure.input(CustomerAddressSchema).mutation(({ ctx, input }) =>
    saveAddress(db.query.bind(db), ctx.user.id, input)),
  remove: protectedProcedure.input(z.object({ id: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    await db.query('DELETE FROM customer_saved_addresses WHERE id = $1 AND user_id = $2', [input.id, ctx.user.id]);
    return { ok: true as const };
  }),
  getForQuote: protectedProcedure.input(quoteInput).query(async ({ ctx, input }) => {
    const result = await db.query<QuoteAddressRow>(
      `SELECT a.* FROM quote_service_addresses a
       JOIN quote_versions v ON v.id = a.quote_version_id JOIN quotes q ON q.id = v.quote_id
       JOIN task_drafts d ON d.id = q.task_draft_id
       WHERE q.id = $1 AND v.id = $2 AND d.poster_user_id = $3 AND a.user_id = $3`,
      [input.quoteId, input.quoteVersionId, ctx.user.id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { locked: Boolean(row.locked_at || row.task_id), taskId: row.task_id,
      address: row.task_id ? null : decryptCustomerAddress(`checkout:${ctx.user.id}:${input.quoteVersionId}`, row) };
  }),
  prepareForQuote: protectedProcedure.input(quoteInput.extend({
    savedAddressId: z.string().uuid().optional(),
    address: CustomerAddressSchema.optional(),
    saveForFuture: z.boolean().default(false),
  }).strict().refine((value) => Boolean(value.savedAddressId) !== Boolean(value.address), 'Choose a saved address or enter a new address.'))
    .mutation(async ({ ctx, input }) => db.transaction(async (query) => {
      const quote = await query<{ zip: string | null }>(
        `SELECT d.zip FROM quotes q JOIN task_drafts d ON d.id = q.task_draft_id
         JOIN quote_versions v ON v.id = q.active_version_id AND v.quote_id = q.id
         WHERE q.id = $1 AND v.id = $2 AND d.poster_user_id = $3 AND d.quote_id = q.id
           AND q.status IN ('quote_ready', 'quote_send_ready') AND d.task_id IS NULL AND v.expires_at > NOW()
         FOR UPDATE OF q, d`, [input.quoteId, input.quoteVersionId, ctx.user.id],
      );
      if (!quote.rows[0]) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote is no longer available for payment.' });
      let address = input.address;
      if (input.savedAddressId) {
        const saved = await query<StoredEncryptedTaskLocation>(
          'SELECT * FROM customer_saved_addresses WHERE id = $1 AND user_id = $2', [input.savedAddressId, ctx.user.id],
        );
        if (!saved.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved address not found.' });
        address = decryptCustomerAddress(`saved:${ctx.user.id}:${input.savedAddressId}`, saved.rows[0]);
      }
      if (!address) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a service address.' });
      // The accepted quote and region policy were priced for the intake ZIP.
      if (quote.rows[0].zip && address.postalCode.slice(0, 5) !== quote.rows[0].zip.slice(0, 5)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Use an address in the ZIP code for this request, or contact support to change the service area.' });
      }
      const existing = await query<QuoteAddressRow>(
        'SELECT * FROM quote_service_addresses WHERE quote_version_id = $1 FOR UPDATE', [input.quoteVersionId],
      );
      if (existing.rows[0]?.locked_at || existing.rows[0]?.task_id) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The service address is locked for this payment. Continue the existing payment or contact support.' });
      }
      const encrypted = encryptCustomerAddress(`checkout:${ctx.user.id}:${input.quoteVersionId}`, address);
      await query(`INSERT INTO quote_service_addresses
        (quote_version_id, user_id, location_ciphertext, location_nonce, location_auth_tag, location_key_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (quote_version_id) DO UPDATE SET location_ciphertext = EXCLUDED.location_ciphertext,
          location_nonce = EXCLUDED.location_nonce, location_auth_tag = EXCLUDED.location_auth_tag,
          location_key_id = EXCLUDED.location_key_id, updated_at = NOW()`,
      [input.quoteVersionId, ctx.user.id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, encrypted.keyId]);
      if (input.saveForFuture && !input.savedAddressId) await saveAddress(query, ctx.user.id, address);
      return { ok: true as const };
    })),
});
