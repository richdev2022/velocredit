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
  creditScores,
  users,
  loans,
  repayments,
  kycCases,
  persistStore,
} from "./store.js";
import { requestCreditReport } from "./providers/prembly.js";
import { calculateCreditScore } from "./credit.js";

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
        const kyc = kycCases.find((k) => k.userId === report.userId);
        const kycBvnData = (kyc?.providerRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data ?? {};
        const bvnFullName: string | undefined =
          [kycBvnData.title ? `${String(kycBvnData.title)} ` : "", kycBvnData.firstName, kycBvnData.middleName ? `${String(kycBvnData.middleName)} ` : "", kycBvnData.lastName]
            .filter(Boolean).join(" ") || undefined;
        const bvnDob: string | undefined = typeof kycBvnData.dateOfBirth === "string" ? kycBvnData.dateOfBirth : undefined;
        const hasBvn = typeof kyc?.bvn === "string" && kyc.bvn.length === 11;

        const cbResult = await requestCreditReport(
          hasBvn
            ? { mode: "ID", number: kyc!.bvn!, customer_name: bvnFullName ?? user.fullName, dob: bvnDob ?? user.dateOfBirth }
            : { mode: "BIO", customer_name: user.fullName, dob: user.dateOfBirth }
        );

        retried += 1;
        const cbRaw = cbResult.rawResponse ?? {};
        const cbScore: number | undefined =
          typeof (cbResult.normalizedFields as { score?: unknown } | undefined)?.score === "number"
            ? ((cbResult.normalizedFields as { score: number }).score as number)
            : typeof (cbRaw as { score?: unknown }).score === "number"
            ? (cbRaw as { score: number }).score
            : undefined;
        const cbStatus: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED" =
          cbResult.status === "SUCCESS"
            ? "RECEIVED"
            : cbResult.status === "PENDING" || cbResult.status === "MANUAL_REVIEW"
            ? "PENDING"
            : "FAILED";

        if (cbStatus === "PENDING") {
          // Still pending — leave the row alone, will retry next cron run.
          continue;
        }

        report.status = cbStatus;
        report.score = cbScore;
        report.normalizedFields = cbResult.normalizedFields;
        report.redactedRaw = cbRaw;
        report.reportReference = cbResult.providerReference ?? report.reportReference;
        report.requestedAt = new Date().toISOString();

        if (cbStatus === "RECEIVED") {
          resolved += 1;
          // Recompute the user's internal credit score with the new bureau score.
          if (cbScore != null) {
            const idx = creditScores.findIndex((s) => s.userId === report.userId);
            if (idx >= 0) {
              const recomputed = calculateCreditScore({
                completedLoans: loans.filter((item) => item.borrowerId === report.userId && item.status === "REPAID").length,
                onTimePayments: repayments.filter((item) => item.borrowerId === report.userId && item.status === "SUCCESSFUL" && item.onTime === true).length,
                latePayments: repayments.filter((item) => item.borrowerId === report.userId && item.status === "SUCCESSFUL" && item.onTime === false).length,
                defaultedLoans: loans.filter((item) => item.borrowerId === report.userId && item.status === "DEFAULTED").length,
                outstandingMinor: loans.reduce((sum, item) => sum + Math.round(Number(item.outstandingNaira ?? 0) * 100), 0),
                totalBorrowedMinor: loans.reduce((sum, item) => sum + Math.round(Number(item.principalNaira ?? 0) * 100), 0),
                kycVerified: user.kycStatus === "VERIFIED",
                bureauScore: cbScore,
              });
              creditScores[idx] = { ...creditScores[idx], score: recomputed.score, band: recomputed.band, factors: recomputed.factors, createdAt: recomputed.calculatedAt };
            }
          }
        } else if (cbStatus === "FAILED") {
          failed += 1;
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
  setTimeout(() => { void runCreditReportReconciliationSweep(); }, 60_000).unref();
  setInterval(() => { void runCreditReportReconciliationSweep(); }, intervalMs).unref();
}
