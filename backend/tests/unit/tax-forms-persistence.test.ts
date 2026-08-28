/**
 * Tax Forms Persistence Tests
 *
 * Validates that StripeConnectService.getTaxInfo/submitTaxInfo
 * properly persist and retrieve from the tax_forms table.
 *
 * @see backend/database/migrations/20260222_009_tax_forms.sql
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Inline mock for DB ──────────────────────────────────────────────────────
const mockQueryResults: Record<string, { rows: unknown[]; rowCount: number }> = {};

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      // Route based on SQL content
      if (sql.includes('SELECT stripe_connect_id FROM users')) {
        return mockQueryResults['getConnectAccountId'] ?? { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tax_forms')) {
        return mockQueryResults['getTaxInfo'] ?? { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE tax_forms SET status = \'expired\'')) {
        return mockQueryResults['expireForms'] ?? { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO tax_forms')) {
        return mockQueryResults['submitTaxInfo'] ?? { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_placeholder_for_tests' },
    redis: { url: null },
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    fire: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    status: { name: 'CLOSED' },
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stripe mock — needs to be a constructor that returns an object
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      constructor() {
        // empty
      }
    },
  };
});

// ── Import AFTER mocks ──────────────────────────────────────────────────────
import { db } from '../../src/db';

// We need to test the actual service logic, but the module initializes Stripe
// on import. Since we mocked Stripe, we can import safely.
// However, the service uses getConnectAccountId internally, which queries db.
// We control that via mockQueryResults.

describe('Tax Forms Persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all mock results
    Object.keys(mockQueryResults).forEach(key => delete mockQueryResults[key]);
  });

  describe('getTaxInfo', () => {
    it('returns not_submitted when no tax form exists', async () => {
      // User has a Connect account but no tax form
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: 'acct_test123' }],
        rowCount: 1,
      };
      mockQueryResults['getTaxInfo'] = { rows: [], rowCount: 0 };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.getTaxInfo('user-123');

      expect(result.success).toBe(true);
      expect(result.data!.status).toBe('not_submitted');
      expect(result.data!.formType).toBeNull();
    });

    it('returns existing tax form when one exists', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: 'acct_test123' }],
        rowCount: 1,
      };
      mockQueryResults['getTaxInfo'] = {
        rows: [{
          form_type: 'W9',
          status: 'verified',
          submitted_at: new Date('2026-01-15'),
          verified_at: new Date('2026-01-16'),
          requires_update: false,
          tax_id_last4: '4321',
          name_on_file: 'John Doe',
          business_name_on_file: null,
        }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.getTaxInfo('user-123');

      expect(result.success).toBe(true);
      expect(result.data!.formType).toBe('W9');
      expect(result.data!.status).toBe('verified');
      expect(result.data!.taxIdLast4).toBe('4321');
      expect(result.data!.nameOnFile).toBe('John Doe');
    });

    it('fails when user has no Connect account', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.getTaxInfo('user-no-connect');

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    });
  });

  describe('submitTaxInfo', () => {
    it('inserts a new tax form and returns it', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: 'acct_test456' }],
        rowCount: 1,
      };
      mockQueryResults['expireForms'] = { rows: [], rowCount: 0 };
      mockQueryResults['submitTaxInfo'] = {
        rows: [{
          form_type: 'W9',
          status: 'pending',
          submitted_at: new Date(),
          verified_at: null,
          requires_update: false,
          tax_id_last4: '6789',
          name_on_file: 'Jane Smith',
          business_name_on_file: 'Smith LLC',
        }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.submitTaxInfo({
        userId: 'user-456',
        formType: 'W9',
        name: 'Jane Smith',
        businessName: 'Smith LLC',
        ssnLast4: '6789',
        signature: 'Jane Smith',
      });

      expect(result.success).toBe(true);
      expect(result.data!.formType).toBe('W9');
      expect(result.data!.status).toBe('pending');
      expect(result.data!.taxIdLast4).toBe('6789');
    });

    it('expires existing forms before inserting new one', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: 'acct_test789' }],
        rowCount: 1,
      };
      mockQueryResults['expireForms'] = { rows: [], rowCount: 1 };
      mockQueryResults['submitTaxInfo'] = {
        rows: [{
          form_type: 'W8BEN',
          status: 'pending',
          submitted_at: new Date(),
          verified_at: null,
          requires_update: false,
          tax_id_last4: null,
          name_on_file: 'International User',
          business_name_on_file: null,
        }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.submitTaxInfo({
        userId: 'user-789',
        formType: 'W8BEN',
        name: 'International User',
        foreignTaxId: 'FT12345',
        treatyCountry: 'GB',
      });

      expect(result.success).toBe(true);
      expect(result.data!.formType).toBe('W8BEN');

      // Verify the expire query was called
      const dbMock = db.query as ReturnType<typeof vi.fn>;
      const expireCalls = dbMock.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('SET status = \'expired\'')
      );
      expect(expireCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('fails when user has no Connect account', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: null }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.submitTaxInfo({
        userId: 'user-no-connect',
        formType: 'W9',
      });

      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('STRIPE_CONNECT_NOT_SETUP');
    });

    it('derives taxIdLast4 from EIN when SSN not provided', async () => {
      mockQueryResults['getConnectAccountId'] = {
        rows: [{ stripe_connect_id: 'acct_ein_test' }],
        rowCount: 1,
      };
      mockQueryResults['expireForms'] = { rows: [], rowCount: 0 };
      mockQueryResults['submitTaxInfo'] = {
        rows: [{
          form_type: 'W9',
          status: 'pending',
          submitted_at: new Date(),
          verified_at: null,
          requires_update: false,
          tax_id_last4: '5678',
          name_on_file: 'Business Owner',
          business_name_on_file: 'My Corp',
        }],
        rowCount: 1,
      };

      const { StripeConnectService } = await import('../../src/services/StripeConnectService');
      const result = await StripeConnectService.submitTaxInfo({
        userId: 'user-ein',
        formType: 'W9',
        name: 'Business Owner',
        businessName: 'My Corp',
        ein: '12-3455678',
      });

      expect(result.success).toBe(true);
      // The INSERT receives the derived last4 — verify via db.query call
      const dbMock = db.query as ReturnType<typeof vi.fn>;
      const insertCalls = dbMock.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO tax_forms')
      );
      expect(insertCalls.length).toBeGreaterThanOrEqual(1);
      // The 4th parameter (index 3) should be the taxIdLast4
      const insertParams = insertCalls[0][1] as unknown[];
      expect(insertParams[3]).toBe('5678');
    });
  });

  describe('Migration SQL schema', () => {
    const getMigrationPath = async () => {
      const path = await import('path');
      return path.resolve(__dirname, '../../database/migrations/20260222_009_tax_forms.sql');
    };

    it('migration file exists', async () => {
      const fs = await import('fs');
      const migrationPath = await getMigrationPath();
      expect(fs.existsSync(migrationPath)).toBe(true);
    });

    it('migration creates tax_forms table with required columns', async () => {
      const fs = await import('fs');
      const migrationPath = await getMigrationPath();
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      expect(sql).toContain('CREATE TABLE IF NOT EXISTS tax_forms');
      expect(sql).toContain('user_id UUID NOT NULL REFERENCES users(id)');
      expect(sql).toContain('form_type TEXT NOT NULL');
      expect(sql).toContain("status TEXT NOT NULL DEFAULT 'pending'");
      expect(sql).toContain('tax_id_last4 TEXT');
      expect(sql).toContain('signature_on_file BOOLEAN');
      expect(sql).toContain('idx_tax_forms_active_per_user');
    });

    it('migration enforces one active form per user via unique index', async () => {
      const fs = await import('fs');
      const migrationPath = await getMigrationPath();
      const sql = fs.readFileSync(migrationPath, 'utf-8');

      expect(sql).toContain('CREATE UNIQUE INDEX idx_tax_forms_active_per_user');
      expect(sql).toContain("WHERE status IN ('pending', 'verified')");
    });
  });
});
