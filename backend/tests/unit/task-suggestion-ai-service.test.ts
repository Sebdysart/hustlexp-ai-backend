// backend/tests/unit/task-suggestion-ai-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/TaskDiscoveryService.js', () => ({
  TaskDiscoveryService: {
    getFeed: vi.fn(),
  },
}));

vi.mock('../../src/services/WorkerSkillService.js', () => ({
  WorkerSkillService: {
    getWorkerSkills: vi.fn(),
  },
}));

vi.mock('../../src/services/AIClient.js', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(true),
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock('../../src/lib/pii-scrubber.js', () => ({
  scrubPII: (text: string) => text,
}));

vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
  aiLogger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import { TaskSuggestionAIService } from '../../src/services/TaskSuggestionAIService.js';
import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService.js';
import { WorkerSkillService } from '../../src/services/WorkerSkillService.js';
import { AIClient } from '../../src/services/AIClient.js';
import { db } from '../../src/db.js';

const mockDiscovery = vi.mocked(TaskDiscoveryService);
const mockSkills = vi.mocked(WorkerSkillService);
const mockAIClient = vi.mocked(AIClient);
const mockDb = vi.mocked(db);

const USER_ID = 'user-001';
const TASK_ID_1 = 'task-aaa-001';
const TASK_ID_2 = 'task-bbb-002';

const makeFeedItem = (taskId: string, overrides = {}) => ({
  task: { id: taskId, title: 'Fix my fence', category: 'outdoor', price: 5000 },
  matching_score: 0.85,
  relevance_score: 0.9,
  distance_miles: 2.3,
  explanation: 'Close by and good match for your skills',
  ...overrides,
});

const makeUserRow = (overrides = {}) => ({
  rows: [{ trust_tier: 2, zip_code: '60601', preferred_categories: ['outdoor'], completed: '15', ...overrides }],
  rowCount: 1,
});

describe('TaskSuggestionAIService.getSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSkills.getWorkerSkills.mockResolvedValue({ success: true, data: [] } as any);
    mockDb.query.mockResolvedValue(makeUserRow() as any);
  });

  it('returns AI-ranked suggestions on success', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1), makeFeedItem(TASK_ID_2)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({
      data: {
        suggestions: [
          { taskId: TASK_ID_1, reason: 'Great match for your outdoor skills', fitScore: 0.9 },
          { taskId: TASK_ID_2, reason: 'Close to you', fitScore: 0.75 },
        ],
      },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].aiReason).toBe('Great match for your outdoor skills');
    expect(result.data[0].fitScore).toBe(0.9);
  });

  it('returns empty array when feed is empty', async () => {
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: [] } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
    expect(mockAIClient.callJSON).not.toHaveBeenCalled();
  });

  it('returns feed failure when getFeed fails', async () => {
    mockDiscovery.getFeed.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Database unavailable' },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('DB_ERROR');
  });

  it('uses fallback when AIClient is not configured', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.isConfigured.mockReturnValueOnce(false);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].aiReason).toBe('Close by and good match for your skills');
    expect(mockAIClient.callJSON).not.toHaveBeenCalled();
  });

  it('uses fallback when AI returns null suggestions', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({ data: null } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].task.id).toBe(TASK_ID_1);
    expect(result.data[0].fitScore).toBe(0.85); // falls back to matching_score
  });

  it('uses fallback when AI returns empty suggestions', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1), makeFeedItem(TASK_ID_2)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({ data: { suggestions: [] } } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2); // all feed items in fallback
  });

  it('ignores duplicate taskIds from AI suggestions', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({
      data: {
        suggestions: [
          { taskId: TASK_ID_1, reason: 'Good match', fitScore: 0.9 },
          { taskId: TASK_ID_1, reason: 'Duplicate', fitScore: 0.5 },
        ],
      },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1); // duplicate removed
  });

  it('skips taskIds not in feed', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({
      data: {
        suggestions: [
          { taskId: 'nonexistent-id', reason: 'Phantom task', fitScore: 0.99 },
          { taskId: TASK_ID_1, reason: 'Real task', fitScore: 0.8 },
        ],
      },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0].task.id).toBe(TASK_ID_1);
  });

  it('uses explanation as aiReason when AI reason is empty', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({
      data: {
        suggestions: [{ taskId: TASK_ID_1, reason: '', fitScore: 0.8 }],
      },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].aiReason).toBe('Close by and good match for your skills');
  });

  it('uses matching_score as fitScore when AI fitScore is invalid', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockResolvedValueOnce({
      data: {
        suggestions: [{ taskId: TASK_ID_1, reason: 'Good', fitScore: 2.5 }], // out of range
      },
    } as any);

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].fitScore).toBe(0.85); // fallback to matching_score
  });

  it('respects limit parameter (max 20)', async () => {
    const feedItems = Array.from({ length: 25 }, (_, i) => makeFeedItem(`task-${i}`));
    mockDiscovery.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.isConfigured.mockReturnValueOnce(false); // use fallback

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID, { limit: 50 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.length).toBeLessThanOrEqual(20); // capped at 20
  });

  it('falls back to feed when AI throws an exception', async () => {
    const feedItems = [makeFeedItem(TASK_ID_1)];
    // First getFeed call throws (causing catch branch), second is for fallback
    mockDiscovery.getFeed
      .mockResolvedValueOnce({ success: true, data: feedItems } as any)
      .mockResolvedValueOnce({ success: true, data: feedItems } as any);
    mockAIClient.callJSON.mockRejectedValueOnce(new Error('AI service timeout'));

    const result = await TaskSuggestionAIService.getSuggestions(USER_ID);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].task.id).toBe(TASK_ID_1);
  });
});

describe('TaskSuggestionAIService.getUserProfileForAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns user profile with skills', async () => {
    mockDb.query.mockResolvedValueOnce(makeUserRow() as any);
    mockSkills.getWorkerSkills.mockResolvedValueOnce({
      success: true,
      data: [{ skill: { name: 'carpentry' }, skill_id: 'sk-1' }],
    } as any);

    const profile = await TaskSuggestionAIService.getUserProfileForAI(USER_ID);

    expect(profile.trust_tier).toBe(2);
    expect(profile.completed_tasks).toBe(15);
    expect(profile.skillNames).toContain('carpentry');
  });

  it('returns defaults when db query fails', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB error'));
    mockSkills.getWorkerSkills.mockRejectedValueOnce(new Error('Skills error'));

    const profile = await TaskSuggestionAIService.getUserProfileForAI(USER_ID);

    expect(profile.trust_tier).toBe(1);
    expect(profile.completed_tasks).toBe(0);
    expect(profile.skillNames).toHaveLength(0);
    expect(profile.preferred_categories).toHaveLength(0);
  });

  it('uses skill_id as fallback when skill name is missing', async () => {
    mockDb.query.mockResolvedValueOnce(makeUserRow() as any);
    mockSkills.getWorkerSkills.mockResolvedValueOnce({
      success: true,
      data: [{ skill_id: 'sk-no-name' }], // no skill.name
    } as any);

    const profile = await TaskSuggestionAIService.getUserProfileForAI(USER_ID);

    expect(profile.skillNames).toContain('sk-no-name');
  });

  it('returns empty skillNames when getWorkerSkills fails', async () => {
    mockDb.query.mockResolvedValueOnce(makeUserRow() as any);
    mockSkills.getWorkerSkills.mockResolvedValueOnce({ success: false, error: { code: 'ERR' } } as any);

    const profile = await TaskSuggestionAIService.getUserProfileForAI(USER_ID);

    expect(profile.skillNames).toHaveLength(0);
  });
});

describe('TaskSuggestionAIService.fallbackSuggestions', () => {
  it('maps feed items to suggestion results', () => {
    const feedItems = [makeFeedItem(TASK_ID_1), makeFeedItem(TASK_ID_2)];

    const result = TaskSuggestionAIService.fallbackSuggestions(feedItems, 10);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(2);
    expect(result.data[0].aiReason).toBe('Close by and good match for your skills');
    expect(result.data[0].fitScore).toBe(0.85);
  });

  it('limits results to the specified limit', () => {
    const feedItems = Array.from({ length: 10 }, (_, i) => makeFeedItem(`task-${i}`));

    const result = TaskSuggestionAIService.fallbackSuggestions(feedItems, 3);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(3);
  });

  it('returns empty array when feed is empty', () => {
    const result = TaskSuggestionAIService.fallbackSuggestions([], 10);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(0);
  });
});
