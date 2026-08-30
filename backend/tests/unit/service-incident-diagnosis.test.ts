import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  readQuery: vi.fn(),
  aiCall: vi.fn(),
}));

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, readQuery: mocks.readQuery },
}));
vi.mock('../../src/services/AIClient', () => ({
  AIClient: { call: mocks.aiCall, isConfigured: () => true },
}));

import {
  AI_INCIDENT_DIAGNOSIS_DORMANT,
  IncidentDiagnosisService,
} from '../../src/services/IncidentDiagnosisService';

beforeEach(() => vi.clearAllMocks());

describe('legacy IncidentDiagnosisService object', () => {
  it('returns its stable dormant failure before any database, AI, or persistence access', async () => {
    await expect(IncidentDiagnosisService.diagnoseIncident('incident-1')).resolves.toEqual({
      success: false,
      error: {
        code: AI_INCIDENT_DIAGNOSIS_DORMANT,
        message: AI_INCIDENT_DIAGNOSIS_DORMANT,
      },
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.readQuery).not.toHaveBeenCalled();
    expect(mocks.aiCall).not.toHaveBeenCalled();
  });

  it('cannot be activated by incident input or available dependencies', async () => {
    mocks.query.mockResolvedValue({ rows: [{ id: 'would-be-evidence' }], rowCount: 1 });
    mocks.aiCall.mockResolvedValue({ content: 'fabricated diagnosis' });
    const result = await IncidentDiagnosisService.diagnoseIncident(
      '550e8400-e29b-41d4-a716-446655440000',
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: AI_INCIDENT_DIAGNOSIS_DORMANT },
    });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.readQuery).not.toHaveBeenCalled();
    expect(mocks.aiCall).not.toHaveBeenCalled();
  });
});
