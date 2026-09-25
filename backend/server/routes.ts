import { createHmac, randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  issueToken,
  requireAuth,
  requireRole,
  type AuthRequest,
  createOtpChallenge,
  verifyOtpChallenge,
  OtpRateLimitError,
  findOtpChallenge,
  findLatestOtpChallenge,
  requestPasswordReset,
  confirmPasswordReset,
  markKycChecklistComplete,
  recordConsent,
  resetKycCategory,
  type KycResetCategory,
} from "./auth.js";
import { calculateInvestmentAccrual } from "./investments.js";
import {
  createWallet,
  findUserByEmail,
  findWallet,
  findOrCreateKycCase,
  investments,
  investmentPlans,
  loans,
  repayments,
  users,
  wallets,
  walletTransactions,
  ledgerEntries,
  documents,
  creditHistory,
  creditScores,
  creditReports,
  providerEvents,
  payoutAccounts,
  payouts,
  kycCases,
  identityVerificationEvents,
  appendLedger,
  loanProducts,
  loanApplications,
  applicationDrafts,
  loanSchedules,
  notifications,
  consents,
  auditLogs,
  otpChallenges,
  type KycStatus,
  type Role,
  type CreditReport,
  type LoanStatus,
  type AdminLedgerEntry,
  ADMIN_PERMISSIONS,
  getAdminLedgerBalanceMinor,
  adminLedger,
  getPlatformSettings,
  updatePlatformSettings,
  setInvestorEarningRateOverride,
  getEffectiveInvestorRate,
  investorWithdrawals,
  appendAdminLedger,
  settleWalletDeposit,
  LOAN_STAGES,
  seedLoanStageStatuses,
  type StageStatus,
  type LoanStageKey,
  type LoanProductSnapshot,
  loanDisbursements,
  disbursementAccounts,
  accountChangeRequests,
  indexes,
  listRecentJobRuns,
  decomposeRuntimeStateIntoTables,
  reloadStoreFromRelationalTables,
  persistStore,
  normalizeLoanProducts,
  ensureLoanProductsLoaded,
  purgeGhostCatalogRows,
  normalizeTenorInterestRates,
  resolveTenorMonthlyRate,
  type TenorInterestRate,
} from "./store.js";
import { runExportSheetsBackup } from "./exportSheetsBackup.js";
import { env } from "./config.js";
import { sql } from "./db.js";
import { uploadPrivateDocument } from "./storage/googleDrive.js";
import { calculateCreditScore } from "./credit.js";
import {
  backfillIdentityNumbers,
  externalReportPayload,
  fullIdentifier,
  recomputeInternalCreditScore,
  resolveFullBvn,
  resolveFullNin,
  startCreditBureauCheck,
  type CreditBureauCheckOutcome,
} from "./creditBureau.js";
import { evaluateLoanEligibility } from "./loanDecision.js";
import {
  initializeRepayment,
  createLoanDisbursement,
  createInvestorPayout,
  initializeWalletFunding,
  verifyTransaction,
  verifyTransactionByReference,
  verifyTransactionWithRetry,
  verifyTransferWithRetry,
  pollTransferUntilTerminal,
  resolveBankAccount,
  listBanks,
  FlutterwaveError,
  normalizeBankCodeForFlutterwave,
} from "./providers/flutterwave.js";
import { verifyBvn, verifyNin, verifyIdentityWithFace } from "./providers/prembly.js";
import { sendEmail, investorWithdrawalEmail, investorWalletFundedEmail, welcomeEmail, loginAttemptEmail, kycStatusEmail, kycSubmittedEmail, kycActionBlockedEmail, maintenanceModeEmail, loanApplicationSubmittedEmail, loanDecisionEmail, loanAwaitingDisbursementEmail, loanDisbursedEmail, disbursementAccountUpdateRequestedEmail } from "./email.js";
import type { KycCategory, KycCategoryResult, PlatformAnnouncement, PlatformBanner, Document as StoreDocument } from "./store.js";

const router = Router();
// Wallet/funding/withdrawal endpoints must respond in well under a second.
// Persistence continues in the background (persistStore chains in-flight runs
// and a 20s sweeper retries failures), so a slow database never blocks the
// HTTP response — it only delays durability, not the user.
const PERSIST_TIMEOUT_MS = 8_000;

async function persistMutation(res: any): Promise<boolean> {
  if (!sql) {
    // Without PostgreSQL the in-memory store is the only source of truth.
    // Failing every mutation would break the entire product, so continue and
    // flag the degraded mode to the client.
    return true;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    await Promise.race([
      persistStore(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("Persistence timed out"));
        }, PERSIST_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    if (timedOut) {
      // The persist is still running (or the sweeper will retry). Respond now —
      // the mutation is already applied in memory and will converge to disk.
      console.warn("[routes] PostgreSQL persistence slow — responding without waiting");
      return true;
    }
    // HARD persistence failure. The mutation is ALREADY applied in memory, so
    // telling the client "Unable to save your information" was a lie that
    // caused real damage: admins saw an error on loan approval even though the
    // approval HAD succeeded, then re-submitted and got duplicate/conflict
    // errors. The 20s sweeper keeps retrying the persist, so durability
    // converges in the background. Log loudly and let the request succeed.
    console.error("[routes] PostgreSQL persistence failed (mutation stays applied, background sweeper will retry):", error);
    if (res && typeof res.setHeader === "function" && !res.headersSent) {
      res.setHeader("X-Persist-Retrying", "1");
    }
    return true;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type PersistBestEffortResult = { ok: true; persistRetrying: false } | { ok: true; persistRetrying: true; persistError: string };

// Fire-and-forget persistence for fast wallet flows. The 20s sweeper retries
// if this fails, so nothing is lost — the request just doesn't wait for it.
function schedulePersist(): void {
  void persistStore().catch((error) => {
    console.error("[routes] background persistence failed (sweeper will retry):", error);
  });
}

async function persistMutationBestEffort(res: any): Promise<PersistBestEffortResult> {
  if (!sql) {
    return { ok: true, persistRetrying: true, persistError: "PostgreSQL is not configured. Retrying in background." };
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      persistStore(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Persistence timed out")), PERSIST_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, persistRetrying: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown persistence error";
    console.error("[routes] PostgreSQL persistence failed (best-effort — continuing with in-memory state):", error);
    return { ok: true, persistRetrying: true, persistError: msg };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const normalizePhone = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const digits = value.replace(/[\s()-]/g, "");
  if (digits.startsWith("+234")) return `0${digits.slice(4)}`;
  if (digits.startsWith("234") && digits.length === 13) return `0${digits.slice(3)}`;
  return digits;
};

function loginOtpPhone(phone: string | undefined): string | undefined {
  const normalized = normalizePhone(phone);
  return typeof normalized === "string" && /^0\d{10}$/.test(normalized) ? normalized : undefined;
}

function recordAdminAudit(req: AuthRequest, action: string, resourceType: string, resourceId: string | undefined, metadata?: Record<string, unknown>): void {
  auditLogs.push({
    id: randomUUID(),
    userId: req.user?.id,
    action,
    resourceType,
    resourceId,
    metadata,
    ipAddress: req.ip,
    userAgent: req.get("user-agent") ?? undefined,
    createdAt: new Date().toISOString(),
  });
}
async function dbEmailExists(email: string): Promise<boolean | null> {
  if (!sql) return null;
  try {
    if (env.DEBUG_SQL === "true") {
      try {
        const explain = await sql.query(
          "EXPLAIN SELECT id FROM users WHERE email ILIKE $1 LIMIT 1",
          [email]
        ) as unknown as Array<Record<string, unknown>>;
        console.debug("[DEBUG_SQL] dbEmailExists EXPLAIN:", JSON.stringify(explain));
      } catch { /* EXPLAIN failure must not block query */ }
    }
    const rows = await sql.query(
      "SELECT id FROM users WHERE email ILIKE $1 LIMIT 1",
      [email]
    ) as unknown as Array<Record<string, unknown>>;
    return (rows?.length ?? 0) > 0;
  } catch (_e) {
    console.warn("[dbEmailExists] SQL failed — falling back to in-memory check. Error:", _e);
    return null;
  }
}
async function dbHasUnresolvedBorrowing(userId: string, excludeApplicationId?: string): Promise<boolean | null> {
  if (!sql) return null;
  try {
    const appParams: unknown[] = [userId];
    let appExclude = "";
    if (excludeApplicationId) { appParams.push(excludeApplicationId); appExclude = " AND id != $2"; }
    const appQ = `SELECT 1 FROM loan_applications WHERE borrower_id = $1${appExclude} AND status IN ('SUBMITTED','KYC_PENDING','UNDER_REVIEW','MORE_INFORMATION_REQUIRED') LIMIT 1`;
    const loanQ = `SELECT 1 FROM loans WHERE borrower_id = $1 AND status NOT IN ('REPAID','CANCELLED','WRITTEN_OFF') LIMIT 1`;
    if (env.DEBUG_SQL === "true") {
      try {
        const explain1 = await sql.query("EXPLAIN " + appQ, appParams) as unknown as Array<Record<string, unknown>>;
        const explain2 = await sql.query("EXPLAIN " + loanQ, [userId]) as unknown as Array<Record<string, unknown>>;
        console.debug("[DEBUG_SQL] dbHasUnresolvedBorrowing EXPLAIN (apps):", JSON.stringify(explain1));
        console.debug("[DEBUG_SQL] dbHasUnresolvedBorrowing EXPLAIN (loans):", JSON.stringify(explain2));
      } catch { /* EXPLAIN failure must not block */ }
    }
    const openApps = await sql.query(appQ, appParams) as unknown as Array<Record<string, unknown>>;
    if ((openApps?.length ?? 0) > 0) return true;
    const openLoans = await sql.query(loanQ, [userId]) as unknown as Array<Record<string, unknown>>;
    return (openLoans?.length ?? 0) > 0;
  } catch (_e) {
    console.warn("[dbHasUnresolvedBorrowing] SQL failed — falling back to in-memory check. Error:", _e);
    return null;
  }
}
async function dbIsBvnOrNinAlreadyVerifiedByOther(
  bvn: string | undefined,
  nin: string | undefined,
  excludeKycCaseId?: string
): Promise<{ conflict: boolean; existingUserId?: string; field?: "BVN" | "NIN" } | null> {
  if (!sql) return null;
  try {
    const results: Array<{ existing_user_id: string; field: "BVN" | "NIN" }> = [];
    if (bvn && bvn.length === 11) {
      const params: unknown[] = [bvn];
      let exclude = "";
      if (excludeKycCaseId) { params.push(excludeKycCaseId); exclude = " AND id != $2"; }
      const rows = await sql.query(
        `SELECT user_id AS existing_user_id, 'BVN' AS field FROM kyc_cases WHERE bvn IS NOT NULL AND bvn = $1 AND bvn_verified_at IS NOT NULL${exclude} LIMIT 1`,
        params
      ) as unknown as Array<{ existing_user_id: string; field: "BVN" | "NIN" }>;
      if (rows && rows.length > 0) results.push(...rows);
    }
    if (nin && nin.length === 11) {
      const params: unknown[] = [nin];
      let exclude = "";
      if (excludeKycCaseId) { params.push(excludeKycCaseId); exclude = " AND id != $2"; }
      const rows = await sql.query(
        `SELECT user_id AS existing_user_id, 'NIN' AS field FROM kyc_cases WHERE nin IS NOT NULL AND nin = $1 AND nin_verified_at IS NOT NULL${exclude} LIMIT 1`,
        params
      ) as unknown as Array<{ existing_user_id: string; field: "BVN" | "NIN" }>;
      if (rows && rows.length > 0) results.push(...rows);
    }
    if (results.length > 0) {
      return { conflict: true, existingUserId: results[0].existing_user_id, field: results[0].field };
    }
    return { conflict: false };
  } catch (_e) {
    console.warn("[dbIsBvnOrNinAlreadyVerifiedByOther] SQL failed — falling back to in-memory check. Error:", _e);
    return null;
  }
}
async function dbWalletAvailableMinor(userId: string): Promise<number | null> {
  if (!sql) return null;
  try {
    if (env.DEBUG_SQL === "true") {
      try {
        const explain = await sql.query(
          "EXPLAIN SELECT available_minor FROM wallets WHERE user_id = $1 LIMIT 1",
          [userId]
        ) as unknown as Array<Record<string, unknown>>;
        console.debug("[DEBUG_SQL] dbWalletAvailableMinor EXPLAIN:", JSON.stringify(explain));
      } catch { /* ignore */ }
    }
    const rows = await sql.query(
      "SELECT available_minor FROM wallets WHERE user_id = $1 LIMIT 1",
      [userId]
    ) as unknown as Array<{ available_minor: unknown }>;
    if (!rows || rows.length === 0) return null;
    const val = rows[0].available_minor;
    if (typeof val === "bigint") return Number(val);
    if (typeof val === "number") return val;
    if (typeof val === "string") return parseInt(val, 10) || 0;
    return null;
  } catch (_e) {
    console.warn("[dbWalletAvailableMinor] SQL failed — falling back to in-memory balance. Error:", _e);
    return null;
  }
}
function reconcileWalletFromDb(userId: string, dbAvailableMinor: number): void {
  const wallet = findWallet(userId);
  if (!wallet) return;
  const memAvailable = wallet.availableMinor ?? 0;
  if (memAvailable === dbAvailableMinor) return;
  console.warn(
    `[store_reconciliation_warning] Wallet for user ${userId} diverged: in-memory availableMinor=${memAvailable} DB=${dbAvailableMinor}. Overwriting in-memory state with DB truth.`
  );
  wallet.availableMinor = dbAvailableMinor;
  auditLogs.push({
    id: randomUUID(),
    userId,
    action: "wallet_reconciliation",
    resourceType: "WALLET",
    resourceId: wallet.id,
    metadata: {
      fromAvailableMinor: memAvailable,
      toAvailableMinor: dbAvailableMinor,
      delta: dbAvailableMinor - memAvailable,
      source: "db_truth_overwrite",
    },
    ipAddress: null as unknown as undefined,
    userAgent: "system:wallet_reconciliation",
    createdAt: new Date().toISOString(),
  });
}
const consentSchema = z.object({
  terms: z.boolean().refine((v) => v === true, "Terms consent is required"),
  privacy: z.boolean().refine((v) => v === true, "Privacy policy consent is required"),
  identityVerification: z.boolean().default(true),
  electronicCommunications: z.boolean().default(true),
});
const registerSchema = z
  .object({
    email: z.string().email("Valid email address is required"),
    phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/, "Enter a valid Nigerian phone number")),
    fullName: z.string().min(2).max(120),
    password: z.string().min(8, "Password must be at least 8 characters"),
    role: z.enum(["INVESTOR", "BORROWER"]).default("BORROWER"),
    preferredOtpChannel: z.enum(["SMS", "EMAIL"]).default("EMAIL"),
    dateOfBirth: z.string().optional(),
    residentialAddress: z.record(z.unknown()).optional(),
    occupation: z.string().optional(),
    sourceOfFunds: z.string().optional(),
    consents: consentSchema,
  })
  .strict();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
const adminOtpChannelSchema = z.enum(["EMAIL"]).default("EMAIL");
const amountSchema = z.object({ amountNaira: z.number().positive().finite() });
function paginate<T>(items: T[], query: Record<string, unknown>): { items: T[]; meta: { total: number; limit: number; offset: number; hasMore: boolean } } {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { items: items.slice(offset, offset + limit), meta: { total: items.length, limit, offset, hasMore: offset + limit < items.length } };
}

// Parse a `?from=` / `?to=` date-range query value. Accepts full ISO timestamps
// as well as plain `YYYY-MM-DD` days. `to` is inclusive by default: a plain
// date means "everything that happened on that day" (end of day).
function parseDateQueryParam(value: unknown, options: { endOfDay?: boolean } = {}): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dayOnly ? (options.endOfDay ? `${raw}T23:59:59.999` : `${raw}T00:00:00.000`) : raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const kycCategoryForEvent: Record<string, KycCategory> = { BVN: "BVN", NIN: "NIN", LIVENESS: "LIVENESS", PASSPORT: "PASSPORT", ADDRESS: "ADDRESS", SIGNATURE: "SIGNATURE" };
function providerReason(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.replace(/<[^>]*>/g, "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 500) || "The identity provider could not verify the submitted details.";
}
function setKycCategoryResult(kyc: any, category: KycCategory, status: KycCategoryResult["status"], reason?: string): void {
  kyc.categoryResults = { ...(kyc.categoryResults ?? {}), [category]: { status, reason: reason ? providerReason(reason) : undefined, updatedAt: new Date().toISOString() } };
}
async function notifyKyc(user: { email: string; fullName: string }, status: "APPROVED" | "REJECTED", category?: string, reason?: string): Promise<void> {
  const template = kycStatusEmail({ name: user.fullName, status, category, reason });
  try { await sendEmail({ to: user.email, name: user.fullName, ...template }); } catch { /* notification failure must not block a KYC decision */ }
}
async function notifyLogin(user: { email: string; fullName: string }, req: AuthRequest | any): Promise<void> {
  const template = loginAttemptEmail({ name: user.fullName, device: req.get("user-agent") || "Unknown device", ipAddress: req.ip || "Unknown IP", attemptedAt: new Date().toISOString() });
  try { await sendEmail({ to: user.email, name: user.fullName, ...template }); } catch { /* notification failure must not block login */ }
}

// ---------------------------------------------------------------------------
// KYC gate helpers — investing, payouts, withdrawals and loan disbursement all
// require the customer's KYC to be verified. When an action is blocked the
// customer is told exactly which action needs the verification and receives an
// email prompting them to complete their KYC.
// ---------------------------------------------------------------------------
type KycBlockedAction = "LOAN_DISBURSEMENT" | "INVESTMENT" | "INVESTOR_PAYOUT" | "WITHDRAWAL" | "EARLY_LIQUIDITY";
function userKycVerified(userId: string): boolean {
  const kycStatus = kycCases.find((item) => item.userId === userId)?.status;
  const userStatus = users.find((u) => u.id === userId)?.kycStatus;
  // The KYC case is the source of truth; the user record mirrors it. If the
  // case was never started, fall back to the user record (admin-verified or
  // legacy accounts that were verified before the case existed).
  const effective = !kycStatus || kycStatus === "NOT_STARTED" ? (userStatus ?? kycStatus ?? "NOT_STARTED") : kycStatus;
  return effective === "VERIFIED" || effective === "PARTIALLY_VERIFIED";
}
async function notifyKycBlocked(user: { id: string; email: string; fullName: string }, action: KycBlockedAction): Promise<void> {
  const template = kycActionBlockedEmail({ name: user.fullName, action });
  try { await sendEmail({ to: user.email, name: user.fullName, ...template }); } catch { /* notification failure must not block the API response */ }
  notifications.push({
    id: randomUUID(),
    userId: user.id,
    channel: "EMAIL",
    kind: "KYC_ACTION_BLOCKED",
    template: "kycActionBlocked",
    subject: template.subject,
    content: `KYC verification required before you can ${action.replace(/_/g, " ").toLowerCase()}.`,
    status: "SENT",
    relatedEntityType: "KYC",
    relatedEntityId: "kyc-case",
    retryCount: 0,
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Profile hydration — the customer already provided their profile details
// (phone, date of birth, address, occupation…) during the loan application.
// Backfill ONLY empty user fields from the most recent application snapshot
// (and verified KYC provider data) so the profile page shows what they gave us
// without ever overwriting newer information they may have edited.
// ---------------------------------------------------------------------------
function hydrateUserProfileFromApplications(userId: string): boolean {
  const user = users.find((item) => item.id === userId);
  if (!user) return false;
  const isEmpty = (value: unknown) => value == null || (typeof value === "string" && !value.trim()) || (typeof value === "object" && Object.keys(value as object).length === 0);
  const application = loanApplications
    .filter((item) => item.borrowerId === userId)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))[0];
  const snapshot = (application?.customerSnapshot ?? {}) as Record<string, unknown>;
  const personalInfo = (snapshot.personalInfo ?? {}) as Record<string, unknown>;
  const kycProvider = kycCases.find((item) => item.userId === userId)?.providerRaw as Record<string, unknown> | undefined;
  const providerBlock = ((kycProvider?.bvn ?? kycProvider?.nin) as { data?: Record<string, unknown> } | undefined)?.data ?? {};
  const pick = (...sources: Array<Record<string, unknown> | undefined>) => {
    for (const source of sources) {
      if (!source) continue;
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number") return String(value);
      }
    }
    return undefined;
  };
  let changed = false;
  if (isEmpty(user.dateOfBirth)) {
    const dob = pick({ dateOfBirth: personalInfo.dateOfBirth ?? personalInfo.dob }, { dateOfBirth: providerBlock.dateOfBirth ?? (providerBlock as Record<string, unknown>).dob });
    if (dob) { user.dateOfBirth = dob; changed = true; }
  }
  if (isEmpty(user.occupation)) {
    const occupation = pick({ occupation: personalInfo.occupation }, { occupation: personalInfo.employmentStatus });
    if (occupation) { user.occupation = occupation; changed = true; }
  }
  if (isEmpty(user.sourceOfFunds)) {
    const funds = pick({ sourceOfFunds: personalInfo.sourceOfFunds }, { sourceOfFunds: (personalInfo.monthlyIncome as string) });
    if (funds) { user.sourceOfFunds = funds; changed = true; }
  }
  if (isEmpty(user.residentialAddress)) {
    const address = (personalInfo.residentialAddress ?? personalInfo.homeAddress ?? personalInfo.address) as unknown;
    if (typeof address === "string" && address.trim()) {
      user.residentialAddress = { line1: address.trim() };
      changed = true;
    } else if (address && typeof address === "object" && Object.keys(address as object).length) {
      user.residentialAddress = address as Record<string, unknown>;
      changed = true;
    } else {
      const street = pick({ residentialAddress: (snapshot.residentialAddress as string) });
      if (street) { user.residentialAddress = { line1: street }; changed = true; }
    }
  }
  if (changed) {
    user.updatedAt = new Date().toISOString();
    schedulePersist();
  }
  return changed;
}

// ---------------------------------------------------------------------------
// KYC auto-pull on loan application submission — every KYC-relevant detail the
// customer gave in the wizard (identity numbers, documents, liveness) is pulled
// into their standalone KYC case so they never have to upload the same
// documents twice. Any remaining human-review items surface on the admin KYC
// dashboard and the customer is emailed at each lifecycle transition.
// ---------------------------------------------------------------------------
function documentTypeForSnapshotDoc(slot: string, identificationType?: string): StoreDocument["documentType"] | null {
  switch (slot) {
    case "proofOfAddress": return "PROOF_OF_ADDRESS";
    case "signature": return "SIGNATURE";
    case "identificationDocument":
      if (identificationType && /passport/i.test(identificationType)) return "PASSPORT_PHOTO";
      if (identificationType && /nin/i.test(identificationType)) return "NIN_SLIP";
      if (identificationType && /bvn/i.test(identificationType)) return "BVN_SLIP";
      return "ID_CARD_FRONT";
    default: return null;
  }
}

function pullKycFromSubmittedApplication(application: (typeof loanApplications)[number], userId: string): { createdDocuments: number; checklistUpdated: boolean } {
  const kyc = findOrCreateKycCase(userId);
  const snapshot = (application.customerSnapshot ?? {}) as Record<string, unknown>;
  const appDocuments = (snapshot.documents ?? {}) as Record<string, { name?: string; type?: string; size?: number; data?: string }>;
  const appKyc = (snapshot.kyc ?? {}) as Record<string, unknown>;
  let createdDocuments = 0;
  let checklistUpdated = false;

  // 1) Identity numbers captured in the wizard flow into the KYC case.
  for (const field of ["bvn", "nin"] as const) {
    const value = typeof appKyc[field] === "string" ? (appKyc[field] as string) : "";
    if (/^\d{11}$/.test(value) && !kyc.checklist[field]) {
      kyc[field] = value;
      kyc.checklist[field] = true;
      checklistUpdated = true;
    }
  }
  if (appKyc.bvnVerified === true && !kyc.checklist.bvn) { kyc.checklist.bvn = true; checklistUpdated = true; }
  if (appKyc.ninVerified === true && !kyc.checklist.nin) { kyc.checklist.nin = true; checklistUpdated = true; }
  if (appKyc.livenessVerified === true && !kyc.checklist.liveness) {
    kyc.checklist.liveness = true;
    kyc.livenessVerifiedAt = kyc.livenessVerifiedAt ?? new Date().toISOString();
    if (!kyc.livenessStatus) kyc.livenessStatus = "SUCCESS";
    checklistUpdated = true;
  }

  // 2) Documents uploaded in the wizard become reviewable KYC documents.
  for (const [slot, doc] of Object.entries(appDocuments)) {
    if (!doc || typeof doc !== "object") continue;
    const documentType = documentTypeForSnapshotDoc(slot, typeof appKyc.identificationType === "string" ? appKyc.identificationType : undefined);
    if (!documentType) continue;
    const reference = `snapshot:${application.id}:${slot}`;
    const duplicate = documents.some((item) => item.userId === userId && item.providerFileId === reference && item.documentType === documentType);
    if (duplicate) continue;
    documents.push({
      id: randomUUID(),
      userId,
      applicationId: application.id,
      documentSlot: slot,
      documentType,
      provider: "manual",
      providerFileId: reference,
      fileName: doc.name ?? `${slot}`,
      mimeType: doc.type ?? "application/octet-stream",
      sizeBytes: doc.size,
      status: "PENDING_REVIEW",
      version: 1,
      createdAt: new Date().toISOString(),
    });
    createdDocuments += 1;
    const checklistKey = documentType === "PROOF_OF_ADDRESS" ? "proofOfAddress" : documentType === "SIGNATURE" ? "signature" : null;
    if (checklistKey && !kyc.checklist[checklistKey]) {
      kyc.checklist[checklistKey] = true;
      checklistUpdated = true;
    }
    const category: KycCategory | null = documentType === "PROOF_OF_ADDRESS" ? "ADDRESS" : documentType === "SIGNATURE" ? "SIGNATURE" : null;
    if (category) setKycCategoryResult(kyc, category, "PENDING_REVIEW");
  }

  if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
  markKycChecklistComplete(userId);
  kyc.updatedAt = new Date().toISOString();
  return { createdDocuments, checklistUpdated };
}

// ---------------------------------------------------------------------------
// Standalone KYC prefill — expose the KYC details the customer gave during
// their most recent loan application so the Verification page can pre-fill
// identity numbers, personal details and reuse uploaded documents.
//
// UNMASKED POOLING: the identity numbers returned here are the FULL values
// resolved from the KYC case / provider raw store (resolveFullBvn /
// resolveFullNin) — never a masked display value. Masked leftovers in an
// application snapshot are ignored. The *_masked variants are derived from
// the resolved values purely for display placeholders.
// ---------------------------------------------------------------------------
function applicationKycPrefill(userId: string): Record<string, unknown> | null {
  // Unmask + self-heal: pulls the full BVN/NIN out of the raw store and
  // repairs masked KYC-case columns in place.
  backfillIdentityNumbers(userId);
  const resolvedBvn = resolveFullBvn(userId);
  const resolvedNin = resolveFullNin(userId);
  const application = loanApplications
    .filter((item) => item.borrowerId === userId)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
    .find((item) => {
      const snap = (item.customerSnapshot ?? {}) as Record<string, unknown>;
      const kyc = (snap.kyc ?? {}) as Record<string, unknown>;
      return Boolean(kyc.bvn || kyc.nin || kyc.identificationNumber);
    });
  const snapshotKyc = (() => {
    if (!application) return {} as Record<string, unknown>;
    return (((application.customerSnapshot ?? {}) as Record<string, unknown>).kyc ?? {}) as Record<string, unknown>;
  })();
  if (!application && !resolvedBvn && !resolvedNin) return null;
  const snapshot = (application?.customerSnapshot ?? {}) as Record<string, unknown>;
  const appKyc = snapshotKyc;
  const personalInfo = (snapshot.personalInfo ?? {}) as Record<string, unknown>;
  const appDocuments = (snapshot.documents ?? {}) as Record<string, { name?: string; type?: string; size?: number; data?: string }>;
  const documentSummaries: Array<Record<string, unknown>> = [];
  for (const [slot, doc] of Object.entries(appDocuments)) {
    if (!doc || typeof doc !== "object") continue;
    const documentType = documentTypeForSnapshotDoc(slot, typeof appKyc.identificationType === "string" ? appKyc.identificationType : undefined);
    if (!documentType) continue;
    documentSummaries.push({
      slot,
      documentType,
      fileName: doc.name ?? slot,
      mimeType: doc.type ?? "application/octet-stream",
      sizeBytes: doc.size ?? 0,
      available: Boolean(doc.data),
      providerFileId: `snapshot:${application?.id}:${slot}`,
    });
  }
  const maskId = (value: unknown) => (typeof value === "string" && value.length >= 6 ? `${"*".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}` : typeof value === "string" ? value : undefined);
  // Only trust a snapshot identity number when it is FULL — masked display
  // leftovers ("***-***-1234") must never leak into a prefill.
  const fullFromSnapshot = (value: unknown): string | undefined =>
    typeof value === "string" && /^\d{11}$/.test(value) ? value : undefined;
  const bvn = resolvedBvn ?? fullFromSnapshot(appKyc.bvn);
  const nin = resolvedNin ?? fullFromSnapshot(appKyc.nin);
  return {
    applicationId: application ? (application.applicationId || application.id) : undefined,
    submittedAt: application?.submittedAt ?? application?.createdAt,
    bvn,
    bvnMasked: bvn ? maskId(bvn) : undefined,
    bvnVerified: appKyc.bvnVerified === true || Boolean(resolvedBvn),
    nin,
    ninMasked: nin ? maskId(nin) : undefined,
    ninVerified: appKyc.ninVerified === true || Boolean(resolvedNin),
    livenessVerified: appKyc.livenessVerified === true,
    identificationType: typeof appKyc.identificationType === "string" ? appKyc.identificationType : undefined,
    identificationNumber: maskId(appKyc.identificationNumber),
    personalInfo: {
      firstName: personalInfo.firstName,
      middleName: personalInfo.middleName,
      lastName: personalInfo.lastName,
      fullName: personalInfo.fullName,
      dateOfBirth: personalInfo.dateOfBirth ?? personalInfo.dob,
      phone: personalInfo.phone,
      email: personalInfo.email,
      residentialAddress: personalInfo.residentialAddress ?? personalInfo.homeAddress ?? personalInfo.address,
      city: personalInfo.city,
      state: personalInfo.state,
      lga: personalInfo.lga,
      gender: personalInfo.gender,
    },
    documents: documentSummaries,
  };
}

const loanNotificationPermission = "loan_notifications" as const;
function hasUnresolvedBorrowing(userId: string, excludeApplicationId?: string): boolean {
  const openApplication = loanApplications.some((application) => application.borrowerId === userId && application.id !== excludeApplicationId && ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED"].includes(application.status));
  const openLoan = loans.some((loan) => loan.borrowerId === userId && !["REPAID", "CANCELLED", "WRITTEN_OFF"].includes(loan.status));
  return openApplication || openLoan;
}

async function sendLoanEmails(application: (typeof loanApplications)[number], event: "SUBMITTED" | "APPROVED" | "REJECTED"): Promise<void> {
  const snapshot = application.customerSnapshot ?? {};
  const borrower = users.find((user) => user.id === application.borrowerId);
  const borrowerName = borrower?.fullName ?? String(snapshot.fullName ?? "Borrower");
  const borrowerEmail = borrower?.email ?? String(snapshot.email ?? "");
  const amountNaira = Number(application.amountNaira ?? 0);
  const borrowerMessage = event === "SUBMITTED"
    ? loanApplicationSubmittedEmail({ name: borrowerName, applicationId: application.applicationId, amountNaira, recipient: "borrower" })
    : loanDecisionEmail({ name: borrowerName, applicationId: application.applicationId, status: event, amountNaira, note: application.manualNote });
  const messages = [{ email: borrowerEmail, name: borrowerName, ...borrowerMessage }];

  if (event === "SUBMITTED" || event === "APPROVED") {
    const admins = users.filter((user) => user.isActive !== false && (user.roles.includes("ADMIN") || (user.roles.includes("LOAN_MANAGER") && user.adminPermissions?.includes(loanNotificationPermission))));
    const recipients = [...admins.map((user) => ({ email: user.email, name: user.fullName })), ...(env.ADMIN_EMAIL ? [{ email: env.ADMIN_EMAIL, name: "Velo Administrator" }] : [])];
    const uniqueRecipients = recipients.filter((recipient, index, all) => all.findIndex((item) => item.email.toLowerCase() === recipient.email.toLowerCase()) === index);
    messages.push(...uniqueRecipients.map((recipient) => ({
      ...recipient,
      ...(event === "SUBMITTED"
        ? loanApplicationSubmittedEmail({ name: recipient.name, applicationId: application.applicationId, amountNaira, recipient: "reviewer" })
        : loanAwaitingDisbursementEmail({ name: recipient.name, applicationId: application.applicationId, amountNaira })),
    })));
  }

  await Promise.all(messages.filter((message) => message.email).map(async (message) => { try { await sendEmail({ to: message.email, name: message.name, subject: message.subject, html: message.html }); } catch { /* notification failure must not block loan processing */ } }));
}
const otpRequestSchema = z.object({
  action: z.enum([
    "LOGIN_STEP_UP",
    "PAYOUT_ACCOUNT_CHANGE",
    "EARLY_LIQUIDITY",
    "PASSWORD_RESET",
    "KYC_VERIFICATION",
    "WITHDRAWAL",
  ]),
  channel: z.enum(["SMS", "EMAIL"]).default("SMS"),
});
const otpVerifySchema = z.object({ challengeId: z.string().min(1), code: z.string().min(4) });
const passwordResetRequestSchema = z.object({ email: z.string().email() });
const passwordResetConfirmSchema = z.object({
  resetId: z.string().min(1),
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
const bvnVerifySchema = z.object({ bvn: z.string().regex(/^\d{11}$/, "BVN must be exactly 11 digits"), firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: z.string().optional(), otpChannel: z.enum(["SMS"]).optional() });
const ninVerifySchema = z.object({ nin: z.string().regex(/^\d{11}$/, "NIN must be exactly 11 digits"), firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: z.string().optional(), otpChannel: z.enum(["SMS"]).optional() });
const payoutAccountSchema = z.object({ accountName: z.string().min(2), accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"), bankCode: z.string().min(2), bankName: z.string().optional() });
const createInvestmentSchema = z.object({ amountNaira: z.number().positive().finite(), planId: z.string().min(1).optional(), tenureDays: z.number().int().positive().default(90), annualRatePercent: z.number().nonnegative().default(12) });
const earlyLiquiditySchema = z.object({ otpChallengeId: z.string().optional(), otpCode: z.string().optional() });
function compactApplicationPayload(input: Record<string, unknown>): Record<string, unknown> {
  const compactDocuments = Object.fromEntries(
    Object.entries((input.documents && typeof input.documents === "object" ? input.documents : {}) as Record<string, unknown>).map(([slot, value]) => {
      if (!value || typeof value !== "object") return [slot, value];
      const { data: _data, ...metadata } = value as Record<string, unknown>;
      return [slot, metadata];
    }),
  );
  const sourceKyc = input.kyc && typeof input.kyc === "object" ? input.kyc as Record<string, unknown> : {};
  const { verifiedDetails: _verifiedDetails, selfieImageData: _selfieImageData, identityPhotoUrl: _identityPhotoUrl, ...kyc } = sourceKyc;
  return {
    ...input,
    kyc,
    documents: compactDocuments,
    agreement: input.agreement && typeof input.agreement === "object"
      ? { ...(input.agreement as Record<string, unknown>), generatedHtml: null }
      : input.agreement,
  };
}

const loanApplicationSchema = z.object({
  applicationId: z.string().optional(),
  applicantType: z.enum(["PERSONAL", "BUSINESS"]).default("PERSONAL"),
  personalInfo: z.record(z.unknown()).default({}),
  businessInfo: z.record(z.unknown()).default({}),
  businessRep: z.record(z.unknown()).default({}),
  personalFinancial: z.record(z.unknown()).default({}),
  businessFinancial: z.record(z.unknown()).default({}),
  kyc: z.record(z.unknown()).default({}),
  // A loan application can NEVER be submitted without a complete disbursement
  // account — this is the account the loan is paid into. Requiring it here
  // (server-side, in addition to the frontend gate) prevents applications that
  // would later fail admin disbursement with "No disbursement account found".
  disbursementAccount: z.object({
    accountName: z.string({ required_error: "Disbursement account name is required" }).trim().min(2, "Disbursement account name is required"),
    accountNumber: z.string({ required_error: "Disbursement account number is required" }).trim().regex(/^\d{10}$/, "Disbursement account number must be exactly 10 digits"),
    bankCode: z.string({ required_error: "Disbursement bank code is required" }).trim().min(2, "Select a valid disbursement bank"),
    bankName: z.string().trim().optional(),
  }),
  loanRequest: z
    .object({ amount: z.number().positive(), tenure: z.number().int().positive(), purpose: z.string().min(1) })
    .optional(),
  collateral: z.record(z.unknown()).default({}),
  documents: z.record(z.unknown()).default({}),
  witness: z.record(z.unknown()).default({}),
  calculation: z.record(z.unknown()).nullable().default(null),
});
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DOCUMENT_MAX_SIZE_BYTES },
  fileFilter: (_req, file, callback) =>
    callback(null, env.DOCUMENT_ALLOWED_MIME_TYPES.split(",").includes(file.mimetype)),
});
const livenessUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)) });

router.post("/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  if (!sql) {
    res.status(503).json({ ok: false, error: "PostgreSQL is not configured. Account registration is unavailable." });
    return;
  }
  const dbExists = await dbEmailExists(input.email);
  const memExists = Boolean(findUserByEmail(input.email));
  if (dbExists !== null && dbExists !== memExists) {
    console.warn(
      `[store_reconciliation_warning] Email uniqueness diverged for ${input.email}: DB=${dbExists} in-memory=${memExists}. Trusting DB truth.`
    );
    auditLogs.push({
      id: randomUUID(),
      userId: null as unknown as undefined,
      action: "store_reconciliation_warning",
      resourceType: "USER",
      resourceId: null as unknown as undefined,
      metadata: { email: input.email, dbExists, memExists, reason: "email_uniqueness_registration_gate" },
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
      createdAt: new Date().toISOString(),
    });
  }
  const emailTaken = dbExists !== null ? dbExists : memExists;
  if (emailTaken) {
    res.status(409).json({ ok: false, error: "An account with this email already exists" });
    return;
  }
  const now = new Date().toISOString();
  const userRoles: Role[] = ["INVESTOR", "BORROWER"];
  const normalizedEmail = input.email.toLowerCase();
  const rawDuplicate = users.some((u) => u.email.toLowerCase() === normalizedEmail);
  if (rawDuplicate) {
    res.status(409).json({ ok: false, error: "An account with this email already exists" });
    return;
  }
  const user = {
    id: randomUUID(),
    email: normalizedEmail,
    phone: input.phone,
    fullName: input.fullName,
    passwordHash: await bcrypt.hash(input.password, 12),
    roles: userRoles,
    kycStatus: "NOT_STARTED" as KycStatus,
    createdAt: now,
    updatedAt: now,
    isActive: false,
    preferredOtpChannel: input.preferredOtpChannel,
    otpLoginEnabled: false,
    dateOfBirth: input.dateOfBirth,
    residentialAddress: input.residentialAddress as Record<string, unknown> | undefined,
    occupation: input.occupation,
    sourceOfFunds: input.sourceOfFunds,
  };
  users.push(user);
  indexes.usersByEmail.set(normalizedEmail, user);
  createWallet(user.id);
  findOrCreateKycCase(user.id);
  if (input.consents.terms) recordConsent(user.id, "TERMS");
  if (input.consents.privacy) recordConsent(user.id, "PRIVACY");
  if (input.consents.identityVerification) recordConsent(user.id, "IDENTITY_VERIFICATION");
  if (input.consents.electronicCommunications) recordConsent(user.id, "ELECTRONIC_COMMUNICATIONS");
  const challenge = await createOtpChallenge(
    user.id,
    "SIGNUP_VERIFY",
    user.phone,
    user.email,
    user.preferredOtpChannel
  );
  if (!(await persistMutation(res))) return;
  const safeUser = {
    id: user.id,
    email: user.email,
    phone: user.phone,
    fullName: user.fullName,
    roles: user.roles,
    kycStatus: user.kycStatus,
    createdAt: user.createdAt,
    dateOfBirth: user.dateOfBirth,
    occupation: user.occupation,
  };
  res.status(201).json({
    ok: true,
    user: safeUser,
    verification: {
      userId: user.id,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: user.preferredOtpChannel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
    },
    message: "Enter the OTP sent through your preferred channel to activate your account.",
  });
});

router.post("/auth/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Email and password are required" });
    return;
  }
  const user = findUserByEmail(parsed.data.email);
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    res.status(401).json({ ok: false, error: "Invalid email or password" });
    return;
  }
  if (user.isActive === false) {
    res.status(403).json({
      ok: false,
      error: "Verify your OTP before signing in",
      code: "OTP_REQUIRED",
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      channels: ["SMS", "EMAIL"] as const,
    });
    return;
  }
  // Maintenance mode: customers are locked out with a friendly modal; admins
  // can still sign in to operate the console and toggle maintenance back off.
  const maintenanceSettings = getPlatformSettings();
  if (maintenanceSettings.maintenanceMode === true && !user.roles.includes("ADMIN")) {
    res.status(503).json({
      ok: false,
      code: "MAINTENANCE_MODE",
      error: maintenanceSettings.maintenanceMessage?.trim()
        ? maintenanceSettings.maintenanceMessage.trim()
        : "Velo is currently undergoing scheduled maintenance. We'll email you as soon as the system is back up — thank you for your patience.",
    });
    return;
  }
  if (user.otpLoginEnabled) {
    const channel = user.preferredOtpChannel ?? "EMAIL";
    const phone = loginOtpPhone(user.phone);
    if (channel === "SMS" && !phone) {
      res.status(400).json({ ok: false, error: "A valid Nigerian phone number is required for SMS two-step login" });
      return;
    }
    try {
      const challenge = await createOtpChallenge(user.id, "LOGIN_STEP_UP", phone, user.email, channel);
      res.json({ ok: true, requiresOtp: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, channel: challenge.channel, resendAvailableAt: challenge.resendAvailableAt, resendSecondsRemaining: challenge.resendSecondsRemaining, user: { id: user.id, email: user.email, fullName: user.fullName, roles: user.roles } });
      return;
    } catch (error) {
      if (error instanceof OtpRateLimitError) {
        res.status(429).json({ ok: false, error: error.message, resendAvailableAt: error.resendAvailableAt, resendSecondsRemaining: error.resendSecondsRemaining });
        return;
      }
      throw error;
    }
  }
  user.lastLoginAt = new Date().toISOString();
  await notifyLogin(user, req);
  res.json({
    ok: true,
    accessToken: issueToken(user),
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      kycStatus: user.kycStatus,
    },
  });
});

router.post("/auth/login/resend-otp", async (req, res) => {
  const parsed = z.object({ userId: z.string().uuid(), challengeId: z.string().uuid().optional(), channel: z.enum(["SMS", "EMAIL"]).optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((item) => item.id === parsed.data.userId && item.isActive !== false && item.otpLoginEnabled);
  if (!user) { res.status(404).json({ ok: false, error: "Login verification is not available" }); return; }
  const channel = parsed.data.channel ?? user.preferredOtpChannel ?? "EMAIL";
  const phone = loginOtpPhone(user.phone);
  if (channel === "SMS" && !phone) {
    res.status(400).json({ ok: false, error: "A valid Nigerian phone number is required for SMS two-step login" });
    return;
  }
  try {
    const challenge = await createOtpChallenge(user.id, "LOGIN_STEP_UP", phone, user.email, channel);
    res.status(201).json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, channel: challenge.channel, resendAvailableAt: challenge.resendAvailableAt, resendSecondsRemaining: challenge.resendSecondsRemaining });
  } catch (error) {
    if (error instanceof OtpRateLimitError) { res.status(429).json({ ok: false, error: error.message, resendAvailableAt: error.resendAvailableAt, resendSecondsRemaining: error.resendSecondsRemaining }); return; }
    throw error;
  }
});

router.post("/auth/login/verify-otp", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok || result.action !== "LOGIN_STEP_UP" || !result.userId) { res.status(400).json({ ok: false, error: result.error ?? "Invalid or expired OTP" }); return; }
  const user = users.find((item) => item.id === result.userId && item.isActive !== false && item.otpLoginEnabled);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  // Maintenance mode also blocks the OTP second step for non-admin users.
  const maintenanceSettings = getPlatformSettings();
  if (maintenanceSettings.maintenanceMode === true && !user.roles.includes("ADMIN")) {
    res.status(503).json({
      ok: false,
      code: "MAINTENANCE_MODE",
      error: maintenanceSettings.maintenanceMessage?.trim()
        ? maintenanceSettings.maintenanceMessage.trim()
        : "Velo is currently undergoing scheduled maintenance. We'll email you as soon as the system is back up — thank you for your patience.",
    });
    return;
  }
  user.lastLoginAt = new Date().toISOString();
  await notifyLogin(user, req);
  res.json({ ok: true, accessToken: issueToken(user), user: { id: user.id, email: user.email, fullName: user.fullName, phone: user.phone, roles: user.roles, kycStatus: user.kycStatus, createdAt: user.createdAt } });
});

// ---------------------------------------------------------------------------
// Public platform status — consumed by the landing page, AccountAccess and the
// customer dashboards to render the maintenance modal, announcement slider and
// banner carousel without exposing any settings internals.
// ---------------------------------------------------------------------------
router.get("/platform/status", (_req, res) => {
  const settings = getPlatformSettings();
  res.json({
    ok: true,
    maintenanceMode: settings.maintenanceMode === true,
    maintenanceMessage: settings.maintenanceMessage ?? "",
    announcements: (settings.announcements ?? []).filter((item) => item.isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });
});

router.get("/platform/banners", (_req, res) => {
  const settings = getPlatformSettings();
  res.json({
    ok: true,
    banners: (settings.banners ?? []).filter((item) => item.isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  });
});

router.post("/auth/admin/login", async (req, res) => {
  const parsed = loginSchema.extend({ channel: adminOtpChannelSchema.default("EMAIL") }).safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ ok: false, error: "Invalid admin credentials" });
    return;
  }
  const persistedAdmin = findUserByEmail(parsed.data.email);
  const isEnvironmentAdmin = Boolean(env.ADMIN_EMAIL && parsed.data.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase());
  const configuredAdminPasswordHash = env.ADMIN_PASSWORD_HASH;
  const isBackOfficeUser = Boolean(persistedAdmin?.roles.some((role) => ["ADMIN", "LOAN_MANAGER"].includes(role)));
  const passwordMatches = isBackOfficeUser && persistedAdmin
    ? await bcrypt.compare(parsed.data.password, persistedAdmin.passwordHash)
    : isEnvironmentAdmin && Boolean(env.ADMIN_PASSWORD || configuredAdminPasswordHash) && (configuredAdminPasswordHash ? await bcrypt.compare(parsed.data.password, configuredAdminPasswordHash) : parsed.data.password === env.ADMIN_PASSWORD);
  if ((!isEnvironmentAdmin && !isBackOfficeUser) || !passwordMatches) {
    res.status(401).json({ ok: false, error: "Invalid admin credentials" });
    return;
  }
  if (isEnvironmentAdmin && !persistedAdmin) {
    const now = new Date().toISOString();
    users.push({
      id: "env-admin",
      email: env.ADMIN_EMAIL!.toLowerCase(),
      phone: "",
      fullName: "Velo Administrator",
      passwordHash: configuredAdminPasswordHash || await bcrypt.hash(env.ADMIN_PASSWORD!, 12),
      roles: ["ADMIN"],
      kycStatus: "VERIFIED",
      createdAt: now,
      updatedAt: now,
      isActive: true,
      otpLoginEnabled: false,
    });
  }
  const databaseAdmin = persistedAdmin ?? findUserByEmail(parsed.data.email)!;
  const admin = {
    id: databaseAdmin.id,
    email: databaseAdmin.email,
    phone: databaseAdmin.phone,
    fullName: databaseAdmin.fullName,
    passwordHash: databaseAdmin.passwordHash,
    roles: databaseAdmin.roles,
    adminPermissions: databaseAdmin.roles.includes("ADMIN") ? [...ADMIN_PERMISSIONS] : databaseAdmin.adminPermissions,
    kycStatus: databaseAdmin.kycStatus,
    createdAt: databaseAdmin.createdAt,
  };
  try {
    const challenge = await createOtpChallenge(admin.id, "LOGIN_STEP_UP", "", admin.email, parsed.data.channel);
    auditLogs.push({ id: randomUUID(), userId: admin.id, action: "ADMIN_LOGIN_INITIATED", resourceType: "AUTH", resourceId: admin.email, metadata: { channel: parsed.data.channel }, ipAddress: req.ip, userAgent: req.get("user-agent") ?? undefined, createdAt: new Date().toISOString() });
    res.json({
      ok: true,
      requiresOtp: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: parsed.data.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
      user: { id: admin.id, email: admin.email, fullName: admin.fullName, roles: admin.roles, adminPermissions: admin.adminPermissions },
    });
  } catch (error) {
    if (error instanceof OtpRateLimitError) {
      res.status(429).json({ ok: false, error: error.message, resendAvailableAt: error.resendAvailableAt, resendSecondsRemaining: error.resendSecondsRemaining });
      return;
    }
    throw error;
  }
});

router.post("/auth/admin/login/resend-otp", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().uuid(), email: z.string().email(), channel: adminOtpChannelSchema }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "A valid admin OTP challenge and channel are required" });
    return;
  }
  const admin = findUserByEmail(parsed.data.email);
  const adminId = admin?.roles.some((role) => ["ADMIN", "LOAN_MANAGER"].includes(role)) ? admin.id : "env-admin";
  try {
    const challenge = await createOtpChallenge(adminId, "LOGIN_STEP_UP", admin?.phone ?? "", admin?.email ?? env.ADMIN_EMAIL, parsed.data.channel);
    res.status(201).json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, channel: parsed.data.channel, resendAvailableAt: challenge.resendAvailableAt, resendSecondsRemaining: challenge.resendSecondsRemaining });
  } catch (error) {
    if (error instanceof OtpRateLimitError) {
      res.status(429).json({ ok: false, error: error.message, resendAvailableAt: error.resendAvailableAt, resendSecondsRemaining: error.resendSecondsRemaining });
      return;
    }
    throw error;
  }
});

router.post("/auth/admin/login/verify-otp", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok || result.action !== "LOGIN_STEP_UP") {
    res.status(400).json({ ok: false, error: result.error ?? "Admin OTP verification failed" });
    return;
  }
  const persistedAdmin = users.find((user) => user.id === result.userId && user.roles.some((role) => ["ADMIN", "LOAN_MANAGER"].includes(role)));
  const configuredAdminPasswordHash = env.ADMIN_PASSWORD_HASH;
  const admin = persistedAdmin ?? { id: "env-admin", email: env.ADMIN_EMAIL!, phone: "", fullName: "Velo Administrator", passwordHash: configuredAdminPasswordHash ?? "", roles: ["ADMIN"] as Role[], adminPermissions: [...ADMIN_PERMISSIONS], kycStatus: "VERIFIED" as KycStatus, createdAt: new Date().toISOString() };
  auditLogs.push({ id: randomUUID(), userId: admin.id, action: "ADMIN_LOGIN_VERIFIED", resourceType: "AUTH", resourceId: admin.email, ipAddress: req.ip, userAgent: req.get("user-agent") ?? undefined, createdAt: new Date().toISOString() });
  const adminPermissions = admin.roles.includes("ADMIN") ? [...ADMIN_PERMISSIONS] : admin.adminPermissions;
  res.json({ ok: true, verified: true, accessToken: issueToken({ ...admin, adminPermissions }), user: { id: admin.id, email: admin.email, fullName: admin.fullName, roles: admin.roles, adminPermissions } });
});

router.post("/auth/admin/logout", requireAuth, (req: AuthRequest, res) => {
  auditLogs.push({ id: randomUUID(), userId: req.user?.id, action: "ADMIN_LOGOUT", resourceType: "AUTH", resourceId: req.user?.email, ipAddress: req.ip, userAgent: req.get("user-agent") ?? undefined, createdAt: new Date().toISOString() });
  res.json({ ok: true });
});

router.post("/auth/refresh", requireAuth, (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  res.json({ ok: true, accessToken: issueToken(user) });
});

router.post("/auth/logout", (_req, res) => {
  res.json({ ok: true, message: "Logged out. Client should discard the token." });
});

router.post("/auth/otp/request", requireAuth, async (req: AuthRequest, res) => {
  const parsed = otpRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const phone = loginOtpPhone(user.phone);
  if (parsed.data.channel === "SMS" && !phone) {
    res.status(400).json({ ok: false, error: "A valid Nigerian phone number is required for SMS verification" });
    return;
  }
  try {
    const challenge = await createOtpChallenge(
      user.id,
      parsed.data.action,
      phone,
      user.email,
      parsed.data.channel,
      { skipRateLimit: user.roles.includes("ADMIN") || user.roles.includes("LOAN_MANAGER") }
    );
    res.status(201).json({
      ok: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: parsed.data.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
    });
  } catch (error) {
    if (error instanceof OtpRateLimitError) {
      res.status(429).json({
        ok: false,
        error: error.message,
        resendAvailableAt: error.resendAvailableAt,
        resendSecondsRemaining: error.resendSecondsRemaining,
      });
      return;
    }
    throw error;
  }
});

router.post("/auth/register/resend-otp", async (req, res) => {
  const parsed = z.object({ userId: z.string().uuid(), channel: z.enum(["SMS", "EMAIL"]).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const user = users.find((item) => item.id === parsed.data.userId);
  if (!user || user.otpVerifiedAt) {
    res.status(404).json({ ok: false, error: "Registration not found or already verified" });
    return;
  }
  const chosenChannel = parsed.data.channel ?? user.preferredOtpChannel ?? "EMAIL";
  try {
    const challenge = await createOtpChallenge(user.id, "SIGNUP_VERIFY", user.phone, user.email, chosenChannel);
    res.status(201).json({
      ok: true,
      userId: user.id,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: chosenChannel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
    });
  } catch (error) {
    if (error instanceof OtpRateLimitError) {
      res.status(429).json({
        ok: false,
        error: error.message,
        resendAvailableAt: error.resendAvailableAt,
        resendSecondsRemaining: error.resendSecondsRemaining,
      });
      return;
    }
    throw error;
  }
});

router.post("/auth/register/verify-otp", async (req, res) => {
  const parsed = z.object({ userId: z.string().uuid(), challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok || result.action !== "SIGNUP_VERIFY" || result.userId !== parsed.data.userId) {
    res.status(400).json({ ok: false, error: result.error ?? "Registration OTP verification failed" });
    return;
  }
  const user = users.find((item) => item.id === parsed.data.userId);
  if (!user) {
    res.status(404).json({ ok: false, error: "Registration not found" });
    return;
  }
  user.isActive = true;
  user.otpVerifiedAt = new Date().toISOString();
  user.lastLoginAt = user.otpVerifiedAt;
  const welcome = welcomeEmail({ name: user.fullName });
  try { await sendEmail({ to: user.email, name: user.fullName, ...welcome }); } catch { /* account activation is independent of email delivery */ }
  res.json({
    ok: true,
    verified: true,
    accessToken: issueToken(user),
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone,
      roles: user.roles,
      kycStatus: user.kycStatus,
      createdAt: user.createdAt,
    },
  });
});

router.post("/auth/otp/verify", async (req, res) => {
  const parsed = otpVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error ?? "OTP verification failed" });
    return;
  }
  res.json({ ok: true, action: result.action, verified: true });
});

router.post("/auth/password-reset/request", async (req, res) => {
  const parsed = passwordResetRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "Valid email is required" });
    return;
  }
  const result = await requestPasswordReset(parsed.data.email);
  if (!(await persistMutation(res))) return;
  res.json(result);
});

router.post("/auth/password-reset/confirm", async (req, res) => {
  const parsed = passwordResetConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await confirmPasswordReset(parsed.data.resetId, parsed.data.token, parsed.data.newPassword);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error ?? "Password reset failed" });
    return;
  }
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, message: "Password reset successful" });
});

router.post("/auth/admin/password-reset/request", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), channel: adminOtpChannelSchema.default("EMAIL") }).safeParse(req.body);
  if (!parsed.success || !env.ADMIN_EMAIL || parsed.data.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    res.json({ ok: true, message: "If this email is the administrator email, a reset OTP has been sent." });
    return;
  }
  let admin = findUserByEmail(parsed.data.email);
  if (!admin) {
    const now = new Date().toISOString();
    // Cache the bcrypt hash so repeated reset requests don't re-hash the env
    // password on every call (avoids CPU DoS via repeated hits to this endpoint).
    // The hash is computed once and stored on the env-admin user record.
    const cachedHash = env.ADMIN_PASSWORD_HASH ?? await bcrypt.hash(env.ADMIN_PASSWORD!, 12);
    admin = {
      id: "env-admin",
      email: env.ADMIN_EMAIL.toLowerCase(),
      phone: "",
      fullName: "Velo Administrator",
      passwordHash: cachedHash,
      roles: ["ADMIN"],
      kycStatus: "VERIFIED",
      createdAt: now,
      updatedAt: now,
      isActive: true,
      otpLoginEnabled: false,
    };
    users.push(admin);
  }
  // Rate-limit OTP creation per admin user: max 1 reset OTP per minute.
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const recentChallenge = otpChallenges.find(
    (c) => c.userId === admin!.id && c.action === "PASSWORD_RESET" && c.createdAt >= oneMinuteAgo && !c.consumedAt,
  );
  if (recentChallenge) {
    const resendAvailableAt = new Date(new Date(recentChallenge.createdAt).getTime() + 60_000).toISOString();
    const resendSecondsRemaining = Math.max(0, Math.ceil((new Date(resendAvailableAt).getTime() - Date.now()) / 1000));
    res.status(429).json({
      ok: false,
      error: "Please wait before requesting another reset OTP.",
      resendAvailableAt,
      resendSecondsRemaining,
    });
    return;
  }
  const challenge = await createOtpChallenge(admin.id, "PASSWORD_RESET", "", admin.email, parsed.data.channel);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, channel: challenge.channel, resendAvailableAt: challenge.resendAvailableAt, resendSecondsRemaining: challenge.resendSecondsRemaining, message: "Enter the OTP sent to the selected channel." });
});

router.post("/auth/admin/password-reset/confirm", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(12) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok || result.action !== "PASSWORD_RESET" || !result.userId) {
    res.status(400).json({ ok: false, error: result.error ?? "Admin password reset verification failed" });
    return;
  }
  const admin = users.find((user) => user.id === result.userId && user.roles.includes("ADMIN"));
  if (!admin) {
    res.status(404).json({ ok: false, error: "Administrator not found" });
    return;
  }
  admin.passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  admin.updatedAt = new Date().toISOString();
  if (!(await persistMutation(res))) return;
  if (sql) {
    await sql.query("UPDATE admin_profiles SET password_hash = $1, created_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE user_id = $2", [admin.passwordHash, admin.id]);
    await sql.query("INSERT INTO env (key, value, updated_at) VALUES ('admin_password_hash', $1::jsonb, CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at", [JSON.stringify(admin.passwordHash)]);
  }
  res.json({ ok: true, message: "Admin password reset successful" });
});

router.get("/me", requireAuth, (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  // Profile autofill: the customer's phone, date of birth, address, occupation
  // etc. were already provided during their loan application — backfill any
  // empty profile fields so the profile page shows the details they gave us.
  hydrateUserProfileFromApplications(user.id);
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      kycStatus: user.kycStatus,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth,
      occupation: user.occupation,
      sourceOfFunds: user.sourceOfFunds,
      residentialAddress: user.residentialAddress,
      createdAt: user.createdAt,
    },
  });
});

router.get("/user/settings", requireAuth, (req: AuthRequest, res) => {
  const user = users.find((item) => item.id === req.user?.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  res.json({ ok: true, preferredOtpChannel: user.preferredOtpChannel ?? "EMAIL", otpLoginEnabled: user.otpLoginEnabled === true });
});

router.put("/user/settings", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ preferredOtpChannel: z.enum(["SMS", "EMAIL"]).optional(), otpLoginEnabled: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((item) => item.id === req.user?.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  const preferredOtpChannel = parsed.data.preferredOtpChannel ?? user.preferredOtpChannel ?? "EMAIL";
  const otpLoginEnabled = parsed.data.otpLoginEnabled ?? (user.otpLoginEnabled === true);
  if (otpLoginEnabled && preferredOtpChannel === "SMS" && !loginOtpPhone(user.phone)) {
    res.status(400).json({ ok: false, error: "Add a valid Nigerian phone number before enabling SMS two-step login" });
    return;
  }
  if (parsed.data.preferredOtpChannel !== undefined) user.preferredOtpChannel = parsed.data.preferredOtpChannel;
  if (parsed.data.otpLoginEnabled !== undefined) user.otpLoginEnabled = parsed.data.otpLoginEnabled;
  user.updatedAt = new Date().toISOString();
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, preferredOtpChannel: user.preferredOtpChannel ?? "EMAIL", otpLoginEnabled: user.otpLoginEnabled === true });
});

router.patch("/me", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const raw = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
  if (typeof raw.email === "string") {
    res.status(400).json({ ok: false, error: "Email cannot be edited directly. Start a profile update OTP flow via /me/profile-update/initiate." });
    return;
  }
  if (typeof raw.phone === "string") {
    res.status(400).json({ ok: false, error: "Phone cannot be edited directly. Start a profile update OTP flow via /me/profile-update/initiate." });
    return;
  }
  const schema = z.object({
    fullName: z.string().min(2).max(120).optional(),
    dateOfBirth: z.string().optional(),
    residentialAddress: z.record(z.unknown()).optional(),
    occupation: z.string().optional(),
    sourceOfFunds: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.fullName) user.fullName = parsed.data.fullName;
  if (parsed.data.dateOfBirth) user.dateOfBirth = parsed.data.dateOfBirth;
  if (parsed.data.residentialAddress) user.residentialAddress = parsed.data.residentialAddress;
  if (parsed.data.occupation) user.occupation = parsed.data.occupation;
  if (parsed.data.sourceOfFunds) user.sourceOfFunds = parsed.data.sourceOfFunds;
  user.updatedAt = new Date().toISOString();
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, user });
});

const profileUpdateInitiateSchema = z.object({
  phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/, "Enter a valid Nigerian phone number")).optional(),
  email: z.string().email("Valid email address is required").optional(),
  channel: z.enum(["SMS", "EMAIL"]).default("SMS"),
});

router.post("/me/profile-update/initiate", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const parsed = profileUpdateInitiateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const newPhone = parsed.data.phone;
  const newEmail = parsed.data.email;
  if (!newPhone && !newEmail) {
    res.status(400).json({ ok: false, error: "Provide a new phone number or email to update." });
    return;
  }
  if (newPhone && newPhone === user.phone && (!newEmail || newEmail.toLowerCase() === user.email.toLowerCase())) {
    res.status(400).json({ ok: false, error: "New phone number is the same as your current phone number." });
    return;
  }
  if (newEmail && newEmail.toLowerCase() === user.email.toLowerCase() && (!newPhone || newPhone === user.phone)) {
    res.status(400).json({ ok: false, error: "New email is the same as your current email." });
    return;
  }
  if (newEmail && findUserByEmail(newEmail)) {
    res.status(409).json({ ok: false, error: "An account with this email already exists." });
    return;
  }
  if (newPhone && users.some((u) => u.id !== user.id && u.phone === newPhone)) {
    res.status(409).json({ ok: false, error: "An account with this phone number already exists." });
    return;
  }
  const channel = (() => {
    if (newEmail && !newPhone) return "EMAIL";
    if (parsed.data.channel === "EMAIL" && !newEmail) {
      return (user.preferredOtpChannel && user.preferredOtpChannel !== "EMAIL" ? user.preferredOtpChannel : "SMS") as "SMS";
    }
    return parsed.data.channel;
  })();
  const sendTargetPhone = newPhone ?? user.phone ?? "";
  const sendTargetEmail = newEmail ?? user.email ?? "";
  try {
    const challenge = await createOtpChallenge(user.id, "PROFILE_UPDATE", sendTargetPhone, sendTargetEmail, channel);
    res.json({
      ok: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: challenge.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
      phoneLastFour: newPhone ? newPhone.slice(-4) : undefined,
      emailMasked: newEmail ? newEmail.replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => `${a}${"*".repeat(Math.max(3, b.length))}${c}`) : undefined,
      pendingPhone: newPhone,
      pendingEmail: newEmail,
    });
  } catch (err) {
    res.status(429).json({ ok: false, error: err instanceof Error ? err.message : "Unable to send OTP right now." });
  }
});

const profileUpdateResendSchema = z.object({ challengeId: z.string().min(1), channel: z.enum(["SMS","EMAIL"]).optional() });

router.post("/me/profile-update/resend-otp", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const parsed = profileUpdateResendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const found = findOtpChallenge(parsed.data.challengeId);
  if (!found || found.userId !== req.user?.id || found.action !== "PROFILE_UPDATE") {
    res.status(404).json({ ok: false, error: "Challenge not found. Start a new profile update request." });
    return;
  }
  try {
    const channel = (parsed.data.channel ?? found.deliveryChannel) as "SMS"|"EMAIL";
    const challenge = await createOtpChallenge(found.userId, "PROFILE_UPDATE", found.phone ?? user.phone, found.email ?? user.email, channel);
    res.json({
      ok: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: challenge.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
    });
  } catch (err) {
    res.status(429).json({ ok: false, error: err instanceof Error ? err.message : "Unable to resend OTP right now." });
  }
});

const profileUpdateConfirmSchema = z.object({ challengeId: z.string().min(1), code: z.string().regex(/^\d{6}$/, "6-digit OTP code is required"), phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/).optional()), email: z.string().email().optional() });

router.post("/me/profile-update/confirm", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const parsed = profileUpdateConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const found = findOtpChallenge(parsed.data.challengeId);
  if (!found || found.userId !== req.user?.id || found.action !== "PROFILE_UPDATE") {
    res.status(404).json({ ok: false, error: "Challenge not found. Start a new profile update request." });
    return;
  }
  if (parsed.data.phone && found.phone && parsed.data.phone !== found.phone) {
    res.status(400).json({ ok: false, error: "Phone number in this request does not match the profile update challenge." });
    return;
  }
  if (parsed.data.email && found.email && parsed.data.email.toLowerCase() !== found.email.toLowerCase()) {
    res.status(400).json({ ok: false, error: "Email in this request does not match the profile update challenge." });
    return;
  }
  const expectedPhone = parsed.data.phone ?? found.phone;
  const expectedEmail = parsed.data.email ?? found.email;
  if (!expectedPhone && !expectedEmail) {
    res.status(400).json({ ok: false, error: "No pending phone or email to update for this challenge." });
    return;
  }
  if (expectedEmail && findUserByEmail(expectedEmail)) {
    res.status(409).json({ ok: false, error: "An account with this email already exists." });
    return;
  }
  if (expectedPhone && users.some((u) => u.id !== user.id && u.phone === expectedPhone)) {
    res.status(409).json({ ok: false, error: "An account with this phone number already exists." });
    return;
  }
  const verified = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!verified.ok) {
    res.status(400).json({ ok: false, error: verified.error ?? "Invalid or expired OTP. Try resending." });
    return;
  }
  const before = { phone: user.phone, email: user.email };
  const changes: { phone?: string; email?: string } = {};
  if (expectedPhone && expectedPhone !== user.phone) {
    user.phone = expectedPhone;
    changes.phone = expectedPhone;
  }
  if (expectedEmail && expectedEmail.toLowerCase() !== user.email.toLowerCase()) {
    user.email = expectedEmail.toLowerCase();
    changes.email = user.email;
  }
  const now = new Date().toISOString();
  user.updatedAt = now;
  res.json({
    ok: true,
    message: "Profile updated successfully.",
    changes,
    previous: before,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      kycStatus: user.kycStatus,
      phone: user.phone,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
  });
});

router.post("/me/roles/add", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const schema = z.object({
    role: z.enum(["INVESTOR", "BORROWER"]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const roleToAdd = parsed.data.role;
  if (!user.roles.includes(roleToAdd)) {
    user.roles = [...user.roles, roleToAdd];
  }
  if (roleToAdd === "INVESTOR") {
    createWallet(user.id);
  }
  user.updatedAt = new Date().toISOString();
  if (!(await persistMutation(res))) return;
  res.json({
    ok: true,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      kycStatus: user.kycStatus,
    },
    message: roleToAdd === "INVESTOR"
      ? "Investor access enabled. Wallet created if it didn't exist."
      : "Borrower access enabled.",
  });
});

router.get("/me/kyc", requireAuth, (req: AuthRequest, res) => {
  // AUTO-FETCH: pull identity numbers + documents from the customer's most
  // recent loan application into the KYC case on every page load. The pull is
  // idempotent (already-copied items are skipped), so this keeps the
  // Verification page in sync with the application without asking the
  // customer to click "reuse" first.
  const kycBefore = findOrCreateKycCase(req.user!.id);
  const requiredChecksAll = ["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const;
  if (requiredChecksAll.some((key) => !kycBefore.checklist[key])) {
    const sourceApplication = loanApplications
      .filter((item) => item.borrowerId === req.user!.id)
      .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
      .find((item) => {
        const snap = (item.customerSnapshot ?? {}) as Record<string, unknown>;
        const appKyc = (snap.kyc ?? {}) as Record<string, unknown>;
        const docs = (snap.documents ?? {}) as Record<string, unknown>;
        return Boolean(appKyc.bvn || appKyc.nin || appKyc.identificationNumber || docs.proofOfAddress || docs.signature || docs.identificationDocument);
      });
    if (sourceApplication) pullKycFromSubmittedApplication(sourceApplication, req.user!.id);
  }
  const kyc = findOrCreateKycCase(req.user!.id);
  const requiredChecks = ["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const;
  const userDocs = documents.filter((d) => d.userId === req.user?.id);
  const missingRequired = requiredChecks.filter((key) => !kyc.checklist[key]);
  // Status downgrade guard: a submitted (PENDING_VERIFICATION) case with any
  // uploaded/pulled document stays submitted for admin review even when some
  // checklist items are incomplete. Only an empty case (nothing to review)
  // or a verified case broken by an admin category reset falls back.
  const shouldDowngrade =
    missingRequired.length > 0 &&
    (kyc.status === "VERIFIED" || (kyc.status === "PENDING_VERIFICATION" && userDocs.length === 0));
  if (shouldDowngrade && ["PENDING_VERIFICATION", "VERIFIED"].includes(kyc.status)) {
    kyc.status = "IN_PROGRESS";
    kyc.submittedAt = undefined;
    kyc.updatedAt = new Date().toISOString();
    const user = users.find((item) => item.id === req.user!.id);
    if (user) user.kycStatus = kyc.status;
  }
  let identityPhoto: string | undefined;
  const normalizedFields: Record<string, unknown> = {};
  if (kyc.providerRaw && typeof kyc.providerRaw === "object") {
    const raw = kyc.providerRaw as Record<string, unknown>;
    for (const idKey of ["bvn", "nin"]) {
      const block = (raw as any)[idKey];
      if (!block || typeof block !== "object") continue;
      const data = block.data ?? block;
      if (!data || typeof data !== "object") continue;
      const aliases: Record<string, Array<string>> = {
        fullName: ["fullName", "firstName middleName lastName", "firstName", "lastName"],
        firstName: ["firstName", "first_name"],
        middleName: ["middleName", "middle_name"],
        lastName: ["lastName", "surname", "last_name"],
        dateOfBirth: ["dateOfBirth", "dob", "birthDate", "date_of_birth"],
        phone: ["phoneNumber", "phone_number", "phone", "mobile", "telephone", "telephoneno"],
        residentialAddress: ["residentialAddress", "residence_address", "address", "residence", "contact_address", "house_address"],
        state: ["state", "stateOfOrigin", "state_of_origin", "residenceState"],
        lga: ["lga", "localGovernment", "local_government", "localGovernmentArea", "lg"],
        email: ["email", "emailAddress", "email_address"],
        gender: ["gender", "sex"],
        photo: ["photo", "photograph", "image", "face_image", "selfie", "identityPhoto"],
      };
      const merged: Record<string, unknown> = {};
      for (const [outKey, candidateKeys] of Object.entries(aliases)) {
        for (const ck of candidateKeys) {
          const v = (data as any)[ck];
          if (v != null && !(typeof v === "string" && !v.trim())) {
            if (outKey === "fullName" && candidateKeys[0] === "fullName" && (ck === "firstName" || ck === "lastName" || ck === "middleName")) {
              continue;
            }
            merged[outKey] = String(v);
            break;
          }
        }
      }
      if (!merged.fullName) {
        const parts = [merged.firstName, merged.middleName, merged.lastName].filter((x) => typeof x === "string" && x.trim());
        if (parts.length) merged.fullName = parts.join(" ");
      }
      Object.assign(normalizedFields, { [idKey]: merged });
      if (!identityPhoto) {
        for (const key of ["photo", "photograph", "image", "face_image", "selfie", "identityPhoto"]) {
          const val = (data as any)[key];
          if (typeof val === "string" && val.length > 50) { identityPhoto = val; break; }
        }
      }
    }
  }
  if (!identityPhoto && kyc.identityPhoto && typeof kyc.identityPhoto === "string") identityPhoto = kyc.identityPhoto;
  const profilePrefill: Record<string, unknown> = {};
  const bvnFields = (normalizedFields.bvn as Record<string, unknown>) ?? {};
  const ninFields = (normalizedFields.nin as Record<string, unknown>) ?? {};
  const source = { ...ninFields, ...bvnFields };
  for (const key of ["fullName", "firstName", "middleName", "lastName", "dateOfBirth", "phone", "residentialAddress", "state", "lga", "email", "gender"]) {
    if (source[key] != null) profilePrefill[key] = source[key];
  }
  const proofOfAddressUrl = userDocs.find((d) => d.documentType === "PROOF_OF_ADDRESS")?.providerFileId;
  const safeVerificationEvents = identityVerificationEvents
    .filter((event) => event.kycCaseId === kyc.id)
    .map(({ rawResponse: _rawResponse, ...event }) => event);
  // Standalone KYC prefill: details the customer gave during their loan
  // application (identity numbers, personal data, uploaded documents) so the
  // Verification page can reuse them instead of asking for everything again.
  const applicationPrefill = applicationKycPrefill(req.user!.id);
  // Unmasked pooling: serve the FULL identity numbers (the masked display
  // value is never what the verification page or wizard should pool), and
  // self-heal masked/missing KYC-case columns from the raw store.
  backfillIdentityNumbers(req.user!.id);
  const pooledBvn = resolveFullBvn(req.user!.id) ?? (typeof kyc.bvn === "string" && kyc.bvn ? kyc.bvn : undefined);
  const pooledNin = resolveFullNin(req.user!.id) ?? (typeof kyc.nin === "string" && kyc.nin ? kyc.nin : undefined);
  res.json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    categoryResults: kyc.categoryResults ?? {},
    bvn: pooledBvn,
    nin: pooledNin,
    bvnLastFour: pooledBvn ? pooledBvn.slice(-4) : undefined,
    ninLastFour: pooledNin ? pooledNin.slice(-4) : undefined,
    submittedAt: kyc.submittedAt,
    rejectionReason: kyc.rejectionReason,
    documents: userDocs.map((doc) => ({
      ...publicDocumentView(doc),
      // Drive-hosted docs preview directly; inline/snapshot docs are fetched
      // through GET /me/documents/:id by the page when the user clicks preview.
      previewUrl: doc.provider === "google_drive" && doc.providerFileId
        ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(doc.providerFileId)}`
        : "",
      downloadUrl: doc.provider === "google_drive" && doc.providerFileId
        ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(doc.providerFileId)}`
        : "",
    })),
    verificationEvents: safeVerificationEvents,
    selfieImageData: undefined,
    livenessStatus: kyc.livenessStatus,
    livenessManualUploaded: kyc.livenessManualUploaded ?? false,
    verifiedDetails: Object.keys(source).length ? source : undefined,
    normalizedFields: Object.keys(normalizedFields).length ? normalizedFields : undefined,
    profilePrefill: Object.keys(profilePrefill).length ? profilePrefill : undefined,
    proofOfAddressUrl,
    applicationPrefill,
  });
});

router.post("/me/kyc", requireAuth, async (req: AuthRequest, res) => {
  const kyc = findOrCreateKycCase(req.user!.id);
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const schema = z
    .object({
      statusOverride: z.enum(["IN_PROGRESS", "PENDING_VERIFICATION"]).optional(),
      bvn: z.string().regex(/^\d{11}$/).optional(),
      nin: z.string().regex(/^\d{11}$/).optional(),
      checklist: z
        .object({
          bvn: z.boolean().optional(),
          nin: z.boolean().optional(),
          proofOfAddress: z.boolean().optional(),
          passport: z.boolean().optional(),
          signature: z.boolean().optional(),
        })
        .optional(),
    })
    .strict();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  if (parsed.data.checklist) {
    const safeChecklist: Record<string, boolean> = {};
    const allowedClientKeys = ["bvn", "nin"] as const;
    for (const key of allowedClientKeys) {
      if (typeof parsed.data.checklist[key] === "boolean") {
        safeChecklist[key] = parsed.data.checklist[key] as boolean;
      }
    }
    Object.assign(kyc.checklist, safeChecklist);
  }
  if (parsed.data.bvn) kyc.bvn = parsed.data.bvn;
  if (parsed.data.nin) kyc.nin = parsed.data.nin;
  if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
  // Submission gate: submitting for admin review requires SOME evidence (at
  // least one uploaded/pulled document or one completed check) — not the full
  // checklist. The admin reviews whatever was provided and can request more.
  const submissionEvidence =
    documents.some((d) => d.userId === user.id) ||
    (["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const).some((key) => kyc.checklist[key]);
  const submittedViaOverride = parsed.data.statusOverride === "PENDING_VERIFICATION";
  if (submittedViaOverride && submissionEvidence) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else {
    const requiredChecklistComplete = kyc.checklist.bvn && kyc.checklist.nin && kyc.checklist.proofOfAddress;
    if (requiredChecklistComplete) {
      kyc.status = "PENDING_VERIFICATION";
      kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
    }
  }
  user.kycStatus = kyc.status;
  kyc.updatedAt = new Date().toISOString();
  markKycChecklistComplete(user.id);
  if (!(await persistMutation(res))) return;
  // KYC lifecycle email — submitted for review.
  if (kyc.status === "PENDING_VERIFICATION" && user.email) {
    const template = kycSubmittedEmail({ name: user.fullName, source: "KYC_PAGE" });
    void sendEmail({ to: user.email, name: user.fullName, ...template }).catch(() => undefined);
  }
  res.status(202).json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    message:
      kyc.status === "VERIFIED"
        ? "KYC is verified."
        : kyc.status === "PENDING_VERIFICATION"
        ? "Your verification has been submitted. Our team will review it and email you the outcome."
        : "Add at least one verification step (verify your BVN/NIN or upload a document) before submitting.",
  });
});

// ---------------------------------------------------------------------------
// Reuse loan-application KYC documents — one click on the Verification page
// pulls the documents the customer uploaded during their loan application
// (ID, proof of address, signature) into their KYC case, so they never have to
// upload the same files twice.
// ---------------------------------------------------------------------------
router.post("/me/kyc/reuse-application-documents", requireAuth, async (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const application = loanApplications
    .filter((item) => item.borrowerId === user.id)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
    .find((item) => {
      const snap = (item.customerSnapshot ?? {}) as Record<string, unknown>;
      const docs = (snap.documents ?? {}) as Record<string, unknown>;
      return Boolean(docs.proofOfAddress || docs.signature || docs.identificationDocument);
    });
  if (!application) {
    res.status(404).json({ ok: false, error: "No loan application with uploaded documents was found on your account." });
    return;
  }
  const result = pullKycFromSubmittedApplication(application, user.id);
  const kyc = findOrCreateKycCase(user.id);
  schedulePersist();
  res.json({
    ok: true,
    reused: result.createdDocuments,
    checklist: kyc.checklist,
    status: kyc.status,
    message: result.createdDocuments > 0
      ? `${result.createdDocuments} document${result.createdDocuments === 1 ? "" : "s"} pulled from your loan application into your KYC verification.`
      : "Your loan application documents were already attached to your KYC verification.",
  });
});

// ---------------------------------------------------------------------------
// KYC pending notification — the customer tried an action their dashboard
// gates (invest, withdraw, payout…) while unverified. Send the "verify your
// KYC to trigger {action}" email so they know exactly what to do next.
// ---------------------------------------------------------------------------
router.post("/me/kyc/action-blocked", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({ action: z.enum(["LOAN_DISBURSEMENT", "INVESTMENT", "INVESTOR_PAYOUT", "WITHDRAWAL", "EARLY_LIQUIDITY"]) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  if (userKycVerified(user.id)) {
    res.json({ ok: true, notified: false, message: "Your KYC is already verified — you can retry the action now." });
    return;
  }
  await notifyKycBlocked(user, parsed.data.action);
  res.json({ ok: true, notified: true, message: "We emailed you a link to complete your KYC verification." });
});

router.post("/me/kyc/bvn/verify", requireAuth, async (req: AuthRequest, res) => {
  const parsed = bvnVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const kyc = findOrCreateKycCase(req.user!.id);
  const user = users.find((u) => u.id === req.user?.id);
  const result = await verifyBvn({
    number: parsed.data.bvn,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    dateOfBirth: parsed.data.dateOfBirth,
  });
  const event = {
    id: randomUUID(),
    kycCaseId: kyc.id,
    provider: "prembly" as const,
    verificationType: "BVN" as const,
    providerReference: result.providerReference,
    status: result.status,
    matchScore: result.matchScore,
    rawResponse: result.rawResponse,
    createdAt: new Date().toISOString(),
  };
  identityVerificationEvents.push(event);
  setKycCategoryResult(kyc, "BVN", result.status === "SUCCESS" ? "VERIFIED" : "REJECTED", result.errorMessage);
  if (result.status !== "SUCCESS") {
    kyc.status = "REJECTED";
    kyc.rejectionReason = providerReason(result.errorMessage);
    if (user) { user.kycStatus = kyc.status; await notifyKyc(user, "REJECTED", "BVN", kyc.rejectionReason); }
  }
  let otpChallengeForPhone: undefined | {
    challengeId: string; expiresAt: string; channel: "SMS"|"WHATSAPP"|"EMAIL"; phoneLastFour: string; resendAvailableAt: string; resendSecondsRemaining: number; requiresPhoneVerification: true;
  } = undefined;
  if (result.status === "SUCCESS") {
    kyc.bvn = parsed.data.bvn;
    if (kyc.status === "REJECTED") kyc.status = "IN_PROGRESS";
    kyc.providerRequestId = result.providerReference;
    // MERGE (never overwrite) the provider raw store so BOTH the BVN and NIN
    // raw blocks are always retained — whichever verification ran last must
    // not destroy the other identifier's NIBSS/NIMC raw response.
    kyc.providerRaw = { ...(kyc.providerRaw ?? {}), ...(result.rawResponse ?? {}) };
    // Cross-harvest: the NIBSS BVN Advance response can carry the customer's
    // linked NIN — capture it so the raw store holds both identifiers.
    const linkedNin =
      fullIdentifier((result.normalizedFields as { nin?: unknown } | undefined)?.nin) ??
      fullIdentifier(((result.rawResponse as { bvn?: { data?: Record<string, unknown> } | undefined } | undefined)?.bvn?.data as { nin?: unknown } | undefined)?.nin) ??
      fullIdentifier(((result.rawResponse as { bvn?: { bvn_data?: Record<string, unknown> } | undefined } | undefined)?.bvn?.bvn_data as { nin?: unknown } | undefined)?.nin);
    if (linkedNin && !/^\d{11}$/.test(kyc.nin ?? "")) kyc.nin = linkedNin;
    let identityPhone: string | undefined;
    if (user) {
      const details = result.normalizedFields ?? {};
      const idPhoneKeys = ["phone_number", "phoneNumber", "phone", "mobile", "telephoneno"];
      for (const key of idPhoneKeys) {
        if (typeof details[key] === "string" && String(details[key]).trim()) {
          identityPhone = String(details[key]).trim();
          break;
        }
      }
    }
    let phoneRequiresOwnershipProof = false;
    const normalizedPhone = loginOtpPhone(identityPhone);
    if (normalizedPhone) {
      phoneRequiresOwnershipProof = true;
    }
    if (phoneRequiresOwnershipProof && normalizedPhone) {
      const channel = parsed.data.otpChannel ?? (user?.preferredOtpChannel && user.preferredOtpChannel !== "EMAIL" ? user.preferredOtpChannel : "SMS") as "SMS";
      try {
        const challenge = await createOtpChallenge(
          req.user!.id,
          "KYC_VERIFICATION",
          normalizedPhone,
          user?.email,
          channel
        );
        otpChallengeForPhone = {
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt,
          channel,
          phoneLastFour: normalizedPhone.slice(-4),
          resendAvailableAt: challenge.resendAvailableAt,
          resendSecondsRemaining: challenge.resendSecondsRemaining,
          requiresPhoneVerification: true,
        };
      } catch (otpError) {
        if (otpError instanceof OtpRateLimitError) {
          const active = findLatestOtpChallenge(req.user!.id, "KYC_VERIFICATION");
          if (active) {
            otpChallengeForPhone = {
              challengeId: active.id,
              expiresAt: active.expiresAt,
              channel: active.deliveryChannel,
              phoneLastFour: String(active.phone ?? normalizedPhone).slice(-4),
              resendAvailableAt: otpError.resendAvailableAt,
              resendSecondsRemaining: otpError.resendSecondsRemaining,
              requiresPhoneVerification: true,
            };
          }
        } else {
          const msg = otpError instanceof Error ? otpError.message : "Unknown OTP dispatch error";
          console.error("[routes] BVN OTP dispatch failed (non-rate-limit) — falling back to ownership auto-complete:", msg);
          kyc.checklist.bvn = true;
          kyc.bvnVerifiedAt = new Date().toISOString();
          otpChallengeForPhone = undefined;
        }
      }
    } else {
      // Phone matches (or no identity phone) — ownership already considered proven
      kyc.checklist.bvn = true;
      kyc.bvnVerifiedAt = new Date().toISOString();
    }
  }
  if (user) {
    if (result.status === "SUCCESS" && !user.fullName.includes(parsed.data.firstName ?? "") && parsed.data.firstName) {
      // Names compared at manual review stage
    }
  }
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  const persistResult = await persistMutationBestEffort(res);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: otpChallengeForPhone,
    persistRetrying: persistResult.persistRetrying,
    persistError: persistResult.persistRetrying ? persistResult.persistError : undefined,
  });
});

router.post("/me/kyc/liveness/verify", requireAuth, livenessUpload.single("image"), async (req: AuthRequest, res) => {
  if (!req.file) { res.status(400).json({ ok: false, error: "A supported selfie image is required" }); return; }
  const kyc = findOrCreateKycCase(req.user!.id);
  const type = req.body.idType === "NIN" ? "NIN" : req.body.idType === "BVN" ? "BVN" : undefined;
  const number = typeof req.body.idNumber === "string" ? req.body.idNumber : "";
  if (!type || !/^\d{11}$/.test(number)) {
    res.status(400).json({ ok: false, error: "Verify your BVN or NIN before starting face verification." });
    return;
  }
  const result = await verifyIdentityWithFace({ type, number, image: req.file.buffer.toString("base64"), dateOfBirth: typeof req.body.dateOfBirth === "string" ? req.body.dateOfBirth : undefined });
  identityVerificationEvents.push({ id: randomUUID(), kycCaseId: kyc.id, provider: "prembly", verificationType: "LIVENESS", providerReference: result.providerReference, status: result.status, matchScore: result.matchScore, rawResponse: result.rawResponse, createdAt: new Date().toISOString() });
  setKycCategoryResult(kyc, "LIVENESS", result.status === "SUCCESS" ? "PENDING_REVIEW" : "PENDING_REVIEW", result.errorMessage ?? "Manual selfie upload pending admin review");
  const selfieImageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
  kyc.selfieImageData = selfieImageData;
  kyc.livenessStatus = result.status;
  kyc.livenessManualUploaded = true;
  if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
  kyc.updatedAt = new Date().toISOString();
  markKycChecklistComplete(req.user!.id);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, verificationStatus: "PENDING_ADMIN_REVIEW", providerConfigured: !result.errorMessage?.includes("not configured"), error: result.errorMessage, checklist: kyc.checklist, selfieImageData, message: "Selfie uploaded. An admin will review your liveness check shortly." });
});

router.post("/me/kyc/prembly-widget/complete", requireAuth, async (req: AuthRequest, res) => {
  const parsed = z.object({
    status: z.union([z.enum(["SUCCESS", "FAILED"]), z.string()]),
    providerReference: z.string().optional(),
    rawResponse: z.record(z.unknown()).optional(),
    selfieImageData: z.string().optional(),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const statusRaw = String(parsed.data.status).trim().toUpperCase();
  const successTokens = ["SUCCESS", "SUCCESSFUL", "VERIFIED", "PASS", "PASSED", "00", "OK", "APPROVE", "APPROVED", "VALID", "MATCH", "MATCHED", "COMPLETE", "COMPLETED", "TRUE"];
  const normalizedStatus = successTokens.some((token) => statusRaw.includes(token)) ? "SUCCESS" : "FAILED";
  const kyc = findOrCreateKycCase(req.user!.id);
  identityVerificationEvents.push({
    id: randomUUID(),
    kycCaseId: kyc.id,
    provider: "prembly",
    verificationType: "LIVENESS",
    providerReference: parsed.data.providerReference,
    status: normalizedStatus,
    rawResponse: parsed.data.rawResponse ?? {},
    createdAt: new Date().toISOString(),
  });
  let selfieImageData: string | undefined = parsed.data.selfieImageData;
  if (!selfieImageData && parsed.data.rawResponse) {
    const r = parsed.data.rawResponse as any;
    const candidates: unknown[] = [
      r.selfie,
      r.image,
      r.selfieImage,
      r.selfie_image,
      r.photo,
      r.photograph,
      r.face_image,
      r.base64Image,
      r.base64_image,
      r.imageBase64,
      r.selfieData,
      r.selfie_data,
      r.livenessSelfie,
      r.liveness_selfie,
      r.capturedImage,
      r.captured_image,
      (r.data as any)?.selfie,
      (r.data as any)?.image,
      (r.data as any)?.photo,
      (r.data as any)?.selfieImage,
      (r.data as any)?.imageBase64,
      (r.data as any)?.base64Image,
      (r.data as any)?.data?.selfie,
      (r.data as any)?.data?.image,
      (r.result as any)?.selfie,
      (r.result as any)?.image,
    ];
    for (const raw of candidates) {
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
  }
  if (normalizedStatus === "SUCCESS") {
    kyc.checklist.liveness = true;
    kyc.livenessStatus = "SUCCESS";
    kyc.livenessVerifiedAt = new Date().toISOString();
    setKycCategoryResult(kyc, "LIVENESS", "VERIFIED");
    kyc.updatedAt = new Date().toISOString();
    if (selfieImageData) {
      kyc.selfieImageData = selfieImageData;
    }
    const user = users.find((u) => u.id === req.user?.id);
    if (user) user.kycStatus = kyc.status;
    markKycChecklistComplete(req.user!.id);
  }
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, verificationStatus: normalizedStatus, providerConfigured: true, checklist: kyc.checklist, selfieImageData });
});

router.post("/me/kyc/nin/verify", requireAuth, async (req: AuthRequest, res) => {
  const parsed = ninVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const kyc = findOrCreateKycCase(req.user!.id);
  const user = users.find((u) => u.id === req.user?.id);
  const result = await verifyNin({
    number: parsed.data.nin,
    firstName: parsed.data.firstName,
    lastName: parsed.data.lastName,
    dateOfBirth: parsed.data.dateOfBirth,
  });
  const event = {
    id: randomUUID(),
    kycCaseId: kyc.id,
    provider: "prembly" as const,
    verificationType: "NIN" as const,
    providerReference: result.providerReference,
    status: result.status,
    matchScore: result.matchScore,
    rawResponse: result.rawResponse,
    createdAt: new Date().toISOString(),
  };
  identityVerificationEvents.push(event);
  setKycCategoryResult(kyc, "NIN", result.status === "SUCCESS" ? "VERIFIED" : "REJECTED", result.errorMessage);
  if (result.status !== "SUCCESS") {
    kyc.status = "REJECTED";
    kyc.rejectionReason = providerReason(result.errorMessage);
    if (user) { user.kycStatus = kyc.status; await notifyKyc(user, "REJECTED", "NIN", kyc.rejectionReason); }
  }
  let ninOtpChallenge: undefined | {
    challengeId: string; expiresAt: string; channel: "SMS"|"WHATSAPP"|"EMAIL"; phoneLastFour: string; resendAvailableAt: string; resendSecondsRemaining: number; requiresPhoneVerification: true;
  } = undefined;
  if (result.status === "SUCCESS") {
    kyc.nin = parsed.data.nin;
    if (kyc.status === "REJECTED") kyc.status = "IN_PROGRESS";
    kyc.providerRequestId = result.providerReference;
    // MERGE (never overwrite) the provider raw store so BOTH the BVN and NIN
    // raw blocks are always retained — whichever verification ran last must
    // not destroy the other identifier's NIBSS/NIMC raw response.
    kyc.providerRaw = { ...(kyc.providerRaw ?? {}), ...(result.rawResponse ?? {}) };
    // Cross-harvest: the NIMC NIN Advance response can carry the customer's
    // linked BVN — capture it so the raw store holds both identifiers. BVN is
    // mandatory for the credit bureau pipeline, so every source of it counts.
    const linkedBvn =
      fullIdentifier((result.normalizedFields as { bvn?: unknown } | undefined)?.bvn) ??
      fullIdentifier(((result.rawResponse as { nin?: { data?: Record<string, unknown> } | undefined } | undefined)?.nin?.data as { bvn?: unknown } | undefined)?.bvn) ??
      fullIdentifier(((result.rawResponse as { nin?: { nin_data?: Record<string, unknown> } | undefined } | undefined)?.nin?.nin_data as { bvn?: unknown } | undefined)?.bvn);
    if (linkedBvn && !/^\d{11}$/.test(kyc.bvn ?? "")) kyc.bvn = linkedBvn;
    let identityPhone: string | undefined;
    if (user) {
      const details = result.normalizedFields ?? {};
      const idPhoneKeys = ["phone_number", "phoneNumber", "phone", "mobile", "telephoneno"];
      for (const key of idPhoneKeys) {
        if (typeof details[key] === "string" && String(details[key]).trim()) {
          identityPhone = String(details[key]).trim();
          break;
        }
      }
    }
    let phoneRequiresOwnershipProof = false;
    const normalizedPhone = loginOtpPhone(identityPhone);
    if (normalizedPhone) {
      phoneRequiresOwnershipProof = true;
    }
    if (phoneRequiresOwnershipProof && normalizedPhone) {
      const channel = parsed.data.otpChannel ?? (user?.preferredOtpChannel && user.preferredOtpChannel !== "EMAIL" ? user.preferredOtpChannel : "SMS") as "SMS";
      try {
        const challenge = await createOtpChallenge(
          req.user!.id,
          "KYC_VERIFICATION",
          normalizedPhone,
          user?.email,
          channel
        );
        ninOtpChallenge = {
          challengeId: challenge.id,
          expiresAt: challenge.expiresAt,
          channel,
          phoneLastFour: normalizedPhone.slice(-4),
          resendAvailableAt: challenge.resendAvailableAt,
          resendSecondsRemaining: challenge.resendSecondsRemaining,
          requiresPhoneVerification: true,
        };
      } catch (otpError) {
        if (otpError instanceof OtpRateLimitError) {
          const active = findLatestOtpChallenge(req.user!.id, "KYC_VERIFICATION");
          if (active) {
            ninOtpChallenge = {
              challengeId: active.id,
              expiresAt: active.expiresAt,
              channel: active.deliveryChannel,
              phoneLastFour: String(active.phone ?? normalizedPhone).slice(-4),
              resendAvailableAt: otpError.resendAvailableAt,
              resendSecondsRemaining: otpError.resendSecondsRemaining,
              requiresPhoneVerification: true,
            };
          }
        } else {
          const msg = otpError instanceof Error ? otpError.message : "Unknown OTP dispatch error";
          console.error("[routes] NIN OTP dispatch failed (non-rate-limit) — falling back to ownership auto-complete:", msg);
          kyc.checklist.nin = true;
          kyc.ninVerifiedAt = new Date().toISOString();
          ninOtpChallenge = undefined;
        }
      }
    } else {
      kyc.checklist.nin = true;
      kyc.ninVerifiedAt = new Date().toISOString();
    }
  }
  if (Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  } else if (kyc.status === "NOT_STARTED") {
    kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = new Date().toISOString();
  if (user) user.kycStatus = kyc.status;
  markKycChecklistComplete(req.user!.id);
  const ninPersistResult = await persistMutationBestEffort(res);
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
    verifiedDetails: result.status === "SUCCESS" ? result.normalizedFields : undefined,
    otpChallenge: ninOtpChallenge,
    persistRetrying: ninPersistResult.persistRetrying,
    persistError: ninPersistResult.persistRetrying ? ninPersistResult.persistError : undefined,
  });
});

const kycConfirmOtpSchema = z.object({ idType: z.enum(["BVN","NIN"]), challengeId: z.string().min(1), code: z.string().regex(/^\d{6}$/, "6-digit OTP code is required"), channel: z.enum(["SMS"]).optional() });

router.post("/me/kyc/verify-confirm-otp", requireAuth, async (req: AuthRequest, res) => {
  const parsed = kycConfirmOtpSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const kyc = findOrCreateKycCase(req.user!.id);
  const user = users.find((u) => u.id === req.user?.id);
  try {
    const verified = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
    if (!verified || verified.action !== "KYC_VERIFICATION") {
      res.status(400).json({ ok: false, error: "Invalid or expired OTP. Try resending." });
      return;
    }
    const now = new Date().toISOString();
    if (parsed.data.idType === "BVN") {
      kyc.checklist.bvn = true;
      if (!kyc.bvnVerifiedAt) kyc.bvnVerifiedAt = now;
      kyc.updatedAt = now;
    } else {
      kyc.checklist.nin = true;
      if (!kyc.ninVerifiedAt) kyc.ninVerifiedAt = now;
      kyc.updatedAt = now;
    }
    markKycChecklistComplete(req.user!.id);
    if (!(await persistMutation(res))) return;
    res.json({
      ok: true,
      idType: parsed.data.idType,
      checklist: kyc.checklist,
      status: kyc.status,
      message: `${parsed.data.idType} ownership verified.`,
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Unable to verify OTP" });
  } finally {
    if (user) user.kycStatus = kyc.status;
  }
});

router.post("/me/kyc/verify-resend-otp", requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({ idType: z.enum(["BVN","NIN"]), challengeId: z.string().min(1), channel: z.enum(["SMS"]).optional() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const found = findOtpChallenge(parsed.data.challengeId);
  if (!found || found.userId !== req.user?.id || found.action !== "KYC_VERIFICATION") {
    res.status(404).json({ ok: false, error: "Challenge not found. Start a new verification request." });
    return;
  }
  const user = users.find((u) => u.id === req.user?.id);
  try {
    const channel = (parsed.data.channel ?? (found.deliveryChannel === "EMAIL" ? "SMS" : found.deliveryChannel)) as "SMS";
    const challenge = await createOtpChallenge(found.userId, "KYC_VERIFICATION", found.phone ?? user?.phone, found.email ?? user?.email, channel);
    res.json({
      ok: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: challenge.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
    });
  } catch (err) {
    res.status(429).json({ ok: false, error: err instanceof Error ? err.message : "Unable to resend OTP right now." });
  }
});

router.post("/me/kyc/documents", requireAuth, documentUpload.single("document"), async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: "A supported document file is required" });
    return;
  }
  const documentTypeSchema = z.enum([
    "PASSPORT_PHOTO",
    "PROOF_OF_ADDRESS",
    "SIGNATURE",
    "BVN_SLIP",
    "NIN_SLIP",
    "BUSINESS_REGISTRATION",
    "ID_CARD_FRONT",
    "ID_CARD_BACK",
    "SELFIE_PHOTO",
  ]);
  const documentType = documentTypeSchema.safeParse(req.body.documentType);
  if (!documentType.success) {
    res.status(400).json({ ok: false, error: `documentType must be one of: ${documentTypeSchema.options.join(", ")}` });
    return;
  }
  try {
    // FAST UPLOAD PATH: the document is persisted immediately as an inline
    // record (base64 kept on the row) and the request answers right away, so
    // the customer never waits on the Google Drive round-trip. The archive
    // copy to Drive happens in the background and upgrades the record in
    // place when it lands; if Drive is slow/unavailable the inline copy
    // remains the durable, viewable source of truth.
    const INLINE_KEEP_LIMIT_BYTES = 6 * 1024 * 1024;
    const record: StoreDocument = {
      id: randomUUID(),
      userId: req.user!.id,
      documentType: documentType.data,
      provider: "inline",
      providerFileId: `inline:${randomUUID()}`,
      inlineData: req.file.size <= INLINE_KEEP_LIMIT_BYTES
        ? `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`
        : undefined,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      status: "PENDING_REVIEW" as const,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    documents.push(record);
    const kyc = findOrCreateKycCase(req.user!.id);
    if (documentType.data === "SELFIE_PHOTO") {
      const isImage = req.file.mimetype.startsWith("image/");
      if (isImage && record.inlineData) {
        kyc.selfieImageData = record.inlineData;
      }
      kyc.livenessStatus = "PENDING_REVIEW";
      kyc.livenessManualUploaded = true;
      identityVerificationEvents.push({ id: randomUUID(), kycCaseId: kyc.id, provider: "manual", verificationType: "LIVENESS", status: "PENDING_REVIEW", createdAt: new Date().toISOString() });
    }
    if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
    kyc.updatedAt = new Date().toISOString();
    markKycChecklistComplete(req.user!.id);
    if (!(await persistMutation(res))) return;
    res.status(201).json({ ok: true, document: publicDocumentView(record), checklist: kyc.checklist, message: "Document uploaded and saved for admin review." });

    // Background archive upload — never blocks the response.
    void (async () => {
      try {
        const stored = await uploadPrivateDocument({
          filename: req.file!.originalname,
          mimeType: req.file!.mimetype,
          buffer: req.file!.buffer,
          userId: record.userId,
          documentType: documentType.data,
        });
        record.provider = stored.provider;
        record.providerFileId = stored.fileId;
        record.inlineData = undefined;
        record.uploadError = undefined;
        record.updatedAt = new Date().toISOString();
        schedulePersist();
      } catch (archiveError) {
        // Keep the inline copy authoritative; record why archival failed.
        record.uploadError = archiveError instanceof Error ? archiveError.message.slice(0, 300) : "Archive upload failed";
        schedulePersist();
      }
    })();
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Document storage unavailable",
    });
  }
});

/** Safe-to-send projection of a document record (never leaks inline bytes). */
function publicDocumentView(doc: StoreDocument): Record<string, unknown> {
  return {
    id: doc.id,
    documentType: doc.documentType,
    documentSlot: doc.documentSlot,
    provider: doc.provider,
    providerFileId: doc.providerFileId,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    hasInlineContent: Boolean(doc.inlineData),
    uploadError: doc.uploadError,
    version: doc.version,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Customer-facing document preview — resolves a document the user owns into
// viewable/downloadable URLs:
//   • inline (fast-path KYC uploads)  → the stored base64 data URL
//   • snapshot refs (loan application) → base64 from the application snapshot
//   • Google Drive                    → drive preview/download URLs
// ---------------------------------------------------------------------------
router.get("/me/documents/:documentId", requireAuth, (req: AuthRequest, res) => {
  const doc = documents.find((d) => d.id === String(req.params.documentId ?? "").trim() && d.userId === req.user!.id);
  if (!doc) {
    res.status(404).json({ ok: false, error: "Document not found" });
    return;
  }
  let previewUrl = "";
  let downloadUrl = "";
  if (doc.provider === "google_drive" && doc.providerFileId) {
    previewUrl = `https://drive.google.com/uc?export=view&id=${encodeURIComponent(doc.providerFileId)}`;
    downloadUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(doc.providerFileId)}`;
  } else if (doc.inlineData) {
    previewUrl = doc.inlineData;
    downloadUrl = doc.inlineData;
  } else if (doc.provider === "manual" && doc.providerFileId.startsWith("snapshot:")) {
    const [, applicationId, slot] = doc.providerFileId.split(":");
    const application = loanApplications.find((item) => item.id === applicationId);
    const snapshotDoc = slot
      ? ((application?.customerSnapshot as Record<string, unknown> | undefined)?.documents as Record<string, { data?: string; type?: string } | undefined> | undefined)?.[slot]
      : undefined;
    if (snapshotDoc?.data) {
      const mimeType = snapshotDoc.type || doc.mimeType || "application/octet-stream";
      const dataUrl = `data:${mimeType};base64,${snapshotDoc.data}`;
      previewUrl = dataUrl;
      downloadUrl = dataUrl;
    }
  }
  res.json({
    ok: true,
    document: {
      ...publicDocumentView(doc),
      previewUrl,
      downloadUrl,
      unavailable: !previewUrl,
    },
  });
});

router.post("/me/payout-accounts", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const parsed = payoutAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const existing = payoutAccounts.find((item) => item.userId === req.user!.id);
  const now = new Date().toISOString();
  const account = {
    id: existing?.id ?? randomUUID(),
    userId: req.user!.id,
    ...parsed.data,
    status: "PENDING_VERIFICATION" as const,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  if (existing) Object.assign(existing, account);
  else payoutAccounts.push(account);
  if (!(await persistMutation(res))) return;
  res.status(202).json({
    ok: true,
    account,
    message: "Payout account saved and requires verification before settlement.",
  });
});

router.post("/me/payout-accounts/:id/verify", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const account = payoutAccounts.find((a) => a.id === req.params.id && a.userId === req.user?.id);
  if (!account) {
    res.status(404).json({ ok: false, error: "Payout account not found" });
    return;
  }
  account.status = "VERIFIED";
  account.verifiedAt = new Date().toISOString();
  account.verificationReference = `local-verification-${randomUUID()}`;
  account.updatedAt = new Date().toISOString();
  if (!(await persistMutation(res))) return;
  res.json({
    ok: true,
    account,
    message: "Payout account verified. Configure Flutterwave account-name enquiry before production.",
  });
});

router.get("/investor/dashboard", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  // Self-heal stale/phantom holds BEFORE the wallet is read so the dashboard
  // never displays money as "locked" without a backing record.
  try { reconcileWalletHolds(req.user!.id); } catch (reconcileError) {
    console.error("[routes] dashboard hold reconciliation failed:", reconcileError);
  }
  const wallet = findWallet(req.user!.id);
  const userInvestments = investments.filter((item) => item.investorId === req.user!.id);
  const userPayouts = payouts.filter((item) => item.userId === req.user!.id);
  const account = payoutAccounts.find((item) => item.userId === req.user!.id) ?? null;
  const userDocs = documents.filter((d) => d.userId === req.user?.id);
  const now = new Date();
  const investmentViews = userInvestments.map((investment) => ({ ...investment, accrual: calculateInvestmentAccrual(investment, now) }));
  res.json({ ok: true, wallet, investments: investmentViews, payouts: userPayouts, payoutAccount: account, documents: userDocs });
});

router.get("/investor/wallet", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  try { reconcileWalletHolds(req.user!.id); } catch (reconcileError) {
    console.error("[routes] wallet hold reconciliation failed:", reconcileError);
  }
  const wallet = findWallet(req.user!.id);
  const entries = ledgerEntries.filter((e) => e.walletId === wallet.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const transactions = walletTransactions.filter((t) => t.userId === req.user?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, wallet, ledger: entries, transactions });
});

router.get("/investor/payout-account", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  res.json({ ok: true, account: payoutAccounts.find((item) => item.userId === req.user!.id) ?? null });
});

router.put("/investor/payout-account", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const parsed = payoutAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const existing = payoutAccounts.find((item) => item.userId === req.user!.id);
  const now = new Date().toISOString();
  const account = {
    id: existing?.id ?? randomUUID(),
    userId: req.user!.id,
    ...parsed.data,
    status: "PENDING_VERIFICATION" as const,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  if (existing) Object.assign(existing, account);
  else payoutAccounts.push(account);
  if (!(await persistMutation(res))) return;
  res.status(202).json({
    ok: true,
    account,
    message: "Payout account saved and requires verification before settlement.",
  });
});

router.get("/investor/investment-plans", requireAuth, requireRole("INVESTOR"), (_req, res) => {
  res.json({ ok: true, plans: investmentPlans.filter((p) => p.isActive) });
});

router.post("/investor/wallet/funding", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "amountNaira must be a positive number" });
    return;
  }
  const user = users.find((u) => u.id === req.user?.id);
  const txRef = `VELO-FUND-${randomUUID()}`;
  const now = new Date().toISOString();
  const wallet = findWallet(req.user!.id);
  wallet.pendingDepositMinor += Math.round(parsed.data.amountNaira * 100);
  walletTransactions.push({
    id: randomUUID(),
    userId: req.user!.id,
    walletId: wallet.id,
    type: "DEPOSIT",
    amountMinor: Math.round(parsed.data.amountNaira * 100),
    currency: "NGN",
    status: "PENDING_PROVIDER_CONFIRMATION",
    provider: "flutterwave",
    txRef,
    createdAt: now,
  });
  // Persist in the background — the funding intent lives in memory immediately
  // and the sweeper guarantees it lands in PostgreSQL. A slow DB no longer
  // blocks (or fails) the checkout hand-off.
  schedulePersist();
  try {
    const checkout = await initializeWalletFunding({
      txRef,
      amountNaira: parsed.data.amountNaira,
      email: user?.email ?? req.user!.email,
      phone: user?.phone ?? "",
      name: user?.fullName ?? req.user!.fullName,
      redirectUrl: `${env.API_PUBLIC_URL}/api/v1/payments/flutterwave/return`,
    });
    res.status(200).json({
      ok: true,
      txRef,
      amountNaira: parsed.data.amountNaira,
      checkout,
      message:
        "Complete the secure Flutterwave checkout. Your wallet is credited only after verified server-to-server confirmation.",
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Flutterwave unavailable";
    console.error("[routes] Flutterwave funding checkout failed:", detail);
    // 200 (not 503): the funding intent was recorded and can be retried or
    // verified manually; the client shows the friendly message instead of a
    // generic request failure.
    res.status(200).json({
      ok: true,
      txRef,
      amountNaira: parsed.data.amountNaira,
      checkout: null,
      message:
        "We couldn't start the payment checkout just now. Your funding request was recorded — please try again in a moment or contact support if it persists.",
      error: detail,
    });
  }
});

router.post("/investor/wallet/funding/verify", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const parsed = z.object({ transactionId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "transactionId is required" });
    return;
  }
  try {
    const verification = await verifyTransactionWithRetry(parsed.data.transactionId, 3, 1500);
    const fwData = verification.data ?? {};
    const txRef = (fwData.tx_ref as string) ?? undefined;
    const flwRef = (fwData.flw_ref as string) ?? undefined;
    const amount = Number(fwData.amount);
    const chargeAmount = Number(fwData.charged_amount ?? fwData.amount);
    if (!txRef) {
      res.status(422).json({ ok: false, error: "Transaction reference missing from Flutterwave response", txRef });
      return;
    }
    const pending = walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT");
    const verifiedCurrency = String(fwData.currency ?? "").toUpperCase();
    const verifiedAmountMinor = Math.round(Number(fwData.amount ?? 0) * 100);
    if (!pending || pending.userId !== req.user!.id || verifiedCurrency !== "NGN" || verifiedAmountMinor !== pending.amountMinor) {
      res.status(422).json({ ok: false, error: "Verified transaction does not match this wallet funding request", txRef });
      return;
    }
    if (!verification.settled) {
      const pending = walletTransactions.find((t) => t.txRef === txRef);
      if (pending && pending.status === "PENDING_PROVIDER_CONFIRMATION") {
        if (verification.status === "failed") {
          pending.status = "FAILED";
          pending.updatedAt = new Date().toISOString();
          const wallet = findWallet(pending.userId);
          wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - pending.amountMinor);
        }
      }
      schedulePersist();
      res.status(402).json({ ok: false, error: `Payment status=${verification.status}, wallet not credited`, txRef, status: verification.status });
      return;
    }
    const settled = settleWalletDeposit({ txRef, providerReference: flwRef, providerTransactionId: parsed.data.transactionId });
    if (!settled.ok) {
      res.status(409).json({ ok: false, error: settled.reason ?? "Unable to settle deposit", txRef });
      return;
    }
    if (settled.user && settled.wallet && settled.reason !== "already_settled") {
      const email = investorWalletFundedEmail({
        investorName: settled.user.fullName,
        amountNaira: Number((settled.tx?.amountMinor ?? 0) / 100),
        balanceNaira: Number(settled.wallet.availableMinor / 100),
        reference: txRef,
      });
      // Email is fire-and-forget — it must never delay the wallet credit.
      void sendEmail({ to: settled.user.email, name: settled.user.fullName, subject: email.subject, html: email.html }).catch(() => undefined);
    }
    schedulePersist();
    res.json({ ok: true, settled: settled.tx, txRef, amount, chargeAmount, reason: settled.reason ?? "settled" });
  } catch (err) {
    res.status(502).json({ ok: false, error: err instanceof Error ? err.message : "Unable to reach Flutterwave" });
  }
});

router.get("/payments/flutterwave/return", async (req, res) => {
  const { status, tx_ref, transaction_id, flw_ref } = req.query as Record<string, string | undefined>;
  let txRef = tx_ref;
  let providerTxId = transaction_id;
  let providerRef = flw_ref;
  const safeRedirect = (ok: boolean, message: string) => {
    const base = `${env.API_ORIGIN}/investor`;
    const params = new URLSearchParams();
    params.set("funding", ok ? "success" : "failed");
    if (txRef) params.set("tx_ref", txRef);
    if (message) params.set("message", message.slice(0, 200));
    res.redirect(302, `${base}?${params.toString()}`);
  };
  try {
    let verifiedSettled = false;
    if (providerTxId) {
      try {
        const verification = await verifyTransactionWithRetry(providerTxId, 3, 1000);
        const fwData = verification.data ?? {};
        txRef = (fwData.tx_ref as string) ?? txRef;
        providerRef = (fwData.flw_ref as string) ?? providerRef;
        const pending = txRef ? walletTransactions.find((t) => t.txRef === txRef && t.type === "DEPOSIT") : undefined;
        const verifiedCurrency = String(fwData.currency ?? "").toUpperCase();
        const verifiedAmountMinor = Math.round(Number(fwData.amount ?? 0) * 100);
        if (verification.settled && pending && verifiedCurrency === "NGN" && verifiedAmountMinor === pending.amountMinor) {
          verifiedSettled = true;
        } else {
          if (txRef) {
            const pending = walletTransactions.find((t) => t.txRef === txRef);
            if (pending && pending.status === "PENDING_PROVIDER_CONFIRMATION") {
              if (verification.status === "failed") {
                pending.status = "FAILED";
                pending.updatedAt = new Date().toISOString();
                const wallet = findWallet(pending.userId);
                wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - pending.amountMinor);
              }
            }
          }
          safeRedirect(false, `Payment status=${verification.status || status || "unknown"}`);
          return;
        }
      } catch (_verr) {
        safeRedirect(false, "Payment verification failed. Please check your wallet balance later or contact support.");
        return;
      }
    }
    if (!verifiedSettled) {
      safeRedirect(false, status === "successful" ? "Waiting for server confirmation. Check your wallet shortly." : (status ? `Payment status=${status}` : "No payment confirmation received."));
      return;
    }
    if (!txRef) {
      safeRedirect(false, "No transaction reference in redirect");
      return;
    }
    const settled = settleWalletDeposit({ txRef, providerReference: providerRef, providerTransactionId: providerTxId });
    if (settled.user && settled.wallet && settled.reason !== "already_settled") {
      try {
        const email = investorWalletFundedEmail({
          investorName: settled.user.fullName,
          amountNaira: Number((settled.tx?.amountMinor ?? 0) / 100),
          balanceNaira: Number(settled.wallet.availableMinor / 100),
          reference: txRef,
        });
        await sendEmail({ to: settled.user.email, name: settled.user.fullName, subject: email.subject, html: email.html });
      } catch (_emailErr) {
        // Non-fatal
      }
    }
    safeRedirect(settled.ok, settled.ok ? "Wallet has been credited successfully" : (settled.reason ?? "Unable to credit wallet"));
    return;
  } catch (err) {
    safeRedirect(false, err instanceof Error ? err.message : "Server error while verifying payment");
    return;
  }
});

router.get("/investor/investments", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const now = new Date();
  res.json({ ok: true, investments: investments.filter((item) => item.investorId === req.user!.id).map((investment) => ({ ...investment, accrual: calculateInvestmentAccrual(investment, now) })) });
});

router.post("/investor/investments", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const parsed = createInvestmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const user = users.find((u) => u.id === req.user?.id);
  const kyc = findOrCreateKycCase(req.user!.id);
  if (!user || kyc.status !== "VERIFIED" && kyc.status !== "PARTIALLY_VERIFIED") {
    // Tell the investor exactly what to do — email + in-app notification.
    if (user) void notifyKycBlocked(user, "INVESTMENT");
    res.status(409).json({
      ok: false,
      code: "KYC_REQUIRED",
      error: "Your KYC verification is pending. Complete your identity verification before you can invest.",
      kycStatus: kyc.status,
    });
    return;
  }
  const plan = parsed.data.planId ? investmentPlans.find((p) => p.id === parsed.data.planId) : undefined;
  const planRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;
  const annualRate = getEffectiveInvestorRate(req.user!.id, planRate);
  const tenure = plan?.tenureDays ?? parsed.data.tenureDays;
  if (plan) {
    if (!plan.isActive) {
      res.status(409).json({ ok: false, error: "This investment plan is not active." });
      return;
    }
    if (parsed.data.amountNaira < plan.minAmountNaira || parsed.data.amountNaira > plan.maxAmountNaira) {
      res.status(400).json({
        ok: false,
        error: `Amount must be between ₦${plan.minAmountNaira.toLocaleString("en-NG")} and ₦${plan.maxAmountNaira.toLocaleString("en-NG")}.`,
      });
      return;
    }
  }
  const wallet = findWallet(req.user!.id);
  if (wallet.availableMinor < Math.round(parsed.data.amountNaira * 100)) {
    res.status(409).json({ ok: false, error: "Insufficient available wallet balance" });
    return;
  }
  const startsAt = new Date();
  const maturesAt = new Date(startsAt.getTime() + tenure * 86400000);
  const expectedEarnings = calculateInvestmentAccrual({ amountNaira: parsed.data.amountNaira, annualRatePercent: annualRate, tenureDays: tenure, startsAt: startsAt.toISOString(), maturesAt: maturesAt.toISOString() }).expectedEarningsNaira;
  const investment = {
    id: randomUUID(),
    investorId: req.user!.id,
    planId: plan?.id,
    planVersion: plan?.version,
    planSnapshot: plan ? { ...plan } : undefined,
    amountNaira: parsed.data.amountNaira,
    expectedEarningsNaira: expectedEarnings,
    tenureDays: tenure,
    annualRatePercent: annualRate,
    startsAt: startsAt.toISOString(),
    maturesAt: maturesAt.toISOString(),
    status: "ACTIVE" as const,
    createdAt: startsAt.toISOString(),
  };
  investments.push(investment);
  const amountMinor = Math.round(parsed.data.amountNaira * 100);
  appendLedger(wallet, {
    entryType: "INVESTMENT_LOCK",
    referenceId: investment.id,
    amountMinor,
    direction: "DEBIT",
    description: `Investment ${investment.id} locked`,
  });
  walletTransactions.push({
    id: randomUUID(),
    userId: req.user!.id,
    walletId: wallet.id,
    type: "INVESTMENT",
    amountMinor,
    currency: "NGN",
    status: "COMPLETED",
    txRef: `VELO-INVEST-${investment.id}`,
    createdAt: startsAt.toISOString(),
  });
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, investment });
});

router.post("/investor/investments/:id/liquidity", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const investment = investments.find((i) => i.id === req.params.id && i.investorId === req.user?.id);
  if (!investment) {
    res.status(404).json({ ok: false, error: "Investment not found" });
    return;
  }
  if (investment.status !== "ACTIVE") {
    res.status(409).json({ ok: false, error: `Investment is ${investment.status} and cannot request early liquidity.` });
    return;
  }
  // KYC gate: payouts (including early liquidity) require verified identity.
  if (!userKycVerified(req.user!.id)) {
    const requester = users.find((u) => u.id === req.user!.id);
    if (requester) void notifyKycBlocked(requester, "EARLY_LIQUIDITY");
    res.status(409).json({ ok: false, code: "KYC_REQUIRED", error: "Your KYC verification is pending. Complete your identity verification before requesting early liquidity." });
    return;
  }
  const plan = investment.planId ? investmentPlans.find((p) => p.id === investment.planId) : undefined;
  if (plan && !plan.earlyLiquidityAllowed) {
    res.status(409).json({ ok: false, error: "Early liquidity is not permitted for this plan." });
    return;
  }
  const account = payoutAccounts.find((a) => a.userId === req.user!.id && a.status === "VERIFIED");
  if (!account) {
    res.status(409).json({ ok: false, error: "A verified payout account is required for early liquidity." });
    return;
  }
  const parsed = earlyLiquiditySchema.safeParse(req.body);
  if (parsed.success && parsed.data.otpChallengeId && parsed.data.otpCode) {
    const verified = await verifyOtpChallenge(parsed.data.otpChallengeId, parsed.data.otpCode);
    if (!verified.ok) {
      res.status(400).json({ ok: false, error: verified.error ?? "OTP verification failed" });
      return;
    }
  }
  const liquidityFeePercent = plan?.earlyLiquidityFeePercent ?? 0;
  const gatewayFeePercent = plan?.gatewayFeePercent ?? 0;
  const forfeitInterest = plan?.forfeitInterestOnEarlyExit ?? false;
  const eligibleEarnings = forfeitInterest ? 0 : Number(investment.expectedEarningsNaira ?? 0);
  const liquidityFee = (Number(investment.amountNaira) * liquidityFeePercent) / 100;
  const gatewayFee = (Number(investment.amountNaira) * gatewayFeePercent) / 100;
  const totalFees = liquidityFee + gatewayFee;
  const net = Number(investment.amountNaira) + eligibleEarnings - totalFees;
  const now = new Date().toISOString();
  investment.status = "LIQUIDITY_APPROVED";
  investment.liquidityRequestedAt = now;
  investment.liquidityApprovedAt = now;
  investment.liquidityFeeNaira = Math.round(totalFees * 100) / 100;
  investment.netPayoutNaira = Math.round(net * 100) / 100;
  investment.updatedAt = now;
  const wallet = findWallet(req.user!.id);
  const amountMinor = Math.round(Number(investment.amountNaira) * 100);
  const earningsMinor = Math.round(eligibleEarnings * 100);
  const feesMinor = Math.round(totalFees * 100);
  appendLedger(wallet, {
    entryType: "INVESTMENT_RELEASE",
    referenceId: investment.id,
    amountMinor,
    direction: "CREDIT",
    description: `Early liquidity release for investment ${investment.id}`,
  });
  if (earningsMinor > 0) {
    appendLedger(wallet, {
      entryType: "INVESTMENT_RETURN",
      referenceId: investment.id,
      amountMinor: earningsMinor,
      direction: "CREDIT",
      description: `Eligible earnings for early liquidity ${investment.id}`,
    });
  }
  if (feesMinor > 0) {
    appendLedger(wallet, {
      entryType: "FEE",
      referenceId: investment.id,
      amountMinor: feesMinor,
      direction: "DEBIT",
      description: `Early liquidity fees (${liquidityFeePercent}% + ${gatewayFeePercent}%)`,
    });
  }
  const payout: (typeof payouts)[number] = {
    id: randomUUID(),
    userId: req.user!.id,
    investmentId: investment.id,
    payoutType: "EARLY_LIQUIDITY",
    principalNaira: Number(investment.amountNaira),
    earningsNaira: eligibleEarnings,
    feesNaira: totalFees,
    amountNaira: investment.netPayoutNaira,
    currency: "NGN",
    status: "PENDING_APPROVAL",
    payoutAccountSnapshot: account as unknown as Record<string, unknown>,
    retryCount: 0,
    idempotencyKey: `liq-${investment.id}-${now}`,
    createdAt: now,
    updatedAt: now,
  };
  payouts.push(payout);
  res.json({
    ok: true,
    breakdown: {
      principalNaira: investment.amountNaira,
      earningsNaira: eligibleEarnings,
      liquidityFeeNaira: liquidityFee,
      gatewayFeeNaira: gatewayFee,
      netPayoutNaira: investment.netPayoutNaira,
    },
    investment,
    payout,
    otpRequired: !(parsed.success && parsed.data.otpChallengeId),
    message: "Early liquidity approved. Payout is created pending admin approval and Flutterwave settlement activation.",
  });
});

// Provider verification happens entirely in the background: this endpoint is
// polled every ~15s by the investor dashboard, so it must return stored state
// instantly. Verification results are picked up by the NEXT poll.
let withdrawalVerificationInFlight = false;
function verifyPendingWithdrawalsInBackground(): void {
  if (withdrawalVerificationInFlight) return;
  withdrawalVerificationInFlight = true;
  void (async () => {
    try {
      const pending = investorWithdrawals.filter((item) => ["PENDING", "PROCESSING"].includes(item.status));
      for (const withdrawal of pending) {
        const transfer = (withdrawal.providerTransfer ?? {}) as { initiate?: { data?: { id?: number | string; reference?: string } }; verification?: Record<string, unknown> };
        const transferId = String(transfer.initiate?.data?.id ?? "");
        // NOTE: only a real provider transfer id makes verification possible —
        // the reference string has a constant fallback (`WITHDRAWAL-<id>`) and
        // is therefore useless as a "provider saw this transfer" signal.
        if (!transferId) {
          // No provider transfer was ever created. If this has been stuck for
          // over 15 minutes the transfer will never happen — fail it and
          // release the hold so the money returns to the wallet instead of
          // staying locked forever.
          const ageMs = Date.now() - (Date.parse(withdrawal.updatedAt || withdrawal.createdAt || "") || 0);
          if (ageMs > 15 * 60_000) {
            const now = new Date().toISOString();
            withdrawal.status = "FAILED";
            withdrawal.error = "Transfer was never initiated (timed out) — funds returned to your wallet";
            withdrawal.updatedAt = now;
            reverseInvestorWithdrawal(withdrawal, "Transfer was never initiated (timed out)");
            console.warn(`[routes] withdrawal ${withdrawal.id} had no provider transfer id; reversed after ${Math.round(ageMs / 60000)}m`);
          }
          continue;
        }
        const reference = withdrawal.providerReference ?? String(transfer.initiate?.data?.reference ?? `WITHDRAWAL-${withdrawal.id}`);
        const verification = await verifyTransferWithRetry(transferId, reference, 1, 250);
        const now = new Date().toISOString();
        withdrawal.providerTransfer = { ...withdrawal.providerTransfer, verification } as unknown as Record<string, unknown>;
        if (verification.settled && withdrawal.status !== "SUCCESSFUL") {
          withdrawal.status = "SUCCESSFUL";
          withdrawal.error = undefined;
          withdrawal.processedAt = now;
          withdrawal.updatedAt = now;
          appendLedger(findWallet(withdrawal.investorId), { entryType: "WITHDRAWAL_SETTLEMENT", referenceId: withdrawal.id, amountMinor: 0, direction: "CREDIT", description: "Release funds held for successful withdrawal", metadata: { releasedAmountMinor: Math.round(Number(withdrawal.amountNaira) * 100) } });
        } else if (verification.status === "failed" && withdrawal.status !== "FAILED") {
          const reason = typeof (verification.data as Record<string, unknown> | undefined)?.complete_message === "string" ? String((verification.data as Record<string, unknown>).complete_message) : "Transfer verification returned failed status";
          withdrawal.status = "FAILED";
          withdrawal.error = reason;
          withdrawal.updatedAt = now;
          reverseInvestorWithdrawal(withdrawal, reason);
        }
      }
      if (pending.length > 0) schedulePersist();
    } catch (error) {
      console.error("[routes] background withdrawal verification failed:", error);
    } finally {
      withdrawalVerificationInFlight = false;
    }
  })();
}

router.get("/investor/withdrawals/status", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const refreshed = investorWithdrawals.filter((item) => item.investorId === req.user!.id && ["PENDING", "PROCESSING"].includes(item.status));
  if (refreshed.length > 0) verifyPendingWithdrawalsInBackground();
  try { reconcileWalletHolds(req.user!.id); } catch (reconcileError) {
    console.error("[routes] withdrawal-status hold reconciliation failed:", reconcileError);
  }
  res.json({ ok: true, withdrawals: refreshed, wallet: findWallet(req.user!.id) });
});

// Converge wallet deposits stuck in PENDING/PENDING_PROVIDER_CONFIRMATION:
// their redirect verification or webhook was missed, so money the investor
// actually paid never settled and the transaction history showed "PENDING
// PROVIDER CONFIRMATION" instead of SUCCESSFUL. Re-verified by tx_ref at most
// once every 5 minutes per row; on confirmation the wallet is credited and the
// history flips to SUCCESSFUL, on a definitive provider failure the row is
// marked FAILED and the pending-hold released.
const DEPOSIT_RECONCILE_MIN_AGE_MS = 90_000;
const depositReconcileAttempts = new Map<string, number>();
async function reconcileStalePendingDeposits(): Promise<void> {
  if (!env.FLUTTERWAVE_SECRET_KEY) return;
  const nowMs = Date.now();
  const stale = walletTransactions.filter((t) => {
    if (t.type !== "DEPOSIT") return false;
    if (!["PENDING", "PENDING_PROVIDER_CONFIRMATION", "PROVIDER_NOT_CONFIGURED"].includes(String(t.status))) return false;
    const createdAtMs = new Date(t.createdAt as unknown as string).getTime();
    if (!Number.isFinite(createdAtMs) || nowMs - createdAtMs <= DEPOSIT_RECONCILE_MIN_AGE_MS) return false;
    return nowMs - (depositReconcileAttempts.get(t.id) ?? 0) > 5 * 60_000;
  });
  for (const tx of stale) {
    depositReconcileAttempts.set(tx.id, nowMs);
    if (!tx.txRef) continue;
    try {
      const result = await verifyTransactionByReference(tx.txRef);
      const data = (result?.data ?? {}) as Record<string, unknown>;
      const providerStatus = String(data.status ?? result?.status ?? "").toLowerCase();
      const currency = String(data.currency ?? "NGN").toUpperCase();
      const amountMatches = Math.round(Number(data.amount ?? 0) * 100) === Number(tx.amountMinor);
      if ((providerStatus === "successful" || providerStatus === "success") && currency === "NGN" && amountMatches) {
        const settled = settleWalletDeposit({
          txRef: tx.txRef,
          providerReference: String(data.id ?? data.flw_ref ?? tx.txRef),
          providerTransactionId: String(data.id ?? ""),
        });
        if (settled.ok) {
          tx.updatedAt = new Date().toISOString();
          console.info(`[routes] deposit ${tx.id} settled via reconciliation sweep (txRef=${tx.txRef})`);
          schedulePersist();
        }
      } else if (["failed", "cancelled", "canceled", "reversed"].includes(providerStatus)) {
        tx.status = "FAILED";
        tx.metadata = { ...(tx.metadata ?? {}), reconcileNote: `Provider reported payment status=${providerStatus}` };
        tx.updatedAt = new Date().toISOString();
        const wallet = findWallet(tx.userId);
        wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - tx.amountMinor);
        schedulePersist();
      }
    } catch (_error) {
      // Provider hiccup or a genuinely never-paid intent — the next sweep
      // window retries; unpaid intents simply keep PENDING forever.
    }
  }
}

router.get("/investor/transactions", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  // Self-healing for the transaction history: deposits whose redirect
  // verification or webhook was missed stay PENDING forever, so the history
  // keeps showing "PENDING PROVIDER CONFIRMATION" for payments the investor
  // actually made. Re-verify stuck deposits against the provider (by tx_ref)
  // and settle/FAIL them; fire-and-forget so the listing never blocks.
  void reconcileStalePendingDeposits().catch((err) => console.error("[routes] deposit reconciliation sweep failed:", err));
  const wallet = findWallet(req.user!.id);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const userInvestments = indexes.investmentsByInvestorId.get(req.user!.id) ?? [];
  const userPayouts = indexes.payoutsByUserId.get(req.user!.id) ?? [];
  const userLedger = (indexes.ledgerEntriesByWalletId.get(wallet.id) ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const userWalletTxs = (indexes.walletTransactionsByUserId.get(req.user!.id) ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Withdrawal records carry the LIVE transfer status (PROCESSING → SUCCESSFUL/
  // FAILED) — the UI needs them so a settled withdrawal no longer renders as an
  // eternal "PROCESSING" ledger row in the transaction history.
  const userWithdrawals = investorWithdrawals
    .filter((w) => w.investorId === req.user!.id)
    .slice()
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
  const sliced = {
    investments: userInvestments.slice(offset, offset + limit),
    payouts: userPayouts.slice(offset, offset + limit),
    ledger: userLedger.slice(offset, offset + limit),
    walletTransactions: userWalletTxs.slice(offset, offset + limit),
    withdrawals: userWithdrawals.slice(offset, offset + limit),
  };
  res.json({
    ok: true,
    ...sliced,
    meta: {
      limit,
      offset,
      totals: {
        investments: userInvestments.length,
        payouts: userPayouts.length,
        ledger: userLedger.length,
        walletTransactions: userWalletTxs.length,
        withdrawals: userWithdrawals.length,
      },
      hasMore: {
        investments: offset + limit < userInvestments.length,
        payouts: offset + limit < userPayouts.length,
        ledger: offset + limit < userLedger.length,
        walletTransactions: offset + limit < userWalletTxs.length,
        withdrawals: offset + limit < userWithdrawals.length,
      },
    },
  });
});

export function synchronizeLoanApplicationStatus(application: (typeof loanApplications)[number]): boolean {
  const loan = loans.find((item) => item.applicationId === application.id || item.applicationId === application.applicationId);
  if (!loan) return false;
  const successfulDisbursement = loanDisbursements.some((item) => item.loanId === loan.id && item.status === "SUCCESSFUL");
  let loanChanged = false;
  if (loan.status === "DISBURSED" || (successfulDisbursement && ["APPROVED", "DISBURSEMENT_PENDING"].includes(loan.status))) {
    loan.status = "ACTIVE";
    loan.disbursedAt = loan.disbursedAt ?? new Date().toISOString();
    loan.updatedAt = new Date().toISOString();
    loanChanged = true;
  }
  // Application-status semantics:
  //   REPAID   -> loan fully repaid
  //   ACTIVE   -> loan money has been disbursed and is now in repayment
  //                (covers ACTIVE, DISBURSED, PAST_DUE, DEFAULTED, WRITTEN_OFF)
  //   APPROVED  -> admin approved, awaiting disbursement
  //   (others)  -> fall through to current application status
  // We map ACTIVE loans to the "ACTIVE" application status so the borrower
  // and admin UIs reflect that the loan has been disbursed and is now active
  // in its repayment lifecycle.
  const activeLikeStatuses: LoanStatus[] = ["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "WRITTEN_OFF"];
  const nextStatus: string = loan.status === "REPAID" ? "REPAID"
                  : activeLikeStatuses.includes(loan.status as LoanStatus) ? "ACTIVE"
                  : loan.status === "DISBURSEMENT_PENDING" ? "APPROVED"
                  : application.status;
  if (application.status === nextStatus) return loanChanged;
  application.status = nextStatus as typeof application.status;
  application.updatedAt = new Date().toISOString();
  return true;
}

const LOCKED_LOAN_STATUSES = new Set(["APPROVED", "DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF", "CANCELLED"]);

function linkedLoan(application: (typeof loanApplications)[number]) {
  return loans.find((item) => item.applicationId === application.id || item.applicationId === application.applicationId);
}

function isLockedLoanApplication(application: (typeof loanApplications)[number]): boolean {
  const loan = linkedLoan(application);
  return Boolean(loan && LOCKED_LOAN_STATUSES.has(loan.status));
}

router.get("/borrower/dashboard", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const userApplications = loanApplications.filter((item) => item.borrowerId === req.user!.id);
  const changed = userApplications.some(synchronizeLoanApplicationStatus);
  if (changed) await persistStore().catch(() => undefined);
  const userLoans = loans.filter((item) => item.borrowerId === req.user!.id);
  const userRepayments = repayments.filter((item) => item.borrowerId === req.user!.id);
  const disbursementAccount = disbursementAccounts.find((item) => item.borrowerId === req.user!.id) ?? null;
  // Urgent-attention flag: a loan's disbursement is blocked on the borrower's
  // bank account (provider rejected it, or the admin requested an update).
  const accountUpdateLoans = userLoans
    .filter((loan) => loan.disbursementAccountNeedsUpdate === true)
    .map((loan) => ({ loanId: loan.id, applicationId: loan.applicationId, requestedAt: loan.disbursementAccountRequestedAt ?? null }));
  // Loan eligibility: a borrower with a submitted application or an
  // outstanding loan cannot request another loan until it is fully repaid.
  const openApplication = userApplications.find((item) => ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED"].includes(String(item.status)));
  const activeLoan = userLoans.find((item) => !["REPAID", "CANCELLED", "WRITTEN_OFF"].includes(item.status));
  const loanEligibility = openApplication || activeLoan
    ? {
        canApply: false,
        reason: openApplication
          ? "You already have a loan application under review. You can apply for a new loan once it is completed and your current loan is fully repaid."
          : "You have an active loan. You can apply for a new loan once your current loan is fully repaid.",
        activeApplicationId: openApplication?.applicationId ?? null,
        activeApplicationStatus: openApplication?.status ?? null,
        activeLoanId: activeLoan?.id ?? null,
        activeLoanStatus: activeLoan?.status ?? null,
      }
    : { canApply: true, reason: null as string | null, activeApplicationId: null as string | null, activeApplicationStatus: null as string | null, activeLoanId: null as string | null, activeLoanStatus: null as string | null };
  // Decorate every application/loan with resolved product fields so the UI can
  // always render loan information (name, interest, fees, range) — even for
  // applications created before products were linked, or whose product was
  // later renamed/deactivated. Never an empty product block.
  res.json({
    ok: true,
    applications: userApplications.map((item) => ({ ...item, ...applicationProductPayload(item) })),
    loans: userLoans.map((item) => ({ ...item, ...applicationProductPayload({
      loanProductId: item.loanProductId,
      applicantType: userApplications.find((a) => a.id === item.applicationId)?.applicantType,
      amountNaira: item.principalNaira,
      productSnapshot: item.productSnapshot,
      customerSnapshot: userApplications.find((a) => a.id === item.applicationId)?.customerSnapshot,
    }) })),
    repayments: userRepayments,
    disbursementAccount,
    accountUpdateRequested: accountUpdateLoans.length > 0,
    accountUpdateLoans,
    loanEligibility,
  });
});

/**
 * Reapply prefill — one endpoint that returns EVERYTHING the customer's next
 * loan application should start pre-filled with, merged server-side:
 *   1. Every previous loan application's customerSnapshot, oldest → newest
 *      (newest values win, so the last application's answers are authoritative)
 *   2. The account profile (fullName, email, phone, dateOfBirth)
 *   3. The verified KYC case (FULL unmasked BVN/NIN from the raw store win
 *      over typed-in application values; masked display leftovers are stripped)
 *   4. The saved disbursement account (admin-verified payout account wins)
 * The frontend fills every still-empty wizard field from this payload — a
 * returning customer must never have to re-type information we already hold.
 */
router.get("/borrower/applications/reapply-prefill", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const shallowMerge = (layers: Array<Record<string, unknown> | undefined>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const layer of layers) {
      if (!layer || typeof layer !== "object" || Array.isArray(layer)) continue;
      for (const [key, value] of Object.entries(layer)) {
        if (value == null) continue;
        if (typeof value === "string" && !value.trim()) continue;
        if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 0) continue;
        out[key] = value;
      }
    }
    return out;
  };

  const apps = loanApplications
    .filter((item) => item.borrowerId === req.user!.id && item.status !== "DRAFT" && item.status !== "IN_PROGRESS")
    .sort((a, b) =>
      String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? "").localeCompare(
        String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "")
      )
    );
  const snapshots = apps.map((app) => (app.customerSnapshot ?? {}) as Record<string, unknown>);

  const user = users.find((item) => item.id === req.user!.id);
  const kyc = kycCases.find((item) => item.userId === req.user!.id);
  const savedDisbursement = disbursementAccounts
    .filter((item) => item.borrowerId === req.user!.id)
    .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
    .find((item) => item.status === "ACTIVE") ??
    disbursementAccounts.filter((item) => item.borrowerId === req.user!.id).slice(-1)[0];

  const personalInfoLayers: Array<Record<string, unknown> | undefined> = snapshots.map((s) => s.personalInfo as Record<string, unknown> | undefined);
  if (user) {
    personalInfoLayers.push({
      fullName: user.fullName,
      email: user.email,
      phone: user.phone,
      dateOfBirth: user.dateOfBirth ?? "",
    });
  }
  const disbursementLayers: Array<Record<string, unknown> | undefined> = [
    ...snapshots.map((s) => s.disbursementAccount as Record<string, unknown> | undefined),
    ...(savedDisbursement
      ? [{
          accountName: savedDisbursement.accountName ?? "",
          bankName: savedDisbursement.bankName ?? "",
          bankCode: savedDisbursement.bankCode ?? "",
          accountNumber: savedDisbursement.accountNumber ?? "",
        }]
      : []),
  ];
  // UNMASKED POOLING: masked identity leftovers ("***-***-1234") stored in
  // old snapshots are stripped so they can never win the merge and leak into
  // the wizard; the authoritative FULL BVN/NIN resolved from the KYC raw
  // store (self-healed on read) is layered last so it always wins.
  const unmaskKycLayer = (layer: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    if (!layer || typeof layer !== "object" || Array.isArray(layer)) return undefined;
    const clean = { ...layer };
    for (const key of ["bvn", "nin"] as const) {
      const value = clean[key];
      if (typeof value === "string" && value.trim() && !/^\d{11}$/.test(value.trim())) delete clean[key];
    }
    return Object.keys(clean).length ? clean : undefined;
  };
  backfillIdentityNumbers(req.user!.id);
  const pooledBvn = resolveFullBvn(req.user!.id);
  const pooledNin = resolveFullNin(req.user!.id);
  const kycLayers: Array<Record<string, unknown> | undefined> = [
    ...snapshots.map((s) => unmaskKycLayer(s.kyc as Record<string, unknown> | undefined)),
    ...(kyc
      ? [{
          ...(pooledBvn ? { bvn: pooledBvn } : {}),
          ...(pooledNin ? { nin: pooledNin } : {}),
          bvnVerified: kyc.checklist.bvn === true,
          ninVerified: kyc.checklist.nin === true,
          livenessVerified: kyc.checklist.liveness === true,
          ...(kyc.verifiedDetails ? { verifiedDetails: kyc.verifiedDetails } : {}),
          ...(kyc.identityPhotoUrl ? { identityPhotoUrl: kyc.identityPhotoUrl } : {}),
        }]
      : []),
  ];

  const prefill = {
    personalInfo: Object.keys(shallowMerge(personalInfoLayers)).length ? shallowMerge(personalInfoLayers) : null,
    disbursementAccount: Object.keys(shallowMerge(disbursementLayers)).length ? shallowMerge(disbursementLayers) : null,
    personalFinancial: snapshots.map((s) => s.personalFinancial as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.personalFinancial as Record<string, unknown> | undefined)) : null,
    businessInfo: snapshots.map((s) => s.businessInfo as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.businessInfo as Record<string, unknown> | undefined)) : null,
    businessRep: snapshots.map((s) => s.businessRep as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.businessRep as Record<string, unknown> | undefined)) : null,
    businessFinancial: snapshots.map((s) => s.businessFinancial as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.businessFinancial as Record<string, unknown> | undefined)) : null,
    kyc: Object.keys(shallowMerge(kycLayers)).length ? shallowMerge(kycLayers) : null,
    collateral: snapshots.map((s) => s.collateral as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.collateral as Record<string, unknown> | undefined)) : null,
    witness: snapshots.map((s) => s.witness as Record<string, unknown> | undefined).some((l) => l && Object.keys(l).length) ? shallowMerge(snapshots.map((s) => s.witness as Record<string, unknown> | undefined)) : null,
    loanRequest: (() => {
      const loanLayers = snapshots.map((s) => s.loanRequest as Record<string, unknown> | undefined);
      const merged = shallowMerge(loanLayers);
      return Object.keys(merged).length ? merged : null;
    })(),
  };

  const latest = apps.length > 0 ? apps[apps.length - 1] : null;
  res.json({
    ok: true,
    prefill,
    meta: {
      hasPreviousApplication: apps.length > 0,
      previousApplicationCount: apps.length,
      sourceApplicationId: latest?.applicationId ?? latest?.id ?? null,
      sources: {
        applicationSnapshots: snapshots.length,
        profile: Boolean(user),
        kycCase: Boolean(kyc),
        disbursementAccount: Boolean(savedDisbursement),
      },
    },
  });
});

/**
 * Build the borrower-facing product catalog payload.
 *
 * Contract (production incident 2026-09: endpoint returned `products: []`):
 *   1. The list is never empty while ANY product exists — if every product is
 *      inactive we serve the full catalog flagged with ALL_PRODUCTS_INACTIVE_FALLBACK
 *      instead of bricking the application funnel (the admin UI shows a matching
 *      warning + one-click "Activate all").
 *   2. `programType` is stamped per product so the borrower flow renders loan
 *      information STRICTLY for the product type the customer selected.
 */
export function buildBorrowerProductCatalog(): {
  products: Array<(typeof loanProducts)[number] & { programType: "PERSONAL" | "BUSINESS" | "BOTH" | null }>;
  activeCount: number;
  catalogNotice: string | null;
} {
  const active = loanProducts.filter((p) => p.isActive);
  const allInactive = active.length === 0 && loanProducts.length > 0;
  const payload = allInactive ? loanProducts : active;
  return {
    products: payload.map((p) => ({ ...p, programType: classifyLoanProductType(p) })),
    activeCount: active.length,
    catalogNotice: allInactive ? "ALL_PRODUCTS_INACTIVE_FALLBACK" : null,
  };
}

/**
 * Resolve the SINGLE authoritative product for one borrower application flow
 * (PERSONAL or BUSINESS). The borrower's loan request screen calls the catalog
 * endpoint with `?type=PERSONAL|BUSINESS` and renders EXACTLY the returned
 * product — limits, interest, fees and grace period all come from this one row.
 *
 * Resolution order (deterministic, never empty while the catalog exists):
 *   1. Highest match score among ACTIVE products:
 *      3 = explicit flow match (programType classification / name keyword),
 *      2 = BOTH (single-product platform), 1 = unclassified.
 *      Ties: cheapest first (compareProductsByRange), then most recently
 *      updated — mirroring the frontend's deterministic fallback.
 *   2. For BUSINESS, when the top candidate is UNCLASSIFIED (score 1) and
 *      another candidate exists, the SECOND candidate is served: PERSONAL
 *      claims the cheapest unclassified product first (frontend pass-2
 *      mirror), so the two flows split the catalog instead of colliding.
 *   3. If NO product is active (admin deactivated everything) fall back to the
 *      FULL catalog so the funnel keeps working — the caller flags this via
 *      `fromInactiveFallback` so the response carries the catalogNotice.
 */
export function resolveBorrowerProductForFlow(type: "PERSONAL" | "BUSINESS"): {
  product: LoanProductRow | null;
  fromInactiveFallback: boolean;
} {
  const scoreFor = (product: LoanProductRow): number => {
    const classified = classifyLoanProductType(product);
    if (classified === type) return 3;
    if (classified === "BOTH") return 2;
    return productMatchesApplicantType(product, type) ? 2 : 1;
  };
  const rankPool = (pool: LoanProductRow[]): LoanProductRow[] =>
    pool
      .slice()
      .sort((a, b) => {
        const scoreDiff = scoreFor(b) - scoreFor(a);
        if (scoreDiff !== 0) return scoreDiff;
        const rangeDiff = compareProductsByRange(a, b);
        if (rangeDiff !== 0) return rangeDiff;
        return String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""));
      });
  const pickForType = (pool: LoanProductRow[]): LoanProductRow | null => {
    if (pool.length === 0) return null;
    const ranked = rankPool(pool);
    if (type === "BUSINESS" && ranked.length > 1 && scoreFor(ranked[0]) === 1) {
      return ranked[1];
    }
    return ranked[0];
  };

  const active = loanProducts.filter((p) => p.isActive);
  const fromActive = pickForType(active);
  if (fromActive) return { product: fromActive, fromInactiveFallback: false };
  return { product: pickForType(loanProducts), fromInactiveFallback: loanProducts.length > 0 };
}

function loanProductPayload(product: LoanProductRow) {
  return { ...product, programType: classifyLoanProductType(product) };
}

router.get("/borrower/loan-products", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  // Self-heal first: legacy snapshots could contain duplicated rows (same id /
  // same name). Borrowers must ONLY ever see the admin-configured products.
  if (normalizeLoanProducts()) {
    console.warn("[routes] borrower/loan-products removed duplicated product rows from the in-memory catalog");
    void persistStore().catch(() => undefined);
    void purgeGhostCatalogRows();
  }
  // Hard guarantee: a partial boot (DB hiccup during hydration) must never
  // leave a logged-in borrower with an empty catalog for the life of the
  // process — reload straight from Postgres, then fall back to seed defaults.
  if (loanProducts.length === 0) {
    await ensureLoanProductsLoaded();
    if (normalizeLoanProducts()) void persistStore().catch(() => undefined);
  }

  // Flow-scoped fetch (?type=PERSONAL|BUSINESS): the borrower loan request
  // screen renders loan information for EXACTLY ONE product — the one the
  // backend resolves for the application type the customer selected. This
  // keeps limits, interest, fees and grace period strictly per product type.
  const typeParam = typeof req.query.type === "string" ? req.query.type.trim().toUpperCase() : "";
  const productIdParam = typeof req.query.productId === "string" ? req.query.productId.trim() : "";

  if (productIdParam) {
    const product = loanProducts.find((p) => p.id === productIdParam);
    if (!product) {
      return res.status(404).json({ ok: false, error: "Loan product not found" });
    }
    return res.json({
      ok: true,
      products: [loanProductPayload(product)],
      activeCount: loanProducts.filter((p) => p.isActive).length,
      catalogNotice: product.isActive ? null : "ALL_PRODUCTS_INACTIVE_FALLBACK",
    });
  }

  if (typeParam === "PERSONAL" || typeParam === "BUSINESS") {
    const { product, fromInactiveFallback } = resolveBorrowerProductForFlow(typeParam);
    if (!product) {
      return res.json({ ok: true, products: [], activeCount: 0, catalogNotice: "EMPTY_CATALOG" });
    }
    if (fromInactiveFallback) {
      console.warn("[routes] borrower/loan-products?type=" + typeParam + ": NO active loan products — serving the best-match catalog product so the application flow is not bricked (admin should re-activate a product)");
    }
    return res.json({
      ok: true,
      products: [loanProductPayload(product)],
      activeCount: loanProducts.filter((p) => p.isActive).length,
      catalogNotice: fromInactiveFallback ? "ALL_PRODUCTS_INACTIVE_FALLBACK" : null,
    });
  }

  // programType tells the borrower flow EXPLICITLY which application type a
  // product drives, so loan information never renders empty when product names
  // no longer contain the "personal"/"business" keyword.
  const catalog = buildBorrowerProductCatalog();
  if (catalog.catalogNotice) {
    console.warn("[routes] borrower/loan-products: NO active loan products — serving the full catalog so the application flow is not bricked (admin should re-activate a product)");
  }
  res.json({ ok: true, ...catalog });
});

// Application statuses where the loan lifecycle has materially ended. A draft
// pointing at such an application is stale junk: resuming it would reuse the
// OLD application ID on the customer's next loan request.
const TERMINAL_APPLICATION_STATUSES = ["REPAID", "CANCELLED", "WRITTEN_OFF"];

router.get("/borrower/application-draft", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const mine = applicationDrafts.filter((draft) => draft.userId === req.user!.id);
  // Self-heal: drop drafts whose application already reached a terminal state
  // (repaid / cancelled / written off). Returning them would resurrect the
  // old application for a customer who is starting a NEW loan request.
  const staleIds = new Set(
    mine
      .filter((draft) => {
        const application = loanApplications.find(
          (item) => item.applicationId === draft.applicationId || item.id === draft.applicationId,
        );
        return application ? TERMINAL_APPLICATION_STATUSES.includes(String(application.status)) : false;
      })
      .map((draft) => draft.id),
  );
  if (staleIds.size > 0) {
    for (let index = applicationDrafts.length - 1; index >= 0; index -= 1) {
      if (staleIds.has(applicationDrafts[index].id)) applicationDrafts.splice(index, 1);
    }
    void persistStore().catch(() => undefined);
  }
  const drafts = mine
    .filter((draft) => !staleIds.has(draft.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json({ ok: true, draft: drafts[0] ?? null });
});

router.put("/borrower/application-draft", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const parsed = z.object({
    applicationId: z.string().min(1),
    applicantType: z.enum(["PERSONAL", "BUSINESS"]),
    data: z.record(z.unknown()),
    lastSectionIndex: z.number().int().min(0),
    updatedAt: z.string().datetime(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const now = new Date().toISOString();
  const existing = applicationDrafts.find((draft) => draft.userId === req.user!.id && draft.applicationId === parsed.data.applicationId);
  if (existing) {
    if (new Date(existing.updatedAt).getTime() > new Date(parsed.data.updatedAt).getTime()) {
      res.json({ ok: true, draft: existing });
      return;
    }
    existing.applicantType = parsed.data.applicantType;
    existing.data = compactApplicationPayload(parsed.data.data);
    existing.lastSectionIndex = parsed.data.lastSectionIndex;
    existing.updatedAt = parsed.data.updatedAt;
    if (!await persistMutation(res)) return;
    res.json({ ok: true, draft: existing });
    return;
  }
  const draft = { id: randomUUID(), userId: req.user!.id, ...parsed.data, data: compactApplicationPayload(parsed.data.data), createdAt: now };
  applicationDrafts.push(draft);
  if (!await persistMutation(res)) return;
  res.status(201).json({ ok: true, draft });
});

router.delete("/borrower/application-draft/:applicationId", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const index = applicationDrafts.findIndex((draft) => draft.userId === req.user!.id && draft.applicationId === req.params.applicationId);
  if (index >= 0) applicationDrafts.splice(index, 1);
  res.json({ ok: true });
});

router.post("/borrower/applications", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  try {
    const parsed = loanApplicationSchema.safeParse(req.body);
    if (!parsed.success) {
      // Surface a single readable message — the frontend shows body.error verbatim.
      const flat = parsed.error.flatten();
      const accountMissing = Array.isArray(flat.fieldErrors?.disbursementAccount) && flat.fieldErrors!.disbursementAccount.length > 0;
      let message: string;
      if (accountMissing) {
        message = "A complete disbursement account (verified account name, 10-digit account number and bank) is required to submit your loan application — this is where your loan will be paid.";
      } else {
        const firstFieldError = Object.values(flat.fieldErrors ?? {}).flat()[0];
        message = typeof firstFieldError === "string"
          ? firstFieldError
          : (flat.formErrors[0] || "Some required information is missing or invalid. Please review your application and try again.");
      }
      res.status(400).json({ ok: false, error: message, details: flat });
      return;
    }
    const input = { ...parsed.data, ...compactApplicationPayload(parsed.data) };
    if (input.applicationId) {
      const existingApplication = loanApplications.find((item) => item.applicationId === input.applicationId);
      if (existingApplication && existingApplication.borrowerId !== req.user!.id) {
        res.status(409).json({ ok: false, error: "That application reference ID is already in use." });
        return;
      }
      if (existingApplication && !TERMINAL_APPLICATION_STATUSES.includes(String(existingApplication.status))) {
        const reconciled = synchronizeLoanApplicationStatus(existingApplication);
        if (reconciled) await persistStore().catch(() => undefined);
        res.status(200).json({ ok: true, application: existingApplication, duplicate: true });
        return;
      }
      if (existingApplication) {
        // The old application reached a terminal state (REPAID / CANCELLED /
        // WRITTEN_OFF). The customer is requesting a NEW loan — it must get a
        // FRESH application ID and a brand-new application record, never
        // inherit the finished one.
        input.applicationId = randomUUID();
      }
    }
    let dbBorrowing: boolean | null = null;
    try {
      dbBorrowing = await dbHasUnresolvedBorrowing(req.user!.id);
    } catch (_e) {
      console.warn(`[routes] dbHasUnresolvedBorrowing failed user=${req.user!.id}, falling back to in-memory`);
      dbBorrowing = null;
    }
    const memBorrowing = hasUnresolvedBorrowing(req.user!.id);
    if (dbBorrowing !== null && dbBorrowing !== memBorrowing) {
      console.warn(
        `[store_reconciliation_warning] hasUnresolvedBorrowing diverged user=${req.user!.id}: DB=${dbBorrowing} in-memory=${memBorrowing}. Trusting DB truth.`
      );
      auditLogs.push({
        id: randomUUID(),
        userId: req.user!.id,
        action: "store_reconciliation_warning",
        resourceType: "BORROWING",
        resourceId: null as unknown as undefined,
        metadata: { dbBorrowing, memBorrowing, reason: "application_submit_gate" },
        ipAddress: req.ip,
        userAgent: req.get("user-agent") ?? undefined,
        createdAt: new Date().toISOString(),
      });
    }
    const unresolvedBorrowing = dbBorrowing !== null ? dbBorrowing : memBorrowing;
    if (unresolvedBorrowing) {
      res.status(409).json({ ok: false, error: "You cannot apply for another loan until your current loan is fully repaid." });
      return;
    }
    const kyc = findOrCreateKycCase(req.user!.id);
    // Self-heal legacy masked/missing identity columns from the raw store
    // BEFORE the mandatory-BVN gate so genuinely-verified customers pass.
    backfillIdentityNumbers(req.user!.id);
    // BVN is MANDATORY: the checklist flag alone is not enough — a full
    // 11-digit BVN must actually be on file (the client can set checklist
    // flags, but the bureau pipeline requires the real number).
    if (!kyc.checklist.bvn || !kyc.checklist.nin || !kyc.checklist.liveness || !/^\d{11}$/.test(kyc.bvn ?? "")) {
      res.status(409).json({ ok: false, error: "BVN, NIN, and liveness verification must be completed before submitting a loan application. A verified 11-digit BVN is mandatory." });
      return;
    }
    const user = users.find((item) => item.id === req.user!.id);
    recordConsent(req.user!.id, "CREDIT_REPORT");

    const now = new Date().toISOString();

    let latestExternalCredit = creditReports
      .filter((item) => item.userId === req.user!.id && item.status === "RECEIVED" && item.score != null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    // Kick off the credit bureau fetch in the background so loan submission
    // is not blocked waiting on Prembly. Business customers run the
    // COMMERCIAL (Business) Advance bureau product with the RC number +
    // company name from their application/profile; customers without an RC
    // number fall back to the consumer product via their verified BVN/NIN.
    // The report row exists immediately as PENDING (visible on the admin
    // card + borrower credit page) and the provider call completes in the
    // background; the creditReconciliation cron retries anything left
    // PENDING.
    const bureauStart: CreditBureauCheckOutcome = await startCreditBureauCheck(req.user!.id, {
      source: "SUBMISSION",
      snapshot: { businessInfo: input.businessInfo, personalInfo: input.personalInfo, kyc: input.kyc },
    });
    // A PENDING row must not REPLACE an already-RECEIVED scored report for
    // scoring purposes — the background completion recomputes the internal
    // score with the fresh bureau data anyway.
    const currentExternalCredit: CreditReport | null = bureauStart.ok && !latestExternalCredit ? bureauStart.report : null;
    if (currentExternalCredit) latestExternalCredit = currentExternalCredit;

    const customerSnapshot = {
      userId: req.user!.id,
      fullName: user?.fullName,
      email: user?.email,
      phone: user?.phone,
      personalInfo: input.personalInfo,
      businessInfo: input.businessInfo,
      businessRep: input.businessRep,
      personalFinancial: input.personalFinancial,
      businessFinancial: input.businessFinancial,
      loanRequest: input.loanRequest,
      calculation: input.calculation,
      kyc: input.kyc,
      disbursementAccount: { ...input.disbursementAccount, institution: "VELO" },
      collateral: input.collateral,
      witness: input.witness,
      documents: input.documents,
    };
    const internalCredit = calculateCreditScore({
      completedLoans: loans.filter((item) => item.borrowerId === req.user!.id && item.status === "REPAID").length,
      onTimePayments: repayments.filter(
        (item) => item.borrowerId === req.user!.id && item.status === "SUCCESSFUL" && item.onTime === true
      ).length,
      latePayments: repayments.filter(
        (item) => item.borrowerId === req.user!.id && item.status === "SUCCESSFUL" && item.onTime === false
      ).length,
      defaultedLoans: loans.filter((item) => item.borrowerId === req.user!.id && item.status === "DEFAULTED").length,
      outstandingMinor: loans.reduce(
        (sum, item) => sum + Math.round(Number(item.outstandingNaira ?? 0) * 100),
        0
      ),
      totalBorrowedMinor: loans.reduce(
        (sum, item) => sum + Math.round(Number(item.principalNaira ?? 0) * 100),
        0
      ),
      kycVerified: user?.kycStatus === "VERIFIED",
      bureauScore: latestExternalCredit?.score ?? null,
    });
    const externalCreditReport: Record<string, unknown> = latestExternalCredit
      ? {
          provider: latestExternalCredit.provider,
          status: latestExternalCredit.status,
          score: latestExternalCredit.score ?? null,
          reportReference: latestExternalCredit.reportReference ?? null,
          requestedAt: latestExternalCredit.requestedAt ?? null,
          consentGrantedAt: latestExternalCredit.consentGrantedAt ?? null,
          pulledAt: latestExternalCredit.createdAt,
          normalizedFields: latestExternalCredit.normalizedFields,
          redactedRaw: latestExternalCredit.redactedRaw,
        }
      : {
          provider: "prembly" as const,
          status: "PENDING" as const,
          score: null,
          reportReference: null,
          requestedAt: now,
          consentGrantedAt: now,
          consentRequired: true,
          reason: "External credit bureau is being pulled in the background at submission.",
        };
    const amountNaira = input.loanRequest?.amount ?? 0;
    const eligibility = evaluateLoanEligibility(internalCredit, amountNaira);
    creditScores.push({
      id: randomUUID(),
      userId: req.user!.id,
      version: internalCredit.version,
      score: internalCredit.score,
      band: internalCredit.band,
      factors: internalCredit.factors,
      createdAt: internalCredit.calculatedAt,
    });
    const application: (typeof loanApplications)[number] = seedLoanStageStatuses({
      id: randomUUID(),
      applicationId: input.applicationId ?? randomUUID(),
      borrowerId: req.user!.id,
      applicantType: input.applicantType,
      customerSnapshot,
      creditReportSnapshot: { internal: internalCredit, external: externalCreditReport },
      amountNaira,
      tenureDays: input.loanRequest?.tenure,
      // Link the application to the product that governs it RIGHT NOW and
      // capture its terms — later renames/re-pricing cannot orphan the info.
      ...(() => {
        const product = resolveLoanProductForApplication({
          applicantType: input.applicantType,
          amountNaira,
        });
        return product
          ? { loanProductId: product.id, productSnapshot: captureProductSnapshot(product) ?? undefined }
          : {};
      })(),
      status: "UNDER_REVIEW",
      stageStatuses: { profile: "COMPLETED", employment: "COMPLETED", bvn_nin: "COMPLETED", address: "COMPLETED", liveness: "COMPLETED", loan_details: "COMPLETED", documents: "COMPLETED", disbursement_account: "COMPLETED", consent: "COMPLETED", credit_review: "PENDING_REVIEW", risk_review: "PENDING_REVIEW", approval: "PENDING_REVIEW" },
      stageRejectionNotes: {},
      systemDecision: eligibility as unknown as Record<string, unknown>,
      manualDecision: "PENDING",
      disbursementInstitution: "VELO",
      disbursementAccount: customerSnapshot.disbursementAccount,
      createdAt: now,
      updatedAt: now,
      submittedAt: now,
    });
    loanApplications.push(application);
    // If the bureau report lands AFTER the application row exists (fast
    // provider, or the background call finished before this row was pushed),
    // sync the freshly created application's credit snapshot so the admin
    // card never sticks on PENDING while the report has actually resolved.
    // (Slow providers are covered by executeCreditBureauCheck's own
    // syncApplicationCreditSnapshots, which runs once the row exists.)
    if (bureauStart.ok) {
      void bureauStart.completion
        .then(() => {
          const report = bureauStart.report;
          if (report.status !== "RECEIVED") return;
          application.creditReportSnapshot = {
            ...(application.creditReportSnapshot ?? {}),
            external: externalReportPayload(report),
            internal: recomputeInternalCreditScore(req.user!.id, report.score ?? null) ?? (application.creditReportSnapshot as { internal?: unknown } | undefined)?.internal,
          };
          application.updatedAt = new Date().toISOString();
          void persistStore().catch(() => undefined);
        })
        .catch(() => undefined);
    }
    creditHistory.push({
      id: randomUUID(),
      userId: req.user!.id,
      loanId: undefined,
      eventType: "LOAN_APPLIED",
      detail: `Application ${application.applicationId} submitted`,
      occurredAt: now,
      createdAt: now,
    });
    // One-shot submission path: pull the KYC details + documents captured in
    // the application into the customer's standalone KYC case (same contract
    // as the draft /submit endpoint below).
    let kycPulled: { createdDocuments: number; checklistUpdated: boolean } | null = null;
    let kycAutoSubmitted = false;
    try {
      const kycBeforePull = findOrCreateKycCase(req.user!.id);
      const kycWasAlreadySubmitted = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVIEWING"].includes(kycBeforePull.status);
      kycPulled = pullKycFromSubmittedApplication(application, req.user!.id);
      const kycAfter = findOrCreateKycCase(req.user!.id);
      kycAutoSubmitted = kycAfter.status === "PENDING_VERIFICATION" && !kycWasAlreadySubmitted;
      if (kycAutoSubmitted && user?.email) {
        const template = kycSubmittedEmail({ name: user.fullName, source: "LOAN_APPLICATION" });
        void sendEmail({ to: user.email, name: user.fullName, ...template }).catch(() => undefined);
      }
    } catch (kycError) {
      console.warn(`[routes] KYC auto-pull failed on application creation user=${req.user!.id}:`, kycError);
    }
    if (!(await persistMutation(res))) return;
    res.status(201).json({ ok: true, application, kycPulled, kycAutoSubmitted });
  } catch (_e) {
    console.error("[routes] unexpected POST /borrower/applications error:", _e);
    if (res.headersSent) return;
    const message = _e instanceof Error ? _e.message : "Unexpected error processing your loan application. Please try again in a few minutes.";
    res.status(500).json({ ok: false, error: message });
  }
});

router.patch("/borrower/applications/:id", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  try {
    const application = loanApplications.find((a) => (a.id === req.params.id || a.applicationId === req.params.id) && a.borrowerId === req.user?.id);
    if (!application) {
      res.status(404).json({ ok: false, error: "Application not found" });
      return;
    }
    const reconciled = synchronizeLoanApplicationStatus(application);
    if (reconciled) await persistStore().catch(() => undefined);
    if (isLockedLoanApplication(application)) {
      res.status(409).json({ ok: false, error: `Application ${application.applicationId} is locked because its loan is ${application.status}.`, application });
      return;
    }
    // REJECTED applications are EDITABLE: the customer must be able to re-access
    // the loan, fix the failed information and resubmit. MORE_INFORMATION_REQUIRED
    // stays editable as before.
    if (!["DRAFT", "IN_PROGRESS", "MORE_INFORMATION_REQUIRED", "REJECTED"].includes(application.status)) {
      res.status(409).json({ ok: false, error: `Application ${application.status} cannot be modified` });
      return;
    }
    const schema = z.object({
      personalInfo: z.record(z.unknown()).optional(),
      businessInfo: z.record(z.unknown()).optional(),
      businessRep: z.record(z.unknown()).optional(),
      personalFinancial: z.record(z.unknown()).optional(),
      businessFinancial: z.record(z.unknown()).optional(),
      kyc: z.record(z.unknown()).optional(),
      disbursementAccount: z.record(z.unknown()).optional(),
      loanRequest: z
        .object({ amount: z.number().positive(), tenure: z.number().int().positive(), purpose: z.string().min(1) })
        .optional(),
      collateral: z.record(z.unknown()).optional(),
      documents: z.record(z.unknown()).optional(),
      witness: z.record(z.unknown()).optional(),
      calculation: z.record(z.unknown()).nullable().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    const snapshot = application.customerSnapshot ?? {};
    if (parsed.data.personalInfo) Object.assign(snapshot, { personalInfo: parsed.data.personalInfo });
    if (parsed.data.businessInfo) Object.assign(snapshot, { businessInfo: parsed.data.businessInfo });
    if (parsed.data.businessRep) Object.assign(snapshot, { businessRep: parsed.data.businessRep });
    if (parsed.data.personalFinancial) Object.assign(snapshot, { personalFinancial: parsed.data.personalFinancial });
    if (parsed.data.businessFinancial) Object.assign(snapshot, { businessFinancial: parsed.data.businessFinancial });
    if (parsed.data.disbursementAccount) {
      const account = { ...parsed.data.disbursementAccount, institution: "VELO" };
      Object.assign(snapshot, { disbursementAccount: account });
      application.disbursementAccount = account;
    }
    if (parsed.data.loanRequest) {
      Object.assign(snapshot, { loanRequest: parsed.data.loanRequest });
      application.amountNaira = parsed.data.loanRequest.amount;
      application.tenureDays = parsed.data.loanRequest.tenure;
      // Re-stamp the product link + terms snapshot so an ongoing application
      // (draft resumed weeks later, limits changed in between) always keeps a
      // correct, renderable set of loan information.
      const product = resolveLoanProductForApplication(application);
      if (product) {
        application.loanProductId = product.id;
        const freshSnapshot = captureProductSnapshot(product);
        if (freshSnapshot) application.productSnapshot = freshSnapshot;
      }
    }
    if (parsed.data.collateral) Object.assign(snapshot, { collateral: parsed.data.collateral });
    if (parsed.data.kyc) {
      Object.assign(snapshot, { kyc: parsed.data.kyc });
      const kyc = findOrCreateKycCase(req.user!.id);
      const anyKyc = parsed.data.kyc as Record<string, unknown>;
      if (typeof anyKyc.bvn === "string" && /^\d{11}$/.test(anyKyc.bvn)) {
        kyc.bvn = anyKyc.bvn;
        kyc.checklist.bvn = true;
      }
      if (typeof anyKyc.nin === "string" && /^\d{11}$/.test(anyKyc.nin)) {
        kyc.nin = anyKyc.nin;
        kyc.checklist.nin = true;
      }
      if (typeof anyKyc.identificationNumber === "string" && typeof anyKyc.identificationType === "string") {
        if (anyKyc.identificationType === "BVN" && /^\d{11}$/.test(anyKyc.identificationNumber)) {
          kyc.bvn = anyKyc.identificationNumber;
          kyc.checklist.bvn = true;
        } else if (anyKyc.identificationType === "NIN" && /^\d{11}$/.test(anyKyc.identificationNumber)) {
          kyc.nin = anyKyc.identificationNumber;
          kyc.checklist.nin = true;
        }
      }
      markKycChecklistComplete(req.user!.id);
    }
    if (parsed.data.witness) Object.assign(snapshot, { witness: parsed.data.witness });
    if (parsed.data.calculation !== undefined) Object.assign(snapshot, { calculation: parsed.data.calculation });
    if (parsed.data.documents) {
      Object.assign(snapshot, { documents: parsed.data.documents });
    }
    application.customerSnapshot = snapshot;
    application.updatedAt = new Date().toISOString();
    if (!(await persistMutation(res))) return;
    res.json({ ok: true, application });
  } catch (_e) {
    console.error("[routes] unexpected PATCH /borrower/applications/:id error:", _e);
    if (res.headersSent) return;
    const message = _e instanceof Error ? _e.message : "Unexpected error updating your loan application. Please try again in a few minutes.";
    res.status(500).json({ ok: false, error: message });
  }
});

router.post("/borrower/applications/:id/submit", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  try {
    const application = loanApplications.find((a) => (a.id === req.params.id || a.applicationId === req.params.id) && a.borrowerId === req.user?.id);
    if (!application) {
      res.status(404).json({ ok: false, error: "Application not found" });
      return;
    }
    const kyc = findOrCreateKycCase(req.user!.id);
    // Self-heal legacy masked/missing identity columns, then enforce the
    // mandatory full 11-digit BVN (the checklist flag alone can be set by
    // the client — the bureau pipeline needs the real number on file).
    backfillIdentityNumbers(req.user!.id);
    if (!kyc.checklist.bvn || !kyc.checklist.nin || !kyc.checklist.liveness || !/^\d{11}$/.test(kyc.bvn ?? "")) {
      res.status(409).json({ ok: false, error: "BVN, NIN, and liveness verification must be completed before submitting a loan application. A verified 11-digit BVN is mandatory." });
      return;
    }
    let unresolvedBorrowing = false;
    try {
      unresolvedBorrowing = hasUnresolvedBorrowing(req.user!.id, application.id);
    } catch (_e) {
      console.warn(`[routes] hasUnresolvedBorrowing throw in submit user=${req.user!.id}, treating as false`);
      unresolvedBorrowing = false;
    }
    if (unresolvedBorrowing) {
      res.status(409).json({ ok: false, error: "You cannot apply for another loan until your current loan is fully repaid." });
      return;
    }
    const wasSubmitted = Boolean(application.submittedAt);
    const isResubmission = application.status === "REJECTED";
    application.status = "SUBMITTED";
    application.submittedAt = new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    if (isResubmission) {
      // Resubmission after rejection: reset the ENTIRE review pipeline so the
      // loan team sees a FRESH review. The previous rejection decision, note
      // and stage rejections must not leak into the new review round.
      application.manualDecision = "PENDING";
      application.manualNote = "";
      application.approvedAt = undefined;
      application.stageRejectionNotes = {};
      application.stageStatuses = {
        profile: "COMPLETED", employment: "COMPLETED", bvn_nin: "COMPLETED", address: "COMPLETED", liveness: "COMPLETED", loan_details: "COMPLETED", documents: "COMPLETED", disbursement_account: "COMPLETED", consent: "COMPLETED", credit_review: "PENDING_REVIEW", risk_review: "PENDING_REVIEW", approval: "PENDING_REVIEW",
      };
      console.info(`[routes] application ${application.applicationId} resubmitted after rejection user=${req.user!.id}`);
    }
    // KYC auto-pull: every identity detail + document the customer provided in
    // the wizard is pulled into their standalone KYC case automatically. Items
    // that still need a human decision (proof of address, signature) surface
    // on the admin KYC dashboard, and the customer is emailed about the
    // submission. Existing VERIFIED status is never downgraded.
    let kycPulled: { createdDocuments: number; checklistUpdated: boolean } | null = null;
    let kycAutoSubmitted = false;
    try {
      const kycBeforePull = findOrCreateKycCase(req.user!.id);
      const kycWasAlreadySubmitted = ["PENDING_VERIFICATION", "VERIFIED", "REJECTED", "REVIEWING"].includes(kycBeforePull.status);
      kycPulled = pullKycFromSubmittedApplication(application, req.user!.id);
      const kycAfter = findOrCreateKycCase(req.user!.id);
      kycAutoSubmitted = kycAfter.status === "PENDING_VERIFICATION" && !kycWasAlreadySubmitted;
      if (kycAutoSubmitted) {
        const kycUser = users.find((u) => u.id === req.user!.id);
        if (kycUser?.email) {
          const template = kycSubmittedEmail({ name: kycUser.fullName, source: "LOAN_APPLICATION" });
          void sendEmail({ to: kycUser.email, name: kycUser.fullName, ...template }).catch(() => undefined);
        }
      }
    } catch (kycError) {
      console.warn(`[routes] KYC auto-pull failed on submit user=${req.user!.id}:`, kycError);
    }
    if (!(await persistMutation(res))) return;
    res.json({ ok: true, application, resubmitted: isResubmission, kycPulled, kycAutoSubmitted });
    if (!wasSubmitted) void sendLoanEmails(application, "SUBMITTED");
  } catch (_e) {
    console.error("[routes] unexpected POST /borrower/applications/:id/submit error:", _e);
    if (res.headersSent) return;
    const message = _e instanceof Error ? _e.message : "Unexpected error submitting your loan application. Please try again in a few minutes.";
    res.status(500).json({ ok: false, error: message });
  }
});

router.get("/borrower/loans", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const userLoans = indexes.loansByBorrowerId.get(req.user!.id) ?? [];
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const sorted = userLoans.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const page = sorted.slice(offset, offset + limit);
  const withSchedules = page.map((loan) => ({
    ...loan,
    // Resolved product info (name/interest/fees/range) — never empty, even for
    // loans created before products were linked or after a product was removed.
    ...applicationProductPayload({
      loanProductId: loan.loanProductId,
      applicantType: loanApplications.find((a) => a.id === loan.applicationId)?.applicantType,
      amountNaira: loan.principalNaira,
      productSnapshot: loan.productSnapshot,
      customerSnapshot: loanApplications.find((a) => a.id === loan.applicationId)?.customerSnapshot,
    }),
    schedule: indexes.loanSchedulesByLoanId.get(loan.id) ?? [],
  }));
  res.json({
    ok: true,
    loans: withSchedules,
    meta: { total: sorted.length, limit, offset, hasMore: offset + limit < sorted.length },
  });
});

router.get("/borrower/loans/:loanId", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const loan = loans.find((item) => item.id === req.params.loanId && item.borrowerId === req.user!.id);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  const application = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
  if (application && synchronizeLoanApplicationStatus(application)) await persistStore().catch(() => undefined);
  res.json({
    ok: true,
    loan: { ...loan, ...applicationProductPayload({
      loanProductId: loan.loanProductId,
      applicantType: application?.applicantType,
      amountNaira: loan.principalNaira,
      productSnapshot: loan.productSnapshot,
      customerSnapshot: application?.customerSnapshot,
    }) },
    application: application ? { ...application, ...applicationProductPayload(application) } : application,
    schedule: loanSchedules.filter((s) => s.loanId === loan.id),
    repayments: repayments.filter((r) => r.loanId === loan.id),
  });
});

router.get("/borrower/credit-history", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  res.json({
    ok: true,
    events: creditHistory.filter((item) => item.userId === req.user!.id).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
    scores: creditScores.filter((item) => item.userId === req.user!.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    reports: creditReports.filter((item) => item.userId === req.user!.id),
  });
});

router.get("/borrower/credit-score", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const userLoans = loans.filter((item) => item.borrowerId === req.user!.id);
  const userPayments = repayments.filter((item) => item.borrowerId === req.user!.id && item.status === "SUCCESSFUL");
  const latestExternalCredit = creditReports
    .filter((item) => item.userId === req.user!.id && item.status === "RECEIVED" && item.score != null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const result = calculateCreditScore({
    completedLoans: userLoans.filter((item) => item.status === "REPAID").length,
    onTimePayments: userPayments.filter((item) => item.onTime === true).length,
    latePayments: userPayments.filter((item) => item.onTime === false).length,
    defaultedLoans: userLoans.filter((item) => item.status === "DEFAULTED").length,
    outstandingMinor: userLoans.reduce(
      (sum, item) => sum + Math.round(Number(item.outstandingNaira ?? 0) * 100),
      0
    ),
    totalBorrowedMinor: userLoans.reduce(
      (sum, item) => sum + Math.round(Number(item.principalNaira ?? 0) * 100),
      0
    ),
    kycVerified: users.find((item) => item.id === req.user!.id)?.kycStatus === "VERIFIED",
    bureauScore: latestExternalCredit?.score ?? null,
  });
  res.json({ ok: true, score: result });
});

router.post("/borrower/credit-report/request", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const schema = z.object({ consent: z.boolean().refine((v) => v === true, "Consent is required") });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  // Shared bureau flow: commercial (RC + company name) first, consumer via
  // verified BVN/NIN as fallback. The report row is created immediately as
  // PENDING and the provider call runs in the background (real lookups take
  // 25-90s) — the borrower's credit page reflects the final state when it
  // lands, and the reconciliation cron self-heals anything left PENDING.
  const started = await startCreditBureauCheck(req.user!.id, { source: "BORROWER_REQUEST" });
  if (!started.ok) {
    res.status(409).json({ ok: false, error: started.message });
    return;
  }
  // Brief inline window for fast provider answers; slow ones stay PENDING.
  await Promise.race([started.completion, new Promise((resolve) => setTimeout(resolve, 3000))]);
  const report = started.report;
  res.json({
    ok: true,
    report,
    creditScore: recomputeInternalCreditScore(req.user!.id, report.status === "RECEIVED" ? report.score ?? null : null),
    message:
      report.status === "RECEIVED"
        ? "Credit report received."
        : report.status === "PENDING"
        ? "Credit report request is processing; it will complete automatically."
        : (report.normalizedFields as { reason?: string } | undefined)?.reason ?? "Credit report request could not be completed.",
  });
});

router.post("/borrower/loans/:loanId/repayments", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const loan = loans.find((item) => item.id === req.params.loanId && item.borrowerId === req.user!.id);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  if (loan.status === "REPAID" || loan.status === "CANCELLED" || loan.status === "WRITTEN_OFF") {
    res.status(400).json({ ok: false, error: `No repayment needed for a loan in ${loan.status} status` });
    return;
  }
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "amountNaira must be a positive number" });
    return;
  }
  const maxAllowed = Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? loan.principalNaira ?? 0);
  const minAllowed = 50;
  const desired = Number(parsed.data.amountNaira);
  if (maxAllowed <= 0) {
    res.status(400).json({ ok: false, error: "This loan has no outstanding balance" });
    return;
  }
  if (desired < minAllowed) {
    res.status(400).json({
      ok: false,
      error: `Minimum repayment amount is ₦${minAllowed.toLocaleString("en-NG")}`,
      minAllowedNaira: minAllowed,
      maxAllowedNaira: maxAllowed,
    });
    return;
  }
  if (desired > maxAllowed + 0.01) {
    res.status(400).json({
      ok: false,
      error: `You cannot repay more than the outstanding ₦${maxAllowed.toLocaleString("en-NG")}`,
      minAllowedNaira: minAllowed,
      maxAllowedNaira: maxAllowed,
    });
    return;
  }
  const roundedAmount = Math.round(desired * 100) / 100;
  const user = users.find((item) => item.id === req.user!.id);
  const txRef = `VELO-REPAY-${randomUUID()}`;
  const now = new Date().toISOString();
  const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
  const onTime = dueAt ? new Date(now) <= dueAt : true;
  const isFullPayoff = roundedAmount >= maxAllowed - 0.01;
  const estimatedPrincipal = Math.min(
    Number(loan.outstandingPrincipalNaira ?? loan.principalNaira ?? maxAllowed),
    roundedAmount
  );
  const estimatedInterest = Math.max(0, roundedAmount - estimatedPrincipal);
  const repayment: (typeof repayments)[number] = {
    id: randomUUID(),
    txRef,
    loanId: loan.id,
    borrowerId: req.user!.id,
    amountNaira: roundedAmount,
    currency: "NGN",
    status: "PENDING_PROVIDER_CONFIRMATION",
    onTime,
    createdAt: now,
  };
  repayments.push(repayment);
  try {
    const checkout = await initializeRepayment({
      txRef,
      amountNaira: repayment.amountNaira,
      email: user?.email ?? req.user!.email,
      phone: user?.phone ?? "",
      name: user?.fullName ?? req.user!.fullName,
      redirectUrl: `${env.API_PUBLIC_URL}/api/v1/payments/flutterwave/return`,
    });
    res.status(201).json({
      ok: true,
      repayment,
      checkout: {
        type: "flutterwave_standard_checkout",
        url: checkout.data?.link,
        link: checkout.data?.link,
        txRef,
        amountNaira: repayment.amountNaira,
        currency: repayment.currency,
      },
      repaymentContext: {
        isFullPayoff,
        minAllowedNaira: minAllowed,
        maxAllowedNaira: maxAllowed,
        outstandingNaira: maxAllowed,
        estimatedPrincipalNaira: Math.round(estimatedPrincipal * 100) / 100,
        estimatedInterestNaira: Math.round(estimatedInterest * 100) / 100,
      },
      message: isFullPayoff
        ? "Complete Flutterwave checkout to settle the full outstanding balance."
        : "Complete Flutterwave checkout to record the partial repayment.",
    });
  } catch (error) {
    repayment.status = "PROVIDER_NOT_CONFIGURED";
    console.error("[routes] Flutterwave repayment checkout failed:", error instanceof Error ? error.message : error);
    // 200 (not 503) so the client can present the friendly message instead of a
    // generic request failure; the repayment record stays for retry/verification.
    res.status(200).json({
      ok: true,
      repayment,
      checkout: null,
      message: "We couldn't start the payment checkout just now. Please try again in a moment or contact support if it persists.",
      error: error instanceof Error ? error.message : "Flutterwave unavailable",
    });
  }
});

router.get("/admin/application-drafts", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const query = String(_req.query.search ?? "").trim().toLowerCase();
  const type = String(_req.query.type ?? "").trim().toUpperCase();
  const status = String(_req.query.status ?? "").trim().toUpperCase();
  const drafts = applicationDrafts
    .map((draft) => {
      const borrower = users.find((user) => user.id === draft.userId);
      const data = draft.data as Record<string, any>;
      const totalSections = draft.applicantType === "BUSINESS" ? 9 : 8;
      const currentSection = Math.min(totalSections - 1, Math.max(0, draft.lastSectionIndex));
      return {
        applicationId: draft.applicationId,
        applicantType: draft.applicantType,
        status: data.status === "IN_PROGRESS" ? "IN_PROGRESS" : "DRAFT",
        applicantName: data.personalInfo?.fullName || data.businessInfo?.businessName || borrower?.fullName || "Borrower",
        email: data.personalInfo?.email || borrower?.email || "",
        phone: data.personalInfo?.phone || borrower?.phone || "",
        loanAmount: Number(data.loanRequest?.amount || 0),
        tenure: `${Number(data.loanRequest?.tenure || 0)} days`,
        dateCreated: draft.createdAt,
        dateUpdated: draft.updatedAt,
        currentSection,
        totalSections,
        progressPercent: Math.round(((currentSection + 1) / totalSections) * 100),
      };
    })
    .filter((draft) => !type || draft.applicantType === type)
    .filter((draft) => !status || draft.status === status)
    .filter((draft) => !query || [draft.applicationId, draft.applicantName, draft.email, draft.phone].some((value) => String(value).toLowerCase().includes(query)))
    .sort((a, b) => b.dateUpdated.localeCompare(a.dateUpdated));
  const limit = Math.max(1, Math.min(100, Number(_req.query.limit ?? 20)));
  const offset = Math.max(0, Number(_req.query.offset ?? 0));
  res.json({ ok: true, drafts: drafts.slice(offset, offset + limit), total: drafts.length });
});

// Admin: fetch the full saved draft data for a single in-progress application.
// Used by the admin loan detail page to show the borrower's saved progress
// (sections, fields) before the application has been formally submitted.
router.get("/admin/application-drafts/:applicationId", requireAuth, requireRole("ADMIN"), (req, res) => {
  const applicationId = String(req.params.applicationId ?? "").trim();
  if (!applicationId) {
    res.status(400).json({ ok: false, error: "applicationId is required" });
    return;
  }
  const draft = applicationDrafts.find((d) => d.applicationId === applicationId);
  if (!draft) {
    res.status(404).json({ ok: false, error: "Draft not found for this applicationId" });
    return;
  }
  const borrower = users.find((user) => user.id === draft.userId);
  const data = draft.data as Record<string, any>;
  const totalSections = draft.applicantType === "BUSINESS" ? 9 : 8;
  const currentSection = Math.min(totalSections - 1, Math.max(0, draft.lastSectionIndex));
  res.json({
    ok: true,
    draft: {
      applicationId: draft.applicationId,
      applicantType: draft.applicantType,
      status: data.status === "IN_PROGRESS" ? "IN_PROGRESS" : "DRAFT",
      borrower: borrower ? { id: borrower.id, fullName: borrower.fullName, email: borrower.email, phone: borrower.phone } : null,
      data,
      lastSectionIndex: draft.lastSectionIndex,
      currentSection,
      totalSections,
      progressPercent: Math.round(((currentSection + 1) / totalSections) * 100),
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
    },
  });
});

router.get("/admin/summary", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const approved = loans.filter((l) => ["APPROVED", "DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID"].includes(l.status));
  const today = new Date();
  const trends = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const day = date.toISOString().slice(0, 10);
    const createdOn = (value?: string) => value?.slice(0, 10) === day;
    return {
      date,
      applications: loanApplications.filter((item) => createdOn(item.createdAt)).length,
      disbursements: loans.filter((item) => createdOn(item.disbursedAt)).length,
      repayments: repayments.filter((item) => createdOn(item.createdAt)).length,
    };
  });
  // ===== Revenue + repayment calculations =====
  // - totalLoanDisbursed: sum of principalNaira across loans that have been
  //   disbursed (status ACTIVE/PAST_DUE/DEFAULTED/REPAID).
  // - realizedRevenue: sum of (totalRepaymentNaira - principalNaira) across
  //   REPAID loans, plus the interest portion of successful repayments on
  //   active loans. This is the revenue the platform has actually earned.
  // - awaitingRevenue: sum of (totalRepaymentNaira - principalNaira) across
  //   active loans that have not yet been repaid (expected future revenue).
  // - totalRepaid: sum of all successful repayments.
  // - repaidCount: number of loans in REPAID status.
  const disbursedLoans = loans.filter((l) => ["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID"].includes(l.status));
  const repaidLoans = loans.filter((l) => l.status === "REPAID");
  const activeLoans = loans.filter((l) => ["ACTIVE", "PAST_DUE", "DEFAULTED"].includes(l.status));
  const successfulRepayments = repayments.filter((r) => r.status === "SUCCESSFUL");
  const totalLoanDisbursed = disbursedLoans.reduce((sum, l) => sum + Number(l.principalNaira ?? 0), 0);
  const totalRepaid = successfulRepayments.reduce((sum, r) => sum + Number(r.amountNaira ?? 0), 0);
  // Revenue from repaid loans = sum of (totalRepayment - principal) for repaid loans
  const realizedRevenueFromRepaid = repaidLoans.reduce((sum, l) => {
    const total = Number(l.totalRepaymentNaira ?? 0);
    const principal = Number(l.principalNaira ?? 0);
    return sum + Math.max(0, total - principal);
  }, 0);
  // Revenue from active loans = interest portion of successful repayments
  // (approximated as totalRepayment * (interest / totalRepayment) ratio, or
  // simply the difference between repaid amount and principal paid down).
  // For simplicity, use the same formula: sum of interest allocated to date.
  const realizedRevenueFromActive = activeLoans.reduce((sum, l) => {
    const total = Number(l.totalRepaymentNaira ?? 0);
    const principal = Number(l.principalNaira ?? 0);
    const interest = Math.max(0, total - principal);
    const outstanding = Number(l.outstandingNaira ?? 0);
    const paidDown = Math.max(0, total - outstanding);
    // Pro-rate interest by the fraction paid.
    const interestFraction = total > 0 ? paidDown / total : 0;
    return sum + Math.round(interest * interestFraction);
  }, 0);
  const realizedRevenue = realizedRevenueFromRepaid + realizedRevenueFromActive;
  const awaitingRevenue = activeLoans.reduce((sum, l) => {
    const total = Number(l.totalRepaymentNaira ?? 0);
    const principal = Number(l.principalNaira ?? 0);
    const interest = Math.max(0, total - principal);
    const outstanding = Number(l.outstandingNaira ?? 0);
    const paidDown = Math.max(0, total - outstanding);
    const remainingInterest = Math.max(0, interest - (interest * (total > 0 ? paidDown / total : 0)));
    return sum + Math.round(remainingInterest);
  }, 0);
  res.json({
    ok: true,
    totals: {
      users: users.length,
      investors: users.filter((user) => user.roles.includes("INVESTOR")).length,
      borrowers: users.filter((user) => user.roles.includes("BORROWER")).length,
      kycPending: kycCases.filter((k) => ["PENDING_VERIFICATION", "IN_PROGRESS", "ACTION_REQUIRED"].includes(k.status)).length,
      kycVerified: kycCases.filter((k) => k.status === "VERIFIED").length,
      loans: loanApplications.length,
      approvedLoans: approved.length,
      disbursedPrincipal: totalLoanDisbursed,
      outstandingPrincipal: loans.reduce((sum, l) => sum + Number(l.outstandingNaira ?? 0), 0),
      investments: investments.length,
      activeInvestmentPrincipal: investments.filter((i) => i.status === "ACTIVE").reduce((s, i) => s + Number(i.amountNaira ?? 0), 0),
      pendingPayments: [...repayments, ...walletTransactions.filter((t) => t.type === "DEPOSIT")].filter((p: { status: string }) => p.status !== "SUCCESSFUL" && p.status !== "COMPLETED").length,
      pendingPayouts: payouts.filter((payout) => payout.status !== "SUCCESSFUL").length,
      failedPayouts: payouts.filter((p) => p.status === "FAILED").length,
      reconciliationItems: providerEvents.filter((e) => !(e as { processed?: boolean }).processed).length,
      // Revenue metrics (used by the admin applications table KPI strip).
      totalLoanDisbursed,
      totalRepaid,
      repaidCount: repaidLoans.length,
      realizedRevenue,
      awaitingRevenue,
    },
    trends,
    recentActivity: auditLogs.slice().sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))).slice(0, 10),
  });
});

router.get("/admin/investors", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const allInvestors = users.filter((user) => user.roles.includes("INVESTOR")).map((investor) => ({
    ...investor,
    passwordHash: undefined,
    wallet: findWallet(investor.id),
    investments: investments.filter((item) => item.investorId === investor.id),
    payouts: payouts.filter((item) => item.userId === investor.id),
    kyc: kycCases.find((k) => k.userId === investor.id),
  }));
  const page = paginate(allInvestors, _req.query as Record<string, unknown>);
  res.json({
    ok: true,
    investors: page.items,
    meta: page.meta,
  });
});

router.get("/admin/payouts", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const page = paginate(payouts, _req.query as Record<string, unknown>);
  res.json({ ok: true, payouts: page.items, meta: page.meta });
});

router.post("/admin/payouts/:payoutId/retry", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const payout = payouts.find((item) => item.id === req.params.payoutId);
  if (!payout) {
    res.status(404).json({ ok: false, error: "Payout not found" });
    return;
  }
  if (payout.status !== "FAILED") {
    res.status(409).json({ ok: false, error: "Only definitively failed payouts can be retried." });
    return;
  }
  // KYC gate: retries are still payouts — the investor's KYC must be verified.
  if (!userKycVerified(payout.userId)) {
    const investor = users.find((u) => u.id === payout.userId);
    if (investor) void notifyKycBlocked(investor, "INVESTOR_PAYOUT");
    res.status(409).json({
      ok: false,
      code: "KYC_REQUIRED",
      error: `The investor's KYC verification is not complete${investor ? ` (${investor.fullName})` : ""}. The payout cannot be retried until the investor completes identity verification.`,
    });
    return;
  }
  const account = payoutAccounts.find((item) => item.userId === payout.userId);
  if (!account) {
    res.status(400).json({ ok: false, error: "Investor payout account not found" });
    return;
  }
  try {
    // Bank-code normalization for legacy payout accounts (see maturity sweep).
    let payoutBankCode = String(account.bankCode);
    try {
      const normalized = await normalizeBankCodeForFlutterwave(payoutBankCode, String(account.bankName ?? account.bankCode ?? ""));
      if (normalized && normalized !== payoutBankCode) {
        payoutBankCode = normalized;
        account.bankCode = normalized;
        account.updatedAt = new Date().toISOString();
      }
    } catch (_normError) {
      // Bank list unavailable — proceed with the stored code.
    }
    const transfer = await createInvestorPayout({
      txRef: `VELO-PAYOUT-RETRY-${payout.id}`,
      amountNaira: Number(payout.amountNaira),
      accountNumber: String(account.accountNumber),
      accountBank: payoutBankCode,
      beneficiaryName: String(account.accountName),
      narration: `Velo investor payout retry ${payout.id}`,
    });
    payout.status = "PENDING_PROVIDER_CONFIRMATION";
    payout.providerTransfer = transfer;
    payout.retryCount = (payout.retryCount ?? 0) + 1;
    payout.lastAttemptAt = new Date().toISOString();
    if (!(await persistMutation(res))) return;
    res.status(202).json({ ok: true, payout, transfer });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Flutterwave payout unavailable",
    });
  }
});

router.get("/admin/users", requireAuth, requireRole("ADMIN"), (req, res) => {
  const role = typeof req.query.role === "string" ? req.query.role : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const filtered = users.filter((user) => (!role || user.roles.includes(role as Role)) && (!status || (status === "ACTIVE" ? user.isActive !== false : user.isActive === false)));
  const page = paginate(filtered, req.query as Record<string, unknown>);
  res.json({
    ok: true,
    users: page.items.map(({ passwordHash: _passwordHash, ...user }) => user),
    meta: page.meta,
  });
});

router.post("/admin/users", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({
    email: z.string().email(),
    fullName: z.string().min(2).max(120),
    phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/, "Enter a valid Nigerian phone number")),
    password: z.string().min(12),
    roles: z.array(z.enum(["INVESTOR", "BORROWER"])).min(1).default(["INVESTOR", "BORROWER"]),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (findUserByEmail(parsed.data.email)) { res.status(409).json({ ok: false, error: "An account with this email already exists" }); return; }
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    email: parsed.data.email.toLowerCase(),
    phone: parsed.data.phone,
    fullName: parsed.data.fullName,
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    roles: parsed.data.roles as Role[],
    kycStatus: "NOT_STARTED" as KycStatus,
    createdAt: now,
    updatedAt: now,
    isActive: true,
  };
  users.push(user);
  createWallet(user.id);
  recordAdminAudit(req, "USER_CREATED", "USER", user.id, { email: user.email, roles: user.roles });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.status(201).json({ ok: true, user: safeUser });
});

router.patch("/admin/users/:id/roles", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({ roles: z.array(z.enum(["INVESTOR", "BORROWER"])).min(1) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((u) => u.id === req.params.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  user.roles = parsed.data.roles as Role[];
  user.updatedAt = new Date().toISOString();
  recordAdminAudit(req, "USER_ROLES_UPDATED", "USER", user.id, { roles: user.roles });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

router.patch("/admin/users/:id/status", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((u) => u.id === req.params.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  user.isActive = parsed.data.isActive;
  user.updatedAt = new Date().toISOString();
  recordAdminAudit(req, parsed.data.isActive ? "USER_ACTIVATED" : "USER_DEACTIVATED", "USER", user.id, { isActive: user.isActive });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

router.patch("/admin/users/:id", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({
    fullName: z.string().min(2).max(120).optional(),
    phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/, "Enter a valid Nigerian phone number")).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((u) => u.id === req.params.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  if (parsed.data.fullName != null) user.fullName = parsed.data.fullName;
  if (parsed.data.phone != null) user.phone = parsed.data.phone;
  user.updatedAt = new Date().toISOString();
  recordAdminAudit(req, "USER_UPDATED", "USER", user.id, { fullName: user.fullName, phone: user.phone });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeUser } = user;
  res.json({ ok: true, user: safeUser });
});

router.post("/admin/users/:id/kyc-reset", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({
    category: z.enum(["BVN", "NIN", "LIVENESS", "ADDRESS", "ALL"]),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const user = users.find((u) => u.id === req.params.id);
  if (!user) { res.status(404).json({ ok: false, error: "User not found" }); return; }
  const result = resetKycCategory(user.id, parsed.data.category as KycResetCategory);
  recordAdminAudit(req, "KYC_RESET", "KYC", user.id, { category: parsed.data.category, checklist: result.checklist, status: result.status });
  const kyc = findOrCreateKycCase(user.id);
  if (!(await persistMutation(res))) return;
  res.json({
    ok: true,
    category: parsed.data.category,
    checklist: result.checklist,
    status: result.status,
    kyc: {
      id: kyc.id,
      userId: kyc.userId,
      status: kyc.status,
      checklist: kyc.checklist,
      updatedAt: kyc.updatedAt,
    },
  });
});

router.get("/admin/loan-managers", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({
    ok: true,
    managers: users
      .filter((user) => user.roles.includes("LOAN_MANAGER"))
      .map(({ passwordHash: _passwordHash, ...user }) => ({ ...user, role: "LOAN_MANAGER" })),
  });
});

router.post("/admin/loan-managers", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({
    email: z.string().email(),
    fullName: z.string().min(2).max(120),
    phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/, "Enter a valid Nigerian phone number")),
    password: z.string().min(12),
    role: z.literal("LOAN_MANAGER").optional(),
    permissions: z.array(z.enum(ADMIN_PERMISSIONS)).default([...ADMIN_PERMISSIONS]),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  if (findUserByEmail(parsed.data.email)) {
    res.status(409).json({ ok: false, error: "An account with this email already exists" });
    return;
  }
  const now = new Date().toISOString();
  const manager = {
    id: randomUUID(),
    email: parsed.data.email.toLowerCase(),
    phone: parsed.data.phone,
    fullName: parsed.data.fullName,
    passwordHash: await bcrypt.hash(parsed.data.password, 12),
    roles: ["LOAN_MANAGER"] as Role[],
    adminPermissions: parsed.data.permissions,
    kycStatus: "NOT_STARTED" as KycStatus,
    createdAt: now,
    updatedAt: now,
    isActive: true,
  };
  users.push(manager);
  recordAdminAudit(req, "LOAN_MANAGER_CREATED", "USER", manager.id, { role: "LOAN_MANAGER", email: manager.email });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeManager } = manager;
  res.status(201).json({ ok: true, manager: { ...safeManager, role: "LOAN_MANAGER" } });
});

router.patch("/admin/loan-managers/:id/status", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const manager = users.find((user) => user.id === req.params.id && user.roles.includes("LOAN_MANAGER"));
  if (!manager) {
    res.status(404).json({ ok: false, error: "Loan manager not found" });
    return;
  }
  manager.isActive = parsed.data.isActive;
  manager.updatedAt = new Date().toISOString();
  recordAdminAudit(req, parsed.data.isActive ? "LOAN_MANAGER_ACTIVATED" : "LOAN_MANAGER_DEACTIVATED", "USER", manager.id, { isActive: manager.isActive });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, manager: { ...manager, passwordHash: undefined, role: "LOAN_MANAGER" } });
});

router.delete("/admin/loan-managers/:id", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const managerIndex = users.findIndex((user) => user.id === req.params.id && user.roles.includes("LOAN_MANAGER"));
  if (managerIndex < 0) {
    res.status(404).json({ ok: false, error: "Loan manager not found" });
    return;
  }
  const [manager] = users.splice(managerIndex, 1);
  recordAdminAudit(req, "LOAN_MANAGER_DELETED", "USER", manager.id, { email: manager.email, role: "LOAN_MANAGER" });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, deleted: true, managerId: manager.id });
});

router.get("/admin/administrators", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const persisted = users.filter((user) => user.roles.includes("ADMIN")).map(({ passwordHash: _passwordHash, ...user }) => user);
  if (env.ADMIN_EMAIL && !persisted.some((user) => user.email.toLowerCase() === env.ADMIN_EMAIL!.toLowerCase())) {
    persisted.unshift({ id: "env-admin", email: env.ADMIN_EMAIL.toLowerCase(), phone: "", fullName: "Velo Administrator", roles: ["ADMIN" as Role], kycStatus: "VERIFIED" as KycStatus, createdAt: new Date().toISOString(), isActive: true });
  }
  res.json({ ok: true, administrators: persisted });
});

router.post("/admin/administrators", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({ email: z.string().email(), fullName: z.string().min(2).max(120), phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/)), password: z.string().min(12), roles: z.array(z.enum(["ADMIN", "LOAN_MANAGER"])).min(1).default(["ADMIN"]), permissions: z.array(z.enum(ADMIN_PERMISSIONS)).default([...ADMIN_PERMISSIONS]) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (findUserByEmail(parsed.data.email)) { res.status(409).json({ ok: false, error: "An account with this email already exists" }); return; }
  const now = new Date().toISOString();
  const administrator = { id: randomUUID(), email: parsed.data.email.toLowerCase(), phone: parsed.data.phone, fullName: parsed.data.fullName, passwordHash: await bcrypt.hash(parsed.data.password, 12), roles: parsed.data.roles as Role[], adminPermissions: parsed.data.permissions, kycStatus: "VERIFIED" as KycStatus, createdAt: now, updatedAt: now, isActive: true };
  users.push(administrator);
  recordAdminAudit(req, "ADMIN_CREATED", "USER", administrator.id, { email: administrator.email });
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeAdministrator } = administrator;
  res.status(201).json({ ok: true, administrator: safeAdministrator });
});

router.patch("/admin/administrators/:id/status", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  const administrator = users.find((user) => user.id === req.params.id && user.roles.includes("ADMIN"));
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (!administrator) { res.status(404).json({ ok: false, error: "Administrator not found" }); return; }
  administrator.isActive = parsed.data.isActive;
  administrator.updatedAt = new Date().toISOString();
  recordAdminAudit(req, parsed.data.isActive ? "ADMIN_ACTIVATED" : "ADMIN_DEACTIVATED", "USER", administrator.id);
  if (!(await persistMutation(res))) return;
  const { passwordHash: _passwordHash, ...safeAdministrator } = administrator;
  res.json({ ok: true, administrator: safeAdministrator });
});

router.delete("/admin/administrators/:id", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const index = users.findIndex((user) => user.id === req.params.id && user.roles.includes("ADMIN"));
  if (index < 0) { res.status(404).json({ ok: false, error: "Administrator not found" }); return; }
  const [administrator] = users.splice(index, 1);
  recordAdminAudit(req, "ADMIN_DELETED", "USER", administrator.id, { email: administrator.email });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, deleted: true });
});

router.get("/admin/audit-logs", requireAuth, requireRole("ADMIN"), (req, res) => {
  const ordered = [...auditLogs].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const page = paginate(ordered, req.query as Record<string, unknown>);
  const logs = page.items.map((entry) => {
    const actor = entry.userId ? users.find((user) => user.id === entry.userId) : undefined;
    const target = entry.resourceType === "USER" && entry.resourceId ? users.find((user) => user.id === entry.resourceId) : undefined;
    return { ...entry, actor: actor ? { id: actor.id, fullName: actor.fullName, email: actor.email, roles: actor.roles } : null, targetUser: target ? { id: target.id, fullName: target.fullName, email: target.email, phone: target.phone } : null };
  });
  res.json({ ok: true, logs, meta: page.meta });
});

router.get("/admin/kyc-cases", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const cases = kycCases.map((k) => ({
    ...k,
    bvn: k.bvn ? `***-***-${k.bvn.slice(-4)}` : undefined,
    nin: k.nin ? `***-***-${k.nin.slice(-4)}` : undefined,
    user: users.find((u) => u.id === k.userId) ? { id: k.userId, fullName: users.find((u) => u.id === k.userId)!.fullName, email: users.find((u) => u.id === k.userId)!.email, phone: users.find((u) => u.id === k.userId)!.phone } : undefined,
    documents: documents.filter((d) => d.userId === k.userId),
    events: identityVerificationEvents.filter((e) => e.kycCaseId === k.id),
  }));
  const page = paginate(cases, _req.query as Record<string, unknown>);
  res.json({
    ok: true,
    cases: page.items,
    meta: page.meta,
  });
});

router.post("/admin/kyc-cases/:id/decision", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z
    .object({
      decision: z.enum(["VERIFIED", "PARTIALLY_VERIFIED", "REJECTED", "ACTION_REQUIRED", "SUSPENDED"]),
      note: z.string().max(1000).default(""),
      rejectedReason: z.string().max(1000).optional(),
      checklistOverride: z
        .object({
          bvn: z.boolean().optional(),
          nin: z.boolean().optional(),
          proofOfAddress: z.boolean().optional(),
          passport: z.boolean().optional(),
          signature: z.boolean().optional(),
        })
        .optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const kyc = kycCases.find((k) => k.id === req.params.id);
  if (!kyc) {
    res.status(404).json({ ok: false, error: "KYC case not found" });
    return;
  }
  const before = { ...kyc };
  const requiredChecks = ["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const;
  const proposedChecklist = { ...kyc.checklist, ...parsed.data.checklistOverride };
  if (parsed.data.decision === "VERIFIED" && !requiredChecks.every((key) => proposedChecklist[key])) {
    res.status(400).json({ ok: false, error: "Every required KYC check must be approved before verifying the overall KYC status." });
    return;
  }
  if (parsed.data.decision === "REJECTED" && !String(parsed.data.rejectedReason ?? parsed.data.note).trim()) {
    res.status(400).json({ ok: false, error: "A rejection reason is required" });
    return;
  }
  if (parsed.data.checklistOverride) Object.assign(kyc.checklist, parsed.data.checklistOverride);
  kyc.status = parsed.data.decision as KycStatus;
  kyc.reviewedBy = (req as AuthRequest).user?.id ?? "unknown-admin";
  kyc.reviewedAt = new Date().toISOString();
  if (parsed.data.decision === "VERIFIED" && !kyc.verifiedAt) kyc.verifiedAt = kyc.reviewedAt;
  if (parsed.data.decision === "REJECTED") {
    kyc.rejectionReason = providerReason(parsed.data.rejectedReason || parsed.data.note);
    const category = Object.entries(kyc.categoryResults ?? {}).find(([, value]) => value?.status === "REJECTED")?.[0];
    if (category) setKycCategoryResult(kyc, category as KycCategory, "REJECTED", kyc.rejectionReason);
  }
  if (parsed.data.decision === "VERIFIED") {
    for (const category of ["BVN", "NIN", "LIVENESS", "ADDRESS", "SIGNATURE"] as KycCategory[]) setKycCategoryResult(kyc, category, "VERIFIED");
  }
  kyc.updatedAt = new Date().toISOString();
  if (parsed.data.checklistOverride) markKycChecklistComplete(kyc.userId);
  const user = users.find((u) => u.id === kyc.userId);
  if (user) {
    user.kycStatus = kyc.status;
    await notifyKyc(user, parsed.data.decision === "VERIFIED" ? "APPROVED" : "REJECTED", "KYC", kyc.rejectionReason);
  }
  recordAdminAudit(req, `KYC_${parsed.data.decision}`, "KYC_CASE", kyc.id, { userId: kyc.userId, previousStatus: before.status, newStatus: kyc.status, note: parsed.data.note, rejectedReason: parsed.data.rejectedReason });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, case: kyc, before });
});

router.post("/admin/kyc-cases/:id/requirement", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({
    requirement: z.enum(["bvn", "nin", "liveness", "proofOfAddress", "passport", "signature"]),
    approved: z.boolean(),
    note: z.string().max(1000).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const kyc = kycCases.find((item) => item.id === req.params.id);
  if (!kyc) { res.status(404).json({ ok: false, error: "KYC case not found" }); return; }
  kyc.checklist[parsed.data.requirement] = parsed.data.approved;
  kyc.updatedAt = new Date().toISOString();
  if (parsed.data.requirement === "liveness" && parsed.data.approved) {
    kyc.livenessVerifiedAt = kyc.livenessVerifiedAt ?? new Date().toISOString();
    if (!kyc.livenessStatus) kyc.livenessStatus = "SUCCESS";
  }
  const category = parsed.data.requirement === "proofOfAddress" ? "ADDRESS" : parsed.data.requirement.toUpperCase() as KycCategory;
  setKycCategoryResult(kyc, category, parsed.data.approved ? "VERIFIED" : "REJECTED", parsed.data.note);
  if (!parsed.data.approved) kyc.rejectionReason = providerReason(parsed.data.note || `${parsed.data.requirement} requires attention`);
  markKycChecklistComplete(kyc.userId);
  const user = users.find((item) => item.id === kyc.userId);
  if (user) await notifyKyc(user, parsed.data.approved ? "APPROVED" : "REJECTED", category, kyc.rejectionReason);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, case: kyc });
});

// ---------------------------------------------------------------------------
// Intelligent loan-product resolution (backward compatibility core).
//
// Products can be renamed, re-priced, deactivated or deleted by the admin at
// any time. Ongoing applications must ALWAYS keep rendering correct loan
// information instead of returning empty product info. The resolver tries, in
// order of trustworthiness:
//   1. The product id stored on the application (even if now inactive/renamed)
//   2. The snapshot product id captured when the application was saved
//   3. Active-product name keyword match for the applicant type
//      (snapshot/cached names are checked too, case-insensitively)
//   4. The application's own captured product snapshot (terms survive deletion)
//   5. Amount-range containment among active products of the platform
//   6. Any active product (deterministic: lowest minimum first)
// It never throws and always yields usable terms.
// ---------------------------------------------------------------------------

type LoanProductRow = (typeof loanProducts)[number];

/** Sort + dedupe a tenure list so catalog data is always canonical. */
export function normalizeTenureDays(days: number[]): number[] {
  return [...new Set(days.map((d) => Math.trunc(Number(d))).filter((d) => Number.isFinite(d) && d > 0))].sort((a, b) => a - b);
}

function normalizeProductKeyword(name: unknown): string {
  return String(name ?? "").trim().toLowerCase();
}

function productMatchesApplicantType(product: LoanProductRow, applicantType: "PERSONAL" | "BUSINESS"): boolean {
  // Explicit admin-set type always wins over name keywords.
  if (product.programType === "BOTH") return true;
  if (product.programType === "PERSONAL" || product.programType === "BUSINESS") {
    return product.programType === applicantType;
  }
  const name = normalizeProductKeyword(product.name);
  return applicantType === "BUSINESS"
    ? name.includes("business")
    : name.includes("personal") && !name.includes("business");
}

/** Deterministic ordering: cheapest products first (stable tie-break by creation). */
function compareProductsByRange(a: LoanProductRow, b: LoanProductRow): number {
  const minDiff = Number(a.minAmountNaira ?? 0) - Number(b.minAmountNaira ?? 0);
  if (minDiff !== 0) return minDiff;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
}

export function resolveLoanProductForApplication(
  application: {
    loanProductId?: string;
    applicantType?: "PERSONAL" | "BUSINESS";
    amountNaira?: number;
    productSnapshot?: LoanProductSnapshot | null;
    customerSnapshot?: Record<string, unknown> | null;
  }
): LoanProductRow | null {
  // 1. Stored product id — wins even if the product was renamed or deactivated,
  //    because that is the product the borrower was shown.
  if (application.loanProductId) {
    const byId = loanProducts.find((p) => p.id === application.loanProductId);
    if (byId) return byId;
  }
  // 2. Snapshot product id (legacy applications store it only in the snapshot).
  const snapshotId = (application.productSnapshot as LoanProductSnapshot | undefined)?.productId
    ?? (application.customerSnapshot as { productSnapshot?: LoanProductSnapshot } | undefined)?.productSnapshot?.productId;
  if (snapshotId) {
    const bySnapshotId = loanProducts.find((p) => p.id === snapshotId);
    if (bySnapshotId) return bySnapshotId;
  }
  const type = application.applicantType === "BUSINESS" ? "BUSINESS" : "PERSONAL";
  const active = loanProducts.filter((p) => p.isActive);
  // 3. Active products whose name matches the applicant type.
  const byType = active.filter((p) => productMatchesApplicantType(p, type)).sort(compareProductsByRange);
  if (byType.length > 0) return byType[0];
  // 4. Amount-range containment (helps when names no longer carry a keyword).
  const amount = Number(application.amountNaira ?? 0);
  if (Number.isFinite(amount) && amount > 0) {
    const byAmount = active
      .filter((p) => Number(p.minAmountNaira ?? 0) <= amount && amount <= Number(p.maxAmountNaira ?? 0))
      .sort(compareProductsByRange);
    if (byAmount.length > 0) return byAmount[0];
  }
  // 5. Any active product — deterministic.
  if (active.length > 0) return active.slice().sort(compareProductsByRange)[0];
  // 6. Last resort: any product row at all.
  return loanProducts[0] ?? null;
}

/**
 * Build the immutable terms snapshot captured on applications and loans.
 */
export function captureProductSnapshot(product: LoanProductRow | null): LoanProductSnapshot | null {
  if (!product) return null;
  return {
    productId: product.id,
    productName: product.name,
    programType: product.programType ?? null,
    minAmountNaira: Number(product.minAmountNaira),
    maxAmountNaira: Number(product.maxAmountNaira),
    defaultAmountNaira: product.defaultAmountNaira !== undefined ? Number(product.defaultAmountNaira) : undefined,
    defaultTenureDays: product.defaultTenureDays,
    tenureDays: product.tenureDays ? [...product.tenureDays] : undefined,
    tenorInterestRates: product.tenorInterestRates ? product.tenorInterestRates.map((r) => ({ ...r })) : undefined,
    interestRatePercent: Number(product.interestRatePercent),
    interestType: product.interestType,
    processingFeePercent: Number(product.processingFeePercent),
    serviceFeePercent: Number(product.serviceFeePercent ?? 0),
    lateFeePercent: Number(product.lateFeePercent),
    lateFeeType: product.lateFeeType,
    gracePeriodDays: product.gracePeriodDays,
    collateralEnabled: product.collateralEnabled ?? true,
    collateralRequired: product.collateralRequired ?? false,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Flat product fields merged into application/loan API responses so the UI can
 * ALWAYS render loan information (product name, interest, fees, range) even
 * when the underlying product was renamed, deactivated or deleted.
 */
function applicationProductPayload(application: {
  loanProductId?: string;
  applicantType?: "PERSONAL" | "BUSINESS";
  amountNaira?: number;
  productSnapshot?: LoanProductSnapshot | null;
  customerSnapshot?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const product = resolveLoanProductForApplication(application);
  const snapshot = (application.productSnapshot
    ?? (application.customerSnapshot as { productSnapshot?: LoanProductSnapshot } | undefined)?.productSnapshot) as LoanProductSnapshot | undefined;
  const source: LoanProductRow | LoanProductSnapshot | undefined = product ?? snapshot ?? undefined;
  if (!source) return {};
  // A catalog ROW has `name`; a SNAPSHOT has `productName`. Read both defensively
  // so a renamed/deleted product still renders its captured terms.
  const sourceRecord = source as unknown as Record<string, unknown>;
  const name = sourceRecord.name ?? sourceRecord.productName;
  if (!name) return {};
  return {
    productName: name,
    productProgramType: (sourceRecord.programType ?? snapshot?.programType ?? null) as string | null | undefined,
    productInterestRatePercent: Number(sourceRecord.interestRatePercent ?? snapshot?.interestRatePercent ?? 0),
    productInterestType: sourceRecord.interestType ?? snapshot?.interestType ?? "SIMPLE_FLAT",
    productProcessingFeePercent: Number(sourceRecord.processingFeePercent ?? snapshot?.processingFeePercent ?? 0),
    productServiceFeePercent: Number(sourceRecord.serviceFeePercent ?? snapshot?.serviceFeePercent ?? 0),
    productLateFeePercent: Number(sourceRecord.lateFeePercent ?? snapshot?.lateFeePercent ?? 0),
    productGracePeriodDays: sourceRecord.gracePeriodDays ?? snapshot?.gracePeriodDays,
    productMinAmountNaira: Number(sourceRecord.minAmountNaira ?? snapshot?.minAmountNaira ?? 0),
    productMaxAmountNaira: Number(sourceRecord.maxAmountNaira ?? snapshot?.maxAmountNaira ?? 0),
    productDefaultAmountNaira: sourceRecord.defaultAmountNaira ?? snapshot?.defaultAmountNaira,
    productDefaultTenureDays: sourceRecord.defaultTenureDays ?? snapshot?.defaultTenureDays,
    productTenureDays: (sourceRecord.tenureDays ?? snapshot?.tenureDays) as number[] | undefined,
    productTenorInterestRates: (sourceRecord.tenorInterestRates ?? snapshot?.tenorInterestRates) as TenorInterestRate[] | undefined,
  };
}

/**
 * Classify a product into the borrower application flow (PERSONAL / BUSINESS)
 * deterministically, so the borrower never renders an empty program:
 *   0. EXPLICIT productType column — the admin's choice always wins (a renamed
 *      product keeps its flow; no keyword guessing).
 *   1. Name keyword ("business" -> BUSINESS, "personal" (not business) -> PERSONAL)
 *      for legacy rows created before the explicit column existed.
 *   2. Single active product on the platform -> "BOTH" (serves both flows)
 *   3. Otherwise null (frontend falls back to deterministic assignment)
 */
export function classifyLoanProductType(product: LoanProductRow): "PERSONAL" | "BUSINESS" | "BOTH" | null {
  if (product.programType === "BUSINESS" || product.programType === "PERSONAL") return product.programType;
  if (product.programType === "BOTH") return "BOTH";
  if (productMatchesApplicantType(product, "BUSINESS")) return "BUSINESS";
  if (productMatchesApplicantType(product, "PERSONAL")) return "PERSONAL";
  const active = loanProducts.filter((p) => p.isActive);
  if (active.length === 1 && active[0].id === product.id) return "BOTH";
  return null;
}

function ensureApprovedLoanRecord(application: (typeof loanApplications)[number], now = new Date().toISOString()) {
  const existing = loans.find((loan) => loan.applicationId === application.id);
  if (existing) return existing;
  const product = resolveLoanProductForApplication(application);
  const snapshot = (application.productSnapshot ?? (application.customerSnapshot as { productSnapshot?: LoanProductSnapshot } | undefined)?.productSnapshot) as LoanProductSnapshot | undefined;
  // Terms priority:
  //   1. The stored frontend calculation — exactly what the borrower saw and
  //      agreed to in the agreement (survives any later product re-pricing).
  //   2. The resolved product's live terms.
  //   3. The captured snapshot terms.
  //   4. Conservative defaults.
  const savedCalc = (application.customerSnapshot as { calculation?: { loanAmount?: number; interest?: number; processingFee?: number; serviceFee?: number; totalRepayment?: number; tenure?: number } | null } | undefined)?.calculation;
  const principal = Number(application.amountNaira ?? 0);
  const tenure = application.tenureDays
    ?? (Number.isFinite(Number(savedCalc?.tenure)) && Number(savedCalc?.tenure) > 0 ? Number(savedCalc?.tenure) : undefined)
    ?? product?.defaultTenureDays
    ?? snapshot?.defaultTenureDays
    ?? 90;
  let interest: number;
  let processing: number;
  if (savedCalc && Number(savedCalc.loanAmount) === principal && Number.isFinite(Number(savedCalc.interest)) && Number(savedCalc.interest) >= 0) {
    interest = Number(savedCalc.interest);
    processing = Number(savedCalc.processingFee ?? 0) + Number(savedCalc.serviceFee ?? 0);
  } else {
    // Per-tenor monthly rate (easimoney style) wins: interest for tenor T =
    // principal × monthlyRate% × (T/30). Without an entry the base-rate math
    // applies (unchanged legacy behaviour).
    const tenorMonthlyRate = resolveTenorMonthlyRate(product ?? null, snapshot ?? null, tenure);
    if (tenorMonthlyRate !== undefined) {
      interest = principal * (tenorMonthlyRate / 100) * (tenure / 30);
    } else {
      const rate = Number(product?.interestRatePercent ?? snapshot?.interestRatePercent ?? 18) / 100;
      interest = principal * rate * (tenure / 365);
    }
    processing = principal * (Number(product?.processingFeePercent ?? snapshot?.processingFeePercent ?? 2) / 100);
  }
  const totalRepayment = principal + interest + processing;
  const dueAt = new Date(Date.now() + tenure * 86400000).toISOString();
  const loanRecord: (typeof loans)[number] = {
    id: randomUUID(),
    applicationId: application.id,
    borrowerId: application.borrowerId,
    loanProductId: product?.id ?? snapshot?.productId,
    productSnapshot: captureProductSnapshot(product) ?? snapshot ?? undefined,
    principalNaira: principal,
    totalInterestNaira: Math.round(interest * 100) / 100,
    totalFeesNaira: Math.round(processing * 100) / 100,
    totalRepaymentNaira: Math.round(totalRepayment * 100) / 100,
    outstandingNaira: Math.round(totalRepayment * 100) / 100,
    tenureDays: tenure,
    status: "DISBURSEMENT_PENDING",
    dueAt,
    createdAt: now,
    updatedAt: now,
  };
  loans.push(loanRecord);
  const scheduleCount = Math.max(1, Math.round(tenure / 30));
  for (let i = 1; i <= scheduleCount; i++) {
    loanSchedules.push({
      id: randomUUID(), loanId: loanRecord.id, installmentNumber: i,
      dueDate: new Date(Date.now() + (tenure / scheduleCount) * i * 86400000).toISOString().slice(0, 10),
      principalNaira: Math.round((principal / scheduleCount) * 100) / 100,
      interestNaira: Math.round((interest / scheduleCount) * 100) / 100,
      feesNaira: i === 1 ? Math.round(processing * 100) / 100 : 0,
      totalDueNaira: Math.round((totalRepayment / scheduleCount) * 100) / 100,
      totalPaidNaira: 0, status: "PENDING", createdAt: now,
    });
  }
  creditHistory.push({ id: randomUUID(), userId: application.borrowerId, loanId: loanRecord.id, eventType: "LOAN_APPROVED", detail: `Application ${application.applicationId} approved`, occurredAt: now, createdAt: now });
  return loanRecord;
}

router.get("/admin/loans", requireAuth, requireRole("ADMIN"), (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const borrowerId = typeof req.query.borrowerId === "string" ? req.query.borrowerId : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.toLowerCase() : undefined;
  // Performance: avoid JSON.stringify on every application. Build a small
  // searchable string per application only from the fields we actually match.
  const filtered = loanApplications.filter((application) => {
    const snapshot = application.customerSnapshot as Record<string, unknown> | undefined;
    const personalInfo = (snapshot?.personalInfo as Record<string, unknown> | undefined) ?? {};
    const businessInfo = (snapshot?.businessInfo as Record<string, unknown> | undefined) ?? {};
    const applicantType = businessInfo?.businessName ? "BUSINESS" : "PERSONAL";
    if (status && application.status !== status) return false;
    if (type && applicantType !== type) return false;
    if (borrowerId && application.borrowerId !== borrowerId) return false;
    if (search) {
      const haystack = [
        application.applicationId,
        application.id,
        String(personalInfo.fullName ?? ""),
        String(personalInfo.email ?? ""),
        String(personalInfo.phone ?? ""),
        String(businessInfo.businessName ?? ""),
      ].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  }).map((a) => ({ ...seedLoanStageStatuses(a), ...applicationProductPayload(a) }));
  const reconciled = filtered.some(synchronizeLoanApplicationStatus);
  if (reconciled) void persistStore().catch(() => undefined);
  const page = paginate(filtered, req.query as Record<string, unknown>);
  // Note: we no longer return `disbursedLoans: loans` (ALL loans) — that was
  // forcing the entire loans array to be serialised on every admin list call.
  // Consumers that need disbursement data should hit /admin/disbursements.
  // The admin loan table still needs each application's LOAN RECORD status to
  // drive the disburse button (disable while processing, hide once disbursed),
  // so return a lightweight projection for just the applications on this page.
  const pageApplicationIds = new Set(page.items.map((a) => a.id));
  const loanRecords = loans
    .filter((l) => (l.applicationId && pageApplicationIds.has(l.applicationId)))
    .map((l) => ({ id: l.id, applicationId: l.applicationId, status: l.status, disbursedAt: l.disbursedAt ?? null, updatedAt: l.updatedAt }));
  res.json({ ok: true, loans: page.items, loanRecords, meta: page.meta, stages: LOAN_STAGES });
});

router.get("/admin/loans/:loanId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  if (application) {
    seedLoanStageStatuses(application);
    if (synchronizeLoanApplicationStatus(application)) await persistStore().catch(() => undefined);
  }
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.id === req.params.loanId);
  if (!application && !loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  const borrowerId = application?.borrowerId ?? loan?.borrowerId;
  const borrowerKyc = borrowerId ? indexes.kycCasesByUserId.get(borrowerId) : undefined;
  const kycDocuments: Record<string, unknown> = {};
  if (borrowerId) {
    const userDocs = documents.filter((d) => d.userId === borrowerId);
    const proofOfAddress = userDocs.find((d) => d.documentType === "PROOF_OF_ADDRESS");
    const passport = userDocs.find((d) => d.documentType === "PASSPORT_PHOTO" || d.documentSlot === "passportPhoto");
    const signature = userDocs.find((d) => d.documentType === "SIGNATURE" || d.documentSlot === "signature");
    const selfie = userDocs.find((d) => (d.documentType as string) === "LIVENESS_SELFIE" || d.documentSlot === "selfie");
    // Attach preview/download URLs directly so the admin UI can render images
    // inline without a second round-trip.
    const withUrls = (d: typeof documents[number] | undefined) => {
      if (!d) return undefined;
      const isGd = d.provider === "google_drive";
      const previewUrl = isGd && d.providerFileId
        ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(d.providerFileId)}`
        : (d as { previewUrl?: string }).previewUrl ?? "";
      const downloadUrl = isGd && d.providerFileId
        ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(d.providerFileId)}`
        : (d as { downloadUrl?: string }).downloadUrl ?? "";
      return { ...d, previewUrl, downloadUrl };
    };
    if (proofOfAddress) kycDocuments.proofOfAddress = withUrls(proofOfAddress);
    if (passport) kycDocuments.passportPhoto = withUrls(passport);
    if (signature) kycDocuments.signature = withUrls(signature);
    if (selfie) kycDocuments.selfie = withUrls(selfie);
  }
  if (borrowerKyc?.identityPhoto || borrowerKyc?.identityPhotoUrl) {
    kycDocuments.identityPhoto = borrowerKyc.identityPhotoUrl ?? borrowerKyc.identityPhoto;
  }
  if (borrowerKyc?.selfieImageData) {
    kycDocuments.selfieImageData = borrowerKyc.selfieImageData;
  }
  res.json({
    ok: true,
    application: application ? { ...application, ...applicationProductPayload(application) } : application,
    loan: loan ? { ...loan, ...applicationProductPayload({
      loanProductId: loan.loanProductId,
      applicantType: application?.applicantType,
      amountNaira: loan.principalNaira,
      productSnapshot: loan.productSnapshot,
      customerSnapshot: application?.customerSnapshot,
    }) } : loan,
    stages: LOAN_STAGES,
    schedule: loan ? loanSchedules.filter((s) => s.loanId === loan.id) : [],
    repayments: loan ? repayments.filter((r) => r.loanId === loan.id) : [],
    creditHistory: application ? creditHistory.filter((c) => c.userId === application.borrowerId) : [],
    kycCase: borrowerKyc,
    kycDocuments,
  });
});

// Admin: trigger a Prembly credit-bureau check for a specific loan
// application's borrower. Identity (RC number + company name for the
// COMMERCIAL (Business) Advance product, or the verified BVN/NIN for the
// consumer product) is resolved from the customer's application snapshot,
// KYC case and profile. The report row is created immediately (PENDING) and
// the provider call runs in the BACKGROUND — real bureau lookups take
// 25-90s, far beyond what an HTTP request should stay open for. The endpoint
// waits up to ~3s so fast responses come back inline; otherwise the admin
// card polls every 3s and the reconciliation cron self-heals PENDING rows.
router.post("/admin/loan-applications/:applicationId/credit-bureau", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const application = loanApplications.find(
    (a) => a.id === req.params.applicationId || a.applicationId === req.params.applicationId
  );
  if (!application) {
    res.status(404).json({ ok: false, error: "Loan application not found" });
    return;
  }
  const dataMode = typeof req.body?.dataMode === "string" && req.body.dataMode.toUpperCase() === "BASIC" ? "BASIC" as const : "ADVANCE" as const;
  try {
    const started = await startCreditBureauCheck(application.borrowerId, {
      applicationId: application.applicationId || application.id,
      snapshot: application.customerSnapshot as Record<string, unknown> | undefined,
      source: "ADMIN_TRIGGER",
      dataMode,
    });
    if (!started.ok) {
      res.status(409).json({ ok: false, error: started.message });
      return;
    }
    // Give fast provider responses a brief window to land inline so the
    // admin usually sees RECEIVED/FAILED right away; slow lookups (the norm)
    // return the PENDING report and the card keeps polling.
    await Promise.race([
      started.completion,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    const report = started.report;
    auditLogs.push({
      id: randomUUID(),
      userId: req.user!.id,
      action: "credit_bureau_check_triggered",
      resourceType: "LOAN_APPLICATION",
      resourceId: application.applicationId || application.id,
      metadata: {
        borrowerId: application.borrowerId,
        reportId: report.id,
        reportStatus: report.status,
        reportScore: report.score ?? null,
        product: (report.normalizedFields as { reportType?: string } | undefined)?.reportType ?? "CONSUMER_ADVANCE",
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent") ?? undefined,
      createdAt: new Date().toISOString(),
    });
    res.json({
      ok: true,
      report,
      creditReportSnapshot: application.creditReportSnapshot ?? null,
      message:
        report.status === "RECEIVED"
          ? `Credit bureau report received${report.score != null ? ` — bureau-equivalent score ${report.score}` : ""}.`
          : report.status === "PENDING"
          ? "Credit bureau check started — the bureau usually answers within a minute and this card refreshes automatically while the check runs."
          : ((report.normalizedFields as { reason?: string } | undefined)?.reason ?? "The credit bureau lookup failed — see the report details."),
    });
  } catch (error) {
    console.error("[routes] admin credit-bureau check failed:", error);
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : "The credit bureau check failed unexpectedly." });
  }
});

// Admin: proxy-download a KYC document by documentId. Streams the file from
// Google Drive (or whatever storage provider is configured) so the admin
// can preview/download without exposing the raw provider file ID to the
// browser. Used by the document preview grid on the admin detail page.
router.get("/admin/documents/:documentId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const documentId = String(req.params.documentId ?? "").trim();
  if (!documentId) {
    res.status(400).json({ ok: false, error: "documentId is required" });
    return;
  }
  const doc = documents.find((d) => d.id === documentId);
  if (!doc) {
    res.status(404).json({ ok: false, error: "Document not found" });
    return;
  }
  // Return the document metadata + a public-facing URL the browser can use.
  // For Google Drive documents we expose a /uc?export=view URL (preview) and
  // /uc?export=download URL (download). For other providers we fall back to
  // any URL fields already stored on the document.
  const isGoogleDrive = doc.provider === "google_drive";
  // Documents pulled automatically from a loan application snapshot reference
  // the original upload (`snapshot:<applicationId>:<slot>`) — serve them from
  // the application's stored base64 payload.
  let snapshotPreviewUrl = "";
  let snapshotDownloadUrl = "";
  if (doc.provider === "manual" && doc.providerFileId.startsWith("snapshot:")) {
    const [, applicationId, slot] = doc.providerFileId.split(":");
    const application = loanApplications.find((item) => item.id === applicationId);
    const snapshotDoc = slot
      ? ((application?.customerSnapshot as Record<string, unknown> | undefined)?.documents as Record<string, { data?: string; type?: string } | undefined> | undefined)?.[slot]
      : undefined;
    if (snapshotDoc?.data) {
      const mimeType = snapshotDoc.type || doc.mimeType || "application/octet-stream";
      const dataUrl = `data:${mimeType};base64,${snapshotDoc.data}`;
      snapshotPreviewUrl = dataUrl;
      snapshotDownloadUrl = dataUrl;
    }
  }
  // Fast-path uploads keep their bytes inline until the background archive
  // upload finishes (or permanently when Drive is unavailable).
  let inlinePreviewUrl = "";
  let inlineDownloadUrl = "";
  if (!isGoogleDrive && doc.inlineData) {
    inlinePreviewUrl = doc.inlineData;
    inlineDownloadUrl = doc.inlineData;
  }
  const previewUrl = isGoogleDrive && doc.providerFileId
    ? `https://drive.google.com/uc?export=view&id=${encodeURIComponent(doc.providerFileId)}`
    : snapshotPreviewUrl || inlinePreviewUrl || ((doc as { previewUrl?: string }).previewUrl ?? "");
  const downloadUrl = isGoogleDrive && doc.providerFileId
    ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(doc.providerFileId)}`
    : snapshotDownloadUrl || inlineDownloadUrl || ((doc as { downloadUrl?: string }).downloadUrl ?? "");
  res.json({
    ok: true,
    document: {
      id: doc.id,
      documentType: doc.documentType,
      documentSlot: doc.documentSlot,
      provider: doc.provider,
      providerFileId: doc.providerFileId,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      status: doc.status,
      createdAt: doc.createdAt,
      uploadError: doc.uploadError,
      previewUrl,
      downloadUrl,
      source: doc.providerFileId.startsWith("snapshot:") ? "loan_application" : doc.provider,
    },
  });
});

router.post("/admin/loans/:loanId/decision", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z
    .object({
      decision: z.enum(["APPROVED", "REJECTED", "MORE_INFORMATION_REQUIRED"]),
      note: z.string().max(1000).default(""),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  if (!application) {
    res.status(404).json({ ok: false, error: "Loan application not found" });
    return;
  }
  const reconciled = synchronizeLoanApplicationStatus(application);
  if (reconciled) await persistStore().catch(() => undefined);
  const existingLoan = linkedLoan(application);
  if (existingLoan && ["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF", "CANCELLED"].includes(existingLoan.status)) {
    res.status(409).json({ ok: false, error: "A disbursed loan cannot be changed. Its status changes automatically with repayment." });
    return;
  }
  const previousStatus = application.status;
  application.manualDecision = parsed.data.decision;
  application.manualNote = parsed.data.note;
  application.updatedAt = new Date().toISOString();
  if (parsed.data.decision === "APPROVED" && !loans.some((loan) => loan.applicationId === application.id)) {
    application.status = "APPROVED";
    application.approvedAt = new Date().toISOString();
    // Shared builder: resolves the RIGHT product for this application
    // (applicant type + stored ids + snapshot fallback), honours the borrower's
    // saved calculation, and captures an immutable terms snapshot.
    ensureApprovedLoanRecord(application);
  } else if (parsed.data.decision === "REJECTED") {
    application.status = "REJECTED";
  } else {
    application.status = "MORE_INFORMATION_REQUIRED";
  }
  application.updatedAt = new Date().toISOString();
  if (parsed.data.decision === "APPROVED" && previousStatus !== "APPROVED") void sendLoanEmails(application, "APPROVED").catch(() => undefined);
  if (parsed.data.decision === "REJECTED" && previousStatus !== "REJECTED") void sendLoanEmails(application, "REJECTED").catch(() => undefined);
  recordAdminAudit(req, `LOAN_${parsed.data.decision}`, "LOAN_APPLICATION", application.id, { applicationId: application.applicationId, previousStatus, newStatus: application.status, note: parsed.data.note });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, application });
});

router.patch("/admin/loans/:loanId/stages/:stageKey", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({
    decision: z.enum(["APPROVED", "REJECTED"]),
    note: z.string().max(2000).default(""),
  }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  if (!application) {
    res.status(404).json({ ok: false, error: "Loan application not found" });
    return;
  }
  const reconciled = synchronizeLoanApplicationStatus(application);
  if (reconciled) await persistStore().catch(() => undefined);
  if (isLockedLoanApplication(application)) {
    res.status(409).json({ ok: false, error: `Application ${application.applicationId} is locked because its loan is ${application.status}.`, application });
    return;
  }
  const stageKey = req.params.stageKey as LoanStageKey;
  const valid = LOAN_STAGES.some((s) => s.key === stageKey);
  if (!valid) {
    res.status(400).json({ ok: false, error: `Unknown stage key ${stageKey}` });
    return;
  }
  seedLoanStageStatuses(application);
  const previousStatus = application.status;
  const now = new Date().toISOString();
  application.stageStatuses[stageKey] = parsed.data.decision;
  if (parsed.data.decision === "REJECTED") {
    application.stageRejectionNotes[stageKey] = parsed.data.note;
  } else {
    delete application.stageRejectionNotes[stageKey];
  }
  application.updatedAt = now;
  const allApproved = LOAN_STAGES.every((s) => application.stageStatuses[s.key] === "APPROVED");
  if (allApproved && parsed.data.decision === "APPROVED") {
    application.status = "APPROVED";
    application.approvedAt = application.approvedAt ?? now;
    application.manualDecision = "APPROVED";
    ensureApprovedLoanRecord(application, now);
  }
  if (parsed.data.decision === "REJECTED" && previousStatus !== "REJECTED") void sendLoanEmails(application, "REJECTED").catch(() => undefined);
  if (allApproved && previousStatus !== "APPROVED") void sendLoanEmails(application, "APPROVED").catch(() => undefined);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, application, allStagesApproved: allApproved });
});

router.post("/admin/loans/:loanId/stages/approve-all", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({ note: z.string().max(2000).default("") }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  if (!application) {
    res.status(404).json({ ok: false, error: "Loan application not found" });
    return;
  }
  const reconciled = synchronizeLoanApplicationStatus(application);
  if (reconciled) await persistStore().catch(() => undefined);
  if (isLockedLoanApplication(application)) {
    res.status(409).json({ ok: false, error: `Application ${application.applicationId} is locked because its loan is ${application.status}.`, application });
    return;
  }
  seedLoanStageStatuses(application);
  const previousStatus = application.status;
  const now = new Date().toISOString();
  for (const stage of LOAN_STAGES) application.stageStatuses[stage.key] = "APPROVED";
  application.stageRejectionNotes = {};
  application.updatedAt = now;
  application.status = "APPROVED";
  application.approvedAt = application.approvedAt ?? now;
  application.manualDecision = "APPROVED";
  application.manualNote = parsed.data.note || application.manualNote;
  if (!loans.some((l) => l.applicationId === application.id)) {
    // Shared builder — same product resolution & snapshot capture as the
    // single-stage approval path, so terms can never depend on catalog order.
    ensureApprovedLoanRecord(application, now);
  }
  if (previousStatus !== "APPROVED") void sendLoanEmails(application, "APPROVED").catch(() => undefined);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, application });
});

// Fuzzy bank-name -> Flutterwave bank-code recovery for legacy applications
// that stored a bankName without bankCode. Normalizes punctuation and common
// suffixes, then matches on the static NIBSS/Flutterwave code table.
const NG_BANK_CODE_BY_NAME: Array<[string, string]> = [
  ["access bank", "044"],
  ["citibank", "023"],
  ["diamond bank", "063"],
  ["ecobank", "050"],
  ["fcmb", "214"],
  ["first city monument bank", "214"],
  ["fidelity bank", "070"],
  ["first bank", "011"],
  ["first bank of nigeria", "011"],
  ["gtb", "058"],
  ["gtbank", "058"],
  ["guaranty trust bank", "058"],
  ["heritage bank", "030"],
  ["jaiz bank", "301"],
  ["keystone bank", "082"],
  ["kuda", "50211"],
  ["kuda microfinance bank", "50211"],
  ["moniepoint", "50515"],
  ["moniepoint mfb", "50515"],
  ["opay", "999992"],
  ["palmpay", "999991"],
  ["polaris bank", "076"],
  ["providus bank", "101"],
  ["stanbic ibtc", "221"],
  ["standard chartered", "068"],
  ["sterling bank", "232"],
  ["titan trust bank", "102"],
  ["uba", "033"],
  ["united bank for africa", "033"],
  ["union bank", "032"],
  ["unity bank", "215"],
  ["wema bank", "035"],
  ["zenith bank", "057"],
];

function normalizeBankNameForMatch(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(plc|ltd|limited|ng|nigeria|nigerian|microfinance|mfb|digital|bank|banks)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function guessBankCodeFromName(bankName: string): string | undefined {
  const normalized = normalizeBankNameForMatch(bankName);
  if (!normalized) return undefined;
  for (const [name, code] of NG_BANK_CODE_BY_NAME) {
    const normalizedCandidate = normalizeBankNameForMatch(name);
    if (normalized === normalizedCandidate || normalized.includes(normalizedCandidate) || normalizedCandidate.includes(normalized)) {
      return code;
    }
  }
  return undefined;
}

// ============================================================================
// Loan disbursement execution (shared by POST /admin/loans/:id/disburse and
// POST /admin/disbursements/:id/retry).
//
// The admin's click now WAITS for Flutterwave's real final answer instead of
// receiving an optimistic 202 "submitted and being processed":
//   1. Pre-flight account resolution — a definitive 4xx rejection fails the
//      attempt IMMEDIATELY with the provider's reason (e.g. "Account resolve
//      failed") and no junk transfer is created at Flutterwave. 5xx/network/
//      timeout never block: the provider repeats account resolution during
//      transfer creation anyway.
//   2. Transfer creation (awaited).
//   3. Poll the transfer until a TERMINAL status (up to ~30s) — SUCCESSFUL
//      settles the loan (ACTIVE + ledger + credit history + email), FAILED
//      rolls the loan back to APPROVED for retry, and a budget timeout leaves
//      the row PENDING for the background reconciler to converge.
// ============================================================================
type DisbursementAttemptOutcome = { outcome: "SUCCESSFUL" | "FAILED" | "PENDING"; message: string; error?: string };
type DisbursementAccountView = { accountName?: string; accountNumber?: string; bankCode?: string; bankName?: string };

// Duplicate-disbursement protection: once money has actually left the
// platform for a loan (DISBURSED/ACTIVE and everything downstream of it),
// that loan can NEVER be disbursed again — the admin UI hides the CTA and
// this set backs the API-level guard so a direct API attempt gets a precise
// 409 instead of a second transfer for the same application ID.
const DISBURSED_LIKE_LOAN_STATUSES = new Set(["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "WRITTEN_OFF"]);

function loanAlreadyDisbursed(loan: { status?: string } | undefined | null, application?: { status?: string } | null): boolean {
  const loanStatus = String(loan?.status ?? "").toUpperCase();
  const applicationStatus = String(application?.status ?? "").toUpperCase();
  return DISBURSED_LIKE_LOAN_STATUSES.has(loanStatus) || DISBURSED_LIKE_LOAN_STATUSES.has(applicationStatus);
}

function describeTransferProviderFailure(error: unknown): { message: string; providerResponse: Record<string, unknown> | null } {
  if (error instanceof FlutterwaveError) {
    const payload = error.providerResponse as { message?: string; data?: { complete_message?: string; processor_message?: string } };
    const complete = payload?.data?.complete_message || payload?.data?.processor_message || "";
    const message = `${error.message}${error.httpStatus ? ` (HTTP ${error.httpStatus})` : ""}${complete ? `: ${complete}` : ""}`;
    return { message, providerResponse: error.providerResponse };
  }
  const message = error instanceof Error ? error.message : "Flutterwave transfer unavailable";
  return { message, providerResponse: null };
}

function providerRefsFromResponse(payload: Record<string, unknown> | null): { reference?: string; id?: string } {
  const data = (payload as { data?: { reference?: string; id?: number | string } } | null)?.data;
  if (!data) return {};
  return {
    reference: data.reference ? String(data.reference) : undefined,
    id: data.id !== undefined && data.id !== null ? String(data.id) : undefined,
  };
}

// ---- Admin-ledger helpers (loan disbursement accuracy) ---------------------
// A LOAN_DISBURSEMENT DEBIT is written the moment Flutterwave accepts the
// transfer. If that transfer later FAILS (poll/reconciliation), the debit must
// be reversed — otherwise the ledger double-charges the loan on retry.
function adminLedgerHasEntry(entryType: AdminLedgerEntry["entryType"], referenceId: string, direction: "DEBIT" | "CREDIT"): boolean {
  return adminLedger.some((entry) => entry.entryType === entryType && entry.referenceId === referenceId && entry.direction === direction);
}

function reverseLoanDisbursementLedger(disbursementId: string, loanId: string, borrowerId: string, reason: string): void {
  if (!adminLedgerHasEntry("LOAN_DISBURSEMENT", disbursementId, "DEBIT")) return; // never debited — nothing to reverse
  if (adminLedgerHasEntry("LOAN_DISBURSEMENT_REVERSAL", disbursementId, "CREDIT")) return; // already reversed (idempotent)
  const original = adminLedger.find((entry) => entry.entryType === "LOAN_DISBURSEMENT" && entry.referenceId === disbursementId && entry.direction === "DEBIT");
  appendAdminLedger({
    entryType: "LOAN_DISBURSEMENT_REVERSAL",
    referenceId: disbursementId,
    borrowerId,
    loanId,
    amountMinor: original?.amountMinor ?? 0,
    direction: "CREDIT",
    description: `Admin ledger reversal for failed loan disbursement - loan ${loanId} / disbursement ${disbursementId}`,
    metadata: { reason, loanId, disbursementId },
  });
  schedulePersist();
}

function backfillLoanDisbursementLedger(disbursementId: string, loanId: string, borrowerId: string, amountNaira: number, note: string): void {
  if (adminLedgerHasEntry("LOAN_DISBURSEMENT", disbursementId, "DEBIT")) return;
  appendAdminLedger({
    entryType: "LOAN_DISBURSEMENT",
    referenceId: disbursementId,
    borrowerId,
    loanId,
    amountMinor: Math.round(amountNaira * 100),
    direction: "DEBIT",
    description: `Admin ledger debit for loan disbursement (backfilled) - loan ${loanId}`,
    metadata: { backfilled: true, note },
  });
  schedulePersist();
}

// Account-resolution rejections (“Unknown Bank Code”, “Account resolve failed”,
// unresolvable NUBAN) will NEVER succeed on retry with the same account — flag
// the loan so the admin can ask the customer to re-provide the disbursement
// account and the customer's dashboard shows the urgent-action banner.
function failureLooksLikeAccountProblem(message: string): boolean {
  const haystack = String(message || "").toLowerCase();
  return [
    "unknown bank code",
    "account resolve failed",
    "could not verify the borrower's bank account",
    "could not resolve this account",
    "account_number",
    "account_number_invalid",
    "invalid account",
    "beneficiary account",
    "nuban",
    "account does not exist",
    "no account found",
  ].some((needle) => haystack.includes(needle));
}

function finalizeFailedLoanDisbursement(params: {
  req: AuthRequest;
  loan: (typeof loans)[number];
  application?: (typeof loanApplications)[number] | null;
  disbursement: (typeof loanDisbursements)[number];
  message: string;
  providerResponse: Record<string, unknown> | null;
}): DisbursementAttemptOutcome {
  const { req, loan, application, disbursement, message, providerResponse } = params;
  const now = new Date().toISOString();
  disbursement.status = "FAILED";
  disbursement.error = message;
  if (providerResponse) {
    disbursement.providerTransfer = providerResponse;
    // The provider sometimes registers the transfer even when creation is
    // rejected (HTTP 400 + a FAILED transfer object) — keep its reference for
    // reconciliation so a later retry never collides with it.
    const refs = providerRefsFromResponse(providerResponse);
    if (!disbursement.providerReference) disbursement.providerReference = refs.reference ?? refs.id;
  }
  disbursement.processedAt = now;
  disbursement.updatedAt = now;
  // Ledger accuracy: if the transfer had already been accepted (and the admin
  // ledger debited) before failing, reverse the debit so the ledger reflects
  // that the money never left — and a retry does not double-charge.
  reverseLoanDisbursementLedger(disbursement.id, loan.id, loan.borrowerId, message);
  // If the provider rejected the borrower's ACCOUNT itself, mark the loan so
  // the admin gets a one-click CTA and the borrower sees the urgent banner.
  if (failureLooksLikeAccountProblem(message)) {
    loan.disbursementAccountNeedsUpdate = true;
    loan.disbursementAccountRequestedAt = loan.disbursementAccountRequestedAt ?? now;
  }
  // Give the loan back to the admin so the disbursement can be retried.
  if (loan.status === "DISBURSEMENT_PENDING") {
    loan.status = "APPROVED";
    loan.updatedAt = now;
  }
  recordAdminAudit(req, "LOAN_DISBURSEMENT_FAILED", "LOAN", loan.id, { applicationId: application?.applicationId, disbursementId: disbursement.id, retryCount: Number(disbursement.retryCount ?? 0), error: message, accountNeedsUpdate: loan.disbursementAccountNeedsUpdate === true });
  schedulePersist();
  return { outcome: "FAILED", message, error: message };
}

async function executeLoanTransferAttempt(params: {
  req: AuthRequest;
  loan: (typeof loans)[number];
  application?: (typeof loanApplications)[number] | null;
  disbursement: (typeof loanDisbursements)[number];
  account: DisbursementAccountView;
  narration: string;
  txRef: string;
}): Promise<DisbursementAttemptOutcome> {
  const { req, loan, application, disbursement, narration, txRef } = params;
  const amountNaira = Number(disbursement.amountNaira ?? loan.principalNaira);
  // Bank-code normalization: accounts saved with legacy/foreign-convention codes
  // (e.g. Paystack-style 999992 for OPay) made Flutterwave reject transfers with
  // "Unknown Bank Code". Re-map the code against Flutterwave's live bank list
  // (by stored bank name / legacy alias) BEFORE resolving or transferring, and
  // persist the corrected code so every later attempt uses it too.
  let account = { ...params.account };
  try {
    const normalizedCode = await normalizeBankCodeForFlutterwave(String(account.bankCode ?? ""), account.bankName);
    if (normalizedCode && normalizedCode !== String(account.bankCode ?? "")) {
      console.info(`[routes] disbursement ${disbursement.id}: bank code remapped ${account.bankCode} -> ${normalizedCode} (${account.bankName ?? "name unknown"})`);
      const nowRemap = new Date().toISOString();
      account = { ...account, bankCode: normalizedCode };
      disbursement.bankCode = normalizedCode;
      disbursement.updatedAt = nowRemap;
      const savedAccountRow = disbursementAccounts.find((item) => item.borrowerId === loan.borrowerId);
      if (savedAccountRow && savedAccountRow.bankCode !== normalizedCode) {
        savedAccountRow.bankCode = normalizedCode;
        savedAccountRow.updatedAt = nowRemap;
      }
      if (application?.disbursementAccount && (application.disbursementAccount as Record<string, unknown>).bankCode) {
        (application.disbursementAccount as unknown as Record<string, unknown>).bankCode = normalizedCode;
        application.updatedAt = nowRemap;
      }
      schedulePersist();
    }
  } catch (remapError) {
    console.warn(`[routes] disbursement ${disbursement.id}: bank-code normalization skipped (${remapError instanceof Error ? remapError.message : "unknown"})`);
  }
  const accountLabel = `${account.bankName || account.bankCode || "bank"} · ${account.accountNumber ? `••••${String(account.accountNumber).slice(-4)}` : "—"}`;

  // ---- Step 1: pre-flight beneficiary account resolution (fail fast).
  try {
    await resolveBankAccount(String(account.accountNumber ?? ""), String(account.bankCode ?? ""), account.bankName);
  } catch (resolveError) {
    const httpStatus = (resolveError as { httpStatus?: number }).httpStatus;
    const providerResponse = (resolveError as { providerResponse?: Record<string, unknown> }).providerResponse ?? null;
    const providerMsg = resolveError instanceof Error ? resolveError.message : "Account resolve failed";
    const definitive = typeof httpStatus === "number" && httpStatus >= 400 && httpStatus < 500;
    if (definitive) {
      const message = `Flutterwave could not verify the borrower's bank account (${accountLabel}): ${providerMsg}. Confirm the account number and bank, then retry the disbursement.`;
      console.error(`[routes] disbursement ${disbursement.id} pre-resolve rejected: ${message}`);
      return finalizeFailedLoanDisbursement({ req, loan, application, disbursement, message, providerResponse: providerResponse ?? { message: providerMsg } });
    }
    console.warn(`[routes] disbursement ${disbursement.id} pre-resolve unavailable (HTTP ${httpStatus ?? "network"}); proceeding — Flutterwave validates the account during transfer creation.`);
  }

  // ---- Step 2: create the transfer (awaited — the admin is waiting).
  try {
    const transfer = await createLoanDisbursement({
      txRef,
      amountNaira,
      accountNumber: String(account.accountNumber ?? ""),
      accountBank: String(account.bankCode ?? ""),
      beneficiaryName: account.accountName ?? "Borrower",
      narration,
    });
    if (String((transfer as { status?: string }).status ?? "").toLowerCase() !== "success") {
      throw new Error((transfer as { message?: string }).message || "Flutterwave did not accept the disbursement transfer");
    }
    appendAdminLedger({
      entryType: "LOAN_DISBURSEMENT",
      referenceId: disbursement.id,
      borrowerId: loan.borrowerId,
      loanId: loan.id,
      amountMinor: Math.round(amountNaira * 100),
      direction: "DEBIT",
      description: `Admin ledger debit for loan disbursement - loan ${loan.id} / application ${application?.applicationId ?? loan.id}`,
      metadata: { provider: "flutterwave", applicationId: application?.applicationId, accountBank: account.bankCode, retryOfId: disbursement.retryOfId ?? null },
    });
    const providerTransfer = transfer as unknown as Record<string, unknown>;
    const createdRefs = providerRefsFromResponse(providerTransfer);
    disbursement.providerTransfer = providerTransfer;
    disbursement.providerReference = createdRefs.reference ?? createdRefs.id ?? disbursement.id;
    disbursement.status = "PENDING";
    disbursement.processedAt = new Date().toISOString();
    disbursement.updatedAt = disbursement.processedAt;
    loan.providerTransfer = providerTransfer;
    loan.updatedAt = new Date().toISOString();
    schedulePersist();

    // ---- Step 3: wait for the provider's FINAL answer (up to ~30s).
    const verification = await pollTransferUntilTerminal(
      createdRefs.id ?? "",
      String(disbursement.providerReference ?? ""),
      amountNaira,
      { budgetMs: 30_000, intervalMs: 3_000 }
    );
    if (verification.settled) {
      const settledAt = new Date().toISOString();
      loan.status = "ACTIVE";
      loan.disbursedAt = settledAt;
      loan.updatedAt = settledAt;
      // Money actually landed — any outstanding account-update attention flag
      // is now moot.
      loan.disbursementAccountNeedsUpdate = false;
      if (application) {
        // Canonical post-disbursement lifecycle status is ACTIVE (not DISBURSED).
        application.status = "ACTIVE";
        application.updatedAt = settledAt;
      }
      loan.providerReference = String(verification.data?.id ?? verification.data?.flw_ref ?? disbursement.providerReference);
      disbursement.status = "SUCCESSFUL";
      disbursement.processedAt = settledAt;
      disbursement.updatedAt = settledAt;
      creditHistory.push({ id: randomUUID(), userId: loan.borrowerId, loanId: loan.id, eventType: "LOAN_DISBURSED", detail: `Disbursement confirmed via Flutterwave ${loan.providerReference}`, occurredAt: settledAt, createdAt: settledAt });
      recordAdminAudit(req, "LOAN_DISBURSED", "LOAN", loan.id, { applicationId: application?.applicationId, principalNaira: amountNaira, providerReference: loan.providerReference, disbursementId: disbursement.id, retryCount: Number(disbursement.retryCount ?? 0) });
      const borrower = users.find((user) => user.id === loan.borrowerId);
      if (borrower) {
        const template = loanDisbursedEmail({ name: borrower.fullName, applicationId: application?.applicationId ?? loan.id, amountNaira });
        void sendEmail({ to: borrower.email, name: borrower.fullName, ...template }).catch(() => undefined);
      }
      schedulePersist();
      return { outcome: "SUCCESSFUL", message: `Disbursement successful. ₦${amountNaira.toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} sent to ${account.accountName ?? "the borrower"} (${accountLabel}).` };
    }
    if (verification.failed) {
      const complete = String(verification.data?.complete_message || verification.data?.processor_message || verification.status || "transfer failed");
      const message = `Flutterwave could not complete the transfer: ${complete}. Review the provider response, confirm the borrower's account details, then retry the disbursement.`;
      console.error(`[routes] disbursement ${disbursement.id} failed at provider: ${complete}`);
      return finalizeFailedLoanDisbursement({ req, loan, application, disbursement, message, providerResponse: (verification.raw as Record<string, unknown>) ?? { message: complete } });
    }
    // Budget exhausted — the provider is still moving. The row stays PENDING;
    // the background reconciler converges it and the admin UI reflects it.
    schedulePersist();
    return { outcome: "PENDING", message: "Disbursement submitted to Flutterwave and is still being processed. The final status is confirmed automatically and this loan updates within a few minutes." };
  } catch (error) {
    const { message, providerResponse } = describeTransferProviderFailure(error);
    console.error(`[routes] disbursement ${disbursement.id} creation failed: ${message}`);
    return finalizeFailedLoanDisbursement({ req, loan, application, disbursement, message, providerResponse });
  }
}

// Converge disbursement rows that never reached a terminal state (e.g. the
// server restarted mid-poll, or verification kept timing out). Runs as a
// fire-and-forget sweep on the admin disbursements listing — at most once per
// ~90s per row — so the admin UI self-heals without a manual reconcile.
const DISBURSEMENT_RECONCILE_MIN_AGE_MS = 90_000;
const disbursementReconcileAttempts = new Map<string, number>();
async function reconcileStaleDisbursements(): Promise<void> {
  const nowMs = Date.now();
  const stale = loanDisbursements.filter((d) => {
    if (!["PROCESSING", "PENDING"].includes(d.status)) return false;
    const ageMs = nowMs - new Date(d.updatedAt ?? d.createdAt ?? nowMs).getTime();
    if (ageMs <= DISBURSEMENT_RECONCILE_MIN_AGE_MS) return false;
    return nowMs - (disbursementReconcileAttempts.get(d.id) ?? 0) > DISBURSEMENT_RECONCILE_MIN_AGE_MS;
  });
  for (const row of stale) {
    disbursementReconcileAttempts.set(row.id, nowMs);
    const loan = loans.find((l) => l.id === row.loanId);
    if (!loan) continue;
    const application = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
    const payload = row.providerTransfer as { data?: { id?: number | string } } | null | undefined;
    const providerId = String(payload?.data?.id ?? "");
    const reference = String(row.providerReference ?? "");
    if (!providerId && !reference) {
      // The transfer was never submitted (the process died between row creation
      // and provider call) — after a grace period, fail it so the loan can be
      // retried instead of being stuck in DISBURSEMENT_PENDING forever.
      const ageMs = nowMs - new Date(row.createdAt ?? nowMs).getTime();
      if (ageMs > 10 * 60_000) {
        finalizeFailedLoanDisbursement({
          req: { user: { id: "system", role: "ADMIN" } } as unknown as AuthRequest,
          loan, application, disbursement: row,
          message: "This transfer was never submitted to Flutterwave (the server restarted mid-disbursement). Retry the disbursement.",
          providerResponse: null,
        });
      }
      continue;
    }
    const verification = await pollTransferUntilTerminal(providerId, reference, Number(row.amountNaira), { budgetMs: 8_000, intervalMs: 2_000 });
    if (verification.settled) {
      const settledAt = new Date().toISOString();
      loan.status = "ACTIVE";
      loan.disbursedAt = loan.disbursedAt ?? settledAt;
      loan.updatedAt = settledAt;
      loan.disbursementAccountNeedsUpdate = false;
      if (application) {
        application.status = "ACTIVE";
        application.updatedAt = settledAt;
      }
      row.status = "SUCCESSFUL";
      row.error = null;
      row.processedAt = settledAt;
      row.updatedAt = settledAt;
      // Ledger accuracy: if the process died between transfer creation and the
      // ledger write, backfill the LOAN_DISBURSEMENT debit now so every settled
      // disbursement is represented exactly once on the admin ledger.
      backfillLoanDisbursementLedger(row.id, loan.id, loan.borrowerId, Number(row.amountNaira), `reconciled via Flutterwave ${reference || providerId}`);
      creditHistory.push({ id: randomUUID(), userId: loan.borrowerId, loanId: loan.id, eventType: "LOAN_DISBURSED", detail: `Disbursement confirmed via Flutterwave reconciliation (${reference || providerId})`, occurredAt: settledAt, createdAt: settledAt });
      schedulePersist();
    } else if (verification.failed) {
      const complete = String(verification.data?.complete_message || verification.data?.processor_message || verification.status || "transfer failed");
      finalizeFailedLoanDisbursement({
        req: { user: { id: "system", role: "ADMIN" } } as unknown as AuthRequest,
        loan, application, disbursement: row,
        message: `Flutterwave could not complete the transfer: ${complete} (confirmed during reconciliation).`,
        providerResponse: (verification.raw as Record<string, unknown>) ?? { message: complete },
      });
    } else {
      // Still moving — touch updatedAt so the sweep waits another window.
      row.updatedAt = new Date().toISOString();
      schedulePersist();
    }
  }
}

router.post("/admin/loans/:loanId/disburse", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.applicationId === application?.id || l.id === req.params.loanId);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan record not found. Approve the application first." });
    return;
  }
  // HARD duplicate-disbursement guard: a loan that has already been disbursed
  // and is now live can never be disbursed again. The admin UI hides the CTA
  // for these statuses; this is the API backstop so a direct attempt returns
  // a precise 409 instead of pushing a second transfer out of the door.
  if (loanAlreadyDisbursed(loan, application)) {
    res.status(409).json({
      ok: false,
      code: "ALREADY_DISBURSED",
      error: "Loan already disbursed and active, can't disburse duplicate loan.",
    });
    return;
  }
  if (application && application.manualDecision !== "APPROVED") {
    res.status(409).json({ ok: false, error: "Loan manager approval is required before disbursement" });
    return;
  }
  // KYC gate: the borrower's identity verification must be complete before
  // funds leave the platform. Admin sees a precise reason instead of a
  // provider failure after the fact.
  if (!userKycVerified(loan.borrowerId)) {
    const borrower = users.find((u) => u.id === loan.borrowerId);
    res.status(409).json({
      ok: false,
      code: "KYC_REQUIRED",
      error: `KYC verification is not complete for this borrower${borrower ? ` (${borrower.fullName})` : ""}. The borrower must complete and be approved on identity verification before this loan can be disbursed.`,
    });
    return;
  }
  const snapshot = (application?.customerSnapshot ?? {}) as {
    fullName?: string;
    disbursementAccount?: { accountName?: string; accountNumber?: string; bankCode?: string; bankName?: string };
  };
  const savedAccount = disbursementAccounts.find((item) => item.borrowerId === loan.borrowerId);
  // Resolution order (widest possible so an application-submitted account is
  // ALWAYS picked up): saved ACTIVE account -> the account captured on the
  // application itself (top-level or customerSnapshot) -> saved account that
  // merely lacks ACTIVE status (it exists and was verified at submission).
  type AccountView = { accountName?: string; accountNumber?: string; bankCode?: string; bankName?: string };
  const asAccountView = (value: unknown): AccountView | null =>
    value && typeof value === "object" ? (value as AccountView) : null;
  const snapshotAccount =
    asAccountView(snapshot.disbursementAccount?.accountNumber ? snapshot.disbursementAccount : null) ??
    asAccountView(application?.disbursementAccount) ??
    asAccountView(snapshot.disbursementAccount);
  const applicationAccount: AccountView | null = snapshotAccount;
  // Some legacy applications captured a bankName but no bankCode (older draft
  // normalizer dropped it) — recover the code from the bank name when possible.
  const bankCodeFromName = applicationAccount && !applicationAccount.bankCode && applicationAccount.bankName
    ? guessBankCodeFromName(applicationAccount.bankName)
    : undefined;
  const applicationAccountNumber = applicationAccount?.accountNumber ? String(applicationAccount.accountNumber) : "";
  const applicationBankCode = applicationAccount?.bankCode ? String(applicationAccount.bankCode) : "";
  const applicationBankName = applicationAccount?.bankName ? String(applicationAccount.bankName) : undefined;
  const applicationAccountName = applicationAccount?.accountName ? String(applicationAccount.accountName) : "";
  const candidateFromApplication = applicationAccountNumber && (applicationBankCode || bankCodeFromName)
    ? {
        accountName: applicationAccountName || snapshot.fullName || "Borrower",
        accountNumber: applicationAccountNumber,
        bankCode: (applicationBankCode || bankCodeFromName)!,
        bankName: applicationBankName,
      }
    : null;
  const account = savedAccount?.status === "ACTIVE"
    ? savedAccount
    : candidateFromApplication
      ? candidateFromApplication
      : savedAccount?.accountNumber && savedAccount.bankCode
        ? savedAccount
        : null;
  if (!account) {
    res.status(400).json({
      ok: false,
      error: "No disbursement account found for this borrower. The loan application must carry a complete disbursement account, or the borrower must add one from their dashboard (Disbursement section) — it will attach to this loan automatically.",
    });
    return;
  }
  // Promote the application-captured account to the borrower's saved account so
  // future disbursements (and the settings UI) see one consistent record.
  if (!savedAccount && candidateFromApplication && account === candidateFromApplication) {
    const nowPromote = new Date().toISOString();
    disbursementAccounts.push({
      id: randomUUID(),
      borrowerId: loan.borrowerId,
      accountName: candidateFromApplication.accountName,
      accountNumber: candidateFromApplication.accountNumber,
      bankCode: candidateFromApplication.bankCode,
      bankName: candidateFromApplication.bankName,
      status: "ACTIVE",
      createdAt: nowPromote,
      updatedAt: nowPromote,
      rejectionReason: null,
    } as (typeof disbursementAccounts)[number]);
  }
  const existingTransfer = loanDisbursements.find((item) => item.loanId === loan.id && ["PROCESSING", "PENDING", "SUCCESSFUL"].includes(item.status));
  if (existingTransfer) {
    res.status(409).json({ ok: false, error: "A disbursement is already in progress or completed for this loan" });
    return;
  }
  try {
    const now = new Date().toISOString();
    const disbursement: (typeof import("./store.js").loanDisbursements)[number] = {
      id: randomUUID(),
      loanId: loan.id,
      applicationId: application?.id,
      borrowerId: loan.borrowerId,
      amountNaira: Number(loan.principalNaira),
      currency: "NGN",
      bankCode: account.bankCode,
      accountNumber: account.accountNumber,
      accountName: account.accountName ?? snapshot.fullName,
      bankName: account.bankName ?? account.bankCode,
      status: "PROCESSING",
      narration: `Velo loan disbursement ${application?.applicationId ?? loan.id}`,
      retryCount: 0,
      retryOfId: null,
      createdAt: now,
      updatedAt: now,
      providerTransfer: null,
      providerReference: null,
      error: null,
    };
    loanDisbursements.push(disbursement);
    loan.status = "DISBURSEMENT_PENDING";
    loan.updatedAt = now;
    schedulePersist();
    recordAdminAudit(req, "LOAN_DISBURSEMENT_INITIATED", "LOAN", loan.id, { applicationId: application?.applicationId, principalNaira: Number(loan.principalNaira), disbursementId: disbursement.id });

    // SYNCHRONOUS execution: the admin's click waits for Flutterwave's real
    // final answer (pre-resolve -> create transfer -> poll to terminal, up to
    // ~30s) and THIS response carries the actual provider outcome — no more
    // optimistic "submitted and being processed" when the transfer in fact
    // failed. A second click meanwhile 409s on the PROCESSING/PENDING guard
    // above, so the loan can never be double-disbursed.
    const result = await executeLoanTransferAttempt({
      req,
      loan,
      application,
      disbursement,
      account: {
        accountName: account.accountName ?? snapshot.fullName,
        accountNumber: account.accountNumber,
        bankCode: account.bankCode,
        bankName: account.bankName ?? account.bankCode,
      },
      narration: `Velo loan disbursement ${application?.applicationId ?? loan.id}`,
      txRef: `VELO-DISBURSE-${loan.id}-${disbursement.id.slice(0, 8)}`,
    });

    if (result.outcome === "FAILED") {
      res.status(200).json({ ok: false, final: true, loan, disbursement, error: result.error, message: result.message });
    } else if (result.outcome === "PENDING") {
      res.status(202).json({ ok: true, final: false, loan, disbursement, message: result.message });
    } else {
      res.status(200).json({ ok: true, final: true, loan, disbursement, message: result.message });
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Unable to initiate disbursement";
    res.status(503).json({
      ok: false,
      error: errMsg,
    });
  }
});

// ---------------- Admin CTA: ask the customer to re-provide the disbursement
// account. Used when Flutterwave rejected the saved account (the loan cannot
// be disbursed until the customer updates it from their Settings). The
// customer's dashboard then shows an "urgent attention" banner and their
// disbursement-account form is unlocked; the update applies IMMEDIATELY
// (auto-approved) and is mapped onto this loan automatically.
router.post("/admin/loans/:loanId/request-account-update", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.applicationId === application?.id || l.id === req.params.loanId);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan record not found" });
    return;
  }
  const schema = z.object({
    note: z.string().max(500).optional(),
    clear: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const now = new Date().toISOString();
  const borrower = users.find((u) => u.id === loan.borrowerId);
  if (parsed.data.clear) {
    clearBorrowerAccountUpdateFlags(loan.borrowerId);
    schedulePersist();
    recordAdminAudit(req, "DISBURSEMENT_ACCOUNT_UPDATE_CLEARED", "LOAN", loan.id, { borrowerId: loan.borrowerId });
    res.json({ ok: true, loan, updateRequested: false, message: "Account-update request cleared for this borrower." });
    return;
  }
  loan.disbursementAccountNeedsUpdate = true;
  loan.disbursementAccountRequestedAt = now;
  loan.updatedAt = now;
  recordAdminAudit(req, "DISBURSEMENT_ACCOUNT_UPDATE_REQUESTED", "LOAN", loan.id, {
    borrowerId: loan.borrowerId,
    applicationId: application?.applicationId,
    principalNaira: Number(loan.principalNaira),
    note: parsed.data.note ?? null,
  });
  if (borrower) {
    const template = disbursementAccountUpdateRequestedEmail({
      name: borrower.fullName,
      applicationId: application?.applicationId ?? loan.id,
      amountNaira: Number(loan.principalNaira),
      note: parsed.data.note,
    });
    void sendEmail({ to: borrower.email, name: borrower.fullName, ...template }).catch(() => undefined);
    notifications.push({
      id: randomUUID(),
      userId: borrower.id,
      channel: "EMAIL" as const,
      kind: "DISBURSEMENT_ACCOUNT_UPDATE_REQUESTED" as const,
      subject: template.subject,
      recipientMasked: borrower.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
      status: "SENT",
      retryCount: 0,
      relatedEntityType: "LOAN",
      relatedEntityId: loan.id,
      createdAt: now,
      sentAt: now,
    });
  }
  schedulePersist();
  res.json({
    ok: true,
    loan,
    updateRequested: true,
    message: borrower
      ? `Requested. ${borrower.fullName} has been notified by email and will see an urgent banner on their dashboard — their account update will attach to this loan automatically.`
      : "Requested. The borrower will see the urgent banner on their dashboard.",
  });
});

router.get("/admin/investment-plans", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, plans: investmentPlans });
});

router.post("/admin/investment-plans", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    minAmountNaira: z.number().positive(),
    maxAmountNaira: z.number().positive(),
    tenureDays: z.number().int().positive(),
    annualRatePercent: z.number().nonnegative(),
    rateType: z.enum(["ANNUALIZED", "FLAT", "TENURE_SPECIFIC"]).default("ANNUALIZED"),
    earlyLiquidityAllowed: z.boolean().default(false),
    earlyLiquidityFeePercent: z.number().nonnegative().default(0),
    gatewayFeePercent: z.number().nonnegative().default(0),
    forfeitInterestOnEarlyExit: z.boolean().default(false),
    capacityNaira: z.number().positive().optional(),
    isActive: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const now = new Date().toISOString();
  const plan: (typeof investmentPlans)[number] = {
    id: randomUUID(),
    currency: "NGN",
    allowNewInvestmentsAfterClose: false,
    version: 1,
    effectiveFrom: now,
    createdAt: now,
    ...parsed.data,
  };
  investmentPlans.push(plan);
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, plan });
});

router.patch("/admin/investment-plans/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const plan = investmentPlans.find((p) => p.id === req.params.id);
  if (!plan) {
    res.status(404).json({ ok: false, error: "Investment plan not found" });
    return;
  }
  const schema = z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    minAmountNaira: z.number().positive().optional(),
    maxAmountNaira: z.number().positive().optional(),
    annualRatePercent: z.number().nonnegative().optional(),
    earlyLiquidityAllowed: z.boolean().optional(),
    earlyLiquidityFeePercent: z.number().nonnegative().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  plan.version += 1;
  plan.updatedAt = new Date().toISOString();
  Object.assign(plan, parsed.data);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, plan });
});

router.get("/admin/reconciliation", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const providerEventsPending = providerEvents.filter((e) => !(e as { processed?: boolean }).processed);
  const unverifiedDeposits = walletTransactions.filter((t) => t.type === "DEPOSIT" && ["PENDING", "PENDING_PROVIDER_CONFIRMATION"].includes(String(t.status)));
  const unverifiedRepayments = repayments.filter((r) => r.status === "PENDING_PROVIDER_CONFIRMATION");
  const pendingPayouts = payouts.filter((p) => ["PENDING_PROVIDER_CONFIRMATION", "FAILED"].includes(p.status));
  const pendingWithdrawals = investorWithdrawals.filter((w) => ["PENDING", "PROCESSING", "FAILED"].includes(w.status));
  res.json({ ok: true, guide: { providerEvents: "Webhook/provider callbacks not marked processed; match by provider event ID and provider reference.", unverifiedDeposits: "Wallet deposit requests awaiting provider confirmation; match txRef, amount, currency and provider transaction ID.", unverifiedRepayments: "Loan repayment requests awaiting provider confirmation; match loan ID, borrower, amount and provider reference.", pendingPayouts: "Investment payouts awaiting provider settlement or needing retry; match payout ID, investor, amount and provider reference.", pendingWithdrawals: "Investor withdrawals whose wallet funds remain held until the provider confirms success or failure; match withdrawal ID, investor, net amount and provider reference." }, providerEvents: providerEventsPending, unverifiedDeposits, unverifiedRepayments, pendingPayouts, pendingWithdrawals, totals: { providerEvents: providerEventsPending.length, unverifiedDeposits: unverifiedDeposits.length, unverifiedRepayments: unverifiedRepayments.length, pendingPayouts: pendingPayouts.length, pendingWithdrawals: pendingWithdrawals.length } });
});

router.get("/admin/reports", requireAuth, requireRole("ADMIN"), (req, res) => {
  const from = (req.query.from as string) ?? new Date(0).toISOString();
  const to = (req.query.to as string) ?? new Date().toISOString();
  const inRange = (t: string) => t >= from && t <= to;
  res.json({
    ok: true,
    range: { from, to },
    currency: "NGN",
    timezone: "Africa/Lagos",
    investments: {
      count: investments.filter((i) => inRange(i.createdAt)).length,
      principal: investments.filter((i) => inRange(i.createdAt)).reduce((s, i) => s + Number(i.amountNaira ?? 0), 0),
      expectedReturns: investments.filter((i) => inRange(i.createdAt)).reduce((s, i) => s + Number(i.expectedEarningsNaira ?? 0), 0),
      maturedCount: investments.filter((i) => i.status === "PAID_OUT" && i.maturesAt && inRange(i.maturesAt)).length,
      payoutFailures: payouts.filter((p) => p.status === "FAILED" && inRange(p.createdAt)).length,
    },
    loans: {
      applications: loanApplications.filter((l) => inRange(l.createdAt)).length,
      approved: loanApplications.filter((l) => l.status === "APPROVED" || (l.manualDecision === "APPROVED" && inRange(l.createdAt))).length,
      disbursedPrincipal: loans.filter((l) => l.disbursedAt && inRange(l.disbursedAt)).reduce((s, l) => s + Number(l.principalNaira ?? 0), 0),
      repaidTotal: repayments.filter((r) => r.status === "SUCCESSFUL" && inRange(r.createdAt)).reduce((s, r) => s + Number(r.amountNaira ?? 0), 0),
      defaults: loans.filter((l) => l.status === "DEFAULTED" && inRange(l.updatedAt ?? l.createdAt)).length,
    },
    kyc: {
      submitted: kycCases.filter((k) => k.submittedAt && inRange(k.submittedAt)).length,
      verified: kycCases.filter((k) => k.status === "VERIFIED" && k.reviewedAt && inRange(k.reviewedAt)).length,
      rejected: kycCases.filter((k) => k.status === "REJECTED" && k.reviewedAt && inRange(k.reviewedAt)).length,
    },
  });
});

router.get("/me/notifications", requireAuth, (req: AuthRequest, res) => {
  const userNotifications = notifications
    .filter((n) => n.userId === req.user?.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ ok: true, notifications: userNotifications });
});

router.get("/me/consents", requireAuth, (req: AuthRequest, res) => {
  res.json({
    ok: true,
    consents: consents.filter((c) => c.userId === req.user?.id),
  });
});

router.post("/consents", requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    consentType: z.enum([
      "TERMS", "PRIVACY", "IDENTITY_VERIFICATION", "CREDIT_REPORT",
      "ELECTRONIC_COMMUNICATIONS", "INVESTMENT_AGREEMENT", "LOAN_AGREEMENT",
    ]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const consent = recordConsent(req.user!.id, parsed.data.consentType);
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, consent });
});

router.get("/admin/loan-products", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  // Self-heal duplicates so the admin sees the authoritative catalog (this is
  // also what the borrower endpoint serves from — one source of truth).
  if (normalizeLoanProducts()) {
    console.warn("[routes] admin/loan-products removed duplicated product rows from the in-memory catalog");
    void persistStore().catch(() => undefined);
    void purgeGhostCatalogRows();
  }
  // Same partial-boot guarantee as the borrower endpoint: the admin console
  // must never render an empty catalog just because hydration raced.
  if (loanProducts.length === 0) {
    await ensureLoanProductsLoaded();
    if (normalizeLoanProducts()) void persistStore().catch(() => undefined);
  }
  res.json({
    ok: true,
    products: loanProducts,
    activeCount: loanProducts.filter((p) => p.isActive).length,
  });
});

router.post("/admin/loan-products", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    programType: z.enum(["PERSONAL", "BUSINESS", "BOTH"]).nullable().optional(),
    minAmountNaira: z.number().positive(),
    maxAmountNaira: z.number().positive(),
    defaultAmountNaira: z.number().positive().optional(),
    defaultTenureDays: z.number().int().positive().optional(),
    tenureDays: z.array(z.number().int().positive()).max(24).optional(),
    tenorInterestRates: z.array(z.object({
      tenorDays: z.number().int().positive(),
      monthlyRatePercent: z.number().min(0),
    })).max(24).optional(),
    interestRatePercent: z.number().nonnegative(),
    interestType: z.enum(["SIMPLE_FLAT", "REDUCING_BALANCE", "ANNUALIZED"]).default("SIMPLE_FLAT"),
    processingFeePercent: z.number().nonnegative().default(2),
    serviceFeePercent: z.number().nonnegative().default(0),
    lateFeePercent: z.number().nonnegative().default(1),
    lateFeeType: z.enum(["ONE_TIME", "COMPOUNDING_DAILY", "COMPOUNDING_MONTHLY"]).default("COMPOUNDING_DAILY"),
    gracePeriodDays: z.number().int().nonnegative().default(3),
    collateralEnabled: z.boolean().default(true),
    collateralRequired: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
    // Cross-field guard: a product with min >= max would seed every borrower
    // screen with an impossible range (this is how the ₦200-vs-₦50,000 class of
    // bugs used to slip through). Reject at the API boundary.
    .refine((data) => data.minAmountNaira < data.maxAmountNaira, {
      message: "minAmountNaira must be less than maxAmountNaira",
      path: ["minAmountNaira"],
    })
    .refine((data) => data.defaultAmountNaira === undefined || (data.defaultAmountNaira >= data.minAmountNaira && data.defaultAmountNaira <= data.maxAmountNaira), {
      message: "defaultAmountNaira must fall within the min/max range",
      path: ["defaultAmountNaira"],
    })
    .refine((data) => data.tenureDays === undefined || data.tenureDays.length === 0 || data.defaultTenureDays === undefined || data.tenureDays.includes(data.defaultTenureDays), {
      message: "defaultTenureDays must be one of the allowed tenureDays",
      path: ["defaultTenureDays"],
    })
    // A per-tenor rate can only pin a tenor the product actually offers —
    // otherwise the admin would configure a rate borrowers can never select.
    .refine((data) => {
      if (!data.tenorInterestRates || data.tenorInterestRates.length === 0) return true;
      if (!data.tenureDays || data.tenureDays.length === 0) return true;
      const allowed = new Set(data.tenureDays.map((d) => Math.trunc(Number(d))));
      return data.tenorInterestRates.every((entry) => allowed.has(Math.trunc(Number(entry.tenorDays))));
    }, {
      message: "tenorInterestRates entries must reference tenors from the tenureDays list",
      path: ["tenorInterestRates"],
    });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  // Duplicate-name guard: two products with the same name (case-insensitive)
  // make the borrower's product-type filtering ambiguous — the borrower
  // application flow maps products to PERSONAL/BUSINESS programs by name.
  const normalizedName = parsed.data.name.trim().toLowerCase();
  const duplicate = loanProducts.find((p) => p.name.trim().toLowerCase() === normalizedName);
  if (duplicate) {
    res.status(409).json({
      ok: false,
      error: { formErrors: [`A loan product named "${duplicate.name}" already exists. Edit that product instead of creating a duplicate.`], fieldErrors: { name: ["A loan product with this name already exists."] } },
    });
    return;
  }
  const now = new Date().toISOString();
  const { tenureDays, tenorInterestRates, ...rest } = parsed.data;
  const product: (typeof loanProducts)[number] = {
    id: randomUUID(),
    version: 1,
    createdAt: now,
    ...rest,
    ...(tenureDays && tenureDays.length > 0 ? { tenureDays: normalizeTenureDays(tenureDays) } : {}),
    ...(tenorInterestRates && tenorInterestRates.length > 0 ? { tenorInterestRates: normalizeTenorInterestRates(tenorInterestRates) } : {}),
  };
  loanProducts.push(product);
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, product });
});

router.patch("/admin/loan-products/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const product = loanProducts.find((p) => p.id === req.params.id);
  if (!product) {
    res.status(404).json({ ok: false, error: "Loan product not found" });
    return;
  }
  const schema = z.object({
    name: z.string().min(2).optional(),
    description: z.string().optional(),
    programType: z.enum(["PERSONAL", "BUSINESS", "BOTH"]).nullable().optional(),
    minAmountNaira: z.number().positive().optional(),
    maxAmountNaira: z.number().positive().optional(),
    defaultAmountNaira: z.number().positive().nullable().optional(),
    defaultTenureDays: z.number().int().positive().optional(),
    tenureDays: z.array(z.number().int().positive()).max(24).optional(),
    tenorInterestRates: z.array(z.object({
      tenorDays: z.number().int().positive(),
      monthlyRatePercent: z.number().min(0),
    })).max(24).nullable().optional(),
    interestRatePercent: z.number().nonnegative().optional(),
    interestType: z.enum(["SIMPLE_FLAT", "REDUCING_BALANCE", "ANNUALIZED"]).optional(),
    processingFeePercent: z.number().nonnegative().optional(),
    serviceFeePercent: z.number().nonnegative().optional(),
    lateFeePercent: z.number().nonnegative().optional(),
    lateFeeType: z.enum(["ONE_TIME", "COMPOUNDING_DAILY", "COMPOUNDING_MONTHLY"]).optional(),
    gracePeriodDays: z.number().int().nonnegative().optional(),
    collateralEnabled: z.boolean().optional(),
    collateralRequired: z.boolean().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  // Renaming to another product's name would recreate the ambiguous catalog
  // (two products mapping to one borrower program), so reject collisions.
  if (parsed.data.name !== undefined) {
    const normalizedName = parsed.data.name.trim().toLowerCase();
    const collision = loanProducts.find((p) => p.id !== product.id && p.name.trim().toLowerCase() === normalizedName);
    if (collision) {
      res.status(409).json({
        ok: false,
        error: { formErrors: [`Another loan product named "${collision.name}" already exists.`], fieldErrors: { name: ["A loan product with this name already exists."] } },
      });
      return;
    }
  }
  // Cross-field guard on the MERGED product: validate the effective min/max
  // after applying the patch so a partial update cannot invert the range.
  const effectiveMin = parsed.data.minAmountNaira ?? product.minAmountNaira;
  const effectiveMax = parsed.data.maxAmountNaira ?? product.maxAmountNaira;
  if (!(effectiveMin < effectiveMax)) {
    res.status(400).json({
      ok: false,
      error: {
        formErrors: [],
        fieldErrors: { minAmountNaira: [`minAmountNaira (${effectiveMin}) must be less than maxAmountNaira (${effectiveMax})`] },
      },
    });
    return;
  }
  // The default amount must always sit inside the effective range.
  const effectiveDefaultAmount = parsed.data.defaultAmountNaira === undefined
    ? product.defaultAmountNaira
    : parsed.data.defaultAmountNaira;
  if (effectiveDefaultAmount !== undefined && effectiveDefaultAmount !== null && (effectiveDefaultAmount < effectiveMin || effectiveDefaultAmount > effectiveMax)) {
    res.status(400).json({
      ok: false,
      error: {
        formErrors: [],
        fieldErrors: { defaultAmountNaira: [`defaultAmountNaira (${effectiveDefaultAmount}) must fall within the min/max range (${effectiveMin} – ${effectiveMax})`] },
      },
    });
    return;
  }
  // Default tenure must be one of the allowed tenures once both are known.
  const effectiveTenureDays = parsed.data.tenureDays !== undefined
    ? normalizeTenureDays(parsed.data.tenureDays)
    : product.tenureDays;
  const effectiveDefaultTenure = parsed.data.defaultTenureDays ?? product.defaultTenureDays;
  if (effectiveTenureDays && effectiveTenureDays.length > 0 && effectiveDefaultTenure !== undefined && !effectiveTenureDays.includes(effectiveDefaultTenure)) {
    res.status(400).json({
      ok: false,
      error: {
        formErrors: [],
        fieldErrors: { defaultTenureDays: [`defaultTenureDays (${effectiveDefaultTenure}) must be one of the allowed tenureDays (${effectiveTenureDays.join(", ")})`] },
      },
    });
    return;
  }
  // Per-tenor monthly rates: validate the MERGED product — every effective
  // rate entry must reference a tenor the product still offers. A patch that
  // shrinks the tenor list prunes orphaned rate entries below.
  if (parsed.data.tenorInterestRates !== undefined && parsed.data.tenorInterestRates !== null && parsed.data.tenorInterestRates.length > 0 && effectiveTenureDays && effectiveTenureDays.length > 0) {
    const allowedTenors = new Set(effectiveTenureDays);
    const orphans = parsed.data.tenorInterestRates.map((entry) => Math.trunc(Number(entry.tenorDays))).filter((tenorDays) => !allowedTenors.has(tenorDays));
    if (orphans.length > 0) {
      res.status(400).json({
        ok: false,
        error: {
          formErrors: [],
          fieldErrors: { tenorInterestRates: [`tenorInterestRates entries (${orphans.join(", ")}) must reference tenors from the tenureDays list (${effectiveTenureDays.join(", ")})`] },
        },
      });
      return;
    }
  }
  product.version += 1;
  product.updatedAt = new Date().toISOString();
  const { tenureDays, defaultAmountNaira, tenorInterestRates, ...rest } = parsed.data;
  Object.assign(product, rest);
  if (tenureDays !== undefined) {
    const normalized = normalizeTenureDays(tenureDays);
    if (normalized.length > 0) (product as LoanProductRow).tenureDays = normalized;
    else delete (product as LoanProductRow).tenureDays;
    // The tenor list shrank: drop rate entries for tenors the product no
    // longer offers (explicitly-patched rates were validated above).
    if (tenorInterestRates === undefined && (product as LoanProductRow).tenorInterestRates && normalized.length > 0) {
      const allowedTenors = new Set(normalized);
      const pruned = normalizeTenorInterestRates(((product as LoanProductRow).tenorInterestRates ?? []).filter((entry) => allowedTenors.has(entry.tenorDays)));
      if (pruned && pruned.length > 0) (product as LoanProductRow).tenorInterestRates = pruned;
      else delete (product as LoanProductRow).tenorInterestRates;
    }
  }
  if (defaultAmountNaira !== undefined) {
    if (defaultAmountNaira === null) delete (product as LoanProductRow).defaultAmountNaira;
    else (product as LoanProductRow).defaultAmountNaira = defaultAmountNaira;
  }
  if (tenorInterestRates !== undefined) {
    if (tenorInterestRates === null || tenorInterestRates.length === 0) delete (product as LoanProductRow).tenorInterestRates;
    else {
      const normalized = normalizeTenorInterestRates(tenorInterestRates);
      if (normalized && normalized.length > 0) (product as LoanProductRow).tenorInterestRates = normalized;
      else delete (product as LoanProductRow).tenorInterestRates;
    }
  }
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, product });
});

router.post("/admin/payouts/:payoutId/approve", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const payout = payouts.find((item) => item.id === req.params.payoutId);
  if (!payout) {
    res.status(404).json({ ok: false, error: "Payout not found" });
    return;
  }
  if (payout.status !== "PENDING_APPROVAL" && payout.status !== "FAILED") {
    res.status(409).json({ ok: false, error: `Payout is ${payout.status}, cannot approve.` });
    return;
  }
  // KYC gate: no investor receives money — auto or manual — before their KYC
  // is verified and approved.
  if (!userKycVerified(payout.userId)) {
    const investor = users.find((u) => u.id === payout.userId);
    if (investor) void notifyKycBlocked(investor, "INVESTOR_PAYOUT");
    res.status(409).json({
      ok: false,
      code: "KYC_REQUIRED",
      error: `The investor's KYC verification is not complete${investor ? ` (${investor.fullName})` : ""}. The payout stays on hold until the investor completes identity verification.`,
    });
    return;
  }
  const account = payoutAccounts.find((item) => item.userId === payout.userId && item.status === "VERIFIED");
  const snapshot = (payout.payoutAccountSnapshot ?? {}) as { accountNumber?: string; bankCode?: string; accountName?: string };
  const accountNumber = snapshot.accountNumber ?? account?.accountNumber;
  const bankCode = snapshot.bankCode ?? account?.bankCode;
  const accountName = snapshot.accountName ?? account?.accountName;
  if (!accountNumber || !bankCode) {
    res.status(400).json({ ok: false, error: "Verified payout account details are required for settlement." });
    return;
  }
  try {
    // Bank-code normalization for legacy payout accounts (see maturity sweep).
    let approveBankCode = String(bankCode);
    try {
      const normalized = await normalizeBankCodeForFlutterwave(approveBankCode, String(accountName ?? ""));
      if (normalized && normalized !== approveBankCode) approveBankCode = normalized;
    } catch (_normError) {
      // Bank list unavailable — proceed with the stored code.
    }
    const transfer = await createInvestorPayout({
      txRef: `VELO-PAYOUT-${payout.id}`,
      amountNaira: Number(payout.amountNaira),
      accountNumber,
      accountBank: approveBankCode,
      beneficiaryName: accountName ?? `Investor ${payout.userId}`,
      narration: `Velo ${payout.payoutType ?? "payout"} ${payout.id}`,
    });
    payout.status = "PENDING_PROVIDER_CONFIRMATION";
    payout.providerTransfer = transfer as unknown as Record<string, unknown>;
    payout.retryCount = (payout.retryCount ?? 0) + 1;
    payout.lastAttemptAt = new Date().toISOString();
    payout.updatedAt = payout.lastAttemptAt;
    if (!(await persistMutation(res))) return;
    res.status(202).json({ ok: true, payout, transfer });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Flutterwave payout unavailable",
    });
  }
});

router.get("/notifications", requireAuth, (req: AuthRequest, res) => {
  const limit = Math.min(100, Number(req.query.limit ?? 50));
  const offset = Number(req.query.offset ?? 0);
  const isAdmin = req.user?.roles.includes("ADMIN");
  const filtered = isAdmin
    ? notifications.slice()
    : notifications.filter((n) => n.userId === req.user?.id);
  const sorted = filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const paged = sorted.slice(offset, offset + limit);
  res.json({ ok: true, notifications: paged, meta: { total: sorted.length, limit, offset } });
});

router.get("/payments/flutterwave/return", (req, res) => {
  const status = String(req.query.status ?? "");
  const txRef = String(req.query.tx_ref ?? "");
  if (status.toLowerCase() === "successful") {
    void verifyTransaction(txRef).catch(() => undefined);
  }
  const redirect = `${env.API_ORIGIN}/account?purchase=complete&tx_ref=${encodeURIComponent(txRef)}&status=${encodeURIComponent(status)}`;
  res.redirect(302, redirect);
});


// ===============================
// Wallet hold reconciliation
// ===============================
// `wallet.heldMinor` is maintained incrementally inside appendLedger, and
// every historical path that wrote a hold (investment lock, withdrawal
// initiation) or released one (settlement, reversal, sweep, early liquidity)
// had to keep the counter in sync by itself. Any interruption — a process
// restart between "hold written" and "record linked", an over-release, a
// legacy double-write — left PHANTOM holds behind: money shown as "locked"
// with no active investment and no in-flight withdrawal backing it (investors
// saw a held balance while `investments` was empty).
//
// reconcileWalletHolds() derives the TRUE held balance from the backing
// records and repairs the stored counter in both directions, writing a
// compensating ledger entry so `available = totalCredited - totalDebited`
// and `available + held` stay provably consistent:
//   • held too HIGH (phantom/orphan hold)  -> HOLD_RELEASE credit: the money
//     was debited from available but no provider transfer ever existed (no
//     backing record), so it goes back to the investor.
//   • held too LOW  (over-release ate holds) -> HOLD_RESTORE debit: money
//     that belongs to a live position is moved back out of available.
// Called on every investor wallet-reading endpoint and after the maturity
// sweep, so the displayed numbers are always derived from real records.
export function reconcileWalletHolds(userId: string, opts: { refundPhantom?: boolean } = {}): { beforeMinor: number; afterMinor: number; expectedMinor: number; changed: boolean } {
  const wallet = findWallet(userId);
  const before = wallet.heldMinor;

  // --- Held investments -----------------------------------------------------
  // A released investment has an INVESTMENT_RELEASE / INVESTMENT_RETURN ledger
  // entry referencing its id (early liquidity releases immediately; the
  // maturity sweep releases principal + earnings). Anything not provably
  // released still locks the principal: ACTIVE positions, matured positions
  // stuck on PAYOUT_ACCOUNT_REQUIRED (sweep bailed before any credit) and
  // KYC-gated maturities whose payout sits in PENDING_APPROVAL without the
  // wallet having been credited.
  const walletEntries = ledgerEntries.filter((e) => e.walletId === wallet.id);
  const releasedInvestmentIds = new Set(
    walletEntries
      .filter((e) => e.entryType === "INVESTMENT_RELEASE" || e.entryType === "INVESTMENT_RETURN")
      .map((e) => String(e.referenceId ?? ""))
  );
  const heldInvestmentsMinor = investments
    .filter((item) => {
      if (item.investorId !== userId) return false;
      const status = String(item.status ?? "");
      if (status === "ACTIVE" || status === "PAYOUT_ACCOUNT_REQUIRED") return true;
      if (releasedInvestmentIds.has(String(item.id ?? ""))) return false;
      if (status === "PAYOUT_PENDING" || status === "LIQUIDITY_APPROVED") {
        return payouts.some((p) => p.investmentId === item.id && p.status === "PENDING_APPROVAL");
      }
      return false;
    })
    .reduce((sum, item) => sum + Math.round(Number(item.amountNaira ?? 0) * 100), 0);

  // --- In-flight withdrawals --------------------------------------------------
  // Withdrawals hold their GROSS amount from initiation until the provider
  // confirms the outcome. A withdrawal whose outcome entry already exists
  // (settlement release or reversal) must not hold anymore, even if its
  // status field was left stale by a crash.
  const resolvedWithdrawalIds = new Set(
    walletEntries
      .filter((e) => e.entryType === "WITHDRAWAL_SETTLEMENT" || e.entryType === "WITHDRAWAL_REVERSAL")
      .map((e) => String(e.referenceId ?? ""))
  );
  const inFlightWithdrawalsMinor = investorWithdrawals
    .filter((w) =>
      w.investorId === userId &&
      ["PENDING", "PROCESSING"].includes(String(w.status ?? "")) &&
      !resolvedWithdrawalIds.has(String(w.id ?? ""))
    )
    .reduce((sum, w) => sum + Math.round(Number(w.amountNaira ?? 0) * 100), 0);

  const expected = heldInvestmentsMinor + inFlightWithdrawalsMinor;
  if (expected === before) {
    return { beforeMinor: before, afterMinor: wallet.heldMinor, expectedMinor: expected, changed: false };
  }

  if (expected < before) {
    // Phantom hold: release the unbacked difference back to the investor.
    const phantom = before - expected;
    wallet.heldMinor = expected;
    if (opts.refundPhantom !== false && phantom > 0) {
      appendLedger(wallet, {
        entryType: "HOLD_RELEASE",
        referenceId: `reconcile-${Date.now()}`,
        amountMinor: phantom,
        direction: "CREDIT",
        description: "Stale hold released - locked funds with no active investment or pending withdrawal",
        metadata: { reconcile: true, beforeHeldMinor: before, expectedHeldMinor: expected },
      });
      console.warn(`[wallet/reconcile] user=${userId} phantom hold released: held ${before} -> ${expected} (+${phantom} credited back)`);
    } else {
      console.warn(`[wallet/reconcile] user=${userId} held lowered ${before} -> ${expected} (no refund requested)`);
    }
  } else {
    // Under-held: a live position's hold was lost (over-release). Move the
    // money back out of available so it cannot be spent twice.
    const missing = expected - before;
    wallet.heldMinor = expected;
    appendLedger(wallet, {
      entryType: "HOLD_RESTORE",
      referenceId: `reconcile-${Date.now()}`,
      amountMinor: missing,
      direction: "DEBIT",
      description: "Hold restored - funds locked in active investments or pending withdrawals",
      metadata: { reconcile: true, beforeHeldMinor: before, expectedHeldMinor: expected },
    });
    console.warn(`[wallet/reconcile] user=${userId} hold restored: held ${before} -> ${expected} (-${missing} from available)`);
  }
  schedulePersist();
  return { beforeMinor: before, afterMinor: wallet.heldMinor, expectedMinor: expected, changed: true };
}

/** Reconcile every wallet — used after the maturity sweep and on boot. */
export function reconcileAllWalletHolds(): number {
  let changed = 0;
  for (const wallet of wallets) {
    try {
      if (reconcileWalletHolds(wallet.userId).changed) changed += 1;
    } catch (error) {
      console.error(`[wallet/reconcile] failed for user=${wallet.userId}:`, error);
    }
  }
  return changed;
}

function reverseInvestorWithdrawal(withdrawal: (typeof investorWithdrawals)[number], reason: string): void {
  const wallet = findWallet(withdrawal.investorId);
  const amountMinor = Math.round(Number(withdrawal.amountNaira) * 100);
  if (wallet) {
    appendLedger(wallet, {
      entryType: "WITHDRAWAL_REVERSAL",
      referenceId: withdrawal.id,
      amountMinor,
      direction: "CREDIT",
      description: `Withdrawal reversal - ${reason}`,
    });
  }
  // Mirror reversal: the WITHDRAWAL_OUT admin credit taken at initiation is
  // charged back so the ledger stays consistent with the restored wallet.
  appendAdminLedger({
    entryType: "WITHDRAWAL_OUT_REVERSAL",
    investorId: withdrawal.investorId,
    referenceId: withdrawal.id,
    amountMinor,
    direction: "DEBIT",
    description: `Reverse admin ledger credit for failed withdrawal - ${reason}`,
    metadata: { reason },
  });
  const feeMinor = Math.round(Number(withdrawal.feeNaira) * 100);
  if (feeMinor > 0) {
    appendAdminLedger({
      entryType: "REVERSAL",
      referenceId: withdrawal.id,
      investorId: withdrawal.investorId,
      amountMinor: feeMinor,
      direction: "DEBIT",
      description: "Reverse withdrawal fee due to failed transfer",
    });
  }
}

async function executeInvestorWithdrawal(withdrawal: (typeof investorWithdrawals)[number]): Promise<{ transfer?: Record<string, unknown>; verification?: Record<string, unknown>; finalStatus?: string; error?: string }> {
  withdrawal.status = "PROCESSING";
  withdrawal.retryCount = (withdrawal.retryCount ?? 0) + 1;
  withdrawal.lastAttemptAt = new Date().toISOString();
  withdrawal.updatedAt = withdrawal.lastAttemptAt;
  let initialTransfer: Record<string, unknown> | null = null;
  try {
    // Bank-code normalization: legacy withdrawal records may carry codes from
    // other providers' conventions that Flutterwave rejects ("Unknown Bank
    // Code"). Re-map against Flutterwave's live bank list first.
    let effectiveBankCode = String(withdrawal.bankCode);
    try {
      effectiveBankCode = await normalizeBankCodeForFlutterwave(effectiveBankCode, withdrawal.bankName || withdrawal.bankCode);
      if (effectiveBankCode !== String(withdrawal.bankCode)) {
        withdrawal.bankCode = effectiveBankCode;
        // If bankName was just echoing the (bad) code, clean it up so the UI
        // shows a real bank label.
        if (!withdrawal.bankName || withdrawal.bankName === withdrawal.bankCode) withdrawal.bankName = effectiveBankCode;
        withdrawal.updatedAt = new Date().toISOString();
        schedulePersist();
      }
    } catch (_normError) {
      // Provider bank list unavailable — proceed with the stored code.
    }
    const transfer = await createInvestorPayout({
      txRef: `WITHDRAWAL-${withdrawal.id}`,
      amountNaira: Number(withdrawal.netNaira),
      accountNumber: String(withdrawal.accountNumber),
      accountBank: effectiveBankCode,
      beneficiaryName: String(withdrawal.accountName),
      narration: withdrawal.narration || `Velo investor withdrawal ${withdrawal.id}`,
    });
    initialTransfer = transfer as unknown as Record<string, unknown>;
    withdrawal.providerTransfer = { ...(withdrawal.providerTransfer ?? {}), initiate: transfer as unknown as Record<string, unknown> } as unknown as Record<string, unknown>;
    const providerStatus = String(transfer.status ?? "").toLowerCase();
    if (providerStatus !== "success") throw new Error(transfer.message || "Withdrawal provider rejected the transfer");
    const transferData = (transfer as unknown as { data?: { id?: number | string; reference?: string } }) ?? {};
    const rawId = transferData?.data?.id;
    const rawRef = transferData?.data?.reference;
    const transferId = rawId !== undefined && rawId !== null ? String(rawId) : "";
    const reference = rawRef !== undefined && rawRef !== null ? String(rawRef) : `WITHDRAWAL-${withdrawal.id}`;
    withdrawal.providerReference = reference || transferId;
    withdrawal.updatedAt = new Date().toISOString();
    const verification = await verifyTransferWithRetry(transferId, reference, 2, 1000);
    withdrawal.providerTransfer = { ...(withdrawal.providerTransfer ?? {}), verification: verification as unknown as Record<string, unknown> } as unknown as Record<string, unknown>;
    const now = new Date().toISOString();
    if (verification.settled) {
      withdrawal.status = "SUCCESSFUL";
      withdrawal.error = undefined;
      withdrawal.processedAt = now;
      withdrawal.updatedAt = now;
      appendLedger(findWallet(withdrawal.investorId), {
        entryType: "WITHDRAWAL_SETTLEMENT",
        referenceId: withdrawal.id,
        amountMinor: 0,
        direction: "CREDIT",
        description: "Release funds held for successful withdrawal",
        metadata: { releasedAmountMinor: Math.round(Number(withdrawal.amountNaira) * 100) },
      });
      return { transfer: initialTransfer ?? undefined, verification: verification as unknown as Record<string, unknown>, finalStatus: "SUCCESSFUL" };
    } else if (verification.status === "failed") {
      const failReason =
        (verification.data && typeof (verification.data as Record<string, unknown>).complete_message === "string"
          ? String((verification.data as Record<string, unknown>).complete_message)
          : undefined) ||
        (verification.raw instanceof Error ? verification.raw.message : undefined) ||
        "Transfer verification returned failed status";
      withdrawal.status = "FAILED";
      withdrawal.error = failReason;
      withdrawal.updatedAt = now;
      reverseInvestorWithdrawal(withdrawal, failReason);
      return { transfer: initialTransfer ?? undefined, verification: verification as unknown as Record<string, unknown>, finalStatus: "FAILED", error: failReason };
    } else {
      withdrawal.status = "PROCESSING";
      withdrawal.error = verification.status === "error" && verification.raw instanceof Error ? verification.raw.message : `Awaiting provider confirmation (status=${verification.status}). Final status will be updated via webhook.`;
      withdrawal.updatedAt = now;
      return { transfer: initialTransfer ?? undefined, verification: verification as unknown as Record<string, unknown>, finalStatus: "PROCESSING" };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Withdrawal provider unavailable";
    withdrawal.status = "FAILED";
    withdrawal.error = message;
    withdrawal.updatedAt = new Date().toISOString();
    if (initialTransfer) {
      withdrawal.providerTransfer = { ...(withdrawal.providerTransfer ?? {}), initiateError: message } as unknown as Record<string, unknown>;
    }
    reverseInvestorWithdrawal(withdrawal, message);
    return { transfer: initialTransfer ?? undefined, error: message, finalStatus: "FAILED" };
  }
}

// ===============================
// Investor withdrawal endpoint
// ===============================
router.post("/investor/wallet/withdraw", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const schema = z.object({
    amountNaira: z.number().positive().max(50_000_000),
    bankCode: z.string().min(2).max(10),
    accountNumber: z.string().regex(/^\d{10}$/),
    narration: z.string().max(100).optional(),
    idempotencyKey: z.string().min(16).max(100),
    otpChallengeId: z.string().min(1),
    otpCode: z.string().regex(/^\d{6}$/),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const userId = req.user!.id;
  const existingWithdrawal = investorWithdrawals.find((item) => item.investorId === userId && item.idempotencyKey === parsed.data.idempotencyKey);
  if (existingWithdrawal) {
    res.status(existingWithdrawal.status === "FAILED" ? 200 : 202).json({
      ok: existingWithdrawal.status !== "FAILED",
      withdrawal: existingWithdrawal,
      message: existingWithdrawal.status === "SUCCESSFUL"
        ? "Withdrawal already processed successfully."
        : existingWithdrawal.status === "FAILED"
          ? existingWithdrawal.error || "Withdrawal failed."
          : "Withdrawal is already being processed.",
      finalStatus: existingWithdrawal.status,
    });
    return;
  }
  // KYC gate: wallet withdrawals are payouts and require verified identity.
  // Checked BEFORE the OTP so the customer isn't burned on a challenge that
  // cannot succeed anyway.
  const precheckWallet = findWallet(userId);
  const precheckInvestor = users.find((u) => u.id === userId);
  if (!precheckWallet || !precheckInvestor) {
    res.status(404).json({ ok: false, error: "Wallet not found" });
    return;
  }
  if (!userKycVerified(userId)) {
    void notifyKycBlocked(precheckInvestor, "WITHDRAWAL");
    res.status(409).json({ ok: false, code: "KYC_REQUIRED", error: "Your KYC verification is pending. Complete your identity verification before withdrawing." });
    return;
  }
  const verification = await verifyOtpChallenge(parsed.data.otpChallengeId, parsed.data.otpCode);
  if (!verification.ok || verification.action !== "WITHDRAWAL" || verification.userId !== userId) { res.status(400).json({ ok: false, error: "Invalid or expired OTP" }); return; }
  const wallet = findWallet(userId);
  const investor = users.find((u) => u.id === userId);
  if (!wallet || !investor) {
    res.status(404).json({ ok: false, error: "Wallet not found" });
    return;
  }
  const settings = getPlatformSettings();
  const minWithdrawNaira = Math.max(200, Number(settings.investorWithdrawalMinAmountNaira ?? 200));
  if (parsed.data.amountNaira < minWithdrawNaira) {
    res.status(400).json({ ok: false, error: `Minimum withdrawal amount is ₦${minWithdrawNaira.toLocaleString("en-NG")}` });
    return;
  }
  const feePercent = settings.investorWithdrawalFeePercent ?? 0;
  const flatMinor = settings.investorWithdrawalFeeFlatMinor ?? 0;
  const amountMinor = Math.round(parsed.data.amountNaira * 100);
  const feePercentMinor = Math.round(amountMinor * (feePercent / 100));
  const totalFeeMinor = feePercentMinor + flatMinor;
  const netMinor = amountMinor - totalFeeMinor;
  if (netMinor < 0 || wallet.availableMinor < amountMinor) {
    res.status(400).json({ ok: false, error: "Insufficient wallet balance" });
    return;
  }
  let bank: Awaited<ReturnType<typeof resolveBankAccount>>;
  try {
    bank = await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode);
  } catch (error) {
    // Provider unavailable / not configured / account resolution failed —
    // return a clear, actionable error instead of a generic 500.
    const message = error instanceof Error ? error.message : "Could not verify the bank account";
    console.error("[routes] withdrawal account resolution failed:", message);
    res.status(503).json({ ok: false, error: `${message}. Please try again shortly or contact support.` });
    return;
  }
  if (bank.status !== "success") {
    res.status(400).json({ ok: false, error: bank.message ?? "Could not verify bank account" });
    return;
  }
  const resolvedAccountName = bank.data?.account_name ?? "Beneficiary";
  const resolvedBankName = parsed.data.bankCode;
  const debitEntry = appendLedger(wallet, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: "pending",
    amountMinor,
    direction: "DEBIT",
    description: `Withdrawal to ${resolvedBankName} *${parsed.data.accountNumber.slice(-4)}`,
    metadata: {
      bankCode: parsed.data.bankCode,
      accountNumber: parsed.data.accountNumber,
      beneficiaryName: resolvedAccountName,
      feeMinor: totalFeeMinor,
      netMinor,
    },
  });
  if (flatMinor > 0) {
    appendAdminLedger({
      entryType: "WITHDRAWAL_FEE",
      investorId: userId,
      amountMinor: flatMinor,
      direction: "CREDIT",
      description: "Flat withdrawal fee collected",
      metadata: { feeType: "FLAT", amountMinor: flatMinor },
    });
  }
  if (feePercentMinor > 0) {
    appendAdminLedger({
      entryType: "WITHDRAWAL_FEE",
      investorId: userId,
      amountMinor: feePercentMinor,
      direction: "CREDIT",
      description: `Percentage withdrawal fee (${feePercent}%)`,
      metadata: { feeType: "PERCENT", percent: feePercent, amountMinor: feePercentMinor },
    });
  }
  // Mirror the investor wallet debit on the admin ledger: the wallet was
  // debited for the GROSS amount (net + fees), so the admin ledger is credited
  // with the same gross amount — fees included — keeping both sides of the
  // movement visible and auditable. Reversed if the transfer fails.
  appendAdminLedger({
    entryType: "WITHDRAWAL_OUT",
    investorId: userId,
    amountMinor,
    direction: "CREDIT",
    description: `Admin ledger credit for investor withdrawal (wallet debited incl. fees) — ${resolvedBankName} ••••${parsed.data.accountNumber.slice(-4)}`,
    metadata: {
      grossMinor: amountMinor,
      feeMinor: totalFeeMinor,
      netMinor,
      bankCode: parsed.data.bankCode,
      accountNumber: parsed.data.accountNumber,
    },
  });
  const withdrawalId = randomUUID();
  const withdrawalEntry = {
    id: withdrawalId,
    investorId: userId,
    amountNaira: parsed.data.amountNaira,
    feeNaira: Math.round(totalFeeMinor) / 100,
    netNaira: Math.round(netMinor) / 100,
    currency: "NGN" as const,
    bankCode: parsed.data.bankCode,
    bankName: resolvedBankName,
    accountNumber: parsed.data.accountNumber,
    accountName: resolvedAccountName,
    status: "PROCESSING" as const,
    narration: parsed.data.narration,
    retryCount: 0,
    lastAttemptAt: new Date().toISOString(),
    idempotencyKey: parsed.data.idempotencyKey,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  investorWithdrawals.push(withdrawalEntry);
  debitEntry.referenceId = withdrawalId;
  // Respond immediately: the wallet hold and the withdrawal record exist, the
  // provider transfer is executed in the background and its final status is
  // picked up by the dashboard's withdrawal-status polling. Blocking here on
  // Flutterwave (+ persistence) is what made withdrawals take 30s+ or fail.
  schedulePersist();
  res.status(202).json({
    ok: true,
    withdrawal: withdrawalEntry,
    message: "Withdrawal has been submitted and is being processed. Final status will be confirmed shortly.",
    finalStatus: "PROCESSING",
    feeBreakdown: {
      flatNaira: Math.round(flatMinor) / 100,
      percentNaira: Math.round(feePercentMinor) / 100,
      totalNaira: Math.round(totalFeeMinor) / 100,
      netNaira: Math.round(netMinor) / 100,
    },
  });
  void (async () => {
    const execution = await executeInvestorWithdrawal(withdrawalEntry);
    schedulePersist();
    const emailTpl = investorWithdrawalEmail({
      investorName: investor.fullName,
      withdrawalId,
      amountNaira: parsed.data.amountNaira,
      feeNaira: Math.round(totalFeeMinor) / 100,
      netNaira: Math.round(netMinor) / 100,
      balanceNaira: Math.round(wallet.availableMinor) / 100,
      bankName: resolvedBankName,
      accountNumber: parsed.data.accountNumber,
    });
    try {
      const emailRes = await sendEmail({
        to: investor.email,
        name: investor.fullName,
        subject: emailTpl.subject,
        html: emailTpl.html,
      });
      notifications.push({
        id: randomUUID(),
        userId: investor.id,
        channel: "EMAIL" as const,
        kind: "WITHDRAWAL_REQUEST" as const,
        subject: emailTpl.subject,
        recipientMasked: investor.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
        status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
        providerMessageId: emailRes.providerReference,
        retryCount: 0,
        relatedEntityType: "WITHDRAWAL",
        relatedEntityId: withdrawalId,
        createdAt: new Date().toISOString(),
        sentAt: emailRes.sent ? new Date().toISOString() : undefined,
      });
      schedulePersist();
    } catch (_emailErr) {
      // Email failure must not affect the withdrawal outcome.
    }
    if (execution.error) {
      console.error(`[routes] withdrawal ${withdrawalId} execution error:`, execution.error);
    }
  })();
});

// ===============================
// Admin platform settings routes
// ===============================
router.get("/admin/settings/platform", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const settings = getPlatformSettings();
  const balanceMinor = getAdminLedgerBalanceMinor();
  res.json({
    ok: true,
    settings,
    adminLedgerBalanceMinor: balanceMinor,
    adminLedgerBalanceNaira: Math.round(balanceMinor) / 100,
  });
});

router.put("/admin/settings/platform", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    investorWithdrawalFeePercent: z.number().min(0).max(100).optional(),
    investorWithdrawalFeeFlatMinor: z.number().int().min(0).optional(),
    investorWithdrawalFeeFlatNaira: z.number().min(0).optional(),
    investorWithdrawalMinAmountNaira: z.number().min(200).optional(),
    defaultInvestmentAnnualRatePercent: z.number().min(0).max(100).optional(),
    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: z.string().max(500).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (parsed.data.investorWithdrawalFeePercent !== undefined) {
    updates.investorWithdrawalFeePercent = parsed.data.investorWithdrawalFeePercent;
  }
  if (parsed.data.investorWithdrawalFeeFlatMinor !== undefined) {
    updates.investorWithdrawalFeeFlatMinor = parsed.data.investorWithdrawalFeeFlatMinor;
  } else if (parsed.data.investorWithdrawalFeeFlatNaira !== undefined) {
    updates.investorWithdrawalFeeFlatMinor = Math.round(parsed.data.investorWithdrawalFeeFlatNaira * 100);
  }
  if (parsed.data.investorWithdrawalMinAmountNaira !== undefined) {
    updates.investorWithdrawalMinAmountNaira = parsed.data.investorWithdrawalMinAmountNaira;
  }
  if (parsed.data.defaultInvestmentAnnualRatePercent !== undefined) {
    updates.defaultInvestmentAnnualRatePercent = parsed.data.defaultInvestmentAnnualRatePercent;
  }
  if (parsed.data.maintenanceMessage !== undefined) {
    updates.maintenanceMessage = parsed.data.maintenanceMessage;
  }
  const before = getPlatformSettings();
  const maintenanceToggled = parsed.data.maintenanceMode !== undefined && parsed.data.maintenanceMode !== (before.maintenanceMode === true);
  if (parsed.data.maintenanceMode !== undefined) {
    updates.maintenanceMode = parsed.data.maintenanceMode;
  }
  const updated = updatePlatformSettings(updates);
  recordAdminAudit(req, maintenanceToggled ? (updated.maintenanceMode ? "MAINTENANCE_MODE_ENABLED" : "MAINTENANCE_MODE_DISABLED") : "PLATFORM_SETTINGS_UPDATED", "PLATFORM_SETTINGS", updated.id, { maintenanceMode: updated.maintenanceMode, message: updated.maintenanceMessage });
  // Maintenance-mode email blast: every active customer is notified the moment
  // the toggle flips (ON: "we'll email you when we're back", OFF: "we're back").
  let emailedCount: number | null = null;
  if (maintenanceToggled) {
    schedulePersist();
    const recipients = users.filter((u) => u.isActive !== false && !u.roles.includes("ADMIN") && Boolean(u.email));
    emailedCount = recipients.length;
    void (async () => {
      let delivered = 0;
      for (const recipient of recipients) {
        try {
          const template = maintenanceModeEmail({ name: recipient.fullName, isOn: updated.maintenanceMode === true, message: updated.maintenanceMessage });
          await sendEmail({ to: recipient.email, name: recipient.fullName, ...template });
          delivered += 1;
        } catch { /* best-effort blast — per-user failures are logged by sendEmail */ }
      }
      console.info(`[routes] maintenance mode ${updated.maintenanceMode ? "ON" : "OFF"} email blast: ${delivered}/${recipients.length} delivered`);
    })();
  }
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, settings: updated, maintenanceEmailed: emailedCount ?? undefined });
});

// ---------------------------------------------------------------------------
// Announcements — admin-authored messages rendered as a smooth horizontal text
// slider (with an alert icon) on the Borrower and Investor dashboards.
// ---------------------------------------------------------------------------
router.get("/admin/announcements", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const settings = getPlatformSettings();
  res.json({ ok: true, announcements: (settings.announcements ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

router.post("/admin/announcements", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({ message: z.string().min(3).max(280) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  const settings = getPlatformSettings();
  const now = new Date().toISOString();
  const announcement: PlatformAnnouncement = { id: randomUUID(), message: parsed.data.message.trim(), isActive: true, createdAt: now, updatedAt: now };
  settings.announcements = [...(settings.announcements ?? []), announcement];
  settings.updatedAt = now;
  recordAdminAudit(req, "ANNOUNCEMENT_CREATED", "PLATFORM_SETTINGS", String(announcement.id), { message: announcement.message });
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, announcement });
});

router.patch("/admin/announcements/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const settings = getPlatformSettings();
  const announcement = (settings.announcements ?? []).find((item) => item.id === req.params.id);
  if (!announcement) { res.status(404).json({ ok: false, error: "Announcement not found" }); return; }
  const parsed = z.object({ message: z.string().min(3).max(280).optional(), isActive: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (parsed.data.message !== undefined) announcement.message = parsed.data.message.trim();
  if (parsed.data.isActive !== undefined) announcement.isActive = parsed.data.isActive;
  announcement.updatedAt = new Date().toISOString();
  settings.updatedAt = announcement.updatedAt;
  recordAdminAudit(req, "ANNOUNCEMENT_UPDATED", "PLATFORM_SETTINGS", String(announcement.id), { isActive: announcement.isActive });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, announcement });
});

router.delete("/admin/announcements/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const settings = getPlatformSettings();
  const before = (settings.announcements ?? []).length;
  settings.announcements = (settings.announcements ?? []).filter((item) => item.id !== req.params.id);
  if (settings.announcements.length === before) { res.status(404).json({ ok: false, error: "Announcement not found" }); return; }
  settings.updatedAt = new Date().toISOString();
  recordAdminAudit(req, "ANNOUNCEMENT_DELETED", "PLATFORM_SETTINGS", String(req.params.id), {});
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, deleted: true });
});

// ---------------------------------------------------------------------------
// Banners — admin-uploaded images shown as an auto-sliding carousel on the
// Borrower and Investor dashboards. Stored as data URLs inside platform
// settings so they survive persistence without a separate file store.
// ---------------------------------------------------------------------------
router.get("/admin/banners", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const settings = getPlatformSettings();
  res.json({ ok: true, banners: (settings.banners ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
});

router.post("/admin/banners", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parsed = z.object({
    name: z.string().min(1).max(120),
    // Accept a raw data URL or a bare base64 payload with an explicit mimeType.
    imageData: z.string().min(32).max(6_000_000),
    mimeType: z.string().regex(/^image\//).optional(),
    linkUrl: z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  let imageData = parsed.data.imageData;
  if (!imageData.startsWith("data:")) {
    imageData = `data:${parsed.data.mimeType ?? "image/jpeg"};base64,${imageData}`;
  }
  const settings = getPlatformSettings();
  const now = new Date().toISOString();
  const banner: PlatformBanner = { id: randomUUID(), name: parsed.data.name.trim(), imageData, linkUrl: parsed.data.linkUrl?.trim() || undefined, isActive: true, createdAt: now, updatedAt: now };
  settings.banners = [...(settings.banners ?? []), banner];
  settings.updatedAt = now;
  recordAdminAudit(req, "BANNER_UPLOADED", "PLATFORM_SETTINGS", String(banner.id), { name: banner.name });
  if (!(await persistMutation(res))) return;
  res.status(201).json({ ok: true, banner: { ...banner, imageData: undefined }, bannerId: banner.id });
});

router.patch("/admin/banners/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const settings = getPlatformSettings();
  const banner = (settings.banners ?? []).find((item) => item.id === req.params.id);
  if (!banner) { res.status(404).json({ ok: false, error: "Banner not found" }); return; }
  const parsed = z.object({ isActive: z.boolean().optional(), name: z.string().min(1).max(120).optional(), linkUrl: z.string().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (parsed.data.isActive !== undefined) banner.isActive = parsed.data.isActive;
  if (parsed.data.name !== undefined) banner.name = parsed.data.name.trim();
  if (parsed.data.linkUrl !== undefined) banner.linkUrl = parsed.data.linkUrl.trim() || undefined;
  banner.updatedAt = new Date().toISOString();
  settings.updatedAt = banner.updatedAt;
  recordAdminAudit(req, "BANNER_UPDATED", "PLATFORM_SETTINGS", String(banner.id), { isActive: banner.isActive });
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, banner: { ...banner, imageData: undefined } });
});

router.delete("/admin/banners/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const settings = getPlatformSettings();
  const before = (settings.banners ?? []).length;
  settings.banners = (settings.banners ?? []).filter((item) => item.id !== req.params.id);
  if (settings.banners.length === before) { res.status(404).json({ ok: false, error: "Banner not found" }); return; }
  settings.updatedAt = new Date().toISOString();
  recordAdminAudit(req, "BANNER_DELETED", "PLATFORM_SETTINGS", String(req.params.id), {});
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, deleted: true });
});

router.put("/admin/investors/:investorId/earning-rate", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const schema = z.object({
    annualRatePercent: z.number().min(0).max(100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const investorId = String(req.params.investorId);
  const investor = users.find((u) => u.id === investorId && u.roles.includes("INVESTOR"));
  if (!investor) {
    res.status(404).json({ ok: false, error: "Investor not found" });
    return;
  }
  const settings = setInvestorEarningRateOverride(investorId, parsed.data.annualRatePercent);
  if (!(await persistMutation(res))) return;
  res.json({
    ok: true,
    investor: {
      id: investorId,
      fullName: investor.fullName,
      email: investor.email,
      earningRatePercent: parsed.data.annualRatePercent,
    },
    settings,
  });
});

router.post("/admin/investors/:investorId/credit-wallet", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const schema = z.object({
    amountNaira: z.number().positive().max(500_000_000),
    description: z.string().max(200).optional(),
    reason: z.enum(["MANUAL_CREDIT", "INVESTMENT_RETURN", "BONUS", "CORRECTION"]).default("MANUAL_CREDIT"),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const investorId = String(req.params.investorId);
  const reasonVal = Array.isArray(parsed.data.reason) ? parsed.data.reason[0] : parsed.data.reason;
  const investor = users.find((u) => u.id === investorId && u.roles.includes("INVESTOR"));
  const wallet = findWallet(investorId);
  if (!investor || !wallet) {
    res.status(404).json({ ok: false, error: "Investor or wallet not found" });
    return;
  }
  const amountMinor = Math.round(parsed.data.amountNaira * 100);
  const refId = randomUUID();
  appendAdminLedger({
    entryType: "INVESTMENT_RETURN_CREDIT",
    referenceId: refId,
    investorId,
    amountMinor,
    direction: "DEBIT",
    description: parsed.data.description ?? `Admin manual credit - ${reasonVal}`,
    metadata: { reason: reasonVal, creditedBy: req.user?.id },
  });
  appendLedger(wallet, {
    entryType: "INVESTMENT_RETURN",
    referenceId: refId,
    amountMinor,
    direction: "CREDIT",
    description: parsed.data.description ?? `Admin credit: ${reasonVal}`,
    metadata: { reason: reasonVal, creditedBy: req.user?.id },
  });
  const balanceNaira = Math.round(wallet.availableMinor) / 100;
  const emailTpl = investorWalletFundedEmail({
    investorName: investor.fullName,
    amountNaira: parsed.data.amountNaira,
    balanceNaira,
    reference: refId,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    subject: emailTpl.subject,
    html: emailTpl.html,
  }).then((emailRes) => {
    notifications.push({
      id: randomUUID(),
      userId: investorId,
      channel: "EMAIL" as const,
      kind: "WALLET_FUNDED" as const,
      subject: emailTpl.subject,
      recipientMasked: investor.email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
      status: emailRes.sent ? "SENT" : "NOT_CONFIGURED",
      providerMessageId: emailRes.providerReference,
      retryCount: 0,
      relatedEntityType: "WALLET_TRANSACTION",
      relatedEntityId: refId,
      createdAt: new Date().toISOString(),
      sentAt: emailRes.sent ? new Date().toISOString() : undefined,
    });
  }).catch(() => undefined);
  res.json({
    ok: true,
    walletBalanceMinor: wallet.availableMinor,
    walletBalanceNaira: Math.round(wallet.availableMinor) / 100,
    transactionId: refId,
  });
});

router.get("/admin/ledger", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const entryType = req.query.entryType ? String(req.query.entryType) : undefined;
  const filtered = entryType
    ? indexes.adminLedgerByEntryType.get(entryType) ?? []
    : adminLedger;
  const sorted = filtered.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const page = sorted.slice(offset, offset + limit);
  const balanceMinor = getAdminLedgerBalanceMinor();
  res.json({
    ok: true,
    balanceMinor,
    balanceNaira: Math.round(balanceMinor) / 100,
    totalEntries: sorted.length,
    entries: page,
    limit,
    offset,
    hasMore: offset + limit < sorted.length,
  });
});

router.get("/admin/investments", requireAuth, requireRole("ADMIN"), (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const investorId = typeof req.query.investorId === "string" ? req.query.investorId : undefined;
  let filtered: Array<(typeof investments)[number]> = investorId
    ? indexes.investmentsByInvestorId.get(investorId) ?? []
    : investments;
  if (status) filtered = filtered.filter((i) => String(i.status) === status);
  const sorted = filtered.slice().sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const page = paginate(sorted, req.query as Record<string, unknown>);
  res.json({
    ok: true,
    investments: page.items,
    meta: page.meta,
    plans: investmentPlans,
  });
});

router.get("/admin/investors/:investorId/withdrawals", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const investorId = String(req.params.investorId);
  const statusFilter = req.query.status ? String(req.query.status) : undefined;
  let items = investorWithdrawals.filter((w) => w.investorId === investorId);
  if (statusFilter) items = items.filter((w) => w.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ ok: true, withdrawals: items });
});

router.get("/admin/withdrawals", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const statusFilter = req.query.status ? String(req.query.status) : undefined;
  const search = req.query.search ? String(req.query.search).trim().toLowerCase() : "";
  const fromDate = parseDateQueryParam(req.query.from);
  const toDate = parseDateQueryParam(req.query.to, { endOfDay: true });
  let items = [...investorWithdrawals];
  if (statusFilter) items = items.filter((w) => w.status === statusFilter);
  if (fromDate) items = items.filter((w) => new Date(String(w.createdAt)).getTime() >= fromDate.getTime());
  if (toDate) items = items.filter((w) => new Date(String(w.createdAt)).getTime() <= toDate.getTime());
  if (search) {
    items = items.filter((w) => {
      const investor = users.find((u) => u.id === w.investorId);
      const haystack = [
        w.id,
        w.providerReference,
        w.bankName,
        w.bankCode,
        w.accountNumber,
        w.accountName,
        w.narration,
        String(w.amountNaira ?? ""),
        investor?.fullName,
        investor?.email,
        investor?.phone,
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(search);
    });
  }
  items.sort((a, b) => new Date(String(b.createdAt)).getTime() - new Date(String(a.createdAt)).getTime());
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  const page = items.slice(offset, offset + limit).map((w) => {
    const investor = users.find((u) => u.id === w.investorId);
    return {
      ...w,
      investor: investor
        ? { id: investor.id, fullName: investor.fullName, email: investor.email, phone: investor.phone ?? null }
        : null,
    };
  });
  // Summary over the FULL filtered set (not just the current page) so the
  // header can show meaningful totals regardless of pagination.
  const summary = items.reduce(
    (acc, w) => {
      acc.count += 1;
      acc.grossNaira += Number(w.amountNaira ?? 0);
      acc.feeNaira += Number(w.feeNaira ?? 0);
      acc.netNaira += Number(w.netNaira ?? 0);
      if (w.status === "SUCCESSFUL") acc.successful += 1;
      else if (w.status === "FAILED") acc.failed += 1;
      else acc.pending += 1;
      return acc;
    },
    { count: 0, grossNaira: 0, feeNaira: 0, netNaira: 0, successful: 0, failed: 0, pending: 0 },
  );
  res.json({ ok: true, total: items.length, withdrawals: page, summary });
});

// Full audit trail for ONE withdrawal: the record itself, the investor, every
// wallet ledger entry it produced (initiation / settlement / reversal) and
// every admin ledger entry (mirror credit, fees, reversals) — the detail page
// renders this as a complete transaction history.
router.get("/admin/withdrawals/:withdrawalId/detail", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const withdrawal = investorWithdrawals.find((w) => w.id === String(req.params.withdrawalId));
  if (!withdrawal) {
    res.status(404).json({ ok: false, error: "Withdrawal not found" });
    return;
  }
  const investor = users.find((u) => u.id === withdrawal.investorId) ?? null;
  const wallet = wallets.find((item) => item.userId === withdrawal.investorId) ?? null;
  const investorLedger = (wallet
    ? ledgerEntries.filter((entry) => entry.walletId === wallet.id && String(entry.referenceId ?? "") === withdrawal.id)
    : []
  ).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const adminLedgerEntries = adminLedger
    .filter((entry) => String(entry.referenceId ?? "") === withdrawal.id)
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  res.json({
    ok: true,
    withdrawal,
    investor: investor
      ? { id: investor.id, fullName: investor.fullName, email: investor.email, phone: investor.phone ?? null, kycStatus: investor.kycStatus ?? null }
      : null,
    wallet: wallet ? { id: wallet.id, availableMinor: wallet.availableMinor, heldMinor: wallet.heldMinor } : null,
    investorLedger,
    adminLedger: adminLedgerEntries,
  });
});

// ===================== CSV EXPORT =====================
// Every table in the product (admin, investor and borrower) can be exported to
// CSV with an optional date range. The BACKEND serializes and returns a real
// text/csv attachment so even very large ranges work — the frontend only
// downloads the file.

function csvEscapeValue(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return [headers, ...rows].map((row) => row.map(csvEscapeValue).join(",")).join("\r\n");
}

function sendCsvResponse(res: { setHeader: (name: string, value: string) => void; status: (code: number) => { send: (body: string) => void } }, filename: string, csv: string): void {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  // UTF-8 BOM so Excel renders naira signs and accented names correctly.
  res.status(200).send("\ufeff" + csv);
}

function csvFileName(dataset: string, from: unknown, to: unknown): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const range = from || to ? `_${String(from ?? "start").slice(0, 10)}_to_${String(to ?? "today").slice(0, 10)}` : "";
  return `velocredit-${dataset}${range}_${stamp}.csv`;
}

const csvNaira = (value: unknown): number => Math.round(Number(value ?? 0)) / 100;
// For fields that are ALREADY stored in naira (major units) — csvNaira above
// expects minor units and would divide these by 100, exporting wrong amounts.
const csvNairaValue = (value: unknown): number => Math.round(Number(value ?? 0) * 100) / 100;
const csvStamp = (from: unknown, to: unknown) => ({
  from: parseDateQueryParam(from),
  to: parseDateQueryParam(to, { endOfDay: true }),
});
const inRange = (createdAt: unknown, from?: Date, to?: Date): boolean => {
  const time = new Date(String(createdAt)).getTime();
  if (Number.isNaN(time)) return !from && !to;
  if (from && time < from.getTime()) return false;
  if (to && time > to.getTime()) return false;
  return true;
};

router.get("/admin/export/:dataset", requireAuth, requireRole("ADMIN"), (req, res) => {
  const dataset = String(req.params.dataset);
  const { from, to } = csvStamp(req.query.from, req.query.to);
  const status = req.query.status ? String(req.query.status) : undefined;

  if (dataset === "withdrawals") {
    const rows = investorWithdrawals
      .filter((w) => (!status || w.status === status) && inRange(w.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((w) => {
        const investor = users.find((u) => u.id === w.investorId);
        return [
          w.id, w.createdAt, w.status, investor?.fullName ?? w.investorId, investor?.email ?? "",
          csvNairaValue(w.amountNaira), csvNairaValue(w.feeNaira), csvNairaValue(w.netNaira),
          w.bankName ?? w.bankCode ?? "", w.accountNumber, w.accountName ?? "",
          w.providerReference ?? "", w.retryCount ?? 0, w.lastAttemptAt ?? "", w.processedAt ?? "", w.error ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Withdrawal ID", "Created At", "Status", "Investor", "Investor Email", "Amount (NGN)", "Fee (NGN)", "Net (NGN)", "Bank", "Account Number", "Account Name", "Provider Reference", "Retries", "Last Attempt", "Completed At", "Error"],
      rows,
    ));
    return;
  }

  if (dataset === "loans") {
    const rows = loanApplications
      .filter((app) => (!status || app.status === status) && inRange(app.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((app) => {
        const borrower = users.find((u) => u.id === app.borrowerId);
        const loanRecord = loans.find((l) => l.applicationId === app.id);
        const snapshot = (app.customerSnapshot ?? {}) as Record<string, unknown>;
        return [
          app.applicationId || app.id, app.createdAt, snapshot.fullName || borrower?.fullName || app.borrowerId,
          snapshot.email || borrower?.email || "", snapshot.phone || borrower?.phone || "",
          app.applicantType ?? "", app.productSnapshot?.productName ?? "",
          csvNairaValue(app.amountNaira), app.tenureDays ?? "", app.status,
          loanRecord ? loanRecord.status : "", csvNairaValue(loanRecord?.outstandingNaira ?? 0),
          loanRecord?.disbursedAt ?? "", loanRecord?.dueAt ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Application ID", "Created", "Borrower", "Email", "Phone", "Type", "Product", "Principal (NGN)", "Tenure (days)", "Application Status", "Loan Status", "Outstanding (NGN)", "Disbursed At", "Due At"],
      rows,
    ));
    return;
  }

  if (dataset === "payouts") {
    const rows = payouts
      .filter((p) => (!status || p.status === status) && inRange(p.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((p) => {
        const investor = users.find((u) => u.id === p.userId);
        return [
          p.id, p.createdAt, investor?.fullName ?? p.userId, investor?.email ?? "", p.investmentId ?? "",
          p.payoutType ?? "", csvNairaValue(p.principalNaira), csvNairaValue(p.earningsNaira), csvNairaValue(p.feesNaira),
          csvNairaValue(p.amountNaira), p.status, p.providerReference ?? "", p.updatedAt ?? p.createdAt, p.error ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Payout ID", "Created", "Investor", "Email", "Investment ID", "Type", "Principal (NGN)", "Earnings (NGN)", "Fees (NGN)", "Amount (NGN)", "Status", "Provider Reference", "Updated", "Error"],
      rows,
    ));
    return;
  }

  if (dataset === "ledger") {
    const rows = adminLedger
      .filter((entry) => (!status || entry.entryType === status) && inRange(entry.createdAt, from, to))
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((entry) => [
        entry.id, entry.createdAt, entry.entryType, entry.direction, csvNaira(entry.amountMinor),
        entry.referenceId ?? "", entry.description ?? "", csvNaira(entry.balanceAfterMinor),
      ]);
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Entry ID", "Created", "Entry Type", "Direction", "Amount (NGN)", "Reference", "Description", "Balance After (NGN)"],
      rows,
    ));
    return;
  }

  if (dataset === "kyc") {
    const rows = kycCases
      .filter((k) => (!status || k.status === status) && inRange(k.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((k) => {
        const applicant = users.find((u) => u.id === k.userId);
        const checks = Object.values((k.checklist ?? {}) as Record<string, unknown>).filter(Boolean).length;
        return [
          k.id, k.createdAt, applicant?.fullName ?? k.userId, applicant?.email ?? "", k.status,
          checks, Object.keys((k.checklist ?? {}) as Record<string, unknown>).length,
          k.submittedAt ?? "", k.updatedAt ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Case ID", "Created", "Applicant", "Email", "Status", "Checks Passed", "Checks Total", "Submitted", "Updated"],
      rows,
    ));
    return;
  }

  if (dataset === "investors") {
    const rows = users
      .filter((u) => Array.isArray(u.roles) && u.roles.includes("INVESTOR"))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((u) => {
        const wallet = wallets.find((item) => item.userId === u.id);
        return [
          u.id, u.fullName, u.email, u.phone ?? "", u.kycStatus ?? "", u.createdAt,
          csvNaira(wallet?.availableMinor ?? 0), csvNaira(wallet?.heldMinor ?? 0),
          csvNaira(wallet?.totalCreditedMinor ?? 0), csvNaira(wallet?.totalDebitedMinor ?? 0),
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Investor ID", "Name", "Email", "Phone", "KYC Status", "Joined", "Wallet Balance (NGN)", "Held (NGN)", "Total Credited (NGN)", "Total Debited (NGN)"],
      rows,
    ));
    return;
  }

  if (dataset === "audit-logs") {
    const rows = auditLogs
      .filter((a) => (!status || a.action === status) && inRange(a.createdAt, from, to))
      .slice()
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((a) => {
        const actor = a.userId ? users.find((u) => u.id === a.userId) : undefined;
        const target = a.resourceId ? users.find((u) => u.id === a.resourceId) : undefined;
        return [
          a.id, a.createdAt, a.action, actor?.fullName ?? "", actor?.email ?? "",
          a.resourceType ?? "", a.resourceId ?? "", target?.fullName ?? "",
          JSON.stringify(a.metadata ?? {}), a.ipAddress ?? "", a.userAgent ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Event ID", "Created", "Action", "Actor", "Actor Email", "Resource Type", "Resource ID", "Target User", "Metadata", "IP Address", "User Agent"],
      rows,
    ));
    return;
  }

  res.status(400).json({ ok: false, error: `Unknown export dataset '${dataset}'. Available: withdrawals, loans, payouts, ledger, kyc, investors, audit-logs` });
});

router.get("/investor/export/:dataset", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const dataset = String(req.params.dataset);
  const { from, to } = csvStamp(req.query.from, req.query.to);
  const userId = req.user!.id;

  if (dataset === "transactions") {
    // Mirror the unified transaction history shown in the dashboard (including
    // its dedup rules) so the exported file always matches what the investor
    // sees on screen: one row per real money movement — the wallet DEPOSIT row
    // for fundings, the first-class investment row for positions.
    const wallet = findWallet(userId);
    const userWithdrawals = investorWithdrawals.filter((w) => w.investorId === userId);
    const withdrawalIds = new Set(userWithdrawals.map((w) => w.id));
    const userWalletTxs = walletTransactions.filter((t) => t.userId === userId);
    const depositTxIds = new Set(userWalletTxs.filter((t) => String(t.type) === "DEPOSIT").map((t) => t.id));
    const userInvestments = investments.filter((i) => i.investorId === userId);
    const investmentIdSet = new Set(userInvestments.map((i) => i.id));
    type Row = { date: string; type: string; direction: string; amountNaira: number; status: string; description: string; reference: string };
    const rows: Row[] = [];
    for (const entry of ledgerEntries.filter((e) => e.walletId === wallet.id)) {
      const entryType = String(entry.entryType ?? "");
      if (/WITHDRAWAL_SETTLEMENT/.test(entryType) && Number(entry.amountMinor ?? 0) === 0) continue;
      if (/WITHDRAWAL_INITIATED/.test(entryType) && withdrawalIds.has(String(entry.referenceId ?? ""))) continue;
      // DEDUP (funding): the FUNDING ledger row duplicates the DEPOSIT wallet
      // transaction (same money, richer live status on the deposit row).
      if (/^FUNDING$/.test(entryType)) {
        const meta = (entry.metadata ?? {}) as Record<string, unknown>;
        if (depositTxIds.has(String(entry.referenceId ?? "")) || (meta.txRef && userWalletTxs.some((t) => t.txRef === meta.txRef))) continue;
      }
      // DEDUP (investment): the first-class investment row below already
      // carries plan name + status — skip the INVESTMENT_LOCK bookkeeping row.
      if (/INVESTMENT_LOCK/.test(entryType) && investmentIdSet.has(String(entry.referenceId ?? ""))) continue;
      rows.push({
        date: entry.createdAt,
        type: entryType.replace(/_/g, " "),
        direction: entry.direction,
        amountNaira: csvNaira(entry.amountMinor),
        status: /REVERSAL/.test(entryType) ? "REVERSED" : "COMPLETED",
        description: String(entry.description ?? ""),
        reference: String(entry.referenceId ?? ""),
      });
    }
    // Wallet funding rows — same source the dashboard renders, so statuses
    // match (PENDING PROVIDER CONFIRMATION / SUCCESSFUL / FAILED).
    for (const tx of userWalletTxs) {
      if (String(tx.type) !== "DEPOSIT") continue;
      rows.push({
        date: String(tx.createdAt),
        type: "Wallet funding",
        direction: "CREDIT",
        amountNaira: csvNaira(tx.amountMinor),
        status: String(tx.status ?? "SUCCESSFUL"),
        description: `Wallet funding via ${String(tx.provider ?? "payment gateway")}`,
        reference: String(tx.txRef ?? tx.id),
      });
    }
    for (const w of userWithdrawals) {
      rows.push({
        date: String(w.createdAt), type: "Withdrawal", direction: "DEBIT", amountNaira: csvNairaValue(w.amountNaira),
        status: String(w.status), description: `Withdrawal to ${w.bankName || w.bankCode} ••••${String(w.accountNumber).slice(-4)}`,
        reference: String(w.providerReference ?? w.id),
      });
    }
    for (const inv of userInvestments) {
      rows.push({
        date: String(inv.createdAt), type: "Investment", direction: "DEBIT", amountNaira: csvNairaValue(inv.amountNaira),
        status: String(inv.status), description: inv.planSnapshot?.name ? `Investment: ${inv.planSnapshot.name}` : "New investment",
        reference: String(inv.id),
      });
    }
    for (const p of payouts.filter((p) => p.userId === userId)) {
      rows.push({
        date: String(p.createdAt), type: "Investment payout", direction: "CREDIT", amountNaira: csvNairaValue(p.amountNaira),
        status: String(p.status), description: `Payout (${p.payoutType ?? "PAYOUT"})`, reference: String(p.providerReference ?? p.id),
      });
    }
    const filtered = rows
      .filter((row) => inRange(row.date, from, to))
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((row) => [row.date, row.type, row.direction, row.amountNaira, row.status, row.description, row.reference]);
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Date", "Type", "Direction", "Amount (NGN)", "Status", "Description", "Reference"],
      filtered,
    ));
    return;
  }

  if (dataset === "investments") {
    const rows = investments
      .filter((i) => i.investorId === userId && inRange(i.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((inv) => [
        inv.id, inv.createdAt, inv.planSnapshot?.name ?? "", csvNairaValue(inv.amountNaira),
        inv.tenureDays ?? "", inv.status, inv.startsAt ?? "", inv.maturesAt ?? "",
        csvNairaValue(inv.expectedEarningsNaira), inv.annualRatePercent ?? "",
      ]);
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Investment ID", "Created", "Plan", "Amount (NGN)", "Tenure (days)", "Status", "Started", "Matures", "Expected Earnings (NGN)", "Annual Rate (%)"],
      rows,
    ));
    return;
  }

  res.status(400).json({ ok: false, error: `Unknown export dataset '${dataset}'. Available: transactions, investments` });
});

router.get("/borrower/export/:dataset", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const dataset = String(req.params.dataset);
  const { from, to } = csvStamp(req.query.from, req.query.to);
  const userId = req.user!.id;

  if (dataset === "repayments") {
    const rows = repayments
      .filter((r) => r.borrowerId === userId && inRange(r.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((r) => [
        r.createdAt, r.loanId, csvNairaValue(r.amountNaira), r.status, r.onTime ? "YES" : "NO",
        r.txRef ?? "", r.providerReference ?? "", r.verifiedAt ?? "",
      ]);
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Date", "Loan ID", "Amount (NGN)", "Status", "On Time", "Transaction Ref", "Provider Reference", "Verified At"],
      rows,
    ));
    return;
  }

  if (dataset === "loans") {
    const rows = loanApplications
      .filter((app) => app.borrowerId === userId && inRange(app.createdAt, from, to))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((app) => {
        const loanRecord = loans.find((l) => l.applicationId === app.id);
        return [
          app.applicationId || app.id, app.createdAt, app.applicantType ?? "",
          app.productSnapshot?.productName ?? "", csvNairaValue(app.amountNaira), app.tenureDays ?? "",
          app.status, loanRecord ? loanRecord.status : "", csvNairaValue(loanRecord?.outstandingNaira ?? 0),
          loanRecord?.disbursedAt ?? "", loanRecord?.dueAt ?? "",
        ];
      });
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Application ID", "Created", "Type", "Product", "Principal (NGN)", "Tenure (days)", "Application Status", "Loan Status", "Outstanding (NGN)", "Disbursed At", "Due At"],
      rows,
    ));
    return;
  }

  if (dataset === "schedule") {
    const loanId = String(req.query.loanId ?? "");
    const loan = loans.find((l) => l.id === loanId && l.borrowerId === userId);
    if (!loan) {
      res.status(404).json({ ok: false, error: "Loan not found" });
      return;
    }
    const rows = loanSchedules
      .filter((s) => s.loanId === loanId)
      .sort((a, b) => Number(a.installmentNumber) - Number(b.installmentNumber))
      .map((s) => [
        s.installmentNumber, s.dueDate, csvNairaValue(s.principalNaira), csvNairaValue(s.interestNaira),
        csvNairaValue(s.feesNaira), csvNairaValue(s.totalDueNaira), csvNairaValue(s.totalPaidNaira), s.status,
      ]);
    sendCsvResponse(res, csvFileName(dataset, req.query.from, req.query.to), buildCsv(
      ["Installment", "Due Date", "Principal (NGN)", "Interest (NGN)", "Fees (NGN)", "Total Due (NGN)", "Total Paid (NGN)", "Status"],
      rows,
    ));
    return;
  }

  res.status(400).json({ ok: false, error: `Unknown export dataset '${dataset}'. Available: repayments, loans, schedule` });
});

router.post("/admin/withdrawals/:withdrawalId/retry", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const withdrawalId = String(req.params.withdrawalId);
  const withdrawal = investorWithdrawals.find((item) => item.id === withdrawalId);
  if (!withdrawal) {
    res.status(404).json({ ok: false, error: "Withdrawal not found" });
    return;
  }
  if (withdrawal.status !== "FAILED") {
    res.status(400).json({ ok: false, error: `Only failed withdrawals can be retried. Current status: ${withdrawal.status}` });
    return;
  }
  const settings = getPlatformSettings();
  const minWithdrawNaira = Math.max(200, Number(settings.investorWithdrawalMinAmountNaira ?? 200));
  if (Number(withdrawal.amountNaira) < minWithdrawNaira) {
    res.status(400).json({ ok: false, error: `Minimum withdrawal amount is ₦${minWithdrawNaira.toLocaleString("en-NG")}. Update withdrawal amount.` });
    return;
  }
  const wallet = findWallet(withdrawal.investorId);
  const amountMinor = Math.round(Number(withdrawal.amountNaira) * 100);
  if (!wallet || wallet.availableMinor < amountMinor) {
    res.status(400).json({ ok: false, error: "Insufficient wallet balance to retry this withdrawal" });
    return;
  }
  appendLedger(wallet, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: withdrawal.id,
    amountMinor,
    direction: "DEBIT",
    description: `Withdrawal retry to ${withdrawal.bankName} *${withdrawal.accountNumber.slice(-4)}`,
    metadata: { bankCode: withdrawal.bankCode, accountNumber: withdrawal.accountNumber, feeMinor: Math.round(Number(withdrawal.feeNaira) * 100), netMinor: Math.round(Number(withdrawal.netNaira) * 100) },
  });
  const retryFeeMinor = Math.round(Number(withdrawal.feeNaira) * 100);
  if (retryFeeMinor > 0) {
    appendAdminLedger({
      entryType: "WITHDRAWAL_FEE",
      investorId: withdrawal.investorId,
      referenceId: withdrawal.id,
      amountMinor: retryFeeMinor,
      direction: "CREDIT",
      description: "Withdrawal fee collected on retry",
    });
  }
  // Mirror the retry's wallet debit on the admin ledger (gross, fees included),
  // same as the original initiation — reversed automatically on failure.
  appendAdminLedger({
    entryType: "WITHDRAWAL_OUT",
    investorId: withdrawal.investorId,
    referenceId: withdrawal.id,
    amountMinor,
    direction: "CREDIT",
    description: `Admin ledger credit for investor withdrawal retry (wallet debited incl. fees) — ${withdrawal.bankName || withdrawal.bankCode} ••••${String(withdrawal.accountNumber).slice(-4)}`,
    metadata: {
      grossMinor: amountMinor,
      feeMinor: retryFeeMinor,
      netMinor: Math.round(Number(withdrawal.netNaira) * 100),
      retry: true,
    },
  });
  const execution = await executeInvestorWithdrawal(withdrawal);
  if (!(await persistMutation(res))) return;
  const finalStatus = execution.finalStatus ?? (execution.error ? "FAILED" : "PROCESSING");
  let responseMessage = "Withdrawal retry submitted.";
  if (finalStatus === "SUCCESSFUL") responseMessage = "Withdrawal retry processed successfully and confirmed by the provider.";
  else if (finalStatus === "FAILED") responseMessage = execution.error ? `Withdrawal retry failed and the wallet balance was restored: ${execution.error}` : "Withdrawal retry failed and the wallet balance was restored.";
  else if (finalStatus === "PROCESSING") responseMessage = "Withdrawal retry has been submitted and is being processed. Final status will be confirmed shortly.";
  res.json({
    ok: finalStatus !== "FAILED",
    withdrawal,
    message: responseMessage,
    finalStatus,
    providerResponse: execution.transfer,
    providerVerification: execution.verification,
  });
});

router.get("/providers/flutterwave/banks", requireAuth, async (_req, res) => {
  try {
    const result = await listBanks("NG");
    const banks = Array.isArray(result.data)
      ? result.data
          .filter((b) => b && b.code && b.name)
          .map((b) => ({ id: b.id, code: String(b.code), name: String(b.name), is_nuban_bank: b.is_nuban_bank ?? true }))
      : [];
    res.json({ ok: true, banks });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to load Flutterwave banks",
    });
  }
});

router.get("/investor/payout-accounts", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const accounts = payoutAccounts.filter((a) => a.userId === userId);
  const pendingRequests = accountChangeRequests.filter(
    (r) => r.userId === userId && r.type === "INVESTOR_PAYOUT_ACCOUNT"
  );
  res.json({ ok: true, accounts, pendingRequests });
});

router.post("/investor/payout-accounts/resolve", requireAuth, requireRole("INVESTOR"), async (req, res) => {
  const schema = z.object({
    accountNumber: z.string().regex(/^\d{10}$/, "10-digit account number required"),
    bankCode: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  try {
    const result = await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode);
    if (!result.data?.account_name) {
      res.status(422).json({ ok: false, error: "Unable to resolve account name", result });
      return;
    }
    res.json({
      ok: true,
      accountName: String(result.data.account_name),
      accountNumber: String(result.data.account_number ?? parsed.data.accountNumber),
      resolved: {
        accountName: String(result.data.account_name),
        accountNumber: String(result.data.account_number ?? parsed.data.accountNumber),
      },
    });
  } catch (error) {
    res.status(422).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to verify account",
    });
  }
});

router.post("/investor/payout-accounts", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const parsed = payoutAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const userId = req.user!.id;
  const now = new Date().toISOString();
  const existing = payoutAccounts.find((a) => a.userId === userId);
  if (!existing) {
    const account = {
      id: randomUUID(),
      userId,
      ...parsed.data,
      isDefault: true,
      status: "VERIFIED" as const,
      createdAt: now,
      updatedAt: now,
    };
    payoutAccounts.push(account);
    res.json({ ok: true, account, message: "Payout account saved successfully" });
    return;
  }
  const request = {
    id: randomUUID(),
    userId,
    type: "INVESTOR_PAYOUT_ACCOUNT" as const,
    status: "PENDING_APPROVAL" as const,
    existingSnapshot: JSON.parse(JSON.stringify(existing)),
    newSnapshot: parsed.data as unknown as Record<string, unknown>,
    reason: "Investor requested payout account update",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
  accountChangeRequests.push(request);
  res.status(202).json({
    ok: true,
    pendingApproval: true,
    request,
    message: "Your payout account update has been submitted and is awaiting admin approval.",
  });
});

router.put("/investor/payout-accounts/:accountId", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const existing = payoutAccounts.find((a) => a.id === req.params.accountId && a.userId === userId);
  const parsed = payoutAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  if (!existing) {
    res.status(404).json({ ok: false, error: "Payout account not found" });
    return;
  }
  const now = new Date().toISOString();
  const request = {
    id: randomUUID(),
    userId,
    type: "INVESTOR_PAYOUT_ACCOUNT" as const,
    status: "PENDING_APPROVAL" as const,
    existingSnapshot: JSON.parse(JSON.stringify(existing)),
    newSnapshot: parsed.data as unknown as Record<string, unknown>,
    reason: "Investor requested payout account update",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
  accountChangeRequests.push(request);
  res.status(202).json({
    ok: true,
    pendingApproval: true,
    request,
    message: "Your payout account update has been submitted and is awaiting admin approval.",
  });
});

router.put("/investor/payout-accounts/:accountId/default", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const userId = req.user!.id;
  const target = payoutAccounts.find((a) => a.id === req.params.accountId && a.userId === userId);
  if (!target) {
    res.status(404).json({ ok: false, error: "Payout account not found" });
    return;
  }
  for (const account of payoutAccounts) {
    if (account.userId === userId) account.isDefault = account.id === target.id;
  }
  target.updatedAt = new Date().toISOString();
  res.json({ ok: true, account: target });
});

// ---------- Urgent disbursement-account update flow (borrower side) --------
// When a loan carries disbursementAccountNeedsUpdate (provider rejected the
// saved account, or the admin explicitly requested it), the borrower's settings
// update must apply IMMEDIATELY (auto-approved), map onto every open
// application/loan, and clear the attention flags — otherwise the customer
// would be stuck behind the standard admin-approval queue while their
// disbursement is blocked.

function borrowerHasAccountUpdateRequest(borrowerId: string): boolean {
  return loans.some((l) => l.borrowerId === borrowerId && l.disbursementAccountNeedsUpdate === true);
}

function clearBorrowerAccountUpdateFlags(borrowerId: string): void {
  const now = new Date().toISOString();
  for (const loan of loans) {
    if (loan.borrowerId !== borrowerId) continue;
    if (loan.disbursementAccountNeedsUpdate) {
      loan.disbursementAccountNeedsUpdate = false;
      loan.updatedAt = now;
    }
  }
}

// Stamp a freshly applied account onto every open application of the borrower
// (replacing any previous account) so the disbursement resolution order —
// saved account first, then application account — can never fall back to the
// stale/rejected one.
function stampAccountOnOpenApplications(borrowerId: string, accountPayload: { accountName: string; accountNumber: string; bankCode: string; bankName?: string }): number {
  const openStatuses = ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "DISBURSEMENT_PENDING"];
  const now = new Date().toISOString();
  let stamped = 0;
  for (const application of loanApplications) {
    if (application.borrowerId !== borrowerId || !openStatuses.includes(String(application.status))) continue;
    const snap = (application.customerSnapshot ?? {}) as Record<string, unknown>;
    const accountWithMeta = { ...accountPayload, institution: "VELO" };
    application.disbursementAccount = accountWithMeta as typeof application.disbursementAccount;
    application.customerSnapshot = { ...snap, disbursementAccount: accountWithMeta } as typeof application.customerSnapshot;
    application.updatedAt = now;
    stamped += 1;
  }
  return stamped;
}

router.get("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const borrowerId = req.user!.id;
  const saved = disbursementAccounts.find((a) => a.borrowerId === borrowerId) ?? null;
  const pendingRequests = accountChangeRequests.filter(
    (r) => r.userId === borrowerId && r.type === "BORROWER_DISBURSEMENT_ACCOUNT"
  );
  // Visibility guarantee: while a loan application is submitted the settings
  // form is LOCKED — but locked must never mean INVISIBLE. When no standalone
  // account is saved, fall back to the account the borrower submitted WITH the
  // most recent open application so they can always see exactly where their
  // loan will be paid. `accountSource` lets the UI label it appropriately.
  let account = saved;
  let accountSource: "saved" | "application" | null = saved ? "saved" : null;
  if (!account) {
    const openStatuses = ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID"];
    const application = loanApplications
      .filter((a) => a.borrowerId === borrowerId && openStatuses.includes(String(a.status)))
      .sort((a, b) => String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? "")))
      .find((a) => {
        const top = (a.disbursementAccount ?? {}) as Record<string, unknown>;
        const snap = (((a.customerSnapshot ?? {}) as Record<string, unknown>).disbursementAccount ?? {}) as Record<string, unknown>;
        return Boolean(top.accountNumber || snap.accountNumber);
      });
    if (application) {
      const snap = (((application.customerSnapshot ?? {}) as Record<string, unknown>).disbursementAccount ?? {}) as Record<string, unknown>;
      const merged = { ...snap, ...((application.disbursementAccount ?? {}) as Record<string, unknown>) };
      if (merged.accountNumber) {
        account = {
          id: `application:${application.id}`,
          borrowerId,
          bankCode: String(merged.bankCode ?? ""),
          bankName: merged.bankName ? String(merged.bankName) : undefined,
          accountNumber: String(merged.accountNumber),
          accountName: merged.accountName ? String(merged.accountName) : undefined,
          status: "ACTIVE" as const,
          createdAt: application.createdAt,
          updatedAt: application.updatedAt ?? application.createdAt,
          rejectionReason: null,
        };
        accountSource = "application";
      }
    }
  }
  res.json({ ok: true, account: account ?? null, accountSource, pendingRequests, updateRequested: borrowerHasAccountUpdateRequest(borrowerId) });
});

router.post("/borrower/disbursement-account/resolve", requireAuth, requireRole("BORROWER"), async (req, res) => {
  const schema = z.object({
    accountNumber: z.string().regex(/^\d{10}$/, "10-digit account number required"),
    bankCode: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  try {
    const result = await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode);
    if (!result.data?.account_name) {
      res.status(422).json({ ok: false, error: "Unable to resolve account name", result });
      return;
    }
    res.json({
      ok: true,
      accountName: String(result.data.account_name),
      resolved: {
        accountName: String(result.data.account_name),
        accountNumber: String(result.data.account_number ?? parsed.data.accountNumber),
      },
    });
  } catch (error) {
    res.status(422).json({
      ok: false,
      error: error instanceof Error ? error.message : "Unable to verify account",
    });
  }
});

router.post("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const schema = z.object({
    accountName: z.string().min(2),
    accountNumber: z.string().regex(/^\d{10}$/,
      "10-digit account number required"),
    bankCode: z.string().min(1),
    bankName: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const borrowerId = req.user!.id;
  const now = new Date().toISOString();
  if (borrowerHasAccountUpdateRequest(borrowerId)) {
    // URGENT path (loan disbursal blocked on this account): verify the new
    // account with Flutterwave first — a definitive rejection means the
    // customer mistyped something and we must NOT queue a broken account.
    try {
      await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode, parsed.data.bankName);
    } catch (error) {
      const httpStatus = (error as { httpStatus?: number }).httpStatus;
      const message = error instanceof Error ? error.message : "Could not verify the account";
      if (env.FLUTTERWAVE_SECRET_KEY && (typeof httpStatus !== "number" || httpStatus < 500)) {
        res.status(400).json({ ok: false, error: `Flutterwave rejected this account: ${message}. Please check the account number and bank, then try again.` });
        return;
      }
      // Provider outage (5xx/network) — accept but note it in the logs;
      // blocking the customer on an outage would be worse.
      console.warn(`[routes] urgent disbursement-account update accepted without verification for user=${borrowerId}: ${message}`);
    }
    // Bank-code normalization: the queued account must always carry a
    // Flutterwave-native code (prevents a repeat of "Unknown Bank Code").
    let normalizedBankCode = parsed.data.bankCode;
    try {
      normalizedBankCode = await normalizeBankCodeForFlutterwave(parsed.data.bankCode, parsed.data.bankName);
    } catch (_normError) {
      // Keep the provided code if the live list is unavailable.
    }
    const accountPayload = { ...parsed.data, bankCode: normalizedBankCode };
    const existingAccount = disbursementAccounts.find((a) => a.borrowerId === borrowerId);
    // Every account CHANGE is logged for admin review and approval BEFORE it
    // takes effect — the current account stays active until an admin approves.
    const request = {
      id: randomUUID(),
      userId: borrowerId,
      type: "BORROWER_DISBURSEMENT_ACCOUNT" as const,
      status: "PENDING_APPROVAL" as const,
      existingSnapshot: existingAccount ? JSON.parse(JSON.stringify(existingAccount)) : null,
      newSnapshot: accountPayload as unknown as Record<string, unknown>,
      reason: "Urgent update — loan disbursal was blocked on the previous account; awaiting admin approval",
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    accountChangeRequests.push(request);
    schedulePersist();
    console.info(`[routes] urgent disbursement-account update QUEUED for admin approval user=${borrowerId}`);
    res.status(202).json({
      ok: true,
      pendingApproval: true,
      applied: false,
      request,
      message: "Your new disbursement account has been verified and submitted. It will take effect as soon as the admin approves the change.",
    });
    return;
  }
  const existing = disbursementAccounts.find((a) => a.borrowerId === borrowerId);
  if (!existing) {
    const account = {
      id: randomUUID(),
      borrowerId,
      ...parsed.data,
      status: "ACTIVE" as const,
      createdAt: now,
      updatedAt: now,
      rejectionReason: null,
    };
    disbursementAccounts.push(account);
    // Self-healing: attach this account to every open loan application that
    // has no disbursement account (e.g. legacy applications submitted before
    // the account was enforced). Admin disbursement then works immediately —
    // the borrower must NOT be trapped between "application already submitted"
    // and "no disbursement account found".
    const openStatuses = ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED"];
    let stamped = 0;
    for (const application of loanApplications) {
      if (application.borrowerId !== borrowerId || !openStatuses.includes(String(application.status))) continue;
      const snap = (application.customerSnapshot ?? {}) as Record<string, unknown>;
      const hasAccount = Boolean(
        ((application.disbursementAccount ?? {}) as Record<string, unknown>).accountNumber ||
        ((snap.disbursementAccount ?? {}) as Record<string, unknown>).accountNumber
      );
      if (hasAccount) continue;
      const accountPayload = { ...parsed.data, institution: "VELO" };
      application.disbursementAccount = accountPayload as typeof application.disbursementAccount;
      application.customerSnapshot = { ...snap, disbursementAccount: accountPayload } as typeof application.customerSnapshot;
      application.updatedAt = now;
      stamped += 1;
    }
    if (stamped > 0) {
      schedulePersist();
      console.info(`[routes] stamped borrower disbursement account onto ${stamped} open application(s) user=${borrowerId}`);
    }
    res.json({ ok: true, account, message: "Disbursement account saved successfully", stampedApplications: stamped });
    return;
  }
  const request = {
    id: randomUUID(),
    userId: borrowerId,
    type: "BORROWER_DISBURSEMENT_ACCOUNT" as const,
    status: "PENDING_APPROVAL" as const,
    existingSnapshot: JSON.parse(JSON.stringify(existing)),
    newSnapshot: parsed.data as unknown as Record<string, unknown>,
    reason: "Borrower requested disbursement account update",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
  accountChangeRequests.push(request);
  res.status(202).json({
    ok: true,
    pendingApproval: true,
    request,
    message: "Your disbursement account update has been submitted and is awaiting admin approval.",
  });
});

router.put("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), async (req: AuthRequest, res) => {
  const schema = z.object({
    accountName: z.string().min(2),
    accountNumber: z.string().regex(/^\d{10}$/, "10-digit account number required"),
    bankCode: z.string().min(1),
    bankName: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const borrowerId = req.user!.id;
  const existing = disbursementAccounts.find((a) => a.borrowerId === borrowerId);
  if (!existing) {
    res.status(404).json({ ok: false, error: "No disbursement account exists. Please create one first." });
    return;
  }
  const now = new Date().toISOString();
  if (borrowerHasAccountUpdateRequest(borrowerId)) {
    // URGENT path — mirror of the POST handler: verify, then QUEUE for admin
    // approval (changes never take effect without an admin approving them).
    try {
      await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode, parsed.data.bankName);
    } catch (error) {
      const httpStatus = (error as { httpStatus?: number }).httpStatus;
      const message = error instanceof Error ? error.message : "Could not verify the account";
      if (env.FLUTTERWAVE_SECRET_KEY && (typeof httpStatus !== "number" || httpStatus < 500)) {
        res.status(400).json({ ok: false, error: `Flutterwave rejected this account: ${message}. Please check the account number and bank, then try again.` });
        return;
      }
      console.warn(`[routes] urgent disbursement-account update accepted without verification for user=${borrowerId}: ${message}`);
    }
    let normalizedBankCode = parsed.data.bankCode;
    try {
      normalizedBankCode = await normalizeBankCodeForFlutterwave(parsed.data.bankCode, parsed.data.bankName);
    } catch (_normError) {
      // Keep the provided code if the live list is unavailable.
    }
    const accountPayload = { ...parsed.data, bankCode: normalizedBankCode };
    const request = {
      id: randomUUID(),
      userId: borrowerId,
      type: "BORROWER_DISBURSEMENT_ACCOUNT" as const,
      status: "PENDING_APPROVAL" as const,
      existingSnapshot: JSON.parse(JSON.stringify(existing)),
      newSnapshot: accountPayload as unknown as Record<string, unknown>,
      reason: "Urgent update — loan disbursal was blocked on the previous account; awaiting admin approval",
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    accountChangeRequests.push(request);
    schedulePersist();
    console.info(`[routes] urgent disbursement-account update (PUT) QUEUED for admin approval user=${borrowerId}`);
    res.status(202).json({
      ok: true,
      pendingApproval: true,
      applied: false,
      request,
      message: "Your new disbursement account has been verified and submitted. It will take effect as soon as the admin approves the change.",
    });
    return;
  }
  const request = {
    id: randomUUID(),
    userId: borrowerId,
    type: "BORROWER_DISBURSEMENT_ACCOUNT" as const,
    status: "PENDING_APPROVAL" as const,
    existingSnapshot: JSON.parse(JSON.stringify(existing)),
    newSnapshot: parsed.data as unknown as Record<string, unknown>,
    reason: "Borrower requested disbursement account update",
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    createdAt: now,
    updatedAt: now,
  };
  accountChangeRequests.push(request);
  res.status(202).json({
    ok: true,
    pendingApproval: true,
    request,
    message: "Your disbursement account update has been submitted and is awaiting admin approval.",
  });
});

router.get("/admin/account-requests", requireAuth, requireRole("ADMIN"), (req, res) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  const userIdFilter = typeof req.query.userId === "string" ? req.query.userId : undefined;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  let filtered = accountChangeRequests.slice();
  if (statusFilter) filtered = filtered.filter((r) => r.status === statusFilter);
  if (userIdFilter) filtered = filtered.filter((r) => r.userId === userIdFilter);
  filtered.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = filtered.length;
  const items = filtered.slice(offset, offset + limit).map((r) => {
    const user = users.find((u) => u.id === r.userId);
    return {
      ...r,
      user: user ? { id: user.id, fullName: user.fullName, email: user.email, phone: user.phone } : undefined,
    };
  });
  res.json({ ok: true, total, requests: items });
});

function applyAccountChange(request: (typeof accountChangeRequests)[number]): { ok: boolean; reason?: string } {
  if (request.type === "INVESTOR_PAYOUT_ACCOUNT") {
    const snapshot = request.newSnapshot as Partial<(typeof payoutAccounts)[number]>;
    if (!snapshot?.accountNumber || !snapshot?.bankCode) return { ok: false, reason: "Invalid snapshot" };
    let account = payoutAccounts.find((a) => a.userId === request.userId);
    const now = new Date().toISOString();
    if (account) {
      Object.assign(account, {
        ...snapshot,
        updatedAt: now,
        status: account.status || "VERIFIED",
      });
    } else {
      account = {
        id: randomUUID(),
        userId: request.userId,
        bankCode: snapshot.bankCode,
        accountNumber: snapshot.accountNumber,
        bankName: snapshot.bankName,
        accountName: snapshot.accountName,
        isDefault: true,
        status: "VERIFIED",
        createdAt: now,
        updatedAt: now,
      };
      payoutAccounts.push(account);
    }
    return { ok: true };
  }
  if (request.type === "BORROWER_DISBURSEMENT_ACCOUNT") {
    const snapshot = request.newSnapshot as Partial<(typeof disbursementAccounts)[number]>;
    if (!snapshot?.accountNumber || !snapshot?.bankCode) return { ok: false, reason: "Invalid snapshot" };
    let account = disbursementAccounts.find((a) => a.borrowerId === request.userId);
    const now = new Date().toISOString();
    if (account) {
      Object.assign(account, {
        ...snapshot,
        updatedAt: now,
        status: "ACTIVE",
        rejectionReason: null,
      });
    } else {
      account = {
        id: randomUUID(),
        borrowerId: request.userId,
        bankCode: snapshot.bankCode,
        accountNumber: snapshot.accountNumber,
        bankName: snapshot.bankName,
        accountName: snapshot.accountName,
        status: "ACTIVE",
        rejectionReason: null,
        createdAt: now,
        updatedAt: now,
      };
      disbursementAccounts.push(account);
    }
    // Map the approved account onto the borrower's open applications and clear
    // any outstanding account-update attention flags, so an approved change
    // unblocks disbursement exactly like the urgent (auto-approved) path.
    const accountPayload = {
      accountName: String(account.accountName ?? snapshot.accountName ?? ""),
      accountNumber: String(account.accountNumber ?? snapshot.accountNumber ?? ""),
      bankCode: String(account.bankCode ?? snapshot.bankCode ?? ""),
      bankName: account.bankName ?? snapshot.bankName,
    };
    if (accountPayload.accountNumber && accountPayload.bankCode) {
      stampAccountOnOpenApplications(request.userId, accountPayload);
    }
    clearBorrowerAccountUpdateFlags(request.userId);
    return { ok: true };
  }
  return { ok: false, reason: `Unknown request type: ${request.type}` };
}

router.put("/admin/account-requests/:requestId/approve", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const request = accountChangeRequests.find((r) => r.id === req.params.requestId);
  if (!request) {
    res.status(404).json({ ok: false, error: "Account change request not found" });
    return;
  }
  if (request.status !== "PENDING_APPROVAL") {
    res.status(409).json({ ok: false, error: `Request is already ${request.status}` });
    return;
  }
  const applied = applyAccountChange(request);
  if (!applied.ok) {
    res.status(400).json({ ok: false, error: applied.reason ?? "Unable to apply changes" });
    return;
  }
  const now = new Date().toISOString();
  request.status = "APPROVED";
  request.reviewedBy = req.user?.id ?? "admin";
  request.reviewedAt = now;
  request.updatedAt = now;
  res.json({ ok: true, request });
});

router.put("/admin/account-requests/:requestId/reject", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const schema = z.object({ rejectionReason: z.string().max(500).optional() });
  const parsed = schema.safeParse(req.body);
  const request = accountChangeRequests.find((r) => r.id === req.params.requestId);
  if (!request) {
    res.status(404).json({ ok: false, error: "Account change request not found" });
    return;
  }
  if (request.status !== "PENDING_APPROVAL") {
    res.status(409).json({ ok: false, error: `Request is already ${request.status}` });
    return;
  }
  const now = new Date().toISOString();
  request.status = "REJECTED";
  request.reviewedBy = req.user?.id ?? "admin";
  request.reviewedAt = now;
  request.rejectionReason = parsed.data?.rejectionReason ?? "Rejected by admin";
  request.updatedAt = now;
  res.json({ ok: true, request });
});

router.get("/admin/disbursements", requireAuth, requireRole("ADMIN"), (req, res) => {
  // Self-healing: converge rows stuck in PROCESSING/PENDING (server restart
  // mid-transfer, verification timeouts, …) against the provider. Fire-and-
  // forget so the listing never blocks; the admin UI's 3s poller picks up the
  // converged status on its next fetch.
  void reconcileStaleDisbursements().catch((err) => console.error("[routes] disbursement reconciliation sweep failed:", err));
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  let items = loanDisbursements.slice();
  if (statusFilter) items = items.filter((d) => d.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const total = items.length;
  const disbursements = items.slice(offset, offset + limit).map((d) => {
    const borrower = users.find((u) => u.id === d.borrowerId);
    return {
      ...d,
      borrowerName: borrower?.fullName,
    };
  });
  res.json({ ok: true, total, disbursements });
});

router.get("/admin/borrowers/:borrowerId/disbursements", requireAuth, requireRole("ADMIN"), (req, res) => {
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined;
  let items = loanDisbursements.filter((d) => d.borrowerId === req.params.borrowerId);
  if (statusFilter) items = items.filter((d) => d.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ ok: true, total: items.length, disbursements: items });
});

router.post("/admin/disbursements/:disbursementId/retry", requireAuth, requireRole("ADMIN"), async (req: AuthRequest, res) => {
  const prev = loanDisbursements.find((d) => d.id === req.params.disbursementId);
  if (!prev) {
    res.status(404).json({ ok: false, error: "Disbursement record not found" });
    return;
  }
  if (prev.status !== "FAILED") {
    res.status(409).json({ ok: false, error: "Only definitively failed disbursements can be retried. Reconcile the provider transfer before retrying." });
    return;
  }
  const activeTransfer = loanDisbursements.find((item) => item.loanId === prev.loanId && ["PROCESSING", "PENDING", "SUCCESSFUL"].includes(item.status));
  if (activeTransfer) {
    res.status(409).json({ ok: false, error: "A disbursement is already in progress or completed for this loan" });
    return;
  }
  const loan = loans.find((l) => l.id === prev.loanId);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  // Same duplicate-disbursement protection as the initiate route: a loan that
  // already settled (SUCCESSFUL transfer / ACTIVE+) must never be re-funded
  // via a retry of an older failed attempt.
  const retryApplication = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
  if (loanAlreadyDisbursed(loan, retryApplication)) {
    res.status(409).json({
      ok: false,
      code: "ALREADY_DISBURSED",
      error: "Loan already disbursed and active, can't disburse duplicate loan.",
    });
    return;
  }
  // Account freshness: prefer the borrower's CURRENT saved disbursement account
  // (they may have re-provided it after the failure — the urgent update flow),
  // falling back to the failed attempt's details only when no saved account
  // exists. Retrying into the stale account would repeat the same rejection.
  const savedActiveAccount = disbursementAccounts.find(
    (item) => item.borrowerId === loan.borrowerId && item.status === "ACTIVE" && item.accountNumber && item.bankCode
  );
  const retrySource = savedActiveAccount ?? prev;
  if (!retrySource.accountNumber || !retrySource.bankCode) {
    res.status(400).json({ ok: false, error: "Previous disbursement is missing bank/account details" });
    return;
  }
  // Narrowed copies for the background closure (TS cannot carry the guard's
  // narrowing into the async IIFE below).
  const retryAccountNumber = retrySource.accountNumber;
  const retryBankCode = retrySource.bankCode;
  const now = new Date().toISOString();
  const retryCount = (prev.retryCount ?? 0) + 1;
  const retry: (typeof loanDisbursements)[number] = {
    id: randomUUID(),
    loanId: prev.loanId,
    applicationId: prev.applicationId,
    borrowerId: prev.borrowerId,
    amountNaira: prev.amountNaira,
    currency: prev.currency,
    bankCode: String(retryBankCode),
    bankName: retrySource.bankName ?? prev.bankName,
    accountNumber: String(retryAccountNumber),
    accountName: retrySource.accountName ?? prev.accountName,
    status: "PROCESSING",
    narration: prev.narration ? `${prev.narration} (retry #${retryCount})` : undefined,
    providerTransfer: null,
    providerReference: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    retryOfId: prev.id,
    retryCount,
  };
  loanDisbursements.push(retry);
  loan.status = "DISBURSEMENT_PENDING";
  loan.updatedAt = now;
  schedulePersist();
  recordAdminAudit(req, "LOAN_DISBURSEMENT_RETRY_INITIATED", "LOAN", loan.id, { applicationId: prev.applicationId, retryOfId: prev.id, retryCount, disbursementId: retry.id });

  // SYNCHRONOUS retry — identical contract to the initiate route: this response
  // carries Flutterwave's REAL final answer (or a still-processing 202 if the
  // provider needs longer than the ~30s budget).
  const retryLoanApp = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
  const result = await executeLoanTransferAttempt({
    req,
    loan,
    application: retryLoanApp,
    disbursement: retry,
    account: {
      accountName: retrySource.accountName ?? prev.accountName,
      accountNumber: retryAccountNumber,
      bankCode: retryBankCode,
      bankName: retrySource.bankName ?? prev.bankName,
    },
    narration: retry.narration ?? `Velo loan disbursement retry ${loan.id}`,
    txRef: `VELO-DISBURSE-${loan.id}-${retry.id.slice(0, 8)}`,
  });
  if (result.outcome === "FAILED") {
    res.status(200).json({ ok: false, final: true, loan, disbursement: retry, error: result.error, message: result.message });
  } else if (result.outcome === "PENDING") {
    res.status(202).json({ ok: true, final: false, loan, disbursement: retry, message: result.message });
  } else {
    res.status(200).json({ ok: true, final: true, loan, disbursement: retry, message: result.message });
  }
});

export default router;
