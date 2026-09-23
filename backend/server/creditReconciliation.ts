// ============================================================================
// backend/server/creditReconciliation.ts
//
// Periodic cron — runs every 10 minutes (and once on boot) to retry PENDING
// credit bureau reports from Prembly. Without this, a credit report that
// returned PENDING at submission time (Prembly was slow to confirm) would
// stay PENDING forever, leaving the admin credit report card stuck on
// "PENDING" with no path to resolution.
//
// For each PENDING credit report, the cron:
//   1. Looks up the borrower's BVN + name + DOB
//   2. Re-requests the credit report from Prembly
//   3. If the new report comes back RECEIVED, updates the existing PENDING
//      row in place (preserving the original id + consentGrantedAt) and
//      recomputes the user's internal credit score with the new bureau score.
//   4. If the new report also returns PENDING, leaves the row alone (will
//      retry on the next cron run).
//   5. If the new report returns FAILED, marks the row as FAILED so admin
//      can see the provider returned an error.
// ============================================================================

import {
  creditReports,
  users,
  persistStore,
} from "./store.js";
import {
  retryCreditReport,
  mapProviderStatus,
  extractReportScore,
  recomputeInternalCreditScore,
  syncApplicationCreditSnapshots,
} from "./creditBureau.js";
import type { VerificationResult } from "./providers/prembly.js";

let creditReconRunning = false;

export async function runCreditReportReconciliationSweep(): Promise<{ retried: number; resolved: number; failed: number }> {
  if (creditReconRunning) return { retried: 0, resolved: 0, failed: 0 };
  creditReconRunning = true;
  try {
    const pendingReports = creditReports.filter((r) => r.status === "PENDING");
    if (pendingReports.length === 0) return { retried: 0, resolved: 0, failed: 0 };

    let resolved = 0;
    let failed = 0;
    let retried = 0;

    for (const report of pendingReports) {
      try {
        const user = users.find((u) => u.id === report.userId);
        if (!user) {
          report.status = "FAILED";
          failed += 1;
          continue;
        }

        // Commercial reports retry with the RC number + company name stored
        // in the report; consumer reports re-resolve the borrower's BVN +
        // name + DOB (both handled inside retryCreditReport).
        const cbResult: VerificationResult = await retryCreditReport(report);

        retried += 1;
        const cbRaw = cbResult.rawResponse ?? {};
        const cbScore = extractReportScore(cbResult);
        const cbStatus = mapProviderStatus(cbResult.status);

        if (cbStatus === "PENDING") {
          // Still pending — leave the row alone, will retry next cron run.
          continue;
        }

        report.status = cbStatus;
        report.score = cbScore;
        report.normalizedFields = {
          ...(cbResult.normalizedFields ?? {}),
          ...(cbResult.errorMessage ? { reason: cbResult.errorMessage } : {}),
        };
        report.redactedRaw = cbRaw;
        report.reportReference = cbResult.providerReference ?? report.reportReference;
        report.requestedAt = new Date().toISOString();

        if (cbStatus === "RECEIVED") {
          resolved += 1;
          // Recompute the user's internal credit score with the new bureau
          // score and refresh the loan application credit snapshots.
          const internal = recomputeInternalCreditScore(report.userId, cbScore ?? null);
          syncApplicationCreditSnapshots(report.userId, report, internal);
        } else if (cbStatus === "FAILED") {
          failed += 1;
          syncApplicationCreditSnapshots(report.userId, report, null);
        }
      } catch (error) {
        console.error("[creditRecon] failed for report", report.id, error);
      }
    }

    if (resolved > 0 || failed > 0) {
      try {
        await persistStore();
      } catch (error) {
        console.error("[creditRecon] persistStore failed:", error);
      }
      console.log(`[creditRecon] retried=${retried} resolved=${resolved} failed=${failed} of ${pendingReports.length} pending report(s)`);
    }
    return { retried, resolved, failed };
  } finally {
    creditReconRunning = false;
  }
}

/** Register the periodic credit-report reconciliation cron. Safe to call multiple times. */
export function startCreditReconciliationCron(intervalMs = 10 * 60 * 1000): void {
  // First sweep 30s after boot so reports left PENDING by a previous run (or
  // by a slow Prembly response during submission) are picked up quickly.
  setTimeout(() => { void runCreditReportReconciliationSweep(); }, 30_000).unref();
  setInterval(() => { void runCreditReportReconciliationSweep(); }, intervalMs).unref();
}
