import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260720_task_geofence_event_contract.sql'),
  'utf8',
);
const SERVICE = readFileSync(
  resolve(process.cwd(), 'backend/src/services/GeofenceService.ts'),
  'utf8',
);
const ROUTER = readFileSync(resolve(process.cwd(), 'backend/src/routers/geofence.ts'), 'utf8');
const RUNNER = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'),
  'utf8',
);
const DOCKERFILE = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

describe('purpose-bound geofence event contract', () => {
  it('creates replayable, version-aware, retention-bound presence evidence', () => {
    for (const field of [
      'client_event_id', 'client_sequence', 'idempotency_key', 'request_hash',
      'prior_task_version', 'local_occurred_at', 'device_version', 'app_version',
      'consent_basis', 'purpose', 'purge_after',
    ]) expect(SQL).toContain(field);
    expect(SQL).toContain('task_geofence_events_task_sequence_uniq');
    expect(SQL).toContain('task_geofence_events_immutable');
    expect(SQL).toContain('task_geofence_events_no_truncate');
  });

  it('purges legacy coordinates and forbids retaining new raw coordinates', () => {
    expect(SQL).toContain('UPDATE task_geofence_events SET location_lat=NULL,location_lng=NULL');
    expect(SQL).toContain('location_lat IS NULL AND location_lng IS NULL');
    expect(SERVICE).not.toContain('event_type, location_lat, location_lng');
    expect(SERVICE).toContain('task_id,user_id,event_type,distance_meters,client_event_id');
  });

  it('requires client replay provenance at the authenticated API boundary', () => {
    for (const field of [
      'clientEventId', 'clientSequence', 'priorTaskVersion', 'localOccurredAt',
      'deviceVersion', 'appVersion',
    ]) expect(ROUTER).toContain(field);
    expect(SERVICE).toContain("code: 'SYNC_CONFLICT'");
    expect(SERVICE).toContain("code: 'IDEMPOTENCY_CONFLICT'");
  });

  it('ships before major-action telemetry in startup and the image', () => {
    const geofenceIndex = RUNNER.indexOf("fileName: '20260720_task_geofence_event_contract.sql'");
    const telemetryIndex = RUNNER.indexOf("fileName: '20260720_major_action_telemetry_contract.sql'");
    expect(geofenceIndex).toBeGreaterThan(-1);
    expect(telemetryIndex).toBeGreaterThan(geofenceIndex);
    expect(DOCKERFILE).toContain('/app/backend/database/migrations/20260720_task_geofence_event_contract.sql');
  });
});
