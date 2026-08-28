import {
  initiateBackgroundCheck,
  reviewBackgroundCheck,
  updateBackgroundCheckStatus,
} from './BackgroundCheckMutationService.js';
import {
  getChecksByStatus,
  getPendingReviews,
  getUpcomingExpirations,
  getUserBackgroundCheck,
  hasValidBackgroundCheck,
  markExpiredChecks,
} from './BackgroundCheckReadService.js';

export type {
  BackgroundCheck,
  BackgroundCheckInitiation,
} from './BackgroundCheckTypes.js';

export {
  getChecksByStatus,
  getPendingReviews,
  getUpcomingExpirations,
  getUserBackgroundCheck,
  hasValidBackgroundCheck,
  initiateBackgroundCheck,
  markExpiredChecks,
  reviewBackgroundCheck,
  updateBackgroundCheckStatus,
};

export default {
  initiateBackgroundCheck,
  updateBackgroundCheckStatus,
  reviewBackgroundCheck,
  getUserBackgroundCheck,
  hasValidBackgroundCheck,
  getPendingReviews,
  getChecksByStatus,
  markExpiredChecks,
  getUpcomingExpirations,
};
