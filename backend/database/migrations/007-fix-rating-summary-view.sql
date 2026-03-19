-- Migration 007: Fix user_rating_summary view to include per-star counts and metadata
-- RatingService.UserRatingSummary requires: five_star_count, four_star_count,
-- three_star_count, two_star_count, one_star_count, commented_count, last_rating_at
-- which are missing from the view defined in 005-mega-schema-alignment.sql.

CREATE OR REPLACE VIEW user_rating_summary AS
SELECT
  ratee_id                                              AS user_id,
  AVG(stars)::NUMERIC(3,2)                              AS avg_rating,
  COUNT(*)                                              AS total_ratings,
  COUNT(*) FILTER (WHERE stars >= 4)                    AS positive_ratings,
  COUNT(*) FILTER (WHERE stars <= 2)                    AS negative_ratings,
  COUNT(*) FILTER (WHERE stars = 5)                     AS five_star_count,
  COUNT(*) FILTER (WHERE stars = 4)                     AS four_star_count,
  COUNT(*) FILTER (WHERE stars = 3)                     AS three_star_count,
  COUNT(*) FILTER (WHERE stars = 2)                     AS two_star_count,
  COUNT(*) FILTER (WHERE stars = 1)                     AS one_star_count,
  COUNT(*) FILTER (WHERE comment IS NOT NULL)           AS commented_count,
  MAX(created_at)                                       AS last_rating_at
FROM task_ratings
GROUP BY ratee_id;
