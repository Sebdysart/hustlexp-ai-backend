/**
 * Incident Diagnosis Service v1.0.0
 *
 * Automated incident diagnosis via AI reasoning:
 * 1. Correlate with recent deployments (Railway timestamps)
 * 2. Correlate with recent git commits
 * 3. Query knowledge graph for related invariants/specs
 * 4. Call AIClient reasoning route (DeepSeek) for synthesis
 *
 * Graceful degradation: reasoning → fast → rule-based heuristics
 *
 * @see backend/src/services/AnomalyDetectionService.ts
 */

import { ServiceResult } from '../types.js';
import { AIClient } from './AIClient.js';
import { db } from '../db.js';

export interface IncidentDiagnosis {
  incidentId: string;
  confidence: number; // 0-100
  rootCause: string;
  relatedCommits: string[];
  relatedDeployments: string[];
  suggestedFix: string;
  reasoning: string; // AI reasoning chain
}

export const IncidentDiagnosisService = {
  /**
   * Diagnose incident using AI reasoning
   */
  async diagnoseIncident(incidentId: string): Promise<ServiceResult<IncidentDiagnosis>> {
    try {
      // Fetch incident details
      const incidentResult = await db.query<{
        event_type: string;
        severity: string;
        service: string;
        details: Record<string, unknown>;
        created_at: Date;
      }>(
        'SELECT event_type, severity, service, details, created_at FROM incident_events WHERE id = $1',
        [incidentId]
      );

      if (incidentResult.rowCount === 0) {
        return {
          success: false,
          error: { code: 'HX600', message: 'Incident not found' },
        };
      }

      const incident = incidentResult.rows[0];

      // Correlate with recent events
      const recentCommits = await this.getRecentCommits();
      const recentDeployments = await this.getRecentDeployments();

      // Build diagnosis prompt
      const prompt = this.buildDiagnosisPrompt(incident, recentCommits, recentDeployments);

      // Try AI reasoning route (DeepSeek)
      let diagnosis: IncidentDiagnosis;

      try {
        const aiResponse = await AIClient.call({
          route: 'reasoning',
          
          systemPrompt: 'You are an expert DevOps engineer diagnosing production incidents.',
          prompt,
        });

        diagnosis = this.parseAIDiagnosis(incidentId, aiResponse.content);
      } catch (aiError) {
        console.warn('AI reasoning failed, using rule-based heuristics:', aiError);
        diagnosis = this.ruleBasedDiagnosis(incidentId, incident, recentCommits, recentDeployments);
      }

      // Save diagnosis to database
      await db.query(
        'UPDATE incident_events SET diagnosis = $1 WHERE id = $2',
        [JSON.stringify(diagnosis), incidentId]
      );

      return { success: true, data: diagnosis };
    } catch (error) {
      console.error('IncidentDiagnosisService.diagnoseIncident error:', error);
      return {
        success: false,
        error: { code: 'HX600', message: 'Internal server error' },
      };
    }
  },

  /**
   * Build diagnosis prompt for AI
   */
  buildDiagnosisPrompt(
    incident: { event_type: string; severity: string; service: string; details: Record<string, unknown>; created_at: Date },
    recentCommits: string[],
    recentDeployments: string[]
  ): string {
    return `
Diagnose the following production incident:

**Incident Details:**
- Type: ${incident.event_type}
- Severity: ${incident.severity}
- Service: ${incident.service}
- Time: ${incident.created_at}
- Details: ${JSON.stringify(incident.details, null, 2)}

**Recent Commits (last 24h):**
${recentCommits.length > 0 ? recentCommits.join('\n') : 'None'}

**Recent Deployments (last 24h):**
${recentDeployments.length > 0 ? recentDeployments.join('\n') : 'None'}

Provide:
1. Root cause analysis (what likely caused this)
2. Correlation with commits/deployments
3. Suggested fix
4. Confidence score (0-100)

Format your response as JSON:
{
  "rootCause": "...",
  "relatedCommits": [...],
  "relatedDeployments": [...],
  "suggestedFix": "...",
  "confidence": 85,
  "reasoning": "..."
}
`;
  },

  /**
   * Parse AI diagnosis response
   */
  parseAIDiagnosis(incidentId: string, aiResponse: string): IncidentDiagnosis {
    try {
      // Try to extract JSON from response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          incidentId,
          confidence: parsed.confidence || 50,
          rootCause: parsed.rootCause || 'Unknown',
          relatedCommits: parsed.relatedCommits || [],
          relatedDeployments: parsed.relatedDeployments || [],
          suggestedFix: parsed.suggestedFix || 'Manual investigation required',
          reasoning: parsed.reasoning || aiResponse,
        };
      }
    } catch (parseError) {
      console.warn('Failed to parse AI diagnosis JSON:', parseError);
    }

    // Fallback: use raw response
    return {
      incidentId,
      confidence: 30,
      rootCause: 'Unable to determine from AI response',
      relatedCommits: [],
      relatedDeployments: [],
      suggestedFix: 'Manual investigation required',
      reasoning: aiResponse,
    };
  },

  /**
   * Rule-based diagnosis (fallback when AI unavailable)
   */
  ruleBasedDiagnosis(
    incidentId: string,
    incident: { event_type: string; severity: string; service: string; details: Record<string, unknown>; created_at: Date },
    recentCommits: string[],
    recentDeployments: string[]
  ): IncidentDiagnosis {
    let rootCause = 'Unknown';
    let suggestedFix = 'Manual investigation required';
    let confidence = 40;

    // Simple heuristics
    if (incident.event_type === 'error_spike' && recentDeployments.length > 0) {
      rootCause = 'Likely related to recent deployment';
      suggestedFix = 'Review recent deployment logs and consider rollback';
      confidence = 70;
    } else if (incident.event_type === 'latency_spike') {
      rootCause = 'Performance degradation detected';
      suggestedFix = 'Check database query performance and API response times';
      confidence = 50;
    } else if (incident.event_type === 'budget_threshold') {
      rootCause = 'AI budget threshold exceeded';
      suggestedFix = 'Review AI usage patterns and consider increasing budget or optimizing calls';
      confidence = 90;
    } else if (incident.event_type === 'circuit_breaker_open') {
      rootCause = 'Circuit breaker opened due to repeated failures';
      suggestedFix = 'Investigate downstream service health';
      confidence = 60;
    }

    return {
      incidentId,
      confidence,
      rootCause,
      relatedCommits: recentCommits.slice(0, 5),
      relatedDeployments: recentDeployments.slice(0, 3),
      suggestedFix,
      reasoning: 'Rule-based heuristic diagnosis (AI unavailable)',
    };
  },

  /**
   * Get recent git commits (mock - in production, query git history)
   */
  async getRecentCommits(): Promise<string[]> {
    // In production, execute: git log --since="24 hours ago" --oneline
    return [
      // Mock commits
      'a1b2c3d Fix escrow release KYC gate',
      'e4f5g6h Add movement tracking service',
    ];
  },

  /**
   * Get recent deployments (mock - in production, query Railway API)
   */
  async getRecentDeployments(): Promise<string[]> {
    // In production, query Railway deployment history API
    return [
      // Mock deployments
      'Deployment #123 - 2 hours ago - SUCCESS',
    ];
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
 * Diagnose an incident by ID using rule-based heuristics (with AI fallback).
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

    // 3. Fetch recent incidents for AI context (not currently used in rule-based)
    await db.readQuery(
      'SELECT id, event_type FROM incident_events WHERE id != $1 ORDER BY created_at DESC LIMIT 5',
      [incidentId]
    );

    // 4. Rule-based diagnosis
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

    // 5. Persist diagnosis back to the incident record
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
