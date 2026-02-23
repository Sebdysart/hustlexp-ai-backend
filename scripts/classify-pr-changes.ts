/**
 * classify-pr-changes.ts
 *
 * Deterministic PR change classifier. Routes PRs to one of 4 verification
 * tiers based on file path pattern matching. NO AI calls — pure heuristics.
 *
 * Reads changed files from:
 *   1. CHANGED_FILES env var (comma-separated, set by CI)
 *   2. Falls back to `git diff --name-only origin/main...HEAD`
 *
 * Tiers (highest wins for mixed changes):
 *   0 TRIVIAL:       docs, images, non-orchestrator CI config
 *   1 STANDARD:      routers, non-financial services, middleware, tests
 *   2 CRITICAL:      financial paths (Escrow, Ledger, Payment, Trust, XP, Stripe)
 *   3 ARCHITECTURAL: migrations, server config, orchestrator, infra
 *
 * Output: JSON to stdout + GITHUB_OUTPUT if available.
 */

import { execSync } from "child_process";
import * as fs from "fs";

// ============================================================================
// TYPES
// ============================================================================

export interface ClassificationResult {
  tier: number;
  tierName: string;
  mergeThreshold: number;
  fileCount: number;
  tierJustification: string[];
  skipGates: string[];
}

// ============================================================================
// TIER DEFINITIONS
// ============================================================================

const TIER_NAMES: Record<number, string> = {
  0: "TRIVIAL",
  1: "STANDARD",
  2: "CRITICAL",
  3: "ARCHITECTURAL",
};

const MERGE_THRESHOLDS: Record<number, number> = {
  0: 40,
  1: 80,
  2: 90,
  3: 95,
};

// ============================================================================
// PATTERN MATCHERS
// ============================================================================

function isTrivial(file: string): boolean {
  // Markdown files
  if (file.endsWith(".md")) return true;
  // Docs directory
  if (file.startsWith("docs/")) return true;
  // GitHub config EXCEPT orchestrator.yml
  if (
    file.startsWith(".github/") &&
    file.endsWith(".yml") &&
    !file.includes("orchestrator.yml")
  ) {
    return true;
  }
  // Images
  if (/\.(png|jpg|jpeg|svg|gif|ico)$/i.test(file)) return true;
  // README variants
  if (/^README/i.test(file.split("/").pop() ?? "")) return true;
  // LICENSE
  if (file === "LICENSE" || file === "LICENSE.md") return true;
  // .gitignore
  if (file === ".gitignore") return true;

  return false;
}

function isArchitectural(file: string): boolean {
  // Migrations
  if (file.startsWith("migrations/") && file.endsWith(".sql")) return true;
  // Core server files
  if (file === "backend/src/server.ts") return true;
  if (file === "backend/src/config.ts") return true;
  if (file === "backend/src/trpc.ts") return true;
  // Orchestrator workflow
  if (file === ".github/workflows/orchestrator.yml") return true;
  // Database directory
  if (file.startsWith("backend/database/")) return true;
  // Docker
  if (file === "Dockerfile" || file === "docker-compose.yml") return true;
  // Infrastructure
  if (file.startsWith("infrastructure/")) return true;

  return false;
}

const FINANCIAL_PATTERNS = [
  /Escrow/i,
  /Ledger/i,
  /Payment/i,
  /Trust/i,
  /XP/i,
  /Stripe/i,
];

function isCritical(file: string): boolean {
  // Only match files under backend/src/
  if (!file.startsWith("backend/src/")) return false;

  const basename = file.split("/").pop() ?? "";
  return FINANCIAL_PATTERNS.some((pattern) => pattern.test(basename));
}

function isStandard(file: string): boolean {
  // Routers
  if (file.startsWith("backend/src/routers/") && file.endsWith(".ts")) {
    return true;
  }
  // Non-financial services (financial ones are caught by isCritical first)
  if (file.startsWith("backend/src/services/") && file.endsWith(".ts")) {
    return true;
  }
  // Middleware
  if (file.startsWith("backend/src/middleware/") && file.endsWith(".ts")) {
    return true;
  }
  // Tests
  if (file.startsWith("backend/tests/")) return true;

  return false;
}

// ============================================================================
// CLASSIFIER
// ============================================================================

export function classifyFiles(files: string[]): ClassificationResult {
  if (files.length === 0) {
    return {
      tier: 0,
      tierName: "TRIVIAL",
      mergeThreshold: MERGE_THRESHOLDS[0],
      fileCount: 0,
      tierJustification: ["No changed files"],
      skipGates: ["holodeck", "invariants", "tdad"],
    };
  }

  let maxTier = 0;
  const justifications: string[] = [];

  for (const file of files) {
    let fileTier = 0;
    let reason = "unclassified";

    // Check tiers from highest to lowest so we get the right label
    if (isArchitectural(file)) {
      fileTier = 3;
      reason = "architectural path";
    } else if (isCritical(file)) {
      fileTier = 2;
      reason = "financial path";
    } else if (isStandard(file)) {
      fileTier = 1;
      reason = "standard path";
    } else if (isTrivial(file)) {
      fileTier = 0;
      reason = "trivial";
    } else {
      // Unknown files default to standard
      fileTier = 1;
      reason = "unclassified (default standard)";
    }

    if (fileTier >= maxTier) {
      maxTier = fileTier;
    }

    justifications.push(
      `${file} → ${TIER_NAMES[fileTier]} (${reason})`
    );
  }

  const skipGates = maxTier === 0 ? ["holodeck", "invariants", "tdad"] : [];

  return {
    tier: maxTier,
    tierName: TIER_NAMES[maxTier],
    mergeThreshold: MERGE_THRESHOLDS[maxTier],
    fileCount: files.length,
    tierJustification: justifications,
    skipGates,
  };
}

// ============================================================================
// FILE LIST RESOLUTION
// ============================================================================

function getChangedFiles(): string[] {
  // 1. Try CHANGED_FILES env var (comma-separated from CI)
  const envFiles = process.env.CHANGED_FILES;
  if (envFiles && envFiles.trim()) {
    return envFiles
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
  }

  // 2. Fall back to git diff
  try {
    const output = execSync("git diff --name-only origin/main...HEAD", {
      encoding: "utf-8",
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    console.error("Warning: Could not read changed files from git");
    return [];
  }
}

// ============================================================================
// GITHUB OUTPUT
// ============================================================================

function writeGitHubOutput(key: string, value: string) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `${key}=${value}\n`);
  }
}

// ============================================================================
// CLI
// ============================================================================

function main() {
  const files = getChangedFiles();
  const result = classifyFiles(files);

  // Write to stdout as JSON
  console.log(JSON.stringify(result, null, 2));

  // Write to GITHUB_OUTPUT if available
  writeGitHubOutput("tier", String(result.tier));
  writeGitHubOutput("tierName", result.tierName);
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
