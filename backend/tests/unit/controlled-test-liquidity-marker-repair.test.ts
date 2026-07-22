import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_liquidity_marker_repair.sql',
), 'utf8');

describe('controlled TEST liquidity marker repair', () => {
  it('treats an unset marker as false instead of SQL NULL', () => {
    expect(sql).toContain("(current_setting('hustlexp.local_test_liquidity_enabled', TRUE) = 'true') IS TRUE");
  });

  it('guards cell, witness, binding, and acceptance mutation surfaces', () => {
    expect(sql).toContain('controlled_test_liquidity_marker_cell_guard');
    expect(sql).toContain('controlled_test_liquidity_marker_witness_guard');
    expect(sql).toContain('task_liquidity_marker_guard');
    expect(sql).toContain('UPDATE OF state,worker_id,liquidity_cell_id');
  });
});
