// ============================================================================
// backend/server/reconciliation.ts
//
// Periodic reconciliation cron — runs every 15 minutes (and once on boot) to
// repair stale loan-application statuses. Without this, a dropped or
// out-of-order Flutterwave webhook can leave an application stuck at
// "DISBURSEMENT_PENDING" or "UNDER_REVIEW" indefinitely even after the loan
// has been disbursed and is in ACTIVE state.
//
// The cron is safe to run concurrently — `synchronizeLoanApplicationStatus`
// is idempotent and only writes when the application status actually changes.
// ============================================================================

import { loanApplications } from "./store.js";
import { synchronizeLoanApplicationStatus } from "./routes.js";
import { persistStore } from "./store.js";

let reconciliationRunning = false;

export async function runLoanReconciliationSweep(): Promise<{ changed: number; total: number }> {
  if (reconciliationRunning) return { changed: 0, total: loanApplications.length };
  reconciliationRunning = true;
  try {
    let changed = 0;
    for (const application of loanApplications) {
      try {
        const didChange = synchronizeLoanApplicationStatus(application);
        if (didChange) changed += 1;
      } catch (error) {
        console.error("[reconciliation] failed for application", application.id, error);
      }
    }
    if (changed > 0) {
      try {
        await persistStore();
      } catch (error) {
        console.error("[reconciliation] persistStore failed:", error);
      }
      console.log(`[reconciliation] updated ${changed} of ${loanApplications.length} application status(es)`);
    }
    return { changed, total: loanApplications.length };
  } finally {
    reconciliationRunning = false;
  }
}

/** Register the periodic reconciliation cron. Safe to call multiple times. */
export function startReconciliationCron(intervalMs = 15 * 60 * 1000): void {
  // Run once shortly after boot (give the server time to finish startup work).
  setTimeout(() => { void runLoanReconciliationSweep(); }, 30_000).unref();
  // Then on a fixed interval.
  setInterval(() => { void runLoanReconciliationSweep(); }, intervalMs).unref();
}
