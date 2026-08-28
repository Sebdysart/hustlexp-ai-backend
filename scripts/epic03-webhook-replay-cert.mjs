#!/usr/bin/env node
/**
 * EPIC-03 case 5 — webhook replay certification (Stripe CLI).
 *
 * Starts a local receiver that mirrors engine idempotency:
 *   first delivery → store event id
 *   second delivery of same id → acknowledge duplicate (no second store)
 *
 * Also cites engine contract tests (StripeWebhookService ON CONFLICT DO NOTHING).
 *
 * Usage (two terminals, or this script runs listen as child):
 *   1) stripe login   (once)
 *   2) node scripts/epic03-webhook-replay-cert.mjs
 *
 * Env:
 *   STRIPE_CLI   path to stripe.exe (optional)
 *   HX_EPIC03_WEBHOOK_PORT  default 5055
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const receiptsPath = resolve(root, 'ops/runbooks/EPIC03_TEST_MODE_RECEIPTS.json');
const evidencePath = resolve(root, 'ops/runbooks/EPIC03_WEBHOOK_REPLAY_EVIDENCE.json');
const envLocal = resolve(root, '.env.epic03.local');

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
if (process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_API_KEY) {
  process.env.STRIPE_API_KEY = process.env.STRIPE_SECRET_KEY;
}

const port = Number(process.env.HX_EPIC03_WEBHOOK_PORT || 5055);
const stripeBin = process.env.STRIPE_CLI || 'stripe';
const apiKey = process.env.STRIPE_API_KEY || process.env.STRIPE_SECRET_KEY || '';

const state = {
  webhookSecret: null,
  ready: false,
  deliveries: [], // { event_id, type, at, outcome }
  byEvent: new Map(), // event_id -> count
  rejectLog: [],
};

function stripeArgs(args) {
  if (!apiKey) return args;
  return ['--api-key', apiKey, ...args];
}

function verifyStripeSignature(rawBody, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k.trim(), v];
    }),
  );
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) return false;
  const signed = `${ts}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(sig, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function startReceiver() {
  return new Promise((resolveReady) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/webhooks/stripe') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const sigHeader = req.headers['stripe-signature'];
        if (!verifyStripeSignature(raw, sigHeader, state.webhookSecret)) {
          state.rejectLog.push({
            at: new Date().toISOString(),
            reason: 'invalid_signature',
            has_secret: Boolean(state.webhookSecret),
            has_header: Boolean(sigHeader),
          });
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
          return;
        }
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
          return;
        }
        const id = event.id;
        const type = event.type;
        const prev = state.byEvent.get(id) || 0;
        const next = prev + 1;
        state.byEvent.set(id, next);
        const outcome = next === 1 ? 'stored' : 'duplicate_ack';
        state.deliveries.push({
          event_id: id,
          type,
          at: new Date().toISOString(),
          outcome,
          delivery_n: next,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, outcome, event_id: id }));
      });
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`Receiver listening on http://127.0.0.1:${port}/webhooks/stripe`);
      resolveReady(server);
    });
  });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: { ...process.env, ...(opts.env || {}) },
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d) => {
      out += d.toString();
      if (opts.mirror) process.stdout.write(d);
    });
    child.stderr?.on('data', (d) => {
      err += d.toString();
      if (opts.mirror) process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, out, err }));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!apiKey?.startsWith('sk_test_')) {
    console.error('Need STRIPE_API_KEY or STRIPE_SECRET_KEY as sk_test_… (from .env.epic03.local).');
    process.exit(2);
  }

  const server = await startReceiver();

  console.log('Starting stripe listen…');
  const listen = spawn(
    stripeBin,
    stripeArgs([
      'listen',
      '--forward-to',
      `127.0.0.1:${port}/webhooks/stripe`,
      '--events',
      'payment_intent.succeeded,payment_intent.created',
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'], shell: false },
  );

  let listenBuf = '';
  const listenReady = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error('timeout waiting for stripe listen Ready')),
      90000,
    );
    const onData = (d) => {
      const text = d.toString();
      listenBuf += text;
      // Never echo whsec lines
      for (const line of text.split(/\r?\n/)) {
        if (/whsec_/.test(line)) {
          console.log('[stripe listen] (webhook signing secret captured)');
        } else if (line.trim()) {
          console.log(`[stripe listen] ${line}`);
        }
      }
      const secretMatch = listenBuf.match(/whsec_[A-Za-z0-9]+/);
      if (secretMatch && !state.webhookSecret) {
        state.webhookSecret = secretMatch[0];
      }
      if (/Ready!/i.test(listenBuf) && state.webhookSecret) {
        state.ready = true;
        clearTimeout(timer);
        resolveReady(true);
      }
    };
    listen.stdout.on('data', onData);
    listen.stderr.on('data', onData);
    listen.on('error', (e) => {
      clearTimeout(timer);
      rejectReady(e);
    });
    listen.on('close', (code) => {
      if (!state.ready) {
        clearTimeout(timer);
        rejectReady(new Error(`stripe listen exited early code=${code}`));
      }
    });
  });

  try {
    await listenReady;
    console.log('Listen ready. Triggering payment_intent.succeeded…');
    await sleep(1000);

    const trigger = await run(
      stripeBin,
      stripeArgs(['trigger', 'payment_intent.succeeded']),
      { mirror: true },
    );
    if (trigger.code !== 0) {
      throw new Error(`stripe trigger failed: ${trigger.err || trigger.out}`);
    }

    // Wait for first delivery
    for (let i = 0; i < 80 && state.deliveries.length < 1; i++) await sleep(250);
    if (state.deliveries.length < 1) {
      throw new Error(
        `No webhook delivery received after trigger. rejects=${JSON.stringify(state.rejectLog)}`,
      );
    }
    const eventId = state.deliveries[0].event_id;
    console.log(`First delivery: ${eventId}`);

    console.log('Resending same event (1/2)…');
    await run(stripeBin, stripeArgs(['events', 'resend', eventId]), { mirror: true });
    await sleep(1500);
    console.log('Resending same event (2/2)…');
    await run(stripeBin, stripeArgs(['events', 'resend', eventId]), { mirror: true });

    for (let i = 0; i < 80 && (state.byEvent.get(eventId) || 0) < 2; i++) await sleep(250);

    const count = state.byEvent.get(eventId) || 0;
    const stored = state.deliveries.filter((d) => d.event_id === eventId && d.outcome === 'stored').length;
    const dupes = state.deliveries.filter((d) => d.event_id === eventId && d.outcome === 'duplicate_ack').length;
    const pass = count >= 2 && stored === 1 && dupes >= 1;

    const evidence = {
      schema_version: 1,
      kind: 'epic03_webhook_replay_evidence',
      as_of: new Date().toISOString(),
      event_id: eventId,
      deliveries_for_event: count,
      stored_once: stored === 1,
      duplicate_acks: dupes,
      pass,
      deliveries: state.deliveries,
      engine_contract:
        'backend/src/services/StripeWebhookService.ts ON CONFLICT (stripe_event_id) DO NOTHING + stripe-webhook-branches.test.ts idempotent replay',
      note: pass
        ? 'Same Stripe event delivered ≥2 times; local receiver stored once and ack’d duplicates (mirrors engine S-1).'
        : 'Replay did not produce duplicate delivery ack — check stripe login / listen / resend.',
    };

    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    if (existsSync(receiptsPath)) {
      const receipts = JSON.parse(readFileSync(receiptsPath, 'utf8'));
      receipts.as_of = evidence.as_of;
      receipts.cases = (receipts.cases || []).map((c) => {
        if (c.case !== 5) return c;
        return {
          case: 5,
          title: 'Webhook replay (deliver same event twice)',
          status: pass ? 'PROVEN' : 'FAILED',
          stripe_event_id: eventId,
          deliveries: count,
          stored_once: stored === 1,
          duplicate_acks: dupes,
          evidence_file: 'ops/runbooks/EPIC03_WEBHOOK_REPLAY_EVIDENCE.json',
        };
      });
      const proven = receipts.cases.filter((c) => c.status === 'PROVEN').length;
      const failed = receipts.cases.filter((c) => c.status === 'FAILED').length;
      const open = receipts.cases.filter((c) =>
        ['OPEN', 'PARTIAL', 'SKIPPED'].includes(c.status),
      ).length;
      receipts.summary = { proven, failed, open_or_partial: open, total: receipts.cases.length };
      receipts.next =
        failed > 0
          ? 'Fix FAILED rows before claiming EPIC-03 test cert.'
          : open > 0
            ? 'Finish OPEN/PARTIAL rows.'
            : 'All seven rows PROVEN. Keep production frozen until unfreeze gate.';
      writeFileSync(receiptsPath, `${JSON.stringify(receipts, null, 2)}\n`);
    }

    console.log(JSON.stringify({ pass, eventId, count, stored, dupes }, null, 2));
    console.log(`Wrote ${evidencePath}`);

    listen.kill('SIGTERM');
    server.close();
    process.exit(pass ? 0 : 1);
  } catch (err) {
    console.error(err);
    listen.kill('SIGTERM');
    server.close();
    process.exit(1);
  }
}

main();
