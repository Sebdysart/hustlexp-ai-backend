import type { FeedFilters, PublicFeedFilters, SearchFilters } from './TaskDiscoveryTypes.js';
import { taskEligibilityJoins, taskEligibilityPredicates } from './TaskEligibilityPolicy.js';

interface QuerySpec {
  sql: string;
  params: unknown[];
}

const FEED_ELIGIBILITY_PREDICATES = taskEligibilityPredicates();

// Pre-match discovery is an allowlisted projection. Never replace this with
// `t.*`: task rows also carry private identity and exact-location vault fields
// that must not cross the discovery boundary, even as ciphertext.
const PRE_MATCH_TASK_COLUMNS = `
        t.id, t.title, t.description, t.category, t.price,
        t.rough_location AS location, t.deadline, t.created_at, t.state,
        t.requires_proof, t.mode, t.hustler_payout_cents,
        t.estimated_duration_minutes, t.rough_location, t.risk_level,
        t.required_tools, t.requirements, t.scope_hash,
        t.cancellation_policy_version, t.late_cancel_pct,
        t.cancellation_window_hours,
        (SELECT economics_cell.minimum_provider_net_hourly_cents
           FROM zone_category_cells economics_cell
          WHERE economics_cell.id = t.liquidity_cell_id)
          AS minimum_provider_net_hourly_cents,
        (SELECT economics_cell.provider_earnings_policy_version
           FROM zone_category_cells economics_cell
          WHERE economics_cell.id = t.liquidity_cell_id)
          AS provider_earnings_policy_version`;

const PUBLIC_SORT: Record<string, string> = {
  newest: ' ORDER BY created_at DESC',
  price_high: ' ORDER BY price DESC',
  price_low: ' ORDER BY price ASC',
  deadline: ' ORDER BY deadline ASC NULLS LAST',
};

const FEED_SORT: Record<string, string> = {
  relevance: ' ORDER BY tms.relevance_score DESC',
  price: ' ORDER BY t.price DESC',
  distance: ' ORDER BY tms.distance_miles ASC',
  deadline: ' ORDER BY t.deadline ASC NULLS LAST',
};

function appendPublicFilters(spec: QuerySpec, filters: PublicFeedFilters): void {
  if (filters.category) {
    spec.params.push(filters.category);
    spec.sql += ` AND category = $${spec.params.length}`;
  }
  if (filters.min_price !== undefined) {
    spec.params.push(filters.min_price);
    spec.sql += ` AND price >= $${spec.params.length}`;
  }
  if (filters.max_price !== undefined) {
    spec.params.push(filters.max_price);
    spec.sql += ` AND price <= $${spec.params.length}`;
  }
}

function appendFeedFilters(spec: QuerySpec, filters: FeedFilters): void {
  const fieldFilters: Array<[unknown, string]> = [
    [filters.category, 't.category ='],
    [filters.min_price, 't.price >='],
    [filters.max_price, 't.price <='],
    [filters.max_distance_miles, 'tms.distance_miles <='],
  ];
  for (const [value, expression] of fieldFilters) {
    if (value === undefined) continue;
    spec.params.push(value);
    spec.sql += ` AND ${expression} $${spec.params.length}`;
  }
  if (filters.min_matching_score === undefined) {
    spec.sql += ' AND tms.matching_score >= 0.20';
    return;
  }
  spec.params.push(filters.min_matching_score);
  spec.sql += ` AND tms.matching_score >= $${spec.params.length}`;
}

function appendPagination(spec: QuerySpec, limit: number, offset: number): void {
  spec.params.push(limit, offset);
  spec.sql += ` LIMIT $${spec.params.length - 1} OFFSET $${spec.params.length}`;
}

export function publicFeedQuery(
  filters: PublicFeedFilters,
  limit: number,
  offset: number
): QuerySpec {
  const spec: QuerySpec = {
    sql: `
      SELECT
        id, title, description, category, price, rough_location AS location,
        deadline, created_at, state, requires_proof,
        mode, hustler_payout_cents, estimated_duration_minutes,
        rough_location, risk_level, required_tools, requirements, scope_hash,
        cancellation_policy_version, late_cancel_pct, cancellation_window_hours
      FROM tasks
      WHERE state = 'OPEN'`,
    params: [],
  };
  appendPublicFilters(spec, filters);
  spec.sql += PUBLIC_SORT[filters.sort_by || 'newest'] || PUBLIC_SORT.newest;
  appendPagination(spec, limit, offset);
  return spec;
}

export function personalizedFeedQuery(
  hustlerId: string,
  filters: FeedFilters,
  limit: number,
  offset: number
): QuerySpec {
  const spec: QuerySpec = {
    sql: `
      SELECT
        ${PRE_MATCH_TASK_COLUMNS},
        tms.matching_score::float8 AS matching_score,
        tms.relevance_score::float8 AS relevance_score,
        tms.distance_miles::float8 AS distance_miles
      FROM tasks t
      INNER JOIN task_matching_scores tms ON tms.task_id = t.id AND tms.hustler_id = $1
      ${taskEligibilityJoins('$1')}
      WHERE t.state = 'OPEN'
        AND tms.expires_at > NOW()
        ${FEED_ELIGIBILITY_PREDICATES}`,
    params: [hustlerId],
  };
  appendFeedFilters(spec, filters);
  spec.sql += FEED_SORT[filters.sort_by || 'relevance'] || FEED_SORT.relevance;
  appendPagination(spec, limit, offset);
  return spec;
}

export function eligibleTaskCandidatesQuery(hustlerId: string): QuerySpec {
  return {
    sql: `
      SELECT t.id
      FROM tasks t
      ${taskEligibilityJoins('$1')}
      WHERE t.state = 'OPEN'
        ${FEED_ELIGIBILITY_PREDICATES}
      ORDER BY t.created_at DESC, t.id DESC`,
    params: [hustlerId],
  };
}

export function searchQuery(
  hustlerId: string,
  filters: SearchFilters,
  limit: number,
  offset: number
): QuerySpec {
  const spec: QuerySpec = {
    sql: `
      SELECT
        ${PRE_MATCH_TASK_COLUMNS},
        tms.matching_score::float8 AS matching_score,
        tms.relevance_score::float8 AS relevance_score,
        tms.distance_miles::float8 AS distance_miles,
        ts_rank(to_tsvector('english', t.title || ' ' || COALESCE(t.description, '')), plainto_tsquery('english', $1))::float8 AS search_rank
      FROM tasks t
      INNER JOIN task_matching_scores tms ON tms.task_id = t.id AND tms.hustler_id = $2 AND tms.expires_at > NOW()
      ${taskEligibilityJoins('$2')}
      WHERE t.state = 'OPEN'
        ${FEED_ELIGIBILITY_PREDICATES}
        AND (
          to_tsvector('english', t.title || ' ' || COALESCE(t.description, '')) @@ plainto_tsquery('english', $1)
        )`,
    params: [filters.query, hustlerId],
  };
  if (filters.category) {
    spec.params.push(filters.category);
    spec.sql += ` AND t.category = $${spec.params.length}`;
  }
  spec.sql += ' ORDER BY search_rank DESC, COALESCE(tms.relevance_score, 0.5) DESC';
  appendPagination(spec, limit, offset);
  return spec;
}
