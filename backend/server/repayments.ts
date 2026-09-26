// ============================================================================
// backend/server/repayments.ts
// Single source of truth for loan-repayment settlement.
//
// Three independent entry points must produce IDENTICAL outcomes and
// notifications when a repayment is confirmed by Flutterwave:
//   1. the Flutterwave webhook (index.ts /api/v1/webhooks/flutterwave),
//   2. the browser redirect back from checkout (/payments/flutterwave/return),
//   3. the stale-pending reconciliation sweep (webhook/redirect both missed).
// Every path calls settleLoanRepayment() — idempotent, so a webhook + redirect
// double-fire can never double-credit the ledger or double-notify.
//
// Notifications emitted on a confirmed repayment (borrower + every admin /
// loan-manager with the loan_notifications permission):
//   • borrower email receipt + email channel-log row
//   • admin staff emails + email channel-log rows
//   • borrower in-app bell (REPAYMENT_CONFIRMED / LOAN_REPAID) with a deep
//     link to the loan detail page
//   • staff in-app bell with a deep link to the admin review console
// ============================================================================

import { randomUUID } from "node:crypto";
import {
  appendAdminLedger,
  creditHistory,
  loanApplications,
  loans,
  notifications,
  repayments,
  users,
  type Repayment,
} from "./store.js";
import { loanRepaymentAdminEmail, loanRepaymentEmail, sendEmail } from "./email.js";
import { pushActivityNotification, notifyMoneyTeamActivity } from "./notify.js";
import { verifyTransactionByReference } from "./providers/flutterwave.js";

export interface SettleRepaymentResult {
  ok: boolean;
  reason?: string;
  repayment?: Repayment;
  loanId?: string;
  fullyRepaid?: boolean;
}

/**
 * Mark a borrower repayment as settled by the provider and apply it to the
 * loan balance. Idempotent: a repayment already SUCCESSFUL returns
 * `already_settled` without any ledger/loan/notification side effects.
 */
export function settleLoanRepayment(params: {
  txRef: string;
  providerReference?: string;
  providerTransactionId?: string;
  verifiedAt?: string;
  source: "WEBHOOK" | "RETURN_REDIRECT" | "RECONCILE_SWEEP";
}): SettleRepaymentResult {
  const repayment = repayments.find((item) => item.txRef === params.txRef);
  if (!repayment) return { ok: false, reason: `No repayment found for txRef=${params.txRef}` };
  if (repayment.status === "SUCCESSFUL") return { ok: true, reason: "already_settled", repayment };
  if (!["PENDING_PROVIDER_CONFIRMATION", "PENDING", "PROVIDER_NOT_CONFIGURED"].includes(String(repayment.status))) {
    return { ok: false, reason: `Repayment status=${repayment.status} is not settleable`, repayment };
  }

  const verifiedAt = params.verifiedAt ?? new Date().toISOString();
  const providerReference = params.providerReference ?? params.txRef;

  // Admin ledger: one credit row per settled repayment, whatever the source.
  appendAdminLedger({
    entryType: "LOAN_REPAYMENT_IN",
    referenceId: repayment.id,
    borrowerId: repayment.borrowerId,
    loanId: repayment.loanId,
    amountMinor: Math.round(Number(repayment.amountNaira ?? 0) * 100),
    direction: "CREDIT",
    description: `Admin ledger credit for loan repayment via flutterwave txRef=${params.txRef} (${params.source})`,
    metadata: {
      provider: "flutterwave",
      providerReference,
      providerTransactionId: params.providerTransactionId ?? providerReference,
      txRef: params.txRef,
      source: params.source,
    },
  });

  repayment.status = "SUCCESSFUL";
  repayment.providerReference = providerReference;
  repayment.verifiedAt = verifiedAt;
  repayment.updatedAt = verifiedAt;

  const loan = loans.find((item) => item.id === repayment.loanId);
  let fullyRepaid = false;
  if (loan) {
    const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
    const onTime = dueAt ? new Date(verifiedAt) <= dueAt : true;
    repayment.onTime = onTime;
    const maxOutstandingPrincipal = Number(
      loan.outstandingPrincipalNaira ?? loan.principalNaira ?? Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? 0)
    );
    const principalPortion = Math.min(maxOutstandingPrincipal, Number(repayment.amountNaira));
    const interestPortion = Math.max(0, Number(repayment.amountNaira) - principalPortion);
    repayment.principalNaira = Math.round(principalPortion * 100) / 100;
    repayment.interestNaira = Math.round(interestPortion * 100) / 100;
    loan.outstandingNaira =
      Math.round(
        Math.max(0, Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? 0) - Number(repayment.amountNaira)) * 100
      ) / 100;
    loan.outstandingPrincipalNaira = Math.max(0, Math.round((maxOutstandingPrincipal - repayment.principalNaira) * 100) / 100);
    const oldInterest = Number(
      loan.outstandingInterestNaira ??
        Math.max(
          0,
          Number(loan.totalInterestNaira ?? 0) -
            (maxOutstandingPrincipal === Number(loan.principalNaira) ? 0 : Number(loan.principalNaira ?? 0) - maxOutstandingPrincipal)
        )
    );
    loan.outstandingInterestNaira = Math.max(0, Math.round((oldInterest - repayment.interestNaira) * 100) / 100);
    if (Number(loan.outstandingNaira) <= 0.01) {
      fullyRepaid = true;
      loan.status = "REPAID";
      loan.paidAt = verifiedAt;
      const application = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
      if (application) {
        application.status = "REPAID";
        application.updatedAt = loan.paidAt;
      }
      creditHistory.push({
        id: randomUUID(),
        userId: loan.borrowerId,
        loanId: loan.id,
        repaymentId: repayment.id,
        eventType: "LOAN_REPAID",
        detail: `Loan ${loan.id} fully repaid`,
        occurredAt: verifiedAt,
        createdAt: verifiedAt,
      });
    } else {
      loan.status = onTime ? "ACTIVE" : "PAST_DUE";
    }
    creditHistory.push({
      id: randomUUID(),
      userId: repayment.borrowerId,
      loanId: repayment.loanId,
      repaymentId: repayment.id,
      eventType: onTime ? "REPAYMENT_VERIFIED" : "REPAYMENT_LATE",
      detail: `Repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")} recorded`,
      occurredAt: verifiedAt,
      createdAt: verifiedAt,
    });
    loan.updatedAt = verifiedAt;
  }

  emitRepaymentNotifications(repayment, loan, fullyRepaid);
  return { ok: true, repayment, loanId: loan?.id, fullyRepaid };
}

/** Email + channel-log + in-app bells for a settled repayment. */
export function emitRepaymentNotifications(repayment: Repayment, loan: (typeof loans)[number] | undefined, fullyRepaid: boolean): void {
  const borrower = users.find((user) => user.id === repayment.borrowerId);
  const verifiedAt = repayment.verifiedAt ?? repayment.updatedAt ?? repayment.createdAt;
  const application = loan
    ? loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId)
    : undefined;
  const adminDeepLink = `/admin#view=detail&id=${encodeURIComponent(application?.applicationId ?? loan?.id ?? repayment.loanId)}`;

  // --- Borrower: email receipt + channel-log + in-app bell -----------------
  if (borrower) {
    const borrowerEmail = loanRepaymentEmail({
      name: borrower.fullName,
      loanId: repayment.loanId,
      amountNaira: Number(repayment.amountNaira),
      outstandingNaira: Number(loan?.outstandingNaira ?? 0),
      fullyRepaid,
    });
    void sendEmail({ to: borrower.email, name: borrower.fullName, ...borrowerEmail })
      .then((result) => {
        notifications.push({
          id: randomUUID(),
          userId: borrower.id,
          channel: "EMAIL",
          kind: fullyRepaid ? "LOAN_REPAID" : "LOAN_REPAYMENT_CONFIRMED",
          recipientMasked: borrower.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
          status: result.sent ? "SENT" : "NOT_CONFIGURED",
          providerMessageId: result.providerReference,
          retryCount: 0,
          relatedEntityType: "REPAYMENT",
          relatedEntityId: repayment.id,
          createdAt: verifiedAt,
          sentAt: result.sent ? new Date().toISOString() : undefined,
        });
      })
      .catch(() => undefined);

    pushActivityNotification({
      userId: borrower.id,
      title: fullyRepaid ? "Loan fully repaid — congratulations!" : "Repayment received",
      body: fullyRepaid
        ? `Your final repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")} settled the loan completely. Your certificate of completion is available on the loan page — thank you for banking with us.`
        : `We received your repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")}. Outstanding balance is now ₦${Number(loan?.outstandingNaira ?? 0).toLocaleString("en-NG")}.`,
      category: "LOAN",
      kind: fullyRepaid ? "LOAN_REPAID" : "LOAN_REPAYMENT_CONFIRMED",
      actionLabel: "View loan",
      actionUrl: `/borrower/loans/${encodeURIComponent(repayment.loanId)}`,
      relatedEntityType: "REPAYMENT",
      relatedEntityId: repayment.id,
    });
  }

  // --- Staff: emails + channel-log + in-app bell ---------------------------
  const adminRecipients = users.filter(
    (user) =>
      user.isActive !== false &&
      (user.roles.includes("ADMIN") || (user.roles.includes("LOAN_MANAGER") && user.adminPermissions?.includes("loan_notifications")))
  );
  for (const admin of adminRecipients) {
    const adminEmail = loanRepaymentAdminEmail({
      name: admin.fullName,
      borrowerName: borrower?.fullName ?? "Borrower",
      loanId: repayment.loanId,
      amountNaira: Number(repayment.amountNaira),
      outstandingNaira: Number(loan?.outstandingNaira ?? 0),
      fullyRepaid,
    });
    void sendEmail({ to: admin.email, name: admin.fullName, ...adminEmail }).catch(() => undefined);
    notifications.push({
      id: randomUUID(),
      userId: admin.id,
      channel: "EMAIL",
      kind: fullyRepaid ? "LOAN_REPAID" : "LOAN_REPAYMENT_CONFIRMED",
      recipientMasked: admin.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
      status: "SENT",
      relatedEntityType: "REPAYMENT",
      relatedEntityId: repayment.id,
      retryCount: 0,
      createdAt: verifiedAt,
      sentAt: verifiedAt,
    });
  }
  notifyMoneyTeamActivity({
    title: fullyRepaid ? "Loan fully repaid" : "Repayment received",
    body: `${borrower?.fullName ?? "A borrower"}'s repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")} on loan ${repayment.loanId.slice(0, 8)}… was confirmed${
      fullyRepaid ? " — the loan is now fully repaid" : ` — outstanding is ₦${Number(loan?.outstandingNaira ?? 0).toLocaleString("en-NG")}`
    }.`,
    category: "LOAN",
    kind: "LOAN_REPAYMENT_STAFF",
    actionLabel: "Open loan",
    actionUrl: adminDeepLink,
    relatedEntityType: "REPAYMENT",
    relatedEntityId: repayment.id,
    actorUserId: repayment.borrowerId,
  });
}

/** Definitive provider failure for a repayment (failed/cancelled/reversed). */
export function markRepaymentFailed(txRef: string, reason: string): Repayment | undefined {
  const repayment = repayments.find((item) => item.txRef === txRef);
  if (!repayment || repayment.status === "SUCCESSFUL") return repayment;
  repayment.status = "FAILED";
  repayment.updatedAt = new Date().toISOString();
  if (reason) repayment.rawResponse = { ...(repayment.rawResponse ?? {}), reconcileNote: reason };
  return repayment;
}

// ---------------------------------------------------------------------------
// Reconciliation sweep for repayments whose webhook AND redirect were missed:
// they would otherwise stay "PENDING PROVIDER CONFIRMATION" forever even
// though the borrower's money actually left their bank. Re-verified by
// tx_ref at most once every 5 minutes per row (mirrors the deposit sweep).
// ---------------------------------------------------------------------------
const REPAYMENT_RECONCILE_MIN_AGE_MS = 90_000;
const repaymentReconcileAttempts = new Map<string, number>();

export async function reconcileStalePendingRepayments(now = new Date(), batchSize = 200): Promise<void> {
  const nowMs = now.getTime();
  const stale = repayments.filter((item) => {
    if (item.status !== "PENDING_PROVIDER_CONFIRMATION") return false;
    if (!item.txRef) return false;
    const createdAtMs = new Date(item.createdAt as unknown as string).getTime();
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs <= REPAYMENT_RECONCILE_MIN_AGE_MS) return false;
    return nowMs - (repaymentReconcileAttempts.get(item.id) ?? 0) > 5 * 60_000;
  });
  for (let i = 0; i < stale.length; i += batchSize) {
    for (const repayment of stale.slice(i, i + batchSize)) {
      repaymentReconcileAttempts.set(repayment.id, nowMs);
      try {
        const result = await verifyTransactionByReference(String(repayment.txRef));
        const data = (result?.data ?? {}) as Record<string, unknown>;
        const providerStatus = String(data.status ?? result?.status ?? "").toLowerCase();
        const currency = String(data.currency ?? "NGN").toUpperCase();
        const amountMatches = Math.round(Number(data.amount ?? 0) * 100) === Math.round(Number(repayment.amountNaira ?? 0) * 100);
        if ((providerStatus === "successful" || providerStatus === "success") && currency === "NGN" && amountMatches) {
          const settled = settleLoanRepayment({
            txRef: String(repayment.txRef),
            providerReference: String(data.id ?? data.flw_ref ?? repayment.txRef),
            providerTransactionId: String(data.id ?? ""),
            source: "RECONCILE_SWEEP",
          });
          if (settled.ok && settled.reason !== "already_settled") {
            console.info(`[repayments] repayment ${repayment.id} settled via reconciliation sweep (txRef=${repayment.txRef})`);
          }
        } else if (["failed", "cancelled", "canceled", "reversed"].includes(providerStatus)) {
          markRepaymentFailed(String(repayment.txRef), `Provider reported payment status=${providerStatus}`);
        }
      } catch (_error) {
        // Provider hiccup or a genuinely never-paid intent — the next sweep
        // window retries; unpaid intents simply keep PENDING forever.
      }
    }
    if (i + batchSize < stale.length) await new Promise<void>((resolve) => setImmediate(() => resolve()));
  }
}
