#!/usr/bin/env node
/**
 * EPIC-02 — structural inventory of critical alert rules (no live Alertmanager call).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const yaml = readFileSync(resolve(root, 'ops/alerts/critical.yml'), 'utf8');

const requiredAlerts = [
  'EscrowStuckInFunded',
  'StripeWebhookFailures',
  'EscrowInvariantViolation',
  'HighErrorRate',
];

const missing = requiredAlerts.filter((name) => !yaml.includes(`alert: ${name}`));
const alertCount = [...yaml.matchAll(/^\s+- alert:\s+(\S+)/gm)].map((m) => m[1]);

const result = {
  schema_version: 1,
  kind: 'alert_inventory',
  path: 'ops/alerts/critical.yml',
  alert_count: alertCount.length,
  alerts: alertCount,
  required_missing: missing,
  ok: missing.length === 0 && alertCount.length >= requiredAlerts.length,
  claim_boundary: 'YAML presence only. Does not prove Alertmanager delivery or on-call ack.',
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) process.exit(2);
