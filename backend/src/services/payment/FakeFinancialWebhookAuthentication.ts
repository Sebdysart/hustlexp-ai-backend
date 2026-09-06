import { createHash } from 'node:crypto';
import { z } from 'zod';

export const fakeFinancialWebhookKeyIdSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const fakeFinancialWebhookTargetSchema = z
  .object({
    keyId: fakeFinancialWebhookKeyIdSchema,
    targetAuthorityId: fakeFinancialWebhookKeyIdSchema,
    targetAuthorityVersion: z.number().int().positive().max(2_147_483_647),
    targetDatabaseName: z
      .string()
      .min(1)
      .max(63)
      .refine((value) => !value.includes('\0')),
    environment: z.enum(['local', 'preview', 'staging']),
    releaseManifestSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();
export type FakeFinancialWebhookTarget = z.infer<typeof fakeFinancialWebhookTargetSchema>;
export const FAKE_FINANCIAL_WEBHOOK_AUTHENTICATION_SCHEME = 'HMAC_SHA256_TARGET_V13';

/** Public signing format for the isolated fake provider. This module has no
 * signing key, environment-secret reader, or signing endpoint. */
export function fakeFinancialWebhookSignedBytes(
  target: FakeFinancialWebhookTarget,
  rawPayload: Uint8Array
): Buffer {
  const binding = fakeFinancialWebhookTargetSchema.parse(target);
  const prefix = [
    'HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_V13',
    binding.keyId,
    binding.targetAuthorityId,
    String(binding.targetAuthorityVersion),
    binding.targetDatabaseName,
    binding.environment,
    binding.releaseManifestSha256,
    '',
  ].join('\0');
  return Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from(rawPayload)]);
}

export function fakeFinancialWebhookAuthenticationEvidence(
  signedBytes: Uint8Array,
  signature: string
): string {
  if (!/^[a-f0-9]{64}$/u.test(signature)) throw new Error('FAKE_WEBHOOK_SIGNATURE_INVALID');
  return createHash('sha256')
    .update('HUSTLEXP_FAKE_FINANCIAL_WEBHOOK_AUTH_V13\0', 'utf8')
    .update(signedBytes)
    .update(Buffer.from(signature, 'hex'))
    .digest('hex');
}
