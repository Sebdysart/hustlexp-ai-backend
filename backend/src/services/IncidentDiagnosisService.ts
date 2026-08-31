/**
 * Incident Diagnosis Service v1.0.0
 *
 * The legacy admin-object diagnosis surface is release-frozen. The separate
 * exported rule-based function below remains the real-data implementation.
 *
 * @see backend/src/services/AnomalyDetectionService.ts
 */

import { ServiceResult } from '../types.js';
import { db } from '../db.js';

export const AI_INCIDENT_DIAGNOSIS_DORMANT = 'AI_INCIDENT_DIAGNOSIS_DORMANT' as const;

export const IncidentDiagnosisService = {
  /**
   * Structurally dormant before database, provider, or persistence access.
   */
  async diagnoseIncident(_incidentId: string): Promise<ServiceResult<never>> {
    return {
      success: false,
      error: {
        code: AI_INCIDENT_DIAGNOSIS_DORMANT,
        message: AI_INCIDENT_DIAGNOSIS_DORMANT,
      },
    };
  },
};

// ============================================================================
// Standalone exported diagnoseIncident function
// ============================================================================

export interface IncidentDiagnosisV2 {
  incidentId: string;
  rootCause: string;
  suggestedAction: string;
  diagnosisMethod: 'rule_based' | 'ai_assisted';
  confidence: number; // 0.0 - 1.0
  correlatedEvents: string[];
}

/**
 * Diagnose an incident by ID using only rule-based heuristics over database evidence.
 * Uses db.readQuery for fetches and db.query for persistence.
 */
export async function diagnoseIncident(
  incidentId: string
): Promise<ServiceResult<IncidentDiagnosisV2>> {
  try {
    // 1. Fetch the incident
    const incidentResult = await db.readQuery<{
      id: string;
      event_type: string;
      severity: string;
      service: string;
      details: Record<string, unknown>;
      diagnosis: unknown;
      resolved_at: unknown;
      created_at: string;
    }>(
      'SELECT * FROM incident_events WHERE id = $1',
      [incidentId]
    );

    if (!incidentResult.rowCount || incidentResult.rowCount === 0) {
      return {
        success: false,
        error: { code: 'INCIDENT_NOT_FOUND', message: `Incident ${incidentId} not found` },
      };
    }

    const incident = incidentResult.rows[0];

    // 2. Fetch correlated events (within 5 minutes of this incident)
    const correlatedResult = await db.readQuery<{ id: string }>(
      `SELECT id FROM incident_events
       WHERE id != $1
         AND created_at BETWEEN $2::timestamptz - INTERVAL '5 minutes'
             AND $2::timestamptz + INTERVAL '5 minutes'
       ORDER BY created_at`,
      [incidentId, incident.created_at]
    );

    const correlatedEvents = correlatedResult.rows.map(r => r.id);

    // 3. Rule-based diagnosis
    const { rootCause, suggestedAction, confidence } = applyDiagnosisRules(
      incident.event_type,
      incident.service
    );

    const result: IncidentDiagnosisV2 = {
      incidentId,
      rootCause,
      suggestedAction,
      diagnosisMethod: 'rule_based',
      confidence,
      correlatedEvents,
    };

    // 4. Persist diagnosis back to the incident record
    await db.query(
      'UPDATE incident_events SET diagnosis = $1 WHERE id = $2',
      [JSON.stringify(result), incidentId]
    );

    return { success: true, data: result };
  } catch (_error) {
    return {
      success: false,
      error: { code: 'DIAGNOSIS_FAILED', message: 'Failed to diagnose incident' },
    };
  }
}

function applyDiagnosisRules(
  eventType: string,
  service: string
): { rootCause: string; suggestedAction: string; confidence: number } {
  switch (eventType) {
    case 'circuit_open':
      return {
        rootCause: `Circuit breaker opened for ${service} — repeated downstream failures detected`,
        suggestedAction: 'Investigate downstream service health, check recent deployments and error logs',
        confidence: 0.8,
      };
    case 'error_spike':
      return {
        rootCause: `Error rate spike detected in ${service}`,
        suggestedAction: 'Check recent deployments and rollback if necessary; inspect error logs',
        confidence: 0.7,
      };
    case 'latency_spike':
      return {
        rootCause: `P95 latency spike detected in ${service}`,
        suggestedAction: 'Inspect database query performance and connection pool; check for slow queries',
        confidence: 0.65,
      };
    case 'budget_alert':
      return {
        rootCause: `AI budget threshold exceeded for ${service}`,
        suggestedAction: 'Review AI usage patterns and optimize call frequency or increase budget',
        confidence: 0.9,
      };
    default:
      return {
        rootCause: `Unknown incident type: ${eventType}`,
        suggestedAction: 'Manual investigation required',
        confidence: 0.3,
      };
  }
}
