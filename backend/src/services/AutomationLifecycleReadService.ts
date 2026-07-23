import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';

const log = logger.child({ module: 'automation', service: 'AutomationLifecycleReadService' });

export type RefundState = 'NOT_REQUIRED' | 'PENDING' | 'REFUNDED' | 'BLOCKED';

export interface LifecycleCursor {
  createdAt: string;
  id: string;
}

export interface RawLifecycleRow {
  id: string;
  task_state: string;
  progress_state: string;
  worker_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  dispatch_expires_at: Date | string | null;
  expiration_reason: string | null;
  refund_state: RefundState | null;
  refund_blocker: string | null;
  started_at: Date | string | null;
  completion_message_delivered_at: Date | string | null;
  completion_confirmed_at: Date | string | null;
  payout_ready_at: Date | string | null;
  payout_ready_reason: string | null;
  escrow_state: string | null;
  stripe_payment_intent_id: string | null;
  stripe_refund_id: string | null;
  reservation_state: string | null;
  reserved_hustler_ref: string | null;
  proof_state: string | null;
  automation_classification?: string | null;
}

export interface EngineLifecycleItem {
  engineTaskId: string;
  lifecycleState: string;
  taskState: string;
  progressState: string;
  escrowState: string | null;
  paymentState: string;
  reservationState: string;
  hustlerRef: string | null;
  proofState: string | null;
  completionState: string;
  completionMessageDeliveredAt: string | null;
  payoutState: string;
  refundState: RefundState;
  dispatchExpiresAt: string | null;
  blockerCode: string | null;
  nextAutomaticAction: string | null;
  createdAt: string;
  updatedAt: string;
  automationClassification: string;
}

export interface ListLifecycleResult {
  tasks: EngineLifecycleItem[];
  nextCursor: string | null;
}

function iso(value: Date | string | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

export function encodeLifecycleCursor(cursor: LifecycleCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeLifecycleCursor(value: string): LifecycleCursor {
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<LifecycleCursor>;
  const validDate = typeof decoded.createdAt === 'string' && !Number.isNaN(Date.parse(decoded.createdAt));
  const validId = typeof decoded.id === 'string' && /^[0-9a-f-]{36}$/i.test(decoded.id);
  if (!validDate || !validId) throw new Error('INVALID_CURSOR');
  return { createdAt: decoded.createdAt!, id: decoded.id! };
}

function refundStateFor(row: RawLifecycleRow): RefundState {
  if (row.escrow_state === 'REFUNDED' || row.stripe_refund_id) return 'REFUNDED';
  return row.refund_state ?? 'NOT_REQUIRED';
}

const LIFECYCLE_RULES: ReadonlyArray<{
  state: string;
  applies: (row: RawLifecycleRow) => boolean;
}> = [
  { state: 'EXPIRED_UNFILLED', applies: (row) => row.task_state === 'EXPIRED' && row.expiration_reason === 'UNFILLED' },
  { state: 'PAYOUT_READY', applies: (row) => Boolean(row.payout_ready_at) },
  { state: 'COMPLETED', applies: (row) => row.task_state === 'COMPLETED' },
  { state: 'PROOF_SUBMITTED', applies: (row) => row.task_state === 'PROOF_SUBMITTED' },
  { state: 'IN_PROGRESS', applies: (row) => Boolean(row.started_at) || row.progress_state === 'WORKING' },
  { state: 'ENGINE_RESERVED', applies: (row) => row.task_state === 'ACCEPTED' && row.reservation_state === 'ACTIVE' },
  { state: 'DISPATCH_READY', applies: (row) => row.escrow_state === 'FUNDED' && ['OPEN', 'MATCHING'].includes(row.task_state) },
  { state: 'PAYMENT_PENDING', applies: (row) => row.escrow_state === 'PENDING' },
];

function lifecycleStateFor(row: RawLifecycleRow): string {
  return LIFECYCLE_RULES.find((rule) => rule.applies(row))?.state ?? row.task_state;
}

interface BlockerContext {
  row: RawLifecycleRow;
  lifecycleState: string;
  now: Date;
}

const BLOCKER_RULES: ReadonlyArray<{
  code: string | ((context: BlockerContext) => string | null);
  applies: (context: BlockerContext) => boolean;
}> = [
  { code: ({ row }) => row.refund_blocker, applies: ({ row }) => Boolean(row.refund_blocker) },
  { code: 'PAYOUT_READY_EVIDENCE_MISSING', applies: ({ row, lifecycleState }) => lifecycleState === 'COMPLETED' && !row.payout_ready_at },
  { code: 'PROOF_NOT_ACCEPTED', applies: ({ row, lifecycleState }) => lifecycleState === 'PROOF_SUBMITTED' && row.proof_state !== 'ACCEPTED' },
  { code: 'RESERVATION_EVIDENCE_MISSING', applies: ({ row }) => row.task_state === 'ACCEPTED' && row.reservation_state !== 'ACTIVE' },
  {
    code: 'DISPATCH_EXPIRY_DUE',
    applies: ({ row, now }) => ['OPEN', 'MATCHING'].includes(row.task_state)
      && Boolean(row.dispatch_expires_at)
      && new Date(row.dispatch_expires_at!).getTime() <= now.getTime(),
  },
  { code: 'PAYMENT_NOT_FUNDED', applies: ({ row }) => ['OPEN', 'MATCHING'].includes(row.task_state) && row.escrow_state !== 'FUNDED' },
];

function blockerFor(row: RawLifecycleRow, lifecycleState: string, now: Date): string | null {
  const context = { row, lifecycleState, now };
  const code = BLOCKER_RULES.find((rule) => rule.applies(context))?.code;
  return typeof code === 'function' ? code(context) : code ?? null;
}

function nextActionFor(state: string, refundState: RefundState, blocker: string | null): string | null {
  if (state === 'EXPIRED_UNFILLED' && refundState === 'PENDING') return 'PROCESS_REFUND';
  if (state === 'EXPIRED_UNFILLED' && refundState === 'BLOCKED') return 'RESOLVE_REFUND_BLOCKER';
  if (blocker === 'DISPATCH_EXPIRY_DUE') return 'EXPIRE_UNFILLED';
  const actions: Record<string, string> = {
    PAYOUT_READY: 'AWAIT_PAYOUT_RELEASE',
    COMPLETED: 'RECONCILE_PAYOUT_READY',
    PROOF_SUBMITTED: 'AWAIT_COMPLETION_CONFIRMATION',
    IN_PROGRESS: 'AWAIT_PROOF',
    ENGINE_RESERVED: 'AWAIT_START',
    DISPATCH_READY: 'START_HARD_DISPATCH',
    PAYMENT_PENDING: 'AWAIT_PAYMENT',
  };
  return actions[state] ?? null;
}

function completionStateFor(row: RawLifecycleRow): string {
  if (row.task_state !== 'COMPLETED') return 'NOT_COMPLETED';
  return row.completion_confirmed_at ? 'CONFIRMED' : 'COMPLETED_UNCONFIRMED';
}

function payoutStateFor(row: RawLifecycleRow): string {
  if (row.escrow_state === 'RELEASED') return 'RELEASED';
  return row.payout_ready_at ? 'READY' : 'NOT_READY';
}

export function mapLifecycleRow(row: RawLifecycleRow, now = new Date()): EngineLifecycleItem {
  const refundState = refundStateFor(row);
  const lifecycleState = lifecycleStateFor(row);
  const blockerCode = blockerFor(row, lifecycleState, now);
  return {
    engineTaskId: row.id,
    lifecycleState,
    taskState: row.task_state,
    progressState: row.progress_state,
    escrowState: row.escrow_state,
    paymentState: row.escrow_state ?? 'NOT_CREATED',
    reservationState: row.reservation_state ?? 'NOT_RESERVED',
    hustlerRef: row.reserved_hustler_ref ?? row.worker_id,
    proofState: row.proof_state,
    completionState: completionStateFor(row),
    completionMessageDeliveredAt: iso(row.completion_message_delivered_at),
    payoutState: payoutStateFor(row),
    refundState,
    dispatchExpiresAt: iso(row.dispatch_expires_at),
    blockerCode,
    nextAutomaticAction: nextActionFor(lifecycleState, refundState, blockerCode),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    automationClassification: row.automation_classification ?? 'UNCLASSIFIED',
  };
}

const LIFECYCLE_QUERY = `SELECT t.id,
        t.state AS task_state, t.progress_state, t.worker_id, t.created_at, t.updated_at,
        t.dispatch_expires_at, t.expiration_reason, t.refund_state, t.refund_blocker,
        t.started_at, t.completion_message_delivered_at, t.completion_confirmed_at,
        t.payout_ready_at, t.payout_ready_reason, t.automation_classification,
        e.state AS escrow_state, e.stripe_payment_intent_id, e.stripe_refund_id,
        r.status AS reservation_state, r.hustler_id AS reserved_hustler_ref,
        p.state AS proof_state
 FROM tasks t
 LEFT JOIN LATERAL (
   SELECT state, stripe_payment_intent_id, stripe_refund_id
   FROM escrows WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
 ) e ON TRUE
 LEFT JOIN task_reservations r ON r.task_id = t.id AND r.status = 'ACTIVE'
 LEFT JOIN LATERAL (
   SELECT state FROM proofs WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
 ) p ON TRUE
 WHERE ($1::timestamptz IS NULL OR (t.created_at, t.id) < ($1::timestamptz, $2::uuid))
 ORDER BY t.created_at DESC, t.id DESC
 LIMIT $3`;

function failure(code: string, message: string): ServiceResult<ListLifecycleResult> {
  return { success: false, error: { code, message } };
}

export const AutomationLifecycleReadService = {
  listTasks: async (params: { limit: number; cursor?: string | null }): Promise<ServiceResult<ListLifecycleResult>> => {
    let cursor: LifecycleCursor | null;
    try {
      cursor = params.cursor ? decodeLifecycleCursor(params.cursor) : null;
    } catch {
      return failure('INVALID_CURSOR', 'Pagination cursor is invalid.');
    }
    const limit = Math.max(1, Math.min(params.limit, 100));
    try {
      const result = await db.query<RawLifecycleRow>(LIFECYCLE_QUERY, [
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ]);
      const page = result.rows.slice(0, limit);
      const last = page.at(-1);
      const nextCursor = result.rows.length > limit && last
        ? encodeLifecycleCursor({ createdAt: iso(last.created_at)!, id: last.id })
        : null;
      return { success: true, data: { tasks: page.map((row) => mapLifecycleRow(row)), nextCursor } };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Lifecycle read failed');
      return failure('DB_ERROR', 'Could not read engine lifecycle state.');
    }
  },
};

export default AutomationLifecycleReadService;
