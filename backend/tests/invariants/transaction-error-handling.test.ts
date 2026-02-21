/**
 * Transaction Error Handling Regression Tests
 * 
 * Tests that transaction error handling correctly preserves original errors
 * even when ROLLBACK operations fail.
 * 
 * **REMOVAL GATE**: Do not remove instrumentation or downgrade logging until:
 * - Alpha completes with real traffic
 * - At least one real transaction failure observed
 * - No rollback failures observed OR behavior confirmed via this test
 * - Log volume confirmed acceptable
 * 
 * These tests verify the fix for: ROLLBACK failures masking original transaction errors
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('Transaction Error Handling - Structural Verification', () => {
  let dbSource: string;

  beforeAll(async () => {
    const dbSourcePath = join(process.cwd(), 'backend/src/db.ts');
    dbSource = await readFile(dbSourcePath, 'utf-8');
  });

  it('has try-catch around ROLLBACK to prevent error masking', () => {
    // Find the catch block for transaction errors
    const catchBlockIndex = dbSource.indexOf('catch (error)');
    expect(catchBlockIndex).toBeGreaterThan(-1);

    // Find ROLLBACK within that catch block
    const rollbackIndex = dbSource.indexOf('ROLLBACK', catchBlockIndex);
    expect(rollbackIndex).toBeGreaterThan(-1);

    // Verify there's a nested try-catch around ROLLBACK
    const rollbackTryIndex = dbSource.indexOf('try', catchBlockIndex);
    const rollbackCatchIndex = dbSource.indexOf('catch (rollbackError', rollbackTryIndex);
    
    expect(rollbackTryIndex).toBeGreaterThan(-1);
    expect(rollbackTryIndex).toBeLessThan(rollbackIndex);
    expect(rollbackCatchIndex).toBeGreaterThan(rollbackTryIndex);
    expect(rollbackCatchIndex).toBeGreaterThan(rollbackIndex);
  });

  it('throws original error, not rollback error', () => {
    // Find where error is thrown after ROLLBACK handling
    const catchBlockIndex = dbSource.indexOf('catch (error)');
    const rollbackCatchIndex = dbSource.indexOf('catch (rollbackError');
    const throwIndex = dbSource.indexOf('throw error', rollbackCatchIndex);
    
    // Verify throw happens AFTER rollback catch (preserving original error)
    expect(throwIndex).toBeGreaterThan(rollbackCatchIndex);
    
    // Verify it throws 'error' (original), not 'rollbackError'
    const throwStatement = dbSource.substring(throwIndex, throwIndex + 50);
    expect(throwStatement).toContain('throw error');
    expect(throwStatement).not.toContain('throw rollbackError');
  });

  it('logs both errors when rollback fails', () => {
    // Verify error logging includes both original and rollback errors
    // Supports both console.error and structured logger (pino/dbLog.error)
    const errorLogMatch = dbSource.match(
      /(?:console\.error|\.error)\s*\(\s*\{[^}]*originalError[^}]*rollbackError[^}]*\}|(?:console\.error|\.error)\s*\(\s*\{[^}]*rollbackError[^}]*originalError[^}]*\}/
    );
    expect(errorLogMatch).toBeTruthy();
  });

  it('always releases connection in finally block', () => {
    // Verify both transaction methods have finally blocks with client.release()
    const transactionIndex = dbSource.indexOf('transaction:');
    expect(transactionIndex).toBeGreaterThan(-1);

    // Check first transaction method
    const finally1 = dbSource.indexOf('finally', transactionIndex);
    expect(finally1).toBeGreaterThan(-1);
    const release1 = dbSource.indexOf('client.release()', finally1);
    expect(release1).toBeGreaterThan(finally1);
    // Verify release is close to finally (within the block, not in another function)
    expect(release1 - finally1).toBeLessThan(50);

    // Check serializableTransaction method
    const serializableIndex = dbSource.indexOf('serializableTransaction:');
    expect(serializableIndex).toBeGreaterThan(-1);
    const finally2 = dbSource.indexOf('finally', serializableIndex);
    expect(finally2).toBeGreaterThan(serializableIndex);
    const release2 = dbSource.indexOf('client.release()', finally2);
    expect(release2).toBeGreaterThan(finally2);
    expect(release2 - finally2).toBeLessThan(50);
  });

  it('applies fix to both transaction and serializableTransaction', () => {
    // Check transaction method implementation (skip type declaration by looking for 'transaction: async')
    const transactionIndex = dbSource.indexOf('transaction: async');
    expect(transactionIndex).toBeGreaterThan(-1);
    const transactionSection = dbSource.substring(transactionIndex, transactionIndex + 800);
    expect(transactionSection).toContain('try');
    expect(transactionSection).toContain('ROLLBACK');
    expect(transactionSection).toContain('catch (rollbackError');

    // Check serializableTransaction method implementation
    const serializableIndex = dbSource.indexOf('serializableTransaction: async');
    expect(serializableIndex).toBeGreaterThan(-1);
    const serializableSection = dbSource.substring(serializableIndex, serializableIndex + 800);
    expect(serializableSection).toContain('try');
    expect(serializableSection).toContain('ROLLBACK');
    expect(serializableSection).toContain('catch (rollbackError');
  });
});
