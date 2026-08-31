import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/**
 * Build a caller-owned stable operation identity from domain identifiers and
 * immutable request/version material. Callers must include a distinct domain
 * event/version component when identical payloads can represent new work.
 */
export function aiOperationId(scope: string, ...components: unknown[]): string {
  if (!scope || scope.length > 80) throw new Error('AI_OPERATION_SCOPE_INVALID');
  // Arrays are intentionally ordered. Callers representing a mathematical set
  // must sort it by an immutable domain identifier before calling this helper.
  const digest = createHash('sha256').update(JSON.stringify(canonicalize(components))).digest('hex');
  return `${scope}:${digest}`;
}
