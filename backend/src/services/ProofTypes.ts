import type { Proof } from '../types.js';

export interface ProofPhotoEvidence {
  uploadReceiptId: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  fileSizeBytes: number;
  checksumSha256: string;
  capturedAt?: string;
}

export interface SubmitProofParams {
  taskId: string;
  submitterId: string;
  description?: string;
  photoUrls?: string[];
  photoEvidence?: ProofPhotoEvidence[];
  gpsLatitude?: number;
  gpsLongitude?: number;
  gpsAccuracyMeters?: number;
  biometricHash?: string;
  scopeVersionId?: string;
  scopeHash?: string;
  clientSubmissionId?: string;
  clientSequence?: number;
  priorTaskVersion?: number;
  localOccurredAt?: string;
  deviceVersion?: string;
  appVersion?: string;
  offlinePayloadHash?: string;
}

export interface AddPhotoParams {
  proofId: string;
  storageKey: string;
  contentType: string;
  fileSizeBytes: number;
  checksumSha256: string;
  captureTime?: Date;
  sequenceNumber?: number;
}

export interface AddVideoParams {
  proofId: string;
  storageKey: string;
  contentType?: string;
  fileSizeBytes?: number;
  durationSeconds?: number;
  sequenceNumber?: number;
}

export interface ReviewProofParams {
  proofId: string;
  reviewerId: string;
  decision: 'ACCEPTED' | 'REJECTED';
  reason?: string;
}

export type ProofWithSignals = Proof & {
  photo_url?: string;
  gps_coordinates?: { latitude: number; longitude: number } | string | null;
  gps_accuracy_meters?: number | string | null;
  lidar_depth_map_url?: string;
};

export interface CompletionCriteriaProof {
  type: 'photo_proof' | 'check_in_check_out' | 'session_completion' | 'hybrid';
  photoUrls?: string[];
  checkInAt?: string | null;
  checkOutAt?: string | null;
  hustlerConfirmed?: boolean;
  posterConfirmed?: boolean;
}
