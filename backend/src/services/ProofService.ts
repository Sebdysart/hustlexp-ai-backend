import {
  addProofPhoto,
  addProofVideo,
  getProofById,
  getProofByTaskId,
  getProofPhotos,
  getProofVideos,
} from './ProofDataService.js';
import { validateProofForCriteria } from './ProofPolicy.js';
import { reviewProof } from './ProofReviewService.js';
import { submitProof } from './ProofSubmissionService.js';

export type {
  AddPhotoParams,
  AddVideoParams,
  CompletionCriteriaProof,
  ProofPhotoEvidence,
  ReviewProofParams,
  SubmitProofParams,
} from './ProofTypes.js';

export const ProofService = {
  getById: getProofById,
  getByTaskId: getProofByTaskId,
  getPhotos: getProofPhotos,
  getVideos: getProofVideos,
  submit: submitProof,
  addPhoto: addProofPhoto,
  addVideo: addProofVideo,
  review: reviewProof,
  validateProofForCriteria,
};

export default ProofService;
