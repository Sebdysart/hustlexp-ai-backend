import {
  browsePublicFeed,
  getFeed,
  search,
} from './TaskDiscoveryFeedService.js';
import { getExplanation } from './TaskDiscoveryExplanationService.js';
import {
  deleteSavedSearch,
  executeSavedSearch,
  getSavedSearches,
  saveSearch,
} from './TaskDiscoverySavedSearchService.js';
import {
  calculateFeedScores,
  calculateMatchingScore,
} from './TaskDiscoveryScoreService.js';

export type {
  FeedFilters,
  MatchingScoreComponents,
  SavedSearch,
  SearchFilters,
  TaskFeedItem,
  TaskFeedRow,
  TaskMatchingScore,
} from './TaskDiscoveryTypes.js';

export const TaskDiscoveryService = {
  browsePublicFeed,
  calculateMatchingScore,
  calculateFeedScores,
  getFeed,
  search,
  getExplanation,
  saveSearch,
  getSavedSearches,
  deleteSavedSearch,
  executeSavedSearch,
};
