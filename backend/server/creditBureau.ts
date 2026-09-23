// ============================================================================
// backend/server/creditBureau.ts
//
// Single source of truth for running an external credit-bureau check for a
// borrower (Prembly). Everything that needs to pull a bureau report — the
// loan submission background pull, the borrower-facing request endpoint, the
// admin "run credit bureau check" trigger and the PENDING-report retry cron —
// goes through here so identity resolution, consent recording, report
// storage, internal-score recomputation and application snapshot sync always
// behave identically.
//
// Identity resolution ("all the information comes from the customer's
// identity and profile details"):
//   1. Explicit snapshot (the loan application's customerSnapshot) —
//      businessInfo.businessRegistrationNumber (RC number) + businessName
//      drive the COMMERCIAL (Business) Advance bureau product.
//   2. The borrower's most recent loan applications, newest first, until one
//      yields an RC number + company name.
//   3. Consumer fallback via the KYC case: verified BVN (+ verified name and
//      date of birth from the BVN lookup), then the account profile.
// ============================================================================

import { randomUUID } from "node:crypto";
import {
  creditReports,
  creditScores,
  kycCases,
  loanApplications,
  loans,
  repayments,
  users,
  persistStore,
  type CreditReport,
} from "./store.js";
import { recordConsent } from "./auth.js";
import {
  requestCommercialCreditReport,
  requestCreditReport,
  type VerificationResult,
} from "./providers/prembly.js";
import { calculateCreditScore, type CreditScoreResult } from "./credit.js";

export type CreditReportStatus = CreditReport["status"];

export interface CreditBureauIdentity {
  rcNumber?: string;
  companyName?: string;
  bvn?: string;
  fullName?: string;
  dateOfBirth?: string;
}

function digitsOnly(value: unknown): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .trim();
}

function bvnVerifiedName(kycRaw: Record<string, unknown> | undefined): string | undefined {
  const data = (kycRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data ?? {};
  const name = [
    data.title ? `${String(data.title)} ` : "",
    data.firstName,
    data.middleName ? `${String(data.middleName)} ` : "",
    data.lastName,
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  return name || undefined;
}

/**
 * Walk every identity source we hold for the borrower and return the richest
 * available identity. Business identity wins (Velocity lends to businesses,
 * so the bureau product is Commercial Advance); the consumer identity (BVN /
 * name / DOB) is always attached as fallback.
 */
export function resolveCreditBureauIdentity(
  userId: string,
  opts: { applicationId?: string; snapshot?: Record<string, unknown> } = {}
): { identity: CreditBureauIdentity; sourceApplicationId: string | null } {
  const user = users.find((u) => u.id === userId);
  const kyc = kycCases.find((k) => k.userId === userId);
  const kycRaw = kyc?.providerRaw as Record<string, unknown> | undefined;
  const hasBvn = typeof kyc?.bvn === "string" && kyc.bvn.length === 11;

  const baseIdentity: CreditBureauIdentity = {
    bvn: hasBvn ? kyc!.bvn : undefined,
    fullName: bvnVerifiedName(kycRaw) ?? user?.fullName ?? undefined,
    dateOfBirth:
      typeof ((kycRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data?.dateOfBirth) === "string"
        ? String(((kycRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)!.bvn!.data!).dateOfBirth)
        : user?.dateOfBirth ?? undefined,
  };

  // Candidate snapshots, most authoritative first.
  const candidates: Array<{ snapshot: Record<string, unknown> | undefined; applicationId: string | null }> = [];
  if (opts.snapshot) candidates.push({ snapshot: opts.snapshot, applicationId: opts.applicationId ?? null });
  if (opts.applicationId) {
    const matched = loanApplications.find(
      (a) => a.id === opts.applicationId || a.applicationId === opts.applicationId
    );
    if (matched) candidates.push({ snapshot: matched.customerSnapshot as Record<string, unknown> | undefined, applicationId: matched.applicationId ?? matched.id });
  }
  const recent = loanApplications
    .filter((a) => a.borrowerId === userId)
    .sort((a, b) =>
      String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(
        String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "")
      )
    );
  for (const app of recent) {
    candidates.push({ snapshot: app.customerSnapshot as Record<string, unknown> | undefined, applicationId: app.applicationId ?? app.id });
  }

  for (const candidate of candidates) {
    const businessInfo = (candidate.snapshot as { businessInfo?: Record<string, unknown> } | undefined)?.businessInfo;
    const rcNumber = digitsOnly(businessInfo?.businessRegistrationNumber);
    const companyName = String(businessInfo?.businessName ?? "").trim();
    if (rcNumber && companyName) {
      return {
        identity: { ...baseIdentity, rcNumber, companyName },
        sourceApplicationId: candidate.applicationId,
      };
    }
  }
  return { identity: baseIdentity, sourceApplicationId: null };
}

export function mapProviderStatus(status: VerificationResult["status"]): CreditReportStatus {
  if (status === "SUCCESS") return "RECEIVED";
  if (status === "PENDING" || status === "MANUAL_REVIEW") return "PENDING";
  return "FAILED";
}

export function extractReportScore(result: VerificationResult): number | undefined {
  const normalized = result.normalizedFields as { score?: unknown } | undefined;
  if (typeof normalized?.score === "number") return normalized.score;
  const raw = result.rawResponse as { score?: unknown } | undefined;
  if (typeof raw?.score === "number") return raw.score;
  return undefined;
}

/**
 * Recompute the borrower's internal credit score with the bureau score as an
 * input factor, updating (or creating) their latest creditScores row.
 * Returns the fresh result so callers can embed it into application
 * creditReportSnapshot.internal; null when there is no bureau score yet.
 */
export function recomputeInternalCreditScore(userId: string, bureauScore: number | null | undefined): CreditScoreResult | null {
  if (bureauScore == null || !Number.isFinite(Number(bureauScore))) return null;
  const user = users.find((u) => u.id === userId);
  const userLoans = loans.filter((item) => item.borrowerId === userId);
  const userPayments = repayments.filter((item) => item.borrowerId === userId && item.status === "SUCCESSFUL");
  const recomputed = calculateCreditScore({
    completedLoans: userLoans.filter((item) => item.status === "REPAID").length,
    onTimePayments: userPayments.filter((item) => item.onTime === true).length,
    latePayments: userPayments.filter((item) => item.onTime === false).length,
    defaultedLoans: userLoans.filter((item) => item.status === "DEFAULTED").length,
    outstandingMinor: userLoans.reduce((sum, item) => sum + Math.round(Number(item.outstandingNaira ?? 0) * 100), 0),
    totalBorrowedMinor: userLoans.reduce((sum, item) => sum + Math.round(Number(item.principalNaira ?? 0) * 100), 0),
    kycVerified: user?.kycStatus === "VERIFIED",
    bureauScore: Number(bureauScore),
  });
  const idx = creditScores.findIndex((s) => s.userId === userId);
  if (idx >= 0) {
    creditScores[idx] = {
      ...creditScores[idx],
      score: recomputed.score,
      band: recomputed.band,
      factors: recomputed.factors as unknown as Array<Record<string, unknown>>,
      createdAt: recomputed.calculatedAt,
    };
  } else {
    creditScores.push({
      id: randomUUID(),
      userId,
      version: recomputed.version,
      score: recomputed.score,
      band: recomputed.band,
      factors: recomputed.factors as unknown as Array<Record<string, unknown>>,
      createdAt: recomputed.calculatedAt,
    });
  }
  return recomputed;
}

/** The shape the admin detail card (and borrower credit history) renders. */
export function externalReportPayload(report: CreditReport): Record<string, unknown> {
  const normalized = (report.normalizedFields ?? {}) as Record<string, unknown>;
  return {
    provider: report.provider,
    product: typeof normalized.reportType === "string" ? normalized.reportType : "CONSUMER_ADVANCE",
    status: report.status,
    score: report.score ?? null,
    reportReference: report.reportReference ?? null,
    requestedAt: report.requestedAt ?? null,
    consentGrantedAt: report.consentGrantedAt ?? null,
    pulledAt: report.createdAt,
    normalizedFields: report.normalizedFields,
    reason: typeof normalized.reason === "string" ? normalized.reason : undefined,
  };
}

/**
 * Push a report (and optionally the recomputed internal score) into the
 * borrower's loan applications so the admin credit card reflects the latest
 * bureau state. With an explicit applicationId only that application is
 * touched; otherwise only applications whose external snapshot is not yet
 * RECEIVED are refreshed (latest first).
 */
export function syncApplicationCreditSnapshots(
  userId: string,
  report: CreditReport,
  internal: CreditScoreResult | null,
  applicationId?: string
): void {
  const now = new Date().toISOString();
  const candidates = applicationId
    ? loanApplications.filter((a) => a.id === applicationId || a.applicationId === applicationId)
    : loanApplications
        .filter((a) => a.borrowerId === userId)
        .sort((a, b) =>
          String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(
            String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "")
          )
        );
  for (const application of candidates) {
    if (!applicationId) {
      const external = (application.creditReportSnapshot as { external?: { status?: string } } | undefined)?.external;
      if (external?.status === "RECEIVED") continue;
    }
    const existing = (application.creditReportSnapshot ?? {}) as Record<string, unknown>;
    application.creditReportSnapshot = {
      ...existing,
      external: externalReportPayload(report),
      ...(internal ? { internal } : {}),
    };
    application.updatedAt = now;
  }
}

export type CreditBureauCheckOutcome =
  | { ok: true; report: CreditReport; internal: CreditScoreResult | null }
  | { ok: false; reason: "NO_USER" | "NO_IDENTITY"; message: string };

/**
 * Run a full bureau check for a borrower: resolve identity → record consent →
 * call Prembly (Commercial Advance when an RC number + company name are
 * known, consumer advance otherwise) → store the report → recompute the
 * internal score → sync application snapshots → persist.
 */
export async function runCreditBureauCheck(
  userId: string,
  opts: {
    applicationId?: string;
    source?: string;
    snapshot?: Record<string, unknown>;
    dataMode?: "BASIC" | "ADVANCE";
  } = {}
): Promise<CreditBureauCheckOutcome> {
  const user = users.find((u) => u.id === userId);
  if (!user) return { ok: false, reason: "NO_USER", message: "Borrower account was not found." };
  const { identity } = resolveCreditBureauIdentity(userId, opts);
  if (!identity.rcNumber && !identity.bvn && !identity.fullName) {
    return {
      ok: false,
      reason: "NO_IDENTITY",
      message:
        "No usable identity for a credit bureau check — the customer profile has no business RC number, verified BVN or full name.",
    };
  }

  recordConsent(userId, "CREDIT_REPORT");
  const now = new Date().toISOString();

  let result: VerificationResult;
  if (identity.rcNumber && identity.companyName) {
    result = await requestCommercialCreditReport({
      rcNumber: identity.rcNumber,
      companyName: identity.companyName,
      dataMode: opts.dataMode,
    });
  } else if (identity.bvn) {
    result = await requestCreditReport({
      mode: "ID",
      number: identity.bvn,
      customer_name: identity.fullName,
      dob: identity.dateOfBirth,
    });
  } else {
    result = await requestCreditReport({
      mode: "BIO",
      customer_name: identity.fullName,
      dob: identity.dateOfBirth,
    });
  }

  const normalized = { ...(result.normalizedFields ?? {}) } as Record<string, unknown>;
  if (opts.source) normalized.source = opts.source;
  if (result.errorMessage) normalized.reason = result.errorMessage;
  const raw = result.rawResponse ?? {};
  const status = mapProviderStatus(result.status);
  const score = extractReportScore(result);
  const report: CreditReport = {
    id: randomUUID(),
    userId,
    provider: "prembly",
    consentGrantedAt: now,
    requestedAt: now,
    reportReference: result.providerReference,
    status,
    score,
    normalizedFields: normalized,
    redactedRaw: raw,
    createdAt: now,
  };
  creditReports.push(report);

  const internal = recomputeInternalCreditScore(userId, status === "RECEIVED" ? score ?? null : null);
  syncApplicationCreditSnapshots(userId, report, internal, opts.applicationId);
  await persistStore().catch(() => undefined);
  return { ok: true, report, internal };
}

/**
 * Re-run the provider lookup for an existing (PENDING) report. Commercial
 * reports retry with the RC number / company name stored in the report;
 * consumer reports re-resolve the borrower's BVN + name + DOB.
 */
export async function retryCreditReport(report: CreditReport): Promise<VerificationResult> {
  const normalized = (report.normalizedFields ?? {}) as Record<string, unknown>;
  if (normalized.reportType === "COMMERCIAL_ADVANCE" && normalized.rcNumber && normalized.companyName) {
    return requestCommercialCreditReport({
      rcNumber: String(normalized.rcNumber),
      companyName: String(normalized.companyName),
      dataMode: typeof normalized.dataMode === "string" && normalized.dataMode === "BASIC" ? "BASIC" : "ADVANCE",
    });
  }
  const { identity } = resolveCreditBureauIdentity(report.userId);
  if (identity.bvn) {
    return requestCreditReport({
      mode: "ID",
      number: identity.bvn,
      customer_name: identity.fullName,
      dob: identity.dateOfBirth,
    });
  }
  return requestCreditReport({ mode: "BIO", customer_name: identity.fullName, dob: identity.dateOfBirth });
}
