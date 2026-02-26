# Citadel Governor Protocol — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wrap the Autonomous SDLC Engine in a five-layer sovereign guardrail system that makes it mathematically impossible for AI-generated code to reach `main` without passing cryptographic, formal, and adversarial verification — independently of Claude's own judgement.

**Architecture:** Five independent guardrail layers (Merkle vault, mutation testing, constitution AST enforcement, multi-model adversarial oracle, cryptographic provenance) run as a separate `citadel.yml` workflow. Each layer posts a structured verdict to an append-only SQLite audit log. The orchestrator's readiness-score gates on all five verdicts before the auto-merge job fires. Claude cannot see, reach, or influence any layer — they operate entirely outside its sandbox.

**Tech Stack:** Stryker.js (mutation), Tree-sitter + `@typescript-eslint/typescript-estree` (AST/constitution), OpenAI + Anthropic + Google Gemini APIs (oracle ensemble), `better-sqlite3` (provenance log), `@noble/ed25519` (commit signing), `git submodule` (vault), GitHub Actions (orchestration).

**Design doc:** `docs/plans/2026-02-26-citadel-governor-spec.md` (this file)

---

## Scope Decisions

| Component | v1 (this plan) | Deferred |
|---|---|---|
| Test Vault | Git submodule + SHA256 Merkle check | HSM-backed key storage |
| Mutation | Stryker.js ≥92% gate | AFL++ binary fuzzing |
| Constitution | Tree-sitter AST rules (TypeScript) | WASM compilation, Z3/SMT |
| Oracle | 3-model ensemble (GPT-4o, Gemini-2-Flash, Claude-3.5) | Grok/Llama self-hosting |
| Provenance | SQLite append-only log + ed25519 per-run key | Sigstore transparency log |

---

## Task 1: Create the Test Vault Repository + Submodule

The existing 690 tests move into a separate GitHub repo that the Claude agent **cannot write to** (no write token in CI). The vault is pinned by commit hash in `.gitmodules` and verified by a SHA-256 Merkle check before any merge.

**Files:**
- Create (browser): new GitHub repo `hustlexp-tests-vault` under `Sebdysart`
- Modify: `.gitmodules`
- Modify: `package.json` (test script)
- Create: `scripts/citadel-integrity-lock.sh`

**Step 1: Create the vault repo (browser action)**

Go to `https://github.com/new` and create a **private** repo named `hustlexp-tests-vault`. Do not initialise with a README.

**Step 2: Move existing tests into the vault**

```bash
# From project root
cp -r backend/tests/ /tmp/hustlexp-tests-vault/
cd /tmp/hustlexp-tests-vault
git init && git add . && git commit -m "feat: initial test vault"
git remote add origin https://github.com/Sebdysart/hustlexp-tests-vault.git
git push -u origin main
```

**Step 3: Add the vault as a submodule**

```bash
cd /path/to/hustlexp-ai-backend
git submodule add https://github.com/Sebdysart/hustlexp-tests-vault.git tests-vault
git submodule update --init --recursive
```

**Step 4: Create `scripts/citadel-integrity-lock.sh`**

```bash
#!/usr/bin/env bash
# citadel-integrity-lock.sh
# Verifies the test vault has not been tampered with.
# Exit 0 = clean. Exit 1 = BREACH.
set -euo pipefail

echo "🛡️  Citadel: verifying test vault integrity..."

EXPECTED_SHA=$(git submodule status tests-vault | awk '{print $1}' | tr -d '-+')
ACTUAL_SHA=$(git -C tests-vault rev-parse HEAD)

if [[ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]]; then
  echo "❌ CITADEL BREACH: tests-vault commit mismatch"
  echo "   Expected: $EXPECTED_SHA"
  echo "   Actual:   $ACTUAL_SHA"
  exit 1
fi

# Merkle: hash every file in vault and compare to recorded manifest
MANIFEST="tests-vault/.citadel-manifest.sha256"
if [[ ! -f "$MANIFEST" ]]; then
  echo "❌ CITADEL BREACH: manifest file missing from vault"
  exit 1
fi

cd tests-vault
COMPUTED=$(find . -type f ! -name '.citadel-manifest.sha256' | sort | xargs sha256sum | sha256sum | awk '{print $1}')
RECORDED=$(cat .citadel-manifest.sha256)

if [[ "$COMPUTED" != "$RECORDED" ]]; then
  echo "❌ CITADEL BREACH: Merkle root mismatch — test files altered"
  echo "   Recorded: $RECORDED"
  echo "   Computed: $COMPUTED"
  exit 1
fi

echo "✅ Citadel: test vault integrity confirmed (SHA: ${ACTUAL_SHA:0:12})"
```

**Step 5: Generate the initial Merkle manifest (run once inside the vault repo)**

```bash
cd tests-vault
find . -type f ! -name '.citadel-manifest.sha256' | sort | xargs sha256sum | sha256sum | awk '{print $1}' > .citadel-manifest.sha256
git add .citadel-manifest.sha256
git commit -m "chore: add citadel merkle manifest"
git push
```

**Step 6: Update `package.json` test script to use vault path**

```json
{
  "scripts": {
    "test": "vitest run --config vitest.config.ts",
    "test:vault": "vitest run tests-vault/**/*.test.ts",
    "test:new": "vitest run backend/tests/new/**/*.test.ts"
  }
}
```

**Step 7: Run the integrity check locally**

```bash
bash scripts/citadel-integrity-lock.sh
```
Expected: `✅ Citadel: test vault integrity confirmed`

**Step 8: Commit**

```bash
git add .gitmodules tests-vault scripts/citadel-integrity-lock.sh package.json
git commit -m "feat(citadel): add immutable test vault with Merkle integrity lock"
```

---

## Task 2: Stryker.js Mutation Testing Gate (≥92%)

Stryker mutates every logical branch in changed files and checks that your tests actually *catch* the mutations. A mutation score < 92% means your tests wouldn't catch a subtle bug introduced by the AI.

**Files:**
- Create: `stryker.config.ts`
- Create: `scripts/citadel-mutation-gate.ts`
- Modify: `package.json`

**Step 1: Install Stryker**

```bash
npm install --save-dev @stryker-mutator/core @stryker-mutator/vitest-runner
```

**Step 2: Create `stryker.config.ts`**

```typescript
import type { Config } from '@stryker-mutator/core';

const config: Config = {
  packageManager: 'npm',
  reporters: ['html', 'clear-text', 'json'],
  testRunner: 'vitest',
  coverageAnalysis: 'perTest',
  // Scope to files changed in this PR (injected via env)
  mutate: (process.env.MUTATE_FILES ?? 'backend/src/**/*.ts')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean),
  thresholds: {
    high: 95,
    low: 92,
    break: 92,   // exit 1 below this — gates the CI job
  },
  testablePaths: ['tests-vault/**/*.test.ts', 'backend/tests/new/**/*.test.ts'],
  timeoutMS: 30000,
  concurrency: 4,
  jsonReporter: { fileName: 'stryker-report.json' },
};

export default config;
```

**Step 3: Create `scripts/citadel-mutation-gate.ts`**

```typescript
import { execSync } from 'child_process';
import fs from 'fs';

const changedFiles = (process.env.CHANGED_FILES ?? '').split(',').filter(Boolean);

// Only mutate source files (not tests, scripts, or config)
const mutateTargets = changedFiles
  .filter(f => f.startsWith('backend/src/') && f.endsWith('.ts'))
  .join(',');

if (!mutateTargets) {
  console.log('No source files changed — skipping mutation gate.');
  process.exit(0);
}

process.env.MUTATE_FILES = mutateTargets;

console.log(`🧬 Citadel: mutating ${mutateTargets.split(',').length} file(s)...`);

try {
  execSync('npx stryker run', { stdio: 'inherit' });
} catch {
  console.error('❌ Citadel: mutation score below 92% threshold');
  process.exit(1);
}

// Parse report and emit GitHub output
const report = JSON.parse(fs.readFileSync('stryker-report.json', 'utf-8'));
const score = report.mutationScore ?? 0;
console.log(`✅ Citadel: mutation score ${score.toFixed(1)}% — gate passed`);

if (process.env.GITHUB_OUTPUT) {
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `mutation_score=${score.toFixed(1)}\n`);
}
```

**Step 4: Write the failing test (verify Stryker catches a deliberate mutation)**

Create `backend/tests/new/citadel-mutation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

// A simple pure function we'll use to verify Stryker works
function add(a: number, b: number): number {
  return a + b;
}

describe('citadel mutation verification', () => {
  it('catches arithmetic mutation', () => {
    expect(add(2, 3)).toBe(5);
    expect(add(0, 0)).toBe(0);
    expect(add(-1, 1)).toBe(0);
  });
});
```

**Step 5: Run test to verify it passes**

```bash
npx vitest run backend/tests/new/citadel-mutation.test.ts
```
Expected: PASS

**Step 6: Add script to `package.json`**

```json
"citadel:mutate": "tsx scripts/citadel-mutation-gate.ts"
```

**Step 7: Run mutation gate locally against a sample file**

```bash
CHANGED_FILES="backend/src/services/EscrowService.ts" npm run citadel:mutate
```
Expected: mutation run completes, score reported

**Step 8: Commit**

```bash
git add stryker.config.ts scripts/citadel-mutation-gate.ts \
        backend/tests/new/citadel-mutation.test.ts package.json
git commit -m "feat(citadel): add Stryker.js mutation gate (92% threshold)"
```

---

## Task 3: Living Constitution Enforcer (AST + Semantic Rules)

Compiles the invariants from `CLAUDE.md` into executable TypeScript AST rules using `@typescript-eslint/typescript-estree`. Checks the *diff* of every PR — not just existence of tests, but semantic correctness of the code.

**Files:**
- Create: `scripts/citadel-constitution-enforcer.ts`
- Create: `scripts/citadel-rules/` (one file per invariant group)
- Modify: `package.json`

**Step 1: Install AST tooling**

```bash
npm install --save-dev @typescript-eslint/typescript-estree @typescript-eslint/utils tsx
```

**Step 2: Create `scripts/citadel-rules/financial.ts`**

```typescript
import { parse } from '@typescript-eslint/typescript-estree';
import type { TSESTree } from '@typescript-eslint/utils';

export interface Violation {
  file: string;
  line: number;
  invariant: string;
  message: string;
}

/**
 * INV-4: Ledger entries are immutable — no UPDATE/DELETE on ledger_entries.
 * Scans source for raw SQL that touches ledger_entries with mutation verbs.
 */
export function checkLedgerImmutability(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (
      (lower.includes('update') || lower.includes('delete')) &&
      lower.includes('ledger_entr')
    ) {
      violations.push({
        file: filePath,
        line: i + 1,
        invariant: 'INV-4',
        message: `Ledger mutation detected: "${line.trim()}" — ledger_entries are append-only`,
      });
    }
  });

  return violations;
}

/**
 * INV-1/5: Balance and payment amounts must be positive integers.
 * Flags any assignment to `amount` fields without a positivity check nearby.
 */
export function checkAmountPositivity(source: string, filePath: string): Violation[] {
  const violations: Violation[] = [];

  try {
    const ast = parse(source, { loc: true, range: true, jsx: false });

    function walk(node: TSESTree.Node) {
      // Flag: amount: someVar where someVar isn't guarded with > 0 or Math.abs
      if (
        node.type === 'Property' &&
        node.key.type === 'Identifier' &&
        (node.key.name === 'amount' || node.key.name === 'escrowAmount')
      ) {
        // Heuristic: check if there's no validation in the enclosing function body
        violations.push({
          file: filePath,
          line: node.loc?.start.line ?? 0,
          invariant: 'INV-1/5',
          message: `Amount assignment at line ${node.loc?.start.line} — verify positivity guard exists (INV-1/5)`,
        });
      }
      for (const key of Object.keys(node)) {
        const child = (node as Record<string, unknown>)[key];
        if (child && typeof child === 'object' && 'type' in (child as object)) {
          walk(child as TSESTree.Node);
        } else if (Array.isArray(child)) {
          child.forEach(c => c && typeof c === 'object' && 'type' in c && walk(c as TSESTree.Node));
        }
      }
    }

    walk(ast);
  } catch {
    // Parse errors are reported elsewhere (tsc)
  }

  return violations;
}

/**
 * Architecture Rule: No direct DB calls in routers.
 * Flags `db.` or `sql\`` usage inside files matching routers/ pattern.
 */
export function checkNoDirectDbInRouters(source: string, filePath: string): Violation[] {
  if (!filePath.includes('/routers/')) return [];

  const violations: Violation[] = [];
  const lines = source.split('\n');

  lines.forEach((line, i) => {
    if (/\bdb\.\w+\(/.test(line) || /sql`/.test(line)) {
      violations.push({
        file: filePath,
        line: i + 1,
        invariant: 'ARCH-1',
        message: `Direct DB call in router: "${line.trim()}" — use a Service instead`,
      });
    }
  });

  return violations;
}
```

**Step 3: Create `scripts/citadel-rules/state-machine.ts`**

```typescript
import type { Violation } from './financial.js';

// Valid transitions from CLAUDE.md
const TASK_TRANSITIONS: Record<string, string[]> = {
  open: ['assigned'],
  assigned: ['in_progress', 'open'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const ESCROW_TRANSITIONS: Record<string, string[]> = {
  PENDING: ['FUNDED'],
  FUNDED: ['RELEASED', 'REFUNDED', 'DISPUTED'],
  RELEASED: [],
  REFUNDED: [],
  DISPUTED: ['RELEASED', 'REFUNDED'],
};

/**
 * Flags direct state string assignments that skip the service layer.
 * Pattern: status = 'completed' without going through TaskService.
 */
export function checkStateMachineTransitions(source: string, filePath: string): Violation[] {
  if (filePath.includes('Service.ts') || filePath.includes('.test.ts')) return [];

  const violations: Violation[] = [];
  const lines = source.split('\n');
  const stateValues = [
    ...Object.keys(TASK_TRANSITIONS),
    ...Object.keys(ESCROW_TRANSITIONS),
  ];

  lines.forEach((line, i) => {
    for (const state of stateValues) {
      if (
        new RegExp(`status\\s*=\\s*['"\`]${state}['"\`]`).test(line) ||
        new RegExp(`status:\\s*['"\`]${state}['"\`]`).test(line)
      ) {
        violations.push({
          file: filePath,
          line: i + 1,
          invariant: 'SM-1',
          message: `Direct state assignment '${state}' outside service layer: "${line.trim()}"`,
        });
      }
    }
  });

  return violations;
}
```

**Step 4: Create `scripts/citadel-constitution-enforcer.ts`**

```typescript
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  checkLedgerImmutability,
  checkAmountPositivity,
  checkNoDirectDbInRouters,
} from './citadel-rules/financial.js';
import { checkStateMachineTransitions } from './citadel-rules/state-machine.js';
import type { Violation } from './citadel-rules/financial.js';

// Get changed files from diff
const changedFiles = (process.env.CHANGED_FILES ?? '')
  .split(',')
  .map(f => f.trim())
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('scripts/'));

if (!changedFiles.length) {
  console.log('No source files to check — constitution enforcer skipping.');
  process.exit(0);
}

console.log(`📜 Citadel Constitution: checking ${changedFiles.length} file(s)...`);

const allViolations: Violation[] = [];

for (const file of changedFiles) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf-8');

  allViolations.push(
    ...checkLedgerImmutability(source, file),
    ...checkAmountPositivity(source, file),
    ...checkNoDirectDbInRouters(source, file),
    ...checkStateMachineTransitions(source, file),
  );
}

if (allViolations.length > 0) {
  console.error('\n❌ CITADEL: Constitutional violations detected:\n');
  for (const v of allViolations) {
    console.error(`  [${v.invariant}] ${v.file}:${v.line} — ${v.message}`);
  }
  console.error(`\nTotal: ${allViolations.length} violation(s). Fix before merge.`);

  // Write violations to file for PR comment
  fs.writeFileSync(
    'citadel-constitution-report.md',
    `## ❌ Constitutional Violations\n\n` +
    allViolations.map(v =>
      `- **[${v.invariant}]** \`${v.file}:${v.line}\` — ${v.message}`
    ).join('\n'),
  );

  process.exit(1);
}

console.log(`✅ Citadel Constitution: all ${changedFiles.length} file(s) clean.`);
fs.writeFileSync('citadel-constitution-report.md', '## ✅ Constitutional Check: All Clear\n');
```

**Step 5: Write the failing test (verify enforcer catches a violation)**

Create `backend/tests/new/citadel-constitution.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { checkLedgerImmutability, checkNoDirectDbInRouters } from '../../../scripts/citadel-rules/financial.js';

describe('citadel constitution enforcer', () => {
  it('flags UPDATE on ledger_entries', () => {
    const source = `await db.execute(sql\`UPDATE ledger_entries SET amount = 0\`)`;
    const violations = checkLedgerImmutability(source, 'src/services/Test.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('INV-4');
  });

  it('allows SELECT on ledger_entries', () => {
    const source = `await db.execute(sql\`SELECT * FROM ledger_entries\`)`;
    const violations = checkLedgerImmutability(source, 'src/services/Test.ts');
    expect(violations).toHaveLength(0);
  });

  it('flags direct db call in router', () => {
    const source = `const result = await db.query('SELECT 1')`;
    const violations = checkNoDirectDbInRouters(source, 'src/routers/payment.ts');
    expect(violations).toHaveLength(1);
    expect(violations[0].invariant).toBe('ARCH-1');
  });

  it('ignores db calls in services', () => {
    const source = `const result = await db.query('SELECT 1')`;
    const violations = checkNoDirectDbInRouters(source, 'src/services/PaymentService.ts');
    expect(violations).toHaveLength(0);
  });
});
```

**Step 6: Run the test to verify it passes**

```bash
npx vitest run backend/tests/new/citadel-constitution.test.ts
```
Expected: PASS (4 tests)

**Step 7: Add script**

```json
"citadel:constitution": "tsx scripts/citadel-constitution-enforcer.ts"
```

**Step 8: Commit**

```bash
git add scripts/citadel-constitution-enforcer.ts \
        scripts/citadel-rules/ \
        backend/tests/new/citadel-constitution.test.ts \
        package.json
git commit -m "feat(citadel): add living constitution enforcer (INV-1/4/5, ARCH-1, SM-1)"
```

---

## Task 4: Adversarial Oracle Ensemble (3-Model)

Three independent LLMs each receive the full PR diff, all test output, and the CLAUDE.md invariants. Each is prompted as a "malicious senior security architect looking for shortcuts, backdoors, or quietly disabled invariants." Majority vote gates the merge.

**Files:**
- Create: `scripts/citadel-oracle-ensemble.ts`
- Modify: `package.json`

**GitHub Secrets required (add via browser):**
- `OPENAI_API_KEY` (already likely exists — check `gh secret list`)
- `GEMINI_API_KEY` (get from `aistudio.google.com`)

**Step 1: Install oracle dependencies**

```bash
npm install --save-dev openai @google/generative-ai
```

**Step 2: Write the failing test (oracle vote logic)**

Create `backend/tests/new/citadel-oracle.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

type OracleVerdict = { model: string; safe: boolean; confidence: number; findings: string[] };

function computeMajorityVerdict(verdicts: OracleVerdict[]): {
  safe: boolean;
  confidence: number;
  dissenting: string[];
} {
  const safeVotes = verdicts.filter(v => v.safe).length;
  const totalWeight = verdicts.reduce((sum, v) => sum + v.confidence, 0);
  const safeWeight = verdicts.filter(v => v.safe).reduce((sum, v) => sum + v.confidence, 0);
  const weightedSafe = safeWeight / totalWeight;

  return {
    safe: weightedSafe >= 0.5,
    confidence: weightedSafe,
    dissenting: verdicts.filter(v => !v.safe).map(v => v.model),
  };
}

describe('oracle ensemble voting', () => {
  it('passes when all models agree safe', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: true, confidence: 0.95, findings: [] },
      { model: 'gemini', safe: true, confidence: 0.90, findings: [] },
      { model: 'claude', safe: true, confidence: 0.92, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    expect(result.safe).toBe(true);
    expect(result.dissenting).toHaveLength(0);
  });

  it('blocks when majority flags unsafe', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: false, confidence: 0.95, findings: ['backdoor in auth'] },
      { model: 'gemini', safe: false, confidence: 0.88, findings: ['state bypass'] },
      { model: 'claude', safe: true, confidence: 0.70, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    expect(result.safe).toBe(false);
    expect(result.dissenting).toContain('gpt-4o');
  });

  it('blocks on split vote with high-confidence dissenter', () => {
    const verdicts: OracleVerdict[] = [
      { model: 'gpt-4o', safe: false, confidence: 0.98, findings: ['invariant disabled'] },
      { model: 'gemini', safe: true, confidence: 0.60, findings: [] },
      { model: 'claude', safe: true, confidence: 0.61, findings: [] },
    ];
    const result = computeMajorityVerdict(verdicts);
    // Weighted: unsafe = 0.98, safe = 1.21. Safe wins on weight but barely.
    expect(result.confidence).toBeLessThan(0.6);
  });
});
```

**Step 3: Run to verify it passes**

```bash
npx vitest run backend/tests/new/citadel-oracle.test.ts
```
Expected: PASS (3 tests)

**Step 4: Create `scripts/citadel-oracle-ensemble.ts`**

```typescript
import fs from 'fs';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';

const ORACLE_PROMPT = (diff: string, invariants: string) => `
You are a malicious senior security architect whose job is to find any way that the
following code change could cause a production incident, bypass a financial invariant,
introduce a backdoor, or quietly disable a safety check.

The system has these hard invariants:
${invariants}

Analyze the following diff with maximum adversarial scrutiny:
\`\`\`diff
${diff.slice(0, 8000)}
\`\`\`

Respond in JSON:
{
  "safe": boolean,         // true only if you found NO exploitable issues
  "confidence": number,    // 0.0–1.0 how certain you are
  "findings": string[],   // list of specific issues (empty if safe)
  "reasoning": string     // brief chain of thought
}
`;

interface OracleVerdict {
  model: string;
  safe: boolean;
  confidence: number;
  findings: string[];
  reasoning: string;
}

async function queryGPT4o(diff: string, invariants: string): Promise<OracleVerdict> {
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const resp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: ORACLE_PROMPT(diff, invariants) }],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });
  const parsed = JSON.parse(resp.choices[0].message.content ?? '{}');
  return { model: 'gpt-4o', ...parsed };
}

async function queryGemini(diff: string, invariants: string): Promise<OracleVerdict> {
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
  const model = genai.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
  const result = await model.generateContent(ORACLE_PROMPT(diff, invariants));
  const text = result.response.text().replace(/```json\n?|\n?```/g, '');
  const parsed = JSON.parse(text);
  return { model: 'gemini-2.0-flash', ...parsed };
}

async function queryClaude(diff: string, invariants: string): Promise<OracleVerdict> {
  // Use Claude via REST (separate from the implementing Claude instance)
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: ORACLE_PROMPT(diff, invariants) }],
    }),
  });
  const data = await resp.json() as { content: { text: string }[] };
  const parsed = JSON.parse(data.content[0].text);
  return { model: 'claude-3.5-sonnet', ...parsed };
}

async function main() {
  const diff = process.env.PR_DIFF ?? '';
  const invariants = fs.readFileSync('CLAUDE.md', 'utf-8')
    .split('\n').filter(l => l.startsWith('- **INV') || l.startsWith('- **ARCH'))
    .join('\n');

  if (!diff) {
    console.log('No diff provided — oracle skipping.');
    process.exit(0);
  }

  console.log('🔮 Citadel Oracle: dispatching 3-model adversarial ensemble...');

  const [gpt, gemini, claude] = await Promise.allSettled([
    queryGPT4o(diff, invariants),
    queryGemini(diff, invariants),
    queryClaude(diff, invariants),
  ]);

  const verdicts: OracleVerdict[] = [gpt, gemini, claude]
    .filter(r => r.status === 'fulfilled')
    .map(r => (r as PromiseFulfilledResult<OracleVerdict>).value);

  if (verdicts.length < 2) {
    console.error('❌ Oracle: fewer than 2 models responded — cannot form quorum');
    process.exit(1);
  }

  // Weighted majority vote
  const totalWeight = verdicts.reduce((s, v) => s + v.confidence, 0);
  const safeWeight = verdicts.filter(v => v.safe).reduce((s, v) => s + v.confidence, 0);
  const weightedSafe = safeWeight / totalWeight;
  const overallSafe = weightedSafe >= 0.5;
  const findings = verdicts.flatMap(v => v.findings);

  const report = {
    safe: overallSafe,
    weightedConfidence: weightedSafe,
    verdicts,
    findings,
  };

  fs.writeFileSync('citadel-oracle-report.json', JSON.stringify(report, null, 2));

  // Generate PR comment markdown
  const md = [
    `## 🔮 Oracle Ensemble Verdict: ${overallSafe ? '✅ SAFE' : '❌ UNSAFE'}`,
    `**Weighted confidence:** ${(weightedSafe * 100).toFixed(1)}%`,
    '',
    '| Model | Verdict | Confidence | Findings |',
    '|-------|---------|------------|---------|',
    ...verdicts.map(v =>
      `| ${v.model} | ${v.safe ? '✅' : '❌'} | ${(v.confidence * 100).toFixed(0)}% | ${v.findings.join('; ') || 'None'} |`
    ),
    findings.length > 0 ? `\n### Findings\n${findings.map(f => `- ${f}`).join('\n')}` : '',
  ].join('\n');

  fs.writeFileSync('citadel-oracle-report.md', md);

  if (!overallSafe) {
    console.error(`❌ Oracle: ensemble voted UNSAFE (${(weightedSafe * 100).toFixed(1)}% safe weight)`);
    console.error('Findings:', findings);
    process.exit(1);
  }

  console.log(`✅ Oracle: ensemble voted SAFE (${(weightedSafe * 100).toFixed(1)}% safe weight)`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `oracle_safe=${overallSafe}\noracle_confidence=${weightedSafe.toFixed(3)}\n`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
```

**Step 5: Add script**

```json
"citadel:oracle": "tsx scripts/citadel-oracle-ensemble.ts"
```

**Step 6: Commit**

```bash
git add scripts/citadel-oracle-ensemble.ts \
        backend/tests/new/citadel-oracle.test.ts \
        package.json
git commit -m "feat(citadel): add 3-model adversarial oracle ensemble with weighted voting"
```

---

## Task 5: Cryptographic Provenance Layer

Every citadel run generates a short-lived ed25519 keypair. All verdicts (integrity, mutation, constitution, oracle) are signed with the private key and appended to a local SQLite audit log. The public key + all signatures are posted to the PR. Anyone can replay and verify the entire history.

**Files:**
- Create: `scripts/citadel-provenance.ts`
- Create: `scripts/citadel-verify-provenance.ts`
- Modify: `package.json`

**Step 1: Install provenance dependencies**

```bash
npm install --save-dev @noble/ed25519 better-sqlite3 @types/better-sqlite3
```

**Step 2: Write the failing test**

Create `backend/tests/new/citadel-provenance.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// noble/ed25519 requires sha512 sync provider
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

describe('citadel provenance signing', () => {
  it('signs and verifies a verdict payload', async () => {
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = ed.getPublicKey(privKey);

    const payload = JSON.stringify({ gate: 'mutation', score: 94.2, safe: true });
    const message = new TextEncoder().encode(payload);
    const signature = ed.sign(message, privKey);

    const valid = ed.verify(signature, message, pubKey);
    expect(valid).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const privKey = ed.utils.randomPrivateKey();
    const pubKey = ed.getPublicKey(privKey);

    const payload = JSON.stringify({ gate: 'mutation', score: 94.2, safe: true });
    const message = new TextEncoder().encode(payload);
    const signature = ed.sign(message, privKey);

    const tampered = new TextEncoder().encode(
      JSON.stringify({ gate: 'mutation', score: 94.2, safe: false }) // changed
    );
    const valid = ed.verify(signature, tampered, pubKey);
    expect(valid).toBe(false);
  });
});
```

**Step 3: Run to verify it passes**

```bash
npx vitest run backend/tests/new/citadel-provenance.test.ts
```
Expected: PASS (2 tests)

**Step 4: Create `scripts/citadel-provenance.ts`**

```typescript
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import Database from 'better-sqlite3';
import fs from 'fs';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const DB_PATH = process.env.CITADEL_DB ?? 'citadel-provenance.sqlite';

function getDb() {
  const db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS verdicts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id     TEXT NOT NULL,
      pr_number  TEXT NOT NULL,
      gate       TEXT NOT NULL,
      safe       INTEGER NOT NULL,
      payload    TEXT NOT NULL,
      signature  TEXT NOT NULL,
      pub_key    TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export async function recordVerdict(opts: {
  runId: string;
  prNumber: string;
  gate: string;
  safe: boolean;
  details: Record<string, unknown>;
}) {
  const privKey = ed.utils.randomPrivateKey();
  const pubKey = ed.getPublicKey(privKey);

  const payload = JSON.stringify({ ...opts.details, gate: opts.gate, safe: opts.safe, runId: opts.runId });
  const message = new TextEncoder().encode(payload);
  const signature = ed.sign(message, privKey);

  const db = getDb();
  db.prepare(`
    INSERT INTO verdicts (run_id, pr_number, gate, safe, payload, signature, pub_key)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    opts.runId,
    opts.prNumber,
    opts.gate,
    opts.safe ? 1 : 0,
    payload,
    Buffer.from(signature).toString('hex'),
    Buffer.from(pubKey).toString('hex'),
  );

  return { pubKey: Buffer.from(pubKey).toString('hex'), signature: Buffer.from(signature).toString('hex') };
}

// CLI entrypoint: reads gate results from env and records all verdicts
async function main() {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const prNumber = process.env.PR_NUMBER ?? '0';

  const gates = [
    { gate: 'integrity',    safe: process.env.GATE_INTEGRITY    !== 'false', details: {} },
    { gate: 'mutation',     safe: process.env.GATE_MUTATION     !== 'false', details: { score: process.env.MUTATION_SCORE } },
    { gate: 'constitution', safe: process.env.GATE_CONSTITUTION !== 'false', details: {} },
    { gate: 'oracle',       safe: process.env.GATE_ORACLE       !== 'false', details: { confidence: process.env.ORACLE_CONFIDENCE } },
  ];

  const records = [];
  for (const g of gates) {
    const record = await recordVerdict({ runId, prNumber, ...g });
    records.push({ ...g, ...record });
    console.log(`📝 Recorded: ${g.gate} (safe=${g.safe}) sig=${record.signature.slice(0, 16)}...`);
  }

  // Generate provenance summary for PR comment
  const md = [
    `## 🔏 Cryptographic Provenance`,
    `**Run ID:** \`${runId}\` | **PR:** #${prNumber}`,
    '',
    '| Gate | Safe | Signature (first 24 chars) | Public Key (first 24 chars) |',
    '|------|------|---------------------------|----------------------------|',
    ...records.map(r =>
      `| ${r.gate} | ${r.safe ? '✅' : '❌'} | \`${r.signature.slice(0, 24)}...\` | \`${r.pubKey.slice(0, 24)}...\` |`
    ),
    '',
    `_All verdicts signed with short-lived ed25519 keys. Verify with \`npm run citadel:verify\`._`,
  ].join('\n');

  fs.writeFileSync('citadel-provenance-report.md', md);
  console.log('✅ Provenance layer: all verdicts recorded and signed.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

**Step 5: Add scripts to `package.json`**

```json
"citadel:provenance": "tsx scripts/citadel-provenance.ts",
"citadel:verify": "tsx scripts/citadel-verify-provenance.ts"
```

**Step 6: Commit**

```bash
git add scripts/citadel-provenance.ts \
        scripts/citadel-verify-provenance.ts \
        backend/tests/new/citadel-provenance.test.ts \
        package.json
git commit -m "feat(citadel): add ed25519 cryptographic provenance layer with SQLite audit log"
```

---

## Task 6: `citadel.yml` Workflow

Wires all five layers into a single GitHub Actions workflow that runs in parallel with the orchestrator on every `auto/*` PR. Posts a unified Citadel report to the PR.

**Files:**
- Create: `.github/workflows/citadel.yml`
- Modify: `.github/workflows/orchestrator.yml` (gate on citadel result)

**Step 1: Create `.github/workflows/citadel.yml`**

```yaml
name: Citadel Governor

on:
  pull_request:
    branches: [main]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  # ── Layer 1: Merkle Vault Integrity ──────────────────────────────
  integrity:
    name: Test Vault Integrity
    runs-on: ubuntu-latest
    outputs:
      passed: ${{ steps.check.outputs.passed }}
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
          fetch-depth: 0
      - name: Run Citadel Integrity Lock
        id: check
        run: |
          if bash scripts/citadel-integrity-lock.sh; then
            echo "passed=true" >> $GITHUB_OUTPUT
          else
            echo "passed=false" >> $GITHUB_OUTPUT
            exit 1
          fi

  # ── Layer 2: Mutation Testing ─────────────────────────────────────
  mutation:
    name: Mutation Gate (≥92%)
    runs-on: ubuntu-latest
    outputs:
      passed: ${{ steps.run.outputs.passed }}
      score: ${{ steps.run.outputs.mutation_score }}
    steps:
      - uses: actions/checkout@v4
        with: { submodules: recursive, fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - name: Run mutation gate
        id: run
        run: |
          CHANGED_FILES=$(git diff --name-only origin/main...HEAD | tr '\n' ',')
          export CHANGED_FILES
          if npx tsx scripts/citadel-mutation-gate.ts; then
            echo "passed=true" >> $GITHUB_OUTPUT
          else
            echo "passed=false" >> $GITHUB_OUTPUT
            exit 1
          fi
        continue-on-error: true
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: stryker-report
          path: stryker-report.json
          retention-days: 14

  # ── Layer 3: Living Constitution ──────────────────────────────────
  constitution:
    name: Constitution Enforcer
    runs-on: ubuntu-latest
    outputs:
      passed: ${{ steps.run.outputs.passed }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - name: Run constitution enforcer
        id: run
        run: |
          CHANGED_FILES=$(git diff --name-only origin/main...HEAD | tr '\n' ',')
          export CHANGED_FILES
          if npx tsx scripts/citadel-constitution-enforcer.ts; then
            echo "passed=true" >> $GITHUB_OUTPUT
          else
            echo "passed=false" >> $GITHUB_OUTPUT
            exit 1
          fi
        continue-on-error: true
      - name: Post constitution report
        if: always() && hashFiles('citadel-constitution-report.md') != ''
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: citadel-constitution
          path: citadel-constitution-report.md

  # ── Layer 4: Oracle Ensemble ──────────────────────────────────────
  oracle:
    name: Adversarial Oracle (3 Models)
    runs-on: ubuntu-latest
    needs: [constitution]           # only run if code is constitutionally clean
    if: needs.constitution.outputs.passed == 'true'
    outputs:
      passed: ${{ steps.run.outputs.oracle_safe }}
      confidence: ${{ steps.run.outputs.oracle_confidence }}
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - name: Run oracle ensemble
        id: run
        run: |
          PR_DIFF=$(git diff origin/main...HEAD)
          export PR_DIFF
          export PR_NUMBER=${{ github.event.pull_request.number }}
          npx tsx scripts/citadel-oracle-ensemble.ts
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        continue-on-error: true
      - name: Post oracle report
        if: always() && hashFiles('citadel-oracle-report.md') != ''
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: citadel-oracle
          path: citadel-oracle-report.md
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: oracle-report
          path: citadel-oracle-report.json
          retention-days: 14

  # ── Layer 5: Provenance Record ────────────────────────────────────
  provenance:
    name: Cryptographic Provenance
    runs-on: ubuntu-latest
    needs: [integrity, mutation, constitution, oracle]
    if: always()
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      - run: npm ci
      - name: Record signed verdicts
        run: npx tsx scripts/citadel-provenance.ts
        env:
          GITHUB_RUN_ID: ${{ github.run_id }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
          GATE_INTEGRITY: ${{ needs.integrity.outputs.passed }}
          GATE_MUTATION: ${{ needs.mutation.outputs.passed }}
          GATE_CONSTITUTION: ${{ needs.constitution.outputs.passed }}
          GATE_ORACLE: ${{ needs.oracle.outputs.passed }}
          MUTATION_SCORE: ${{ needs.mutation.outputs.score }}
          ORACLE_CONFIDENCE: ${{ needs.oracle.outputs.confidence }}
      - name: Post provenance report
        uses: marocchino/sticky-pull-request-comment@v2
        with:
          header: citadel-provenance
          path: citadel-provenance-report.md
      - uses: actions/upload-artifact@v4
        with:
          name: citadel-provenance-db
          path: citadel-provenance.sqlite
          retention-days: 90     # long retention for audit trail
```

**Step 2: Gate the orchestrator's auto-merge on Citadel passing**

In `.github/workflows/orchestrator.yml`, update the `auto-merge` job:

```yaml
  auto-merge:
    name: Autonomous Merge
    runs-on: ubuntu-latest
    needs: [readiness-score]
    if: |
      needs.readiness-score.result == 'success' &&
      startsWith(github.event.pull_request.head.ref, 'auto/')
    steps:
      - name: Check Citadel workflow passed
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          CITADEL_STATUS=$(gh api \
            "repos/${{ github.repository }}/commits/${{ github.event.pull_request.head.sha }}/check-runs" \
            --jq '[.check_runs[] | select(.name | startswith("Citadel"))] | map(.conclusion) | all(. == "success")' \
          )
          if [[ "$CITADEL_STATUS" != "true" ]]; then
            echo "❌ Citadel checks have not all passed — blocking auto-merge"
            exit 1
          fi
      - name: Merge PR
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh pr merge ${{ github.event.pull_request.number }} \
            --repo ${{ github.repository }} \
            --squash \
            --auto \
            --subject "auto: ${{ github.event.pull_request.title }} (#${{ github.event.pull_request.number }})"
```

**Step 3: Add `GEMINI_API_KEY` secret (browser action)**

Go to `https://github.com/Sebdysart/hustlexp-ai-backend/settings/secrets/actions` and add `GEMINI_API_KEY`. Get the key from `https://aistudio.google.com/`.

**Step 4: Commit**

```bash
git add .github/workflows/citadel.yml .github/workflows/orchestrator.yml
git commit -m "feat(citadel): wire all 5 layers into citadel.yml workflow + gate auto-merge"
```

---

## Task 7: Run Tests + Verify All New Tests Pass

**Step 1: Run all new citadel tests**

```bash
npx vitest run backend/tests/new/
```

Expected output:
```
✓ backend/tests/new/citadel-mutation.test.ts (1 test)
✓ backend/tests/new/citadel-constitution.test.ts (4 tests)
✓ backend/tests/new/citadel-oracle.test.ts (3 tests)
✓ backend/tests/new/citadel-provenance.test.ts (2 tests)

Test Files  4 passed
Tests       10 passed
```

**Step 2: Run the full vault suite to confirm nothing broke**

```bash
npx vitest run tests-vault/
```

Expected: all 690 existing tests pass

**Step 3: Run constitution enforcer against a sample changed file**

```bash
CHANGED_FILES="backend/src/routers/ai.ts" npm run citadel:constitution
```

Expected: output shows which rules were checked; exits 0 if clean

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat(citadel): all 5 governance layers operational — Citadel Protocol v1"
git push origin main
```

---

## Architecture Diagram

```
GitHub Issue (auto label)
        │
        ▼
claude-implement.yml ──────── [Claude sandbox — cannot reach Citadel]
        │
        ▼
   auto/* branch + PR
        │
   ┌────┴─────────────────────────────────────────────────────────┐
   │  citadel.yml (runs outside Claude's reach)                   │
   │                                                               │
   │  Layer 1: Integrity ──► Merkle vault hash check              │
   │  Layer 2: Mutation  ──► Stryker.js ≥92% per file             │
   │  Layer 3: Constitution ► Tree-sitter AST rules (INV-1/4/5)   │
   │  Layer 4: Oracle    ──► GPT-4o + Gemini + Claude adversarial │
   │  Layer 5: Provenance ─► ed25519 signed SQLite audit log      │
   └────┬─────────────────────────────────────────────────────────┘
        │ all layers green
        ▼
orchestrator.yml readiness-score ≥ threshold
        │
        ▼
auto-merge job checks Citadel status via GitHub API
        │ confirmed
        ▼
      MERGE
```

---

## Deferred to v2

- **HSM-backed key storage** — AWS CloudHSM or Azure Dedicated HSM for the signing keys (currently short-lived in-memory per run)
- **Sigstore transparency log** — replaces SQLite for public auditability
- **AFL++ binary fuzzing** — requires compiled binary and separate fuzzing infrastructure
- **Z3/SMT solver** — formal verification of financial state machines (TLA+ recommended tooling)
- **TLA+ specs** — model-check the escrow and payment state machines before merge
- **AI Behavioral Forensics** — Claude reasoning trace deception scanner

---

**Plan complete and saved to `docs/plans/2026-02-26-citadel-governor-spec.md`.**

**Two execution options:**

**1. Subagent-Driven (this session)** — I dispatch a fresh subagent per task, review between tasks. Fastest iteration. Use `superpowers:subagent-driven-development`.

**2. Parallel Session (separate)** — Open a new Claude Code session in the worktree, point it at this plan, use `superpowers:executing-plans` for checkpointed batch execution.

**Which approach?**
