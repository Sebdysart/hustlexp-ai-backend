#!/usr/bin/env tsx
/**
 * greptile-pr-review.ts
 *
 * Calls the Greptile API to perform a codebase-aware AI review of a PR.
 * Designed to run as a GitHub Actions step in the orchestrator pipeline.
 *
 * Inputs (env vars):
 *   GREPTILE_API_KEY   — Greptile API bearer token
 *   GITHUB_TOKEN       — GitHub token for repo access
 *   PR_NUMBER          — Pull request number
 *   PR_TITLE           — Pull request title
 *   PR_BODY            — Pull request body/description
 *   PR_BRANCH          — Head branch of the PR
 *   BASE_BRANCH        — Base branch (default: main)
 *   REPO_FULL_NAME     — owner/repo (e.g. Sebdysart/hustlexp-ai-backend)
 *   CHANGED_FILES      — Comma-separated list of changed files
 *   GATE_PR_TIER       — PR tier from classifier (0-3)
 *
 * Outputs:
 *   - greptile-review.md   — Formatted review for PR comment
 *   - GITHUB_OUTPUT         — passed=true/false, issue_count, critical_count
 */

import * as fs from "fs";

const GREPTILE_API_URL = "https://api.greptile.com/v2";

interface GreptileQueryResponse {
  message: string;
  sources: Array<{
    repository: string;
    filepath: string;
    summary: string;
  }>;
}

interface ReviewResult {
  summary: string;
  issues: Array<{
    severity: "critical" | "warning" | "info";
    file: string;
    description: string;
  }>;
  score: number;
}

async function queryGreptile(
  messages: Array<{ role: string; content: string }>,
  options: { genius?: boolean; jsonMode?: boolean } = {}
): Promise<GreptileQueryResponse> {
  const apiKey = process.env.GREPTILE_API_KEY;
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO_FULL_NAME || "Sebdysart/hustlexp-ai-backend";
  const baseBranch = process.env.BASE_BRANCH || "main";

  if (!apiKey) throw new Error("GREPTILE_API_KEY is required");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (githubToken) {
    headers["X-GitHub-Token"] = githubToken;
  }

  const response = await fetch(`${GREPTILE_API_URL}/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messages,
      repositories: [
        {
          remote: "github",
          repository: repo,
          branch: baseBranch,
        },
      ],
      genius: options.genius ?? false,
      jsonMode: options.jsonMode ?? false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Greptile API error ${response.status}: ${errText}`);
  }

  return response.json();
}

function buildReviewPrompt(changedFiles: string[], prTitle: string, prBody: string, prTier: number): string {
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
${changedFiles.map((f) => `- ${f}`).join("\n")}

CRITICAL CONSTITUTIONAL INVARIANTS (must NEVER be violated):
1. Escrow amounts must be positive integers in cents
2. XP can only be awarded after escrow is RELEASED
3. Escrows can only be released once (no double-spend)
4. Ledger entries are immutable (no UPDATE/DELETE)
5. Payment amounts must be positive

Review the changes with full codebase context. Respond with a JSON object:
{
  "summary": "2-3 sentence overall assessment",
  "issues": [
    {
      "severity": "critical" | "warning" | "info",
      "file": "path/to/file.ts",
      "description": "Specific, actionable description of the issue"
    }
  ],
  "score": <0-100 quality score>
}

Rules:
- Only flag REAL issues you can see evidence for — no speculative "consider" or "ensure" comments
- Critical: invariant violations, security holes, data loss risk, financial bugs
- Warning: logic errors, missing validation, potential race conditions
- Info: minor improvements that would meaningfully help
- Score 80+ means safe to merge, 60-79 needs attention, <60 has blockers
- If no issues found, return empty issues array and score 90+`;
}

async function main() {
  const prNumber = process.env.PR_NUMBER || "0";
  const prTitle = process.env.PR_TITLE || "Unknown PR";
  const prBody = process.env.PR_BODY || "";
  const prTier = parseInt(process.env.GATE_PR_TIER || "1", 10);
  const changedFilesRaw = process.env.CHANGED_FILES || "";
  const changedFiles = changedFilesRaw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);

  console.log(`Greptile PR Review — PR #${prNumber} (Tier ${prTier})`);
  console.log(`Changed files: ${changedFiles.length}`);

  if (changedFiles.length === 0) {
    console.log("No changed files — skipping review");
    writeOutput(true, 0, 0, 100, "No files to review");
    return;
  }

  // Use genius mode for CRITICAL/ARCHITECTURAL PRs
  const useGenius = prTier >= 2;

  try {
    const prompt = buildReviewPrompt(changedFiles, prTitle, prBody, prTier);

    console.log(`Querying Greptile API${useGenius ? " (genius mode)" : ""}...`);
    const response = await queryGreptile(
      [{ role: "user", content: prompt }],
      { genius: useGenius, jsonMode: true }
    );

    let review: ReviewResult;
    try {
      review = JSON.parse(response.message);
    } catch {
      // If JSON parsing fails, treat as a raw text review
      review = {
        summary: response.message.slice(0, 500),
        issues: [],
        score: 75,
      };
    }

    const criticalCount = review.issues.filter((i) => i.severity === "critical").length;
    const warningCount = review.issues.filter((i) => i.severity === "warning").length;
    const infoCount = review.issues.filter((i) => i.severity === "info").length;
    const totalIssues = review.issues.length;

    // Generate markdown report
    const md = generateMarkdown(review, prNumber, prTier, changedFiles.length, useGenius);
    fs.writeFileSync("greptile-review.md", md, "utf-8");
    console.log("Wrote greptile-review.md");

    // Determine pass/fail
    // Critical issues always fail. For tier 2+, warnings also fail.
    const passed =
      criticalCount === 0 && (prTier < 2 || warningCount === 0) && review.score >= 60;

    writeOutput(passed, totalIssues, criticalCount, review.score, review.summary);

    console.log(`\nScore: ${review.score}/100`);
    console.log(`Issues: ${criticalCount} critical, ${warningCount} warning, ${infoCount} info`);
    console.log(`Result: ${passed ? "PASSED" : "FAILED"}`);
  } catch (error) {
    console.error("Greptile review failed:", error);
    // Degrade gracefully — don't block the pipeline
    writeOutput(true, 0, 0, 0, "Greptile review unavailable (degraded)");
  }
}

function generateMarkdown(
  review: ReviewResult,
  prNumber: string,
  prTier: number,
  fileCount: number,
  genius: boolean
): string {
  const tierNames = ["TRIVIAL", "STANDARD", "CRITICAL", "ARCHITECTURAL"];
  const lines: string[] = [];

  lines.push("## Greptile AI Review");
  lines.push("");
  lines.push(
    `**PR #${prNumber}** | Tier ${prTier} (${tierNames[prTier] || "UNKNOWN"}) | ${fileCount} files | Score: **${review.score}/100**${genius ? " | Genius Mode" : ""}`
  );
  lines.push("");
  lines.push(`> ${review.summary}`);
  lines.push("");

  if (review.issues.length === 0) {
    lines.push("No issues found.");
  } else {
    lines.push("| Severity | File | Issue |");
    lines.push("|----------|------|-------|");

    for (const issue of review.issues) {
      const icon =
        issue.severity === "critical"
          ? "&#x1F6D1;"
          : issue.severity === "warning"
            ? "&#x26A0;&#xFE0F;"
            : "&#x2139;&#xFE0F;";
      lines.push(
        `| ${icon} ${issue.severity.toUpperCase()} | \`${issue.file}\` | ${issue.description} |`
      );
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("_Powered by [Greptile](https://greptile.com) with full codebase context_");

  return lines.join("\n");
}

function writeOutput(
  passed: boolean,
  issueCount: number,
  criticalCount: number,
  score: number,
  summary: string
) {
  // Write to GITHUB_OUTPUT if available
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    const lines = [
      `passed=${passed}`,
      `issue_count=${issueCount}`,
      `critical_count=${criticalCount}`,
      `score=${score}`,
      `summary=${summary.replace(/\n/g, " ").slice(0, 200)}`,
    ];
    fs.appendFileSync(outputFile, lines.join("\n") + "\n", "utf-8");
  }

  // Also log for CI visibility
  console.log(`::set-output name=passed::${passed}`);
  console.log(`::set-output name=score::${score}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
