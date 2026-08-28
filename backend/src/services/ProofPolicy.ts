import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import type { ProofState } from '../types.js';
import type {
  CompletionCriteriaProof,
  ProofPhotoEvidence,
  SubmitProofParams,
} from './ProofTypes.js';

const PROOF_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_PROOF_PHOTO_BYTES = 10 * 1024 * 1024;

export function proofSubmissionHash(
  params: SubmitProofParams,
  includeOfflineSync = params.clientSequence !== undefined,
): string | null {
  if (!params.clientSubmissionId) return null;
  const semantics: Record<string, unknown> = {
    taskId: params.taskId,
    submitterId: params.submitterId,
    description: params.description?.trim() || null,
    photos: (params.photoEvidence ?? []).map((photo) => ({
      uploadReceiptId: photo.uploadReceiptId,
      contentType: photo.contentType,
      fileSizeBytes: photo.fileSizeBytes,
      checksumSha256: photo.checksumSha256.toLowerCase(),
      capturedAt: photo.capturedAt ?? null,
    })),
    gpsLatitude: params.gpsLatitude ?? null,
    gpsLongitude: params.gpsLongitude ?? null,
    gpsAccuracyMeters: params.gpsAccuracyMeters ?? null,
    biometricHash: params.biometricHash ?? null,
    scopeVersionId: params.scopeVersionId ?? null,
    scopeHash: params.scopeHash?.toLowerCase() ?? null,
  };
  if (includeOfflineSync) {
    semantics.offlineSync = {
      clientSequence: params.clientSequence,
      priorTaskVersion: params.priorTaskVersion,
      localOccurredAt: params.localOccurredAt,
      deviceVersion: params.deviceVersion,
      appVersion: params.appVersion,
      offlinePayloadHash: params.offlinePayloadHash,
      entrySurface: 'TASK_PROOF_COMPOSER',
      contextSource: 'ACTIVE_TASK',
      intendedTransition: 'ACCEPTED_TO_PROOF_SUBMITTED',
    };
  }
  return createHash('sha256').update(JSON.stringify(semantics)).digest('hex');
}

function assertPhotoMetadata(photo: ProofPhotoEvidence): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(photo.uploadReceiptId)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proof photo upload receipt is invalid.' });
  }
  if (!PROOF_IMAGE_TYPES.has(photo.contentType)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proof photo content type is not supported.' });
  }
  if (!Number.isInteger(photo.fileSizeBytes)
      || photo.fileSizeBytes <= 0
      || photo.fileSizeBytes > MAX_PROOF_PHOTO_BYTES) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proof photo size is invalid.' });
  }
  if (!/^[a-f0-9]{64}$/i.test(photo.checksumSha256)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proof photo checksum is invalid.' });
  }
  if (photo.capturedAt && !Number.isFinite(Date.parse(photo.capturedAt))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proof photo capture time is invalid.' });
  }
}

export function assertDurablePhotoEvidence(params: SubmitProofParams): void {
  const photoCount = params.photoEvidence?.length ?? 0;
  if ((params.photoUrls?.length ?? 0) > 0) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'URL-only photo proof is not accepted; use finalized upload receipts.',
    });
  }
  if (photoCount > 10) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A maximum of 10 proof photos is allowed.' });
  }
  for (const photo of params.photoEvidence ?? []) {
    assertPhotoMetadata(photo);
  }
}

const VALID_TRANSITIONS: Record<ProofState, ProofState[]> = {
  PENDING: ['SUBMITTED'],
  SUBMITTED: ['ACCEPTED', 'REJECTED', 'EXPIRED'],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
};

export function isValidProofTransition(from: ProofState, to: ProofState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

type CriteriaResult = { valid: boolean; reason?: string };

function validatePhotoCriteria(proof: CompletionCriteriaProof): CriteriaResult {
  if (!proof.photoUrls?.length) {
    return { valid: false, reason: 'At least one photo is required for proof submission.' };
  }
  return { valid: true };
}

function validateCheckinCriteria(proof: CompletionCriteriaProof): CriteriaResult {
  if (!proof.checkInAt) return { valid: false, reason: 'GPS check-in timestamp is required.' };
  if (!proof.checkOutAt) return { valid: false, reason: 'GPS check-out timestamp is required.' };
  return { valid: true };
}

function validateSessionCriteria(proof: CompletionCriteriaProof): CriteriaResult {
  if (!proof.hustlerConfirmed) {
    return { valid: false, reason: 'Hustler must confirm session completion.' };
  }
  if (!proof.posterConfirmed) {
    return { valid: false, reason: 'Poster must confirm session completion before payment releases.' };
  }
  return { valid: true };
}

function validateHybridCriteria(proof: CompletionCriteriaProof): CriteriaResult {
  if (!proof.checkInAt || !proof.checkOutAt) {
    return { valid: false, reason: 'GPS check-in and check-out are required for this task type.' };
  }
  return { valid: true };
}

export function validateProofForCriteria(
  _taskId: string,
  proof: CompletionCriteriaProof,
): Promise<CriteriaResult> {
  switch (proof.type) {
    case 'photo_proof': return Promise.resolve(validatePhotoCriteria(proof));
    case 'check_in_check_out': return Promise.resolve(validateCheckinCriteria(proof));
    case 'session_completion': return Promise.resolve(validateSessionCriteria(proof));
    case 'hybrid': return Promise.resolve(validateHybridCriteria(proof));
    default: return Promise.resolve({ valid: false, reason: 'Unknown proof type — cannot validate.' });
  }
}
