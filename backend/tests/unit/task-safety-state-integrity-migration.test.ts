import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const MIGRATION = read('backend/database/migrations/20260720_task_safety_state_integrity.sql');
const RUNNER = read('backend/src/jobs/engine-automation-migration.ts');
const DOCKERFILE = read('Dockerfile');
const SERVICE = read('backend/src/services/IncidentSafetyAdminService.ts');

describe('task safety state-integrity migration', () => {
  it('separates platform receipt, provider delivery, and human acknowledgment', () => {
    expect(MIGRATION).toContain("WHERE delivery_state = 'acknowledged'");
    expect(MIGRATION).toContain('task_safety_incident_status_truth_ck');
    expect(MIGRATION).toContain('task_safety_incident_delivery_truth_ck');
    expect(MIGRATION).toContain("delivery_state IN ('contact_attempted', 'contact_delivered', 'contact_failed')");
    expect(MIGRATION).toContain("status = 'received' AND acknowledged_at IS NULL");
  });

  it('binds each contact-delivery transition to append-only provider evidence', () => {
    expect(MIGRATION).toContain('delivery_event_id UUID');
    expect(MIGRATION).toContain('task_safety_incident_delivery_event_fk');
    expect(MIGRATION).toContain('delivery_event.event_type IS DISTINCT FROM NEW.delivery_state');
    expect(MIGRATION).toContain('delivery_event.contact_channel IS DISTINCT FROM NEW.contact_permission');
    expect(MIGRATION).toContain('HX826: delivery state lacks matching append-only provider evidence');
    expect(SERVICE).toContain('delivery_event_id = (');
    expect(SERVICE).toContain('WHERE provider_event_id = $3');
  });

  it('freezes report identity and rejects invalid lifecycle movement', () => {
    expect(MIGRATION).toContain('HX819: safety incident reporter is not assigned to this task');
    expect(MIGRATION).toContain('HX821: safety incident identity, consent, and report facts are immutable');
    expect(MIGRATION).toContain('HX822: invalid safety incident status transition');
    expect(MIGRATION).toContain('HX825: invalid safety contact-delivery transition');
  });

  it('ships the migration in startup and the production image', () => {
    expect(RUNNER).toContain("TASK_SAFETY_STATE_INTEGRITY_MIGRATION = '20260720_task_safety_state_integrity'");
    expect(RUNNER).toContain("fileName: '20260720_task_safety_state_integrity.sql'");
    expect(DOCKERFILE).toContain('/app/backend/database/migrations/20260720_task_safety_state_integrity.sql');
  });
});
