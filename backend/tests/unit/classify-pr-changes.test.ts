/**
 * Unit tests for PR change classifier.
 *
 * Tests the deterministic tier classification logic without
 * calling git or reading env vars.
 */
import { describe, it, expect } from "vitest";
import { classifyFiles } from "../../../scripts/classify-pr-changes";

describe("classifyFiles", () => {
  // ─── Tier 0: TRIVIAL ────────────────────────────────────────────────
  it("pure markdown changes -> tier 0 TRIVIAL", () => {
    const result = classifyFiles(["README.md", "docs/architecture.md"]);
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("TRIVIAL");
    expect(result.mergeThreshold).toBe(40);
    expect(result.skipGates).toContain("holodeck");
    expect(result.skipGates).toContain("invariants");
    expect(result.skipGates).toContain("tdad");
  });

  it("image files -> tier 0 TRIVIAL", () => {
    const result = classifyFiles(["assets/logo.png", "docs/diagram.svg"]);
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("TRIVIAL");
  });

  it("non-orchestrator GitHub workflow -> tier 0 TRIVIAL", () => {
    const result = classifyFiles([".github/workflows/ci.yml"]);
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("TRIVIAL");
  });

  it("LICENSE file -> tier 0 TRIVIAL", () => {
    const result = classifyFiles(["LICENSE"]);
    expect(result.tier).toBe(0);
  });

  it(".gitignore -> tier 0 TRIVIAL", () => {
    const result = classifyFiles([".gitignore"]);
    expect(result.tier).toBe(0);
  });

  // ─── Tier 1: STANDARD ───────────────────────────────────────────────
  it("router changes -> tier 1 STANDARD", () => {
    const result = classifyFiles(["backend/src/routers/taskRouter.ts"]);
    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("STANDARD");
    expect(result.mergeThreshold).toBe(80);
    expect(result.skipGates).toEqual([]);
  });

  it("middleware changes -> tier 1 STANDARD", () => {
    const result = classifyFiles(["backend/src/middleware/auth.ts"]);
    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("STANDARD");
  });

  it("test file changes -> tier 1 STANDARD", () => {
    const result = classifyFiles(["backend/tests/unit/foo.test.ts"]);
    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("STANDARD");
  });

  it("non-financial service -> tier 1 STANDARD", () => {
    const result = classifyFiles(["backend/src/services/NotificationService.ts"]);
    expect(result.tier).toBe(1);
    expect(result.tierName).toBe("STANDARD");
  });

  // ─── Tier 2: CRITICAL ───────────────────────────────────────────────
  it("EscrowService changes -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/services/EscrowService.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
    expect(result.mergeThreshold).toBe(90);
    expect(result.skipGates).toEqual([]);
  });

  it("Ledger file -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/services/LedgerService.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
  });

  it("Payment file -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/routers/PaymentRouter.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
  });

  it("Trust file -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/services/TrustService.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
  });

  it("XP file -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/services/XPService.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
  });

  it("Stripe file -> tier 2 CRITICAL", () => {
    const result = classifyFiles(["backend/src/services/StripeService.ts"]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
  });

  it("case-insensitive financial match -> tier 2", () => {
    const result = classifyFiles(["backend/src/services/escrowHelpers.ts"]);
    expect(result.tier).toBe(2);
  });

  // ─── Tier 3: ARCHITECTURAL ──────────────────────────────────────────
  it("migration files -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["migrations/001_initial.sql"]);
    expect(result.tier).toBe(3);
    expect(result.tierName).toBe("ARCHITECTURAL");
    expect(result.mergeThreshold).toBe(95);
  });

  it("server.ts -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["backend/src/server.ts"]);
    expect(result.tier).toBe(3);
    expect(result.tierName).toBe("ARCHITECTURAL");
  });

  it("config.ts -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["backend/src/config.ts"]);
    expect(result.tier).toBe(3);
  });

  it("trpc.ts -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["backend/src/trpc.ts"]);
    expect(result.tier).toBe(3);
  });

  it("orchestrator.yml -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles([".github/workflows/orchestrator.yml"]);
    expect(result.tier).toBe(3);
    expect(result.tierName).toBe("ARCHITECTURAL");
  });

  it("Dockerfile -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["Dockerfile"]);
    expect(result.tier).toBe(3);
  });

  it("docker-compose.yml -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["docker-compose.yml"]);
    expect(result.tier).toBe(3);
  });

  it("infrastructure files -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["infrastructure/terraform/main.tf"]);
    expect(result.tier).toBe(3);
  });

  it("database directory -> tier 3 ARCHITECTURAL", () => {
    const result = classifyFiles(["backend/database/schema.sql"]);
    expect(result.tier).toBe(3);
  });

  // ─── Mixed tiers (highest wins) ─────────────────────────────────────
  it("README + EscrowService -> tier 2 (highest wins)", () => {
    const result = classifyFiles([
      "README.md",
      "backend/src/services/EscrowService.ts",
    ]);
    expect(result.tier).toBe(2);
    expect(result.tierName).toBe("CRITICAL");
    expect(result.fileCount).toBe(2);
    expect(result.skipGates).toEqual([]);
  });

  it("migration + router -> tier 3 (highest wins)", () => {
    const result = classifyFiles([
      "migrations/002_add_index.sql",
      "backend/src/routers/taskRouter.ts",
    ]);
    expect(result.tier).toBe(3);
    expect(result.tierName).toBe("ARCHITECTURAL");
  });

  it("trivial + standard -> tier 1", () => {
    const result = classifyFiles([
      "README.md",
      "backend/src/middleware/auth.ts",
    ]);
    expect(result.tier).toBe(1);
    expect(result.skipGates).toEqual([]);
  });

  // ─── Edge cases ─────────────────────────────────────────────────────
  it("empty file list -> tier 0 TRIVIAL", () => {
    const result = classifyFiles([]);
    expect(result.tier).toBe(0);
    expect(result.tierName).toBe("TRIVIAL");
    expect(result.fileCount).toBe(0);
    expect(result.skipGates).toContain("holodeck");
  });

  it("unknown file type defaults to tier 1", () => {
    const result = classifyFiles(["some-random-file.xyz"]);
    expect(result.tier).toBe(1);
  });

  it("justification includes all files", () => {
    const result = classifyFiles([
      "README.md",
      "backend/src/services/EscrowService.ts",
    ]);
    expect(result.tierJustification).toHaveLength(2);
    expect(result.tierJustification[0]).toContain("README.md");
    expect(result.tierJustification[1]).toContain("EscrowService.ts");
  });
});
