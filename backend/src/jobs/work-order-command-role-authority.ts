import type { QueryFn } from '../db.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

const ROLE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;

export const WORK_ORDER_COMMAND_FUNCTION =
  'public.materialize_universal_v1_fake_work_order_v1(text,text,uuid,uuid,uuid)';

export const WORK_ORDER_COMMAND_WRITE_RELATIONS = [
  'public.task_work_order_command_requests',
  'public.task_provider_eligibility_decisions',
  'public.task_work_orders',
] as const;

export interface WorkOrderCommandRoleNames {
  migrationRole: string;
  runtimeRole: string;
  commandOwnerRole: string;
}

interface RoleRow extends Record<string, unknown> {
  rolname: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  member_of_migration_role: boolean;
  member_of_runtime_role: boolean;
  member_of_command_owner_role: boolean;
}

interface FunctionRow extends Record<string, unknown> {
  function_oid: string | null;
  owner_role: string | null;
  security_definer: boolean | null;
  volatility: string | null;
  configuration: string[] | null;
  runtime_execute: boolean;
  migration_execute: boolean;
  public_execute: boolean;
  actor_binding_present: boolean;
  actor_binding_protocol_approved: boolean;
  runtime_writable_actor_setting_present: boolean;
  runtime_public_schema_create: boolean;
}

interface RelationPrivilegeRow extends Record<string, unknown> {
  relation_name: string;
  owner_role: string | null;
  runtime_insert: boolean;
  runtime_update: boolean;
  runtime_delete: boolean;
  runtime_truncate: boolean;
}

export interface WorkOrderCommandAuthorityEvidence {
  sessionRole: string;
  roles: RoleRow[];
  commandFunction: FunctionRow | null;
  relationPrivileges: RelationPrivilegeRow[];
}

export interface WorkOrderCommandAuthorityReport {
  status: 'READY' | 'BLOCKED';
  reasons: string[];
  roles: WorkOrderCommandRoleNames;
  functionIdentity: typeof WORK_ORDER_COMMAND_FUNCTION;
  protectedWriteRelations: typeof WORK_ORDER_COMMAND_WRITE_RELATIONS;
  sessionRole: string;
}

function refuse(reason: string): never {
  throw new Error(`WORK_ORDER_COMMAND_AUTHORITY_REFUSED:${reason}`);
}

function requiredRole(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) return refuse(`${name}_REQUIRED`);
  if (!ROLE_IDENTIFIER.test(value)) return refuse(`${name}_INVALID`);
  return value;
}

/**
 * Resolve role identities without assigning names in source. Role creation and
 * credential distribution remain infrastructure-owner actions outside this
 * verifier.
 */
export function configuredWorkOrderCommandRoles(env: Environment): WorkOrderCommandRoleNames {
  const roles = {
    migrationRole: requiredRole(env, 'HX_WORK_ORDER_MIGRATION_DATABASE_ROLE'),
    runtimeRole: requiredRole(env, 'HX_WORK_ORDER_RUNTIME_DATABASE_ROLE'),
    commandOwnerRole: requiredRole(env, 'HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE'),
  };
  if (new Set(Object.values(roles)).size !== 3) return refuse('ROLES_MUST_BE_PAIRWISE_DISTINCT');
  return roles;
}

/** Read-only PostgreSQL privilege and function-definition evidence. */
export async function readWorkOrderCommandAuthority(
  query: QueryFn,
  roles: WorkOrderCommandRoleNames
): Promise<WorkOrderCommandAuthorityEvidence> {
  const identity = await query<{ session_role: string }>(
    'SELECT current_user::text AS session_role'
  );
  if (identity.rows.length !== 1) return refuse('SESSION_IDENTITY_ROW_COUNT_INVALID');

  const roleEvidence = await query<RoleRow>(
    `SELECT role.rolname::text, role.rolcanlogin, role.rolsuper, role.rolcreaterole,
            role.rolcreatedb, role.rolreplication, role.rolbypassrls,
            COALESCE(pg_catalog.pg_has_role(role.oid, migration.oid, 'MEMBER'), false)
              AS member_of_migration_role,
            COALESCE(pg_catalog.pg_has_role(role.oid, runtime.oid, 'MEMBER'), false)
              AS member_of_runtime_role,
            COALESCE(pg_catalog.pg_has_role(role.oid, command_owner.oid, 'MEMBER'), false)
              AS member_of_command_owner_role
       FROM pg_catalog.pg_roles role
       LEFT JOIN pg_catalog.pg_roles migration ON migration.rolname = $2
       LEFT JOIN pg_catalog.pg_roles runtime ON runtime.rolname = $3
       LEFT JOIN pg_catalog.pg_roles command_owner ON command_owner.rolname = $4
      WHERE role.rolname = ANY($1::text[])
      ORDER BY rolname`,
    [
      [roles.migrationRole, roles.runtimeRole, roles.commandOwnerRole],
      roles.migrationRole,
      roles.runtimeRole,
      roles.commandOwnerRole,
    ]
  );

  const functionEvidence = await query<FunctionRow>(
    `WITH target AS (
       SELECT procedure.oid,
              owner.rolname::text AS owner_role,
              procedure.prosecdef AS security_definer,
              procedure.provolatile::text AS volatility,
              procedure.proconfig AS configuration,
              procedure.prosrc,
              procedure.proacl,
              procedure.proowner
         FROM pg_catalog.pg_proc procedure
         JOIN pg_catalog.pg_roles owner ON owner.oid = procedure.proowner
        WHERE procedure.oid = pg_catalog.to_regprocedure($1)
     )
     SELECT target.oid::text AS function_oid,
            target.owner_role,
            target.security_definer,
            target.volatility,
            target.configuration,
            COALESCE((
              SELECT pg_catalog.has_function_privilege(role.oid, target.oid, 'EXECUTE')
                FROM pg_catalog.pg_roles role WHERE role.rolname = $2
            ), false) AS runtime_execute,
            COALESCE((
              SELECT pg_catalog.has_function_privilege(role.oid, target.oid, 'EXECUTE')
                FROM pg_catalog.pg_roles role WHERE role.rolname = $3
            ), false) AS migration_execute,
            COALESCE((
              SELECT bool_or(privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE')
                FROM pg_catalog.aclexplode(COALESCE(
                  target.proacl,
                  pg_catalog.acldefault('f', target.proowner)
                )) privilege
            ), false) AS public_execute,
            false AS actor_binding_present,
            false AS actor_binding_protocol_approved,
            target.prosrc LIKE '%current_setting(''hustlexp.authenticated_actor_id'', true)%'
              AS runtime_writable_actor_setting_present,
            COALESCE((
              SELECT pg_catalog.has_schema_privilege(role.oid, 'public', 'CREATE')
                FROM pg_catalog.pg_roles role WHERE role.rolname = $2
            ), false) AS runtime_public_schema_create
       FROM target`,
    [WORK_ORDER_COMMAND_FUNCTION, roles.runtimeRole, roles.migrationRole]
  );

  const relationEvidence = await query<RelationPrivilegeRow>(
    `SELECT relation_name,
            owner.rolname::text AS owner_role,
            COALESCE(pg_catalog.has_table_privilege(runtime.oid, relation_oid, 'INSERT'), false) AS runtime_insert,
            COALESCE(pg_catalog.has_table_privilege(runtime.oid, relation_oid, 'UPDATE'), false) AS runtime_update,
            COALESCE(pg_catalog.has_table_privilege(runtime.oid, relation_oid, 'DELETE'), false) AS runtime_delete,
            COALESCE(pg_catalog.has_table_privilege(runtime.oid, relation_oid, 'TRUNCATE'), false) AS runtime_truncate
       FROM unnest($2::text[]) relation_name
       CROSS JOIN LATERAL (SELECT pg_catalog.to_regclass(relation_name) AS relation_oid) relation
       LEFT JOIN pg_catalog.pg_class class ON class.oid = relation.relation_oid
       LEFT JOIN pg_catalog.pg_roles owner ON owner.oid = class.relowner
       LEFT JOIN pg_catalog.pg_roles runtime ON runtime.rolname = $1
      ORDER BY relation_name`,
    [roles.runtimeRole, [...WORK_ORDER_COMMAND_WRITE_RELATIONS]]
  );

  return {
    sessionRole: identity.rows[0]!.session_role,
    roles: roleEvidence.rows,
    commandFunction: functionEvidence.rows[0] ?? null,
    relationPrivileges: relationEvidence.rows,
  };
}

function elevated(role: RoleRow): boolean {
  return (
    role.rolsuper ||
    role.rolcreaterole ||
    role.rolcreatedb ||
    role.rolreplication ||
    role.rolbypassrls
  );
}

/**
 * Evaluate exact live evidence. Absence is a blocker; this routine never
 * creates roles, changes ownership, grants privileges, or mutates data.
 */
export function evaluateWorkOrderCommandAuthority(
  roles: WorkOrderCommandRoleNames,
  evidence: WorkOrderCommandAuthorityEvidence
): WorkOrderCommandAuthorityReport {
  const reasons: string[] = [];
  const byName = new Map(evidence.roles.map((role) => [role.rolname, role]));
  const migration = byName.get(roles.migrationRole);
  const runtime = byName.get(roles.runtimeRole);
  const owner = byName.get(roles.commandOwnerRole);

  if (!migration) reasons.push('MIGRATION_ROLE_NOT_FOUND');
  if (!runtime) reasons.push('RUNTIME_ROLE_NOT_FOUND');
  if (!owner) reasons.push('COMMAND_OWNER_ROLE_NOT_FOUND');
  if (migration && elevated(migration)) reasons.push('MIGRATION_ROLE_ELEVATED');
  if (runtime && (!runtime.rolcanlogin || elevated(runtime))) {
    reasons.push('RUNTIME_ROLE_SHAPE_INVALID');
  }
  if (runtime && (runtime.member_of_migration_role || runtime.member_of_command_owner_role)) {
    reasons.push('RUNTIME_ROLE_PRIVILEGED_MEMBERSHIP_PRESENT');
  }
  if (owner && (owner.rolcanlogin || elevated(owner))) {
    reasons.push('COMMAND_OWNER_MUST_BE_UNPRIVILEGED_NOLOGIN');
  }
  if (owner && (owner.member_of_migration_role || owner.member_of_runtime_role)) {
    reasons.push('COMMAND_OWNER_ROLE_MEMBERSHIP_PRESENT');
  }
  if (migration && (migration.member_of_runtime_role || migration.member_of_command_owner_role)) {
    reasons.push('MIGRATION_ROLE_APPLICATION_MEMBERSHIP_PRESENT');
  }

  const command = evidence.commandFunction;
  if (!command?.function_oid) {
    reasons.push('COMMAND_FUNCTION_NOT_FOUND');
  } else {
    if (command.owner_role !== roles.commandOwnerRole)
      reasons.push('COMMAND_FUNCTION_OWNER_MISMATCH');
    if (!command.security_definer) reasons.push('COMMAND_FUNCTION_NOT_SECURITY_DEFINER');
    if (command.volatility !== 'v') reasons.push('COMMAND_FUNCTION_NOT_VOLATILE');
    if (
      command.configuration?.length !== 1 ||
      command.configuration[0] !== 'search_path=pg_catalog, public'
    ) {
      reasons.push('COMMAND_FUNCTION_SEARCH_PATH_NOT_FIXED');
    }
    if (!command.actor_binding_present) reasons.push('AUTHENTICATED_ACTOR_BINDING_MISSING');
    if (!command.actor_binding_protocol_approved) {
      reasons.push('AUTHENTICATED_ACTOR_BINDING_PROTOCOL_UNAPPROVED');
    }
    if (command.runtime_writable_actor_setting_present) {
      reasons.push('RUNTIME_WRITABLE_ACTOR_SETTING_IS_NOT_AUTHORITY');
    }
    if (command.runtime_public_schema_create)
      reasons.push('RUNTIME_CAN_CREATE_IN_FUNCTION_SEARCH_PATH');
    if (!command.runtime_execute) reasons.push('RUNTIME_EXECUTE_MISSING');
    if (command.migration_execute) reasons.push('MIGRATION_EXECUTE_MUST_BE_REVOKED');
    if (command.public_execute) reasons.push('PUBLIC_EXECUTE_MUST_BE_REVOKED');
  }

  const privileges = new Map(
    evidence.relationPrivileges.map((relation) => [relation.relation_name, relation])
  );
  for (const relationName of WORK_ORDER_COMMAND_WRITE_RELATIONS) {
    const relation = privileges.get(relationName);
    if (!relation?.owner_role) {
      reasons.push(`PROTECTED_RELATION_NOT_FOUND:${relationName}`);
      continue;
    }
    if (relation.owner_role === roles.runtimeRole) {
      reasons.push(`RUNTIME_OWNS_PROTECTED_RELATION:${relationName}`);
    }
    if (
      relation.runtime_insert ||
      relation.runtime_update ||
      relation.runtime_delete ||
      relation.runtime_truncate
    ) {
      reasons.push(`RUNTIME_DIRECT_WRITE_PRESENT:${relationName}`);
    }
  }

  return {
    status: reasons.length === 0 ? 'READY' : 'BLOCKED',
    reasons,
    roles,
    functionIdentity: WORK_ORDER_COMMAND_FUNCTION,
    protectedWriteRelations: WORK_ORDER_COMMAND_WRITE_RELATIONS,
    sessionRole: evidence.sessionRole,
  };
}

export async function verifyWorkOrderCommandAuthority(
  query: QueryFn,
  env: Environment
): Promise<WorkOrderCommandAuthorityReport> {
  const roles = configuredWorkOrderCommandRoles(env);
  return evaluateWorkOrderCommandAuthority(
    roles,
    await readWorkOrderCommandAuthority(query, roles)
  );
}
