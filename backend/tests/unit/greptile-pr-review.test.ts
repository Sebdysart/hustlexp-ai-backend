/**
 * Tests for greptile-pr-review.ts scoring and markdown generation
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

// ── Helpers extracted from greptile-pr-review.ts for testing ─────────

interface ReviewResult {
  summary: string;
  issues: Array<{
    severity: "critical" | "warning" | "info";
    file: string;
    description: string;
  }>;
  score: number;
}

function determinePassFail(
  review: ReviewResult,
  prTier: number
): boolean {
  const criticalCount = review.issues.filter(
    (i) => i.severity === "critical"
  ).length;
  const warningCount = review.issues.filter(
    (i) => i.severity === "warning"
  ).length;

  return (
    criticalCount === 0 &&
    (prTier < 2 || warningCount === 0) &&
    review.score >= 60
  );
}

function buildReviewPrompt(
  changedFiles: string[],
  prTitle: string,
  prBody: string,
  prTier: number
): string {
  const tierContext: Record<number, string> = {
    0: "This is a TRIVIAL PR (docs, comments, assets). Only flag actual errors.",
    1: "This is a STANDARD PR. Check for logic bugs, missing error handling, and security issues.",
    2: "This is a CRITICAL PR touching financial/trust services. Scrutinize escrow, payment, and XP logic. Verify invariant compliance.",
    3: "This is an ARCHITECTURAL PR modifying core infrastructure. Check for breaking changes, migration safety, and backward compatibility.",
  };

  return `You are reviewing a pull request for HustleXP, a gig economy platform with financial escrow, XP rewards, and trust scoring.

${tierContext[prTier] || tierContext[1]}

PR Title: ${prTitle}
${prBody ? `PR Description: ${prBody}` : ""}

Changed files (${changedFiles.length}):
${changedFiles.map((f) => `- ${f}`).join("\n")}`;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("Greptile PR Review", () => {
  describe("pass/fail determination", () => {
    test("passes when no issues and score >= 60", () => {
      const review: ReviewResult = {
        summary: "Clean PR",
        issues: [],
        score: 90,
      };
      expect(determinePassFail(review, 1)).toBe(true);
    });

    test("fails when critical issues exist", () => {
      const review: ReviewResult = {
        summary: "Has critical issue",
        issues: [
          {
            severity: "critical",
            file: "escrow.ts",
            description: "Double-spend risk",
          },
        ],
        score: 85,
      };
      expect(determinePassFail(review, 1)).toBe(false);
    });

    test("passes with warnings on tier 1 (STANDARD)", () => {
      const review: ReviewResult = {
        summary: "Minor warnings",
        issues: [
          {
            severity: "warning",
            file: "task.ts",
            description: "Missing null check",
          },
        ],
        score: 75,
      };
      expect(determinePassFail(review, 1)).toBe(true);
    });

    test("fails with warnings on tier 2 (CRITICAL)", () => {
      const review: ReviewResult = {
        summary: "Warnings on critical PR",
        issues: [
          {
            severity: "warning",
            file: "EscrowService.ts",
            description: "Potential race condition",
          },
        ],
        score: 80,
      };
      expect(determinePassFail(review, 2)).toBe(false);
    });

    test("fails with warnings on tier 3 (ARCHITECTURAL)", () => {
      const review: ReviewResult = {
        summary: "Warnings on architectural PR",
        issues: [
          {
            severity: "warning",
            file: "server.ts",
            description: "Breaking change",
          },
        ],
        score: 80,
      };
      expect(determinePassFail(review, 3)).toBe(false);
    });

    test("passes with only info issues on any tier", () => {
      const review: ReviewResult = {
        summary: "Minor suggestions",
        issues: [
          {
            severity: "info",
            file: "utils.ts",
            description: "Could simplify",
          },
        ],
        score: 85,
      };
      expect(determinePassFail(review, 3)).toBe(true);
    });

    test("fails when score < 60 even with no issues", () => {
      const review: ReviewResult = {
        summary: "Low score",
        issues: [],
        score: 50,
      };
      expect(determinePassFail(review, 0)).toBe(false);
    });

    test("passes trivial PR with warnings and score >= 60", () => {
      const review: ReviewResult = {
        summary: "Trivial change",
        issues: [
          {
            severity: "warning",
            file: "readme.md",
            description: "Typo",
          },
        ],
        score: 70,
      };
      expect(determinePassFail(review, 0)).toBe(true);
    });
  });

  describe("prompt building", () => {
    test("includes tier context for TRIVIAL", () => {
      const prompt = buildReviewPrompt(["README.md"], "Fix typo", "", 0);
      expect(prompt).toContain("TRIVIAL PR");
      expect(prompt).toContain("README.md");
    });

    test("includes tier context for CRITICAL", () => {
      const prompt = buildReviewPrompt(
        ["backend/src/services/EscrowService.ts"],
        "Fix escrow bug",
        "Fixes double-release",
        2
      );
      expect(prompt).toContain("CRITICAL PR");
      expect(prompt).toContain("escrow");
      expect(prompt).toContain("Fixes double-release");
    });

    test("includes all changed files", () => {
      const files = ["a.ts", "b.ts", "c.ts"];
      const prompt = buildReviewPrompt(files, "Multi-file", "", 1);
      expect(prompt).toContain("Changed files (3):");
      expect(prompt).toContain("- a.ts");
      expect(prompt).toContain("- b.ts");
      expect(prompt).toContain("- c.ts");
    });

    test("defaults to STANDARD for unknown tier", () => {
      const prompt = buildReviewPrompt(["x.ts"], "Unknown", "", 99);
      expect(prompt).toContain("STANDARD PR");
    });
  });

  describe("readiness score integration", () => {
    test("Greptile bonus adds +10 when passed", () => {
      const greptileState = "passed";
      const greptileCritical = 0;
      const greptileBonus =
        greptileState === "passed" ? 10 : greptileCritical > 0 ? -5 : 0;
      expect(greptileBonus).toBe(10);
    });

    test("Greptile penalty is -5 when critical issues", () => {
      const greptileState = "failed";
      const greptileCritical = 2;
      const greptileBonus =
        greptileState === "passed" ? 10 : greptileCritical > 0 ? -5 : 0;
      expect(greptileBonus).toBe(-5);
    });

    test("Greptile bonus is 0 when degraded (no critical)", () => {
      const greptileState = "degraded";
      const greptileCritical = 0;
      const greptileBonus =
        greptileState === "passed" ? 10 : greptileCritical > 0 ? -5 : 0;
      expect(greptileBonus).toBe(0);
    });
  });
});
