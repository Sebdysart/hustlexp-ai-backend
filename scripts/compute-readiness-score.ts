/**
 * compute-readiness-score.ts
 *
 * Reads gate results from environment variables (set by the orchestrator workflow)
 * and computes a 100-point Readiness Score. Outputs a markdown table to
 * readiness-score.md for posting as a sticky PR comment.
 *
 * Scoring breakdown (110 base + bonuses):
 *   Knowledge Graph Context:  10 pts
 *   TDAD (Tests First):       25 pts
 *   TypeCheck + Lint:         15 pts
 *   Unit Tests:               20 pts
 *   Invariant Tests:          20 pts  (MANDATORY — without these, max is 80)
 *   Holodeck Deploy:          10 pts
 *   Greptile AI Review:       10 pts  (bonus — codebase-aware AI review)
 *
 * Merge threshold: 80/100
 */

import * as fs from "fs";

interface Gate {
  name: string;
  points: number;
  mandatory: boolean;
  passed: boolean;
  envKey: string;
}

function isGatePassed(envKey: string): boolean {
  const val = process.env[envKey] ?? "";
  // "true" or "success" means passed
  return val === "true" || val === "success";
}

// ── Tier-aware merge thresholds ──────────────────────────────────────
const TIER_THRESHOLDS: Record<number, number> = {
  0: 40,
  1: 80,
  2: 90,
  3: 95,
};

const TIER_NAMES: Record<number, string> = {
  0: "TRIVIAL",
  1: "STANDARD",
  2: "CRITICAL",
  3: "ARCHITECTURAL",
};

const prTier = parseInt(process.env.GATE_PR_TIER ?? "1", 10);
const prTierName = TIER_NAMES[prTier] ?? "UNKNOWN";

// ── Degradation override ─────────────────────────────────────────────
// If evaluate-degradation.ts flagged a critical service as blocked,
// the entire score is overridden regardless of individual gates.
const degradationBlocked = process.env.GATE_DEGRADATION_BLOCKED === "true";

// ── Gate state helper (supports three-tier: true / degraded / false)
function gateState(envKey: string): "passed" | "degraded" | "failed" {
  const val = process.env[envKey] ?? "";
  if (val === "true" || val === "success") return "passed";
  if (val === "degraded") return "degraded";
  return "failed";
}

// ── Migration safety: +15 bonus when present and safe, -30 penalty when unsafe
const migrationState = gateState("GATE_MIGRATION_SAFETY");
const migrationBonus =
  migrationState === "passed" ? 15 : migrationState === "failed" ? -30 : 0;

// ── Greptile AI Review: +10 bonus when passed, -5 when critical issues found
const greptileState = gateState("GATE_GREPTILE");
const greptileScore = parseInt(process.env.GATE_GREPTILE_SCORE ?? "0", 10);
const greptileCritical = parseInt(process.env.GATE_GREPTILE_CRITICAL ?? "0", 10);
const greptileBonus =
  greptileState === "passed" ? 10 : greptileCritical > 0 ? -5 : 0;

const gates: Gate[] = [
  {
    name: "Knowledge Graph Context",
    points: 10,
    mandatory: false,
    passed: isGatePassed("GATE_CONTEXT"),
    envKey: "GATE_CONTEXT",
  },
  {
    name: "TDAD (Tests First)",
    points: 25,
    mandatory: false,
    passed: isGatePassed("GATE_TDAD"),
    envKey: "GATE_TDAD",
  },
  {
    name: "TypeCheck + Lint",
    points: 15,
    mandatory: false,
    passed:
      isGatePassed("GATE_TYPECHECK") && isGatePassed("GATE_LINT"),
    envKey: "GATE_TYPECHECK + GATE_LINT",
  },
  {
    name: "Unit Tests",
    points: 20,
    mandatory: false,
    passed: isGatePassed("GATE_TESTS"),
    envKey: "GATE_TESTS",
  },
  {
    name: "Invariant Tests",
    points: 20,
    mandatory: true,
    passed: isGatePassed("GATE_INVARIANTS"),
    envKey: "GATE_INVARIANTS",
  },
  {
    name: "Holodeck Deploy",
    points: 10,
    mandatory: false,
    passed: isGatePassed("GATE_HOLODECK"),
    envKey: "GATE_HOLODECK",
  },
];

const totalPossible = gates.reduce((sum, g) => sum + g.points, 0);
const baseEarned = gates.reduce(
  (sum, g) => sum + (g.passed ? g.points : 0),
  0
);

// Apply migration safety + Greptile bonuses/penalties (clamped to 0..totalPossible)
const earnedPoints = Math.max(0, Math.min(totalPossible, baseEarned + migrationBonus + greptileBonus));

const MERGE_THRESHOLD = TIER_THRESHOLDS[prTier] ?? 80;

// Degradation override: if a critical service is blocked, merge is denied
const canMerge = degradationBlocked ? false : earnedPoints >= MERGE_THRESHOLD;

// Build the status icon
function icon(passed: boolean, mandatory: boolean): string {
  if (passed) return "&#x2705;"; // green check
  if (mandatory) return "&#x1F6D1;"; // stop sign
  return "&#x274C;"; // red X
}

// Build markdown output
const lines: string[] = [];

lines.push("## Readiness Score");
lines.push("");

if (degradationBlocked) {
  lines.push(
    `**BLOCKED** — Critical service degradation detected. Merge denied.`
  );
} else if (canMerge) {
  lines.push(
    `**${earnedPoints} / ${totalPossible}** — Ready to merge`
  );
} else {
  lines.push(
    `**${earnedPoints} / ${totalPossible}** — Below merge threshold (${MERGE_THRESHOLD})`
  );
}

lines.push("");
lines.push("| Gate | Points | Status | Mandatory |");
lines.push("|------|--------|--------|-----------|");
lines.push(`| PR Classification | Tier ${prTier} (${prTierName}) | — | Threshold: ${MERGE_THRESHOLD} |`);

for (const gate of gates) {
  const pts = gate.passed ? `+${gate.points}` : `0`;
  const status = icon(gate.passed, gate.mandatory);
  const mand = gate.mandatory ? "YES" : "No";
  lines.push(`| ${gate.name} | ${pts} / ${gate.points} | ${status} | ${mand} |`);
}

// Migration Safety row (bonus/penalty — not a standard gate)
if (migrationState !== "passed" || migrationBonus !== 0) {
  const migIcon = migrationState === "passed" ? "&#x2705;" : migrationState === "failed" ? "&#x1F6D1;" : "&#x2796;";
  const migPts = migrationBonus > 0 ? `+${migrationBonus}` : `${migrationBonus}`;
  lines.push(`| Migration Safety | ${migPts} | ${migIcon} | ${migrationState === "failed" ? "BLOCKING" : "Bonus"} |`);
}

// Greptile AI Review row (bonus/penalty)
if (greptileState !== "failed" || greptileBonus !== 0) {
  const greptileIcon = greptileState === "passed" ? "&#x2705;" : greptileCritical > 0 ? "&#x1F6D1;" : "&#x2796;";
  const greptilePts = greptileBonus > 0 ? `+${greptileBonus}` : `${greptileBonus}`;
  const greptileLabel = greptileCritical > 0
    ? `${greptileCritical} critical`
    : greptileScore > 0 ? `Score: ${greptileScore}/100` : "N/A";
  lines.push(`| Greptile AI Review | ${greptilePts} | ${greptileIcon} | ${greptileLabel} |`);
}

// Degradation override row
if (degradationBlocked) {
  lines.push(`| Degradation Override | BLOCKED | &#x1F6D1; | CRITICAL |`);
}

lines.push("");
lines.push(`**Merge threshold:** ${MERGE_THRESHOLD} / ${totalPossible}`);
lines.push("");

if (!canMerge) {
  const failedGates = gates.filter((g) => !g.passed);
  lines.push("### Blockers");
  lines.push("");
  for (const fg of failedGates) {
    lines.push(
      `- **${fg.name}** (-${fg.points} pts)${fg.mandatory ? " [MANDATORY]" : ""}`
    );
  }
  lines.push("");
}

// Tier justification from CHANGED_FILES
const changedFiles = (process.env.CHANGED_FILES ?? "").split(",").map(f => f.trim()).filter(Boolean);
if (changedFiles.length > 0) {
  lines.push("### Tier Justification");
  lines.push("");
  lines.push(`Classified as **Tier ${prTier} (${prTierName})** based on ${changedFiles.length} changed file(s).`);
  lines.push("");
}

lines.push("---");
lines.push("_Generated by the Orchestrator workflow_");

const markdown = lines.join("\n");

// Write to file for sticky PR comment
fs.writeFileSync("readiness-score.md", markdown, "utf-8");

// Log to stdout for CI visibility
console.log(markdown);
console.log("");
console.log(`Score: ${earnedPoints}/${totalPossible}`);
console.log(`Merge allowed: ${canMerge}`);

// Write outputs for GitHub Actions (consumed by orchestrator auto-merge gate)
const outputFile = process.env.GITHUB_OUTPUT;
if (outputFile) {
  fs.appendFileSync(outputFile, `total_score=${earnedPoints}\n`);
  fs.appendFileSync(outputFile, `meets_threshold=${canMerge}\n`);
}

// Exit with non-zero if below threshold (fails the workflow)
if (!canMerge) {
  console.error(
    `Readiness score ${earnedPoints} is below merge threshold ${MERGE_THRESHOLD}`
  );
  process.exit(1);
}
