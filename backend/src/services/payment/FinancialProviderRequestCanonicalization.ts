/** Exact existing journal encoding, shared by hashing, durable submission and readback. */
export const MAX_CANONICAL_FINANCIAL_REQUEST_BYTES = 65_536;
type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export class FinancialProviderRequestCanonicalizationError extends Error {
  constructor(readonly reason: 'REQUEST_INVALID' | 'REQUEST_TOO_LARGE') {
    super(`FINANCIAL_PROVIDER_REQUEST_${reason}`);
    this.name = 'FinancialProviderRequestCanonicalizationError';
  }
}
function invalid(): never {
  throw new FinancialProviderRequestCanonicalizationError('REQUEST_INVALID');
}
function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  allowUndefined: boolean
): CanonicalJson | undefined {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    return invalid();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) return invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry) => {
        const normalized = canonicalize(entry, ancestors, false);
        if (normalized === undefined) return invalid();
        return normalized;
      });
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    if (Object.getOwnPropertySymbols(value).length > 0) return invalid();
    const normalized: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) return invalid();
      const child = canonicalize(descriptor.value, ancestors, true);
      if (child !== undefined) normalized[key] = child;
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}
export function canonicalFinancialProviderRequestJson(value: unknown): string {
  const normalized = canonicalize(value, new Set<object>(), false);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') return invalid();
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_CANONICAL_FINANCIAL_REQUEST_BYTES) {
    throw new FinancialProviderRequestCanonicalizationError('REQUEST_TOO_LARGE');
  }
  return json;
}
