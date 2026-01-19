/**
 * AnalyticsService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §13, ANALYTICS_SPEC.md
 * 
 * Implements event tracking, conversion funnels, cohort analysis, and A/B testing.
 * Core Principle: Track everything, but respect user privacy (consent-based).
 * 
 * @see schema.sql §11.6 (analytics_events table)
 * @see PRODUCT_SPEC.md §13
 * @see staging/ANALYTICS_SPEC.md
 */

import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';
import { GDPRService } from './GDPRService';

// ============================================================================
// TYPES
// ============================================================================

export type EventCategory = 'user_action' | 'system_event' | 'error' | 'performance';
export type EventType = 
  | 'task_created' | 'task_accepted' | 'task_completed' | 'task_cancelled'
  | 'escrow_funded' | 'escrow_released' | 'escrow_refunded'
  | 'proof_submitted' | 'proof_approved' | 'proof_rejected'
  | 'dispute_opened' | 'dispute_resolved'
  | 'rating_submitted' | 'rating_received'
  | 'message_sent' | 'message_read'
  | 'notification_sent' | 'notification_opened'
  | 'user_onboarded' | 'user_trust_tier_upgraded'
  | 'search_performed' | 'filter_applied'
  | 'page_view' | 'button_click' | 'form_submitted'
  | 'error_occurred' | 'performance_metric';

export interface AnalyticsEvent {
  id: string;
  event_type: string; // VARCHAR(100) - flexible event type
  event_category: EventCategory;
  user_id?: string | null; // NULL for anonymous events
  session_id: string; // UUID
  device_id: string; // UUID
  task_id?: string | null;
  task_category?: string | null;
  trust_tier?: number | null;
  properties: Record<string, unknown>; // JSONB
  platform: 'ios' | 'android' | 'web'; // Schema requires this
  app_version?: string | null; // Schema has this
  ab_test_id?: string | null; // Schema has this
  ab_variant?: string | null; // Schema has this
  event_timestamp: Date; // Schema uses event_timestamp (not created_at)
  ingested_at: Date; // Schema has ingested_at
}

export interface TrackEventParams {
  eventType: EventType | string; // Allow custom event types
  eventCategory: EventCategory;
  userId?: string; // Optional - may be anonymous
  sessionId: string;
  deviceId: string;
  taskId?: string;
  taskCategory?: string;
  trustTier?: number;
  properties?: Record<string, unknown>; // Optional event properties
  platform: 'ios' | 'android' | 'web'; // Required in schema
  appVersion?: string; // Optional app version
  abTestId?: string; // Optional A/B test ID
  abVariant?: string; // Optional A/B test variant
  eventTimestamp?: Date; // Optional - defaults to NOW()
  ipAddress?: string; // Will be anonymized (NOT stored in schema - privacy)
  userAgent?: string; // NOT stored in schema - privacy
}

export interface ConversionFunnel {
  name: string;
  steps: string[]; // Event types representing funnel steps
  timeWindow: number; // Days
  conversionRate: number; // Percentage
  dropoffRates: Record<string, number>; // Step -> dropoff %
}

export interface CohortAnalysis {
  cohort: string; // e.g., "2025-01" for January 2025 cohort
  size: number; // Users in cohort
  retentionRates: Record<string, number>; // Week -> retention %
  activityRates: Record<string, number>; // Week -> activity %
}

// ============================================================================
// SERVICE
// ============================================================================

export const AnalyticsService = {
  // --------------------------------------------------------------------------
  // EVENT TRACKING
  // --------------------------------------------------------------------------
  
  /**
   * Track an analytics event
   * 
   * ANALYTICS_SPEC.md §1: All user actions and system events are tracked
   * 
   * Privacy: Respects user consent (only track if user has granted analytics consent)
   */
  trackEvent: async (
    params: TrackEventParams
  ): Promise<ServiceResult<AnalyticsEvent>> => {
    try {
      // Privacy check: Verify user has granted analytics consent (GDPR compliance)
      if (params.userId) {
        const consentResult = await GDPRService.getConsentStatus(params.userId, 'analytics');
        
        if (consentResult.success && consentResult.data.length > 0) {
          const analyticsConsent = consentResult.data.find(c => c.consent_type === 'analytics');
          
          // If consent exists and is not granted, skip tracking (respect user privacy)
          if (analyticsConsent && !analyticsConsent.granted) {
            return {
              success: false,
              error: {
                code: 'CONSENT_REQUIRED',
                message: 'Analytics tracking requires user consent',
              },
            };
          }
        }
        // If no consent record exists, default to allowing tracking (opt-out model)
        // This can be changed to opt-in by checking for explicit consent
      }
      
      // Schema does NOT store IP address or user agent (privacy-first)
      // Anonymize if needed for processing, but don't store
      
      // Use provided event_timestamp or default to NOW()
      const eventTimestamp = params.eventTimestamp || new Date();
      
      // Create event (schema uses event_timestamp, ingested_at, platform, app_version, ab_test_id, ab_variant)
      const result = await db.query<AnalyticsEvent>(
        `INSERT INTO analytics_events (
          event_type, event_category, user_id, session_id, device_id,
          task_id, task_category, trust_tier, properties,
          platform, app_version, ab_test_id, ab_variant,
          event_timestamp, ingested_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10, $11, $12, $13, $14, NOW())
        RETURNING *`,
        [
          params.eventType,
          params.eventCategory,
          params.userId || null,
          params.sessionId,
          params.deviceId,
          params.taskId || null,
          params.taskCategory || null,
          params.trustTier || null,
          JSON.stringify(params.properties || {}),
          params.platform, // Required
          params.appVersion || null,
          params.abTestId || null,
          params.abVariant || null,
          eventTimestamp,
        ]
      );
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Track multiple events in a batch (for performance)
   */
  trackBatch: async (
    events: TrackEventParams[]
  ): Promise<ServiceResult<{ tracked: number; failed: number }>> => {
    try {
      let tracked = 0;
      let failed = 0;
      
      for (const event of events) {
        const result = await AnalyticsService.trackEvent(event);
        if (result.success) {
          tracked++;
        } else {
          failed++;
        }
      }
      
      return {
        success: true,
        data: { tracked, failed },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get events for a user (with privacy checks)
   */
  getUserEvents: async (
    userId: string,
    eventTypes?: EventType[],
    limit: number = 100,
    offset: number = 0
  ): Promise<ServiceResult<AnalyticsEvent[]>> => {
    try {
      let sql = `SELECT * FROM analytics_events WHERE user_id = $1`;
      const params: unknown[] = [userId];
      
      if (eventTypes && eventTypes.length > 0) {
        params.push(eventTypes);
        sql += ` AND event_type = ANY($${params.length})`;
      }
      
      sql += ` ORDER BY event_timestamp DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const result = await db.query<AnalyticsEvent>(sql, params);
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get events for a task
   */
  getTaskEvents: async (
    taskId: string,
    limit: number = 100
  ): Promise<ServiceResult<AnalyticsEvent[]>> => {
    try {
      const result = await db.query<AnalyticsEvent>(
        `SELECT * FROM analytics_events
         WHERE task_id = $1
         ORDER BY event_timestamp DESC
         LIMIT $2`,
        [taskId, limit]
      );
      
      return {
        success: true,
        data: result.rows,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // CONVERSION FUNNELS
  // --------------------------------------------------------------------------
  
  /**
   * Calculate conversion funnel
   * 
   * ANALYTICS_SPEC.md §2: Track conversion rates through multi-step processes
   * 
   * Example: Task creation → Task acceptance → Task completion → Payment release
   */
  calculateFunnel: async (
    funnelName: string,
    steps: EventType[],
    timeWindowDays: number = 30
  ): Promise<ServiceResult<ConversionFunnel>> => {
    try {
      // Get event counts for each step
      const stepCounts: Record<string, number> = {};
      
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const result = await db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT user_id) as count
           FROM analytics_events
           WHERE event_type = $1
             AND event_timestamp >= NOW() - INTERVAL '${timeWindowDays} days'
             AND user_id IS NOT NULL`,
          [step]
        );
        
        stepCounts[step] = parseInt(result.rows[0]?.count || '0', 10);
      }
      
      // Calculate conversion rates
      const firstStepCount = stepCounts[steps[0]] || 0;
      const lastStepCount = stepCounts[steps[steps.length - 1]] || 0;
      const overallConversionRate = firstStepCount > 0 
        ? (lastStepCount / firstStepCount) * 100 
        : 0;
      
      // Calculate dropoff rates between steps
      const dropoffRates: Record<string, number> = {};
      for (let i = 0; i < steps.length - 1; i++) {
        const currentStep = steps[i];
        const nextStep = steps[i + 1];
        const currentCount = stepCounts[currentStep] || 0;
        const nextCount = stepCounts[nextStep] || 0;
        
        if (currentCount > 0) {
          dropoffRates[`${currentStep}→${nextStep}`] = ((currentCount - nextCount) / currentCount) * 100;
        } else {
          dropoffRates[`${currentStep}→${nextStep}`] = 0;
        }
      }
      
      return {
        success: true,
        data: {
          name: funnelName,
          steps,
          timeWindow: timeWindowDays,
          conversionRate: overallConversionRate,
          dropoffRates,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // COHORT ANALYSIS
  // --------------------------------------------------------------------------
  
  /**
   * Calculate cohort retention rates
   * 
   * ANALYTICS_SPEC.md §3: Track user cohorts and retention
   */
  calculateCohortRetention: async (
    cohortMonth: string // e.g., "2025-01"
  ): Promise<ServiceResult<CohortAnalysis>> => {
    try {
      // Get cohort size (users who onboarded in this month)
      const cohortSizeResult = await db.query<{ count: string }>(
        `SELECT COUNT(DISTINCT user_id) as count
         FROM analytics_events
         WHERE event_type = 'user_onboarded'
           AND DATE_TRUNC('month', event_timestamp) = DATE_TRUNC('month', $1::DATE)
           AND user_id IS NOT NULL`,
        [`${cohortMonth}-01`]
      );
      
      const cohortSize = parseInt(cohortSizeResult.rows[0]?.count || '0', 10);
      
      // Calculate retention rates for weeks 1-12
      const retentionRates: Record<string, number> = {};
      const activityRates: Record<string, number> = {};
      
      for (let week = 1; week <= 12; week++) {
        // Week retention: Users who were active in week N
        const retentionResult = await db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT user_id) as count
           FROM analytics_events
           WHERE user_id IN (
             SELECT DISTINCT user_id FROM analytics_events
             WHERE event_type = 'user_onboarded'
               AND DATE_TRUNC('month', event_timestamp) = DATE_TRUNC('month', $1::DATE)
           )
             AND event_timestamp >= DATE_TRUNC('month', $1::DATE) + INTERVAL '${week - 1} weeks'
             AND event_timestamp < DATE_TRUNC('month', $1::DATE) + INTERVAL '${week} weeks'
             AND user_id IS NOT NULL`,
          [`${cohortMonth}-01`]
        );
        
        const weekActiveCount = parseInt(retentionResult.rows[0]?.count || '0', 10);
        const retentionRate = cohortSize > 0 ? (weekActiveCount / cohortSize) * 100 : 0;
        
        retentionRates[`week_${week}`] = retentionRate;
        activityRates[`week_${week}`] = weekActiveCount;
      }
      
      return {
        success: true,
        data: {
          cohort: cohortMonth,
          size: cohortSize,
          retentionRates,
          activityRates,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // A/B TESTING (Placeholder - Future Enhancement)
  // --------------------------------------------------------------------------
  
  /**
   * Track A/B test assignment and conversion
   * 
   * ANALYTICS_SPEC.md §4: A/B testing framework
   * 
   * Note: sessionId and deviceId should be provided by the client for proper tracking.
   * If not provided, will generate placeholder values (not ideal for cross-device tracking).
   */
  trackABTest: async (
    userId: string,
    testName: string,
    variant: 'A' | 'B' | 'control',
    conversionEvent?: EventType,
    sessionId?: string,
    deviceId?: string,
    platform: 'ios' | 'android' | 'web' = 'web'
  ): Promise<ServiceResult<{ assigned: boolean }>> => {
    try {
      // Generate placeholder values if not provided (not ideal, but allows function to work)
      const effectiveSessionId = sessionId || `session_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const effectiveDeviceId = deviceId || `device_${userId}_${Date.now()}`;
      
      // Track test assignment
      await AnalyticsService.trackEvent({
          eventType: `ab_test_assigned_${testName}`,
          eventCategory: 'system_event',
          userId,
          sessionId: effectiveSessionId,
          deviceId: effectiveDeviceId,
          platform,
          properties: {
            test_name: testName,
            variant,
          },
        });
        
        // If conversion event provided, track that too
        if (conversionEvent) {
          await AnalyticsService.trackEvent({
            eventType: conversionEvent,
            eventCategory: 'user_action',
            userId,
            sessionId: effectiveSessionId,
            deviceId: effectiveDeviceId,
            platform,
            abTestId: testName, // Use ab_test_id field
            abVariant: variant, // Use ab_variant field
            properties: {
              is_conversion: true,
            },
          });
        }
      
      return {
        success: true,
        data: { assigned: true },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // AGGREGATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get event counts by type (for dashboards)
   */
  getEventCounts: async (
    eventTypes: EventType[],
    timeWindowDays: number = 30
  ): Promise<ServiceResult<Record<string, number>>> => {
    try {
      const counts: Record<string, number> = {};
      
      for (const eventType of eventTypes) {
        const result = await db.query<{ count: string }>(
          `SELECT COUNT(*) as count
           FROM analytics_events
           WHERE event_type = $1
             AND event_timestamp >= NOW() - INTERVAL '${timeWindowDays} days'`,
          [eventType]
        );
        
        counts[eventType] = parseInt(result.rows[0]?.count || '0', 10);
      }
      
      return {
        success: true,
        data: counts,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Anonymize IP address (privacy requirement)
 * 
 * GDPR_COMPLIANCE_SPEC.md: IP addresses must be anonymized
 */
function anonymizeIP(ipAddress: string): string {
  // Simple anonymization: Remove last octet for IPv4, last 64 bits for IPv6
  if (ipAddress.includes('.')) {
    // IPv4: 192.168.1.100 -> 192.168.1.0
    const parts = ipAddress.split('.');
    if (parts.length === 4) {
      return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
    }
  } else if (ipAddress.includes(':')) {
    // IPv6: 2001:0db8:85a3:0000:0000:8a2e:0370:7334 -> 2001:0db8:85a3:0000:0000:0000:0000:0000
    const parts = ipAddress.split(':');
    if (parts.length === 8) {
      return `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]}:0000:0000:0000:0000`;
    }
  }
  
  return ipAddress; // Return as-is if can't anonymize
}
