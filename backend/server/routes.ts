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
  loanDisbursements,
  disbursementAccounts,
  accountChangeRequests,
  indexes,
  listRecentJobRuns,
  decomposeRuntimeStateIntoTables,
  reloadStoreFromRelationalTables,
  persistStore,
} from "./store.js";
import { runExportSheetsBackup } from "./exportSheetsBackup.js";
import { env } from "./config.js";
import { sql } from "./db.js";
import { uploadPrivateDocument } from "./storage/googleDrive.js";
import { calculateCreditScore } from "./credit.js";
import { evaluateLoanEligibility } from "./loanDecision.js";
import {
  initializeRepayment,
  createLoanDisbursement,
  createInvestorPayout,
  initializeWalletFunding,
  verifyTransaction,
  verifyTransactionWithRetry,
  verifyTransferWithRetry,
  resolveBankAccount,
  listBanks,
} from "./providers/flutterwave.js";
import { verifyBvn, verifyNin, verifyIdentityWithFace, requestCreditReport } from "./providers/prembly.js";
import { sendEmail, investorWithdrawalEmail, investorWalletFundedEmail, welcomeEmail, loginAttemptEmail, kycStatusEmail, loanApplicationSubmittedEmail, loanDecisionEmail, loanAwaitingDisbursementEmail, loanDisbursedEmail } from "./email.js";
import type { KycCategory, KycCategoryResult } from "./store.js";

const router = Router();
const PERSIST_TIMEOUT_MS = 45_000;

async function persistMutation(res: any): Promise<boolean> {
  if (!sql) {
    res.status(503).json({ ok: false, error: "PostgreSQL is not configured. Your information was not saved." });
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      persistStore(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Persistence timed out")), PERSIST_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    console.error("[routes] PostgreSQL persistence failed:", error);
    res.status(503).json({ ok: false, error: "Unable to save your information right now. Please try again." });
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

type PersistBestEffortResult = { ok: true; persistRetrying: false } | { ok: true; persistRetrying: true; persistError: string };

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
  disbursementAccount: z.record(z.unknown()).default({}),
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
  user.lastLoginAt = new Date().toISOString();
  await notifyLogin(user, req);
  res.json({ ok: true, accessToken: issueToken(user), user: { id: user.id, email: user.email, fullName: user.fullName, phone: user.phone, roles: user.roles, kycStatus: user.kycStatus, createdAt: user.createdAt } });
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
  const kyc = findOrCreateKycCase(req.user!.id);
  const requiredChecks = ["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const;
  if (!requiredChecks.every((key) => kyc.checklist[key]) && ["PENDING_VERIFICATION", "VERIFIED"].includes(kyc.status)) {
    kyc.status = "IN_PROGRESS";
    kyc.submittedAt = undefined;
    kyc.updatedAt = new Date().toISOString();
    const user = users.find((item) => item.id === req.user!.id);
    if (user) user.kycStatus = kyc.status;
  }
  const userDocs = documents.filter((d) => d.userId === req.user?.id);
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
  res.json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    categoryResults: kyc.categoryResults ?? {},
    bvn: kyc.bvn,
    nin: kyc.nin,
    bvnLastFour: kyc.bvn ? kyc.bvn.slice(-4) : undefined,
    ninLastFour: kyc.nin ? kyc.nin.slice(-4) : undefined,
    submittedAt: kyc.submittedAt,
    rejectionReason: kyc.rejectionReason,
    documents: userDocs,
    verificationEvents: safeVerificationEvents,
    selfieImageData: undefined,
    livenessStatus: kyc.livenessStatus,
    livenessManualUploaded: kyc.livenessManualUploaded ?? false,
    verifiedDetails: Object.keys(source).length ? source : undefined,
    normalizedFields: Object.keys(normalizedFields).length ? normalizedFields : undefined,
    profilePrefill: Object.keys(profilePrefill).length ? profilePrefill : undefined,
    proofOfAddressUrl,
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
  const hasDocumentsForSubmit = (kyc.checklist.bvn && kyc.checklist.nin);
  const submittedViaOverride = parsed.data.statusOverride === "PENDING_VERIFICATION";
  if (submittedViaOverride && hasDocumentsForSubmit) {
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
  res.status(202).json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    message:
      kyc.status === "VERIFIED"
        ? "KYC is verified."
        : kyc.status === "PENDING_VERIFICATION"
        ? "KYC submitted for verification. Provider credentials are required for automated checks."
        : "KYC updated. Verify your BVN and NIN and upload proof of address to submit.",
  });
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
    kyc.providerRaw = result.rawResponse;
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
    kyc.providerRaw = result.rawResponse;
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
    const stored = await uploadPrivateDocument({
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      buffer: req.file.buffer,
      userId: req.user!.id,
      documentType: documentType.data,
    });
    const record = {
      id: randomUUID(),
      userId: req.user!.id,
      documentType: documentType.data,
      provider: stored.provider,
      providerFileId: stored.fileId,
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
      if (isImage) {
        kyc.selfieImageData = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      }
      kyc.livenessStatus = "PENDING_REVIEW";
      kyc.livenessManualUploaded = true;
      identityVerificationEvents.push({ id: randomUUID(), kycCaseId: kyc.id, provider: "manual", verificationType: "LIVENESS", status: "PENDING_REVIEW", createdAt: new Date().toISOString() });
    }
    if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
    kyc.updatedAt = new Date().toISOString();
    markKycChecklistComplete(req.user!.id);
    if (!(await persistMutation(res))) return;
    res.status(201).json({ ok: true, document: record, checklist: kyc.checklist, message: "Document uploaded for admin review." });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Document storage unavailable",
    });
  }
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
  if (!(await persistMutation(res))) return;
  try {
    const checkout = await initializeWalletFunding({
      txRef,
      amountNaira: parsed.data.amountNaira,
      email: user?.email ?? req.user!.email,
      phone: user?.phone ?? "",
      name: user?.fullName ?? req.user!.fullName,
      redirectUrl: `${env.API_PUBLIC_URL}/api/v1/payments/flutterwave/return`,
    });
    res.status(202).json({
      ok: true,
      txRef,
      amountNaira: parsed.data.amountNaira,
      checkout,
      message:
        "Funding intent created. Complete Flutterwave checkout. Your wallet is credited only after verified server-to-server confirmation.",
    });
  } catch (error) {
    res.status(503).json({
      ok: true,
      txRef,
      amountNaira: parsed.data.amountNaira,
      checkout: null,
      message:
        "Funding intent created locally. Configure Flutterwave to produce a checkout link; otherwise verify manually.",
      error: error instanceof Error ? error.message : "Flutterwave unavailable",
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
      if (!(await persistMutation(res))) return;
      res.status(402).json({ ok: false, error: `Payment status=${verification.status}, wallet not credited`, txRef, status: verification.status });
      return;
    }
    const settled = settleWalletDeposit({ txRef, providerReference: flwRef, providerTransactionId: parsed.data.transactionId });
    if (!settled.ok) {
      res.status(409).json({ ok: false, error: settled.reason ?? "Unable to settle deposit", txRef });
      return;
    }
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
        // Email failure is not fatal to funding settlement
      }
    }
    if (!(await persistMutation(res))) return;
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
    res.status(409).json({
      ok: false,
      error: "KYC must be completed and verified before creating an investment.",
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

router.get("/investor/withdrawals/status", requireAuth, requireRole("INVESTOR"), async (req: AuthRequest, res) => {
  const pending = investorWithdrawals.filter((item) => item.investorId === req.user!.id && ["PENDING", "PROCESSING"].includes(item.status));
  const refreshed = [];
  for (const withdrawal of pending) {
    const transfer = (withdrawal.providerTransfer ?? {}) as { initiate?: { data?: { id?: number | string; reference?: string } }; verification?: Record<string, unknown> };
    const transferId = String(transfer.initiate?.data?.id ?? "");
    const reference = withdrawal.providerReference ?? String(transfer.initiate?.data?.reference ?? `WITHDRAWAL-${withdrawal.id}`);
    if (!transferId && !reference) continue;
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
    refreshed.push(withdrawal);
  }
  if (refreshed.length > 0) await persistStore();
  res.json({ ok: true, withdrawals: refreshed, wallet: findWallet(req.user!.id) });
});

router.get("/investor/transactions", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const wallet = findWallet(req.user!.id);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const userInvestments = indexes.investmentsByInvestorId.get(req.user!.id) ?? [];
  const userPayouts = indexes.payoutsByUserId.get(req.user!.id) ?? [];
  const userLedger = (indexes.ledgerEntriesByWalletId.get(wallet.id) ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const userWalletTxs = (indexes.walletTransactionsByUserId.get(req.user!.id) ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const sliced = {
    investments: userInvestments.slice(offset, offset + limit),
    payouts: userPayouts.slice(offset, offset + limit),
    ledger: userLedger.slice(offset, offset + limit),
    walletTransactions: userWalletTxs.slice(offset, offset + limit),
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
      },
      hasMore: {
        investments: offset + limit < userInvestments.length,
        payouts: offset + limit < userPayouts.length,
        ledger: offset + limit < userLedger.length,
        walletTransactions: offset + limit < userWalletTxs.length,
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
  //   REPAID    -> loan fully repaid
  //   DISBURSED -> loan money has been sent to the borrower's bank account
  //                (covers ACTIVE, DISBURSED, PAST_DUE, DEFAULTED, WRITTEN_OFF)
  //   APPROVED  -> admin approved, awaiting disbursement
  //   (others)  -> fall through to current application status
  // We deliberately map ACTIVE loans to the "DISBURSED" application status
  // so the borrower and admin UIs can show "Disbursed" instead of the
  // internal "Active" lifecycle label.
  const disbursedLikeStatuses: LoanStatus[] = ["DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "WRITTEN_OFF"];
  const nextStatus: string = loan.status === "REPAID" ? "REPAID"
                  : disbursedLikeStatuses.includes(loan.status as LoanStatus) ? "DISBURSED"
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
  res.json({
    ok: true,
    applications: userApplications,
    loans: userLoans,
    repayments: userRepayments,
    disbursementAccount,
  });
});

router.get("/borrower/loan-products", requireAuth, requireRole("BORROWER"), (_req, res) => {
  res.json({ ok: true, products: loanProducts.filter((p) => p.isActive) });
});

router.get("/borrower/application-draft", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const drafts = applicationDrafts
    .filter((draft) => draft.userId === req.user!.id)
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
      res.status(400).json({ ok: false, error: parsed.error.flatten() });
      return;
    }
    const input = { ...parsed.data, ...compactApplicationPayload(parsed.data) };
    if (input.applicationId) {
      const existingApplication = loanApplications.find((item) => item.applicationId === input.applicationId);
      if (existingApplication) {
        if (existingApplication.borrowerId !== req.user!.id) {
          res.status(409).json({ ok: false, error: "That application reference ID is already in use." });
        } else {
          const reconciled = synchronizeLoanApplicationStatus(existingApplication);
          if (reconciled) await persistStore().catch(() => undefined);
          res.status(200).json({ ok: true, application: existingApplication, duplicate: true });
        }
        return;
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
    if (!kyc.checklist.bvn || !kyc.checklist.nin || !kyc.checklist.liveness) {
      res.status(409).json({ ok: false, error: "BVN, NIN, and liveness verification must be completed before submitting a loan application." });
      return;
    }
    const user = users.find((item) => item.id === req.user!.id);
    recordConsent(req.user!.id, "CREDIT_REPORT");

    const kycBvnData = (kyc.providerRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data ?? {};
    const bvnFullName: string | undefined =
      [kycBvnData.title ? `${String(kycBvnData.title)} ` : "", kycBvnData.firstName, kycBvnData.middleName ? `${String(kycBvnData.middleName)} ` : "", kycBvnData.lastName]
        .filter(Boolean).join(" ") || undefined;
    const bvnDob: string | undefined = typeof kycBvnData.dateOfBirth === "string" ? kycBvnData.dateOfBirth : undefined;
    const now = new Date().toISOString();

    let latestExternalCredit = creditReports
      .filter((item) => item.userId === req.user!.id && item.status === "RECEIVED" && item.score != null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    const creditBureauPromise: Promise<CreditReport | null> = (async (): Promise<CreditReport | null> => {
      try {
        const hasBvn = typeof kyc.bvn === "string" && kyc.bvn.length === 11;
        const cbResult = await requestCreditReport(
          hasBvn
            ? { mode: "ID", number: kyc.bvn, customer_name: bvnFullName ?? user?.fullName, dob: bvnDob ?? user?.dateOfBirth }
            : { mode: "BIO", customer_name: user?.fullName, dob: user?.dateOfBirth }
        );
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
        const report: CreditReport = {
          id: randomUUID(),
          userId: req.user!.id,
          provider: "prembly" as const,
          consentGrantedAt: now,
          requestedAt: now,
          reportReference: cbResult.providerReference,
          status: cbStatus,
          score: cbScore,
          normalizedFields: cbResult.normalizedFields,
          redactedRaw: cbRaw,
          createdAt: now,
        };
        creditReports.push(report);
        return report;
      } catch (_e) {
        return null;
      }
    })();

    const currentExternalCredit = await creditBureauPromise;
    if (currentExternalCredit) latestExternalCredit = currentExternalCredit;

    void creditBureauPromise.then((report) => {
      if (!report || report.status !== "RECEIVED" || report.score == null) return;
      const idx = creditScores.findIndex((s) => s.userId === req.user!.id);
      if (idx < 0) return;
      const recomputed = calculateCreditScore({
        completedLoans: loans.filter((item) => item.borrowerId === req.user!.id && item.status === "REPAID").length,
        onTimePayments: repayments.filter((item) => item.borrowerId === req.user!.id && item.status === "SUCCESSFUL" && item.onTime === true).length,
        latePayments: repayments.filter((item) => item.borrowerId === req.user!.id && item.status === "SUCCESSFUL" && item.onTime === false).length,
        defaultedLoans: loans.filter((item) => item.borrowerId === req.user!.id && item.status === "DEFAULTED").length,
        outstandingMinor: loans.reduce((sum, item) => sum + Math.round(Number(item.outstandingNaira ?? 0) * 100), 0),
        totalBorrowedMinor: loans.reduce((sum, item) => sum + Math.round(Number(item.principalNaira ?? 0) * 100), 0),
        kycVerified: user?.kycStatus === "VERIFIED",
        bureauScore: report.score,
      });
      creditScores[idx] = { ...creditScores[idx], score: recomputed.score, band: recomputed.band, factors: recomputed.factors, createdAt: recomputed.calculatedAt };
    });

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
    creditHistory.push({
      id: randomUUID(),
      userId: req.user!.id,
      loanId: undefined,
      eventType: "LOAN_APPLIED",
      detail: `Application ${application.applicationId} submitted`,
      occurredAt: now,
      createdAt: now,
    });
    if (!(await persistMutation(res))) return;
    res.status(201).json({ ok: true, application });
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
    if (!["DRAFT", "IN_PROGRESS", "MORE_INFORMATION_REQUIRED"].includes(application.status)) {
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
    if (!kyc.checklist.bvn || !kyc.checklist.nin || !kyc.checklist.liveness) {
      res.status(409).json({ ok: false, error: "BVN, NIN, and liveness verification must be completed before submitting a loan application." });
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
    application.status = "SUBMITTED";
    application.submittedAt = application.submittedAt ?? new Date().toISOString();
    application.updatedAt = new Date().toISOString();
    if (!(await persistMutation(res))) return;
    res.json({ ok: true, application });
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
    loan,
    application,
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
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const user = users.find((u) => u.id === req.user?.id);
  const now = new Date().toISOString();
  const kycCase = findOrCreateKycCase(req.user!.id);
  const hasBvn = typeof kycCase.bvn === "string" && kycCase.bvn.length === 11;
  const kycData = (kycCase.providerRaw as { bvn?: { data?: Record<string, unknown> } } | undefined)?.bvn?.data ?? {};
  const bvnFullName: string | undefined =
    [kycData.title ? `${String(kycData.title)} ` : "", kycData.firstName, kycData.middleName ? `${String(kycData.middleName)} ` : "", kycData.lastName]
      .filter(Boolean).join(" ") || undefined;
  const bvnDob: string | undefined = typeof kycData.dateOfBirth === "string" ? kycData.dateOfBirth : undefined;
  const result = await requestCreditReport(
    hasBvn
      ? {
          mode: "ID",
          number: kycCase.bvn,
          customer_name: bvnFullName ?? user?.fullName,
          dob: bvnDob ?? user?.dateOfBirth,
        }
      : {
          mode: "BIO",
          customer_name: user?.fullName,
          dob: user?.dateOfBirth,
        }
  );
  const raw = result.rawResponse ?? {};
  const extractedScore: number | undefined =
    typeof (result.normalizedFields as { score?: unknown } | undefined)?.score === "number"
      ? ((result.normalizedFields as { score: number }).score as number)
      : typeof (raw as { score?: unknown }).score === "number"
      ? (raw as { score: number }).score
      : undefined;
  const reportStatus: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED" =
    result.status === "SUCCESS"
      ? "RECEIVED"
      : result.status === "PENDING" || result.status === "MANUAL_REVIEW"
      ? "PENDING"
      : "FAILED";
  const report: CreditReport = {
    id: randomUUID(),
    userId: req.user!.id,
    provider: "prembly" as const,
    consentGrantedAt: now,
    requestedAt: now,
    reportReference: result.providerReference,
    status: reportStatus,
    score: extractedScore,
    normalizedFields: result.normalizedFields,
    redactedRaw: raw,
    createdAt: now,
  };
  creditReports.push(report);
  recordConsent(req.user!.id, "CREDIT_REPORT");
  res.json({
    ok: true,
    report,
    message: result.errorMessage ?? "Credit report request created.",
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
    res.status(503).json({
      ok: true,
      repayment,
      checkout: null,
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
      disbursedPrincipal: approved.reduce((sum, l) => sum + Number(l.principalNaira ?? 0), 0),
      outstandingPrincipal: loans.reduce((sum, l) => sum + Number(l.outstandingNaira ?? 0), 0),
      investments: investments.length,
      activeInvestmentPrincipal: investments.filter((i) => i.status === "ACTIVE").reduce((s, i) => s + Number(i.amountNaira ?? 0), 0),
      pendingPayments: [...repayments, ...walletTransactions.filter((t) => t.type === "DEPOSIT")].filter((p: { status: string }) => p.status !== "SUCCESSFUL" && p.status !== "COMPLETED").length,
      pendingPayouts: payouts.filter((payout) => payout.status !== "SUCCESSFUL").length,
      failedPayouts: payouts.filter((p) => p.status === "FAILED").length,
      reconciliationItems: providerEvents.filter((e) => !(e as { processed?: boolean }).processed).length,
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
  const account = payoutAccounts.find((item) => item.userId === payout.userId);
  if (!account) {
    res.status(400).json({ ok: false, error: "Investor payout account not found" });
    return;
  }
  try {
    const transfer = await createInvestorPayout({
      txRef: `VELO-PAYOUT-RETRY-${payout.id}`,
      amountNaira: Number(payout.amountNaira),
      accountNumber: String(account.accountNumber),
      accountBank: String(account.bankCode),
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

function ensureApprovedLoanRecord(application: (typeof loanApplications)[number], now = new Date().toISOString()) {
  const existing = loans.find((loan) => loan.applicationId === application.id);
  if (existing) return existing;
  const product = loanProducts[0];
  const principal = Number(application.amountNaira ?? 0);
  const tenure = application.tenureDays ?? product?.defaultTenureDays ?? 90;
  const rate = (product?.interestRatePercent ?? 18) / 100;
  const processing = principal * ((product?.processingFeePercent ?? 2) / 100);
  const interest = principal * rate * (tenure / 365);
  const totalRepayment = principal + interest + processing;
  const dueAt = new Date(Date.now() + tenure * 86400000).toISOString();
  const loanRecord: (typeof loans)[number] = {
    id: randomUUID(),
    applicationId: application.id,
    borrowerId: application.borrowerId,
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
  const filtered = loanApplications.filter((application) => {
    const snapshot = application.customerSnapshot as Record<string, unknown> | undefined;
    const business = snapshot?.businessInfo as Record<string, unknown> | undefined;
    const applicantType = business?.businessName ? "BUSINESS" : "PERSONAL";
    const searchable = JSON.stringify({ application, snapshot }).toLowerCase();
    return (!status || application.status === status) && (!type || applicantType === type) && (!borrowerId || application.borrowerId === borrowerId) && (!search || searchable.includes(search));
  }).map((a) => seedLoanStageStatuses(a));
  const reconciled = filtered.some(synchronizeLoanApplicationStatus);
  if (reconciled) void persistStore().catch(() => undefined);
  const page = paginate(filtered, req.query as Record<string, unknown>);
  res.json({ ok: true, loans: page.items, disbursedLoans: loans, meta: page.meta, stages: LOAN_STAGES });
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
    if (proofOfAddress) kycDocuments.proofOfAddress = proofOfAddress;
    if (passport) kycDocuments.passportPhoto = passport;
    if (signature) kycDocuments.signature = signature;
    if (selfie) kycDocuments.selfie = selfie;
  }
  if (borrowerKyc?.identityPhoto || borrowerKyc?.identityPhotoUrl) {
    kycDocuments.identityPhoto = borrowerKyc.identityPhotoUrl ?? borrowerKyc.identityPhoto;
  }
  if (borrowerKyc?.selfieImageData) {
    kycDocuments.selfieImageData = borrowerKyc.selfieImageData;
  }
  res.json({
    ok: true,
    application,
    loan,
    stages: LOAN_STAGES,
    schedule: loan ? loanSchedules.filter((s) => s.loanId === loan.id) : [],
    repayments: loan ? repayments.filter((r) => r.loanId === loan.id) : [],
    creditHistory: application ? creditHistory.filter((c) => c.userId === application.borrowerId) : [],
    kycCase: borrowerKyc,
    kycDocuments,
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
    const product = loanProducts[0];
    const principal = Number(application.amountNaira ?? 0);
    const tenure = application.tenureDays ?? product?.defaultTenureDays ?? 90;
    const rate = (product?.interestRatePercent ?? 18) / 100;
    const processing = principal * ((product?.processingFeePercent ?? 2) / 100);
    const interest = principal * rate * (tenure / 365);
    const totalRepayment = principal + interest + processing;
    const dueAt = new Date(Date.now() + tenure * 86400000).toISOString();
    const now = new Date().toISOString();
    const loanRecord: (typeof loans)[number] = {
      id: randomUUID(),
      applicationId: application.id,
      borrowerId: application.borrowerId,
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
        id: randomUUID(),
        loanId: loanRecord.id,
        installmentNumber: i,
        dueDate: new Date(Date.now() + (tenure / scheduleCount) * i * 86400000).toISOString().slice(0, 10),
        principalNaira: Math.round((principal / scheduleCount) * 100) / 100,
        interestNaira: Math.round((interest / scheduleCount) * 100) / 100,
        feesNaira: i === 1 ? Math.round(processing * 100) / 100 : 0,
        totalDueNaira: Math.round((totalRepayment / scheduleCount) * 100) / 100,
        totalPaidNaira: 0,
        status: "PENDING",
        createdAt: now,
      });
    }
    creditHistory.push({
      id: randomUUID(),
      userId: application.borrowerId,
      loanId: loanRecord.id,
      eventType: "LOAN_APPROVED",
      detail: `Application ${application.applicationId} approved`,
      occurredAt: now,
      createdAt: now,
    });
  } else if (parsed.data.decision === "REJECTED") {
    application.status = "REJECTED";
  } else {
    application.status = "MORE_INFORMATION_REQUIRED";
  }
  application.updatedAt = new Date().toISOString();
  if (parsed.data.decision === "APPROVED" && previousStatus !== "APPROVED") void sendLoanEmails(application, "APPROVED").catch(() => undefined);
  if (parsed.data.decision === "REJECTED" && previousStatus !== "REJECTED") void sendLoanEmails(application, "REJECTED").catch(() => undefined);
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
    const product = loanProducts[0];
    const principal = Number(application.amountNaira ?? 0);
    const tenure = application.tenureDays ?? product?.defaultTenureDays ?? 90;
    const rate = (product?.interestRatePercent ?? 18) / 100;
    const processing = principal * ((product?.processingFeePercent ?? 2) / 100);
    const interest = principal * rate * (tenure / 365);
    const totalRepayment = principal + interest + processing;
    const dueAt = new Date(Date.now() + tenure * 86400000).toISOString();
    const loanRecord: (typeof loans)[number] = {
      id: randomUUID(),
      applicationId: application.id,
      borrowerId: application.borrowerId,
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
        id: randomUUID(),
        loanId: loanRecord.id,
        installmentNumber: i,
        dueDate: new Date(Date.now() + (tenure / scheduleCount) * i * 86400000).toISOString().slice(0, 10),
        principalNaira: Math.round((principal / scheduleCount) * 100) / 100,
        interestNaira: Math.round((interest / scheduleCount) * 100) / 100,
        feesNaira: i === 1 ? Math.round(processing * 100) / 100 : 0,
        totalDueNaira: Math.round((totalRepayment / scheduleCount) * 100) / 100,
        totalPaidNaira: 0,
        status: "PENDING",
        createdAt: now,
      });
    }
    creditHistory.push({
      id: randomUUID(),
      userId: application.borrowerId,
      loanId: null as unknown as string,
      eventType: "LOAN_APPROVED",
      detail: `Loan application ${application.applicationId} approved via one-click stage approval`,
      occurredAt: now,
      createdAt: now,
    });
  }
  if (previousStatus !== "APPROVED") void sendLoanEmails(application, "APPROVED").catch(() => undefined);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, application });
});

router.post("/admin/loans/:loanId/disburse", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.applicationId === application?.id || l.id === req.params.loanId);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan record not found. Approve the application first." });
    return;
  }
  if (application && application.manualDecision !== "APPROVED") {
    res.status(409).json({ ok: false, error: "Loan manager approval is required before disbursement" });
    return;
  }
  const snapshot = (application?.customerSnapshot ?? {}) as {
    fullName?: string;
    disbursementAccount?: { accountName?: string; accountNumber?: string; bankCode?: string; bankName?: string };
  };
  const savedAccount = disbursementAccounts.find((item) => item.borrowerId === loan.borrowerId);
  const applicationAccount = snapshot.disbursementAccount;
  const account = savedAccount?.status === "ACTIVE"
    ? savedAccount
    : applicationAccount?.accountNumber && applicationAccount.bankCode
      ? {
          accountName: applicationAccount.accountName || snapshot.fullName || "Borrower",
          accountNumber: applicationAccount.accountNumber,
          bankCode: applicationAccount.bankCode,
          bankName: applicationAccount.bankName,
        }
      : null;
  if (!account) {
    res.status(400).json({ ok: false, error: "An active, verified borrower disbursement account is required" });
    return;
  }
  const existingTransfer = loanDisbursements.find((item) => item.loanId === loan.id && ["PROCESSING", "PENDING", "SUCCESSFUL"].includes(item.status));
  if (existingTransfer) {
    res.status(409).json({ ok: false, error: "A disbursement is already in progress or completed for this loan" });
    return;
  }
  try {
    const amountMinor = Math.round(Number(loan.principalNaira) * 100);
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
    const transfer = await createLoanDisbursement({
      txRef: `VELO-DISBURSE-${loan.id}`,
      amountNaira: Number(loan.principalNaira),
      accountNumber: account.accountNumber,
      accountBank: account.bankCode,
      beneficiaryName: account.accountName ?? snapshot.fullName ?? "Borrower",
      narration: `Velo loan disbursement ${application?.applicationId ?? loan.id}`,
    });
    if (String((transfer as { status?: string }).status ?? "").toLowerCase() !== "success") {
      throw new Error((transfer as { message?: string }).message || "Flutterwave did not accept the disbursement transfer");
    }
    appendAdminLedger({
      entryType: "LOAN_DISBURSEMENT",
      referenceId: loan.id,
      borrowerId: loan.borrowerId,
      loanId: loan.id,
      amountMinor,
      direction: "DEBIT",
      description: `Admin ledger debit for loan disbursement - loan ${loan.id} / application ${application?.applicationId ?? loan.id}`,
      metadata: { provider: "flutterwave", applicationId: application?.applicationId, accountBank: account.bankCode },
    });
    disbursement.providerTransfer = transfer as unknown as Record<string, unknown>;
    disbursement.providerReference = (transfer as unknown as { data?: { reference?: string; id?: number | string } }).data?.reference ?? String((transfer as unknown as { data?: { id?: number | string } }).data?.id ?? disbursement.id);
    disbursement.status = "PENDING";
    disbursement.processedAt = now;
    disbursement.updatedAt = now;
    loan.status = "DISBURSEMENT_PENDING";
    loan.providerTransfer = transfer;
    loan.updatedAt = now;
    const transferId = String((transfer as { data?: { id?: number | string } }).data?.id ?? "");
    const verification = await verifyTransferWithRetry(transferId, disbursement.providerReference, 2, 500, Number(loan.principalNaira));
    if (verification.settled) {
      const settledAt = new Date().toISOString();
      loan.status = "ACTIVE";
      loan.disbursedAt = settledAt;
      loan.updatedAt = settledAt;
      if (application) {
        // Use "DISBURSED" (not "ACTIVE") so the borrower and admin UIs can
        // distinguish "money sent" from the internal loan "Active" lifecycle.
        application.status = "DISBURSED";
        application.updatedAt = settledAt;
      }
      loan.providerReference = String(verification.data?.id ?? verification.data?.flw_ref ?? disbursement.providerReference);
      disbursement.status = "SUCCESSFUL";
      disbursement.processedAt = settledAt;
      disbursement.updatedAt = settledAt;
      creditHistory.push({ id: randomUUID(), userId: loan.borrowerId, loanId: loan.id, eventType: "LOAN_DISBURSED", detail: `Disbursement confirmed via Flutterwave ${loan.providerReference}`, occurredAt: settledAt, createdAt: settledAt });
      const borrower = users.find((user) => user.id === loan.borrowerId);
      if (borrower) {
        const template = loanDisbursedEmail({ name: borrower.fullName, applicationId: application?.applicationId ?? loan.id, amountNaira: Number(loan.principalNaira) });
        void sendEmail({ to: borrower.email, name: borrower.fullName, ...template }).catch(() => undefined);
      }
    }
    if (!(await persistMutation(res))) return;
    res.status(verification.settled ? 200 : 202).json({ ok: true, loan, transfer, disbursement });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : "Flutterwave transfer unavailable";
    const disbursement = loanDisbursements.find((item) => item.loanId === loan.id && item.status === "PROCESSING");
    if (disbursement) {
      disbursement.status = "FAILED";
      disbursement.error = errMsg;
      disbursement.updatedAt = new Date().toISOString();
    }
    if (!await persistMutation(res)) return;
    res.status(503).json({
      ok: false,
      error: errMsg,
    });
  }
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

router.get("/admin/loan-products", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, products: loanProducts });
});

router.post("/admin/loan-products", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const schema = z.object({
    name: z.string().min(2),
    description: z.string().optional(),
    minAmountNaira: z.number().positive(),
    maxAmountNaira: z.number().positive(),
    defaultTenureDays: z.number().int().positive().optional(),
    interestRatePercent: z.number().nonnegative(),
    interestType: z.enum(["SIMPLE_FLAT", "REDUCING_BALANCE", "ANNUALIZED"]).default("SIMPLE_FLAT"),
    processingFeePercent: z.number().nonnegative().default(2),
    lateFeePercent: z.number().nonnegative().default(1),
    lateFeeType: z.enum(["ONE_TIME", "COMPOUNDING_DAILY", "COMPOUNDING_MONTHLY"]).default("COMPOUNDING_DAILY"),
    gracePeriodDays: z.number().int().nonnegative().default(3),
    isActive: z.boolean().default(true),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const now = new Date().toISOString();
  const product: (typeof loanProducts)[number] = {
    id: randomUUID(),
    version: 1,
    createdAt: now,
    ...parsed.data,
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
    minAmountNaira: z.number().positive().optional(),
    maxAmountNaira: z.number().positive().optional(),
    defaultTenureDays: z.number().int().positive().optional(),
    interestRatePercent: z.number().nonnegative().optional(),
    interestType: z.enum(["SIMPLE_FLAT", "REDUCING_BALANCE", "ANNUALIZED"]).optional(),
    processingFeePercent: z.number().nonnegative().optional(),
    lateFeePercent: z.number().nonnegative().optional(),
    lateFeeType: z.enum(["ONE_TIME", "COMPOUNDING_DAILY", "COMPOUNDING_MONTHLY"]).optional(),
    gracePeriodDays: z.number().int().nonnegative().optional(),
    isActive: z.boolean().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  product.version += 1;
  product.updatedAt = new Date().toISOString();
  Object.assign(product, parsed.data);
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
    const transfer = await createInvestorPayout({
      txRef: `VELO-PAYOUT-${payout.id}`,
      amountNaira: Number(payout.amountNaira),
      accountNumber,
      accountBank: bankCode,
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


function reverseInvestorWithdrawal(withdrawal: (typeof investorWithdrawals)[number], reason: string): void {
  const wallet = findWallet(withdrawal.investorId);
  if (wallet) {
    appendLedger(wallet, {
      entryType: "WITHDRAWAL_REVERSAL",
      referenceId: withdrawal.id,
      amountMinor: Math.round(Number(withdrawal.amountNaira) * 100),
      direction: "CREDIT",
      description: `Withdrawal reversal - ${reason}`,
    });
  }
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
    const transfer = await createInvestorPayout({
      txRef: `WITHDRAWAL-${withdrawal.id}`,
      amountNaira: Number(withdrawal.netNaira),
      accountNumber: String(withdrawal.accountNumber),
      accountBank: String(withdrawal.bankCode),
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
  const bank = await resolveBankAccount(parsed.data.accountNumber, parsed.data.bankCode);
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
  const execution = await executeInvestorWithdrawal(withdrawalEntry);
  if (!(await persistMutation(res))) return;
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
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    subject: emailTpl.subject,
    html: emailTpl.html,
  }).then((emailRes) => {
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
  }).catch(() => undefined);
  const finalStatus = execution.finalStatus ?? (execution.error ? "FAILED" : "PROCESSING");
  let responseMessage = "Withdrawal submitted.";
  if (finalStatus === "SUCCESSFUL") responseMessage = "Withdrawal processed successfully and confirmed by the provider.";
  else if (finalStatus === "FAILED") responseMessage = execution.error ? `Withdrawal failed and the wallet balance was restored: ${execution.error}` : "Withdrawal failed and the wallet balance was restored.";
  else if (finalStatus === "PROCESSING") responseMessage = "Withdrawal has been submitted and is being processed by the provider. Final status will be confirmed shortly.";
  res.json({
    ok: finalStatus !== "FAILED",
    withdrawal: withdrawalEntry,
    message: responseMessage,
    finalStatus,
    providerResponse: execution.transfer,
    providerVerification: execution.verification,
    feeBreakdown: {
      flatNaira: Math.round(flatMinor) / 100,
      percentNaira: Math.round(feePercentMinor) / 100,
      totalNaira: Math.round(totalFeeMinor) / 100,
      netNaira: Math.round(netMinor) / 100,
    },
  });
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
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const updates: Record<string, number> = {};
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
  const updated = updatePlatformSettings(updates);
  if (!(await persistMutation(res))) return;
  res.json({ ok: true, settings: updated });
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
  let items = [...investorWithdrawals];
  if (statusFilter) items = items.filter((w) => w.status === statusFilter);
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  res.json({ ok: true, total: items.length, withdrawals: items.slice(offset, offset + limit) });
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

router.get("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const borrowerId = req.user!.id;
  const account = disbursementAccounts.find((a) => a.borrowerId === borrowerId);
  const pendingRequests = accountChangeRequests.filter(
    (r) => r.userId === borrowerId && r.type === "BORROWER_DISBURSEMENT_ACCOUNT"
  );
  res.json({ ok: true, account: account ?? null, pendingRequests });
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

router.post("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
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
  const now = new Date().toISOString();
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
    res.json({ ok: true, account, message: "Disbursement account saved successfully" });
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

router.put("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
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
  if (!prev.accountNumber || !prev.bankCode) {
    res.status(400).json({ ok: false, error: "Previous disbursement is missing bank/account details" });
    return;
  }
  const now = new Date().toISOString();
  const retryCount = (prev.retryCount ?? 0) + 1;
  const retry: (typeof loanDisbursements)[number] = {
    id: randomUUID(),
    loanId: prev.loanId,
    applicationId: prev.applicationId,
    borrowerId: prev.borrowerId,
    amountNaira: prev.amountNaira,
    currency: prev.currency,
    bankCode: prev.bankCode,
    bankName: prev.bankName,
    accountNumber: prev.accountNumber,
    accountName: prev.accountName,
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
  try {
    const transfer = await createLoanDisbursement({
      txRef: `VELO-DISBURSE-${loan.id}-RETRY-${retry.id}`,
      amountNaira: Number(prev.amountNaira),
      accountNumber: prev.accountNumber,
      accountBank: prev.bankCode,
      beneficiaryName: prev.accountName ?? "Borrower",
      narration: retry.narration ?? `Velo loan disbursement retry ${loan.id}`,
    });
    if (String((transfer as { status?: string }).status ?? "").toLowerCase() !== "success") {
      throw new Error((transfer as { message?: string }).message || "Flutterwave did not accept the retry transfer");
    }
    appendAdminLedger({
      entryType: "LOAN_DISBURSEMENT",
      referenceId: retry.id,
      borrowerId: loan.borrowerId,
      loanId: loan.id,
      amountMinor: Math.round(Number(prev.amountNaira) * 100),
      direction: "DEBIT",
      description: `Admin ledger debit for loan disbursement retry - loan ${loan.id}`,
      metadata: { provider: "flutterwave", retryOfId: prev.id, accountBank: prev.bankCode },
    });
    retry.providerTransfer = transfer as unknown as Record<string, unknown>;
    retry.providerReference =
      (transfer as unknown as { data?: { reference?: string; id?: number | string } }).data?.reference ??
      String((transfer as unknown as { data?: { id?: number | string } }).data?.id ?? retry.id);
    retry.status = "PENDING";
    retry.processedAt = now;
    retry.updatedAt = now;
    loan.status = "DISBURSEMENT_PENDING";
    loan.providerTransfer = transfer;
    loan.updatedAt = now;
    const transferId = String((transfer as { data?: { id?: number | string } }).data?.id ?? "");
    const verification = await verifyTransferWithRetry(transferId, retry.providerReference, 3, 500, Number(loan.principalNaira));
    if (verification.settled) {
      const settledAt = new Date().toISOString();
      const application = loanApplications.find((item) => item.id === loan.applicationId || item.applicationId === loan.applicationId);
      loan.status = "ACTIVE";
      loan.disbursedAt = settledAt;
      loan.updatedAt = settledAt;
      if (application) {
        application.status = "ACTIVE";
        application.updatedAt = settledAt;
      }
      loan.providerReference = String(verification.data?.id ?? verification.data?.flw_ref ?? retry.providerReference);
      retry.status = "SUCCESSFUL";
      retry.processedAt = settledAt;
      retry.updatedAt = settledAt;
      creditHistory.push({ id: randomUUID(), userId: loan.borrowerId, loanId: loan.id, eventType: "LOAN_DISBURSED", detail: `Disbursement confirmed via Flutterwave ${loan.providerReference}`, occurredAt: settledAt, createdAt: settledAt });
      const borrower = users.find((user) => user.id === loan.borrowerId);
      if (borrower) {
        const template = loanDisbursedEmail({ name: borrower.fullName, applicationId: application?.applicationId ?? loan.applicationId, amountNaira: Number(loan.principalNaira) });
        void sendEmail({ to: borrower.email, name: borrower.fullName, ...template }).catch(() => undefined);
      }
    }
    if (!await persistMutation(res)) return;
    res.status(verification.settled ? 200 : 202).json({ ok: true, loan, disbursement: retry, providerResponse: transfer });
  } catch (error) {
    retry.status = "FAILED";
    retry.error = error instanceof Error ? error.message : "Flutterwave transfer unavailable";
    retry.updatedAt = new Date().toISOString();
    if (!await persistMutation(res)) return;
    res.status(503).json({ ok: false, disbursement: retry, error: retry.error });
  }
});

export default router;
