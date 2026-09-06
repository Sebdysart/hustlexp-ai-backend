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

test('team target binds the active V1A Gate 0-10 boundary and excludes Gates 11-12', async () => {
  const source = await read('docs/HUSTLEXP_TEAM_ALIGNMENT.md');
  assert.match(source, /Charter v1\.1\.0` at signed commit/u);
  assert.match(source, new RegExp(CHARTER_SHA, 'u'));
  assert.match(source, /sole business authority/iu);
  assert.match(
    source,
    /doctrine SHA-256 `5D4045B3C7A1CD3EC05CA133FA6F6699182EF58AF7EF202D596E63AAABA195A4`/u
  );
  assert.match(
    source,
    /authority-manifest SHA-256 `C22082CB4B95E2139E317C8D4A806B0ADBE00F5BD9A8F41C561765F06F1793B7`/u
  );
  assert.match(source, /active boundary is Universal V1A Gates 0–10/iu);

  const declaredGates = [...source.matchAll(/^### Gate (\d+)\s+—/gmu)].map((match) =>
    Number(match[1])
  );
  assert.deepEqual(
    declaredGates,
    Array.from({ length: 13 }, (_, index) => index)
  );

  assert.match(source, /Gate 11 — live-processor V1B adapter \(`EXCLUDED \/ LATER GOAL`\)/u);
  assert.match(source, /Gate 12 — controlled production pilot \(`EXCLUDED \/ LATER GOAL`\)/u);
  assert.match(source, /authorizes no Gate 11 implementation or activation/iu);
  assert.match(source, /authorizes no Gate 12 pilot/iu);
  assert.match(
    source,
    /`AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING \/\s*RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW`/u
  );
  assert.match(source, /backend\/database\/work-order-command-authority\.HOLD\.json/u);
  assert.match(source, /production effects are `NONE`/iu);
  assert.match(source, /production money remains `FROZEN`/iu);
  assert.match(source, /real hard assignment remains `FROZEN`/iu);
  assert.doesNotMatch(source, /Gate 5 — external processor and controlled pilot/iu);
  assert.doesNotMatch(source, /Production remains `NO-GO` until every Gate 5/iu);
});

test('CI documentation describes the checked-in hold and source-dates mutable external truth', async () => {
  const [documentation, workflow, setup] = await Promise.all([
    read('docs/CI_CD.md'),
    read('.github/workflows/deploy.yml'),
    read('backend/tests/system/README.md'),
  ]);
  assert.match(
    documentation,
    /Evidence refreshed through a public read-only observation on `2026-08-28`/u
  );
  assert.match(documentation, /public `main` is unsigned `d42975be/u);
  assert.match(documentation, /PR #281 reached `main` with no approving review/iu);
  assert.match(documentation, /3,248 `\.local-tools` entries/u);
  assert.match(documentation, /deployment `6142799813`/u);
  assert.match(documentation, /zero bypass actors cannot be re-proven/iu);
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
  const [alignment, sourceContracts, migrations, checkpoint, environment] = await Promise.all([
    read('docs/HUSTLEXP_TEAM_ALIGNMENT.md'),
    read('docs/source-contracts/README.md'),
    read('docs/MIGRATIONS.md'),
    read('docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md'),
    read('docs/ENV.md'),
  ]);

  for (const source of [alignment, sourceContracts]) {
    assert.match(source, /Payment Infrastructure Pre-Integration Underwriting Package v3\.3/u);
    assert.match(source, /latest primary underwriting source actually read/iu);
    assert.match(
      source,
      /AIroW37_64ZTORJE2_jnezyXuxDCYyPrZP0UJPXgvzxloOXEM47evoZQhE4swHX1QJFEacb8Xm8-FBDMcVLrX1frAMEmDeu7Lmkao57ZJw/u
    );
    assert.match(source, /provider-modified `2026-08-27T04:51:56\.612Z`/u);
    assert.match(
      source,
      /confidential (?:contents|source content) (?:are|is) not (?:mirrored|copied)/iu
    );
    assert.match(
      source,
      /every processor selection, capability, commercial, onboarding, certification, pilot, and production decision remains unresolved/iu
    );
    assert.match(source, /no payment, business, release, deployment, or processor authority/iu);
    assert.match(source, /production effects remain `NONE`/u);
    assert.match(source, /production money remains `FROZEN`/u);
    assert.match(source, /provider command record precedes (?:any |an )?(?:provider )?effect/iu);
    assert.match(source, /append-only inbox/iu);
    assert.match(source, /canonical ledger facts/iu);
    assert.match(source, /restricted v3\.4 source/iu);
    assert.match(source, /READBACK_REQUIRED/u);
    assert.match(
      source,
      /v7 rejection and v3\.1 source artifacts remain immutable historical evidence/iu
    );
    assert.doesNotMatch(source, /docs\.google\.com/iu);
  }

  assert.match(migrations, /144 ordered registry entries/u);
  assert.match(migrations, /199 SQL files/u);
  assert.match(migrations, /20260904_canonical_user_email_identity/u);
  assert.match(migrations, /20260905_universal_v1_task_draft_legacy_claim_import_repair/u);
  assert.match(migrations, /20260906_universal_v1_estimate_acceptance_materialization/u);
  assert.match(migrations, /20260907_universal_v1_provider_estimate_invitation/u);
  assert.match(migrations, /20260908_universal_v1_provider_work_order_authority/u);
  assert.match(migrations, /20260909_universal_v1_reconciliation_alias_repair/u);
  assert.match(migrations, /20260911_universal_v1_change_order_application/u);
  assert.match(migrations, /20260912_universal_v1_work_order_execution_facts/u);
  assert.match(migrations, /20260913_universal_v1_completion_delivery_receipt/u);
  assert.match(migrations, /20260914_notification_provider_in_flight/u);
  assert.match(migrations, /20260915_ai_spend_attempt_ledger/u);
  assert.match(migrations, /20260916_provider_event_inbox_v1/u);
  assert.match(migrations, /20260917_financial_provider_command_journal_v1/u);
  assert.match(migrations, /20260918_universal_v1_prepared_financial_command_v1/u);
  assert.match(migrations, /20260919_provider_event_processing_v1/u);
  assert.match(migrations, /20260920_financial_provider_command_recovery_v1/u);
  assert.match(migrations, /20260923_legacy_escrow_insert_containment_v1/u);
  assert.match(migrations, /20260924_universal_v1_task_draft_route_context_v1/u);
  assert.match(migrations, /20260925_universal_v1_work_order_compensation_v1/u);
  assert.match(migrations, /20260928_provider_observation_normalization_v1/u);
  assert.match(migrations, /20260929_universal_v1_double_entry_ledger_v1/u);
  assert.match(migrations, /20260930_universal_v1_ops_cases_v1/u);
  assert.match(migrations, /20261001_universal_v1_relationship_origin_v1/u);
  assert.match(migrations, /20261002_universal_v1_dispute_recovery_v1/u);
  assert.match(migrations, /20261003_universal_v1_task_opportunities_v1/u);
  assert.match(migrations, /20261004_universal_v1_completion_notice_dispatch_v1/u);
  assert.match(migrations, /20261005_universal_v1_occurrence_access_audit_v1/u);
  assert.match(migrations, /20261006_stage1_legacy_authority_containment_v1/u);
  assert.match(migrations, /20261007_subscription_cancellation_recovery_v1/u);
  assert.match(migrations, /20261008_universal_v1_work_order_task_state_containment_v1/u);
  assert.match(migrations, /20261009_universal_v1_standardized_quote_readiness_v1/u);
  assert.match(migrations, /20261010_universal_v1_financial_security_event_expiry_v1/u);
  assert.match(migrations, /20260921_universal_v1_fake_financial_lifecycle_bridge_v1/u);
  assert.match(migrations, /20260922_universal_v1_fake_terminal_lifecycle_intent_v1/u);
  assert.match(migrations, /20260926_universal_v1_change_order_three_phase_v1/u);
  assert.match(migrations, /20260927_universal_v1_change_order_recovery_v1/u);
  assert.match(migrations, /20261002_universal_v1_dispute_fake_release_gate_v8/u);
  assert.match(migrations, /20261010_universal_v1_fake_financial_expiry_v9/u);
  assert.match(migrations, /`20260923_legacy_escrow_insert_containment_v1` at 129/iu);
  assert.match(migrations, /`20260925_universal_v1_work_order_compensation_v1` at 131/iu);
  assert.match(migrations, /`20261003_universal_v1_task_opportunities_v1` at 137/iu);
  assert.match(migrations, /`20261004_universal_v1_completion_notice_dispatch_v1` at 138/iu);
  assert.match(migrations, /`20261005_universal_v1_occurrence_access_audit_v1` at 139/iu);
  assert.match(migrations, /`20261006_stage1_legacy_authority_containment_v1` at 140/iu);
  assert.match(migrations, /`20261007_subscription_cancellation_recovery_v1` at 141/iu);
  assert.match(migrations, /`20261008_universal_v1_work_order_task_state_containment_v1` at 142/iu);
  assert.match(
    migrations,
    /Ordinal 143 is\s+`20261009_universal_v1_standardized_quote_readiness_v1`/iu
  );
  assert.match(
    migrations,
    /ordinal 144 is\s+`20261010_universal_v1_financial_security_event_expiry_v1`/iu
  );
  assert.match(migrations, /engine migrations 129 through 144/iu);
  assert.match(migrations, /post-engine, nonproduction-only fake-finance chain/iu);
  assert.match(
    migrations,
    /None of `20260827_fake_financial_provider_v1`[\s\S]*`20261002_universal_v1_dispute_fake_release_gate_v8` is a production engine-registry migration/iu
  );
  assert.match(migrations, /HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 140/u);
  assert.match(migrations, /f0ea0963dc6ce5f9b7b9dad51735d6ecdf9db4c4c849488343b2787b8e6383cd/u);
  assert.match(migrations, /b6671677f556655c2cc3bad374a341a7667a0c431155397dbc0f5ad8029ffdb4/u);
  assert.match(migrations, /ec3b1ccaeffca63edc9a261d98d5d8e1dac6d614d447b7bb3809e82301f2ece0/u);
  assert.match(migrations, /2c3a3050a5a4efb3380e9746d77526a22adf33438c7e31521c589998b860ba04/u);
  assert.match(migrations, /sticky `CANCELLATION_UNCERTAIN` state/iu);
  assert.match(migrations, /retry-only recovery/iu);
  assert.match(migrations, /59e5eae7fa8d7c0327b0e2f803d3f040223a03025e16de159b89090d62a8062a/u);
  assert.match(migrations, /5cc6f5710696048b98c97ea06993a56aefaf711bac7a04dd973059f957d4eb63/u);
  assert.match(migrations, /f5723941769d027e496d0a3a7fed32b29b1a02ff76db97ead815acd46a7fdee8/u);
  assert.match(migrations, /d805ce946b7aba804be55aea9f131cff99047adaa7d46cd3d21242ac492ec364/u);
  assert.match(migrations, /6d1222a3eab5f1022f97ea942827a8869d63c829dd2638c0c94d52fc8c66d0be/u);
  assert.match(migrations, /exact seventeen-migration tail/iu);
  assert.match(
    migrations,
    /exact historical migration-140 verification run did not reapply them/iu
  );
  assert.match(migrations, /focused live-PostgreSQL cohort passed \*\*3\/3\*\*/iu);
  assert.match(
    migrations,
    /complete PostgreSQL verifier ran against disposable loopback-only PostgreSQL/iu
  );
  assert.match(migrations, /HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 141/u);
  assert.match(migrations, /HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 142/u);
  assert.match(
    migrations,
    /`BEFORE TRUNCATE` containment on `public\.quotes` and `public\.tasks`/u
  );
  assert.match(migrations, /refuses a partial legacy task or quote shape/iu);
  assert.match(migrations, /production money remains `FROZEN`/u);
  assert.match(
    migrations,
    /This local evidence grants no CI, signed-candidate, merge, staging, deployment, persistent-target, or production authority/iu
  );
  assert.match(migrations, /hxos_fake_financial_schema_evidence_v5/u);
  assert.match(migrations, /hxos_fake_financial_schema_evidence_v6/u);
  assert.match(migrations, /hxos_fake_financial_schema_evidence_v7/u);
  assert.match(migrations, /hxos_fake_financial_schema_evidence_v8/u);
  assert.match(migrations, /fixture v9 appends provider-observation\/expiry parity/iu);
  assert.match(migrations, /immutable terminal plan before the first fake financial effect/iu);
  assert.match(migrations, /provider-authored current provider-account facts/iu);
  assert.match(migrations, /persisted outcome-to-reconciliation snapshot-digest bridge/iu);
  assert.match(migrations, /no provider I\/O, real-money effect[\s\S]*production authority/iu);
  assert.match(
    migrations,
    /PREPARED and REQUESTED grant neither provider I\/O nor lifecycle DML/iu
  );
  assert.match(migrations, /Earlier verifier receipts.*historical evidence/iu);
  assert.match(migrations, /explicitly (?:nonpromotable|unpromotable)/iu);
  assert.match(migrations, /EXTERNAL_DECISION_REQUIRED \/ RELEASE_BLOCKING/u);
  assert.match(environment, /exactly 144 migrations through/u);
  assert.match(environment, /exactly 199 SQL files/u);
  assert.match(environment, /exactly nine\s+ordered nonproduction fixtures/iu);
  assert.match(environment, /20261010_universal_v1_financial_security_event_expiry_v1/u);
  assert.match(environment, /20261010_universal_v1_fake_financial_expiry_v9/u);
  assert.match(environment, /Migration 140 adds no runtime enablement variable/u);
  assert.match(environment, /Migration 141 adds no runtime enablement variable/u);
  assert.match(environment, /Migration 142 adds no runtime enablement variable/u);
  assert.match(environment, /Migration 143 adds no runtime enablement variable/u);
  assert.match(environment, /Migration 144 adds no runtime enablement variable/u);
  assert.match(environment, /Production\s+money remains frozen/u);
  assert.match(checkpoint, /\*\*144 ordered migrations\*\*/u);
  assert.match(checkpoint, /\*\*nine ordered fixtures\*\*/u);
  assert.match(checkpoint, /\*\*199 SQL files\*\*/u);
  assert.match(checkpoint, /HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 140/u);
  assert.match(checkpoint, /that exact historical migration-140 run did not reapply them/iu);
  assert.match(checkpoint, /Current local certification overlay — 2026-08-31/u);
  assert.match(
    checkpoint,
    /complete current-144 PostgreSQL verifier and combined required gate are still pending/iu
  );
  assert.match(checkpoint, /HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 142/u);
  assert.match(
    checkpoint,
    /Older historical receipts and digests below remain unchanged and continue to describe only their named bytes/iu
  );
  assert.match(
    checkpoint,
    /contains both tracked and untracked implementation changes/iu,
    'checkpoint must expose dirty source without promoting a volatile path count'
  );
  assert.doesNotMatch(
    checkpoint,
    /currently contains [0-9,]+ changed\/untracked paths/iu,
    'volatile path counts must come from a fresh exact-candidate porcelain capture'
  );
  assert.match(
    checkpoint,
    /complete combined local required gate[\s\S]*\*\*([0-9,]+)\/\1 tests across [0-9,]+ result files and [0-9,]+ suites, with zero failed, skipped, pending, or todo tests\*\*/iu
  );
  assert.match(
    checkpoint,
    /reports\/vitest-required(?:-[0-9TZ]+)?\.json.*SHA-256 `[a-f0-9]{64}`/iu
  );
  assert.match(checkpoint, /local Node 24 evidence does not replace hosted Node 22 checks/iu);
  assert.match(
    checkpoint,
    /PostgreSQL 17\.11 verifier[\s\S]*HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 121/iu
  );
  assert.match(checkpoint, /system file separately passed \*\*25\/25\*\* with zero skips/iu);
  assert.match(
    checkpoint,
    /`AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING`[\s\S]*`RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW`/u
  );
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
