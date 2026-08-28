import { processAutoRatings } from './RatingAutomationService.js';
import {
  getRatingById,
  getRatingStats,
  getRatingSummary,
  getRatingsForTask,
  getRatingsForUser,
  getTextReviewsForUser,
  hasRated,
} from './RatingReadService.js';
import { submitRating } from './RatingSubmissionService.js';

export type {
  CreateRatingParams,
  RatingStats,
  StructuredFeedback,
  TaskRating,
  TextReview,
  UserRatingSummary,
} from './RatingTypes.js';

export const RatingService = {
  getRatingById,
  getRatingsForTask,
  getRatingsForUser,
  getTextReviewsForUser,
  getRatingSummary,
  hasRated,
  submitRating,
  processAutoRatings,
  getRatingStats,
};
