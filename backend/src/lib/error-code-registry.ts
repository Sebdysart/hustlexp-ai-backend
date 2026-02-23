/**
 * Error Code Registry v1.0.0
 *
 * Single source of truth for ALL HustleXP error codes.
 * Backend services, database triggers, and iOS clients all reference
 * the same HX-series codes. This registry captures every known code
 * and its metadata so it can be exported as a manifest for cross-surface
 * validation.
 *
 * @see types.ts ErrorCodes
 * @see db.ts HX_ERROR_CODES
 */

// ============================================================================
// TYPES
// ============================================================================

export interface ErrorCodeEntry {
  code: string;        // e.g. "HX001"
  message: string;     // User-facing message
  httpStatus: number;  // 400, 403, 409, etc.
  category: string;    // 'state_violation', 'financial', 'auth', 'data_flow', 'live_mode', etc.
  userFacing: boolean; // Whether this should be shown to end users
}

// ============================================================================
// REGISTRY
// ============================================================================

export const ERROR_CODES: Record<string, ErrorCodeEntry> = {
  // --- Terminal state violations (HX0XX) -----------------------------------
  HX001: {
    code: 'HX001',
    message: 'Task terminal state violation',
    httpStatus: 409,
    category: 'state_violation',
    userFacing: true,
  },
  HX002: {
    code: 'HX002',
    message: 'Escrow terminal state violation',
    httpStatus: 409,
    category: 'state_violation',
    userFacing: true,
  },
  HX003: {
    code: 'HX003',
    message: 'Redis not configured for rate limiting',
    httpStatus: 500,
    category: 'infrastructure',
    userFacing: false,
  },
  HX004: {
    code: 'HX004',
    message: 'Escrow amount immutable after creation',
    httpStatus: 409,
    category: 'financial',
    userFacing: false,
  },

  // --- INV-1: XP requires RELEASED escrow (HX1XX) -------------------------
  HX101: {
    code: 'HX101',
    message: 'XP requires released escrow',
    httpStatus: 409,
    category: 'financial',
    userFacing: false,
  },
  HX102: {
    code: 'HX102',
    message: 'XP ledger entries cannot be deleted (append-only)',
    httpStatus: 409,
    category: 'financial',
    userFacing: false,
  },

  // --- INV-2: RELEASED requires COMPLETED task (HX2XX) --------------------
  HX201: {
    code: 'HX201',
    message: 'Released escrow requires completed task',
    httpStatus: 409,
    category: 'financial',
    userFacing: false,
  },

  // --- INV-3: COMPLETED requires ACCEPTED proof (HX3XX) -------------------
  HX301: {
    code: 'HX301',
    message: 'Completed task requires accepted proof',
    httpStatus: 409,
    category: 'financial',
    userFacing: false,
  },

  // --- Badge system (HX4XX) -----------------------------------------------
  HX401: {
    code: 'HX401',
    message: 'Badge entries cannot be deleted (append-only)',
    httpStatus: 409,
    category: 'data_flow',
    userFacing: false,
  },

  // --- Human Systems (HX6XX) ----------------------------------------------
  HX601: {
    code: 'HX601',
    message: 'Fatigue mandatory break bypass attempt',
    httpStatus: 403,
    category: 'human_systems',
    userFacing: true,
  },
  HX602: {
    code: 'HX602',
    message: 'Pause state violation',
    httpStatus: 409,
    category: 'human_systems',
    userFacing: true,
  },
  HX603: {
    code: 'HX603',
    message: 'Poster reputation access by poster',
    httpStatus: 403,
    category: 'human_systems',
    userFacing: false,
  },
  HX604: {
    code: 'HX604',
    message: 'Percentile public exposure blocked',
    httpStatus: 403,
    category: 'human_systems',
    userFacing: false,
  },

  // --- AI Budget (HX7XX) --------------------------------------------------
  HX701: {
    code: 'HX701',
    message: 'AI daily budget exceeded for agent',
    httpStatus: 429,
    category: 'rate_limit',
    userFacing: true,
  },
  HX702: {
    code: 'HX702',
    message: 'All AI providers exhausted for agent',
    httpStatus: 500,
    category: 'infrastructure',
    userFacing: false,
  },
  HX703: {
    code: 'HX703',
    message: 'Platform AI daily budget exceeded',
    httpStatus: 429,
    category: 'rate_limit',
    userFacing: true,
  },
  HX704: {
    code: 'HX704',
    message: 'Personal AI daily budget exceeded',
    httpStatus: 429,
    category: 'rate_limit',
    userFacing: true,
  },

  // --- Admin actions (HX8XX) ----------------------------------------------
  HX801: {
    code: 'HX801',
    message: 'Admin action audit entries cannot be deleted',
    httpStatus: 409,
    category: 'data_flow',
    userFacing: false,
  },

  // --- Live Mode (HX9XX) --------------------------------------------------
  HX901: {
    code: 'HX901',
    message: 'Live broadcast requires funded escrow',
    httpStatus: 409,
    category: 'live_mode',
    userFacing: true,
  },
  HX902: {
    code: 'HX902',
    message: 'Live task below price floor ($15.00 minimum)',
    httpStatus: 409,
    category: 'live_mode',
    userFacing: true,
  },
  HX903: {
    code: 'HX903',
    message: 'Hustler not in ACTIVE live mode state',
    httpStatus: 409,
    category: 'live_mode',
    userFacing: true,
  },
  HX904: {
    code: 'HX904',
    message: 'Live Mode toggle cooldown active',
    httpStatus: 429,
    category: 'live_mode',
    userFacing: true,
  },
  HX905: {
    code: 'HX905',
    message: 'Live Mode banned',
    httpStatus: 403,
    category: 'live_mode',
    userFacing: true,
  },
};

// ============================================================================
// ACCESSORS
// ============================================================================

export function getErrorCode(code: string): ErrorCodeEntry | undefined {
  return ERROR_CODES[code];
}

export function getAllCodes(): ErrorCodeEntry[] {
  return Object.values(ERROR_CODES);
}
