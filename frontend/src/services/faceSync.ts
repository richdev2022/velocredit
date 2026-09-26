import type { FaceComparisonStatus } from "./apiClient";

/* ==========================================================================
   Live desktop↔phone handoff state machine (pure, unit-tested).

   While the desktop shows the QR code, it polls GET /me/kyc/face-comparison/
   status every few seconds and maps the payload onto this UI state:

     waiting        no verdict from the phone yet — keep listening
     success        the phone selfie passed — desktop shows success instantly
     failed         the phone attempt did not match — show why, keep listening
                    (the phone can retake; the desktop auto-updates)
     manual-review  the phone submitted the case for manual review
   ========================================================================== */

export type PhoneSyncState =
  | { kind: "waiting" }
  | { kind: "failed"; confidence?: number; message: string }
  | { kind: "success" }
  | { kind: "manual-review" };

export function resolvePhoneSync(status: FaceComparisonStatus | null | undefined): PhoneSyncState {
  if (!status) return { kind: "waiting" };
  const attemptStatus = status.lastAttempt?.status?.toUpperCase();
  if (status.pendingManualReview || attemptStatus === "MANUAL_REVIEW" || attemptStatus === "PENDING_REVIEW") {
    return { kind: "manual-review" };
  }
  if (status.checklistLiveness || status.livenessStatus === "SUCCESS" || attemptStatus === "SUCCESS") {
    return { kind: "success" };
  }
  if (attemptStatus === "FAILED") {
    return {
      kind: "failed",
      confidence: status.lastAttempt?.matchScore ?? undefined,
      message: status.reason || "The selfie taken on the phone did not match the identity record.",
    };
  }
  return { kind: "waiting" };
}
