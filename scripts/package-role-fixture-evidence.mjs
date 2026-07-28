#!/usr/bin/env node
/**
 * EPIC-04 — package role-fixture evidence schema (no production writes).
 * Reads an input JSON describing fixtures and writes a normalized evidence file.
 *
 * Usage:
 *   node scripts/package-role-fixture-evidence.mjs --in fixtures.json --out docs/production-role-fixture-evidence.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const ROLES = ['poster', 'hustler', 'business-client', 'service-business', 'operations'];

const inputPath = arg('--in');
const outputPath = arg('--out', 'docs/production-role-fixture-evidence.json');
if (!inputPath) {
  console.error('Usage: node scripts/package-role-fixture-evidence.mjs --in fixtures.json [--out out.json]');
  process.exit(1);
}

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const fixtures = Array.isArray(input.fixtures) ? input.fixtures : [];
const byRole = Object.fromEntries(ROLES.map((role) => [role, []]));
for (const fixture of fixtures) {
  const role = String(fixture.role ?? '');
  if (!byRole[role]) {
    throw new Error(`Unknown role: ${role}`);
  }
  if (!fixture.expires_at) throw new Error(`Fixture missing expires_at for ${role}`);
  if (fixture.test_exclusion !== true) throw new Error(`Fixture must set test_exclusion=true for ${role}`);
  byRole[role].push({
    role,
    identity_redacted: fixture.identity_redacted ?? 'REDACTED',
    expires_at: fixture.expires_at,
    entry: fixture.entry ?? null,
    destination: fixture.destination ?? null,
    recovery: fixture.recovery ?? null,
    journey_evidence: fixture.journey_evidence ?? null,
  });
}

const ready = ROLES.map((role) => ({
  role,
  ready_accounts: byRole[role].length,
  fixtures: byRole[role],
}));

const payload = {
  schema_version: 1,
  kind: 'production_role_fixture_evidence',
  generated_at: new Date().toISOString(),
  claim_boundary: 'Fixture packaging only. Does not create accounts or claim GMV.',
  gates_proven: ready.filter((row) => row.ready_accounts > 0).length,
  gates_total: ROLES.length,
  roles: ready,
  status: ready.every((row) => row.ready_accounts > 0) ? 'PROVEN' : 'BLOCKED_AUTHORITY',
};

writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
process.stdout.write(`${outputPath}\nstatus=${payload.status}\n`);
