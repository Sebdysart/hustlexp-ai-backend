import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/deploy.yml'), 'utf8');

describe('production deploy workflow contract', () => {
  it('binds the only observed production environment and both explicit runtime services', () => {
    expect(workflow).toContain('RAILWAY_PROJECT_ID: e83d489c-fcf8-446f-b35a-f0e78d21c9b4');
    expect(workflow).toContain('RAILWAY_ENVIRONMENT: f4eb7aa5-c6bf-4fdd-b74f-6e8d5d7cc407');
    expect(workflow).toContain('RAILWAY_WEB_SERVICE: e3996482-fa94-489b-b474-985437dda612');
    expect(workflow).toContain('RAILWAY_WORKER_SERVICE: 5295aa04-9c34-489f-a5be-2535468c959a');
    expect(workflow.match(/railway up /gu)).toHaveLength(2);
    expect(workflow).not.toMatch(/railway deploy\b/u);
  });

  it('requires seven exact-main checks and the tree-equivalent PR dependency review from GitHub Actions', () => {
    for (const check of [
      'TypeScript — zero errors',
      'Lint — zero warnings (backend/src/)',
      'Security audit — no high/critical production vulnerabilities',
      'Tests — zero failures',
      'Build Validation',
      'audit',
      'codeql',
      'dependency-review',
    ]) {
      expect(workflow).toContain(check);
    }
    expect(workflow).toContain("GITHUB_ACTIONS_APP_ID: '15368'");
    expect(workflow).toContain('.app.id == $app_id');
    expect(workflow).toContain('/commits/${GITHUB_SHA}/pulls?per_page=100');
    expect(workflow).toContain('.merge_commit_sha == $sha');
    expect(workflow).toContain('refs/pull/${pr_number}/head');
    expect(workflow).toContain('git rev-parse "${pr_head_sha}^{tree}"');
    expect(workflow).toContain('git rev-parse "${GITHUB_SHA}^{tree}"');
  });

  it('requires an authenticated and content-addressed Governor status', () => {
    expect(workflow).toContain('Governor admission');
    expect(workflow).toContain("GOVERNOR_PUBLISHER_ID: '192952981'");
    expect(workflow).toContain("INDEPENDENT_REVIEWER_ID: '19916085'");
    expect(workflow).toContain('GOVERNOR_CONTROL_REPOSITORY: Sebdysart/hustlexp-site');
    expect(workflow).toContain(".creator.type // \"missing\"");
    expect(workflow).toContain(
      'governor-control:([0-9a-f]{40}):sha256:([0-9a-f]{64})'
    );
    expect(workflow).toContain(
      'expected_governor_target="https://github.com/${GOVERNOR_CONTROL_REPOSITORY}/commit/${governor_control_sha}"'
    );
    expect(workflow).toContain('.state // "missing"');
    expect(workflow).toContain('.commit_id // ""');
  });

  it('revalidates current clean main immediately before migration and each upload', () => {
    expect(workflow).toContain('Revalidate then apply only checksummed registered migrations');
    expect(workflow).toMatch(
      /test -z "\$\(git status --porcelain=v1\)"[\s\S]{0,300}npm run db:migrate:engine/u
    );
    const uploadRevalidations = workflow.match(
      /test -z "\$\(git status --porcelain=v1\)"\n\s+upload_receipt="\$\(railway up /gu
    );
    expect(uploadRevalidations).toHaveLength(2);
  });

  it('binds the one-shot migrator to the protected exact database identity', () => {
    for (const variable of [
      'HX_MIGRATION_EXPECTED_DATABASE_NAME',
      'HX_MIGRATION_EXPECTED_DATABASE_OID',
      'HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER',
    ]) {
      expect(workflow).toContain(`${variable}: \${{ vars.${variable} }}`);
    }
  });

  it('deploys one content-addressed archive without persistent build identity variables', () => {
    expect(workflow).toContain('git archive --format=tar');
    expect(workflow).toContain('.hx-release-provenance.json');
    expect(workflow).toContain('source_archive_sha256');
    expect(workflow).toContain('migration_artifact_sha256');
    expect(workflow).toContain('provenance_sha256');
    expect(workflow).not.toContain('railway variable set');
    for (const variable of [
      'HX_BUILD_REVISION',
      'HX_BUILD_SOURCE_CLEAN',
      'HX_BUILD_TIMESTAMP',
      'MIGRATION_DATABASE_URL',
    ]) {
      expect(workflow).toContain(`has("${variable}") | not`);
    }
  });

  it('captures unique deployment IDs and attests the same exact image for both roles', () => {
    expect(workflow.match(/upload_receipt=/gu)).toHaveLength(2);
    expect(workflow.match(/\.deploymentId \/\/ ""/gu)).toHaveLength(2);
    expect(workflow.match(/select\(\.id == \$id\)/gu)).toHaveLength(2);
    expect(workflow.match(/deployment_id=\$deployment_id/gu)).toHaveLength(2);
    expect(workflow.match(/\.meta\.imageDigest/gu)).toHaveLength(2);
    expect(workflow).toContain('test "$image_digest" = "${{ steps.web.outputs.image_digest }}"');
    expect(workflow).toContain('steps.web.outputs.deployment_id');
    expect(workflow).toContain('steps.worker.outputs.deployment_id');
    expect(workflow).not.toContain('${observed:-{}}');
  });

  it('fails unless public health exposes exact provenance and the payment freeze', () => {
    expect(workflow).toContain('.build.revision == $sha');
    expect(workflow).toContain('.build.source == "release-provenance"');
    expect(workflow).toContain('.build.source_tree == $source_tree');
    expect(workflow).toContain('.build.source_archive_sha256 == $source_archive');
    expect(workflow).toContain('.build.migration_artifact_sha256 == $migration');
    expect(workflow).toContain('.build.provenance_sha256 == $provenance');
    expect(workflow).toContain('.paymentCreation.mode == "frozen"');
    expect(workflow).toContain('.paymentCreation.acceptsNewCustomerMoney == false');
  });
});
