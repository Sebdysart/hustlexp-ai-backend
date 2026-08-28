/**
 * TaskRepository Unit Tests
 *
 * Tests all methods of TaskRepository with mocked db.query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB (must use vi.fn() inline) ──────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  default: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  },
}));

import { db } from '../../src/db';
import { TaskRepository } from '../../src/repositories/TaskRepository';

const repo = new TaskRepository();
const mockQuery = vi.mocked(db.query);

const mockTask = {
  id: 'task-1',
  poster_id: 'poster-1',
  worker_id: null as string | null,
  title: 'Test Task',
  description: 'A test task',
  price: 5000,
  state: 'OPEN' as const,
  created_at: new Date(),
  updated_at: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// findByPoster
// ============================================================================

describe('TaskRepository.findByPoster', () => {
  it('returns all tasks for a poster (no state filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    const result = await repo.findByPoster('poster-1');
    expect(result).toEqual([mockTask]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE poster_id = $1 ORDER BY created_at DESC'),
      ['poster-1']
    );
  });

  it('returns filtered tasks by state', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.findByPoster('poster-1', 'OPEN');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE poster_id = $1 AND state = $2'),
      ['poster-1', 'OPEN']
    );
  });

  it('returns empty array when no tasks found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByPoster('poster-1');
    expect(result).toEqual([]);
  });

  it('returns multiple tasks', async () => {
    const tasks = [mockTask, { ...mockTask, id: 'task-2' }];
    mockQuery.mockResolvedValueOnce({ rows: tasks, rowCount: 2 });
    const result = await repo.findByPoster('poster-1');
    expect(result).toHaveLength(2);
  });

  it('uses transaction context when provided', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.findByPoster('poster-1', undefined, { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ============================================================================
// findByWorker
// ============================================================================

describe('TaskRepository.findByWorker', () => {
  it('returns all tasks for a worker (no state filter)', async () => {
    const workerTask = { ...mockTask, worker_id: 'worker-1' };
    mockQuery.mockResolvedValueOnce({ rows: [workerTask], rowCount: 1 });
    const result = await repo.findByWorker('worker-1');
    expect(result).toEqual([workerTask]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE worker_id = $1 ORDER BY created_at DESC'),
      ['worker-1']
    );
  });

  it('returns filtered tasks by state for worker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.findByWorker('worker-1', 'ACCEPTED');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('WHERE worker_id = $1 AND state = $2'),
      ['worker-1', 'ACCEPTED']
    );
  });

  it('returns empty array when worker has no tasks', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findByWorker('worker-1');
    expect(result).toEqual([]);
  });

  it('uses transaction context for worker query', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findByWorker('worker-1', 'OPEN', { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// ============================================================================
// findOpen
// ============================================================================

describe('TaskRepository.findOpen', () => {
  it('returns open tasks with default pagination', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    const result = await repo.findOpen();
    expect(result).toEqual([mockTask]);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("WHERE state = 'OPEN'"),
      [20, 0]
    );
  });

  it('applies custom limit and offset', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findOpen(10, 20);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $1 OFFSET $2'),
      [10, 20]
    );
  });

  it('returns empty array when no open tasks', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.findOpen();
    expect(result).toEqual([]);
  });

  it('orders by created_at DESC', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await repo.findOpen();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
  });
});

// ============================================================================
// updateState
// ============================================================================

describe('TaskRepository.updateState', () => {
  it('updates task state to ACCEPTED', async () => {
    const updated = { ...mockTask, state: 'ACCEPTED' };
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    const result = await repo.updateState('task-1', 'ACCEPTED');
    expect(result).toEqual(updated);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET state = $1, updated_at = NOW()'),
      ['ACCEPTED', 'task-1']
    );
  });

  it('updates task state to COMPLETED', async () => {
    const updated = { ...mockTask, state: 'COMPLETED' };
    mockQuery.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });
    const result = await repo.updateState('task-1', 'COMPLETED');
    expect(result?.state).toBe('COMPLETED');
  });

  it('returns null when task not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.updateState('nonexistent', 'CANCELLED');
    expect(result).toBeNull();
  });

  it('uses transaction context for state update', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.updateState('task-1', 'OPEN', { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// assignWorker
// ============================================================================

describe('TaskRepository.assignWorker', () => {
  it('assigns a worker to a task', async () => {
    const assigned = { ...mockTask, worker_id: 'worker-1', state: 'ACCEPTED' };
    mockQuery.mockResolvedValueOnce({ rows: [assigned], rowCount: 1 });
    const result = await repo.assignWorker('task-1', 'worker-1');
    expect(result).toEqual(assigned);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("SET worker_id = $1, state = 'ACCEPTED'"),
      ['worker-1', 'task-1']
    );
  });

  it('includes accepted_at in the update', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.assignWorker('task-1', 'worker-1');
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('accepted_at = NOW()');
  });

  it('returns null when task not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await repo.assignWorker('nonexistent', 'worker-1');
    expect(result).toBeNull();
  });

  it('uses transaction context', async () => {
    const txQuery = vi.fn().mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.assignWorker('task-1', 'worker-1', { query: txQuery });
    expect(txQuery).toHaveBeenCalled();
  });
});

// ============================================================================
// create
// ============================================================================

describe('TaskRepository.create', () => {
  it('creates a task with required fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    const result = await repo.create({
      id: 'task-1',
      poster_id: 'poster-1',
      title: 'Test Task',
      description: 'A test task',
      price: 5000,
    });
    expect(result).toEqual(mockTask);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO tasks'),
      expect.arrayContaining(['task-1', 'poster-1', 'Test Task', 'A test task', 5000])
    );
  });

  it('defaults optional fields to null/defaults', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.create({
      id: 'task-2',
      poster_id: 'poster-1',
      title: 'Minimal Task',
      description: 'Minimal',
      price: 1000,
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull();    // requirements
    expect(params[6]).toBeNull();    // location
    expect(params[7]).toBeNull();    // category
    expect(params[8]).toBe('STANDARD'); // mode
    expect(params[9]).toBe(true);    // requires_proof
    expect(params[10]).toBeNull();   // deadline
  });

  it('uses provided optional fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    const deadline = new Date('2026-12-31');
    await repo.create({
      id: 'task-3',
      poster_id: 'poster-1',
      title: 'Full Task',
      description: 'Full details',
      price: 10000,
      requirements: 'Must have tools',
      location: 'Seattle, WA',
      category: 'moving',
      mode: 'LIVE',
      requires_proof: false,
      deadline,
    });
    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('Must have tools');
    expect(params[6]).toBe('Seattle, WA');
    expect(params[7]).toBe('moving');
    expect(params[8]).toBe('LIVE');
    expect(params[9]).toBe(false);
    expect(params[10]).toBe(deadline);
  });

  it('inserts with OPEN state by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [mockTask], rowCount: 1 });
    await repo.create({ id: 'task-1', poster_id: 'poster-1', title: 'T', description: 'D', price: 500 });
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain("'OPEN'");
  });
});

// ============================================================================
// Singleton export
// ============================================================================

describe('taskRepository singleton', () => {
  it('exports a TaskRepository instance', async () => {
    const { taskRepository } = await import('../../src/repositories/TaskRepository');
    expect(taskRepository).toBeInstanceOf(TaskRepository);
  });
});
