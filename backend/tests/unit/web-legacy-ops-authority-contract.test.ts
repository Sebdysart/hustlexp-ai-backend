import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const routerSources = ['ops.ts', 'leads.ts', 'actionLinks.ts'].map((name) => ({
  name,
  source: readFileSync(resolve(process.cwd(), 'backend/src/routers/web', name), 'utf8'),
}));

function readActiveRouterSources(directory: string): Array<{ name: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return readActiveRouterSources(path);
    return entry.isFile() && entry.name.endsWith('.ts')
      ? [{ name: path, source: readFileSync(path, 'utf8') }]
      : [];
  });
}

const activeRouterSources = readActiveRouterSources(resolve(process.cwd(), 'backend/src/routers'));

describe('legacy browser Operations authority retirement', () => {
  it('contains no shared browser administrator credential in active backend routers', () => {
    for (const { name, source } of activeRouterSources) {
      expect(source, name).not.toMatch(/OPS_ADMIN_KEY|\badminKey\b/);
    }
  });

  it('uses named, scoped Operations authority for every legacy admin read', () => {
    for (const procedure of ['listEngineTasks', 'listTaskDrafts', 'getTaskDraft', 'listHustlers']) {
      expect(routerSources[0].source).toMatch(new RegExp(`${procedure}: operationsAdminProcedure`));
    }
    for (const procedure of ['listLeads', 'getSurveyStats']) {
      expect(routerSources[1].source).toMatch(new RegExp(`${procedure}: operationsAdminProcedure`));
    }
    expect(routerSources[2].source).toMatch(/list: operationsAdminProcedure/);
  });

  it('holds broad legacy writes and routes only bounded containment through step-up commands', () => {
    expect(routerSources[0].source.match(/\.mutation\(holdLegacyMutation\)/g)).toHaveLength(3);
    expect(routerSources[1].source.match(/\.mutation\(holdLegacyMutation\)/g)).toHaveLength(1);
    expect(routerSources[2].source.match(/\.mutation\(holdLegacyMutation\)/g)).toHaveLength(1);
    expect(routerSources[0].source).toMatch(/updateFlag: operationsStepUpProcedure/);
    expect(routerSources[0].source).toContain("enabled: z.literal(false)");
    expect(routerSources[2].source).toMatch(/updateStatus: operationsStepUpProcedure/);
    expect(routerSources[2].source).toContain("status: z.literal('expired')");
  });

  it('removes payment URLs from reads and rejects public pay actions while frozen', () => {
    expect(routerSources[0].source).not.toContain('payment_link_url');
    expect(routerSources[2].source).toContain("metadata - 'pay_url'");
    expect(routerSources[2].source).toContain("delete metadata.pay_url");
    expect(routerSources[2].source).toContain("normalizedAction === 'pay'");
    expect(routerSources[2].source).toContain("code: 'payment_creation_frozen'");
  });
});
