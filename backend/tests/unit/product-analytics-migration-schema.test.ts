import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../database/migrations/20260916_product_analytics.sql', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const preflight = migration.slice(0, migration.indexOf('ALTER TABLE analytics_events'));

// Static contract checks only: no SQL execution or claim of PostgreSQL validation.
describe('product analytics migration baseline preflight', () => {
  it('finishes its fail-fast preflight before any V1 alteration or index creation', () => {
    expect(preflight).toContain('DO $analytics_preflight$');
    expect(preflight).toContain('END;\n$analytics_preflight$;');
    expect(preflight).not.toMatch(/CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)/i);
    expect(preflight).toContain("to_regclass('analytics_events')");
    expect(preflight).toContain("relkind IN ('r','p')");
    expect(preflight).toContain("ERRCODE='55000'");
    expect(preflight).toContain('docs/analytics-v1.md');
  });
  it.each([
    ['id','uuid'],['event_type','text'],['event_category','text'],['user_id','uuid'],
    ['session_id','uuid'],['device_id','uuid'],['task_id','uuid'],['task_category','text'],
    ['properties','jsonb'],['platform','text'],['event_timestamp','timestamp with time zone'],
    ['ingested_at','timestamp with time zone'],
  ])('requires the baseline column %s with compatible %s typing', (name, type) => {
    expect(preflight).toContain(`('${name}','${type}',`);
  });
  it('reports missing columns, incompatible types/lengths, and a missing generated-ID default without transforming data', () => {
    expect(preflight).toContain("THEN 'missing' ELSE format_type");
    expect(preflight).toContain('a.atttypid=expected.type_name::regtype');
    expect(preflight).toContain('a.atttypmod-4>=expected.min_length');
    expect(preflight).toContain("attname='id' AND atthasdef");
    expect(preflight).toContain('minimal 005 legacy table is incompatible');
    expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE)\s+TABLE|\bUPDATE\s+analytics_events|\bDELETE\s+FROM\s+analytics_events/i);
  });
});
