/**
 * HustleXP Test Setup
 * 
 * Shared configuration for invariant tests using Neon PostgreSQL
 */

import pg from 'pg';

const { Pool } = pg;

// Use environment variable — DATABASE_URL must be set in .env or CI
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * True when DATABASE_URL is available.
 * Use with `describe.skipIf(!hasDb)` to gracefully skip DB tests in environments
 * without a database (e.g., local development without Neon, pure unit-test CI runs).
 */
export const hasDb = !!DATABASE_URL;

function databaseSsl(connectionString: string): false | { rejectUnauthorized: false } {
  const url = new URL(connectionString);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const sslDisabled = url.searchParams.get('sslmode') === 'disable';
  return isLoopback || sslDisabled ? false : { rejectUnauthorized: false };
}

export function createTestPool(): pg.Pool {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Set it in .env or as an environment variable.\n' +
      'Example: DATABASE_URL=postgresql://user:pass@host/db?sslmode=require'
    );
  }
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: databaseSsl(DATABASE_URL),
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

// Generate unique test run ID to avoid conflicts between test runs
const TEST_RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * Get test email with unique run ID to avoid conflicts
 */
export function getTestEmail(name: string): string {
  return `test-${TEST_RUN_ID}-${name}@hustlexp.test`;
}

/**
 * Clean up test data from this specific test run
 * Note: Cannot delete from append-only tables (xp_ledger, badges) due to triggers
 * Using unique TEST_RUN_ID ensures no conflicts between runs
 */
export async function cleanupTestData(pool: pg.Pool): Promise<void> {
  const pattern = `test-${TEST_RUN_ID}-%@hustlexp.test`;
  
  // Delete in order that respects foreign keys
  // Skip xp_ledger and badges - they're append-only and uniqueness is guaranteed by TEST_RUN_ID
  await pool.query('DELETE FROM trust_ledger WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)', [pattern]);
  await pool.query('DELETE FROM proof_videos WHERE proof_id IN (SELECT p.id FROM proofs p JOIN tasks t ON p.task_id = t.id JOIN users u ON t.poster_id = u.id WHERE u.email LIKE $1)', [pattern]);
  await pool.query('DELETE FROM proof_photos WHERE proof_id IN (SELECT p.id FROM proofs p JOIN tasks t ON p.task_id = t.id JOIN users u ON t.poster_id = u.id WHERE u.email LIKE $1)', [pattern]);
  await pool.query('DELETE FROM proofs WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM escrows WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM disputes WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))', [pattern]);
  await pool.query('DELETE FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1)', [pattern]);
  // Don't delete users if they have xp_ledger/badges entries (FK constraint)
  // await pool.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
}

/**
 * Create a test user
 */
export function createTestUser(pool: pg.Pool): Promise<{ id: string }>;
export function createTestUser(pool: pg.Pool, email: string): Promise<string>;
export async function createTestUser(
  pool: pg.Pool,
  email?: string,
): Promise<string | { id: string }> {
  const resolvedEmail = email ?? getTestEmail(`user-${crypto.randomUUID()}`);
  const result = await pool.query(
    `INSERT INTO users (email, full_name, default_mode)
     VALUES ($1, $2, 'worker')
     RETURNING id`,
    [resolvedEmail, 'Test User']
  );
  const id = result.rows[0].id as string;
  return email === undefined ? { id } : id;
}

/**
 * Create a test task
 */
type TestTaskInput = {
  posterId: string;
  workerId?: string;
  state?: string;
  trustTierRequired?: number;
  cancellationPolicyVersion?: string;
  mutualConsentRequired?: boolean;
  mutualConsentAccepted?: boolean;
};

export function createTestTask(pool: pg.Pool, input: TestTaskInput): Promise<{ id: string }>;
export function createTestTask(
  pool: pg.Pool,
  posterId: string,
  state?: string,
  requiresProof?: boolean,
): Promise<string>;
export async function createTestTask(
  pool: pg.Pool,
  input: string | TestTaskInput,
  requestedState: string = 'OPEN',
  _requiresProof: boolean = false,
): Promise<string | { id: string }> {
  const objectInput = typeof input === 'object';
  const posterId = objectInput ? input.posterId : input;
  const state = objectInput ? (input.state ?? 'OPEN') : requestedState;
  let workerId = objectInput
    ? (input.workerId ?? null)
    : null;
  if (state === 'ACCEPTED' && !workerId) {
    const worker = await createTestUser(pool);
    workerId = worker.id;
  }
  if (state === 'ACCEPTED' && workerId) {
    await pool.query(
      `UPDATE users
       SET default_mode = 'worker', trust_tier = GREATEST(trust_tier, 2),
           date_of_birth = DATE '1990-01-01', is_minor = FALSE,
           is_banned = FALSE, trust_hold = FALSE, trust_hold_until = NULL,
           account_status = 'ACTIVE',
           is_verified = TRUE,
           phone = COALESCE(phone, '+1206' || substr(replace(id::text, '-', ''), 1, 7)),
           stripe_connect_id = COALESCE(stripe_connect_id, 'acct_test_' || replace(id::text, '-', '')),
           payouts_enabled = TRUE
       WHERE id = $1`,
      [workerId],
    );
    await pool.query(
      `INSERT INTO capability_profiles (user_id, trust_tier, risk_clearance, updated_at)
       SELECT id, trust_tier,
              CASE WHEN trust_tier >= 3 THEN ARRAY['low','medium','high']::text[]
                   WHEN trust_tier = 2 THEN ARRAY['low','medium']::text[]
                   ELSE ARRAY['low']::text[] END,
              NOW()
       FROM users WHERE id = $1
       ON CONFLICT (user_id) DO UPDATE SET
         trust_tier = EXCLUDED.trust_tier,
         risk_clearance = EXCLUDED.risk_clearance,
         updated_at = NOW()`,
      [workerId],
    );
  }
  const insertState = state === 'ACCEPTED' ? 'OPEN' : state;
  const result = await pool.query(
    `WITH seeded_cells AS (
       INSERT INTO zone_category_cells (
         geo_zone, geography_label, category, operating_window, state,
         policy_version, launch_cell_enabled, green_category,
         metrics_computed_at, evaluated_at, stable_since,
         state_reasons, completed_tasks_total, paid_tasks_30d, fill_rate_30d,
         active_verified_providers, anchor_demand_accounts,
         average_contribution_cents, dispute_rate_30d, no_show_rate_30d,
         cancellation_rate_30d, repeat_demand_rate_30d,
         dispatch_allowed, public_instant_requests_allowed, expansion_eligible,
         max_concurrent_dispatches
       ) VALUES
         ('hx-test-wa', 'HX isolated test zone', 'yard', 'always', 'OPEN',
          'hx-test-v1', TRUE, TRUE, NOW(), NOW(), NOW(), '[]',
          100, 20, 1, 20, 2, 1000, 0, 0, 0, 1, TRUE, TRUE, FALSE, 1000),
         ('hx-test-wa', 'HX isolated test zone', 'moving', 'always', 'OPEN',
          'hx-test-v1', TRUE, TRUE, NOW(), NOW(), NOW(), '[]',
          100, 20, 1, 20, 2, 1000, 0, 0, 0, 1, TRUE, TRUE, FALSE, 1000)
       ON CONFLICT (geo_zone, category, operating_window) DO UPDATE SET
         state = 'OPEN', launch_cell_enabled = TRUE, green_category = TRUE,
         metrics_computed_at = NOW(), evaluated_at = NOW(),
         average_contribution_cents = 1000, dispatch_allowed = TRUE,
         max_concurrent_dispatches = 1000, updated_at = NOW()
       RETURNING id, geo_zone, category
     ), policy AS (
       SELECT id, region_code, version, policy_hash, policy_document
       FROM region_policies
       WHERE region_code = 'US-WA' AND policy_state = 'ACTIVE'
         AND effective_from <= clock_timestamp()
         AND (effective_until IS NULL OR effective_until > clock_timestamp())
       ORDER BY effective_from DESC, created_at DESC
       LIMIT 1
     ), yard_cell AS (
       SELECT id, geo_zone FROM seeded_cells WHERE category = 'yard'
     )
     INSERT INTO tasks (
       poster_id, worker_id, title, description, price, state, requires_proof,
       category, risk_level, automation_classification,
       hustler_payout_cents, platform_margin_cents,
       template_slug, trust_tier_required, completion_criteria,
       content_release, mutual_consent_required, mutual_consent_accepted,
       cancellation_window_hours,
       late_cancel_pct, cancellation_policy_version, illegal_risk_score,
       compliance_guardian_notes, estimated_duration_minutes, scope_hash,
       rough_location,
       region_code, region_policy_id, region_policy_version, region_policy_hash,
       region_policy_snapshot, trade_type, location_state,
       license_required, insurance_required, background_check_required,
       proof_min_photos, proof_max_photos, proof_gps_required, currency,
       geo_zone, liquidity_cell_id
     )
     SELECT
       $1, $3, 'Test Task', 'Test Description', 5000, $2, TRUE,
       'yard', 'LOW', 'CONTROLLED_TEST', 4000, 1000,
       'standard_physical', $4, '{"type":"photo_proof"}'::jsonb,
       FALSE, $6, $7, 24, 0, $5, 0,
       '{}'::jsonb, 60, repeat('e', 64), 'Seattle, WA',
       p.region_code, p.id, p.version, p.policy_hash,
       jsonb_build_object(
         'policyId', p.id::text,
         'policyVersion', p.version,
         'policyHash', p.policy_hash,
         'regionCode', p.region_code,
         'locationState', split_part(p.region_code, '-', 2),
         'licenseRequired', (p.policy_document#>>'{categories,yard,credentials,licenseRequired}')::boolean,
         'insuranceRequired', (p.policy_document#>>'{categories,yard,credentials,insuranceRequired}')::boolean,
         'backgroundCheckRequired', (p.policy_document#>>'{categories,yard,credentials,backgroundCheckRequired}')::boolean,
         'proofRequired', (p.policy_document#>>'{categories,yard,evidence,proofRequired}')::boolean,
         'proofMinPhotos', (p.policy_document#>>'{categories,yard,evidence,minPhotos}')::integer,
         'proofMaxPhotos', (p.policy_document#>>'{categories,yard,evidence,maxPhotos}')::integer,
         'proofGpsRequired', (p.policy_document#>>'{categories,yard,evidence,gpsRequired}')::boolean,
         'recordingAllowed', (p.policy_document#>>'{recording,allowed}')::boolean,
         'recordingStandaloneConsentRequired', (p.policy_document#>>'{recording,standaloneConsentRequired}')::boolean,
         'screeningStandaloneConsentRequired', (p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::boolean,
         'screeningReportAccessRequired', (p.policy_document#>>'{workerRights,reportAccessRequired}')::boolean,
         'screeningDisputeAndAppealRequired', (p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::boolean,
         'screeningAdverseActionNoticeRequired', (p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::boolean,
         'safetyIncidentIntakeRequired', (p.policy_document#>>'{safety,incidentIntakeRequired}')::boolean,
         'safetyTimedCheckinRequired', (p.policy_document#>'{safety,timedCheckinRiskLevels}') ? 'LOW',
         'safetyCheckinIntervalsMinutes', p.policy_document#>'{safety,checkinIntervalsMinutes}',
         'safetyLocationRetentionDays', (p.policy_document#>>'{safety,locationRetentionDays}')::integer,
         'safetyAlternateEmergencyActionRequired', (p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::boolean,
         'currency', p.policy_document#>>'{financial,currency}'
       ),
       'yard', split_part(p.region_code, '-', 2),
       (p.policy_document#>>'{categories,yard,credentials,licenseRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,credentials,insuranceRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,credentials,backgroundCheckRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,evidence,minPhotos}')::integer,
       (p.policy_document#>>'{categories,yard,evidence,maxPhotos}')::integer,
       (p.policy_document#>>'{categories,yard,evidence,gpsRequired}')::boolean,
       p.policy_document#>>'{financial,currency}',
       c.geo_zone, c.id
     FROM policy p CROSS JOIN yard_cell c
     RETURNING id`,
    [
      posterId,
      insertState,
      workerId,
      objectInput ? (input.trustTierRequired ?? 1) : 1,
      objectInput ? (input.cancellationPolicyVersion ?? 'task-template-v2:standard_physical:0') : 'task-template-v2:standard_physical:0',
      objectInput ? (input.mutualConsentRequired ?? false) : false,
      objectInput ? (input.mutualConsentAccepted ?? false) : false,
    ]
  );
  if (result.rowCount !== 1) throw new Error('Active US-WA controlled-test region policy is unavailable');
  const id = result.rows[0].id as string;
  if (state === 'ACCEPTED') {
    if (!workerId) throw new Error('Accepted test task requires a worker');
    await pool.query(
      `INSERT INTO escrows (task_id, amount, state)
       VALUES ($1, 5000, 'FUNDED')`,
      [id],
    );
    await pool.query(
      `INSERT INTO worker_offer_decisions (
         task_id, worker_id, policy_version, payload_hash, decision_ready,
         blocking_reasons, customer_total_cents, payout_cents,
         estimated_net_hourly_cents, distance_miles, estimated_duration_minutes,
         scope_hash, cancellation_policy_version, rank_score, rank_reasons,
         snapshot, expires_at
       )
       SELECT id, $2, 'hx-test-v1', repeat('a', 64), TRUE,
              '[]', price, hustler_payout_cents,
              4000, 0, 60, scope_hash, cancellation_policy_version,
              1, '[]', '{}', NOW() + INTERVAL '1 hour'
       FROM tasks WHERE id = $1`,
      [id, workerId],
    );
    await pool.query(`UPDATE tasks SET state = 'ACCEPTED' WHERE id = $1`, [id]);
  }
  return objectInput ? { id } : id;
}

/**
 * Create a test escrow
 */
type TestEscrowInput = { taskId: string; state?: string };

export function createTestEscrow(pool: pg.Pool, input: TestEscrowInput): Promise<{ id: string }>;
export function createTestEscrow(pool: pg.Pool, taskId: string, state?: string): Promise<string>;
export async function createTestEscrow(
  pool: pg.Pool,
  input: string | TestEscrowInput,
  requestedState: string = 'PENDING',
): Promise<string | { id: string }> {
  const objectInput = typeof input === 'object';
  const taskId = objectInput ? input.taskId : input;
  const state = objectInput ? (input.state ?? 'PENDING') : requestedState;
  const existing = await pool.query<{ id: string; state: string }>(
    'SELECT id, state FROM escrows WHERE task_id = $1',
    [taskId],
  );
  if (existing.rows[0]?.state === state) {
    return objectInput ? { id: existing.rows[0].id } : existing.rows[0].id;
  }
  // REFUND_PARTIAL state requires refund_amount + release_amount = amount
  if (state === 'REFUND_PARTIAL') {
    const result = await pool.query(
      `INSERT INTO escrows (task_id, amount, state, refund_amount, release_amount)
       VALUES ($1, 5000, $2, 2500, 2500)
       RETURNING id`,
      [taskId, state]
    );
    const id = result.rows[0].id as string;
    return objectInput ? { id } : id;
  }
  
  const result = await pool.query(
    `INSERT INTO escrows (task_id, amount, state)
     VALUES ($1, 5000, $2)
     RETURNING id`,
    [taskId, state]
  );
  const id = result.rows[0].id as string;
  return objectInput ? { id } : id;
}

/**
 * Create a test proof
 */
export async function createTestProof(
  pool: pg.Pool,
  taskId: string,
  submitterId: string,
  state: string = 'PENDING'
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO proofs (task_id, submitter_id, state, description)
     VALUES ($1, $2, $3, 'Test proof description')
     RETURNING id`,
    [taskId, submitterId, state]
  );
  return result.rows[0].id;
}

/**
 * Update escrow state directly (for testing)
 */
export async function setEscrowState(
  pool: pg.Pool,
  escrowId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE escrows SET state = $1 WHERE id = $2`,
    [state, escrowId]
  );
}

/**
 * Update task state directly (for testing)
 */
export async function setTaskState(
  pool: pg.Pool,
  taskId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE tasks SET state = $1 WHERE id = $2`,
    [state, taskId]
  );
}

/**
 * Update proof state directly (for testing)
 */
export async function setProofState(
  pool: pg.Pool,
  proofId: string,
  state: string
): Promise<void> {
  await pool.query(
    `UPDATE proofs SET state = $1 WHERE id = $2`,
    [state, proofId]
  );
}
