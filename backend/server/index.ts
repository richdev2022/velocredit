import cors from "cors";
import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { assertProductionSecrets, env } from "./config.js";
import { databaseHealth, sql } from "./db.js";
import apiRouter, { reconcileAllWalletHolds } from "./routes.js";
import { openapi } from "./openapi.js";
import {
  verifyFlutterwaveWebhook,
  verifyKudiSignature,
  verifyMetaWebhookSignature,
  verifyPremblyWebhook,
} from "./providers.js";
import { ensureDatabaseSchema } from "./migrate.js";
import { runInvestmentMaturitySweep } from "./investments.js";
import { runRepaymentReminderSweep } from "./reminders.js";
import { startReconciliationCron } from "./reconciliation.js";
import { startCreditReconciliationCron } from "./creditReconciliation.js";
import {
  repayments,
  creditHistory,
  loans,
  payouts,
  investments,
  providerEvents,
  walletTransactions,
  findWallet,
  appendLedger,
  ledgerEntries,
  wallets,
  users,
  appendAdminLedger,
  adminLedger,
  seedAdminLedgerOpeningBalance,
  getPlatformSettings,
  notifications,
  settleWalletDeposit,
  loanDisbursements,
  loanApplications,
  investorWithdrawals,
} from "./store.js";
import { initializeStore, persistStore, seedInvestmentPlans, seedLoanProducts, seedDefaultEngagement, findOrCreateKycCase, kycCases, identityVerificationEvents } from "./store.js";
import type { IdentityVerificationEvent } from "./store.js";
import { markKycChecklistComplete } from "./auth.js";
import { sendEmail, investorWalletFundedEmail, investorEarningsCreditedEmail, loanDisbursedEmail, loanRepaymentEmail, loanRepaymentAdminEmail } from "./email.js";
import { runExportSheetsBackup } from "./exportSheetsBackup.js";
import { runSeedGoogleSheets } from "./seedGoogleSheets.js";
import { bootstrapEnvironmentAdministrator } from "./bootstrap.js";
import { verifyTransaction, verifyTransactionWithRetry, verifyTransfer } from "./providers/flutterwave.js";

assertProductionSecrets();

const app = express();
app.disable("x-powered-by");

async function runAndPersistInvestmentMaturitySweep(): Promise<void> {
  try {
    await runInvestmentMaturitySweep();
    // The sweep moves money between held/available (principal release +
    // earnings credit, KYC-gated holds); re-derive every wallet's held
    // balance from its backing records so sweep interruptions cannot leave
    // phantom or missing holds behind.
    const repaired = reconcileAllWalletHolds();
    if (repaired > 0) console.warn(`[index] hold reconciliation after maturity sweep repaired ${repaired} wallet(s)`);
    if (sql) await persistStore();
  } catch (error) {
    console.error("[index] investment maturity sweep failed:", error);
  }
}
app.use(helmet());
const allowedOrigins = env.API_ORIGIN
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const isBuilderPreviewOrigin = (origin: string): boolean => /^https:\/\/[a-z0-9-]+\.builderio\.dev$/i.test(origin);
app.use(cors({
  credentials: true,
  origin: (origin, callback) => {
    const normalizedOrigin = origin?.replace(/\/$/, "");
    if (!normalizedOrigin || allowedOrigins.includes(normalizedOrigin) || isBuilderPreviewOrigin(normalizedOrigin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));
app.use((req, res, next) => {
  const requestId = randomUUID();
  const startedAt = Date.now();
  res.setHeader("X-Request-ID", requestId);
  console.log(`[API] ${requestId} -> ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    console.log(`[API] ${requestId} <- ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

app.post(
  "/api/v1/webhooks/flutterwave",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyFlutterwaveWebhook(req.header("verif-hash") ?? undefined, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature" });
      return;
    }
    let event: {
      id?: string;
      event?: string;
      data?: Record<string, unknown>;
    };
    try {
      event = JSON.parse(
        Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}"
      );
    } catch {
      res.status(400).json({ ok: false, error: "Invalid webhook payload" });
      return;
    }
    const eventKey = String(
      event.id ??
        `${event.event}:${event.data?.id ?? event.data?.tx_ref ?? event.data?.reference ?? Date.now()}`
    );
    if (!providerEvents.some((item) => item.provider === "flutterwave" && item.eventKey === eventKey)) {
      const record = {
        provider: "flutterwave" as const,
        eventKey,
        event,
        receivedAt: new Date().toISOString(),
      };
      providerEvents.push(record);
      const data = event.data ?? {};
      const txRef = String(data.tx_ref ?? data.reference ?? "");
      const amount = Number(data.amount ?? 0);
      const currency = String(data.currency ?? "NGN");
      const status = String(data.status ?? "").toLowerCase();
      const success = status === "successful" || status === "success";
      const providerReference = String(data.id ?? data.flw_ref ?? txRef);

      if (success) {
        const withdrawal = investorWithdrawals.find((item) => {
          const transfer = item.providerTransfer as { initiate?: { data?: { reference?: string; id?: number | string } } } | undefined;
          const reference = String(transfer?.initiate?.data?.reference ?? item.providerReference ?? `WITHDRAWAL-${item.id}`);
          const providerId = String(transfer?.initiate?.data?.id ?? item.providerReference ?? "");
          return item.status !== "SUCCESSFUL" && (reference === txRef || providerId === providerReference || txRef === `WITHDRAWAL-${item.id}`);
        });
        if (withdrawal) {
          const now = new Date().toISOString();
          withdrawal.status = "SUCCESSFUL";
          withdrawal.providerReference = providerReference;
          withdrawal.processedAt = now;
          withdrawal.updatedAt = now;
          withdrawal.error = undefined;
        }
        const walletTx = walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT");
        const transactionId = String(data.id ?? "");
        if (walletTx && walletTx.status !== "COMPLETED" && walletTx.status !== "SUCCESSFUL" && transactionId) {
          try {
            const verification = await verifyTransactionWithRetry(transactionId, 3, 2000);
            const verified = verification.data ?? {};
            const verifiedTxRef = String(verified.tx_ref ?? "");
            const verifiedCurrency = String(verified.currency ?? "").toUpperCase();
            const verifiedAmountMinor = Math.round(Number(verified.amount ?? 0) * 100);
            if (verification.settled && verifiedTxRef === walletTx.txRef && verifiedCurrency === "NGN" && verifiedAmountMinor === walletTx.amountMinor) {
              const settled = settleWalletDeposit({ txRef, providerReference, providerTransactionId: transactionId });
              if (settled.ok && settled.user && settled.wallet && settled.reason !== "already_settled") {
                const balanceNaira = Math.round(settled.wallet.availableMinor) / 100;
                const emailTemplate = investorWalletFundedEmail({
                  investorName: settled.user.fullName,
                  amountNaira: Math.round(walletTx.amountMinor) / 100,
                  balanceNaira,
                  reference: providerReference,
                });
                void sendEmail({
                  to: settled.user.email,
                  name: settled.user.fullName,
                  subject: emailTemplate.subject,
                  html: emailTemplate.html,
                }).then((emailResult) => {
                  notifications.push({
                    id: randomUUID(),
                    userId: settled.user!.id,
                    channel: "EMAIL",
                    kind: "WALLET_FUNDED",
                    subject: emailTemplate.subject,
                    recipientMasked: settled.user!.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
                    status: emailResult.sent ? "SENT" : "NOT_CONFIGURED",
                    providerMessageId: emailResult.providerReference,
                    retryCount: 0,
                    relatedEntityType: "WALLET_TRANSACTION",
                    relatedEntityId: walletTx.id,
                    createdAt: new Date().toISOString(),
                    sentAt: emailResult.sent ? new Date().toISOString() : undefined,
                  });
                }).catch(() => undefined);
              }
            }
          } catch (error) {
            console.error("[webhooks/flutterwave] wallet funding verification failed:", error);
          }
        }

        const repayment = repayments.find((p) => p.txRef === txRef);
        if (repayment && repayment.status !== "SUCCESSFUL") {
          const repaymentAmountMinor = Math.round(Number(repayment.amountNaira ?? 0) * 100);
          appendAdminLedger({
            entryType: "LOAN_REPAYMENT_IN",
            referenceId: repayment.id,
            borrowerId: repayment.borrowerId,
            loanId: repayment.loanId,
            amountMinor: repaymentAmountMinor,
            direction: "CREDIT",
            description: `Admin ledger credit for loan repayment via flutterwave txRef=${txRef}`,
            metadata: {
              provider: "flutterwave",
              providerReference,
              providerTransactionId: String(data.id ?? providerReference),
              txRef,
            },
          });
          repayment.status = "SUCCESSFUL";
          repayment.providerReference = providerReference;
          repayment.verifiedAt = new Date().toISOString();
          repayment.updatedAt = repayment.verifiedAt;
          const loan = loans.find((l) => l.id === repayment.loanId);
          if (loan) {
            const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
            const onTime = dueAt ? new Date(repayment.verifiedAt) <= dueAt : true;
            repayment.onTime = onTime;
            const maxOutstandingPrincipal = Number(
              loan.outstandingPrincipalNaira ?? loan.principalNaira ?? Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? 0)
            );
            const principalPortion = Math.min(
              maxOutstandingPrincipal,
              Number(repayment.amountNaira)
            );
            const interestPortion = Math.max(
              0,
              Number(repayment.amountNaira) - principalPortion
            );
            repayment.principalNaira = Math.round(principalPortion * 100) / 100;
            repayment.interestNaira = Math.round(interestPortion * 100) / 100;
            loan.outstandingNaira =
              Math.round(
                Math.max(
                  0,
                  Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? 0) -
                    Number(repayment.amountNaira)
                ) * 100
              ) / 100;
            loan.outstandingPrincipalNaira = Math.max(
              0,
              Math.round(
                (maxOutstandingPrincipal - repayment.principalNaira) * 100
              ) / 100
            );
            const oldInterest = Number(
              loan.outstandingInterestNaira ??
                Math.max(0, Number(loan.totalInterestNaira ?? 0) - (maxOutstandingPrincipal === Number(loan.principalNaira) ? 0 : Number(loan.principalNaira ?? 0) - maxOutstandingPrincipal))
            );
            loan.outstandingInterestNaira = Math.max(
              0,
              Math.round((oldInterest - repayment.interestNaira) * 100) / 100
            );
            if (Number(loan.outstandingNaira) <= 0.01) {
              loan.status = "REPAID";
              loan.paidAt = new Date().toISOString();
              const application = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
              if (application) {
                application.status = "REPAID";
                application.updatedAt = loan.paidAt;
              }
              creditHistory.push({
                id: crypto.randomUUID(),
                userId: loan.borrowerId,
                loanId: loan.id,
                repaymentId: repayment.id,
                eventType: "LOAN_REPAID",
                detail: `Loan ${loan.id} fully repaid`,
                occurredAt: new Date().toISOString(),
                createdAt: new Date().toISOString(),
              });
            } else {
              loan.status = onTime ? "ACTIVE" : "PAST_DUE";
            }
            creditHistory.push({
              id: crypto.randomUUID(),
              userId: repayment.borrowerId,
              loanId: repayment.loanId,
              repaymentId: repayment.id,
              eventType: onTime ? "REPAYMENT_VERIFIED" : "REPAYMENT_LATE",
              detail: `Repayment of ₦${Number(repayment.amountNaira).toLocaleString("en-NG")} recorded`,
              occurredAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
            loan.updatedAt = new Date().toISOString();
            const borrower = users.find((user) => user.id === loan.borrowerId);
            const fullyRepaid = loan.status === "REPAID";
            if (borrower) {
              const borrowerEmail = loanRepaymentEmail({ name: borrower.fullName, loanId: loan.id, amountNaira: Number(repayment.amountNaira), outstandingNaira: Number(loan.outstandingNaira), fullyRepaid });
              void sendEmail({ to: borrower.email, name: borrower.fullName, ...borrowerEmail }).catch(() => undefined);
              notifications.push({ id: randomUUID(), userId: borrower.id, channel: "EMAIL", kind: fullyRepaid ? "LOAN_REPAID" : "LOAN_REPAYMENT_CONFIRMED", recipientMasked: borrower.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"), status: "SENT", relatedEntityType: "REPAYMENT", relatedEntityId: repayment.id, retryCount: 0, createdAt: repayment.verifiedAt, sentAt: repayment.verifiedAt });
            }
            const adminRecipients = users.filter((user) => user.isActive !== false && (user.roles.includes("ADMIN") || (user.roles.includes("LOAN_MANAGER") && user.adminPermissions?.includes("loan_notifications"))));
            for (const admin of adminRecipients) {
              const adminEmail = loanRepaymentAdminEmail({ name: admin.fullName, borrowerName: borrower?.fullName ?? "Borrower", loanId: loan.id, amountNaira: Number(repayment.amountNaira), outstandingNaira: Number(loan.outstandingNaira), fullyRepaid });
              void sendEmail({ to: admin.email, name: admin.fullName, ...adminEmail }).catch(() => undefined);
            }
          }
        }

        const transferRef = String(data.reference ?? "");
        const transfer = data as { reference?: string; id?: string; flw_ref?: string };
        const disbursementLoan = loans.find(
          (l) =>
            l.providerTransfer &&
            (l.providerTransfer as { data?: { reference?: string } }).data?.reference === transferRef
        );
        if (disbursementLoan) {
          const wasDisbursed = ["DISBURSED", "ACTIVE"].includes(disbursementLoan.status);
          disbursementLoan.status = "ACTIVE";
          const application = loanApplications.find((item) => item.id === disbursementLoan.applicationId || item.applicationId === disbursementLoan.applicationId);
          if (application) {
            // Mirror the disbursement route: use "ACTIVE" for the application
            // status so the borrower and admin UIs reflect that the loan has
            // been disbursed and is now in its repayment lifecycle.
            application.status = "ACTIVE";
            application.updatedAt = new Date().toISOString();
          }
          disbursementLoan.providerReference = String(transfer.id ?? transfer.flw_ref ?? transferRef);
          disbursementLoan.disbursedAt = new Date().toISOString();
          disbursementLoan.updatedAt = disbursementLoan.disbursedAt;
          const now = disbursementLoan.disbursedAt;
          const matchingDisbursements = loanDisbursements.filter((d) => d.loanId === disbursementLoan.id);
          for (const d of matchingDisbursements) {
            const matchesReference =
              (d.providerTransfer &&
                ((d.providerTransfer as { data?: { reference?: string } }).data?.reference === transferRef ||
                  (d.providerTransfer as { data?: { id?: number | string } }).data?.id === transfer.id ||
                  (d.providerTransfer as { data?: { id?: number | string } }).data?.id === transfer.flw_ref)) ||
              d.providerReference === String(transfer.id ?? transfer.flw_ref ?? transferRef);
            if (matchesReference) {
              d.status = "SUCCESSFUL";
              d.providerReference = String(transfer.id ?? transfer.flw_ref ?? transferRef);
              d.processedAt = now;
              d.updatedAt = now;
              d.providerTransfer = { ...(d.providerTransfer ?? {}), webhook: data } as unknown as Record<string, unknown>;
            }
          }
          if (!wasDisbursed) {
            creditHistory.push({
              id: crypto.randomUUID(),
              userId: disbursementLoan.borrowerId,
              loanId: disbursementLoan.id,
              eventType: "LOAN_DISBURSED",
              detail: `Disbursement confirmed via provider ${disbursementLoan.providerReference}`,
              occurredAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            });
            const borrower = users.find((user) => user.id === disbursementLoan.borrowerId);
            const application = loanApplications.find((item) => item.id === disbursementLoan.applicationId);
            if (borrower) {
              const template = loanDisbursedEmail({ name: borrower.fullName, applicationId: application?.applicationId ?? disbursementLoan.applicationId, amountNaira: Number(disbursementLoan.principalNaira) });
              void sendEmail({ to: borrower.email, name: borrower.fullName, ...template }).catch(() => undefined);
            }
          }
        }
        const payout = payouts.find(
          (p) =>
            p.providerTransfer &&
            (p.providerTransfer as { data?: { reference?: string } }).data?.reference === transferRef
        );
        if (payout && payout.status !== "SUCCESSFUL") {
          payout.status = "SUCCESSFUL";
          payout.providerReference = String(transfer.id ?? transfer.flw_ref ?? transferRef);
          payout.updatedAt = new Date().toISOString();
          const investment = investments.find((i) => i.id === payout.investmentId);
          if (investment) {
            investment.status = "PAID_OUT";
            investment.updatedAt = new Date().toISOString();
            if (investment.planId || true) {
              const wallet = findWallet(payout.userId);
              const amountMinor = Math.round(Number(payout.amountNaira ?? 0) * 100);
              // Ledger accuracy: the automatic maturity sweep ALREADY debited
              // the admin ledger for this investment when it credited the
              // investor's wallet internally (entryType INVESTMENT_RETURN /
              // referenceId = investment.id). Only debit here when THIS payout
              // has never been represented — otherwise webhook + sweep would
              // double-charge the ledger for the same money.
              const adminAlreadyDebited = adminLedger.some(
                (entry) =>
                  entry.direction === "DEBIT" &&
                  (entry.referenceId === payout.id || (entry.entryType === "INVESTMENT_RETURN" && entry.referenceId === investment.id))
              );
              if (!adminAlreadyDebited) {
                appendAdminLedger({
                  entryType: "INVESTMENT_PAYOUT",
                  referenceId: payout.id,
                  investorId: payout.userId,
                  amountMinor,
                  direction: "DEBIT",
                  description: `Admin ledger debit for investment payout - ${payout.payoutType}`,
                  metadata: {
                    provider: "flutterwave",
                    providerReference: payout.providerReference,
                    payoutType: payout.payoutType,
                    investmentId: investment.id,
                  },
                });
              }
                const alreadyCredited = ledgerEntries.some((entry) => entry.entryType === "INVESTMENT_RETURN" && entry.referenceId === investment.id && entry.direction === "CREDIT");
                if (!alreadyCredited) {
                  appendLedger(wallet, {
                    entryType: "INVESTMENT_RETURN",
                    referenceId: investment.id,
                    amountMinor,
                    direction: "CREDIT",
                    description: `Investment payout ${payout.id}`,
                    metadata: {
                      provider: "flutterwave",
                      providerReference: payout.providerReference,
                      payoutType: payout.payoutType,
                    },
                  });
                }
                const investorUser = users.find((u) => u.id === payout.userId);
                if (investorUser) {
                  const principalVal = Number(payout.principalNaira ?? investment.amountNaira ?? 0);
                  const earningsVal = Number(payout.earningsNaira ?? investment.expectedEarningsNaira ?? 0);
                  const totalVal = Number(payout.amountNaira ?? 0);
                  const balanceNairaVal = Math.round(wallet.availableMinor) / 100;
                  const emailTpl = investorEarningsCreditedEmail({
                    investorName: investorUser.fullName,
                    investmentId: investment.id,
                    principalNaira: principalVal,
                    earningsNaira: earningsVal,
                    totalNaira: totalVal,
                    balanceNaira: balanceNairaVal,
                  });
                  void sendEmail({
                    to: investorUser.email,
                    name: investorUser.fullName,
                    subject: emailTpl.subject,
                    html: emailTpl.html,
                  }).then((emailRes) => {
                    notifications.push({
                      id: randomUUID(),
                      userId: investorUser.id,
                      channel: "EMAIL",
                      kind: "INVESTMENT_PAYOUT",
                      subject: emailTpl.subject,
                      recipientMasked: investorUser.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
                      status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
                      providerMessageId: emailRes.providerReference,
                      retryCount: 0,
                      relatedEntityType: "PAYOUT",
                      relatedEntityId: payout.id,
                      createdAt: new Date().toISOString(),
                      sentAt: emailRes.sent ? new Date().toISOString() : undefined,
                    });
                  }).catch(() => undefined);
                }
            }
          }
        }
      } else if (status === "failed") {
        const walletTx = walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT");
        if (walletTx) {
          walletTx.status = "FAILED";
          walletTx.updatedAt = new Date().toISOString();
          const wallet = wallets.find((w) => w.id === walletTx.walletId);
          if (wallet) {
            wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - walletTx.amountMinor);
          }
        }
        const repayment = repayments.find((p) => p.txRef === txRef);
        if (repayment) {
          repayment.status = "FAILED";
          repayment.updatedAt = new Date().toISOString();
        }
      }
    }
    try {
      await persistStore();
    } catch (error) {
      const eventIndex = providerEvents.findIndex((item) => item.provider === "flutterwave" && item.eventKey === eventKey);
      if (eventIndex >= 0) providerEvents.splice(eventIndex, 1);
      console.error("[webhooks/flutterwave] PostgreSQL persistence failed:", error);
      res.status(503).json({ ok: false, error: "Unable to persist Flutterwave webhook" });
      return;
    }
    res.status(202).json({ ok: true, accepted: true, eventKey });
  }
);

app.get("/api/v1/webhooks/prembly", (req, res) => {
  res.status(200).json({ ok: true, service: "Prembly webhook endpoint" });
});
app.post(
  "/api/v1/webhooks/prembly",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-prembly-signature") ?? req.header("signature") ?? undefined;
    if (!verifyPremblyWebhook(signature, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid Prembly webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "prembly",
      eventKey: String((event as { id?: string }).id ?? `prembly-${Date.now()}`),
      event,
      receivedAt: new Date().toISOString(),
    });
    const status = String(event.status ?? event.event ?? "").toLowerCase();
    const success = ["success", "successful", "passed", "verified", "complete", "completed"].includes(status) || (event.data && typeof (event.data as any).status === "string" && ["success", "verified"].includes((event.data as any).status.toLowerCase()));
    const providerRef = String(
      event.reference ?? event.id ?? (event.data as any)?.reference ?? (event.data as any)?.id ?? (event.metadata as any)?.reference ?? ""
    );
    const verificationTypeRaw = String(event.verification_type ?? event.type ?? (event.data as any)?.type ?? (event.data as any)?.verification_type ?? "").toUpperCase();
    let verificationType: IdentityVerificationEvent["verificationType"] | null = null;
    if (verificationTypeRaw.includes("LIVENESS") || verificationTypeRaw.includes("FACE") || verificationTypeRaw.includes("SELFIE")) verificationType = "LIVENESS";
    else if (verificationTypeRaw.includes("BVN")) verificationType = "BVN";
    else if (verificationTypeRaw.includes("NIN")) verificationType = "NIN";
    else if (verificationTypeRaw.includes("PASSPORT")) verificationType = "PASSPORT";
    else if (verificationTypeRaw.includes("ADDRESS")) verificationType = "ADDRESS";
    const matches = providerRef
      ? identityVerificationEvents.filter((e) => e.provider === "prembly" && e.providerReference === providerRef)
      : [];
    for (const match of matches) {
      match.status = success ? "SUCCESS" : "FAILED";
      match.rawResponse = { ...(match.rawResponse ?? {}), webhook: event };
      const kyc = kycCases.find((k) => k.id === match.kycCaseId);
      if (kyc) {
        const effType = verificationType ?? match.verificationType;
        const now = new Date().toISOString();
        if (success) {
          if (effType === "LIVENESS") { kyc.checklist.liveness = true; kyc.livenessVerifiedAt = kyc.livenessVerifiedAt ?? now; }
          else if (effType === "BVN") { kyc.checklist.bvn = true; kyc.bvnVerifiedAt = kyc.bvnVerifiedAt ?? now; }
          else if (effType === "NIN") { kyc.checklist.nin = true; kyc.ninVerifiedAt = kyc.ninVerifiedAt ?? now; }
          else if (effType === "PASSPORT") { kyc.checklist.passport = true; }
          else if (effType === "ADDRESS") { kyc.checklist.proofOfAddress = true; }
          else if (effType === "SIGNATURE") { kyc.checklist.signature = true; }
        }
        kyc.updatedAt = now;
        const user = users.find((u) => u.id === kyc.userId);
        if (user) markKycChecklistComplete(user.id);
      }
    }
    try {
      await persistStore();
    } catch (error) {
      console.error("[webhooks/prembly] PostgreSQL persistence failed:", error);
      res.status(503).json({ ok: false, error: "Unable to persist Prembly webhook" });
      return;
    }
    res.status(202).json({ ok: true, accepted: true, matches: matches.length });
  }
);

app.get("/api/v1/webhooks/prembly/kyc", (_req, res) => {
  res.status(200).json({ ok: true, service: "Prembly KYC Liveness Webhook", expected: "POST signature: x-prembly-signature with HMAC-SHA512 hex" });
});
app.post(
  "/api/v1/webhooks/prembly/kyc",
  express.raw({ type: "application/json", limit: "5mb" }),
  async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-prembly-signature") ?? req.header("signature") ?? undefined;
    if (!verifyPremblyWebhook(signature, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid Prembly webhook signature" });
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = {};
    }
    providerEvents.push({
      provider: "prembly",
      eventKey: String((payload as { id?: string }).id ?? (payload as { event_id?: string }).event_id ?? `prembly-kyc-${Date.now()}`),
      event: payload,
      receivedAt: new Date().toISOString(),
    });
    const candidateValues = (obj: any, keys: string[]): unknown[] => keys.flatMap((k) => [obj?.[k], obj?.data?.[k], obj?.metadata?.[k]]).filter((v) => v !== undefined && v !== null);
    const pickStr = (keys: string[]): string | undefined => {
      for (const raw of candidateValues(payload, keys)) {
        if (typeof raw === "string" && raw.trim()) return raw.trim();
      }
      return undefined;
    };
    const anyPayload = payload as any;
    const eventStr = String(anyPayload.event ?? anyPayload.type ?? anyPayload.event_type ?? "").toLowerCase();
    const verificationStatusStr = String(anyPayload.verification_status ?? anyPayload.status ?? anyPayload.data?.verification_status ?? anyPayload.data?.status ?? anyPayload.verificationStatus ?? "FAILED").toLowerCase();
    const success = ["success","successful","verified","passed","pass","complete","completed","approved","valid","00","ok"].some((s) => [eventStr, verificationStatusStr].includes(s)) || verificationStatusStr.includes("success") || verificationStatusStr.includes("verified");
    const providerRef = pickStr(["provider_reference","providerReference","reference","transaction_id","transactionId","id"]) ?? undefined;
    const verificationTypeUpper = String(anyPayload.verification_type ?? anyPayload.type ?? anyPayload.data?.verification_type ?? "LIVENESS").toUpperCase();
    const isLivenessEvent = /LIVENESS|FACE|SELFIE|BIOMETRIC/.test(verificationTypeUpper) || eventStr.includes("liveness") || /\/kyc\/liveness|\/biometric/.test(String(anyPayload.webhook_url ?? anyPayload.endpoint ?? ""));
    const bvnFromMeta = (() => {
      const raw = pickStr(["bvn","BVN","metadata.bvn","id_number","idNumber"]) ?? "";
      const digits = raw.replace(/\D/g, "");
      return /^\d{11}$/.test(digits) ? digits : undefined;
    })();
    const ninFromMeta = (() => {
      const raw = pickStr(["nin","NIN","metadata.nin","national_id","nationalId"]) ?? "";
      const digits = raw.replace(/\D/g, "");
      return /^\d{11}$/.test(digits) ? digits : undefined;
    })();
    const metadataUserId = pickStr(["user_id","userId","customer_id","customerId","member_id","memberId","metadata.user_id","metadata.userId"]) ?? undefined;
    let selfieImageData: string | undefined;
    const selfieKeys = ["selfie","image","selfieImage","selfie_image","photo","photograph","face_image","base64Image","base64_image","imageBase64","portrait","captured_image"];
    for (const key of selfieKeys) {
      const variants: unknown[] = [
        (payload as any)[key],
        (payload as any).data?.[key],
        (payload as any).metadata?.[key],
        (payload as any).result?.[key],
      ];
      for (const raw of variants) {
        if (typeof raw !== "string" || raw.length < 20) continue;
        if (raw.startsWith("data:image")) {
          selfieImageData = raw;
          break;
        }
        if (/^[A-Za-z0-9+/=\s]+$/.test(raw) && raw.length > 100) {
          selfieImageData = `data:image/jpeg;base64,${raw.replace(/\s/g, "")}`;
          break;
        }
      }
      if (selfieImageData) break;
    }
    const matches: { kycCaseId: string; via: "providerRef" | "metadata.bvn" | "metadata.nin" | "userId" }[] = [];
    if (providerRef) {
      const byRef = identityVerificationEvents.find((e) => e.provider === "prembly" && e.providerReference === providerRef);
      if (byRef) matches.push({ kycCaseId: byRef.kycCaseId, via: "providerRef" });
    }
    if (matches.length === 0 && metadataUserId) {
      const direct = kycCases.find((k) => k.userId === metadataUserId);
      if (direct) matches.push({ kycCaseId: direct.id, via: "userId" });
    }
    if (matches.length === 0 && bvnFromMeta) {
      const byBvn = kycCases.find((k) => typeof k.bvn === "string" && k.bvn.replace(/\D/g, "") === bvnFromMeta);
      if (byBvn) matches.push({ kycCaseId: byBvn.id, via: "metadata.bvn" });
    }
    if (matches.length === 0 && ninFromMeta) {
      const byNin = kycCases.find((k) => typeof k.nin === "string" && k.nin.replace(/\D/g, "") === ninFromMeta);
      if (byNin) matches.push({ kycCaseId: byNin.id, via: "metadata.nin" });
    }
    const now = new Date().toISOString();
    for (const hit of matches) {
      const kyc = kycCases.find((k) => k.id === hit.kycCaseId);
      if (!kyc) continue;
      identityVerificationEvents.push({
        id: randomUUID(),
        kycCaseId: kyc.id,
        provider: "prembly",
        verificationType: isLivenessEvent ? "LIVENESS" : (verificationTypeUpper.includes("BVN") ? "BVN" : verificationTypeUpper.includes("NIN") ? "NIN" : "LIVENESS"),
        providerReference: providerRef,
        status: success ? "SUCCESS" : "FAILED",
        matchScore: undefined,
        rawResponse: payload,
        createdAt: now,
      });
      if (success) {
        if (isLivenessEvent) {
          kyc.checklist.liveness = true;
          kyc.livenessVerifiedAt = kyc.livenessVerifiedAt ?? now;
          if (selfieImageData) {
            kyc.selfieImageData = selfieImageData;
          }
        } else if (verificationTypeUpper.includes("BVN")) {
          kyc.checklist.bvn = true;
          kyc.bvnVerifiedAt = kyc.bvnVerifiedAt ?? now;
        } else if (verificationTypeUpper.includes("NIN")) {
          kyc.checklist.nin = true;
          kyc.ninVerifiedAt = kyc.ninVerifiedAt ?? now;
        }
      }
      kyc.updatedAt = now;
      const user = users.find((u) => u.id === kyc.userId);
      if (user) markKycChecklistComplete(user.id);
    }
    try {
      await persistStore();
    } catch (error) {
      console.error("[webhooks/prembly/kyc] PostgreSQL persistence failed:", error);
      res.status(503).json({ ok: false, error: "Unable to persist Prembly webhook" });
      return;
    }
    res.status(200).json({ ok: true, processed: true, success, matches: matches.length, liveness: isLivenessEvent, selfieExtracted: Boolean(selfieImageData) });
  }
);

app.get("/api/v1/webhooks/kudi", (_req, res) => {
  res.status(200).json({ ok: true, service: "Kudi webhook endpoint" });
});
app.post(
  "/api/v1/webhooks/kudi",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.header("x-kudi-signature") ?? req.header("signature") ?? undefined;
    if (!verifyKudiSignature(signature, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid Kudi webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "kudi",
      eventKey: String((event as { message_id?: string }).message_id ?? `kudi-${Date.now()}`),
      event,
      receivedAt: new Date().toISOString(),
    });
    res.status(202).json({ ok: true, accepted: true });
  }
);

app.get("/api/v1/webhooks/meta-whatsapp", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (
    mode === "subscribe" &&
    token &&
    token === env.META_WHATSAPP_VERIFY_TOKEN &&
    typeof challenge === "string"
  ) {
    res.status(200).send(challenge);
    return;
  }
  res.status(403).json({ ok: false, error: "Webhook verification failed" });
});
app.post(
  "/api/v1/webhooks/meta-whatsapp",
  express.raw({ type: "application/json", limit: "1mb" }),
  (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (!verifyMetaWebhookSignature(req.header("x-hub-signature-256") ?? undefined, rawBody)) {
      res.status(401).json({ ok: false, error: "Invalid webhook signature" });
      return;
    }
    let event: Record<string, unknown>;
    try {
      event = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      event = {};
    }
    providerEvents.push({
      provider: "meta",
      eventKey: `meta-${Date.now()}-${Math.random()}`,
      event,
      receivedAt: new Date().toISOString(),
    });
    res
      .status(202)
      .json({ ok: true, accepted: true, message: "Webhook accepted for idempotent processing" });
  }
);

app.use(express.json({ limit: "1mb" }));
app.use((error: unknown, _req: unknown, res: unknown, next: unknown) => {
  if (typeof next !== "function") return;
  const err = error as { type?: string; message?: string; status?: number; statusCode?: number };
  if (err?.type === "entity.too.large" || /PayloadTooLarge|payload too large/i.test(err?.message ?? "")) {
    (res as any).status?.(413)?.json?.({ ok: false, error: "Payload too large", maxBytes: err?.status === 413 ? "configured" : "1048576" });
    return;
  }
  if (err && (err.status === 400 || err.statusCode === 400) && /Unexpected token|invalid json|JSON\.parse/i.test(err?.message ?? "")) {
    (res as any).status?.(400)?.json?.({ ok: false, error: "Invalid JSON payload" });
    return;
  }
  next(error);
});

app.get("/health", async (_req, res) => {
  try {
    const database = await databaseHealth();
    res.json({
      ok: true,
      service: "velo-api",
      database,
      time: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      ok: false,
      service: "velo-api",
      database: "unreachable",
    });
  }
});

app.get("/api/v1", (_req, res) => {
  res.json({
    ok: true,
    service: "velo-api",
    version: "v1",
    documentation: "/docs",
  });
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi));
app.get("/openapi.json", (_req, res) => res.json(openapi));
app.use("/api/v1", apiRouter);

// Express 5 forwards rejected promises from async route handlers to the
// next error-handling middleware. Without this terminal handler those
// rejections (e.g. a Flutterwave provider throw inside a wallet route)
// would fall through to the default handler and return a non-JSON 500.
app.use((error: unknown, _req: unknown, res: unknown, _next: unknown) => {
  const message = error instanceof Error ? error.message : "Unexpected server error";
  console.error("[api] unhandled route error:", error);
  const resAny = res as { status?: (code: number) => { json: (body: unknown) => void }; headersSent?: boolean };
  if (!resAny?.status || resAny.headersSent) return;
  resAny.status(500).json({ ok: false, error: message });
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Route not found" });
});

async function start(): Promise<void> {
  try {
    console.log(`[startup] Booting Velo API (NODE_ENV=${env.NODE_ENV}, PORT=${env.API_PORT}, HOST=${env.API_HOST})…`);
    console.log("Initializing database schema...");
    const schema = await ensureDatabaseSchema();
    await bootstrapEnvironmentAdministrator();
    console.log("Loading persisted application state...");
    await initializeStore();
    if (sql && env.GOOGLE_SHEETS_SPREADSHEET_ID && users.length <= 1) {
      const seeded = await runSeedGoogleSheets();
      if (!seeded.ok) console.error(`[startup] Google Sheets seed failed: ${seeded.error ?? "unknown error"}`);
    }
    seedInvestmentPlans();
    seedLoanProducts();
    // seedAdminLedgerOpeningBalance(100_000_000 * 100);
    seedDefaultEngagement();
    getPlatformSettings();
    // Boot-time hold reconciliation: any hold written by a previous process
    // that crashed between "hold written" and "outcome written" (or legacy
    // over-releases) is repaired against the real investment/withdrawal
    // records BEFORE the API starts serving balances.
    try {
      const repaired = reconcileAllWalletHolds();
      if (repaired > 0) console.warn(`[startup] hold reconciliation repaired ${repaired} wallet(s)`);
    } catch (reconcileError) {
      console.error("[startup] hold reconciliation failed:", reconcileError);
    }
    if (sql) await persistStore();
    console.log("Database initialization complete.");
    let sheetsBackupRunning = false;
    const runGuardedSheetsBackup = async (): Promise<void> => {
      if (sheetsBackupRunning) return;
      sheetsBackupRunning = true;
      try {
        await runExportSheetsBackup();
      } catch (_e) {
        console.error("[index] runExportSheetsBackup scheduled run failed:", _e);
      } finally {
        sheetsBackupRunning = false;
      }
    };
    void runGuardedSheetsBackup();
    setInterval(() => { void runGuardedSheetsBackup(); }, 6 * 60 * 60 * 1000).unref();
    const server = app.listen(env.API_PORT, env.API_HOST, () => {
      server.requestTimeout = 120_000;
      server.timeout = 120_000;
      server.headersTimeout = 125_000;
      server.keepAliveTimeout = 65_000;
      const databaseMessage = schema === "created"
        ? "schema initialized"
        : "schema skipped (DATABASE_URL is not configured)";
      console.log(`Velo API: ${env.API_PUBLIC_URL}/api/v1`);
      console.log(`Swagger UI: ${env.API_PUBLIC_URL}/docs`);
      console.log(`Health check: ${env.API_PUBLIC_URL}/health`);
      console.log(`Listening on ${env.API_HOST}:${env.API_PORT}`);
      console.log(`Prembly KYC webhook (paste in widget dashboard): ${env.API_PUBLIC_URL}/api/v1/webhooks/prembly/kyc`);
      console.log(`Database: ${databaseMessage}`);
      void runRepaymentReminderSweep();
      void runAndPersistInvestmentMaturitySweep();
      startReconciliationCron();
      startCreditReconciliationCron();
      setInterval(() => {
        void runRepaymentReminderSweep();
        void runAndPersistInvestmentMaturitySweep();
      }, 60 * 60 * 1000).unref();
    });
    server.on("error", (err) => {
      console.error("[FATAL] HTTP server bind failed", err);
      process.exit(1);
    });
  } catch (error) {
    console.error("[FATAL] Database schema / store initialization failed — exiting to avoid Render port-scan hang:", error);
    process.exit(1);
  }
}

void start();
