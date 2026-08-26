import { readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  newPaymentCreationFailure,
  newPaymentCreationHealth,
  newPaymentCreationMode,
  type NewPaymentLane,
} from '../../src/services/NewPaymentCreationGuard.js';
import {
  CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
  HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7,
} from '../helpers/payment-underwriting-v7.js';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

type ProcessorWriteClass = 'positive' | 'negative' | 'reconciliation';
interface ProcessorWritePolicy {
  classification: ProcessorWriteClass;
  lanes?: readonly NewPaymentLane[];
}
interface ProcessorWriteHit {
  file: string;
  primitive: string;
  policy: ProcessorWritePolicy | undefined;
  dominatingLane: NewPaymentLane | null;
}

const PROCESSOR_COLLECTIONS = [
  'checkout.sessions',
  'paymentIntents',
  'accountLinks',
  'subscriptions',
  'transfers',
  'customers',
  'products',
  'accounts',
  'payouts',
  'refunds',
  'charges',
  'invoices',
] as const;
const PROCESSOR_MUTATION_METHODS = new Set([
  'create',
  'confirm',
  'capture',
  'cancel',
  'update',
  'finalizeInvoice',
  'pay',
  'createReversal',
  'reverse',
  'delete',
  'reject',
]);

const PROCESSOR_WRITE_POLICY: Record<string, ProcessorWritePolicy> = {
  'paymentIntents.create': {
    classification: 'positive',
    lanes: ['escrow_funding', 'xp_tax', 'tip', 'quote_payment'],
  },
  'paymentIntents.confirm': { classification: 'positive', lanes: ['quote_payment'] },
  'paymentIntents.capture': { classification: 'positive', lanes: ['escrow_funding'] },
  'charges.create': { classification: 'positive', lanes: ['escrow_funding'] },
  'checkout.sessions.create': { classification: 'positive', lanes: ['escrow_funding'] },
  'invoices.create': { classification: 'positive', lanes: ['subscription'] },
  'invoices.finalizeInvoice': { classification: 'positive', lanes: ['subscription'] },
  'invoices.pay': { classification: 'positive', lanes: ['subscription'] },
  'customers.create': { classification: 'positive', lanes: ['subscription'] },
  'products.create': { classification: 'positive', lanes: ['subscription'] },
  'subscriptions.create': { classification: 'positive', lanes: ['subscription'] },
  'transfers.create': { classification: 'positive', lanes: ['settlement_transfer'] },
  'payouts.create': { classification: 'positive', lanes: ['cash_out_payout'] },
  'accounts.create': { classification: 'positive', lanes: ['processor_account'] },
  'accountLinks.create': { classification: 'positive', lanes: ['processor_account'] },
  'accounts.update': { classification: 'positive', lanes: ['processor_account'] },
  'paymentIntents.cancel': { classification: 'negative' },
  'subscriptions.cancel': { classification: 'negative' },
  'refunds.create': { classification: 'negative' },
  'refunds.cancel': { classification: 'negative' },
  'transfers.createReversal': { classification: 'negative' },
  'payouts.cancel': { classification: 'negative' },
  'payouts.reverse': { classification: 'negative' },
};

interface ProcessorAliases {
  collections: Map<string, string>;
  methods: Map<string, string>;
}

function normalizedExpressionText(expression: ts.Expression, source: ts.SourceFile): string {
  return expression.getText(source)
    .replace(/\s+/g, '')
    .replaceAll('?.', '.')
    .replaceAll('!', '')
    .replace(/\[['"]([^'"]+)['"]\]/g, '.$1');
}

function processorCollection(
  expression: ts.Expression,
  source: ts.SourceFile,
  aliases: ProcessorAliases,
): string | null {
  if (ts.isIdentifier(expression)) {
    const aliased = aliases.collections.get(expression.text);
    if (aliased) return aliased;
  }
  const normalized = normalizedExpressionText(expression, source);
  return PROCESSOR_COLLECTIONS.find((collection) => (
    normalized === collection || normalized.endsWith(`.${collection}`)
  )) ?? null;
}

function processorPrimitive(
  expression: ts.Expression,
  source: ts.SourceFile,
  aliases: ProcessorAliases,
): string | null {
  if (ts.isIdentifier(expression)) return aliases.methods.get(expression.text) ?? null;
  if (ts.isPropertyAccessExpression(expression)) {
    const collection = processorCollection(expression.expression, source, aliases);
    return collection ? `${collection}.${expression.name.text}` : null;
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    const collection = processorCollection(expression.expression, source, aliases);
    return collection ? `${collection}.${expression.argumentExpression.text}` : null;
  }
  return null;
}

function collectProcessorAliases(source: ts.SourceFile): ProcessorAliases {
  const aliases: ProcessorAliases = { collections: new Map(), methods: new Map() };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const collection = processorCollection(node.initializer, source, aliases);
        if (collection) aliases.collections.set(node.name.text, collection);
        const primitive = processorPrimitive(node.initializer, source, aliases);
        if (primitive) aliases.methods.set(node.name.text, primitive);
      } else if (ts.isObjectBindingPattern(node.name)) {
        const collection = processorCollection(node.initializer, source, aliases);
        if (collection) {
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const method = element.propertyName?.getText(source) ?? element.name.text;
            aliases.methods.set(element.name.text, `${collection}.${method}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return aliases;
}

function containsRuntimeEffect(node: ts.Node): boolean {
  let found = false;
  const visit = (candidate: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(candidate)
      || ts.isNewExpression(candidate)
      || ts.isAwaitExpression(candidate)
      || ts.isYieldExpression(candidate)
      || ts.isDeleteExpression(candidate)
      || ts.isPostfixUnaryExpression(candidate)
    ) {
      found = true;
      return;
    }
    if (
      ts.isPrefixUnaryExpression(candidate)
      && (candidate.operator === ts.SyntaxKind.PlusPlusToken
        || candidate.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(candidate) && candidate.operatorToken.kind >= ts.SyntaxKind.FirstAssignment) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  return found;
}

function guardDeclaration(
  statement: ts.Statement,
  source: ts.SourceFile,
): { variable: string; lane: NewPaymentLane } | null {
  if (!ts.isVariableStatement(statement)) return null;
  for (const declaration of statement.declarationList.declarations) {
    if (
      !ts.isIdentifier(declaration.name)
      || !declaration.initializer
      || !ts.isCallExpression(declaration.initializer)
      || declaration.initializer.expression.getText(source) !== 'newPaymentCreationFailure'
    ) continue;
    const lane = declaration.initializer.arguments[0];
    if (!lane || !ts.isStringLiteral(lane)) return null;
    return { variable: declaration.name.text, lane: lane.text as NewPaymentLane };
  }
  return null;
}

function guardBranchTerminates(statement: ts.Statement, variable: string): boolean {
  if (!ts.isIfStatement(statement) || statement.expression.getText() !== variable) return false;
  if (ts.isReturnStatement(statement.thenStatement) || ts.isThrowStatement(statement.thenStatement)) {
    return true;
  }
  return ts.isBlock(statement.thenStatement)
    && statement.thenStatement.statements.some((candidate) => (
      ts.isReturnStatement(candidate) || ts.isThrowStatement(candidate)
    ));
}

function dominatingGuardLane(call: ts.CallExpression, source: ts.SourceFile): NewPaymentLane | null {
  let scope: ts.Node | undefined = call.parent;
  while (scope) {
    if (ts.isFunctionLike(scope) && scope.body && ts.isBlock(scope.body)) {
      let effectStatement: ts.Node = call;
      while (effectStatement.parent && effectStatement.parent !== scope.body) {
        effectStatement = effectStatement.parent;
      }
      if (effectStatement.parent === scope.body && ts.isStatement(effectStatement)) {
        const effectIndex = scope.body.statements.indexOf(effectStatement);
        for (let index = 0; index < effectIndex; index += 1) {
          const guard = guardDeclaration(scope.body.statements[index], source);
          if (!guard) continue;
          const prelude = scope.body.statements.slice(0, index);
          if (prelude.some(containsRuntimeEffect)) continue;
          const exits = scope.body.statements
            .slice(index + 1, effectIndex)
            .some((statement) => guardBranchTerminates(statement, guard.variable));
          if (exits) return guard.lane;
        }
      }
    }
    scope = scope.parent;
  }
  return null;
}

function analyzeProcessorWrites(file: string, text: string): ProcessorWriteHit[] {
  const source = ts.createSourceFile(
    file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
  );
  const aliases = collectProcessorAliases(source);
  const hits: ProcessorWriteHit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const primitive = processorPrimitive(node.expression, source, aliases);
      const method = primitive?.split('.').at(-1);
      if (primitive && method && PROCESSOR_MUTATION_METHODS.has(method)) {
        const policy = PROCESSOR_WRITE_POLICY[primitive];
        hits.push({
          file,
          primitive,
          policy,
          dominatingLane: policy?.classification === 'positive'
            ? dominatingGuardLane(node, source)
            : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('new-payment incident guard', () => {
  it('cannot be enabled outside the exact controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'production' })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'invalid',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'development',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_not_a_certification_runtime',
    })).toBe('frozen');
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      HX_PAYMENT_CREATION_MODE: 'enabled',
      STRIPE_MODE: 'live',
      STRIPE_SECRET_KEY: 'sk_live_forbidden',
    })).toBe('frozen');
  });

  it('permits only an explicit controlled Stripe test cohort', () => {
    expect(newPaymentCreationMode({ NODE_ENV: 'test' })).toBe('frozen');
    expect(newPaymentCreationMode({
      ...CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
      HX_PAYMENT_CREATION_MODE: 'frozen',
    }, { isolatedTestRunner: true })).toBe('frozen');
    expect(newPaymentCreationMode(
      CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
      { isolatedTestRunner: true },
    )).toBe('enabled');
  });

  it.each(HOSTILE_PAYMENT_CREATION_ENVIRONMENTS_V7)(
    'keeps $name frozen even inside the isolated test runner',
    ({ env }) => {
      expect(newPaymentCreationMode(env, { isolatedTestRunner: true })).toBe('frozen');
    },
  );

  it.each([
    ['missing database URL', { DATABASE_URL: undefined }],
    ['missing attestation', { HXOS_LOCAL_TEST_DATABASE_ATTESTATION: undefined }],
    ['missing attested database name', { HXOS_LOCAL_TEST_DATABASE_NAME: undefined }],
    ['missing attested database role', { HXOS_LOCAL_TEST_DATABASE_ROLE: undefined }],
    ['non-loopback hostname', {
      DATABASE_URL: 'postgresql://hx_test_unit_guard@localhost.example:5432/hx_unit_test_guard',
    }],
    ['production-like database name', {
      DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/hustlexp',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hustlexp',
    }],
    ['production-like database role', {
      DATABASE_URL: 'postgresql://hx_runtime@127.0.0.1:5432/hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_runtime',
    }],
    ['privileged token hidden inside a test-shaped role', {
      DATABASE_URL: 'postgresql://hx_test_unit_admin@127.0.0.1:5432/hx_unit_test_guard',
      HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_unit_admin',
    }],
    ['production token hidden inside a test-shaped database name', {
      DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/hx_unit_test_production',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'hx_unit_test_production',
    }],
    ['mismatched attested role', { HXOS_LOCAL_TEST_DATABASE_ROLE: 'hx_test_unit_other' }],
    ['ambiguous query-string role', {
      DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/hx_unit_test_guard?user=postgres',
    }],
    ['open-ended disposable database name', {
      DATABASE_URL: 'postgresql://hx_test_unit_guard@127.0.0.1:5432/customer_test',
      HXOS_LOCAL_TEST_DATABASE_NAME: 'customer_test',
    }],
  ] as const)('rejects controlled labels with %s', (_name, override) => {
    expect(newPaymentCreationMode({
      ...CONTROLLED_PAYMENT_CREATION_ENVIRONMENT_V7,
      ...override,
    }, { isolatedTestRunner: true })).toBe('frozen');
  });

  it('cannot be enabled by environment configuration in a normal deployed process', () => {
    expect(newPaymentCreationMode({
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      STRIPE_SECRET_KEY: 'sk_test_misconfigured_deployment',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    }, { isolatedTestRunner: false })).toBe('frozen');
  });

  it('returns one truthful, recovery-oriented failure contract for every new-money lane', () => {
    for (const lane of [
      'escrow_funding',
      'xp_tax',
      'tip',
      'subscription',
      'quote_payment',
      'quote_materialization',
      'settlement_transfer',
      'cash_out_payout',
      'processor_account',
    ] as const) {
      const result = newPaymentCreationFailure(lane, {
        NODE_ENV: 'production',
      });
      expect(result).toEqual({
        success: false,
        error: {
          code: 'PAYMENT_CREATION_FROZEN',
          message: lane === 'processor_account'
            ? 'Processor account creation and mutation are disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No processor account change was made.'
            : lane === 'settlement_transfer' || lane === 'cash_out_payout'
            ? 'New transfer and payout creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new disbursement was created.'
            : 'New customer-money creation is disabled until the processor-neutral lifecycle and written underwriting decisions are certified. No new charge was created.',
          details: {
            lane,
            authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
          },
        },
      });
    }
  });

  it('publishes a non-sensitive runtime status that proves whether new money is accepted', () => {
    expect(newPaymentCreationHealth({ NODE_ENV: 'production' })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
    expect(newPaymentCreationHealth({
      NODE_ENV: 'production',
      HX_PAYMENT_CREATION_MODE: 'enabled',
    })).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });
  });

  it('classifies every processor write and requires a dominating fail-closed guard for positive writes', () => {
    const hits = sourceFiles(resolve(process.cwd(), 'backend/src')).flatMap((file) => (
      analyzeProcessorWrites(relative(process.cwd(), file), readFileSync(file, 'utf8'))
    ));
    expect(
      hits.filter((hit) => !hit.policy),
      'Every detected processor mutation must have a closed policy classification.',
    ).toEqual([]);
    for (const hit of hits) {
      if (hit.policy?.classification !== 'positive') continue;
      expect(
        hit.dominatingLane,
        `${hit.file}:${hit.primitive} lacks an acted-upon guard that dominates all prior effects`,
      ).not.toBeNull();
      expect(
        hit.policy.lanes,
        `${hit.file}:${hit.primitive} used an invalid containment lane`,
      ).toContain(hit.dominatingLane);
    }
    expect(hits.map((hit) => `${hit.file}:${hit.primitive}`).sort()).toEqual([
      'backend/src/routers/subscription.ts:customers.create',
      'backend/src/routers/subscription.ts:products.create',
      'backend/src/routers/subscription.ts:subscriptions.cancel',
      'backend/src/routers/subscription.ts:subscriptions.create',
      'backend/src/services/GDPRService.ts:paymentIntents.cancel',
      'backend/src/services/HustlerWalletProvider.ts:payouts.create',
      'backend/src/services/StripeConnectService.ts:accountLinks.create',
      'backend/src/services/StripeConnectService.ts:accounts.create',
      'backend/src/services/StripeConnectService.ts:accounts.update',
      'backend/src/services/StripePaymentIntentCancellationService.ts:paymentIntents.cancel',
      'backend/src/services/StripeService.ts:paymentIntents.confirm',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:paymentIntents.create',
      'backend/src/services/StripeService.ts:refunds.cancel',
      'backend/src/services/StripeService.ts:refunds.create',
      'backend/src/services/StripeService.ts:transfers.create',
      'backend/src/services/StripeService.ts:transfers.createReversal',
      'backend/src/services/TippingService.ts:paymentIntents.cancel',
      'backend/src/services/TippingService.ts:paymentIntents.create',
      'backend/src/services/payment/StripeQuotePaymentProvider.ts:paymentIntents.cancel',
      'backend/src/services/payment/StripeQuotePaymentProvider.ts:refunds.create',
    ]);

    const finalization = read('backend/src/services/QuotePaymentFinalizationService.ts');
    expect(finalization).toContain("newPaymentCreationFailure('quote_materialization')");
    expect(finalization.indexOf("newPaymentCreationFailure('quote_materialization')"))
      .toBeLessThan(finalization.indexOf('StripeQuotePaymentProvider.verifySucceededPayment'));
    expect(finalization.indexOf("newPaymentCreationFailure('quote_materialization')"))
      .toBeLessThan(finalization.indexOf('await db.transaction'));
  });

  it('rejects ignored, non-dominating, aliased, and newly introduced positive processor writes', () => {
    const cases = [
      `async function ignored() {
         newPaymentCreationFailure('settlement_transfer');
         return stripe.transfers.create({});
       }`,
      `async function sibling(flag: boolean) {
         if (flag) {
           const frozen = newPaymentCreationFailure('settlement_transfer');
           if (frozen) return frozen;
         }
         return stripe.transfers.create({});
       }`,
      `async function collectionAlias() {
         const payouts = stripe.payouts;
         return payouts.create({});
       }`,
      `async function methodAlias() {
         const send = stripe.transfers.create;
         return send({});
       }`,
      `async function computedAccess() {
         return stripe['charges'].create({});
       }`,
      `async function capture() {
         return stripe.paymentIntents.capture('pi_1');
       }`,
      `async function checkout() {
         return stripe.checkout.sessions.create({});
       }`,
    ];
    for (const [index, text] of cases.entries()) {
      const hits = analyzeProcessorWrites(`unsafe-${index}.ts`, text);
      expect(hits, `unsafe fixture ${index} was not detected`).toHaveLength(1);
      expect(hits[0].policy?.classification).toBe('positive');
      expect(hits[0].dominatingLane).toBeNull();
    }

    const safe = analyzeProcessorWrites('safe.ts', `
      async function safe() {
        const frozen = newPaymentCreationFailure('settlement_transfer');
        if (frozen) return frozen;
        return stripe.transfers.create({});
      }
    `);
    expect(safe).toHaveLength(1);
    expect(safe[0]).toMatchObject({
      primitive: 'transfers.create',
      policy: { classification: 'positive' },
      dominatingLane: 'settlement_transfer',
    });

    const unclassified = analyzeProcessorWrites('unknown.ts', `
      async function unknown() {
        return stripe.payouts.update('po_1', {});
      }
    `);
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0].policy).toBeUndefined();
  });

  it('guards asynchronous success materialization and old-payment replay boundaries', () => {
    const stripeWorker = read('backend/src/jobs/stripe-event-worker.ts');
    expect(stripeWorker).toContain('containFrozenPositiveEvent');
    expect(stripeWorker.indexOf('await containFrozenPositiveEvent'))
      .toBeLessThan(stripeWorker.indexOf('await processEntitlementPurchase'));
    expect(stripeWorker.indexOf('await containFrozenPositiveEvent'))
      .toBeLessThan(stripeWorker.indexOf('await fundEscrowForPaymentIntent'));

    const paymentWorker = read('backend/src/jobs/payment-worker.ts');
    expect(paymentWorker).toContain("eventType === 'payment_intent.succeeded'");
    expect(paymentWorker.indexOf("eventType === 'payment_intent.succeeded'"))
      .toBeLessThan(paymentWorker.indexOf('await handlePaymentIntentSucceeded'));

    const xpTax = read('backend/src/services/XPTaxService.ts');
    const mutationGuard = xpTax.indexOf("newPaymentCreationFailure('xp_tax')", xpTax.indexOf('payTax: async'));
    expect(mutationGuard).toBeGreaterThan(0);
    expect(mutationGuard).toBeLessThan(xpTax.indexOf('StripeService.verifyPaymentIntent'));
    expect(mutationGuard).toBeLessThan(
      xpTax.indexOf('db.serializableTransaction', xpTax.indexOf('payTax: async')),
    );

    const localProvider = read('backend/src/services/LocalCertificationPaymentProvider.ts');
    expect(localProvider).toContain('assertDisposableStorage');
    expect(localProvider).toContain("['127.0.0.1', 'localhost', '::1']");
    expect(localProvider).toContain('current_database() AS database_name');
  });
});
