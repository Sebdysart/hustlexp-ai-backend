import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';

export type ReconciledActionClass = 'PROOF_COMPLETION' | 'SAFETY' | 'EXECUTION';
export type ReconciledSyncState =
  | 'LOCAL_PENDING'
  | 'SERVER_CONFIRMED'
  | 'SERVER_REJECTED'
  | 'CONFLICT';

export interface OfflineActionProbe {
  actionClass: ReconciledActionClass;
  clientIdentity: string;
  clientSequence: number;
  priorServerVersion: number;
  localOccurredAt: string;
  payloadHash: string;
}

export interface ReconciledOfflineAction {
  actionClass: ReconciledActionClass;
  clientIdentity: string;
  clientSequence: number;
  syncState: ReconciledSyncState;
  confirmationAuthority: 'HUSTLEXP_ENGINE';
  confirmedAt: string | null;
  reasonCode: string;
  recoveryAction: 'NONE' | 'RETRY_UNCHANGED' | 'REFRESH_AND_REVIEW' | 'START_NEW_ACTION';
  evidenceMatch: 'EXACT' | 'LEGACY_IDENTITY_ONLY' | 'NOT_FOUND' | 'CONFLICT';
}

interface TaskSyncRow {
  id: string;
  poster_id: string;
  worker_id: string | null;
  state: string;
  progress_state: string | null;
  version: number | string;
}

interface StoredActionRow {
  client_identity: string;
  client_sequence: number | string;
  prior_task_version: number | string;
  offline_payload_hash: string | null;
  reconciliation_contract_version: number | string;
  local_occurred_at: Date | string;
  created_at: Date | string;
}

interface LatestSequenceRow {
  client_sequence: number | string | null;
}

const PROOF_ACCEPTING_STATES = new Set(['ACCEPTED']);
const EXECUTION_ACCEPTING_STATES = new Set(['ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED']);

function lifecycleOwner(task: TaskSyncRow): 'POSTER' | 'HUSTLER' | 'HUSTLEXP_ENGINE' {
  if (['OPEN', 'MATCHING', 'PENDING_PAYMENT'].includes(task.state)) return 'POSTER';
  if (['ACCEPTED', 'PROOF_SUBMITTED'].includes(task.state)) return 'HUSTLER';
  return 'HUSTLEXP_ENGINE';
}

function lifecycleNextAction(task: TaskSyncRow): string {
  if (task.state === 'ACCEPTED' && task.progress_state === 'TRAVELING') return 'Hustler confirms arrival and starts work.';
  if (task.state === 'ACCEPTED' && task.progress_state === 'IN_PROGRESS') return 'Hustler completes the approved scope and submits proof.';
  if (task.state === 'ACCEPTED') return 'Hustler confirms travel or starts the approved work.';
  if (task.state === 'PROOF_SUBMITTED') return 'Poster reviews the server-confirmed completion proof.';
  if (task.state === 'DISPUTED') return 'HustleXP resolves the held dispute before settlement.';
  if (['COMPLETED', 'CANCELLED', 'REFUNDED'].includes(task.state)) return 'No lifecycle action is pending.';
  return 'Reload the task for the current server-owned next action.';
}

function actionTable(actionClass: ReconciledActionClass): {
  table: string;
  actorColumn: string;
  identityColumn: string;
  syncPredicate: string;
} {
  if (actionClass === 'PROOF_COMPLETION') return {
    table: 'proofs', actorColumn: 'submitter_id', identityColumn: 'client_submission_id',
    syncPredicate: 'sync_contract_version=1',
  };
  if (actionClass === 'SAFETY') return {
    table: 'task_safety_incidents', actorColumn: 'reporter_user_id', identityColumn: 'idempotency_key',
    syncPredicate: 'sync_contract_version=1',
  };
  return {
    table: 'task_geofence_events', actorColumn: 'user_id', identityColumn: 'client_event_id',
    syncPredicate: 'TRUE',
  };
}

async function storedAction(
  query: QueryFn,
  taskId: string,
  userId: string,
  probe: OfflineActionProbe,
): Promise<StoredActionRow | null> {
  const source = actionTable(probe.actionClass);
  const result = await query<StoredActionRow>(
    `SELECT ${source.identityColumn}::text AS client_identity,client_sequence,prior_task_version,
            offline_payload_hash,reconciliation_contract_version,local_occurred_at,created_at
       FROM ${source.table}
      WHERE task_id=$1 AND ${source.actorColumn}=$2 AND ${source.identityColumn}::text=$3
        AND ${source.syncPredicate}
      LIMIT 1`,
    [taskId,userId,probe.clientIdentity],
  );
  return result.rows[0] ?? null;
}

async function latestSequence(
  query: QueryFn,
  taskId: string,
  userId: string,
  actionClass: ReconciledActionClass,
): Promise<number> {
  const source = actionTable(actionClass);
  const result = await query<LatestSequenceRow>(
    `SELECT MAX(client_sequence) AS client_sequence
       FROM ${source.table}
      WHERE task_id=$1 AND ${source.actorColumn}=$2 AND ${source.syncPredicate}`,
    [taskId,userId],
  );
  return Number(result.rows[0]?.client_sequence ?? 0);
}

function conflict(probe: OfflineActionProbe, reasonCode: string): ReconciledOfflineAction {
  return {
    actionClass: probe.actionClass,
    clientIdentity: probe.clientIdentity,
    clientSequence: probe.clientSequence,
    syncState: 'CONFLICT',
    confirmationAuthority: 'HUSTLEXP_ENGINE',
    confirmedAt: null,
    reasonCode,
    recoveryAction: 'REFRESH_AND_REVIEW',
    evidenceMatch: 'CONFLICT',
  };
}

function lifecycleRejects(task: TaskSyncRow, actionClass: ReconciledActionClass): boolean {
  if (actionClass === 'PROOF_COMPLETION') return !PROOF_ACCEPTING_STATES.has(task.state);
  if (actionClass === 'EXECUTION') return !EXECUTION_ACCEPTING_STATES.has(task.state);
  return false;
}

async function reconcileProbe(
  query: QueryFn,
  task: TaskSyncRow,
  userId: string,
  probe: OfflineActionProbe,
): Promise<ReconciledOfflineAction> {
  const stored = await storedAction(query,task.id,userId,probe);
  if (stored) {
    const identityMatches = Number(stored.client_sequence) === probe.clientSequence
      && Number(stored.prior_task_version) === probe.priorServerVersion
      && new Date(stored.local_occurred_at).toISOString() === new Date(probe.localOccurredAt).toISOString();
    const hashComparable = Number(stored.reconciliation_contract_version) === 1;
    const hashMatches = !hashComparable || stored.offline_payload_hash === probe.payloadHash;
    if (!identityMatches || !hashMatches) return conflict(probe,'SERVER_EVIDENCE_MISMATCH');
    return {
      actionClass: probe.actionClass,
      clientIdentity: probe.clientIdentity,
      clientSequence: probe.clientSequence,
      syncState: 'SERVER_CONFIRMED',
      confirmationAuthority: 'HUSTLEXP_ENGINE',
      confirmedAt: new Date(stored.created_at).toISOString(),
      reasonCode: hashComparable ? 'EXACT_SERVER_EVIDENCE_MATCH' : 'LEGACY_SERVER_IDENTITY_MATCH',
      recoveryAction: 'NONE',
      evidenceMatch: hashComparable ? 'EXACT' : 'LEGACY_IDENTITY_ONLY',
    };
  }

  const latest = await latestSequence(query,task.id,userId,probe.actionClass);
  if (probe.clientSequence <= latest) return conflict(probe,'STALE_CLIENT_SEQUENCE');
  if (probe.priorServerVersion !== Number(task.version)) return conflict(probe,'STALE_TASK_VERSION');
  if (lifecycleRejects(task,probe.actionClass)) {
    return {
      actionClass: probe.actionClass,
      clientIdentity: probe.clientIdentity,
      clientSequence: probe.clientSequence,
      syncState: 'SERVER_REJECTED',
      confirmationAuthority: 'HUSTLEXP_ENGINE',
      confirmedAt: null,
      reasonCode: 'LIFECYCLE_NO_LONGER_ACCEPTS_ACTION',
      recoveryAction: 'START_NEW_ACTION',
      evidenceMatch: 'NOT_FOUND',
    };
  }
  return {
    actionClass: probe.actionClass,
    clientIdentity: probe.clientIdentity,
    clientSequence: probe.clientSequence,
    syncState: 'LOCAL_PENDING',
    confirmationAuthority: 'HUSTLEXP_ENGINE',
    confirmedAt: null,
    reasonCode: 'NO_SERVER_RECORD',
    recoveryAction: 'RETRY_UNCHANGED',
    evidenceMatch: 'NOT_FOUND',
  };
}

export async function reconcileOfflineActions(
  input: { taskId: string; actions: OfflineActionProbe[] },
  userId: string,
  query: QueryFn = (sql, params) => db.query(sql, params),
) {
  const taskResult = await query<TaskSyncRow>(
    `SELECT id,poster_id,worker_id,state,progress_state,version
       FROM tasks WHERE id=$1`,
    [input.taskId],
  );
  const task = taskResult.rows[0];
  if (!task || (task.poster_id !== userId && task.worker_id !== userId)) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
  }
  const actions: ReconciledOfflineAction[] = [];
  for (const probe of input.actions) actions.push(await reconcileProbe(query,task,userId,probe));
  return {
    taskId: task.id,
    lifecycleState: task.state,
    progressState: task.progress_state,
    serverVersion: Number(task.version),
    lifecycleOwner: lifecycleOwner(task),
    nextAction: lifecycleNextAction(task),
    confirmationAuthority: 'HUSTLEXP_ENGINE' as const,
    reconciledAt: new Date().toISOString(),
    actions,
  };
}
