import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db } from '../db.js';
import type { WorkerScreeningStatus } from './WorkerScreeningRightsPolicy.js';

export type ScreeningQuery = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface ScreeningCheckRow {
  id: string;
  user_id: string;
  provider: string;
  status: Exclude<WorkerScreeningStatus, 'NOT_STARTED'>;
  result_summary: string | null;
  initiated_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

export function screeningDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function screeningBadRequest(message: string): never {
  throw new TRPCError({ code: 'BAD_REQUEST', message });
}
