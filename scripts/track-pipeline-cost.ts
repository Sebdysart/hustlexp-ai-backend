/**
 * track-pipeline-cost.ts
 *
 * Records pipeline execution metadata as a JSON artifact for cost tracking.
 * Reads from environment variables set during the CI run and writes
 * pipeline-cost.json for upload as a workflow artifact.
 *
 * Env vars:
 *   PR_NUMBER      - Pull request number
 *   PR_TIER        - Classification tier (0-3)
 *   GATES_EXECUTED - Comma-separated list of gates that ran
 *   PIPELINE_START - ISO timestamp when pipeline started
 */

import * as fs from "fs";

interface PipelineCostRecord {
  prNumber: string;
  tier: number;
  gatesExecuted: string[];
  startedAt: string;
  completedAt: string;
  ciMinutes: number;
}

function main() {
  const prNumber = process.env.PR_NUMBER ?? "unknown";
  const tier = parseInt(process.env.PR_TIER ?? "1", 10);
  const gatesExecuted = (process.env.GATES_EXECUTED ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  const startedAt = process.env.PIPELINE_START ?? new Date().toISOString();
  const completedAt = new Date().toISOString();

  // Calculate duration in minutes
  const startMs = new Date(startedAt).getTime();
  const endMs = new Date(completedAt).getTime();
  const ciMinutes = Math.round(((endMs - startMs) / 60_000) * 100) / 100;

  const record: PipelineCostRecord = {
    prNumber,
    tier,
    gatesExecuted,
    startedAt,
    completedAt,
    ciMinutes: isNaN(ciMinutes) ? 0 : ciMinutes,
  };

  const json = JSON.stringify(record, null, 2);
  fs.writeFileSync("pipeline-cost.json", json, "utf-8");

  console.log("Pipeline cost record written to pipeline-cost.json:");
  console.log(json);
}

main();
