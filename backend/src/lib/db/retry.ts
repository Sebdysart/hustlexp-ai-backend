import { logger } from '../../logger';

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  shouldRetry?: (error: unknown) => boolean;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 100,
  maxDelay: 5000,
};

const FATAL_PRISMA_CODES = new Set([
  'P1000',
  'P1001',
  'P1008',
  'P1017',
  'P2000', 'P2001', 'P2002', 'P2003', 'P2004', 'P2005', 'P2006', 'P2007', 'P2008', 'P2009',
  'P2010', 'P2011', 'P2012', 'P2013', 'P2014', 'P2015', 'P2016', 'P2017', 'P2018', 'P2019',
  'P2020', 'P2021', 'P2022', 'P2023', 'P2024', 'P2025', 'P2026', 'P2027', 'P2028', 'P2029',
  'P2030', 'P2031', 'P2032', 'P2033', 'P2034',
  'P3000', 'P3001', 'P3002', 'P3003', 'P3004', 'P3005', 'P3006',
  'P4000', 'P4001', 'P4002',
  'P5000', 'P5001', 'P5002', 'P5003', 'P5004', 'P5005', 'P5006', 'P5007', 'P5008', 'P5009',
  'P5010', 'P5011', 'P5012', 'P5013', 'P5014', 'P5015',
]);

function isFatalPrismaError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') {
      return FATAL_PRISMA_CODES.has(code);
    }
  }
  return false;
}

function calculateDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exponentialDelay = baseDelay * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelay);
  const jitter = 1 + Math.random() * 0.3;
  return Math.round(cappedDelay * jitter);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: Partial<RetryOptions>
): Promise<T> {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const { maxRetries, baseDelay, maxDelay, shouldRetry } = config;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxRetries) {
        break;
      }

      if (isFatalPrismaError(error)) {
        logger.error({ error, code: (error as { code: string }).code }, 'Fatal Prisma error, not retrying');
        throw error;
      }

      if (shouldRetry && !shouldRetry(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelay, maxDelay);
      logger.warn(
        { attempt: attempt + 1, maxRetries, delay, error: (error as Error).message },
        'Retrying database operation'
      );

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  logger.error(
    { attempts: maxRetries + 1, error: (lastError as Error).message },
    'Database operation failed after all retries'
  );
  throw lastError;
}
