import { describe, expect, it, vi } from 'vitest';

import type { QueryFn } from '../../src/db.js';
import {
  configuredWorkOrderCommandRoles,
  evaluateWorkOrderCommandAuthority,
  readWorkOrderCommandAuthority,
  WORK_ORDER_COMMAND_FUNCTION,
  WORK_ORDER_COMMAND_WRITE_RELATIONS,
  type WorkOrderCommandAuthorityEvidence,
  type WorkOrderCommandRoleNames,
} from '../../src/jobs/work-order-command-role-authority.js';

const names: WorkOrderCommandRoleNames = {
  migrationRole: 'hx_migration_candidate',
  runtimeRole: 'hx_runtime_candidate',
  commandOwnerRole: 'hx_work_order_owner_candidate',
};

const role = (rolname: string, rolcanlogin: boolean) => ({
  rolname,
  rolcanlogin,
  rolsuper: false,
  rolcreaterole: false,
  rolcreatedb: false,
  rolreplication: false,
  rolbypassrls: false,
  member_of_migration_role: rolname === names.migrationRole,
  member_of_runtime_role: rolname === names.runtimeRole,
  member_of_command_owner_role: rolname === names.commandOwnerRole,
});

const ready: WorkOrderCommandAuthorityEvidence = {
  sessionRole: names.migrationRole,
  roles: [
    role(names.migrationRole, true),
    role(names.runtimeRole, true),
    role(names.commandOwnerRole, false),
  ],
  commandFunction: {
    function_oid: '4242',
    owner_role: names.commandOwnerRole,
    security_definer: true,
    volatility: 'v',
    configuration: ['search_path=pg_catalog, public'],
    runtime_execute: true,
    migration_execute: false,
    public_execute: false,
    actor_binding_present: true,
    actor_binding_protocol_approved: true,
    runtime_writable_actor_setting_present: false,
    runtime_public_schema_create: false,
  },
  relationPrivileges: WORK_ORDER_COMMAND_WRITE_RELATIONS.map((relation_name) => ({
    relation_name,
    owner_role: names.migrationRole,
    runtime_insert: false,
    runtime_update: false,
    runtime_delete: false,
    runtime_truncate: false,
  })),
};

describe('Work Order database command role configuration', () => {
  it('requires three explicit, valid, pairwise-distinct role identities', () => {
    expect(
      configuredWorkOrderCommandRoles({
        HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: names.migrationRole,
        HX_WORK_ORDER_RUNTIME_DATABASE_ROLE: names.runtimeRole,
        HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: names.commandOwnerRole,
      })
    ).toEqual(names);
    for (const env of [
      {},
      {
        HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: names.migrationRole,
        HX_WORK_ORDER_RUNTIME_DATABASE_ROLE: names.runtimeRole,
        HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: names.runtimeRole,
      },
      {
        HX_WORK_ORDER_MIGRATION_DATABASE_ROLE: 'Role-With-Dashes',
        HX_WORK_ORDER_RUNTIME_DATABASE_ROLE: names.runtimeRole,
        HX_WORK_ORDER_COMMAND_OWNER_DATABASE_ROLE: names.commandOwnerRole,
      },
    ]) {
      expect(() => configuredWorkOrderCommandRoles(env)).toThrow(
        'WORK_ORDER_COMMAND_AUTHORITY_REFUSED:'
      );
    }
  });
});

describe('Work Order database command authority evaluation', () => {
  it('accepts only a no-login owner, execute-only runtime, fixed path, and actor-bound function', () => {
    expect(evaluateWorkOrderCommandAuthority(names, ready)).toEqual(
      expect.objectContaining({
        status: 'READY',
        reasons: [],
        functionIdentity: WORK_ORDER_COMMAND_FUNCTION,
        protectedWriteRelations: [
          'public.task_work_order_command_requests',
          'public.task_provider_eligibility_decisions',
          'public.task_work_orders',
        ],
      })
    );
  });

  it('blocks a missing entrypoint and every elevated or shared direct-write path', () => {
    const evidence: WorkOrderCommandAuthorityEvidence = {
      ...ready,
      roles: [
        role(names.migrationRole, true),
        { ...role(names.runtimeRole, true), rolsuper: true },
        { ...role(names.commandOwnerRole, true), rolcreaterole: true },
      ],
      commandFunction: null,
      relationPrivileges: ready.relationPrivileges.map((relation) => ({
        ...relation,
        owner_role: names.runtimeRole,
        runtime_insert: true,
      })),
    };
    const result = evaluateWorkOrderCommandAuthority(names, evidence);
    expect(result.status).toBe('BLOCKED');
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'RUNTIME_ROLE_SHAPE_INVALID',
        'COMMAND_OWNER_MUST_BE_UNPRIVILEGED_NOLOGIN',
        'COMMAND_FUNCTION_NOT_FOUND',
        `RUNTIME_OWNS_PROTECTED_RELATION:${WORK_ORDER_COMMAND_WRITE_RELATIONS[0]}`,
        `RUNTIME_DIRECT_WRITE_PRESENT:${WORK_ORDER_COMMAND_WRITE_RELATIONS[1]}`,
        `RUNTIME_DIRECT_WRITE_PRESENT:${WORK_ORDER_COMMAND_WRITE_RELATIONS[2]}`,
      ])
    );
  });

  it('blocks weak function ownership, path, ACL, volatility, and actor binding independently', () => {
    const result = evaluateWorkOrderCommandAuthority(names, {
      ...ready,
      commandFunction: {
        ...ready.commandFunction!,
        owner_role: names.migrationRole,
        security_definer: false,
        volatility: 's',
        configuration: ['search_path=public'],
        runtime_execute: false,
        migration_execute: true,
        public_execute: true,
        actor_binding_present: false,
        actor_binding_protocol_approved: false,
        runtime_writable_actor_setting_present: true,
        runtime_public_schema_create: true,
      },
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining([
        'COMMAND_FUNCTION_OWNER_MISMATCH',
        'COMMAND_FUNCTION_NOT_SECURITY_DEFINER',
        'COMMAND_FUNCTION_NOT_VOLATILE',
        'COMMAND_FUNCTION_SEARCH_PATH_NOT_FIXED',
        'AUTHENTICATED_ACTOR_BINDING_MISSING',
        'AUTHENTICATED_ACTOR_BINDING_PROTOCOL_UNAPPROVED',
        'RUNTIME_WRITABLE_ACTOR_SETTING_IS_NOT_AUTHORITY',
        'RUNTIME_CAN_CREATE_IN_FUNCTION_SEARCH_PATH',
        'RUNTIME_EXECUTE_MISSING',
        'MIGRATION_EXECUTE_MUST_BE_REVOKED',
        'PUBLIC_EXECUTE_MUST_BE_REVOKED',
      ])
    );
  });

  it('performs parameterized readback only and never emits role or privilege DDL', async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(
        /(?:^|;)\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/u
      );
      if (sql.includes('current_user::text'))
        return { rows: [{ session_role: names.migrationRole }], rowCount: 1 };
      if (sql.includes('WITH target AS')) return { rows: [ready.commandFunction], rowCount: 1 };
      if (sql.includes('FROM pg_catalog.pg_roles')) return { rows: ready.roles, rowCount: 3 };
      return { rows: ready.relationPrivileges, rowCount: ready.relationPrivileges.length };
    }) as unknown as QueryFn;
    await expect(readWorkOrderCommandAuthority(query, names)).resolves.toEqual(ready);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(
        /pg_catalog\.to_regprocedure\(\$1\)[\s\S]*false AS actor_binding_protocol_approved/u
      ),
      [WORK_ORDER_COMMAND_FUNCTION, names.runtimeRole, names.migrationRole]
    );
  });
});
