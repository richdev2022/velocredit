// ============================================================================
// backend/server/reconciliation.ts
//
// Periodic reconciliation cron — runs every 5 minutes (and once on boot) to:
//   1. Repair stale loan-application statuses. Without this, a dropped or
//      out-of-order Flutterwave webhook can leave an application stuck at
//      "DISBURSEMENT_PENDING" or "UNDER_REVIEW" indefinitely even after the
//      loan has been disbursed.
//   2. Re-verify pending disbursements with Flutterwave and flip the loan +
//      application to ACTIVE when the transfer has settled. This closes the
//      gap when the disbursement route returned verification.settled=false
//      (Flutterwave was slow to confirm) but the transfer later succeeded.
//
// The cron is safe to run concurrently — `synchronizeLoanApplicationStatus`
// is idempotent and only writes when the application status actually changes.
// ============================================================================

import { loanApplications, loanDisbursements, loans, persistStore } from "./store.js";
import { synchronizeLoanApplicationStatus } from "./routes.js";
import { verifyTransferWithRetry } from "./providers/flutterwave.js";

let reconciliationRunning = false;

async function reverifyPendingDisbursements(): Promise<number> {
  let flipped = 0;
  // Find disbursements in PENDING/PROCESSING state that have a provider reference.
  const pendingDisbursements = loanDisbursements.filter(
    (d) => (d.status === "PENDING" || d.status === "PROCESSING") && d.providerReference,
  );
  for (const disbursement of pendingDisbursements) {
    try {
      const transferId = String(
        (disbursement.providerTransfer as { data?: { id?: number | string } })?.data?.id ?? "",
      );
      const reference = String(disbursement.providerReference ?? "");
      const verification = await verifyTransferWithRetry(
        transferId,
        reference,
        1, // single attempt — cron will retry on the next run
        500,
        Number(disbursement.amountNaira),
      );
      if (verification.settled) {
        const settledAt = new Date().toISOString();
        const loan = loans.find((l) => l.id === disbursement.loanId);
        if (loan && loan.status !== "ACTIVE" && loan.status !== "REPAID") {
          loan.status = "ACTIVE";
          loan.disbursedAt = loan.disbursedAt ?? settledAt;
          loan.updatedAt = settledAt;
          const application = loanApplications.find(
            (a) => a.id === loan.applicationId || a.applicationId === loan.applicationId,
          );
          if (application) {
            application.status = "ACTIVE";
            application.updatedAt = settledAt;
          }
          disbursement.status = "SUCCESSFUL";
          disbursement.processedAt = settledAt;
          disbursement.updatedAt = settledAt;
          flipped += 1;
        }
      } else if (verification.status === "failed") {
        // Transfer failed at the provider — mark the disbursement as FAILED
        // so the admin can retry. Don't flip the loan to ACTIVE.
        disbursement.status = "FAILED";
        disbursement.updatedAt = new Date().toISOString();
        disbursement.error = `Flutterwave reported transfer failed during reconciliation sweep`;
        flipped += 1;
      }
    } catch (error) {
      console.error("[reconciliation] disbursement re-verify failed", disbursement.id, error);
    }
  }
  return flipped;
}

export async function runLoanReconciliationSweep(): Promise<{ changed: number; total: number }> {
  if (reconciliationRunning) return { changed: 0, total: loanApplications.length };
  reconciliationRunning = true;
  try {
    // Phase 1: re-verify pending disbursements with Flutterwave (may flip loans to ACTIVE).
    const disbursementFlips = await reverifyPendingDisbursements();

    // Phase 2: synchronize application statuses with loan statuses.
    let changed = 0;
    for (const application of loanApplications) {
      try {
        const didChange = synchronizeLoanApplicationStatus(application);
        if (didChange) changed += 1;
      } catch (error) {
        console.error("[reconciliation] failed for application", application.id, error);
      }
    }

    const totalChanged = changed + disbursementFlips;
    if (totalChanged > 0) {
      try {
        await persistStore();
      } catch (error) {
        console.error("[reconciliation] persistStore failed:", error);
      }
      console.log(
        `[reconciliation] updated ${totalChanged} record(s) — ${disbursementFlips} disbursement flip(s), ${changed} application status(es)`,
      );
    }
    return { changed: totalChanged, total: loanApplications.length };
  } finally {
    reconciliationRunning = false;
  }
}

/** Register the periodic reconciliation cron. Safe to call multiple times. */
export function startReconciliationCron(intervalMs = 5 * 60 * 1000): void {
  // Run once shortly after boot (give the server time to finish startup work).
  setTimeout(() => { void runLoanReconciliationSweep(); }, 30_000).unref();
  // Then on a fixed interval.
  setInterval(() => { void runLoanReconciliationSweep(); }, intervalMs).unref();
}
