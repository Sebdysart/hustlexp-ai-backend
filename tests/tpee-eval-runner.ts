/**
 * TPEE Eval Runner - Phase 2A
 * 
 * Runs the 50 labeled test cases against TPEEService
 * and produces a diff report showing:
 * - Pass/Fail per case
 * - Expected vs Actual decision
 * - Failure categorization
 * 
 * Run: npx tsx tests/tpee-eval-runner.ts
 */

import { TPEEService, type TPEEInput, type TPEEResult, type TPEEDecision, type EnforcementReasonCode } from '../src/services/TPEEService.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================
// Types
// ============================================

interface EvalCase {
    id: string;
    category: string;
    description?: string;
    input: TPEEInput;
    expected: {
        decision: TPEEDecision;
        enforcement_reason_code: EnforcementReasonCode;
        recommended_price_min?: number;
        notes?: string;
    };
}

interface EvalDataset {
    version: string;
    description: string;
    cases: EvalCase[];
}

interface EvalResult {
    id: string;
    category: string;
    passed: boolean;
    expected_decision: TPEEDecision;
    actual_decision: TPEEDecision;
    expected_reason: EnforcementReasonCode;
    actual_reason: EnforcementReasonCode;
    checks_passed: string[];
    checks_failed: string[];
    notes?: string;
    error?: string;
}

interface EvalReport {
    timestamp: string;
    total: number;
    passed: number;
    failed: number;
    pass_rate: number;
    by_category: Record<string, { total: number; passed: number; failed: number }>;
    failures: EvalResult[];
    all_results: EvalResult[];
}

// ============================================
// Load Dataset (strip JSONC comments)
// ============================================

function loadDataset(): EvalDataset {
    const datasetPath = path.join(__dirname, 'tpee-eval-dataset.jsonc');
    const raw = fs.readFileSync(datasetPath, 'utf-8');

    // Strip single-line comments (// ...)
    const jsonClean = raw
        .split('\n')
        .map(line => {
            const commentIndex = line.indexOf('//');
            if (commentIndex === -1) return line;
            // Only strip if not inside a string - simple heuristic
            const beforeComment = line.slice(0, commentIndex);
            const quoteCount = (beforeComment.match(/"/g) || []).length;
            if (quoteCount % 2 === 0) {
                return beforeComment;
            }
            return line;
        })
        .join('\n');

    return JSON.parse(jsonClean);
}

// ============================================
// Run Single Case
// ============================================

async function runCase(evalCase: EvalCase): Promise<EvalResult> {
    try {
        const result = await TPEEService.evaluateTask(evalCase.input);

        // Check if decision matches
        const decisionMatch = result.decision === evalCase.expected.decision;

        // For non-ACCEPT, also check reason code
        const reasonMatch =
            evalCase.expected.decision === 'ACCEPT'
                ? true
                : result.enforcement_reason_code === evalCase.expected.enforcement_reason_code;

        const passed = decisionMatch && reasonMatch;

        return {
            id: evalCase.id,
            category: evalCase.category,
            passed,
            expected_decision: evalCase.expected.decision,
            actual_decision: result.decision,
            expected_reason: evalCase.expected.enforcement_reason_code,
            actual_reason: result.enforcement_reason_code,
            checks_passed: result.checks_passed,
            checks_failed: result.checks_failed,
            notes: evalCase.expected.notes,
        };
    } catch (error) {
        return {
            id: evalCase.id,
            category: evalCase.category,
            passed: false,
            expected_decision: evalCase.expected.decision,
            actual_decision: 'BLOCK',
            expected_reason: evalCase.expected.enforcement_reason_code,
            actual_reason: 'NONE',
            checks_passed: [],
            checks_failed: ['error'],
            error: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

// ============================================
// Run Full Eval
// ============================================

async function runFullEval(): Promise<EvalReport> {
    const dataset = loadDataset();
    const results: EvalResult[] = [];

    console.log(`\n🧪 TPEE Eval Runner v1.0`);
    console.log(`📁 Dataset: ${dataset.description}`);
    console.log(`📊 Cases: ${dataset.cases.length}\n`);
    console.log('─'.repeat(60));

    for (const evalCase of dataset.cases) {
        const result = await runCase(evalCase);
        results.push(result);

        const icon = result.passed ? '✅' : '❌';
        const decisionDiff = result.passed
            ? result.actual_decision
            : `${result.expected_decision}→${result.actual_decision}`;

        console.log(`${icon} ${evalCase.id.padEnd(20)} | ${decisionDiff.padEnd(15)} | ${evalCase.category}`);
    }

    console.log('─'.repeat(60));

    // Aggregate stats
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;

    const byCategory: Record<string, { total: number; passed: number; failed: number }> = {};
    for (const r of results) {
        if (!byCategory[r.category]) {
            byCategory[r.category] = { total: 0, passed: 0, failed: 0 };
        }
        byCategory[r.category].total++;
        if (r.passed) {
            byCategory[r.category].passed++;
        } else {
            byCategory[r.category].failed++;
        }
    }

    const report: EvalReport = {
        timestamp: new Date().toISOString(),
        total: results.length,
        passed,
        failed,
        pass_rate: passed / results.length,
        by_category: byCategory,
        failures: results.filter(r => !r.passed),
        all_results: results,
    };

    // Print summary
    console.log(`\n📈 SUMMARY`);
    console.log(`   Total:   ${report.total}`);
    console.log(`   Passed:  ${report.passed} (${(report.pass_rate * 100).toFixed(1)}%)`);
    console.log(`   Failed:  ${report.failed}`);
    console.log();

    console.log(`📂 BY CATEGORY`);
    for (const [cat, stats] of Object.entries(report.by_category)) {
        const rate = (stats.passed / stats.total * 100).toFixed(0);
        console.log(`   ${cat.padEnd(15)} ${stats.passed}/${stats.total} (${rate}%)`);
    }
    console.log();

    if (report.failures.length > 0) {
        console.log(`❌ FAILURES (${report.failures.length})`);
        for (const f of report.failures) {
            console.log(`   ${f.id}: Expected ${f.expected_decision}/${f.expected_reason}, got ${f.actual_decision}/${f.actual_reason}`);
            if (f.notes) {
                console.log(`      Note: ${f.notes}`);
            }
        }
    }

    // Save report
    const reportPath = path.join(__dirname, 'tpee-eval-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n💾 Report saved: ${reportPath}`);

    return report;
}

// ============================================
// Main
// ============================================

runFullEval()
    .then(report => {
        process.exit(report.failed > 0 ? 1 : 0);
    })
    .catch(err => {
        console.error('Eval failed:', err);
        process.exit(1);
    });
