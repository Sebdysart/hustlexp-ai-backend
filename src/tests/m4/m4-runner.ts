
import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
import { serviceLogger } from '../../utils/logger';
import fs from 'fs';
import path from 'path';

/**
 * M4 SURGICAL RUNNER (Report Mode)
 * Executes M4 test cases against the configured M4 DB.
 * Collects Pass/Fail stats and Drift Metrics.
 */

// Define Test Interface
export interface M4TestCase {
    name: string;
    run: (pool: Pool) => Promise<TestResult>;
}

export interface TestResult {
    passed: boolean;
    durationMs: number;
    error?: string;
    stats?: Record<string, any>;
}

async function main() {
    console.log("=========================================");
    console.log("   M4 SURGICAL TEST RUNNER (NEON/SER)    ");
    console.log("=========================================");

    const m4Url = process.env.DATABASE_URL_M4;
    if (!m4Url) {
        console.error("FATAL: DATABASE_URL_M4 not set.");
        process.exit(1);
    }

    // CRITICAL: Set DATABASE_URL before importing services
    // This ensures db/index.ts initializes with the correct M4 URL
    process.env.DATABASE_URL = m4Url;
    console.log("Environment: DATABASE_URL aligned to M4 Target (Dynamic Import Mode).");

    // NOW we import the cases which trigger db/index.ts loading
    const { RaceReleaseCase } = await import('./cases/race-release');
    const { SagaFaultsCase } = await import('./cases/saga-faults');
    const { LedgerConsistencyCase } = await import('./cases/ledger-consistency');

    const pool = new Pool({ connectionString: m4Url });

    // Global Setup
    try {
        await pool.query("SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"); // Layer A Enforcement
        console.log("Environment: SERIALIZABLE Enforced.");
    } catch (e) {
        console.error("Setup Failed:", e);
        process.exit(1);
    }

    // Load Cases
    const cases: M4TestCase[] = [
        RaceReleaseCase,
        SagaFaultsCase,
        LedgerConsistencyCase
    ];

    const report: Record<string, TestResult> = {};
    let globalPass = true;

    for (const testCase of cases) {
        console.log(`\n>> RUNNING: ${testCase.name}`);
        const start = Date.now();
        try {
            const result = await testCase.run(pool);
            const duration = Date.now() - start;
            result.durationMs = duration;

            report[testCase.name] = result;

            if (result.passed) {
                console.log(`   [PASS] ${duration}ms`);
            } else {
                console.log(`   [FAIL] ${duration}ms - ${result.error}`);
                globalPass = false;
            }
        } catch (err: any) {
            const duration = Date.now() - start;
            console.log(`   [CRASH] ${duration}ms - ${err.message}`);
            report[testCase.name] = { passed: false, durationMs: duration, error: err.message };
            globalPass = false;
        }
    }

    // Final Report
    console.log("\n=========================================");
    console.log("   M4 FINAL REPORT                       ");
    console.log("=========================================");
    console.table(Object.entries(report).map(([k, v]) => ({
        Case: k,
        Status: v.passed ? 'PASS' : 'FAIL',
        Time: `${v.durationMs}ms`,
        Stats: v.stats ? JSON.stringify(v.stats) : '',
        Error: v.error || ''
    })));

    await pool.end();

    if (!globalPass) {
        console.log("\nStatus: BUSTED. Fix the Engine.");
        process.exit(1);
    } else {
        console.log("\nStatus: CERTIFIED (M4).");
        process.exit(0);
    }
}

main(); // Execute if run directly
