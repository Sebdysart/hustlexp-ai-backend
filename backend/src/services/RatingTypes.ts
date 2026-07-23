export interface TaskRating {
  id: string;
  task_id: string;
  rater_id: string;
  ratee_id: string;
  stars: number;
  comment?: string;
  tags?: string[];
  structured_feedback?: StructuredFeedback;
  is_public: boolean;
  is_blind: boolean;
  is_auto_rated: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface UserRatingSummary {
  user_id: string;
  total_ratings: number;
  avg_rating: number;
  five_star_count: number;
  four_star_count: number;
  three_star_count: number;
  two_star_count: number;
  one_star_count: number;
  commented_count: number;
  last_rating_at: Date | null;
}

export interface CreateRatingParams {
  taskId: string;
  raterId: string;
  stars: number;
  comment?: string;
  tags?: string[];
  structuredFeedback?: StructuredFeedback;
}

export interface StructuredFeedback {
  communication: number;
  scopeAccuracy: number;
  punctuality: number;
  care: number;
  resultQuality: number;
  value: number;
}

export interface RatingStats {
  totalRatings: number;
  averageRating: number;
  ratingDistribution: {
    five: number;
    four: number;
    three: number;
    two: number;
    one: number;
  };
  recentRatings: TaskRating[];
}

export interface TextReview {
  id: string;
  task_id: string;
  task_title: string | null;
  stars: number;
  text: string;
  created_at: Date;
  is_auto_rated: boolean;
}

export const RATING_WINDOW_DAYS = 7;

export function validStructuredFeedback(value: StructuredFeedback): boolean {
  return Object.values(value).length === 6
    && Object.values(value).every((score) => Number.isInteger(score) && score >= 1 && score <= 5);
}
