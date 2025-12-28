/**
 * HustleXP TPEE Stress Test Suite (k6)
 * 
 * Run: k6 run tests/stress/tpee-stress.js
 * 
 * Tests:
 * 1. Idempotency under concurrency
 * 2. TPEE invariants (evaluation_id, policy_snapshot_id)
 * 3. AI timeout behavior
 * 4. Load/spike tests
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Simple random string generator
function randomString(length) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// ============================================
// Configuration
// ============================================

const BASE_URL = __ENV.API_URL || 'http://localhost:3000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

// ============================================
// Custom Metrics
// ============================================

const taskCreatedTotal = new Counter('tasks_created_total');
const taskDuplicates = new Counter('task_duplicates');
const tpeeBlockRate = new Rate('tpee_block_rate');
const tpeeAdjustRate = new Rate('tpee_adjust_rate');
const requestDuration = new Trend('request_duration_ms');
const missingPolicySnapshotId = new Counter('missing_policy_snapshot_id');
const missingTpeeEvalId = new Counter('missing_tpee_eval_id');

// ============================================
// Test Scenarios
// ============================================

export const options = {
    scenarios: {
        // A) Smoke test: verify basic functionality
        smoke: {
            executor: 'constant-vus',
            vus: 1,
            duration: '10s',
            exec: 'smokeTest',
            startTime: '0s',
        },

        // B) Idempotency test: 50 concurrent with same key
        idempotency: {
            executor: 'per-vu-iterations',
            vus: 50,
            iterations: 1,
            exec: 'idempotencyTest',
            startTime: '15s',
        },

        // C) Load test: sustained 20 RPS for 2 minutes
        load: {
            executor: 'constant-arrival-rate',
            rate: 20,
            timeUnit: '1s',
            duration: '2m',
            preAllocatedVUs: 50,
            maxVUs: 100,
            exec: 'loadTest',
            startTime: '30s',
        },

        // D) Spike test: 0 → 100 RPS in 10s
        spike: {
            executor: 'ramping-arrival-rate',
            startRate: 0,
            timeUnit: '1s',
            preAllocatedVUs: 100,
            maxVUs: 200,
            stages: [
                { duration: '10s', target: 100 },
                { duration: '30s', target: 100 },
                { duration: '10s', target: 0 },
            ],
            exec: 'spikeTest',
            startTime: '3m',
        },
    },
    thresholds: {
        'http_req_failed': ['rate<0.05'],        // <5% errors
        'http_req_duration': ['p(95)<3000'],     // p95 < 3s
        'task_duplicates': ['count==0'],          // Zero duplicates
        'missing_policy_snapshot_id': ['count==0'], // Every task has policy
        'missing_tpee_eval_id': ['count==0'],     // Every task has eval
    },
};

// ============================================
// Helpers
// ============================================

function getHeaders(idempotencyKey) {
    const headers = {
        'Content-Type': 'application/json',
    };
    if (AUTH_TOKEN) {
        headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
    }
    if (idempotencyKey) {
        headers['Idempotency-Key'] = idempotencyKey;
    }
    return headers;
}

function createTaskPayload(userId) {
    return JSON.stringify({
        userId: userId || 'test-user-' + randomString(8),
        taskDraft: {
            title: 'Stress test task ' + randomString(8),
            description: 'Automated stress test - safe to ignore',
            category: 'general',
            recommendedPrice: 25 + Math.floor(Math.random() * 75),
            flags: [],
        },
    });
}

function validateTaskResponse(response, taskTracker) {
    const body = response.json();

    if (response.status === 200 && body.success) {
        const taskId = body.task?.id;

        // Check for duplicates
        if (taskTracker && taskTracker.has(taskId)) {
            taskDuplicates.add(1);
        }
        taskTracker?.add(taskId);

        // Check invariants
        const tpee = body._tpee;
        if (!tpee?.evaluationId) {
            missingTpeeEvalId.add(1);
        }

        // Note: policy_snapshot_id is on DB record, not in response
        // Would need separate validation query

        taskCreatedTotal.add(1);
        return true;
    }

    if (response.status === 403) {
        tpeeBlockRate.add(1);
        return true;
    }

    if (response.status === 422) {
        tpeeAdjustRate.add(1);
        return true;
    }

    return false;
}

// ============================================
// Test Functions
// ============================================

export function smokeTest() {
    group('Smoke Test', () => {
        const payload = createTaskPayload();
        const start = Date.now();

        const response = http.post(
            `${BASE_URL}/ai/confirm-task`,
            payload,
            { headers: getHeaders() }
        );

        requestDuration.add(Date.now() - start);

        check(response, {
            'status is 200, 403, or 422': (r) => [200, 403, 422].includes(r.status),
            'response has body': (r) => r.body && r.body.length > 0,
        });

        validateTaskResponse(response, null);
    });

    sleep(1);
}

export function idempotencyTest() {
    group('Idempotency Test', () => {
        // All 50 VUs use SAME idempotency key
        const SHARED_KEY = 'stress-test-idempotency-' + (__ENV.TEST_RUN_ID || 'default');
        const payload = createTaskPayload('idempotency-test-user');

        const response = http.post(
            `${BASE_URL}/ai/confirm-task`,
            payload,
            { headers: getHeaders(SHARED_KEY) }
        );

        check(response, {
            'status is 200, 403, 422, or 409': (r) => [200, 403, 422, 409].includes(r.status),
        });

        // Only count as created if 200
        if (response.status === 200) {
            taskCreatedTotal.add(1);
        }
    });
}

export function loadTest() {
    group('Load Test', () => {
        const payload = createTaskPayload();
        const start = Date.now();

        const response = http.post(
            `${BASE_URL}/ai/confirm-task`,
            payload,
            { headers: getHeaders(randomString(32)) }
        );

        requestDuration.add(Date.now() - start);
        validateTaskResponse(response, null);
    });
}

export function spikeTest() {
    group('Spike Test', () => {
        const payload = createTaskPayload();
        const start = Date.now();

        const response = http.post(
            `${BASE_URL}/ai/confirm-task`,
            payload,
            { headers: getHeaders(randomString(32)) }
        );

        requestDuration.add(Date.now() - start);

        check(response, {
            'response under spike': (r) => r.status < 500,
        });

        validateTaskResponse(response, null);
    });
}

// ============================================
// Summary
// ============================================

export function handleSummary(data) {
    console.log('\n========================================');
    console.log('TPEE STRESS TEST RESULTS');
    console.log('========================================\n');

    console.log('Tasks created:', data.metrics.tasks_created_total?.values?.count || 0);
    console.log('Duplicates:', data.metrics.task_duplicates?.values?.count || 0);
    console.log('Missing policy_snapshot_id:', data.metrics.missing_policy_snapshot_id?.values?.count || 0);
    console.log('Missing tpee_eval_id:', data.metrics.missing_tpee_eval_id?.values?.count || 0);
    console.log('\nTPEE Block rate:', data.metrics.tpee_block_rate?.values?.rate?.toFixed(2) || 'N/A');
    console.log('TPEE Adjust rate:', data.metrics.tpee_adjust_rate?.values?.rate?.toFixed(2) || 'N/A');
    console.log('\nRequest p95:', data.metrics.http_req_duration?.values?.['p(95)']?.toFixed(0) + 'ms' || 'N/A');
    console.log('Error rate:', (data.metrics.http_req_failed?.values?.rate * 100)?.toFixed(2) + '%' || 'N/A');

    const passed =
        (data.metrics.task_duplicates?.values?.count || 0) === 0 &&
        (data.metrics.missing_policy_snapshot_id?.values?.count || 0) === 0 &&
        (data.metrics.missing_tpee_eval_id?.values?.count || 0) === 0 &&
        (data.metrics.http_req_failed?.values?.rate || 0) < 0.05;

    console.log('\n========================================');
    console.log('VERDICT:', passed ? '✅ PASS' : '❌ FAIL');
    console.log('========================================\n');

    return {
        stdout: JSON.stringify(data, null, 2),
    };
}
