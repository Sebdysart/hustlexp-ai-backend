/**
 * OpenTelemetry SDK Initialization
 *
 * MUST be imported as the very first module in src/index.ts so the SDK
 * patches built-in Node.js modules (http, net, etc.) before any application
 * code loads them.
 *
 * Failure safety: every SDK call is wrapped in try/catch.  A telemetry
 * outage must NEVER crash the application server.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ConsoleSpanExporter, NoopSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { trace } from '@opentelemetry/api';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Package metadata — resolved at runtime from package.json
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf-8')) as { version: string };

const SERVICE_NAME = env.SERVICE_NAME || 'hustlexp-ai-backend';
const SERVICE_VERSION = pkg.version;

// ---------------------------------------------------------------------------
// Choose exporter:
//   1. OTLP when endpoint is configured
//   2. ConsoleSpanExporter in development / test (helpful for local debugging)
//   3. No-op in production with no OTLP endpoint (avoids flooding stdout)
// ---------------------------------------------------------------------------

function buildExporter(): ConsoleSpanExporter | OTLPTraceExporter | null {
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    return new OTLPTraceExporter({ url: endpoint });
  }
  if (process.env.NODE_ENV !== 'production') {
    return new ConsoleSpanExporter();
  }
  // Production with no OTLP endpoint: return null to signal no-op
  return null;
}

// ---------------------------------------------------------------------------
// SDK initialization — wrapped entirely in try/catch
// ---------------------------------------------------------------------------

let sdk: NodeSDK | null = null;

try {
  const exporter = buildExporter();
  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    // When no exporter is configured (production, no OTLP), use a no-op
    // processor so spans are silently dropped instead of flooding stdout.
    ...(exporter ? { traceExporter: exporter } : { spanProcessor: new NoopSpanProcessor() }),
    instrumentations: [
      new HttpInstrumentation(),
      // PgInstrumentation auto-instruments the native `pg` driver.
      // postgres.js (used via the `sql` tagged-template in src/db) does NOT
      // use native pg under the hood, so auto-instrumentation will not fire
      // for those queries.  Manual tracing via dbTracer.ts covers that gap.
      new PgInstrumentation(),
    ],
  });

  sdk.start();
} catch (err) {
  // Telemetry failure must NOT crash the server
  console.warn('[otel] SDK initialization failed — tracing disabled:', err);
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

process.on('SIGTERM', () => {
  if (sdk) {
    sdk.shutdown().catch((err) => {
      console.warn('[otel] SDK shutdown error:', err);
    });
  }
});

// ---------------------------------------------------------------------------
// Exported tracer — used by fastifyPlugin, dbTracer, and ai/router
// ---------------------------------------------------------------------------

export const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
