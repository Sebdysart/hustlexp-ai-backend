import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { db, type QueryFn } from '../db.js';
import {
  hasFreshOperatorStepUp,
  type IdentityAssurance,
} from '../auth/operator-identity-assurance.js';
import type { Context } from '../trpc-context.js';

export const operatorRoles = [
  'operator_viewer',
  'operator_responder',
  'operator_admin',
] as const;
export type OperatorRole = (typeof operatorRoles)[number];

export const boundedOperatorOperations = [
  'EXPIRE_ACTION_LINK',
  'DISABLE_FEATURE_FLAG',
] as const;
export type BoundedOperatorOperation = (typeof boundedOperatorOperations)[number];

interface AdminRoleRow {
  role: string;
  can_manage_operations: boolean;
}

interface OperatorIdentity {
  userId: string;
  firebaseUid: string;
  identityAssurance?: IdentityAssurance;
}

export interface OperatorSession {
  subject: string;
  displayName: string;
  roles: OperatorRole[];
  expiresAt: string;
  stepUpVerified: boolean;
}

export interface RequestOperatorCommandInput {
  operationType: BoundedOperatorOperation;
  targetId: string;
  targetExpectedVersion: number;
  reason: string;
  idempotencyKey: string;
}

export interface ApproveOperatorCommandInput {
  commandId: string;
  expectedCommandVersion: number;
  reason: string;
  idempotencyKey: string;
}

export type RejectOperatorCommandInput = ApproveOperatorCommandInput;

interface CommandRow {
  id: string;
  operation_type: BoundedOperatorOperation;
  authority_scope: 'ACTION_LINK_STATUS' | 'FEATURE_FLAGS';
  target_kind: 'ACTION_LINK' | 'FEATURE_FLAG';
  target_id: string;
  target_expected_version: number | string;
  command_payload: Record<string, unknown>;
  status: 'PENDING' | 'EXECUTED' | 'REJECTED';
  requested_by: string;
  approved_by: string | null;
  decision_idempotency_key: string | null;
  request_hash: string;
  execution_result: Record<string, unknown> | null;
  version: number | string;
}

const PRIVILEGED_ROLES = new Set(['admin', 'founder']);
const ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FEATURE_FLAG_RE = /^[a-z][a-z0-9_]{1,99}$/;

function fail(code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED', message: string): never {
  throw new TRPCError({ code, message });
}

export function requireFreshOperatorIdentity(context: Context): OperatorIdentity {
  if (!context.user || !context.firebaseUid) {
    return fail('UNAUTHORIZED', 'A named operator identity is required.');
  }
  if (context.user.is_banned
    || context.user.account_status === 'SUSPENDED'
    || context.user.account_status === 'DELETED') {
    return fail('UNAUTHORIZED', 'Operator identity is inactive.');
  }
  if (!hasFreshOperatorStepUp(context.identityAssurance)) {
    return fail('PRECONDITION_FAILED', 'Fresh multi-factor step-up is required.');
  }
  return {
    userId: context.user.id,
    firebaseUid: context.firebaseUid,
    identityAssurance: context.identityAssurance,
  };
}

async function currentAdminRole(query: QueryFn, userId: string): Promise<AdminRoleRow> {
  const result = await query<AdminRoleRow>(
    `SELECT role, COALESCE(can_manage_operations, false) AS can_manage_operations
       FROM admin_roles
      WHERE user_id = $1 AND role = ANY($2::text[])
      LIMIT 1`,
    [userId, [...ADMIN_ROLES]],
  );
  const row = result.rows[0];
  if (!row || (!PRIVILEGED_ROLES.has(row.role) && row.can_manage_operations !== true)) {
    return fail('FORBIDDEN', 'Current Operations capability is required.');
  }
  return row;
}

function rolesFor(row: AdminRoleRow): OperatorRole[] {
  if (PRIVILEGED_ROLES.has(row.role)) {
    return ['operator_viewer', 'operator_responder', 'operator_admin'];
  }
  return ['operator_viewer', 'operator_responder'];
}

export async function getOperatorSession(context: Context): Promise<OperatorSession> {
  const identity = requireFreshOperatorIdentity(context);
  const role = await currentAdminRole(db.query, identity.userId);
  const expiresAtSeconds = identity.identityAssurance?.tokenExpiresAtSeconds;
  if (!expiresAtSeconds) {
    return fail('PRECONDITION_FAILED', 'Verified operator token expiry is unavailable.');
  }
  const displayName = context.user?.full_name?.trim()
    || context.user?.email?.trim()
    || 'HustleXP operator';
  return {
    subject: identity.firebaseUid,
    displayName,
    roles: rolesFor(role),
    expiresAt: new Date(expiresAtSeconds * 1000).toISOString(),
    stepUpVerified: true,
  };
}

function commandContract(input: RequestOperatorCommandInput) {
  if (!Number.isSafeInteger(input.targetExpectedVersion) || input.targetExpectedVersion < 1) {
    return fail('BAD_REQUEST', 'Target expected version must be a positive integer.');
  }
  if (input.operationType === 'EXPIRE_ACTION_LINK') {
    if (!UUID_RE.test(input.targetId)) return fail('BAD_REQUEST', 'Action-link target must be a UUID.');
    return {
      authorityScope: 'ACTION_LINK_STATUS' as const,
      targetKind: 'ACTION_LINK' as const,
      payload: { status: 'expired' },
    };
  }
  if (!FEATURE_FLAG_RE.test(input.targetId)) {
    return fail('BAD_REQUEST', 'Feature-flag target is malformed.');
  }
  return {
    authorityScope: 'FEATURE_FLAGS' as const,
    targetKind: 'FEATURE_FLAG' as const,
    payload: { enabled: false },
  };
}

function hashRequest(input: RequestOperatorCommandInput): string {
  return createHash('sha256').update(JSON.stringify({
    operationType: input.operationType,
    targetId: input.targetId,
    targetExpectedVersion: input.targetExpectedVersion,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
  })).digest('hex');
}

function integerVersion(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('CONFLICT', `${label} returned an invalid version.`);
  }
  return parsed;
}

async function targetVersion(
  query: QueryFn,
  operation: BoundedOperatorOperation,
  targetId: string,
  lock: boolean,
): Promise<number> {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const result = operation === 'EXPIRE_ACTION_LINK'
    ? await query<{ version: number | string }>(
        `SELECT version FROM action_links WHERE id = $1${lockClause}`,
        [targetId],
      )
    : await query<{ version: number | string }>(
        `SELECT version FROM feature_flags WHERE name = $1${lockClause}`,
        [targetId],
      );
  const row = result.rows[0];
  if (!row) return fail('NOT_FOUND', 'Operator command target was not found.');
  return integerVersion(row.version, 'Operator command target');
}

function requireExpectedVersion(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    fail('CONFLICT', `${label} changed; refresh and submit its exact current version.`);
  }
}

export async function requestOperatorCommand(
  context: Context,
  input: RequestOperatorCommandInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  const contract = commandContract(input);
  const requestHash = hashRequest(input);

  return db.transaction(async (query) => {
    await currentAdminRole(query, identity.userId);
    const replay = await query<CommandRow>(
      `SELECT id, operation_type, authority_scope, target_kind, target_id,
              target_expected_version, command_payload, status, requested_by,
              approved_by, decision_idempotency_key, request_hash,
              execution_result, version
         FROM operator_command_requests
        WHERE requested_by = $1 AND idempotency_key = $2`,
      [identity.userId, input.idempotencyKey],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].request_hash !== requestHash) {
        return fail('CONFLICT', 'Idempotency key was reused for a different operator command.');
      }
      return {
        commandId: replay.rows[0].id,
        status: replay.rows[0].status,
        version: integerVersion(replay.rows[0].version, 'Operator command'),
        idempotencyReplayed: true,
      };
    }

    const actualVersion = await targetVersion(query, input.operationType, input.targetId, true);
    requireExpectedVersion(actualVersion, input.targetExpectedVersion, 'Operator command target');

    const inserted = await query<{ id: string; status: 'PENDING'; version: number | string }>(
      `INSERT INTO operator_command_requests (
         operation_type, authority_scope, target_kind, target_id,
         target_expected_version, command_payload, reason, requested_by,
         idempotency_key, request_hash
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
       RETURNING id, status, version`,
      [
        input.operationType,
        contract.authorityScope,
        contract.targetKind,
        input.targetId,
        input.targetExpectedVersion,
        JSON.stringify(contract.payload),
        input.reason,
        identity.userId,
        input.idempotencyKey,
        requestHash,
      ],
    );
    const command = inserted.rows[0];
    await query(
      `INSERT INTO operator_command_audit (
         command_id, command_version, event_type, actor_id,
         authority_scope, event_details
       ) VALUES ($1, $2, 'REQUESTED', $3, $4, $5::jsonb)`,
      [
        command.id,
        command.version,
        identity.userId,
        contract.authorityScope,
        JSON.stringify({
          operationType: input.operationType,
          targetId: input.targetId,
          targetExpectedVersion: input.targetExpectedVersion,
          requestHash,
        }),
      ],
    );
    return {
      commandId: command.id,
      status: command.status,
      version: integerVersion(command.version, 'Operator command'),
      idempotencyReplayed: false,
    };
  });
}

async function executeBoundedCommand(query: QueryFn, command: CommandRow) {
  const expectedTargetVersion = integerVersion(
    command.target_expected_version,
    'Operator command target',
  );
  const actualVersion = await targetVersion(
    query,
    command.operation_type,
    command.target_id,
    true,
  );
  requireExpectedVersion(actualVersion, expectedTargetVersion, 'Operator command target');

  if (command.operation_type === 'EXPIRE_ACTION_LINK') {
    const result = await query<{ id: string; status: string; version: number | string }>(
      `UPDATE action_links
          SET status = 'expired', updated_at = clock_timestamp()
        WHERE id = $1 AND version = $2
        RETURNING id, status, version`,
      [command.target_id, expectedTargetVersion],
    );
    if (!result.rows[0]) return fail('CONFLICT', 'Action link changed during command execution.');
    return {
      targetId: result.rows[0].id,
      status: result.rows[0].status,
      version: integerVersion(result.rows[0].version, 'Action link'),
    };
  }

  const result = await query<{ name: string; enabled: boolean; version: number | string }>(
    `UPDATE feature_flags
        SET enabled = false, updated_at = clock_timestamp()
      WHERE name = $1 AND version = $2
      RETURNING name, enabled, version`,
    [command.target_id, expectedTargetVersion],
  );
  if (!result.rows[0]) return fail('CONFLICT', 'Feature flag changed during command execution.');
  return {
    targetId: result.rows[0].name,
    enabled: result.rows[0].enabled,
    version: integerVersion(result.rows[0].version, 'Feature flag'),
  };
}

export async function approveOperatorCommand(
  context: Context,
  input: ApproveOperatorCommandInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  if (!Number.isSafeInteger(input.expectedCommandVersion) || input.expectedCommandVersion < 1) {
    return fail('BAD_REQUEST', 'Command expected version must be a positive integer.');
  }
  return db.transaction(async (query) => {
    const role = await currentAdminRole(query, identity.userId);
    if (!PRIVILEGED_ROLES.has(role.role)) {
      return fail('FORBIDDEN', 'Operator-admin scope is required to approve a command.');
    }
    const result = await query<CommandRow>(
      `SELECT id, operation_type, authority_scope, target_kind, target_id,
              target_expected_version, command_payload, status, requested_by,
              approved_by, decision_idempotency_key, request_hash,
              execution_result, version
         FROM operator_command_requests
        WHERE id = $1
        FOR UPDATE`,
      [input.commandId],
    );
    const command = result.rows[0];
    if (!command) return fail('NOT_FOUND', 'Operator command was not found.');

    if (command.status === 'EXECUTED'
      && command.approved_by === identity.userId
      && command.decision_idempotency_key === input.idempotencyKey) {
      return {
        commandId: command.id,
        status: command.status,
        version: integerVersion(command.version, 'Operator command'),
        executionResult: command.execution_result,
        idempotencyReplayed: true,
      };
    }
    if (command.status !== 'PENDING') {
      return fail('PRECONDITION_FAILED', 'Operator command is no longer pending.');
    }
    if (command.requested_by === identity.userId) {
      return fail('FORBIDDEN', 'Requester cannot approve their own operator command.');
    }
    requireExpectedVersion(
      integerVersion(command.version, 'Operator command'),
      input.expectedCommandVersion,
      'Operator command',
    );

    const executionResult = await executeBoundedCommand(query, command);
    const updated = await query<{ id: string; status: 'EXECUTED'; version: number | string }>(
      `UPDATE operator_command_requests
          SET status = 'EXECUTED',
              approved_by = $2,
              approval_reason = $3,
              decision_idempotency_key = $4,
              execution_result = $5::jsonb,
              decided_at = clock_timestamp(),
              version = version + 1
        WHERE id = $1 AND status = 'PENDING' AND version = $6
        RETURNING id, status, version`,
      [
        command.id,
        identity.userId,
        input.reason,
        input.idempotencyKey,
        JSON.stringify(executionResult),
        input.expectedCommandVersion,
      ],
    );
    if (!updated.rows[0]) return fail('CONFLICT', 'Operator command changed during approval.');

    await query(
      `INSERT INTO operator_command_audit (
         command_id, command_version, event_type, actor_id,
         authority_scope, event_details
       ) VALUES ($1, $2, 'APPROVED_AND_EXECUTED', $3, $4, $5::jsonb)`,
      [
        command.id,
        updated.rows[0].version,
        identity.userId,
        command.authority_scope,
        JSON.stringify({
          operationType: command.operation_type,
          targetId: command.target_id,
          requesterId: command.requested_by,
          approverId: identity.userId,
          executionResult,
        }),
      ],
    );
    return {
      commandId: updated.rows[0].id,
      status: updated.rows[0].status,
      version: integerVersion(updated.rows[0].version, 'Operator command'),
      executionResult,
      idempotencyReplayed: false,
    };
  });
}

export async function rejectOperatorCommand(
  context: Context,
  input: RejectOperatorCommandInput,
) {
  const identity = requireFreshOperatorIdentity(context);
  if (!Number.isSafeInteger(input.expectedCommandVersion) || input.expectedCommandVersion < 1) {
    return fail('BAD_REQUEST', 'Command expected version must be a positive integer.');
  }
  return db.transaction(async (query) => {
    const role = await currentAdminRole(query, identity.userId);
    if (!PRIVILEGED_ROLES.has(role.role)) {
      return fail('FORBIDDEN', 'Operator-admin scope is required to reject a command.');
    }
    const result = await query<CommandRow>(
      `SELECT id, operation_type, authority_scope, target_kind, target_id,
              target_expected_version, command_payload, status, requested_by,
              approved_by, decision_idempotency_key, request_hash,
              execution_result, version
         FROM operator_command_requests
        WHERE id = $1
        FOR UPDATE`,
      [input.commandId],
    );
    const command = result.rows[0];
    if (!command) return fail('NOT_FOUND', 'Operator command was not found.');
    if (command.status === 'REJECTED'
      && command.approved_by === identity.userId
      && command.decision_idempotency_key === input.idempotencyKey) {
      return {
        commandId: command.id,
        status: command.status,
        version: integerVersion(command.version, 'Operator command'),
        idempotencyReplayed: true,
      };
    }
    if (command.status !== 'PENDING') {
      return fail('PRECONDITION_FAILED', 'Operator command is no longer pending.');
    }
    if (command.requested_by === identity.userId) {
      return fail('FORBIDDEN', 'Requester cannot decide their own operator command.');
    }
    requireExpectedVersion(
      integerVersion(command.version, 'Operator command'),
      input.expectedCommandVersion,
      'Operator command',
    );

    const updated = await query<{ id: string; status: 'REJECTED'; version: number | string }>(
      `UPDATE operator_command_requests
          SET status = 'REJECTED',
              approved_by = $2,
              approval_reason = $3,
              decision_idempotency_key = $4,
              decided_at = clock_timestamp(),
              version = version + 1
        WHERE id = $1 AND status = 'PENDING' AND version = $5
        RETURNING id, status, version`,
      [
        command.id,
        identity.userId,
        input.reason,
        input.idempotencyKey,
        input.expectedCommandVersion,
      ],
    );
    if (!updated.rows[0]) return fail('CONFLICT', 'Operator command changed during rejection.');
    await query(
      `INSERT INTO operator_command_audit (
         command_id, command_version, event_type, actor_id,
         authority_scope, event_details
       ) VALUES ($1, $2, 'REJECTED', $3, $4, $5::jsonb)`,
      [
        command.id,
        updated.rows[0].version,
        identity.userId,
        command.authority_scope,
        JSON.stringify({
          operationType: command.operation_type,
          targetId: command.target_id,
          requesterId: command.requested_by,
          reviewerId: identity.userId,
        }),
      ],
    );
    return {
      commandId: updated.rows[0].id,
      status: updated.rows[0].status,
      version: integerVersion(updated.rows[0].version, 'Operator command'),
      idempotencyReplayed: false,
    };
  });
}

export async function listPendingOperatorCommands(context: Context, limit: number) {
  const identity = requireFreshOperatorIdentity(context);
  await currentAdminRole(db.query, identity.userId);
  const result = await db.query(
    `SELECT id, operation_type, authority_scope, target_kind, target_id,
            target_expected_version, command_payload, reason, status,
            requested_by, requested_at, version
       FROM operator_command_requests
      WHERE status = 'PENDING'
      ORDER BY requested_at ASC, id ASC
      LIMIT $1`,
    [limit],
  );
  return { commands: result.rows };
}

/**
 * Purpose-bounded command history for the named Operations cockpit. Actor UUIDs
 * are never returned; the response exposes display names plus current-operator
 * booleans and the immutable audit sequence needed to prove separation of duty.
 */
export async function listOperatorCommandHistory(context: Context, limit: number) {
  const identity = requireFreshOperatorIdentity(context);
  await currentAdminRole(db.query, identity.userId);
  const result = await db.query(
    `SELECT command.id, command.operation_type, command.authority_scope,
            command.target_kind, command.target_id, command.target_expected_version,
            command.command_payload, command.reason, command.status,
            command.requested_at, command.decided_at, command.approval_reason,
            command.execution_result, command.version,
            COALESCE(NULLIF(BTRIM(requester.full_name), ''), requester.email, 'Named operator')
              AS requester_display_name,
            CASE WHEN approver.id IS NULL THEN NULL
                 ELSE COALESCE(NULLIF(BTRIM(approver.full_name), ''), approver.email, 'Named operator')
             END AS approver_display_name,
            command.requested_by = $2::UUID AS requested_by_current_operator,
            command.approved_by = $2::UUID AS approved_by_current_operator,
            COALESCE(audit.events, '[]'::JSONB) AS events
       FROM operator_command_requests command
       JOIN users requester ON requester.id = command.requested_by
       LEFT JOIN users approver ON approver.id = command.approved_by
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'eventType', event.event_type,
           'commandVersion', event.command_version,
           'actorDisplayName', COALESCE(NULLIF(BTRIM(actor.full_name), ''), actor.email, 'Named operator'),
           'actedByCurrentOperator', event.actor_id = $2::UUID,
           'createdAt', event.created_at
         ) ORDER BY event.created_at, event.id) AS events
           FROM operator_command_audit event
           JOIN users actor ON actor.id = event.actor_id
          WHERE event.command_id = command.id
       ) audit ON TRUE
      ORDER BY command.requested_at DESC, command.id DESC
      LIMIT $1`,
    [limit, identity.userId],
  );
  return { commands: result.rows };
}

export const OperatorAuthorityService = {
  getSession: getOperatorSession,
  request: requestOperatorCommand,
  approve: approveOperatorCommand,
  reject: rejectOperatorCommand,
  listPending: listPendingOperatorCommands,
  listHistory: listOperatorCommandHistory,
};
