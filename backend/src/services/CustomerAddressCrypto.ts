import { z } from 'zod';
import { decryptTaskLocation, encryptTaskLocation, type StoredEncryptedTaskLocation } from './TaskLocationCrypto.js';

const hasUnsupportedAddressCharacter = (value: string): boolean => [...value].some((character) => {
  const code = character.codePointAt(0)!;
  return code <= 0x1f || code === 0x7f || (code >= 0x202a && code <= 0x202e)
    || (code >= 0x2066 && code <= 0x2069);
});

const addressText = (max: number) => z.string().trim().max(max).refine(
  (value) => !hasUnsupportedAddressCharacter(value),
  'Address contains unsupported characters.',
);

export const CustomerAddressSchema = z.object({
  label: addressText(40).optional(),
  line1: addressText(120).refine((value) => value.length > 0, 'Enter a street address.'),
  line2: addressText(60).optional(),
  city: addressText(60).refine((value) => value.length > 0, 'Enter a city.'),
  state: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Use a two-letter state code.'),
  postalCode: z.string().trim().regex(/^\d{5}(?:-\d{4})?$/, 'Enter a valid ZIP code.'),
}).strict().refine((value) => JSON.stringify(value).length <= 500, 'Address is too long.');
export type CustomerAddress = z.infer<typeof CustomerAddressSchema>;

// Reuse AES-GCM, key rotation and fail-closed handling. Domain-prefixed AAD binds
// account/checkout payloads to their owner and row, separately from task UUIDs.
export function encryptCustomerAddress(context: string, address: CustomerAddress) {
  return encryptTaskLocation(`customer-address:${context}`, JSON.stringify(CustomerAddressSchema.parse(address)));
}

export function decryptCustomerAddress(context: string, stored: StoredEncryptedTaskLocation): CustomerAddress {
  return CustomerAddressSchema.parse(JSON.parse(decryptTaskLocation(`customer-address:${context}`, stored)));
}

export function formatServiceAddress(address: CustomerAddress): string {
  return [address.line1, address.line2, address.city, `${address.state} ${address.postalCode}`]
    .filter(Boolean).join(', ');
}
