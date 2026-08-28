import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { Schemas } from '../trpc.js';

export const safetyCategory = z.enum([
  'injury',
  'threat',
  'property_damage',
  'identity_theft',
  'fraud',
  'chargeback',
  'legal_request',
  'licensing_ambiguity',
  'high_value_compensation',
  'vulnerable_person_safety',
  'other',
]);

export const safetyUrgency = z.enum(['standard', 'high', 'urgent']);
const contactPermission = z.enum(['call', 'text', 'in_app_only', 'do_not_contact']);
const locationEvidence = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(1).max(10000),
  capturedAt: z.string().datetime(),
});

export const safetyReportInput = z.object({
  taskId: Schemas.uuid,
  category: safetyCategory,
  urgency: safetyUrgency,
  description: z.string().trim().min(10).max(2000),
  locationSharingEnabled: z.boolean().default(false),
  location: locationEvidence.optional(),
  contactPermission,
  idempotencyKey: z.string().uuid(),
  clientSequence: z.number().int().positive().optional(),
  priorTaskVersion: z.number().int().positive().optional(),
  localOccurredAt: z.string().datetime().optional(),
  deviceVersion: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  appVersion: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  offlinePayloadHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).superRefine((value, context) => {
  if (value.locationSharingEnabled && !value.location) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['location'],
      message: 'Captured location is required when sharing is enabled.',
    });
  }
  if (!value.locationSharingEnabled && value.location) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['location'],
      message: 'Captured location is forbidden when sharing is off.',
    });
  }
  const syncValues = [
    value.clientSequence,
    value.priorTaskVersion,
    value.localOccurredAt,
    value.deviceVersion,
    value.appVersion,
  ];
  const supplied = syncValues.filter((item) => item !== undefined).length;
  if (supplied !== 0 && supplied !== syncValues.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['clientSequence'],
      message: 'Offline sync evidence must be supplied as one complete tuple.',
    });
  }
  if (value.offlinePayloadHash !== undefined && supplied !== syncValues.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['offlinePayloadHash'],
      message: 'Offline payload evidence requires the complete sync tuple.',
    });
  }
});

export type SafetyCategory = z.infer<typeof safetyCategory>;
export type SafetyUrgency = z.infer<typeof safetyUrgency>;
export type SafetyReportInput = z.infer<typeof safetyReportInput>;

const urgencyRank: Record<SafetyUrgency, number> = { standard: 0, high: 1, urgent: 2 };
const categoryUrgencyFloor: Record<SafetyCategory, SafetyUrgency> = {
  injury: 'urgent',
  threat: 'urgent',
  property_damage: 'high',
  identity_theft: 'high',
  fraud: 'high',
  chargeback: 'high',
  legal_request: 'high',
  licensing_ambiguity: 'high',
  high_value_compensation: 'high',
  vulnerable_person_safety: 'urgent',
  other: 'standard',
};

export function effectiveUrgency(
  category: SafetyCategory,
  requested: SafetyUrgency,
): SafetyUrgency {
  const floor = categoryUrgencyFloor[category];
  return urgencyRank[floor] > urgencyRank[requested] ? floor : requested;
}

export function payloadHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function assertLocationRecency(location: SafetyReportInput['location']): void {
  if (!location) return;
  const capturedAt = Date.parse(location.capturedAt);
  const now = Date.now();
  if (capturedAt >= now - 7 * 24 * 60 * 60 * 1000 && capturedAt <= now + 5 * 60 * 1000) return;
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message: 'Captured safety location must be from the last seven days and cannot be in the future.',
  });
}

export async function requireTaskParticipant(taskId: string, userId: string): Promise<void> {
  const result = await db.query<{ poster_id: string; worker_id: string | null }>(
    'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
    [taskId],
  );
  const task = result.rows[0];
  if (task && (task.poster_id === userId || task.worker_id === userId)) return;
  throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
}
