import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ops = readFileSync(join(root, 'backend/src/routers/web/ops.ts'), 'utf8');
const leads = ops.slice(ops.indexOf('listOpsLeads:'), ops.indexOf('getLeadReport:'));
const selectSql = leads.slice(leads.indexOf('`SELECT'), leads.indexOf('FROM leads'));
const checks = [
  ['initials', leads.includes('LEFT(BTRIM(name), 1)')],
  ['no phone', !/\bphone\b/.test(selectSql)],
  ['no email', !/\bemail\b/.test(selectSql)],
  ['no answers', !/\banswers\b/.test(selectSql)],
  ['no utm', !/\butm\b/.test(selectSql)],
];
for (const [k, v] of checks) console.log(`${k}: ${v ? 'PASS' : 'FAIL'}`);
if (!checks.every(([, v]) => v)) process.exit(1);
console.log('PROD_STATIC_PASS');
