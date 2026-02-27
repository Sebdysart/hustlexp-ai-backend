/**
 * Error Code Registry v1.0.0
 *
 * Single source of truth for all HustleXP error codes.
 * Replaces scattered string literals across services with centralized registry.
 *
 * Error code numbering:
 * - HX001-HX099: Authentication & Authorization
 * - HX100-HX199: User & Profile
 * - HX200-HX299: Tasks & Discovery
 * - HX300-HX399: Payments & Escrow
 * - HX400-HX499: Trust & Safety
 * - HX500-HX599: AI & Intelligence
 * - HX600-HX699: System & Infrastructure
 */

export interface ErrorCodeDefinition {
  code: string;
  message: string;
  httpStatus: number;
  userFacing: boolean; // Should this be shown directly to users?
  category: string;
}

export const ERROR_CODES: Record<string, ErrorCodeDefinition> = {
  // ═══════════════════════════════════════════════════════
  // Authentication & Authorization (HX001-HX099)
  // ═══════════════════════════════════════════════════════
  HX001: {
    code: 'HX001',
    message: 'State transition violation',
    httpStatus: 409,
    userFacing: true,
    category: 'state_violation',
  },
  HX002: {
    code: 'HX002',
    message: 'Token expired',
    httpStatus: 401,
    userFacing: true,
    category: 'auth',
  },
  HX003: {
    code: 'HX003',
    message: 'Insufficient permissions',
    httpStatus: 403,
    userFacing: true,
    category: 'auth',
  },
  HX004: {
    code: 'HX004',
    message: 'Account suspended',
    httpStatus: 403,
    userFacing: true,
    category: 'auth',
  },
  HX005: {
    code: 'HX005',
    message: 'Phone verification required',
    httpStatus: 403,
    userFacing: true,
    category: 'auth',
  },
  HX006: {
    code: 'HX006',
    message: 'ID verification required',
    httpStatus: 403,
    userFacing: true,
    category: 'auth',
  },

  // ═══════════════════════════════════════════════════════
  // User & Profile (HX100-HX199)
  // ═══════════════════════════════════════════════════════
  HX100: {
    code: 'HX100',
    message: 'User not found',
    httpStatus: 404,
    userFacing: true,
    category: 'user',
  },
  HX101: {
    code: 'HX101',
    message: 'Profile incomplete',
    httpStatus: 400,
    userFacing: true,
    category: 'user',
  },
  HX102: {
    code: 'HX102',
    message: 'Email already in use',
    httpStatus: 409,
    userFacing: true,
    category: 'user',
  },
  HX103: {
    code: 'HX103',
    message: 'Phone number already in use',
    httpStatus: 409,
    userFacing: true,
    category: 'user',
  },
  HX104: {
    code: 'HX104',
    message: 'Invalid profile data',
    httpStatus: 400,
    userFacing: true,
    category: 'user',
  },
  HX105: {
    code: 'HX105',
    message: 'Professional license verification failed',
    httpStatus: 400,
    userFacing: true,
    category: 'user',
  },
  HX106: {
    code: 'HX106',
    message: 'Background check required',
    httpStatus: 403,
    userFacing: true,
    category: 'user',
  },

  // ═══════════════════════════════════════════════════════
  // Tasks & Discovery (HX200-HX299)
  // ═══════════════════════════════════════════════════════
  HX200: {
    code: 'HX200',
    message: 'Task not found',
    httpStatus: 404,
    userFacing: true,
    category: 'task',
  },
  HX201: {
    code: 'HX201',
    message: 'Task already accepted by another user',
    httpStatus: 409,
    userFacing: true,
    category: 'task',
  },
  HX202: {
    code: 'HX202',
    message: 'Cannot accept own task',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },
  HX203: {
    code: 'HX203',
    message: 'Task not in correct state',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },
  HX204: {
    code: 'HX204',
    message: 'Task cancellation window expired',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },
  HX205: {
    code: 'HX205',
    message: 'Insufficient XP level for this task',
    httpStatus: 403,
    userFacing: true,
    category: 'task',
  },
  HX206: {
    code: 'HX206',
    message: 'Professional license required for this task',
    httpStatus: 403,
    userFacing: true,
    category: 'task',
  },
  HX207: {
    code: 'HX207',
    message: 'Task outside allowed radius',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },
  HX208: {
    code: 'HX208',
    message: 'Invalid proof submission',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },
  HX209: {
    code: 'HX209',
    message: 'Geofence validation failed - not at task location',
    httpStatus: 400,
    userFacing: true,
    category: 'task',
  },

  // ═══════════════════════════════════════════════════════
  // Payments & Escrow (HX300-HX399)
  // ═══════════════════════════════════════════════════════
  HX300: {
    code: 'HX300',
    message: 'Escrow not found',
    httpStatus: 404,
    userFacing: false,
    category: 'payment',
  },
  HX301: {
    code: 'HX301',
    message: 'Payment failed',
    httpStatus: 400,
    userFacing: true,
    category: 'payment',
  },
  HX302: {
    code: 'HX302',
    message: 'Insufficient funds',
    httpStatus: 400,
    userFacing: true,
    category: 'payment',
  },
  HX303: {
    code: 'HX303',
    message: 'Escrow already released',
    httpStatus: 409,
    userFacing: false,
    category: 'payment',
  },
  HX304: {
    code: 'HX304',
    message: 'Escrow release blocked - KYC verification required',
    httpStatus: 403,
    userFacing: true,
    category: 'payment',
  },
  HX305: {
    code: 'HX305',
    message: 'Stripe Connect account not verified',
    httpStatus: 403,
    userFacing: true,
    category: 'payment',
  },
  HX306: {
    code: 'HX306',
    message: 'Payment amount mismatch',
    httpStatus: 400,
    userFacing: false,
    category: 'payment',
  },
  HX307: {
    code: 'HX307',
    message: 'Payout failed',
    httpStatus: 500,
    userFacing: true,
    category: 'payment',
  },
  HX308: {
    code: 'HX308',
    message: 'Tax withholding calculation failed',
    httpStatus: 500,
    userFacing: false,
    category: 'payment',
  },
  HX309: {
    code: 'HX309',
    message: 'Invalid payment method',
    httpStatus: 400,
    userFacing: true,
    category: 'payment',
  },
  HX310: {
    code: 'HX310',
    message: 'Refund window expired',
    httpStatus: 400,
    userFacing: true,
    category: 'payment',
  },

  // ═══════════════════════════════════════════════════════
  // Trust & Safety (HX400-HX499)
  // ═══════════════════════════════════════════════════════
  HX400: {
    code: 'HX400',
    message: 'Trust score too low',
    httpStatus: 403,
    userFacing: true,
    category: 'trust',
  },
  HX401: {
    code: 'HX401',
    message: 'Flagged for review',
    httpStatus: 403,
    userFacing: true,
    category: 'trust',
  },
  HX402: {
    code: 'HX402',
    message: 'Fraudulent activity detected',
    httpStatus: 403,
    userFacing: false,
    category: 'trust',
  },
  HX403: {
    code: 'HX403',
    message: 'Rate limit exceeded',
    httpStatus: 429,
    userFacing: true,
    category: 'trust',
  },
  HX404: {
    code: 'HX404',
    message: 'Suspicious pattern detected',
    httpStatus: 403,
    userFacing: false,
    category: 'trust',
  },
  HX405: {
    code: 'HX405',
    message: 'Content moderation failed - inappropriate content',
    httpStatus: 400,
    userFacing: true,
    category: 'trust',
  },
  HX406: {
    code: 'HX406',
    message: 'Biometric verification failed',
    httpStatus: 403,
    userFacing: true,
    category: 'trust',
  },
  HX407: {
    code: 'HX407',
    message: 'Dispute under review',
    httpStatus: 409,
    userFacing: true,
    category: 'trust',
  },

  // ═══════════════════════════════════════════════════════
  // AI & Intelligence (HX500-HX599)
  // ═══════════════════════════════════════════════════════
  HX500: {
    code: 'HX500',
    message: 'AI service temporarily unavailable',
    httpStatus: 503,
    userFacing: true,
    category: 'ai',
  },
  HX501: {
    code: 'HX501',
    message: 'AI quota exceeded',
    httpStatus: 429,
    userFacing: false,
    category: 'ai',
  },
  HX502: {
    code: 'HX502',
    message: 'Invalid AI input',
    httpStatus: 400,
    userFacing: true,
    category: 'ai',
  },
  HX503: {
    code: 'HX503',
    message: 'AI task classification failed',
    httpStatus: 500,
    userFacing: false,
    category: 'ai',
  },
  HX504: {
    code: 'HX504',
    message: 'AI matchmaking unavailable',
    httpStatus: 503,
    userFacing: false,
    category: 'ai',
  },
  HX505: {
    code: 'HX505',
    message: 'Task batching optimization failed',
    httpStatus: 500,
    userFacing: false,
    category: 'ai',
  },

  // ═══════════════════════════════════════════════════════
  // System & Infrastructure (HX600-HX699)
  // ═══════════════════════════════════════════════════════
  HX600: {
    code: 'HX600',
    message: 'Internal server error',
    httpStatus: 500,
    userFacing: true,
    category: 'system',
  },
  HX601: {
    code: 'HX601',
    message: 'Database connection failed',
    httpStatus: 503,
    userFacing: false,
    category: 'system',
  },
  HX602: {
    code: 'HX602',
    message: 'Service degraded - circuit breaker open',
    httpStatus: 503,
    userFacing: false,
    category: 'system',
  },
  HX603: {
    code: 'HX603',
    message: 'Invalid request format',
    httpStatus: 400,
    userFacing: true,
    category: 'system',
  },
  HX604: {
    code: 'HX604',
    message: 'Feature flag disabled',
    httpStatus: 403,
    userFacing: false,
    category: 'system',
  },
  HX605: {
    code: 'HX605',
    message: 'File upload failed',
    httpStatus: 500,
    userFacing: true,
    category: 'system',
  },
  HX606: {
    code: 'HX606',
    message: 'WebSocket connection failed',
    httpStatus: 503,
    userFacing: false,
    category: 'system',
  },
  HX607: {
    code: 'HX607',
    message: 'Push notification delivery failed',
    httpStatus: 500,
    userFacing: false,
    category: 'system',
  },

  // ═══════════════════════════════════════════════════════
  // Compliance & Reporting (HX700-HX799)
  // ═══════════════════════════════════════════════════════
  HX700: {
    code: 'HX700',
    message: 'Compliance check failed',
    httpStatus: 400,
    userFacing: true,
    category: 'compliance',
  },
  HX701: {
    code: 'HX701',
    message: 'Tax reporting required',
    httpStatus: 400,
    userFacing: true,
    category: 'compliance',
  },
  HX702: {
    code: 'HX702',
    message: 'KYC verification required',
    httpStatus: 403,
    userFacing: true,
    category: 'compliance',
  },
  HX703: {
    code: 'HX703',
    message: 'AML check failed',
    httpStatus: 403,
    userFacing: false,
    category: 'compliance',
  },
  HX704: {
    code: 'HX704',
    message: 'Sanctions screening required',
    httpStatus: 403,
    userFacing: false,
    category: 'compliance',
  },

  // ═══════════════════════════════════════════════════════
  // Data & Privacy (HX800-HX899)
  // ═══════════════════════════════════════════════════════
  HX800: {
    code: 'HX800',
    message: 'Data privacy violation',
    httpStatus: 403,
    userFacing: true,
    category: 'privacy',
  },
  HX801: {
    code: 'HX801',
    message: 'GDPR deletion request failed',
    httpStatus: 500,
    userFacing: false,
    category: 'privacy',
  },
  HX802: {
    code: 'HX802',
    message: 'Data export failed',
    httpStatus: 500,
    userFacing: false,
    category: 'privacy',
  },

  // ═══════════════════════════════════════════════════════
  // Live Mode & Feature Flags (HX900-HX999)
  // ═══════════════════════════════════════════════════════
  HX900: {
    code: 'HX900',
    message: 'Feature not available',
    httpStatus: 403,
    userFacing: true,
    category: 'live_mode',
  },
  HX901: {
    code: 'HX901',
    message: 'Live mode not enabled',
    httpStatus: 403,
    userFacing: true,
    category: 'live_mode',
  },
  HX902: {
    code: 'HX902',
    message: 'Beta feature not accessible',
    httpStatus: 403,
    userFacing: true,
    category: 'live_mode',
  },
  HX903: {
    code: 'HX903',
    message: 'Feature flag disabled',
    httpStatus: 403,
    userFacing: true,
    category: 'live_mode',
  },
  HX904: {
    code: 'HX904',
    message: 'Regional restriction applies',
    httpStatus: 403,
    userFacing: true,
    category: 'live_mode',
  },
  HX905: {
    code: 'HX905',
    message: 'Maintenance mode active',
    httpStatus: 503,
    userFacing: true,
    category: 'live_mode',
  },
};

/**
 * Get error definition by code
 */
export function getErrorDefinition(code: string): ErrorCodeDefinition | undefined {
  return ERROR_CODES[code];
}

/**
 * Get all error codes for a category
 */
export function getErrorsByCategory(category: string): ErrorCodeDefinition[] {
  return Object.values(ERROR_CODES).filter(e => e.category === category);
}

/**
 * Validate error code format (HX + 3 digits)
 */
export function isValidErrorCode(code: string): boolean {
  return /^HX\d{3}$/.test(code);
}

/**
 * Get all categories
 */
export function getAllCategories(): string[] {
  return [...new Set(Object.values(ERROR_CODES).map(e => e.category))];
}

// ============================================================================
// Aliases for backward compatibility and test consumption
// ============================================================================

/** Alias for ErrorCodeDefinition (used by tests as ErrorCodeEntry) */
export type ErrorCodeEntry = ErrorCodeDefinition;

/**
 * Look up an error code entry by its HX code string.
 * Alias for getErrorDefinition.
 */
export function getErrorCode(code: string): ErrorCodeEntry | undefined {
  return ERROR_CODES[code];
}

/**
 * Return all error code entries as an array.
 */
export function getAllCodes(): ErrorCodeEntry[] {
  return Object.values(ERROR_CODES);
}
