import { createHash } from 'node:crypto';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{40}$/u;
const NON_EMPTY = (value) => typeof value === 'string' && value.trim().length > 0;

export const EXPECTED_CATEGORIES = Object.freeze([
  'cleaning',
  'furniture_assembly',
  'moving',
  'yard',
]);

const EXPECTED_POLICY_SUMMARY = Object.freeze({
  moving: {
    allowed_risk_levels: ['LOW', 'MEDIUM'],
    background_check_required: true,
    license_required: false,
    insurance_required: false,
    proof_photos: { minimum: 2, maximum: 5 },
    gps_proof_required: false,
  },
  yard: {
    allowed_risk_levels: ['LOW'],
    background_check_required: false,
    license_required: false,
    insurance_required: false,
    proof_photos: { minimum: 1, maximum: 5 },
    gps_proof_required: false,
  },
  cleaning: {
    allowed_risk_levels: ['LOW', 'MEDIUM', 'IN_HOME'],
    background_check_required: true,
    license_required: false,
    insurance_required: false,
    proof_photos: { minimum: 2, maximum: 5 },
    gps_proof_required: false,
  },
  furniture_assembly: {
    allowed_risk_levels: ['LOW', 'MEDIUM', 'IN_HOME'],
    background_check_required: true,
    license_required: false,
    insurance_required: false,
    proof_photos: { minimum: 2, maximum: 5 },
    gps_proof_required: false,
  },
  recording: { allowed: false, standalone_consent_required: true },
  worker_rights: {
    standalone_screening_consent_required: true,
    report_access_required: true,
    dispute_and_appeal_required: true,
    adverse_action_notice_required: true,
  },
  financial_floors_cents: {
    currency: 'usd',
    customer_total: 5000,
    worker_payout: 4000,
    platform_margin: 500,
  },
  safety: {
    incident_intake_required: true,
    timed_checkin_risk_levels: ['MEDIUM', 'HIGH', 'IN_HOME'],
    checkin_intervals_minutes: [15, 30, 60],
    location_retention_days: 30,
    alternate_emergency_action_required: true,
  },
});

export const EXPECTED_ARTIFACTS = Object.freeze([
  Object.freeze({
    id: 'region-policy-contract',
    repository: 'Sebdysart/hustlexp-ai-backend',
    revision: 'd861f25984d0bebcbdfe7176bdee9f869222a5d1',
    path: 'backend/database/migrations/20260718_region_policy_contract.sql',
    sha256: '01c65eb106aa9ad3a9909e08b882f6ba908bf626e0c23a68136c64fe39ec9311',
    local: true,
  }),
  Object.freeze({
    id: 'region-policy-price-book',
    repository: 'Sebdysart/hustlexp-ai-backend',
    revision: 'd861f25984d0bebcbdfe7176bdee9f869222a5d1',
    path: 'backend/database/migrations/20260720_region_policy_price_book_alignment.sql',
    sha256: '614ac15399457b310f60e4bf637ee1d394a0da97e9cbcd9d6a8367a219af68e0',
    local: true,
  }),
  Object.freeze({
    id: 'region-policy-runtime',
    repository: 'Sebdysart/hustlexp-ai-backend',
    revision: '5936ea0b675f17038feaf9565e5baa7d3b1e8211',
    path: 'backend/src/services/RegionPolicyService.ts',
    sha256: 'a2ab4a8b890cb162b1046a6de9f28e749904339b45c87335256945e3f7fd8d1f',
    local: true,
  }),
  Object.freeze({
    id: 'region-policy-legal-approval-activation',
    repository: 'Sebdysart/hustlexp-ai-backend',
    revision: '5936ea0b675f17038feaf9565e5baa7d3b1e8211',
    path: 'backend/database/migrations/20260722_region_policy_legal_approval_activation.sql',
    sha256: '2be054f21aa0168aad360dd755d52fd5b028a8106129206f47ccfbbc7f081e02',
    local: true,
  }),
  Object.freeze({
    id: 'public-terms',
    repository: 'Sebdysart/hustlexp-site',
    revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
    path: 'src/pages/Terms.tsx',
    sha256: 'b50ca32fd6f9ddaf9652bd0685acf1a9aa0f30ddb912338121b7dad9c70a638a',
    local: false,
  }),
  Object.freeze({
    id: 'public-privacy',
    repository: 'Sebdysart/hustlexp-site',
    revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
    path: 'src/pages/Privacy.tsx',
    sha256: '11d577d575bbf4e0543ee5263ba32a41f5fc3511f9c045008a21bd4c2312a983',
    local: false,
  }),
  Object.freeze({
    id: 'worker-screening-rights-grounding',
    repository: 'Sebdysart/hustlexp-site',
    revision: 'b55ae5a1815feda78054eb284e5d5ccf6883ac2d',
    path: 'docs/WORKER_SCREENING_RIGHTS_GROUNDING_2026-07-18.md',
    sha256: '88822dc25c43a9f5d89010ebb4df3375aa7d969f23e5af1b78a2ca4266b31bc8',
    local: false,
  }),
]);

const REQUIRED_DETERMINATIONS = Object.freeze([
  'worker_classification',
  'category_licensing',
  'screening_and_adverse_action',
  'privacy_and_retention',
  'payments_payouts_and_tax',
  'disputes_arbitration_and_liability',
  'safety_location_and_recording',
]);

function sameStrings(actual, expected) {
  if (!Array.isArray(actual) || actual.some((value) => typeof value !== 'string')) return false;
  if (new Set(actual).size !== actual.length) return false;
  return [...actual].sort().join('\n') === [...expected].sort().join('\n');
}

function validDate(value) {
  if (!NON_EMPTY(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function validHttpsUrl(value) {
  if (!NON_EMPTY(value)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function safeLocalPath(repoRoot, artifactPath) {
  if (!NON_EMPTY(artifactPath) || isAbsolute(artifactPath)) return null;
  const resolved = resolve(repoRoot, artifactPath);
  const fromRoot = relative(resolve(repoRoot), resolved);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  return resolved;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validateReleaseBinding(name, binding, add) {
  if (!binding || typeof binding !== 'object') {
    add(`${name}_binding_missing`, `${name} release binding is missing`);
    return;
  }
  const expectedRepository =
    name === 'engine' ? 'Sebdysart/hustlexp-ai-backend' : 'Sebdysart/hustlexp-site';
  if (binding.repository !== expectedRepository) {
    add(`${name}_repository_mismatch`, `${name} repository differs from the controlled repository`);
  }
  if (!GIT_REVISION.test(binding.approved_revision ?? '')) {
    add(`${name}_revision_unbound`, `${name} approved revision is not bound`);
  }
  if (!GIT_REVISION.test(binding.deployed_revision ?? '')) {
    add(`${name}_deployed_revision_missing`, `${name} deployed revision is missing`);
  }
  if (
    GIT_REVISION.test(binding.approved_revision ?? '') &&
    GIT_REVISION.test(binding.deployed_revision ?? '') &&
    binding.approved_revision !== binding.deployed_revision
  ) {
    add(
      `${name}_revision_mismatch`,
      `${name} deployed revision differs from the approved revision`
    );
  }
  if (!NON_EMPTY(binding.deployment_id))
    add(`${name}_deployment_missing`, `${name} deployment identity is missing`);
}

function validateApproval(approval, now, add) {
  if (!approval || typeof approval !== 'object') {
    add('approval_missing', 'qualified counsel approval is missing');
    return;
  }
  const counsel = approval.counsel;
  if (!counsel || typeof counsel !== 'object') {
    add('counsel_identity_missing', 'counsel identity is missing');
  } else {
    if (!NON_EMPTY(counsel.name) || !NON_EMPTY(counsel.organization)) {
      add('counsel_identity_missing', 'counsel name or organization is missing');
    }
    if (
      !Array.isArray(counsel.licensed_jurisdictions) ||
      !counsel.licensed_jurisdictions.includes('WA')
    ) {
      add('counsel_qualification_missing', 'Washington counsel qualification is missing');
    }
  }
  if (!NON_EMPTY(approval.policy_owner)) add('policy_owner_missing', 'policy owner is missing');
  if (!NON_EMPTY(approval.activation_owner))
    add('activation_owner_missing', 'activation owner is missing');

  const approvedAt = validDate(approval.approved_at);
  const effectiveAt = validDate(approval.effective_at);
  const reviewAt = validDate(approval.review_at);
  if (!approvedAt) add('approved_at_invalid', 'approval timestamp is missing or invalid');
  if (!effectiveAt) add('effective_at_invalid', 'effective timestamp is missing or invalid');
  if (!reviewAt) add('review_at_invalid', 'review timestamp is missing or invalid');
  if (approvedAt && effectiveAt && approvedAt > effectiveAt) {
    add('approval_date_order_invalid', 'approval occurs after its effective time');
  }
  if (effectiveAt && effectiveAt > now)
    add('approval_not_effective', 'approval is not yet effective');
  if (reviewAt && reviewAt <= now) add('approval_expired', 'approval review date has passed');
  if (effectiveAt && reviewAt && effectiveAt >= reviewAt) {
    add(
      'approval_window_invalid',
      'approval effective and review dates do not form a valid window'
    );
  }
  if (!Array.isArray(approval.exceptions))
    add('exceptions_invalid', 'approval exceptions must be explicit');

  const determinations = approval.determinations;
  for (const key of REQUIRED_DETERMINATIONS) {
    if (determinations?.[key] !== 'APPROVED') {
      add(
        'determination_not_approved',
        'one or more required legal determinations is not approved'
      );
      break;
    }
  }

  const evidence = approval.evidence;
  if (!evidence || typeof evidence !== 'object') {
    add('approval_evidence_missing', 'external approval evidence is missing');
    return;
  }
  if (!validHttpsUrl(evidence.uri))
    add('evidence_uri_invalid', 'approval evidence URI must use HTTPS');
  if (!SHA256.test(evidence.sha256 ?? ''))
    add('evidence_hash_invalid', 'approval evidence hash is invalid');
  if (!NON_EMPTY(evidence.signature_method))
    add('evidence_signature_missing', 'approval signature method is missing');
}

function validateManifest(artifacts, add) {
  const byId = new Map(
    Array.isArray(artifacts) ? artifacts.map((artifact) => [artifact?.id, artifact]) : []
  );
  for (const expected of EXPECTED_ARTIFACTS) {
    const actual = byId.get(expected.id);
    if (!actual) {
      add('controlled_artifact_missing', 'one or more required controlled artifacts is missing');
      continue;
    }
    for (const field of ['repository', 'revision', 'path', 'sha256', 'local']) {
      if (actual[field] !== expected[field]) {
        add(
          'controlled_artifact_manifest_mismatch',
          'a controlled artifact differs from the certified manifest'
        );
        break;
      }
    }
  }
  if (byId.size !== EXPECTED_ARTIFACTS.length) {
    add(
      'controlled_artifact_set_mismatch',
      'controlled artifact set contains missing or unexpected entries'
    );
  }
}

export async function auditProductionLegalApproval({
  packet,
  now = () => new Date(),
  repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  readFile = readFileFromDisk,
  hash = sha256,
  verifyLocalArtifacts = true,
  enforceManifest = true,
} = {}) {
  const findings = [];
  const codes = new Set();
  const add = (code, message) => {
    if (codes.has(code) && code !== 'artifact_hash_mismatch' && code !== 'artifact_read_failed')
      return;
    codes.add(code);
    findings.push({ code, message });
  };
  const document = packet && typeof packet === 'object' ? packet : {};
  const checkedAt = now();

  if (document.schema_version !== 1)
    add('schema_version_invalid', 'legal approval schema version is invalid');
  if (document.gate_id !== 'EXT-LEGAL-001')
    add('gate_id_invalid', 'legal approval gate identity is invalid');
  if (document.decision !== 'APPROVED')
    add('decision_not_approved', 'legal approval decision is not APPROVED');

  const scope = document.scope && typeof document.scope === 'object' ? document.scope : {};
  if (scope.jurisdiction_code !== 'US-WA')
    add('jurisdiction_mismatch', 'jurisdiction must be US-WA');
  if (!Array.isArray(scope.local_jurisdictions) || scope.local_jurisdictions.length === 0) {
    add('local_jurisdiction_missing', 'at least one local launch jurisdiction is required');
  } else if (scope.local_jurisdictions.some((entry) => !NON_EMPTY(entry))) {
    add('local_jurisdiction_invalid', 'local launch jurisdictions must be explicit');
  }
  if (scope.policy_version !== 'us-wa-price-book-2026-07-20-v2') {
    add('policy_version_mismatch', 'regional policy version is not the controlled version');
  }
  if (!SHA256.test(scope.policy_hash ?? ''))
    add('policy_hash_missing', 'regional policy hash is missing or invalid');
  if (!sameStrings(scope.permitted_categories, EXPECTED_CATEGORIES)) {
    add('category_scope_mismatch', 'permitted categories differ from the controlled policy');
  }
  if (!Array.isArray(scope.prohibited_scope) || scope.prohibited_scope.length === 0) {
    add('prohibited_scope_missing', 'prohibited work scope is missing');
  }

  if (
    enforceManifest &&
    JSON.stringify(document.controlled_policy_summary) !== JSON.stringify(EXPECTED_POLICY_SUMMARY)
  ) {
    add(
      'policy_summary_mismatch',
      'human-readable policy summary differs from the controlled policy'
    );
  }

  const artifacts = Array.isArray(document.controlled_artifacts)
    ? document.controlled_artifacts
    : [];
  if (enforceManifest) validateManifest(artifacts, add);
  const artifactIds = new Set();
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      !NON_EMPTY(artifact.id) ||
      artifactIds.has(artifact.id)
    ) {
      add('controlled_artifact_invalid', 'controlled artifact identity is invalid or duplicated');
      continue;
    }
    artifactIds.add(artifact.id);
    if (!NON_EMPTY(artifact.repository) || !GIT_REVISION.test(artifact.revision ?? '')) {
      add('controlled_artifact_invalid', 'controlled artifact repository or revision is invalid');
    }
    if (!SHA256.test(artifact.sha256 ?? ''))
      add('controlled_artifact_hash_invalid', 'controlled artifact hash is invalid');
    if (artifact.local === true && verifyLocalArtifacts) {
      const localPath = safeLocalPath(repoRoot, artifact.path);
      if (!localPath) {
        add('artifact_path_invalid', 'local controlled artifact path is invalid');
        continue;
      }
      try {
        const contents = await readFile(localPath);
        if (hash(contents) !== artifact.sha256) {
          add(
            'artifact_hash_mismatch',
            'local controlled artifact does not match its approved hash'
          );
        }
      } catch {
        add('artifact_read_failed', 'local controlled artifact could not be read');
      }
    }
  }

  validateReleaseBinding('engine', document.release_bindings?.engine, add);
  validateReleaseBinding('site', document.release_bindings?.site, add);
  if (
    document.release_bindings?.engine?.policy_source_revision !==
    '5936ea0b675f17038feaf9565e5baa7d3b1e8211'
  ) {
    add(
      'engine_policy_source_mismatch',
      'engine policy source revision differs from the controlled revision'
    );
  }
  validateApproval(document.approval, checkedAt, add);

  return {
    schema_version: 1,
    gate_id: 'EXT-LEGAL-001',
    decision: document.decision ?? null,
    checked_at: checkedAt.toISOString(),
    pass: findings.length === 0 ? 1 : 0,
    fail: findings.length,
    ok: findings.length === 0,
    findings,
  };
}

export async function verifyProductionLegalApproval(options) {
  const report = await auditProductionLegalApproval(options);
  if (!report.ok) {
    const error = new Error('production legal approval verification failed');
    error.report = report;
    throw error;
  }
  return report;
}

async function run() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const packetPath = resolve(repoRoot, 'ops/compliance/production-legal-approval.json');
  const packet = JSON.parse(await readFileFromDisk(packetPath, 'utf8'));
  return verifyProductionLegalApproval({ packet, repoRoot });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await run(), null, 2));
  } catch (error) {
    if (error?.report) console.error(JSON.stringify(error.report, null, 2));
    else console.error('[production-legal-approval] verification failed');
    process.exitCode = 1;
  }
}
