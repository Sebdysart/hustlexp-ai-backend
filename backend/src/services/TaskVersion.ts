import type { Task } from '../types.js';

export type DatabaseTaskVersion = number | string | bigint;

export type DatabaseVersionRow<T extends object> = Omit<T, 'version'> & {
  version: DatabaseTaskVersion;
};

export type NormalizedVersionRow<T extends { version: unknown }> = Omit<T, 'version'> & {
  version: number;
};

export type DatabaseTaskRow = DatabaseVersionRow<Task>;
export type VersionedTask = NormalizedVersionRow<DatabaseTaskRow>;

const MAX_SAFE_TASK_VERSION = BigInt(Number.MAX_SAFE_INTEGER);

export function canonicalTaskVersion(value: unknown): number {
  let parsed: bigint;
  try {
    if (typeof value === 'bigint') {
      parsed = value;
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('unsafe number');
      parsed = BigInt(value);
    } else if (typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
      parsed = BigInt(value);
    } else {
      throw new Error('invalid task version representation');
    }
  } catch {
    throw new Error('TASK_VERSION_INVALID');
  }
  if (parsed <= 0n || parsed > MAX_SAFE_TASK_VERSION) {
    throw new Error('TASK_VERSION_OUT_OF_SAFE_RANGE');
  }
  return Number(parsed);
}

export function normalizeTaskVersion<T extends { version: unknown }>(
  row: T
): NormalizedVersionRow<T> {
  return { ...row, version: canonicalTaskVersion(row.version) };
}
