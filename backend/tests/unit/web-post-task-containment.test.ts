import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { webPostTaskRouter } from '../../src/routers/web/postTask.js';

const VALID_INPUT = {
  lead: {
    submission_id: '00000000-0000-4000-8000-000000000001',
    lead_type: 'poster' as const,
    email: 'poster@example.test',
    consent_version: 'v1' as const,
  },
  task: {
    category: 'yard',
    title: 'Trim the front hedge',
  },
};

describe('legacy webPostTask containment', () => {
  it('returns a stable tombstone and creates no legacy intake state', async () => {
    const caller = webPostTaskRouter.createCaller({
      user: null,
      firebaseUid: null,
      ip: '203.0.113.10',
    });

    await expect(caller.start(VALID_INPUT)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      cause: { applicationCode: 'LEGACY_TASK_DRAFT_WRITER_TOMBSTONED' },
    });
  });

  it('contains no database, generated-quote, or legacy writer dependency', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/routers/web/postTask.ts'),
      'utf8',
    );
    expect(source).toContain('webTaskDrafts.submit');
    expect(source).not.toContain("from '../../db.js'");
    expect(source).not.toContain('QuoteGenerationService');
    expect(source).not.toMatch(/INSERT\s+INTO/iu);
    expect(source).not.toContain('db.transaction');
  });
});
