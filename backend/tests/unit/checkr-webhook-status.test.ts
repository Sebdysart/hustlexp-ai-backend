import { describe, expect, it } from 'vitest';
import { checkrReportStatus } from '../../src/serverWebhookRoutes.js';

describe('Checkr report status projection', () => {
  it('does not equate a completed adverse report with clearance', () => {
    expect(checkrReportStatus({ type: 'report.completed', data: { object: { result: 'consider' } } }))
      .toBe('CONSIDER');
    expect(checkrReportStatus({ type: 'report.completed', data: { object: { result: 'clear' } } }))
      .toBe('CLEAR');
  });

  it('fails closed for a completion without a recognized result', () => {
    expect(checkrReportStatus({ type: 'report.completed', data: { object: {} } })).toBeNull();
    expect(checkrReportStatus({ type: 'report.completed', data: { object: { result: 'unknown' } } }))
      .toBeNull();
  });

  it('does not treat disputes or suspension as clearance', () => {
    expect(checkrReportStatus({ type: 'report.disputed' })).toBe('DISPUTED');
    expect(checkrReportStatus({ type: 'report.suspended' })).toBe('CONSIDER');
  });
});
