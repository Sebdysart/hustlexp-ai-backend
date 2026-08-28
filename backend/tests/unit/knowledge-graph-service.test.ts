// backend/tests/unit/knowledge-graph-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRecordObservation = vi.hoisted(() => vi.fn());

// Mock OpenAI before any imports — use a plain constructor so the singleton works
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      embeddings = {
        create: vi.fn().mockResolvedValue({
          data: [{ embedding: Array(1536).fill(0.01) }],
        }),
      };
    },
  };
});

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    readQuery: vi.fn(),
  },
}));

vi.mock('../../src/services/AIObservabilityService.js', () => ({
  AIObservabilityService: { record: mockRecordObservation },
  aiObservationHash: (value: unknown) => `test-hash-${String(value).length}`,
}));

import { db } from '../../src/db.js';
import { KnowledgeGraphService } from '../../src/services/KnowledgeGraphService.js';

const mockDb = vi.mocked(db);

const makeDocRow = (overrides = {}) => ({
  file_path: '/docs/specs/API_CONTRACT.md',
  section_header: 'task.create',
  content: 'Creates a new task with price validation',
  is_locked: true,
  similarity: 0.92,
  ...overrides,
});

describe('KnowledgeGraphService.queryDocs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordObservation.mockResolvedValue({ success: true, data: { observationId: 'observation-1' } });
  });

  it('returns mapped doc sections on success', async () => {
    mockDb.readQuery.mockResolvedValueOnce({
      rows: [makeDocRow(), makeDocRow({ section_header: 'task.accept', similarity: 0.85 })],
    } as any);

    const results = await KnowledgeGraphService.queryDocs('task creation procedure');

    expect(results).toHaveLength(2);
    expect(results[0].filePath).toBe('/docs/specs/API_CONTRACT.md');
    expect(results[0].sectionHeader).toBe('task.create');
    expect(results[0].similarity).toBe(0.92);
    expect(results[0].isLocked).toBe(true);
    expect(results[1].sectionHeader).toBe('task.accept');
  });

  it('returns empty array when no results', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [] } as any);

    const results = await KnowledgeGraphService.queryDocs('unknown query');

    expect(results).toHaveLength(0);
  });

  it('passes topK parameter to query', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [makeDocRow()] } as any);

    await KnowledgeGraphService.queryDocs('pricing rules', 3);

    const [, params] = (mockDb.readQuery as any).mock.calls[0];
    expect(params[1]).toBe(3); // topK = 3
  });

  it('defaults topK to 5', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [] } as any);

    await KnowledgeGraphService.queryDocs('some query');

    const [, params] = (mockDb.readQuery as any).mock.calls[0];
    expect(params[1]).toBe(5);
  });

  it('withholds an embedding when its observability receipt cannot be persisted', async () => {
    mockRecordObservation.mockResolvedValueOnce({
      success: false,
      error: { code: 'AI_OBSERVABILITY_REQUIRED', message: 'audit unavailable' },
    });
    await expect(KnowledgeGraphService.queryDocs('scope contract')).rejects.toThrow(
      'AI_OBSERVABILITY_REQUIRED',
    );
    expect(mockDb.readQuery).not.toHaveBeenCalled();
  });
});

describe('KnowledgeGraphService.getRelatedInvariants', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordObservation.mockResolvedValue({ success: true, data: { observationId: 'observation-1' } });
  });

  it('returns invariant sections', async () => {
    mockDb.readQuery.mockResolvedValueOnce({
      rows: [
        makeDocRow({ file_path: '/docs/INVARIANTS.md', section_header: 'INV-1: escrow_balance_check' }),
        makeDocRow({ file_path: '/docs/INVARIANTS.md', section_header: 'INV-3: xp_requires_released_escrow' }),
      ],
    } as any);

    const results = await KnowledgeGraphService.getRelatedInvariants('escrow');

    expect(results).toHaveLength(2);
    expect(results[0].sectionHeader).toContain('INV-1');
  });

  it('returns empty array when no invariants found', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [] } as any);

    const results = await KnowledgeGraphService.getRelatedInvariants('some_router');

    expect(results).toHaveLength(0);
  });
});

describe('KnowledgeGraphService.getContractForProcedure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordObservation.mockResolvedValue({ success: true, data: { observationId: 'observation-1' } });
  });

  it('returns contract sections for a procedure', async () => {
    mockDb.readQuery.mockResolvedValueOnce({
      rows: [
        makeDocRow({
          file_path: '/docs/specs/API_CONTRACT.md',
          section_header: 'task.create',
          content: 'POST /task.create — creates a task',
        }),
      ],
    } as any);

    const results = await KnowledgeGraphService.getContractForProcedure('task', 'create');

    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('task.create');
  });

  it('returns empty array when no contract found', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [] } as any);

    const results = await KnowledgeGraphService.getContractForProcedure('nonexistent', 'procedure');

    expect(results).toHaveLength(0);
  });

  it('passes vector string to query', async () => {
    mockDb.readQuery.mockResolvedValueOnce({ rows: [] } as any);

    await KnowledgeGraphService.getContractForProcedure('escrow', 'release');

    const [sql, params] = (mockDb.readQuery as any).mock.calls[0];
    expect(sql).toContain('API_CONTRACT');
    expect(params[0]).toContain('['); // vector format
  });
});
