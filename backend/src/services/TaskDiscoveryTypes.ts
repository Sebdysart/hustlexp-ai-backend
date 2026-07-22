import type { WorkerOfferDecision } from './WorkerOfferDecisionPolicy.js';

export interface TaskMatchingScore {
  id: string;
  task_id: string;
  hustler_id: string;
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  calculated_at: Date;
  expires_at: Date;
}

export interface MatchingScoreComponents {
  trust_multiplier: number;
  distance_score: number;
  category_match: number;
  price_attractiveness: number;
  time_match: number;
}

export interface TaskFeedItem {
  task: TaskFeedRow;
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  explanation: string;
  offer_decision: WorkerOfferDecision;
}

export interface SavedSearch {
  id: string;
  user_id: string;
  name: string;
  query: string | null;
  filters: Record<string, unknown> | string;
  sort_by: string;
  created_at: Date;
}

export interface FeedFilters {
  category?: string;
  min_price?: number;
  max_price?: number;
  max_distance_miles?: number;
  min_matching_score?: number;
  sort_by?: 'relevance' | 'price' | 'distance' | 'deadline';
}

export interface SearchFilters extends FeedFilters {
  query?: string;
}

export interface PublicFeedFilters {
  category?: string;
  min_price?: number;
  max_price?: number;
  sort_by?: 'newest' | 'price_high' | 'price_low' | 'deadline';
}

export interface PublicTaskRow {
  id: string;
  title: string;
  description: string;
  category: string | null;
  price: number;
  location: string | null;
  deadline: string | null;
  created_at: string;
  state: string;
  requires_proof: boolean;
  mode: string;
  hustler_payout_cents: number | null;
  estimated_duration_minutes: number | null;
  rough_location: string | null;
  risk_level: string | null;
  required_tools: string[];
  requirements: string | null;
  scope_hash: string | null;
  cancellation_policy_version: string | null;
  late_cancel_pct: number | null;
  cancellation_window_hours: number | null;
}

export interface TaskFeedRow {
  id: string;
  title: string;
  description: string;
  category: string | null;
  price: number;
  location: string | null;
  deadline: string | null;
  created_at: string;
  state: string;
  requires_proof: boolean;
  mode: string;
  poster_id?: string;
  hustler_payout_cents?: number | null;
  estimated_duration_minutes?: number | null;
  rough_location?: string | null;
  risk_level?: string | null;
  required_tools?: string[];
  requirements?: string | null;
  scope_hash?: string | null;
  cancellation_policy_version?: string | null;
  late_cancel_pct?: number | null;
  cancellation_window_hours?: number | null;
  minimum_provider_net_hourly_cents?: number | null;
  provider_earnings_policy_version?: string | null;
  matching_score: number;
  relevance_score: number;
  distance_miles: number;
  search_rank?: number;
}

export interface ExplanationContext {
  matching_score: number;
  distance_miles: number;
  category: string;
  price: number;
}
