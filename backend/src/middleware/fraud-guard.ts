import { TRPCError } from '@trpc/server';
import { FraudDetectionService } from '../services/FraudDetectionService.js';
import { logger } from '../logger.js';

const log = logger.child({ middleware: 'fraud-guard' });

interface FraudGuardParams {
  entityType: 'user' | 'task' | 'transaction';
  entityId: string;
  action: string;
  blockOnMedium?: boolean;
  failClosed?: boolean;
}

export async function fraudGuard(params: FraudGuardParams): Promise<void> {
  const { entityType, entityId, action, blockOnMedium = false, failClosed = false } = params;

  let assessment;
  try {
    const result = await FraudDetectionService.getRiskAssessment(entityType, entityId);
    if (!result.success) {
      if (failClosed) {
        log.error({ action, entityId, err: result.error?.message }, 'Fraud assessment unavailable — fail-closed: blocking');
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Risk assessment unavailable — action blocked for safety' });
      }
      log.warn({ action, entityId, err: result.error?.message }, 'Fraud assessment unavailable — fail-open: allowing');
      return;
    }
    assessment = result.data;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (failClosed) {
      log.error({ action, entityId, err: error instanceof Error ? error.message : String(error) }, 'Fraud service error — fail-closed: blocking');
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Risk assessment unavailable — action blocked for safety' });
    }
    log.warn({ action, entityId, err: error instanceof Error ? error.message : String(error) }, 'Fraud service error — fail-open: allowing');
    return;
  }

  const { riskLevel, recommendation, riskScore, flags } = assessment;

  if (riskLevel === 'HIGH' || riskLevel === 'CRITICAL' || recommendation === 'auto_reject' || recommendation === 'suspend') {
    log.warn({ action, entityId, riskLevel, riskScore, flags, recommendation }, 'Fraud guard BLOCKED — high risk');
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Action blocked due to risk assessment' });
  }

  if (blockOnMedium && riskLevel === 'MEDIUM') {
    log.warn({ action, entityId, riskLevel, riskScore, flags, recommendation }, 'Fraud guard BLOCKED — medium risk on money-movement action');
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Action blocked due to risk assessment — please contact support' });
  }

  if (riskLevel === 'MEDIUM') {
    log.warn({ action, entityId, riskLevel, riskScore, flags }, 'Fraud guard passed with MEDIUM risk — flagged for review');
  }
}
