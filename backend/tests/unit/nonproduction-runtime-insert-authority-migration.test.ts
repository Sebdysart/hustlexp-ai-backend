import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20261013_nonproduction_runtime_insert_authority_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);
const executableSql = migration.replaceAll(/--[^\r\n]*/gu, '');

interface PortExpectation {
  readonly name: string;
  readonly identity: string;
  readonly returnRelation: string;
  readonly marker: string;
  readonly targetRelation: string;
  readonly idColumn: string;
  readonly idParameter: string;
  readonly writerFile?: string;
  readonly applicationEntrypoint?: string;
}

const ports: readonly PortExpectation[] = [
  {
    name: 'hxos_record_financial_provider_command_v1',
    identity:
      'public.hxos_record_financial_provider_command_v1(uuid,text,uuid,text,text,bigint,text,text,uuid,text,uuid,uuid,uuid,uuid,bigint,text,uuid,text,text,text,text,text,text)',
    returnRelation: 'financial_provider_command_journal',
    marker: 'HXUV1-NPFIP-V1:JOURNAL',
    targetRelation: 'financial_provider_command_journal',
    idColumn: 'command_id',
    idParameter: 'p_command_id',
    writerFile: 'backend/src/services/payment/FinancialProviderCommandJournal.ts',
  },
  {
    name: 'hxos_prepare_universal_v1_financial_command_v1',
    identity:
      'public.hxos_prepare_universal_v1_financial_command_v1(uuid,text,uuid,text,text,bigint,bigint,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,uuid)',
    returnRelation: 'universal_v1_prepared_financial_commands',
    marker: 'HXUV1-NPFIP-V1:PREPARED',
    targetRelation: 'universal_v1_prepared_financial_commands',
    idColumn: 'prepared_command_id',
    idParameter: 'p_prepared_command_id',
    writerFile: 'backend/src/services/payment/PreparedFinancialCommandAuthority.ts',
    applicationEntrypoint: 'hxos_prepare_authenticated_fake_financial_command_v13',
  },
  {
    name: 'hxos_record_financial_provider_dispatch_attempt_v1',
    identity: 'public.hxos_record_financial_provider_dispatch_attempt_v1(uuid,uuid,uuid,integer)',
    returnRelation: 'financial_provider_command_dispatch_attempts',
    marker: 'HXUV1-NPFIP-V1:DISPATCH',
    targetRelation: 'financial_provider_command_dispatch_attempts',
    idColumn: 'dispatch_attempt_id',
    idParameter: 'p_dispatch_attempt_id',
    writerFile: 'backend/src/services/payment/FinancialProviderCommandRecovery.ts',
  },
  {
    name: 'hxos_record_change_order_materialization_command_v1',
    identity:
      'public.hxos_record_change_order_materialization_command_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,integer,integer,integer,integer,integer,uuid,uuid,uuid,integer,integer,text,timestamp with time zone)',
    returnRelation: 'universal_v1_change_order_materialization_commands',
    marker: 'HXUV1-NPFIP-V1:CHANGE_ORDER',
    targetRelation: 'universal_v1_change_order_materialization_commands',
    idColumn: 'proposal_id',
    idParameter: 'p_proposal_id',
    writerFile: 'backend/src/services/UniversalV1ChangeOrderPostgresRepository.ts',
  },
  {
    name: 'hxos_record_fake_financial_lifecycle_bridge_v1',
    identity:
      'public.hxos_record_fake_financial_lifecycle_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    returnRelation: 'universal_v1_fake_financial_lifecycle_bridges',
    marker: 'HXUV1-NPFIP-V1:LIFECYCLE_BRIDGE',
    targetRelation: 'universal_v1_fake_financial_lifecycle_bridges',
    idColumn: 'bridge_id',
    idParameter: 'p_bridge_id',
  },
  {
    name: 'hxos_record_fake_financial_security_event_v1',
    identity:
      'public.hxos_record_fake_financial_security_event_v1(uuid,uuid,text,uuid,text,uuid,uuid,uuid,uuid,uuid)',
    returnRelation: 'task_financial_security_events',
    marker: 'HXUV1-NPFIP-V1:FAKE_FINANCIAL_EVENT',
    targetRelation: 'task_financial_security_events',
    idColumn: 'id',
    idParameter: 'p_event_id',
    writerFile: 'backend/src/services/payment/UniversalV1FinancialApplicationService.ts',
  },
  {
    name: 'hxos_record_fake_terminal_lifecycle_intent_v1',
    identity:
      'public.hxos_record_fake_terminal_lifecycle_intent_v1(uuid,text,uuid,uuid,uuid,uuid,bigint,integer,text,text,uuid)',
    returnRelation: 'universal_v1_fake_terminal_lifecycle_intents',
    marker: 'HXUV1-NPFIP-V1:TERMINAL_INTENT',
    targetRelation: 'universal_v1_fake_terminal_lifecycle_intents',
    idColumn: 'terminal_intent_id',
    idParameter: 'p_terminal_intent_id',
    writerFile: 'backend/src/services/UniversalV1FulfillmentPostgresRepository.ts',
  },
  {
    name: 'hxos_record_fake_provider_account_fact_v1',
    identity:
      'public.hxos_record_fake_provider_account_fact_v1(uuid,text,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    returnRelation: 'universal_v1_fake_provider_account_facts',
    marker: 'HXUV1-NPFIP-V1:PROVIDER_ACCOUNT',
    targetRelation: 'universal_v1_fake_provider_account_facts',
    idColumn: 'provider_account_fact_id',
    idParameter: 'p_provider_account_fact_id',
    writerFile: 'backend/src/services/payment/UniversalV1FakeProviderAccountRepository.ts',
  },
  {
    name: 'hxos_record_fake_reconciliation_bridge_v1',
    identity:
      'public.hxos_record_fake_reconciliation_bridge_v1(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    returnRelation: 'universal_v1_fake_reconciliation_bridges',
    marker: 'HXUV1-NPFIP-V1:RECONCILIATION_BRIDGE',
    targetRelation: 'universal_v1_fake_reconciliation_bridges',
    idColumn: 'reconciliation_bridge_id',
    idParameter: 'p_reconciliation_bridge_id',
  },
  {
    name: 'hxos_record_fake_reconciliation_fact_v1',
    identity:
      'public.hxos_record_fake_reconciliation_fact_v1(uuid,uuid,text,uuid,text,text,uuid,uuid,uuid,uuid,uuid,text)',
    returnRelation: 'task_reconciliation_facts',
    marker: 'HXUV1-NPFIP-V1:FAKE_RECONCILIATION_FACT',
    targetRelation: 'task_reconciliation_facts',
    idColumn: 'id',
    idParameter: 'p_reconciliation_fact_id',
    writerFile: 'backend/src/services/payment/UniversalV1FinancialApplicationService.ts',
  },
] as const;

function normalizeSql(value: string): string {
  return value.replaceAll(/\s+/gu, ' ').trim();
}

function functionBlock(name: string): string {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = migration.indexOf('\n$$;', start);
  expect(start, `${name} start`).toBeGreaterThanOrEqual(0);
  expect(end, `${name} end`).toBeGreaterThan(start);
  return migration.slice(start, end + '\n$$;'.length);
}

function functionIdentity(name: string, block: string): string {
  const returnsIndex = block.indexOf('\nRETURNS ');
  expect(returnsIndex, `${name} RETURNS`).toBeGreaterThan(0);
  const header = block.slice(0, returnsIndex);
  const argumentsStart = header.indexOf('(');
  const argumentsEnd = header.lastIndexOf(')');
  expect(argumentsStart, `${name} arguments start`).toBeGreaterThan(0);
  expect(argumentsEnd, `${name} arguments end`).toBeGreaterThan(argumentsStart);
  const argumentTypes = header
    .slice(argumentsStart + 1, argumentsEnd)
    .split(',')
    .map((argument) => {
      const match = /^p_[a-z0-9_]+\s+(.+)$/iu.exec(argument.trim());
      expect(match, `${name} typed argument: ${argument.trim()}`).not.toBeNull();
      return match![1]!.toLowerCase().replace('timestamptz', 'timestamp with time zone');
    });
  return `public.${name}(${argumentTypes.join(',')})`;
}

describe('nonproduction runtime insert authority migration', () => {
  it('is supplemental and leaves the exact ordinal-146 engine tail unchanged', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES.at(-1)).toEqual({
      name: '20261014_universal_v1_work_order_command_ports_v1',
      fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES.some(({ fileName: candidate }) => String(candidate) === fileName)).toBe(
      false
    );
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('creates exactly ten typed, sealed, PUBLIC-revoked definer ports', () => {
    const createdPorts = [
      ...migration.matchAll(/CREATE OR REPLACE FUNCTION public\.(hxos_[a-z0-9_]+)\(/giu),
    ].map((match) => match[1]!);
    expect(createdPorts).toEqual(ports.map(({ name }) => name));

    for (const port of ports) {
      const block = functionBlock(port.name);
      const normalized = normalizeSql(block);
      expect(functionIdentity(port.name, block)).toBe(port.identity);
      expect(normalized).toContain(`RETURNS public.${port.returnRelation}`);
      expect(normalized).toContain('LANGUAGE plpgsql SECURITY DEFINER VOLATILE PARALLEL UNSAFE');
      expect(normalized).toContain('SET search_path = pg_catalog, public');
      expect(block).toContain(port.marker);
      expect(normalized).toContain('RETURNING * INTO');
      expect(migration).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${port.name}\\([\\s\\S]*?\\)\\s+FROM\\s+PUBLIC;`,
          'u'
        )
      );
    }
  });

  it('requires caller-owned UUID identities and contains no grant or migration-time effect', () => {
    expect(migration).not.toContain('gen_random_uuid');
    for (const port of ports) {
      const normalized = normalizeSql(functionBlock(port.name));
      expect(normalized).toContain(`${port.idParameter} UUID`);
      expect(normalized).toContain(`INSERT INTO public.${port.targetRelation} ( ${port.idColumn},`);
      expect(
        normalized.includes(`VALUES ( ${port.idParameter},`) ||
          normalized.includes(`SELECT ${port.idParameter},`)
      ).toBe(true);
    }

    expect(executableSql).not.toMatch(/^\s*GRANT\b/gimu);
    expect(executableSql).not.toMatch(/\b(?:UPDATE|DELETE FROM)\s+public\./giu);
    const insertTargets = [...executableSql.matchAll(/\bINSERT INTO public\.([a-z0-9_]+)/giu)].map(
      (match) => match[1]!
    );
    expect(insertTargets).toEqual(ports.map(({ targetRelation }) => targetRelation));
  });

  it('routes every production writer through its exact port with no direct target INSERT', () => {
    for (const port of ports) {
      if (!port.writerFile) continue;
      const source = readFileSync(resolve(process.cwd(), port.writerFile), 'utf8');
      expect(source).toContain(`FROM public.${port.applicationEntrypoint ?? port.name}(`);
      if (port.applicationEntrypoint) expect(source).not.toContain(`FROM public.${port.name}(`);
      expect(source).not.toMatch(
        new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${port.targetRelation}\\b`, 'iu')
      );
    }
  });

  it('consumes actor authority before the preparation wrapper delegates to the frozen insert port', () => {
    const current = readFileSync(resolve(process.cwd(), 'backend/database/migrations/20261016_universal_v1_fake_financial_command_outbox_authority_v13.sql'), 'utf8');
    const start = current.indexOf('CREATE OR REPLACE FUNCTION public.hxos_prepare_authenticated_fake_financial_command_v13(');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = current.indexOf('$;', start);
    expect(end).toBeGreaterThan(start);
    const wrapper = current.slice(start, end);
    const consume = wrapper.indexOf('hx_authority.consume_universal_v1_actor_assertion_v1(');
    const insert = wrapper.indexOf('public.hxos_prepare_universal_v1_financial_command_v1(');
    expect(consume).toBeGreaterThanOrEqual(0);
    expect(insert).toBeGreaterThan(consume);
    expect(wrapper.slice(insert)).toContain('actor.resolved_user_id');
    expect(wrapper).toContain('draft.poster_user_id IS DISTINCT FROM actor.resolved_user_id');
  });

  it('makes canonical fake lifecycle and reconciliation writes atomic with their bridge', () => {
    const lifecycle = normalizeSql(functionBlock('hxos_record_fake_financial_security_event_v1'));
    expect(lifecycle).toContain("p_provider_kind IS DISTINCT FROM 'FAKE'");
    expect(lifecycle).toContain('public.hxos_record_fake_financial_lifecycle_bridge_v1(');
    expect(lifecycle).toContain('fake_event.recorded_at');
    expect(lifecycle).toContain('fake_event.expires_at');
    expect(lifecycle).toContain(
      'fake_event.event_version::BIGINT IS DISTINCT FROM outcome.provider_result_version'
    );
    expect(lifecycle).toContain('fake_event.state IS DISTINCT FROM outcome.provider_state');
    expect(lifecycle).toContain(
      'outcome.external_reference_sha256 IS DISTINCT FROM expected_external_reference_sha256'
    );
    expect(lifecycle).toContain(
      'outcome.provider_result_sha256 IS DISTINCT FROM expected_provider_result_sha256'
    );
    expect(lifecycle).toContain('WHERE idempotency_key = p_idempotency_key FOR SHARE');

    const reconciliation = normalizeSql(functionBlock('hxos_record_fake_reconciliation_fact_v1'));
    expect(reconciliation).toContain("p_provider_kind IS DISTINCT FROM 'FAKE'");
    expect(reconciliation).toContain('public.hxos_record_fake_reconciliation_bridge_v1(');
    expect(reconciliation).toContain(
      'public.universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1('
    );
    expect(reconciliation).toContain(
      'p_application_request_sha256 IS DISTINCT FROM intent.request_sha256'
    );
    expect(reconciliation).toContain(
      'fake_event.event_version::BIGINT IS DISTINCT FROM outcome.provider_result_version'
    );
    expect(reconciliation).toContain('fake_event.state IS DISTINCT FROM outcome.provider_state');
    expect(reconciliation).toContain(
      'outcome.external_reference_sha256 IS DISTINCT FROM expected_external_reference_sha256'
    );
    expect(reconciliation).toContain(
      'outcome.provider_result_sha256 IS DISTINCT FROM expected_provider_result_sha256'
    );
    expect(reconciliation).toContain('WHERE idempotency_key = p_idempotency_key FOR SHARE');

    const service = readFileSync(
      resolve(
        process.cwd(),
        'backend/src/services/payment/UniversalV1FinancialApplicationService.ts'
      ),
      'utf8'
    );
    expect(service).not.toMatch(
      /INSERT\s+INTO\s+(?:public\.)?(?:task_financial_security_events|task_reconciliation_facts)\b/iu
    );
    expect(service).not.toContain('FROM public.hxos_record_fake_financial_lifecycle_bridge_v1(');
    expect(service).not.toContain('FROM public.hxos_record_fake_reconciliation_bridge_v1(');
  });

  it('seals deferred canonical-fact guards without granting runtime execution', () => {
    const deferredGuards = [
      'require_universal_v1_controlled_fake_lifecycle_bridge',
      'require_universal_v1_fake_reconciliation_bridge',
      'require_universal_v1_double_entry_ledger_v1',
    ];

    for (const guard of deferredGuards) {
      expect(migration).toMatch(
        new RegExp(`ALTER\\s+FUNCTION\\s+public\\.${guard}\\(\\)\\s+SECURITY\\s+DEFINER;`, 'iu')
      );
      expect(migration).toMatch(
        new RegExp(
          `ALTER\\s+FUNCTION\\s+public\\.${guard}\\(\\)\\s+SET\\s+search_path\\s*=\\s*pg_catalog,\\s*public;`,
          'iu'
        )
      );
      expect(migration).toMatch(
        new RegExp(
          `REVOKE\\s+ALL\\s+ON\\s+FUNCTION\\s+public\\.${guard}\\(\\)\\s+FROM\\s+PUBLIC;`,
          'iu'
        )
      );
    }
  });
});
