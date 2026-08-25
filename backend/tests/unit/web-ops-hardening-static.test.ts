import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const read = (rel: string) => readFileSync(resolve(ROOT, 'backend', rel), 'utf8');

describe('ops backend cutover contracts (static)', () => {
  it('webOps uses operationsAdminProcedure for browser ops and service key for listEngineTasks', () => {
    const ops = read('src/routers/web/ops.ts');
    expect(ops).toContain('operationsAdminProcedure');
    expect(ops).toContain('listEngineTasks');
    expect(ops).toContain('assertEngineOpsServiceKey');
    expect(ops).toContain('TASK_DRAFT_SAFE_COLS');
    expect(ops).toContain('card_token_hash');
    expect(ops).toContain('db.transaction');
    expect(ops).toContain('already_linked');
    expect(ops).toContain('name_initial');
    expect(ops).toContain('getLiquidity');
    expect(ops).toContain('getCommandEngineJoin');
    expect(ops).toContain('listOpsLeads');
    expect(ops).toContain('listQuotes');
  });

  it('registers /admin/liquidity and ops hardening migration', () => {
    const server = read('src/server.ts');
    const routes = read('src/serverOpsAdminRoutes.ts');
    const files = read('src/jobs/engine-automation-migration-files.ts');
    expect(server).toContain('registerOpsAdminRoutes');
    expect(routes).toContain('/admin/liquidity');
    expect(routes).toContain('assertOpsAdminBearerKey');
    expect(files).toContain('20260819_ops_web_hardening');
  });

  it('feature_flags key reconcile migration keeps name and key in sync', () => {
    const sql = read('database/migrations/20260819_ops_web_hardening.sql');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS key');
    expect(sql).toContain('ops_action_audit');
    expect(sql).toContain('sync_feature_flags_key_from_name');
  });

  it('listOpsLeads redacts full names to initials and omits PII columns', () => {
    const ops = read('src/routers/web/ops.ts');
    expect(ops).toContain('LEFT(BTRIM(name), 1)');
    const leadsBlock = ops.slice(ops.indexOf('listOpsLeads:'), ops.indexOf('getLeadReport:'));
    const selectSql = leadsBlock.slice(leadsBlock.indexOf('`SELECT'), leadsBlock.indexOf('FROM leads'));
    expect(selectSql).not.toMatch(/\bphone\b/);
    expect(selectSql).not.toMatch(/\bemail\b/);
    expect(selectSql).not.toMatch(/\banswers\b/);
    expect(selectSql).not.toMatch(/\butm\b/);
  });
});
