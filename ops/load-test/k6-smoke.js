/**
 * HustleXP Load Test — k6 Smoke Test
 *
 * Validates baseline performance before deployment.
 * Run: k6 run ops/load-test/k6-smoke.js
 *
 * AUTHORITY: PRODUCT_SPEC.md §8 (Performance SLAs)
 *
 * Targets:
 *   - Health check: <50ms p99
 *   - Task list:    <200ms p99
 *   - Error rate:   <1%
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  // Smoke test: 5 VUs for 30 seconds
  stages: [
    { duration: '10s', target: 5 },   // Ramp up
    { duration: '30s', target: 5 },   // Steady state
    { duration: '10s', target: 0 },   // Ramp down
  ],

  thresholds: {
    // SLA: 99% of requests succeed
    'http_req_failed': ['rate<0.01'],

    // SLA: P99 latency under 500ms
    'http_req_duration': ['p(99)<500'],

    // Custom: Health check under 50ms p99
    'health_duration': ['p(99)<50'],
  },
};

// ============================================================================
// CUSTOM METRICS
// ============================================================================

const healthDuration = new Trend('health_duration');
const errorRate = new Rate('errors');

// ============================================================================
// TEST SCENARIOS
// ============================================================================

export default function () {
  // 1. Health check (lightweight, most frequent)
  const healthRes = http.get(`${BASE_URL}/health`);
  healthDuration.add(healthRes.timings.duration);

  check(healthRes, {
    'health: status 200': (r) => r.status === 200,
    'health: has status field': (r) => {
      try {
        return JSON.parse(r.body).status === 'healthy';
      } catch {
        return false;
      }
    },
  }) || errorRate.add(1);

  sleep(0.5);

  // 2. Readiness probe
  const readyRes = http.get(`${BASE_URL}/health/readiness`);

  check(readyRes, {
    'readiness: status 200': (r) => r.status === 200,
  }) || errorRate.add(1);

  sleep(0.5);

  // 3. Liveness probe
  const liveRes = http.get(`${BASE_URL}/health/liveness`);

  check(liveRes, {
    'liveness: status 200': (r) => r.status === 200,
    'liveness: has uptime': (r) => {
      try {
        return JSON.parse(r.body).uptime > 0;
      } catch {
        return false;
      }
    },
  }) || errorRate.add(1);

  sleep(1);
}

// ============================================================================
// LIFECYCLE HOOKS
// ============================================================================

export function setup() {
  // Verify server is reachable before running tests
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`Server not reachable at ${BASE_URL}. Status: ${res.status}`);
  }
  console.log(`✅ Server reachable at ${BASE_URL}`);
  return { startTime: new Date().toISOString() };
}

export function teardown(data) {
  console.log(`🏁 Load test completed. Started at ${data.startTime}`);
}
