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
//
// BVN is the ONLY identifier the Prembly consumer credit-bureau endpoint
// accepts, and BVN is MANDATORY for every borrower. The pipeline therefore
// always resolves the FULL, unmasked 11-digit BVN (resolveFullBvn) from every
// raw source we hold and passes exactly that to the bureau — masked display
// values ("***-***-1234") and NINs are never sent to the credit endpoint.
// ============================================================================

import { randomUUID } from "node:crypto";
import {
  creditReports,
  creditScores,
  identityVerificationEvents,
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
  nin?: string;
  fullName?: string;
  dateOfBirth?: string;
}

function digitsOnly(value: unknown): string {
  return String(value ?? "")
    .replace(/\D/g, "")
    .trim();
}

/** A usable government identifier: exactly 11 digits (masked values like
 *  "***-***-1234" stored for display do NOT qualify). */
export function fullIdentifier(value: unknown): string | undefined {
  const digits = digitsOnly(value);
  return /^\d{11}$/.test(digits) ? digits : undefined;
}

/** Normalize NIN birthdates ("DD-MM-YYYY" from NIMC) to YYYY-MM-DD. */
function normalizeDob(value: unknown): string | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  const dmy = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return undefined;
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

/** Identity payload from the NIN Advance verification (providerRaw.nin). */
function ninIdentity(kycRaw: Record<string, unknown> | undefined): { nin?: string; fullName?: string; dateOfBirth?: string; bvn?: string } {
  const ninNode = (kycRaw as { nin?: Record<string, unknown> | undefined } | undefined)?.nin;
  if (!ninNode || typeof ninNode !== "object") return {};
  const data = ((ninNode.nin_data ?? ninNode.data ?? {}) as Record<string, unknown>);
  const fullName = [data.firstname, data.middlename, data.surname]
    .filter((v) => v && String(v).trim())
    .map((v) => String(v).trim())
    .join(" ").trim() || undefined;
  return {
    nin: fullIdentifier(data.nin ?? data.vnin ?? ninNode.nin_number),
    bvn: fullIdentifier(data.bvn),
    fullName,
    dateOfBirth: normalizeDob(data.birthdate ?? data.dateOfBirth ?? data.dob),
  };
}

/* =========================================================================
   FULL-IDENTIFIER RESOLUTION ("unmask during information pooling")

   The display BVN stored on a KYC case / application snapshot is often
   masked ("***-***-1234") and legacy rows may hold either identifier alone.
   These resolvers walk EVERY raw source we hold — KYC case columns, the
   NIBSS/NIMC provider raw blocks, the per-verification event raw responses
   and the application snapshots — and return the FULL 11-digit number.
   Masked values never qualify. Pooling surfaces (reapply-prefill, KYC
   prefill, /me/kyc) and the credit bureau pipeline all go through here so
   the real BVN is always what gets pooled and passed to Prembly.
   ========================================================================= */

function kycRawNode(userId: string): { kyc?: Record<string, unknown>; raw?: Record<string, unknown> } {
  const kyc = kycCases.find((k) => k.userId === userId);
  return {
    kyc: kyc as unknown as Record<string, unknown> | undefined,
    raw: kyc?.providerRaw as Record<string, unknown> | undefined,
  };
}

/** Newest-first successful verification events of a given type. */
function verificationEventRaw(userId: string, type: "BVN" | "NIN"): Array<Record<string, unknown>> {
  return identityVerificationEvents
    .filter((e) => {
      const caseKyc = kycCases.find((k) => k.id === (e as { kycCaseId?: string }).kycCaseId);
      return caseKyc?.userId === userId && (e as { verificationType?: string }).verificationType === type && (e as { status?: string }).status === "SUCCESS";
    })
    .sort((a, b) => String((b as { createdAt?: string }).createdAt ?? "").localeCompare(String((a as { createdAt?: string }).createdAt ?? "")))
    .map((e) => ((e as { rawResponse?: Record<string, unknown> }).rawResponse ?? {}) as Record<string, unknown>);
}

/** Application snapshots for the borrower, newest submitted first. */
function snapshotKycLayers(userId: string): Array<Record<string, unknown>> {
  return loanApplications
    .filter((a) => a.borrowerId === userId)
    .sort((a, b) =>
      String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(
        String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "")
      )
    )
    .map((a) => ((a.customerSnapshot ?? {}) as { kyc?: Record<string, unknown> }).kyc ?? {})
    .filter((k) => k && typeof k === "object");
}

/**
 * Resolve the borrower's FULL, unmasked 11-digit BVN from every source we
 * hold. Order: KYC case column → NIBSS BVN raw block → NIMC raw block
 * (the NIN Advance response carries the linked BVN when NIMC returns it) →
 * successful BVN verification events → application snapshots.
 */
export function resolveFullBvn(userId: string): string | undefined {
  const { kyc, raw } = kycRawNode(userId);
  const fromCase = fullIdentifier(kyc?.bvn);
  if (fromCase) return fromCase;
  const bvnNode = (raw as { bvn?: { data?: Record<string, unknown>; bvn_data?: Record<string, unknown> } | undefined } | undefined)?.bvn;
  const fromBvnRaw = fullIdentifier(bvnNode?.data?.bvn ?? bvnNode?.bvn_data?.bvn);
  if (fromBvnRaw) return fromBvnRaw;
  const fromNinRaw = ninIdentity(raw).bvn;
  if (fromNinRaw) return fromNinRaw;
  for (const eventRaw of verificationEventRaw(userId, "BVN")) {
    const node = (eventRaw as { bvn?: { data?: Record<string, unknown>; bvn_data?: Record<string, unknown> } | undefined }).bvn;
    const candidate = fullIdentifier(node?.data?.bvn ?? node?.bvn_data?.bvn);
    if (candidate) return candidate;
  }
  for (const layer of snapshotKycLayers(userId)) {
    const candidate = fullIdentifier(layer.bvn);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Resolve the borrower's FULL, unmasked 11-digit NIN from every source we
 * hold: KYC case column → NIMC raw block → NIBSS raw block (the BVN Advance
 * response carries the linked NIN when NIBSS returns it) → successful NIN
 * verification events → application snapshots.
 */
export function resolveFullNin(userId: string): string | undefined {
  const { kyc, raw } = kycRawNode(userId);
  const fromCase = fullIdentifier(kyc?.nin);
  if (fromCase) return fromCase;
  const fromNinRaw = ninIdentity(raw).nin;
  if (fromNinRaw) return fromNinRaw;
  const bvnNode = (raw as { bvn?: { data?: Record<string, unknown>; bvn_data?: Record<string, unknown> } | undefined } | undefined)?.bvn;
  const fromBvnRaw = fullIdentifier(bvnNode?.data?.nin ?? bvnNode?.bvn_data?.nin);
  if (fromBvnRaw) return fromBvnRaw;
  for (const eventRaw of verificationEventRaw(userId, "NIN")) {
    const node = (eventRaw as { nin?: Record<string, unknown> | undefined }).nin;
    if (!node || typeof node !== "object") continue;
    const data = ((node.nin_data ?? node.data ?? {}) as Record<string, unknown>);
    const candidate = fullIdentifier(data.nin ?? data.vnin ?? node.nin_number);
    if (candidate) return candidate;
  }
  for (const layer of snapshotKycLayers(userId)) {
    const candidate = fullIdentifier(layer.nin);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Self-healing unmask: write the resolved FULL identifiers back onto the KYC
 * case whenever the stored column is masked or missing, and harvest the
 * cross-identifier (NIBSS response → NIN, NIMC response → BVN) into the raw
 * store so BOTH BVN and NIN are always on file. Legacy rows created before
 * the raw-merge fix are repaired the first time any pooling surface touches
 * the borrower. Returns the (possibly upgraded) identifiers.
 */
export function backfillIdentityNumbers(userId: string): { bvn?: string; nin?: string } {
  const kyc = kycCases.find((k) => k.userId === userId);
  if (!kyc) return {};
  const kycRecord = kyc as unknown as Record<string, unknown>;
  const raw = (kyc.providerRaw ?? {}) as Record<string, unknown>;
  let changed = false;

  const bvn = resolveFullBvn(userId);
  if (bvn && !/^\d{11}$/.test(String(kycRecord.bvn ?? ""))) {
    kycRecord.bvn = bvn;
    changed = true;
  }
  const nin = resolveFullNin(userId);
  if (nin && !/^\d{11}$/.test(String(kycRecord.nin ?? ""))) {
    kycRecord.nin = nin;
    changed = true;
  }

  // Harvest the cross-identifier into providerRaw so the raw store always
  // holds BOTH the BVN and NIN blocks (never just the last-verified one).
  if (bvn && !raw.bvn) {
    raw.bvn = { data: { bvn }, source: "identity-backfill" };
    changed = true;
  }
  if (nin && !raw.nin) {
    raw.nin = { data: { nin }, source: "identity-backfill" };
    changed = true;
  }
  if (changed) {
    kyc.providerRaw = raw;
    kyc.updatedAt = new Date().toISOString();
  }
  return { bvn, nin };
}

/**
 * Walk every identity source we hold for the borrower and return the richest
 * available identity. Business identity wins (Velocity lends to businesses,
 * so the bureau product is Commercial Advance); the consumer identity (full
 * BVN / NIN / verified name / DOB) is always attached as fallback.
 *
 * The consumer identifier is ALWAYS the FULL, unmasked 11-digit BVN — the
 * Prembly consumer credit-bureau endpoint accepts nothing else, and BVN is
 * mandatory for every borrower. resolveFullBvn() unmasks the display value
 * by walking the NIBSS/NIMC raw responses, verification events and
 * application snapshots; the NIN is attached for record-keeping only and is
 * NEVER sent to the credit endpoint.
 */
export function resolveCreditBureauIdentity(
  userId: string,
  opts: { applicationId?: string; snapshot?: Record<string, unknown> } = {}
): { identity: CreditBureauIdentity; sourceApplicationId: string | null } {
  const user = users.find((u) => u.id === userId);
  const kyc = kycCases.find((k) => k.userId === userId);
  const kycRaw = kyc?.providerRaw as Record<string, unknown> | undefined;
  // Unmask first: repairing masked/missing columns here also heals every
  // downstream pooling surface (reapply-prefill, KYC prefill, /me/kyc).
  backfillIdentityNumbers(userId);
  const fullBvn = resolveFullBvn(userId);
  const fullNin = resolveFullNin(userId);
  const fromNin = ninIdentity(kycRaw);

  const baseIdentity: CreditBureauIdentity = {
    bvn: fullBvn,
    nin: fullNin ?? fromNin.nin,
    fullName: bvnVerifiedName(kycRaw) ?? fromNin.fullName ?? user?.fullName ?? undefined,
    dateOfBirth:
      normalizeDob((kycRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data?.dateOfBirth) ??
      fromNin.dateOfBirth ??
      (typeof user?.dateOfBirth === "string" && user.dateOfBirth ? user.dateOfBirth : undefined),
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
    // Provider reason OR the thin-file notice ("There is no record for this
    // borrower") so the admin card always explains a null score.
    reason:
      (typeof normalized.reason === "string" && normalized.reason) ||
      (typeof normalized.bureauNotice === "string" && normalized.bureauNotice) ||
      undefined,
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
  | { ok: true; report: CreditReport; internal: CreditScoreResult | null; completion: Promise<void> }
  | { ok: false; reason: "NO_USER" | "NO_IDENTITY"; message: string };

// Reports whose provider call is running in the background right now. The
// reconciliation cron must NOT retry these (double pull = double billing),
// and tests poll this set to await completion.
const inFlightChecks = new Set<string>();

export function isCreditBureauCheckInFlight(reportId: string): boolean {
  return inFlightChecks.has(reportId);
}

/**
 * Start a bureau check for a borrower WITHOUT waiting for the provider:
 * resolve identity → record consent → create the report row as PENDING (with
 * the resolved identity + product metadata) → persist → run the provider
 * call in the background. The caller gets the PENDING report immediately —
 * the admin card / borrower credit page poll or refresh to see the final
 * state, and the reconciliation cron self-heals anything left PENDING.
 *
 * Why: real bureau lookups take 25-90s (FirstCentral consumer measured ~27s
 * live). A synchronous endpoint would hang the HTTP request and get cut off
 * by proxies/browsers long before Prembly answers.
 */
export async function startCreditBureauCheck(
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
  const { identity, sourceApplicationId } = resolveCreditBureauIdentity(userId, opts);
  // BVN is MANDATORY for the consumer product: the Prembly credit-bureau API
  // is strictly BVN-driven, so a customer without a business RC number MUST
  // have a full, unmasked 11-digit BVN on file. A NIN is never a substitute.
  if (!identity.rcNumber && !identity.bvn) {
    return {
      ok: false,
      reason: "NO_IDENTITY",
      message:
        "No usable identity for a credit bureau check — the customer needs a business RC number (commercial product) or a verified 11-digit BVN (consumer product). BVN is mandatory: the Prembly credit bureau API does not accept a NIN, so ask the customer to complete BVN verification and retry.",
    };
  }

  recordConsent(userId, "CREDIT_REPORT");
  const now = new Date().toISOString();
  const reportType = identity.rcNumber && identity.companyName ? "COMMERCIAL_ADVANCE" : "CONSUMER_ADVANCE";
  const maskId = (value: string | undefined): string | undefined =>
    value && /^\d{11}$/.test(value) ? `***-***-${value.slice(-4)}` : undefined;
  const report: CreditReport = {
    id: randomUUID(),
    userId,
    provider: "prembly",
    consentGrantedAt: now,
    requestedAt: now,
    reportReference: undefined,
    status: "PENDING",
    score: undefined,
    normalizedFields: {
      reportType,
      source: opts.source ?? "UNKNOWN",
      identitySource: sourceApplicationId,
      ...(identity.rcNumber ? { rcNumber: identity.rcNumber } : {}),
      ...(identity.companyName ? { companyName: identity.companyName } : {}),
      // Identifiers on file for this check — masked here for display; the
      // full values live in the KYC raw store and the provider rawResponse.
      ...(identity.bvn ? { bvnMasked: maskId(identity.bvn), bvnProvided: true } : {}),
      ...(identity.nin ? { ninMasked: maskId(identity.nin), ninOnFile: true } : {}),
      ...(opts.dataMode ? { dataMode: opts.dataMode } : {}),
      note: "Credit bureau lookup in progress — this report updates automatically when the provider responds.",
    },
    redactedRaw: {},
    createdAt: now,
  };
  creditReports.push(report);
  await persistStore().catch(() => undefined);

  const completion = executeCreditBureauCheck(report, userId, identity, opts).catch((error) => {
    console.error("[creditBureau] background bureau check failed:", error);
  });
  return { ok: true, report, internal: null, completion };
}

/**
 * Run the provider call for an already-created PENDING report and finalize
 * it: update the row in place, recompute the internal score on success and
 * sync the loan application credit snapshots.
 */
async function executeCreditBureauCheck(
  report: CreditReport,
  userId: string,
  identity: CreditBureauIdentity,
  opts: { applicationId?: string; dataMode?: "BASIC" | "ADVANCE" } = {}
): Promise<void> {
  inFlightChecks.add(report.id);
  try {
    let result: VerificationResult;
    if (identity.rcNumber && identity.companyName) {
      result = await requestCommercialCreditReport({
        rcNumber: identity.rcNumber,
        companyName: identity.companyName,
        dataMode: opts.dataMode,
      });
    } else if (identity.bvn) {
      // Consumer product, ID mode — ALWAYS the full BVN. The Prembly
      // credit-bureau API is strictly BVN-driven, so the NIN is never passed
      // here even when one is on file.
      result = await requestCreditReport({
        mode: "ID",
        number: identity.bvn,
        customer_name: identity.fullName,
        dob: identity.dateOfBirth,
      });
    } else {
      result = {
        status: "FAILED",
        errorMessage:
          "A verified 11-digit BVN is mandatory for a consumer credit bureau check — the Prembly credit bureau API does not accept a NIN. Ask the customer to complete BVN verification and retry.",
      };
    }

    const normalized = { ...(result.normalizedFields ?? {}) } as Record<string, unknown>;
    // Preserve the trigger metadata stored at creation time (including the
    // masked identifier audit fields — the full numbers never enter the
    // report metadata).
    for (const key of ["source", "identitySource", "rcNumber", "companyName", "dataMode", "bvnMasked", "ninMasked", "bvnProvided", "ninOnFile"] as const) {
      const existing = (report.normalizedFields as Record<string, unknown> | undefined)?.[key];
      if (existing != null && normalized[key] == null) normalized[key] = existing;
    }
    if (result.errorMessage) normalized.reason = result.errorMessage;
    const status = mapProviderStatus(result.status);
    const score = extractReportScore(result);
    report.status = status;
    report.score = status === "RECEIVED" ? score : undefined;
    report.reportReference = result.providerReference ?? report.reportReference;
    report.normalizedFields = normalized;
    report.redactedRaw = result.rawResponse ?? {};

    const internal = recomputeInternalCreditScore(userId, status === "RECEIVED" ? score ?? null : null);
    syncApplicationCreditSnapshots(userId, report, internal, opts.applicationId);
    await persistStore().catch(() => undefined);
  } finally {
    inFlightChecks.delete(report.id);
  }
}

/**
 * Re-run the provider lookup for an existing (PENDING) report. Commercial
 * reports retry with the RC number / company name stored in the report;
 * consumer reports re-resolve the borrower's FULL unmasked BVN (+ name + DOB)
 * and always pass the BVN — the Prembly credit-bureau API is strictly
 * BVN-driven, a NIN is never sent.
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
  return {
    status: "FAILED",
    errorMessage:
      "A verified 11-digit BVN is mandatory to retry this consumer credit bureau check — the Prembly credit bureau API does not accept a NIN. Ask the customer to complete BVN verification and retry.",
  };
}

/**
 * Back-compat full check: start the bureau check and WAIT for the provider
 * to answer. Used by tests and any caller that genuinely needs the final
 * result inline. New code should prefer startCreditBureauCheck().
 */
export async function runCreditBureauCheck(
  userId: string,
  opts: {
    applicationId?: string;
    source?: string;
    snapshot?: Record<string, unknown>;
    dataMode?: "BASIC" | "ADVANCE";
  } = {}
): Promise<{ ok: true; report: CreditReport; internal: CreditScoreResult | null } | { ok: false; reason: "NO_USER" | "NO_IDENTITY"; message: string }> {
  const started = await startCreditBureauCheck(userId, opts);
  if (!started.ok) return started;
  await started.completion;
  return { ok: true, report: started.report, internal: recomputeInternalCreditScore(userId, started.report.status === "RECEIVED" ? started.report.score ?? null : null) };
}
