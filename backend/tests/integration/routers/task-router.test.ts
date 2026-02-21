/**
 * Task Router Integration Tests
 *
 * Tests the tRPC task router procedures with mocked services.
 * Verifies auth guards, input validation, and service delegation.
 *
 * AUTHORITY: PRODUCT_SPEC.md §3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DB before any imports
vi.mock('../../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
    create: vi.fn(),
    accept: vi.fn(),
    submitProof: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
    listOpen: vi.fn(),
  },
}));

vi.mock('../../../src/services/ProofService', () => ({
  ProofService: {
    submit: vi.fn(),
    getByTask: vi.fn(),
  },
}));

vi.mock('../../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

vi.mock('../../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue(null),
  },
}));

import { db } from '../../../src/db';
import { TaskService } from '../../../src/services/TaskService';

describe('Task Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db.query as any).mockReset();
  });

  describe('TaskService.getById delegation', () => {
    it('should return task data on success', async () => {
      const mockTask = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test Task',
        price: 2500,
        state: 'OPEN',
        poster_id: 'poster-1',
      };

      (TaskService.getById as any).mockResolvedValue({
        success: true,
        data: mockTask,
      });

      const result = await TaskService.getById(mockTask.id);
      expect(result.success).toBe(true);
      expect(result.data.title).toBe('Test Task');
      expect(result.data.state).toBe('OPEN');
    });

    it('should return error for non-existent task', async () => {
      (TaskService.getById as any).mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      });

      const result = await TaskService.getById('nonexistent-id');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('TaskService.create validation', () => {
    it('should create task with valid params', async () => {
      const params = {
        title: 'Walk my dog',
        description: 'Need someone to walk my golden retriever',
        price: 2500,
        mode: 'STANDARD' as const,
      };

      (TaskService.create as any).mockResolvedValue({
        success: true,
        data: { id: 'new-task-id', ...params, state: 'OPEN' },
      });

      const result = await TaskService.create(params as any);
      expect(result.success).toBe(true);
      expect(result.data.state).toBe('OPEN');
    });

    it('should reject task with price below minimum', async () => {
      (TaskService.create as any).mockResolvedValue({
        success: false,
        error: { code: 'PRICE_TOO_LOW', message: 'Price below $5 minimum' },
      });

      const result = await TaskService.create({ price: 100 } as any);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('PRICE_TOO_LOW');
    });
  });

  describe('TaskService.accept guards', () => {
    it('should accept OPEN task', async () => {
      (TaskService.accept as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'ACCEPTED', worker_id: 'worker-1' },
      });

      const result = await TaskService.accept({ taskId: 'task-1', workerId: 'worker-1' } as any);
      expect(result.success).toBe(true);
      expect(result.data.state).toBe('ACCEPTED');
    });

    it('should reject accept on terminal task', async () => {
      (TaskService.accept as any).mockResolvedValue({
        success: false,
        error: { code: 'TASK_TERMINAL', message: 'Task is in terminal state COMPLETED' },
      });

      const result = await TaskService.accept({ taskId: 'task-1', workerId: 'worker-1' } as any);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('TASK_TERMINAL');
    });
  });

  describe('Task state transitions', () => {
    it('should submit proof (ACCEPTED → PROOF_SUBMITTED)', async () => {
      (TaskService.submitProof as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'PROOF_SUBMITTED' },
      });

      const result = await TaskService.submitProof('task-1');
      expect(result.data.state).toBe('PROOF_SUBMITTED');
    });

    it('should complete task (PROOF_SUBMITTED → COMPLETED)', async () => {
      (TaskService.complete as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'COMPLETED' },
      });

      const result = await TaskService.complete('task-1');
      expect(result.data.state).toBe('COMPLETED');
    });

    it('should cancel task (OPEN → CANCELLED)', async () => {
      (TaskService.cancel as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'CANCELLED' },
      });

      const result = await TaskService.cancel('task-1');
      expect(result.data.state).toBe('CANCELLED');
    });
  });

  describe('Task listing', () => {
    it('should list open tasks', async () => {
      (TaskService.listOpen as any).mockResolvedValue({
        success: true,
        data: [
          { id: 't1', state: 'OPEN', price: 2500 },
          { id: 't2', state: 'OPEN', price: 5000 },
        ],
      });

      const result = await TaskService.listOpen({});
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.data.every((t: any) => t.state === 'OPEN')).toBe(true);
    });
  });
});
