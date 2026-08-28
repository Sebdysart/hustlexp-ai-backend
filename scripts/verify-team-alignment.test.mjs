import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CHARTER_SHA = '0b80c71e118d7cab70474bbbf6df778811fe4fe8';

async function read(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('root README exposes the common repository authority contract', async () => {
  const source = await read('README.md');
  for (const field of [
    'Repository role',
    'Lifecycle status',
    'Canonical authority',
    'Supported runtime',
    'Local start',
    'Staging path',
    'Payment posture',
    'Deployment authority',
    'Known limitations',
  ]) {
    assert.match(source, new RegExp(`\\*\\*${field}:\\*\\*`, 'u'));
  }
  assert.match(source, new RegExp(CHARTER_SHA, 'u'));
  assert.match(
    source,
    /npm run test:required\s+# release gate; zero failures and zero skip\/todo/u
  );
  assert.doesNotMatch(source, /all \d+ unresolved processor-dependent capabilities/iu);
});

test('agent and reviewer instructions enforce Universal V1 rather than a collapsed pay-first lifecycle', async () => {
  const [agents, claude, reviewer] = await Promise.all([
    read('AGENTS.md'),
    read('CLAUDE.md'),
    read('.greptile/rules.md'),
  ]);
  assert.match(agents, /npm run test:required/u);
  assert.match(agents, /rejects any failed, skipped, pending, or todo test/u);
  for (const source of [claude, reviewer]) {
    assert.match(source, new RegExp(CHARTER_SHA, 'u'));
    assert.match(source, /interest is not assignment/iu);
    assert.match(source, /authorization is not capture/iu);
    assert.match(source, /production customer-money creation/iu);
    assert.doesNotMatch(source, /eligible for auto-merge/iu);
    assert.doesNotMatch(source, /Task states:\s*`open`\s*→\s*`assigned`/u);
    assert.doesNotMatch(source, /\d[\d,]* tests across \d+ files/iu);
  }
});

test('CI documentation describes the checked-in hold and source-dates mutable external truth', async () => {
  const [documentation, workflow, setup] = await Promise.all([
    read('docs/CI_CD.md'),
    read('.github/workflows/deploy.yml'),
    read('backend/tests/system/README.md'),
  ]);
  assert.match(documentation, /Evidence refreshed: `2026-08-26`/u);
  assert.match(documentation, /bypass_actors: \[\]/u);
  assert.match(documentation, /actor `252866125` was absent/u);
  assert.match(documentation, /current_user_can_bypass` was `never`/u);
  assert.match(
    documentation,
    /does not check, sign, approve, or grant hosted status to the current dirty local bytes/iu
  );
  assert.match(documentation, /no Railway token, CLI command, deployment job/iu);
  assert.match(workflow, /Production release hold evidence/u);
  assert.match(workflow, /no deployment/u);
  assert.doesNotMatch(workflow, /RAILWAY_TOKEN|railway\s+(?:up|deploy)|railwayapp\/graphql/iu);
  assert.match(setup, /npm run test:required/u);
  assert.match(
    setup,
    /never require Neon, Supabase, a production database, or live provider credentials/iu
  );
});

test('restricted underwriting and dirty local receipts remain subordinate and unpromotable', async () => {
  const [alignment, sourceContracts, migrations, checkpoint] = await Promise.all([
    read('docs/HUSTLEXP_TEAM_ALIGNMENT.md'),
    read('docs/source-contracts/README.md'),
    read('docs/MIGRATIONS.md'),
    read('docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md'),
  ]);

  for (const source of [alignment, sourceContracts]) {
    assert.match(source, /Payment Infrastructure Pre-Integration Underwriting Package v3\.4/u);
    assert.match(source, /subordinate external-decision request/iu);
    assert.match(
      source,
      /every processor selection, capability, commercial, onboarding, certification, pilot, and production decision remains unresolved/iu
    );
    assert.match(source, /no payment, business, release, deployment, or processor authority/iu);
    assert.match(source, /production effects remain `NONE`/u);
    assert.match(source, /production money remains `FROZEN`/u);
    assert.match(source, /superseded v3\.3 request/iu);
    assert.match(
      source,
      /v7 rejection and v3\.1 source artifacts remain immutable historical evidence/iu
    );
    assert.doesNotMatch(source, /docs\.google\.com/iu);
  }

  assert.match(migrations, /121 ordered registry entries/u);
  assert.match(migrations, /20260904_canonical_user_email_identity/u);
  assert.match(migrations, /20260905_universal_v1_task_draft_legacy_claim_import_repair/u);
  assert.match(migrations, /20260906_universal_v1_estimate_acceptance_materialization/u);
  assert.match(migrations, /20260907_universal_v1_provider_estimate_invitation/u);
  assert.match(migrations, /20260908_universal_v1_provider_work_order_authority/u);
  assert.match(migrations, /20260909_universal_v1_reconciliation_alias_repair/u);
  assert.match(migrations, /20260911_universal_v1_change_order_application/u);
  assert.match(migrations, /20260912_universal_v1_work_order_execution_facts/u);
  assert.match(migrations, /6937ff0c82abc87f8391cb0e22de1c0ff163ca8a6bc8e61bbfc11f5252efd9f5/u);
  assert.match(migrations, /explicitly unpromotable/iu);
  assert.match(migrations, /EXTERNAL_DECISION_REQUIRED \/ RELEASE_BLOCKING/u);
  assert.match(
    checkpoint,
    /contains both tracked and untracked implementation changes/iu,
    'checkpoint must expose dirty source without promoting a volatile path count',
  );
  assert.doesNotMatch(
    checkpoint,
    /currently contains [0-9,]+ changed\/untracked paths/iu,
    'volatile path counts must come from a fresh exact-candidate porcelain capture',
  );
  assert.match(
    checkpoint,
    /complete combined local required gate[\s\S]*\*\*([0-9,]+)\/\1 tests across [0-9,]+ result files and [0-9,]+ suites, with zero failed, skipped, pending, or todo tests\*\*/iu
  );
  assert.match(
    checkpoint,
    /reports\/vitest-required(?:-[0-9TZ]+)?\.json.*SHA-256 `[a-f0-9]{64}`/iu,
  );
  assert.match(checkpoint, /local Node 24 evidence does not replace hosted Node 22 checks/iu);
  assert.match(
    checkpoint,
    /PostgreSQL 17\.11 verifier[\s\S]*HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 121/iu
  );
  assert.match(checkpoint, /system file separately passed \*\*25\/25\*\* with zero skips/iu);
  assert.match(checkpoint, /EXTERNAL_DECISION_REQUIRED \/ RELEASE_BLOCKING/u);
  assert.match(checkpoint, /No disposable-database result closes this boundary/u);
  assert.match(
    checkpoint,
    /production effects `NONE`, grants release authority `NONE`, keeps production money `FROZEN`/iu
  );
  assert.match(
    checkpoint,
    /These receipts prove no signature, approval, merge, deployment, or release authority/u
  );
});
