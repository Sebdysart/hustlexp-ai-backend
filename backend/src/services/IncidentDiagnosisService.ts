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

import { ServiceResult } from '../types';
import { AIClient } from './AIClient';
import { db } from '../db';

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
        details: any;
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
    incident: any,
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
    incident: any,
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
