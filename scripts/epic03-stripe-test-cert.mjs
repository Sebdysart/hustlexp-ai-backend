#!/usr/bin/env node
/**
 * EPIC-03 Stripe **Test mode** certification runner.
 *
 * Rules:
 * - Never uses sk_live_ (hard reject).
 * - Never prints secret keys.
 * - Does not change production HX_PAYMENT_CREATION_MODE.
 * - Writes receipt IDs only to ops/runbooks/EPIC03_TEST_MODE_RECEIPTS.json
 *
 * Usage:
 *   set STRIPE_SECRET_KEY=sk_test_...   (or .env.epic03.local)
 *   node scripts/epic03-stripe-test-cert.mjs
 *
 * Optional:
 *   HX_PROD_HEALTH_URL=https://hustlexp-ai-backend-production.up.railway.app/health
 *   HX_EPIC03_SKIP_CONNECT=1   # skip Connect account + transfer attempt
 *   HX_EPIC03_CONNECT_ACCOUNT_ID=acct_...  # reuse an already-onboarded Express test account
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outPath = resolve(root, 'ops/runbooks/EPIC03_TEST_MODE_RECEIPTS.json');
const envLocal = resolve(root, '.env.epic03.local');

const PROD_HEALTH =
  process.env.HX_PROD_HEALTH_URL ||
  'https://hustlexp-ai-backend-production.up.railway.app/health';

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(envLocal);

function maskKey(key) {
  if (!key) return 'unset';
  if (key.startsWith('sk_test_')) return `sk_test_…${key.slice(-4)}`;
  if (key.startsWith('sk_live_')) return 'sk_live_***';
  return 'unknown_prefix';
}

async function stripe(path, { method = 'GET', form, idempotencyKey } = {}) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  const headers = {
    Authorization: `Bearer ${key}`,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`https://api.stripe.com${path}`, { method, headers, body });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

function formFrom(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === 'object') {
          Object.assign(out, formFrom(item, `${key}[${i}]`));
        } else if (item !== undefined) {
          out[`${key}[${i}]`] = String(item);
        }
      });
    } else if (v !== null && typeof v === 'object') {
      Object.assign(out, formFrom(v, key));
    } else if (v !== undefined) {
      out[key] = String(v);
    }
  }
  return out;
}

async function probeProdFreeze() {
  const res = await fetch(PROD_HEALTH, { signal: AbortSignal.timeout(20000) });
  const json = await res.json();
  const mode = json?.paymentCreation?.mode;
  const accepts = json?.paymentCreation?.acceptsNewCustomerMoney;
  return {
    name: 'kill_switch_prod_health',
    pass: mode === 'frozen' && accepts === false,
    paymentCreation: json?.paymentCreation ?? null,
    engine_revision: json?.build?.revision ?? null,
    timestamp: json?.timestamp ?? null,
  };
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key) {
    console.error(
      'Missing STRIPE_SECRET_KEY. Create .env.epic03.local with sk_test_… (gitignored) and retry.',
    );
    process.exit(2);
  }
  if (key.startsWith('sk_live_')) {
    console.error('Refusing sk_live_. EPIC-03 cert must use Stripe Test mode (sk_test_).');
    process.exit(2);
  }
  if (!key.startsWith('sk_test_')) {
    console.error(`Refusing non-test key (${maskKey(key)}). Need sk_test_.`);
    process.exit(2);
  }

  const cases = [];
  const stamp = new Date().toISOString();
  const tag = `epic03_${stamp.replace(/[:.]/g, '').slice(0, 15)}`;

  console.log(`EPIC-03 test cert starting (${stamp}) key=${maskKey(key)}`);

  // Case 7 first — never skip freeze proof
  const freeze = await probeProdFreeze();
  cases.push({
    case: 7,
    title: 'Kill switch: prod still frozen',
    status: freeze.pass ? 'PROVEN' : 'FAILED',
    evidence: freeze,
  });
  console.log(`  [7] freeze: ${freeze.pass ? 'PROVEN' : 'FAILED'}`);

  // Case 1 — Authorization / PaymentIntent create (manual capture)
  const create = await stripe('/v1/payment_intents', {
    method: 'POST',
    idempotencyKey: `${tag}_auth`,
    form: formFrom({
      amount: 500,
      currency: 'usd',
      capture_method: 'manual',
      'payment_method_types[]': 'card',
      metadata: { hustlexp_epic: '03', hustlexp_case: '1_auth' },
      description: 'HustleXP EPIC-03 test authorization',
    }),
  });
  const piId = create.json?.id || null;
  cases.push({
    case: 1,
    title: 'Authorization / PaymentIntent create',
    status: create.ok && piId ? 'PROVEN' : 'FAILED',
    stripe_id: piId,
    stripe_status: create.json?.status ?? null,
    http_status: create.status,
    error: create.ok ? null : create.json?.error?.message || 'create_failed',
  });
  console.log(`  [1] auth create: ${cases.at(-1).status} ${piId || ''}`);

  // Case 6 — Decline (separate PI)
  const decline = await stripe('/v1/payment_intents', {
    method: 'POST',
    idempotencyKey: `${tag}_decline`,
    form: formFrom({
      amount: 150,
      currency: 'usd',
      confirm: 'true',
      payment_method: 'pm_card_chargeDeclined',
      'payment_method_types[]': 'card',
      metadata: { hustlexp_epic: '03', hustlexp_case: '6_decline' },
    }),
  });
  const declinePi =
    decline.json?.id || decline.json?.error?.payment_intent?.id || null;
  const declineExpected =
    Boolean(decline.json?.error) ||
    Boolean(decline.json?.last_payment_error) ||
    decline.json?.status === 'requires_payment_method';
  cases.push({
    case: 6,
    title: 'Card decline / failure',
    status: declineExpected ? 'PROVEN' : 'FAILED',
    stripe_id: declinePi,
    stripe_status: decline.json?.status ?? decline.json?.error?.payment_intent?.status ?? null,
    error_code: decline.json?.error?.code || decline.json?.last_payment_error?.code || null,
    http_status: decline.status,
  });
  console.log(`  [6] decline: ${cases.at(-1).status}`);

  // Case 2 — Confirm + capture success
  let captureStatus = 'SKIPPED';
  let chargeId = null;
  if (piId) {
    const confirm = await stripe(`/v1/payment_intents/${piId}/confirm`, {
      method: 'POST',
      form: formFrom({
        payment_method: 'pm_card_visa',
      }),
    });
    const confirmOk = confirm.ok && confirm.json?.status === 'requires_capture';
    const capture = await stripe(`/v1/payment_intents/${piId}/capture`, {
      method: 'POST',
      idempotencyKey: `${tag}_capture`,
    });
    captureStatus = capture.ok && capture.json?.status === 'succeeded' ? 'PROVEN' : 'FAILED';
    chargeId =
      typeof capture.json?.latest_charge === 'string' ? capture.json.latest_charge : null;
    cases.push({
      case: 2,
      title: 'Confirm / capture success',
      status: confirmOk && captureStatus === 'PROVEN' ? 'PROVEN' : 'FAILED',
      payment_intent: piId,
      confirm_status: confirm.json?.status ?? null,
      capture_status: capture.json?.status ?? null,
      charge_id: chargeId,
      error:
        confirmOk && captureStatus === 'PROVEN'
          ? null
          : confirm.json?.error?.message || capture.json?.error?.message || 'confirm_or_capture_failed',
    });
  } else {
    cases.push({
      case: 2,
      title: 'Confirm / capture success',
      status: 'FAILED',
      error: 'no_payment_intent_from_case_1',
    });
  }
  console.log(`  [2] confirm/capture: ${cases.at(-1).status}`);

  // Case 4 — Connect Express account + destination-charge path (before refund)
  let connectCase = {
    case: 4,
    title: 'Connect / payout path (test)',
    status: 'OPEN',
    note: null,
  };
  if (process.env.HX_EPIC03_SKIP_CONNECT === '1') {
    connectCase.status = 'SKIPPED';
    connectCase.note = 'HX_EPIC03_SKIP_CONNECT=1';
  } else {
    const reuseAcct = (process.env.HX_EPIC03_CONNECT_ACCOUNT_ID || '').trim();
    let acctId = null;
    if (reuseAcct.startsWith('acct_')) {
      const existing = await stripe(`/v1/accounts/${reuseAcct}`);
      if (!existing.ok) {
        connectCase.status = 'FAILED';
        connectCase.error = existing.json?.error?.message || 'reuse_connect_account_failed';
        connectCase.http_status = existing.status;
      } else if (existing.json?.capabilities?.transfers !== 'active') {
        connectCase.status = 'PARTIAL';
        connectCase.connect_account_id = reuseAcct;
        connectCase.note = `HX_EPIC03_CONNECT_ACCOUNT_ID transfers=${existing.json?.capabilities?.transfers || 'unknown'}; finish Express onboarding then re-run.`;
      } else {
        acctId = reuseAcct;
      }
    } else {
      const acct = await stripe('/v1/accounts', {
        method: 'POST',
        idempotencyKey: `${tag}_connect`,
        form: formFrom({
          type: 'express',
          country: 'US',
          capabilities: {
            transfers: { requested: 'true' },
            card_payments: { requested: 'true' },
          },
          business_type: 'individual',
          email: 'epic03-connect@hustlexp.app',
          metadata: { hustlexp_epic: '03', hustlexp_case: '4_connect' },
        }),
      });
      acctId = acct.json?.id || null;
      if (!acct.ok || !acctId) {
        connectCase.status = 'FAILED';
        connectCase.error = acct.json?.error?.message || 'connect_account_create_failed';
        connectCase.http_status = acct.status;
        connectCase.note =
          'Open Stripe Test Dashboard → Settings → Connect → complete platform profile, then re-run.';
      }
    }
    if (acctId) {
      // Destination charge proves Connect money path without waiting on Express onboarding UI.
      const destPi = await stripe('/v1/payment_intents', {
        method: 'POST',
        idempotencyKey: `${tag}_dest_pi`,
        form: formFrom({
          amount: 300,
          currency: 'usd',
          confirm: 'true',
          payment_method: 'pm_card_visa',
          'payment_method_types[]': 'card',
          application_fee_amount: 50,
          transfer_data: { destination: acctId },
          metadata: { hustlexp_epic: '03', hustlexp_case: '4_destination' },
        }),
      });
      if (destPi.ok && destPi.json?.status === 'succeeded') {
        connectCase = {
          case: 4,
          title: 'Connect / payout path (test)',
          status: 'PROVEN',
          connect_account_id: acctId,
          destination_payment_intent: destPi.json.id,
          destination_charge:
            typeof destPi.json.latest_charge === 'string' ? destPi.json.latest_charge : null,
        };
      } else {
        const transferForm = {
          amount: 100,
          currency: 'usd',
          destination: acctId,
          metadata: { hustlexp_epic: '03', hustlexp_case: '4_transfer' },
        };
        if (chargeId) transferForm.source_transaction = chargeId;
        const transfer = await stripe('/v1/transfers', {
          method: 'POST',
          idempotencyKey: `${tag}_transfer`,
          form: formFrom(transferForm),
        });
        if (transfer.ok && transfer.json?.id) {
          connectCase = {
            case: 4,
            title: 'Connect / payout path (test)',
            status: 'PROVEN',
            connect_account_id: acctId,
            transfer_id: transfer.json.id,
            transfer_status: transfer.json.status ?? null,
            source_transaction: chargeId,
          };
        } else {
          connectCase = {
            case: 4,
            title: 'Connect / payout path (test)',
            status: 'PARTIAL',
            connect_account_id: acctId,
            destination_error: destPi.json?.error?.message || null,
            transfer_error: transfer.json?.error?.message || null,
            note:
              'Express account created. Enable transfers (complete Connect platform profile + test onboarding) or finish via /ops execute_test_payout, then re-run.',
          };
        }
      }
    }
  }
  cases.push(connectCase);
  console.log(`  [4] connect/payout: ${connectCase.status}`);

  // Case 3 — Refund remaining after transfer attempt (partial refund OK)
  if (piId && captureStatus === 'PROVEN') {
    const refund = await stripe('/v1/refunds', {
      method: 'POST',
      idempotencyKey: `${tag}_refund`,
      form: formFrom({
        payment_intent: piId,
        metadata: { hustlexp_epic: '03', hustlexp_case: '3_refund' },
      }),
    });
    cases.push({
      case: 3,
      title: 'Customer refund',
      status: refund.ok && refund.json?.id ? 'PROVEN' : 'FAILED',
      stripe_id: refund.json?.id ?? null,
      stripe_status: refund.json?.status ?? null,
      payment_intent: piId,
      error: refund.ok ? null : refund.json?.error?.message || 'refund_failed',
    });
  } else {
    cases.push({
      case: 3,
      title: 'Customer refund',
      status: 'FAILED',
      error: 'capture_not_proven',
    });
  }
  console.log(`  [3] refund: ${cases.at(-1).status}`);

  // Case 5 — Webhook replay cannot be fully proven via REST alone
  cases.push({
    case: 5,
    title: 'Webhook replay (deliver same event twice)',
    status: 'OPEN',
    note:
      'Requires Stripe CLI (`stripe listen` + `stripe events resend <id>` twice) against engine webhook, then scripts/step1-check-results.ts. See EPIC03_TEST_MODE_CERT_STEPS.md.',
  });
  console.log('  [5] webhook replay: OPEN (CLI required)');

  const proven = cases.filter((c) => c.status === 'PROVEN').length;
  const failed = cases.filter((c) => c.status === 'FAILED').length;
  const open = cases.filter((c) => c.status === 'OPEN' || c.status === 'PARTIAL' || c.status === 'SKIPPED').length;

  const report = {
    schema_version: 1,
    kind: 'epic03_stripe_test_mode_receipts',
    as_of: stamp,
    key_mode: 'sk_test',
    key_fingerprint: maskKey(key),
    production_unfreeze: false,
    summary: { proven, failed, open_or_partial: open, total: cases.length },
    cases: cases.sort((a, b) => a.case - b.case),
    next:
      failed > 0
        ? 'Fix FAILED rows before claiming EPIC-03 test cert.'
        : open > 0
          ? 'Finish OPEN/PARTIAL rows (webhook replay + Connect transfer if needed).'
          : 'All seven rows PROVEN. Keep production frozen until unfreeze gate.',
  };

  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(JSON.stringify(report.summary, null, 2));

  if (failed > 0 || !freeze.pass) process.exit(1);
  if (open > 0) process.exit(3); // partial progress
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
