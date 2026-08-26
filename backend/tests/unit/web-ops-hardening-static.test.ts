import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(process.cwd());
const read = (rel: string) => readFileSync(resolve(ROOT, 'backend', rel), 'utf8');
const readRoot = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('ops backend cutover contracts (static)', () => {
  it('webOps uses named operations authorization for every private operator read', () => {
    const ops = read('src/routers/web/ops.ts');
    expect(ops).toContain('operationsAdminProcedure');
    expect(ops).toContain('listEngineTasks');
    const lifecycleRead = ops.slice(ops.indexOf('listEngineTasks:'), ops.indexOf('// ── Liquidity'));
    expect(lifecycleRead).toContain('operationsAdminProcedure');
    expect(lifecycleRead).not.toContain('publicProcedure');
    expect(lifecycleRead).not.toContain('adminKey');
    expect(ops).not.toContain('OPS_ADMIN_KEY');
    expect(ops).toContain('TASK_DRAFT_SAFE_COLS');
    expect(ops).toContain('card_token_hash');
    expect(ops).toContain('HX_OPS_MUTATION_FROZEN');
    expect(ops).not.toContain('db.transaction');
    expect(ops).not.toContain('recordOpsAudit');
    for (const capability of [
      'create_quote',
      'mark_quote_send_ready',
      'upsert_hustler',
      'update_feature_flag',
      'create_business_claim_link',
    ]) {
      expect(ops).toContain(`opsMutationDisabled('${capability}')`);
    }
    expect(ops).toContain('name_initial');
    expect(ops).toContain('getLiquidity');
    expect(ops).toContain('getCommandEngineJoin');
    expect(ops).toContain('listOpsLeads');
    expect(ops).toContain('listQuotes');
  });

  it('keeps the legacy bearer-key admin route unregistered', () => {
    const server = read('src/server.ts');
    const files = read('src/jobs/engine-automation-migration-files.ts');
    expect(server).not.toContain('registerOpsAdminRoutes');
    expect(server).not.toContain('/admin/liquidity');
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

  it('contains no browser-supplied shared-key operations surface', () => {
    const ops = read('src/routers/web/ops.ts');
    const leads = read('src/routers/web/leads.ts');
    const actionLinks = read('src/routers/web/actionLinks.ts');
    const envTemplate = readRoot('.env.template');

    for (const source of [ops, leads, actionLinks, envTemplate]) {
      expect(source).not.toContain('OPS_ADMIN_KEY');
      expect(source).not.toContain('adminKey');
    }
    expect(leads).not.toContain('updateLead:');
    expect(leads).not.toContain('listLeads:');
    expect(actionLinks).toContain('export const webActionLinksRouter = router({});');
  });
});
