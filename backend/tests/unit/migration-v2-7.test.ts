import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Migration v2.7', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../../database/migrations/task_template_v2_7.sql'
  );

  it('migration file exists', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
  });

  it('adds flagged_phrase_counter column to users', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('flagged_phrase_counter');
    expect(sql).toContain('JSONB');
  });

  it('adds prorate_on_abort column to tasks', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('prorate_on_abort');
    expect(sql).toContain('BOOLEAN DEFAULT FALSE');
  });

  it('adds challenge_window_hours column to tasks', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('challenge_window_hours');
    expect(sql).toContain('INTEGER DEFAULT 6');
  });

  it('wraps in transaction', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
  });

  it('is idempotent (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8');
    expect(sql.match(/ADD COLUMN IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(3);
  });
});
