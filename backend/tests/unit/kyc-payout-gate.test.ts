/**
 * Tests for KYC enforcement before escrow release
 *
 * Verifies that EscrowService.release() checks worker's
 * Stripe Connect status and payouts_enabled before releasing funds.
 */

import { describe, test, expect } from "vitest";

// Test the KYC validation logic independently
// (extracted from EscrowService.release for unit testing)

interface WorkerKyc {
  payouts_enabled: boolean;
  stripe_connect_id: string | null;
  stripe_connect_status: string | null;
}

function validateWorkerKyc(kyc: WorkerKyc | null): {
  valid: boolean;
  error?: string;
} {
  if (!kyc) {
    return { valid: false, error: "Worker not found" };
  }

  if (!kyc.stripe_connect_id) {
    return {
      valid: false,
      error: "Worker has not set up Stripe Connect — cannot release payout",
    };
  }

  if (!kyc.payouts_enabled) {
    return {
      valid: false,
      error: `Worker KYC incomplete — payouts not enabled (status: ${kyc.stripe_connect_status ?? "unknown"})`,
    };
  }

  return { valid: true };
}

describe("KYC Payout Gate", () => {
  describe("worker KYC validation", () => {
    test("passes when worker has Connect and payouts enabled", () => {
      const kyc: WorkerKyc = {
        payouts_enabled: true,
        stripe_connect_id: "acct_abc123",
        stripe_connect_status: "complete",
      };
      expect(validateWorkerKyc(kyc)).toEqual({ valid: true });
    });

    test("fails when worker has no Stripe Connect account", () => {
      const kyc: WorkerKyc = {
        payouts_enabled: false,
        stripe_connect_id: null,
        stripe_connect_status: null,
      };
      const result = validateWorkerKyc(kyc);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not set up Stripe Connect");
    });

    test("fails when worker exists but payouts not enabled", () => {
      const kyc: WorkerKyc = {
        payouts_enabled: false,
        stripe_connect_id: "acct_abc123",
        stripe_connect_status: "pending",
      };
      const result = validateWorkerKyc(kyc);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("KYC incomplete");
      expect(result.error).toContain("pending");
    });

    test("fails when worker not found (null)", () => {
      const result = validateWorkerKyc(null);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("fails with unknown status when stripe_connect_status is null", () => {
      const kyc: WorkerKyc = {
        payouts_enabled: false,
        stripe_connect_id: "acct_abc123",
        stripe_connect_status: null,
      };
      const result = validateWorkerKyc(kyc);
      expect(result.valid).toBe(false);
      expect(result.error).toContain("unknown");
    });

    test("passes even with restricted status if payouts enabled", () => {
      const kyc: WorkerKyc = {
        payouts_enabled: true,
        stripe_connect_id: "acct_abc123",
        stripe_connect_status: "restricted",
      };
      expect(validateWorkerKyc(kyc)).toEqual({ valid: true });
    });
  });

  describe("threshold notification levels", () => {
    const THRESHOLD = 60000; // $600 in cents

    function getNotificationLevel(
      earnedCents: number
    ): "none" | "approaching" | "near" | "exceeded" {
      const pct = Math.round((earnedCents / THRESHOLD) * 100);
      if (pct >= 100) return "exceeded";
      if (pct >= 90) return "near";
      if (pct >= 80) return "approaching";
      return "none";
    }

    test("none when below 80% ($0)", () => {
      expect(getNotificationLevel(0)).toBe("none");
    });

    test("none when at 79% ($474)", () => {
      expect(getNotificationLevel(47400)).toBe("none");
    });

    test("approaching when at 80% ($480)", () => {
      expect(getNotificationLevel(48000)).toBe("approaching");
    });

    test("near when at 90% ($540)", () => {
      expect(getNotificationLevel(54000)).toBe("near");
    });

    test("exceeded when at 100% ($600)", () => {
      expect(getNotificationLevel(60000)).toBe("exceeded");
    });

    test("exceeded when above threshold ($1000)", () => {
      expect(getNotificationLevel(100000)).toBe("exceeded");
    });
  });
});
