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
    const errorLogMatch = dbSource.match(/console\.error.*originalError.*rollbackError|console\.error.*rollbackError.*originalError/);
    expect(errorLogMatch).toBeTruthy();
  });

  it('always releases connection in finally block', () => {
    // Verify finally block exists
    const finallyIndex = dbSource.indexOf('finally');
    expect(finallyIndex).toBeGreaterThan(-1);
    
    // Verify client.release() is in finally block
    const releaseIndex = dbSource.indexOf('client.release()', finallyIndex);
    expect(releaseIndex).toBeGreaterThan(finallyIndex);
    
    // Verify release happens after all error handling
    const catchBlockIndex = dbSource.lastIndexOf('catch');
    expect(releaseIndex).toBeGreaterThan(catchBlockIndex);
  });

  it('applies fix to both transaction and serializableTransaction', () => {
    // Check transaction method
    const transactionIndex = dbSource.indexOf('transaction:');
    const transactionSection = dbSource.substring(transactionIndex, transactionIndex + 500);
    expect(transactionSection).toContain('try');
    expect(transactionSection).toContain('ROLLBACK');
    expect(transactionSection).toContain('catch (rollbackError');

    // Check serializableTransaction method
    const serializableIndex = dbSource.indexOf('serializableTransaction:');
    const serializableSection = dbSource.substring(serializableIndex, serializableIndex + 500);
    expect(serializableSection).toContain('try');
    expect(serializableSection).toContain('ROLLBACK');
    expect(serializableSection).toContain('catch (rollbackError');
  });
});
