/**
 * Health Router Unit Tests
 *
 * Tests all procedures in the health router:
 * - ping: returns { status: 'ok', timestamp }
 * - status: healthy when DB connected, degraded when not
 * - verifySchema: valid when no missing tables/triggers/views,
 *                 invalid when items missing, error when DB not connected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), healthCheck: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { env: 'test' },
    firebase: { projectId: 'test-project' },
    redis: { url: 'redis://localhost:6379' },
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: { isConfigured: vi.fn().mockReturnValue(true) },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { healthRouter } from '../../src/routers/health';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller() {
  // publicProcedure: no auth required — ctx can be empty
  return healthRouter.createCaller({} as any);
}

function makeProtectedCaller() {
  return healthRouter.createCaller({ user: { id: 'user-123' }, firebaseUid: 'firebase-uid-123' } as any);
}

function seedAdminRoleCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

function makeAdminCaller() {
  return healthRouter.createCaller({ user: { id: 'admin-user-123' }, firebaseUid: 'firebase-uid-admin' } as any);
}

// All expected tables, triggers, views from the router source
const ALL_TABLES = [
  'schema_versions', 'users', 'tasks', 'escrows', 'proofs', 'proof_photos', 'proof_videos',
  'xp_ledger', 'trust_ledger', 'badges', 'disputes', 'stripe_events',
  'ai_events', 'ai_jobs', 'ai_proposals', 'ai_decisions', 'evidence',
  'admin_roles', 'admin_actions', 'live_sessions', 'live_broadcasts',
  'poster_ratings', 'session_forecasts', 'task_matching_scores',
  'saved_searches', 'task_messages', 'notifications', 'notification_preferences',
  'task_ratings', 'analytics_events', 'fraud_risk_scores', 'fraud_patterns',
  'content_moderation_queue', 'content_reports', 'content_appeals',
  'gdpr_data_requests', 'user_consents',
];

const ALL_TRIGGERS = [
  'task_terminal_guard', 'escrow_terminal_guard', 'escrow_amount_immutable',
  'xp_requires_released_escrow', 'xp_ledger_no_delete', 'badge_no_delete',
  'escrow_released_requires_completed_task', 'task_completed_requires_accepted_proof',
  'trust_tier_audit', 'admin_actions_no_delete', 'live_task_escrow_check',
  'live_task_price_check', 'users_updated_at', 'tasks_updated_at',
  'escrows_updated_at', 'proofs_updated_at', 'disputes_updated_at',
  'ai_jobs_updated_at', 'evidence_updated_at',
];

const ALL_VIEWS = ['poster_reputation', 'money_timeline', 'user_rating_summary'];

// ---------------------------------------------------------------------------
// health.ping
// ---------------------------------------------------------------------------

describe('health.ping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns status ok with timestamp', async () => {
    const result = await makeCaller().ping();
    expect(result.status).toBe('ok');
    expect(result.timestamp).toBeDefined();
    expect(typeof result.timestamp).toBe('string');
  });

  it('timestamp is a valid ISO string', async () => {
    const result = await makeCaller().ping();
    const parsed = new Date(result.timestamp);
    expect(parsed.getTime()).not.toBeNaN();
  });
});

// ---------------------------------------------------------------------------
// health.status
// ---------------------------------------------------------------------------

describe('health.status', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns healthy status when DB is connected', async () => {
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true,
      schemaVersion: '1.1.0',
      latencyMs: 5,
    });

    const result = await makeProtectedCaller().status();

    expect(result.status).toBe('healthy');
    expect(result.services.database.connected).toBe(true);
    expect(result.services.database.schemaVersion).toBe('1.1.0');
    expect(result.services.database.latencyMs).toBe(5);
  });

  it('returns degraded status when DB is not connected', async () => {
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: false,
      schemaVersion: null,
      latencyMs: 0,
    });

    const result = await makeProtectedCaller().status();

    expect(result.status).toBe('degraded');
    expect(result.services.database.connected).toBe(false);
  });

  it('includes stripe, firebase, redis in services', async () => {
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 3,
    });

    const result = await makeProtectedCaller().status();

    expect(result.services.stripe).toBeDefined();
    expect(result.services.firebase).toBeDefined();
    expect(result.services.redis).toBeDefined();
    expect(result.services.stripe.configured).toBe(true);
    expect(result.services.firebase.configured).toBe(true);
    expect(result.services.redis.configured).toBe(true);
  });

  it('includes environment field', async () => {
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: null, latencyMs: 2,
    });

    const result = await makeProtectedCaller().status();

    expect(result.environment).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// health.verifySchema
// ---------------------------------------------------------------------------

describe('health.verifySchema', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns valid=false and error message when DB not connected', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: false, schemaVersion: null, latencyMs: 0,
    });

    const result = await makeAdminCaller().verifySchema();

    expect(result.valid).toBe(false);
    expect((result as any).error).toBe('Database not connected');
  });

  it('returns valid=true when all tables, triggers, and views present', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 4,
    });
    // Tables query
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TABLES.map(t => ({ table_name: t })),
      rowCount: ALL_TABLES.length,
    } as any);
    // Triggers query
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TRIGGERS.map(t => ({ tgname: t })),
      rowCount: ALL_TRIGGERS.length,
    } as any);
    // Views query
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_VIEWS.map(v => ({ table_name: v })),
      rowCount: ALL_VIEWS.length,
    } as any);

    const result = await makeAdminCaller().verifySchema();

    expect(result.valid).toBe(true);
    expect((result as any).tables.missing).toEqual([]);
    expect((result as any).triggers.missing).toEqual([]);
    expect((result as any).views.missing).toEqual([]);
  });

  it('reports missing tables', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 4,
    });
    // Tables: missing 'users' and 'tasks'
    const presentTables = ALL_TABLES.filter(t => t !== 'users' && t !== 'tasks');
    mockDb.query.mockResolvedValueOnce({
      rows: presentTables.map(t => ({ table_name: t })),
      rowCount: presentTables.length,
    } as any);
    // Triggers: all present
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TRIGGERS.map(t => ({ tgname: t })),
      rowCount: ALL_TRIGGERS.length,
    } as any);
    // Views: all present
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_VIEWS.map(v => ({ table_name: v })),
      rowCount: ALL_VIEWS.length,
    } as any);

    const result = await makeAdminCaller().verifySchema();

    expect(result.valid).toBe(false);
    expect((result as any).tables.missing).toContain('users');
    expect((result as any).tables.missing).toContain('tasks');
  });

  it('reports missing triggers', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 4,
    });
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TABLES.map(t => ({ table_name: t })),
      rowCount: ALL_TABLES.length,
    } as any);
    // Missing one trigger
    const presentTriggers = ALL_TRIGGERS.filter(t => t !== 'task_terminal_guard');
    mockDb.query.mockResolvedValueOnce({
      rows: presentTriggers.map(t => ({ tgname: t })),
      rowCount: presentTriggers.length,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_VIEWS.map(v => ({ table_name: v })),
      rowCount: ALL_VIEWS.length,
    } as any);

    const result = await makeAdminCaller().verifySchema();

    expect(result.valid).toBe(false);
    expect((result as any).triggers.missing).toContain('task_terminal_guard');
  });

  it('reports missing views', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 4,
    });
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TABLES.map(t => ({ table_name: t })),
      rowCount: ALL_TABLES.length,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TRIGGERS.map(t => ({ tgname: t })),
      rowCount: ALL_TRIGGERS.length,
    } as any);
    // Missing poster_reputation view
    const presentViews = ALL_VIEWS.filter(v => v !== 'poster_reputation');
    mockDb.query.mockResolvedValueOnce({
      rows: presentViews.map(v => ({ table_name: v })),
      rowCount: presentViews.length,
    } as any);

    const result = await makeAdminCaller().verifySchema();

    expect(result.valid).toBe(false);
    expect((result as any).views.missing).toContain('poster_reputation');
  });

  it('returns expected/actual counts for tables', async () => {
    seedAdminRoleCheck();
    (mockDb.healthCheck as any).mockResolvedValueOnce({
      connected: true, schemaVersion: '1.1.0', latencyMs: 4,
    });
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TABLES.map(t => ({ table_name: t })),
      rowCount: ALL_TABLES.length,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_TRIGGERS.map(t => ({ tgname: t })),
      rowCount: ALL_TRIGGERS.length,
    } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: ALL_VIEWS.map(v => ({ table_name: v })),
      rowCount: ALL_VIEWS.length,
    } as any);

    const result = await makeAdminCaller().verifySchema();

    expect((result as any).tables.expected).toBe(ALL_TABLES.length);
    expect((result as any).tables.actual).toBe(ALL_TABLES.length);
    expect((result as any).triggers.expected).toBe(ALL_TRIGGERS.length);
    expect((result as any).views.expected).toBe(ALL_VIEWS.length);
  });
});
