import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  EXPECTED_CATEGORIES,
  auditProductionLegalApproval,
  verifyProductionLegalApproval,
} from './verify-production-legal-approval.mjs';

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);

function approvedPacket(overrides = {}) {
  const packet = {
    schema_version: 1,
    gate_id: 'EXT-LEGAL-001',
    decision: 'APPROVED',
    scope: {
      jurisdiction_code: 'US-WA',
      local_jurisdictions: ['Bellevue', 'Kirkland'],
      policy_version: 'us-wa-price-book-2026-07-20-v2',
      policy_hash: HEX_A,
      permitted_categories: [...EXPECTED_CATEGORIES],
      prohibited_scope: ['licensed work without verified credentials'],
    },
    controlled_artifacts: [
      {
        id: 'region-policy-contract',
        repository: 'Sebdysart/hustlexp-ai-backend',
        revision: 'd861f25984d0bebcbdfe7176bdee9f869222a5d1',
        path: 'backend/database/migrations/20260718_region_policy_contract.sql',
        sha256: HEX_A,
        local: true,
      },
      {
        id: 'region-policy-price-book',
        repository: 'Sebdysart/hustlexp-ai-backend',
        revision: 'd861f25984d0bebcbdfe7176bdee9f869222a5d1',
        path: 'backend/database/migrations/20260720_region_policy_price_book_alignment.sql',
        sha256: HEX_A,
        local: true,
      },
      {
        id: 'region-policy-runtime',
        repository: 'Sebdysart/hustlexp-ai-backend',
        revision: 'd861f25984d0bebcbdfe7176bdee9f869222a5d1',
        path: 'backend/src/services/RegionPolicyService.ts',
        sha256: HEX_A,
        local: true,
      },
      {
        id: 'public-terms',
        repository: 'Sebdysart/hustlexp-site',
        revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
        path: 'src/pages/Terms.tsx',
        sha256: HEX_B,
        local: false,
      },
      {
        id: 'public-privacy',
        repository: 'Sebdysart/hustlexp-site',
        revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
        path: 'src/pages/Privacy.tsx',
        sha256: HEX_B,
        local: false,
      },
      {
        id: 'worker-screening-rights-grounding',
        repository: 'Sebdysart/hustlexp-site',
        revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
        path: 'docs/WORKER_SCREENING_RIGHTS_GROUNDING_2026-07-18.md',
        sha256: HEX_B,
        local: false,
      },
    ],
    release_bindings: {
      engine: {
        repository: 'Sebdysart/hustlexp-ai-backend',
        policy_source_revision: '5936ea0b675f17038feaf9565e5baa7d3b1e8211',
        approved_revision: '1'.repeat(40),
        deployed_revision: '1'.repeat(40),
        deployment_id: 'engine-deployment-1',
      },
      site: {
        repository: 'Sebdysart/hustlexp-site',
        approved_revision: '2'.repeat(40),
        deployed_revision: '2'.repeat(40),
        deployment_id: 'site-deployment-1',
      },
    },
    approval: {
      counsel: {
        name: 'Qualified Counsel',
        organization: 'Example Law',
        licensed_jurisdictions: ['WA'],
      },
      policy_owner: 'HustleXP Policy Owner',
      activation_owner: 'HustleXP Release Owner',
      approved_at: '2026-07-21T18:00:00.000Z',
      effective_at: '2026-07-21T19:00:00.000Z',
      review_at: '2026-10-21T19:00:00.000Z',
      exceptions: [],
      determinations: {
        worker_classification: 'APPROVED',
        category_licensing: 'APPROVED',
        screening_and_adverse_action: 'APPROVED',
        privacy_and_retention: 'APPROVED',
        payments_payouts_and_tax: 'APPROVED',
        disputes_arbitration_and_liability: 'APPROVED',
        safety_location_and_recording: 'APPROVED',
      },
      evidence: {
        uri: 'https://evidence.example.test/legal/approval.pdf',
        sha256: HEX_B,
        signature_method: 'qualified-counsel-signed-record',
      },
    },
  };
  return Object.assign(packet, overrides);
}

test('a complete, current, revision-bound counsel approval passes', async () => {
  const report = await verifyProductionLegalApproval({
    packet: approvedPacket(),
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    verifyLocalArtifacts: false,
    enforceManifest: false,
  });
  assert.equal(report.ok, true);
  assert.equal(report.fail, 0);
});

test('pending counsel state fails closed instead of inferring approval', async () => {
  const packet = approvedPacket({ decision: 'PENDING_COUNSEL' });
  packet.scope.policy_hash = null;
  packet.scope.local_jurisdictions = [];
  packet.approval = null;
  packet.release_bindings.engine.approved_revision = null;
  packet.release_bindings.engine.deployed_revision = '9'.repeat(40);

  const report = await auditProductionLegalApproval({
    packet,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    verifyLocalArtifacts: false,
    enforceManifest: false,
  });
  assert.equal(report.ok, false);
  assert.ok(report.findings.some((finding) => finding.code === 'decision_not_approved'));
  assert.ok(report.findings.some((finding) => finding.code === 'policy_hash_missing'));
  assert.ok(report.findings.some((finding) => finding.code === 'local_jurisdiction_missing'));
  assert.ok(report.findings.some((finding) => finding.code === 'approval_missing'));
  assert.ok(report.findings.some((finding) => finding.code === 'engine_revision_unbound'));
});

test('stale approval and release drift independently block production', async () => {
  const packet = approvedPacket();
  packet.approval.review_at = '2026-07-22T11:59:59.000Z';
  packet.release_bindings.site.deployed_revision = '3'.repeat(40);

  const report = await auditProductionLegalApproval({
    packet,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    verifyLocalArtifacts: false,
    enforceManifest: false,
  });
  assert.ok(report.findings.some((finding) => finding.code === 'approval_expired'));
  assert.ok(report.findings.some((finding) => finding.code === 'site_revision_mismatch'));
});

test('category widening and incomplete legal determinations fail closed', async () => {
  const packet = approvedPacket();
  packet.scope.permitted_categories.push('electrical');
  packet.approval.determinations.worker_classification = 'PENDING';

  const report = await auditProductionLegalApproval({
    packet,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    verifyLocalArtifacts: false,
    enforceManifest: false,
  });
  assert.ok(report.findings.some((finding) => finding.code === 'category_scope_mismatch'));
  assert.ok(report.findings.some((finding) => finding.code === 'determination_not_approved'));
});

test('local artifact hashes are recomputed and path traversal is rejected', async () => {
  const valid = approvedPacket();
  valid.controlled_artifacts[0].sha256 = HEX_A;
  let reads = 0;
  const expectedPaths = new Set([
    '/repo/backend/database/migrations/20260718_region_policy_contract.sql',
    '/repo/backend/database/migrations/20260720_region_policy_price_book_alignment.sql',
    '/repo/backend/src/services/RegionPolicyService.ts',
  ]);
  const healthy = await auditProductionLegalApproval({
    packet: valid,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    repoRoot: '/repo',
    readFile: async (path) => {
      reads += 1;
      assert.ok(expectedPaths.delete(path));
      return Buffer.from('controlled policy');
    },
    hash: () => HEX_A,
    enforceManifest: false,
  });
  assert.equal(healthy.ok, true);
  assert.equal(reads, 3);
  assert.equal(expectedPaths.size, 0);

  const traversal = approvedPacket();
  traversal.controlled_artifacts[0].path = '../secret';
  const failed = await auditProductionLegalApproval({
    packet: traversal,
    now: () => new Date('2026-07-22T12:00:00.000Z'),
    repoRoot: '/repo',
    readFile: async () => Buffer.from('should not be read'),
    hash: () => HEX_A,
    enforceManifest: false,
  });
  assert.ok(failed.findings.some((finding) => finding.code === 'artifact_path_invalid'));
});

test('errors expose findings but never echo approval evidence content', async () => {
  const packet = approvedPacket();
  packet.approval.evidence.uri = 'not-a-url?secret=do-not-print';
  await assert.rejects(
    () =>
      verifyProductionLegalApproval({
        packet,
        now: () => new Date('2026-07-22T12:00:00.000Z'),
        verifyLocalArtifacts: false,
        enforceManifest: false,
      }),
    (error) => {
      assert.match(error.message, /production legal approval verification failed/iu);
      assert.doesNotMatch(error.message, /do-not-print/iu);
      assert.ok(error.report.findings.some((finding) => finding.code === 'evidence_uri_invalid'));
      return true;
    }
  );
});

test('checked-in pending packet has exact local provenance and only external findings', async () => {
  const packet = JSON.parse(
    await readFile(
      new URL('../ops/compliance/production-legal-approval.json', import.meta.url),
      'utf8'
    )
  );
  const report = await auditProductionLegalApproval({
    packet,
    now: () => new Date('2026-07-22T16:30:00.000Z'),
  });
  assert.deepEqual(
    report.findings.map((finding) => finding.code).sort(),
    [
      'approval_missing',
      'decision_not_approved',
      'engine_revision_unbound',
      'local_jurisdiction_missing',
      'policy_hash_missing',
      'site_revision_unbound',
    ]
  );
});
