/**
 * IncidentDiagnosisService v1.0.0
 *
 * Automated diagnosis for detected incidents.
 * Primary method: rule-based heuristics (deterministic, no AI dependency).
 * Stretch: AI-powered diagnosis via AIClient reasoning/fast routes.
 *
 * @see migrations/20260222_008_incident_events.sql
 */

import { db } from '../db';
import { aiLogger } from '../logger';
import type { ServiceResult } from '../types';
import { AIClient } from './AIClient';

const log = aiLogger.child({ service: 'IncidentDiagnosisService' });

// ============================================================================
// TYPES
// ============================================================================

export interface IncidentDiagnosis {
  incidentId: string;
  rootCause: string;
  confidence: number;
  correlatedEvents: string[];
  suggestedAction: string;
  diagnosisMethod: 'ai_reasoning' | 'ai_fast' | 'rule_based';
}

interface IncidentRow {
  id: string;
  event_type: string;
  severity: string;
  service: string;
  details: Record<string, unknown>;
  diagnosis: Record<string, unknown> | null;
  resolved_at: string | null;
  created_at: string;
}

// ============================================================================
// RULE-BASED HEURISTICS
// ============================================================================

const HEURISTICS: Record<string, { rootCause: (service: string) => string; suggestedAction: (service: string) => string; confidence: number }> = {
  circuit_open: {
    rootCause: (service) => `Circuit breaker opened for ${service}. Service is unresponsive or returning errors.`,
    suggestedAction: (service) => `Check ${service} availability and error logs. Verify API keys and rate limits.`,
    confidence: 0.85,
  },
  error_spike: {
    rootCause: () => 'Error rate spike detected above 2x baseline threshold.',
    suggestedAction: () => 'Check recent deployments and external dependencies. Review error logs for common patterns.',
    confidence: 0.7,
  },
  latency_spike: {
    rootCause: () => 'P95 latency spike detected above 2x baseline threshold.',
    suggestedAction: () => 'Check database query performance and connection pool. Review slow query logs and external API latencies.',
    confidence: 0.65,
  },
  budget_alert: {
    rootCause: () => 'AI budget approaching daily limit.',
    suggestedAction: () => 'Review AI usage patterns and consider rate limiting. Check for runaway retry loops or misconfigured agents.',
    confidence: 0.9,
  },
};

function ruleBasedDiagnosis(incident: IncidentRow, correlatedIds: string[]): IncidentDiagnosis {
  const heuristic = HEURISTICS[incident.event_type];

  if (heuristic) {
    return {
      incidentId: incident.id,
      rootCause: heuristic.rootCause(incident.service),
      confidence: heuristic.confidence,
      correlatedEvents: correlatedIds,
      suggestedAction: heuristic.suggestedAction(incident.service),
      diagnosisMethod: 'rule_based',
    };
  }

  // Fallback for unknown event types
  return {
    incidentId: incident.id,
    rootCause: `Unknown incident type: ${incident.event_type} on service ${incident.service}.`,
    confidence: 0.3,
    correlatedEvents: correlatedIds,
    suggestedAction: `Investigate ${incident.event_type} events for service ${incident.service}. Check logs and metrics.`,
    diagnosisMethod: 'rule_based',
  };
}

// ============================================================================
// AI-POWERED DIAGNOSIS (STRETCH)
// ============================================================================

async function aiDiagnosis(
  incident: IncidentRow,
  correlatedIds: string[],
  recentIncidents: IncidentRow[],
): Promise<IncidentDiagnosis | null> {
  if (!AIClient.isConfigured()) return null;

  const contextSummary = recentIncidents
    .slice(0, 10)
    .map((i) => `- ${i.event_type} (${i.severity}) on ${i.service} at ${i.created_at}`)
    .join('\n');

  const prompt = `Analyze this incident and provide root cause diagnosis.

Incident:
- Type: ${incident.event_type}
- Severity: ${incident.severity}
- Service: ${incident.service}
- Details: ${JSON.stringify(incident.details)}
- Created: ${incident.created_at}

Recent incidents (last 24h):
${contextSummary || 'None'}

Respond with a JSON object:
{
  "rootCause": "brief root cause description",
  "confidence": 0.0-1.0,
  "suggestedAction": "recommended action"
}`;

  const routes = ['reasoning', 'fast'] as const;
  for (const route of routes) {
    try {
      const result = await AIClient.call({
        route,
        systemPrompt: 'You are an incident response expert. Analyze system incidents and provide root cause diagnosis. Respond only with valid JSON.',
        prompt,
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 512,
        timeoutMs: 15000,
        enableCache: false,
      });

      const parsed = JSON.parse(result.content);
      return {
        incidentId: incident.id,
        rootCause: String(parsed.rootCause || 'Unknown'),
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5)),
        correlatedEvents: correlatedIds,
        suggestedAction: String(parsed.suggestedAction || 'Investigate further'),
        diagnosisMethod: route === 'reasoning' ? 'ai_reasoning' : 'ai_fast',
      };
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err), route }, 'AI diagnosis failed, trying next route');
    }
  }

  return null;
}

// ============================================================================
// MAIN DIAGNOSIS METHOD
// ============================================================================

/**
 * Diagnose an incident by ID.
 * 1. Fetch incident from DB
 * 2. Find correlated events (same service, last 24h)
 * 3. Try AI diagnosis, fall back to rule-based
 * 4. Store diagnosis back to incident record
 */
export async function diagnoseIncident(incidentId: string): Promise<ServiceResult<IncidentDiagnosis>> {
  try {
    // 1. Fetch the incident
    const incidentResult = await db.readQuery<IncidentRow>(
      `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at
       FROM incident_events WHERE id = $1`,
      [incidentId]
    );

    if (incidentResult.rows.length === 0) {
      return { success: false, error: { code: 'INCIDENT_NOT_FOUND', message: `Incident ${incidentId} not found` } };
    }

    const incident = incidentResult.rows[0];

    // 2. Find correlated events (same service, last 24h, excluding self)
    const correlatedResult = await db.readQuery<{ id: string }>(
      `SELECT id FROM incident_events
       WHERE service = $1 AND id != $2 AND created_at >= NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC LIMIT 20`,
      [incident.service, incidentId]
    );
    const correlatedIds = correlatedResult.rows.map((r) => r.id);

    // 3. Get recent incidents for AI context
    const recentResult = await db.readQuery<IncidentRow>(
      `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at
       FROM incident_events
       WHERE created_at >= NOW() - INTERVAL '24 hours' AND id != $1
       ORDER BY created_at DESC LIMIT 20`,
      [incidentId]
    );

    // 4. Try AI diagnosis, fall back to rule-based
    let diagnosis: IncidentDiagnosis;
    const aiResult = await aiDiagnosis(incident, correlatedIds, recentResult.rows);
    if (aiResult) {
      diagnosis = aiResult;
    } else {
      diagnosis = ruleBasedDiagnosis(incident, correlatedIds);
    }

    // 5. Store diagnosis back to incident
    await db.query(
      `UPDATE incident_events SET diagnosis = $1 WHERE id = $2`,
      [JSON.stringify(diagnosis), incidentId]
    );

    log.info({ incidentId, method: diagnosis.diagnosisMethod, confidence: diagnosis.confidence }, 'Incident diagnosed');

    return { success: true, data: diagnosis };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message, incidentId }, 'Diagnosis failed');
    return { success: false, error: { code: 'DIAGNOSIS_FAILED', message } };
  }
}

// ============================================================================
// EXPORT
// ============================================================================

export const IncidentDiagnosisService = {
  diagnoseIncident,
};

export default IncidentDiagnosisService;
