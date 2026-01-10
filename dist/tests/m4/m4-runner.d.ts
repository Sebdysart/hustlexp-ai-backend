import 'dotenv/config';
import { Pool } from '@neondatabase/serverless';
/**
 * M4 SURGICAL RUNNER (Report Mode)
 * Executes M4 test cases against the configured M4 DB.
 * Collects Pass/Fail stats and Drift Metrics.
 */
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
//# sourceMappingURL=m4-runner.d.ts.map