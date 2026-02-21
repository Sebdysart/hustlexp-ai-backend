/**
 * HustleXP Load Test — k6 Stress Test
 *
 * Tests system behavior under increasing load to find breaking points.
 * Run: k6 run ops/load-test/k6-stress.js
 *
 * AUTHORITY: PRODUCT_SPEC.md §8 (Performance SLAs)
 *
 * This test ramps from 0 → 50 → 100 VUs to identify:
 *   - Connection pool exhaustion threshold
 *   - Memory/CPU bottlenecks
 *   - Rate limiter behavior under load
 *   - Error rate degradation curve
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

// ============================================================================
// CONFIGURATION
// ============================================================================

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  stages: [
    { duration: '1m', target: 10 },   // Warm-up
    { duration: '2m', target: 50 },   // Normal load
    { duration: '2m', target: 100 },  // Stress load
    { duration: '1m', target: 100 },  // Sustained stress
    { duration: '2m', target: 0 },    // Recovery
  ],

  thresholds: {
    // Under stress, we allow slightly degraded performance
    'http_req_failed': ['rate<0.05'],       // 5% error budget
    'http_req_duration': ['p(95)<1000'],     // p95 under 1s
    'rate_limited': ['count<100'],           // Max 100 rate limits
  },
};

// ============================================================================
// CUSTOM METRICS
// ============================================================================

const rateLimited = new Counter('rate_limited');
const healthDuration = new Trend('health_duration');
const errorRate = new Rate('errors');

// ============================================================================
// TEST SCENARIOS
// ============================================================================

export default function () {
  const scenario = Math.random();

  if (scenario < 0.5) {
    // 50%: Health checks (simulates monitoring)
    const res = http.get(`${BASE_URL}/health`);
    healthDuration.add(res.timings.duration);

    check(res, {
      'health: 200': (r) => r.status === 200,
    }) || errorRate.add(1);

    if (res.status === 429) {
      rateLimited.add(1);
    }

  } else if (scenario < 0.8) {
    // 30%: Readiness probe (simulates k8s)
    const res = http.get(`${BASE_URL}/health/readiness`);

    check(res, {
      'readiness: 200': (r) => r.status === 200,
    }) || errorRate.add(1);

  } else {
    // 20%: Detailed health (expensive query)
    const res = http.get(`${BASE_URL}/health/detailed`);

    check(res, {
      'detailed: 200 or 503': (r) => r.status === 200 || r.status === 503,
    }) || errorRate.add(1);
  }

  sleep(0.2 + Math.random() * 0.3); // 200-500ms between requests
}

export function setup() {
  const res = http.get(`${BASE_URL}/health`);
  if (res.status !== 200) {
    throw new Error(`Server not reachable at ${BASE_URL}`);
  }
  console.log(`✅ Stress test starting against ${BASE_URL}`);
  return {};
}
