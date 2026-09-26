import { describe, expect, it } from "vitest";
import { resolvePhoneSync } from "./faceSync";
import type { FaceComparisonStatus } from "./apiClient";

/* Live desktop↔phone handoff state machine — the desktop must react to the
   phone's verdict instantly and correctly, including retries after a failure. */

function status(overrides: Partial<FaceComparisonStatus> = {}): FaceComparisonStatus {
  return {
    ok: true,
    exists: true,
    livenessStatus: "NOT_STARTED",
    checklistLiveness: false,
    categoryStatus: null,
    reason: null,
    pendingManualReview: false,
    lastAttempt: null,
    selfieImageData: null,
    ...overrides,
  };
}

describe("resolvePhoneSync", () => {
  it("stays waiting when nothing happened yet", () => {
    expect(resolvePhoneSync(null)).toEqual({ kind: "waiting" });
    expect(resolvePhoneSync(status())).toEqual({ kind: "waiting" });
  });

  it("turns a SUCCESS attempt into instant success on the desktop", () => {
    const result = resolvePhoneSync(status({
      livenessStatus: "SUCCESS",
      checklistLiveness: true,
      lastAttempt: { status: "SUCCESS", matchScore: 92, provider: "prembly", at: "2026-09-26T10:00:00Z" },
    }));
    expect(result).toEqual({ kind: "success" });
  });

  it("treats a FAILED attempt as failed and carries the provider message + confidence", () => {
    const result = resolvePhoneSync(status({
      livenessStatus: "FAILED",
      reason: "Face comparison did not pass — try again or request a manual review",
      lastAttempt: { status: "FAILED", matchScore: 38, provider: "custom", at: "2026-09-26T10:00:00Z" },
    }));
    expect(result).toEqual({
      kind: "failed",
      confidence: 38,
      message: "Face comparison did not pass — try again or request a manual review",
    });
  });

  it("keeps waiting after a failure that has no readable reason", () => {
    const result = resolvePhoneSync(status({
      livenessStatus: "FAILED",
      lastAttempt: { status: "FAILED", matchScore: null, provider: "prembly", at: "2026-09-26T10:00:00Z" },
    }));
    expect(result.kind).toBe("failed");
    expect((result as { message: string }).message).toContain("did not match");
  });

  it("routes a manual-review submission to the manual-review state", () => {
    expect(resolvePhoneSync(status({ pendingManualReview: true }))).toEqual({ kind: "manual-review" });
    expect(resolvePhoneSync(status({
      livenessStatus: "PENDING_REVIEW",
      lastAttempt: { status: "MANUAL_REVIEW", matchScore: null, provider: "manual", at: "2026-09-26T10:00:00Z" },
    }))).toEqual({ kind: "manual-review" });
  });

  it("prefers success when the checklist is already approved", () => {
    const result = resolvePhoneSync(status({ checklistLiveness: true, livenessStatus: "SUCCESS" }));
    expect(result).toEqual({ kind: "success" });
  });
});
