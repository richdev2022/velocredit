import { randomUUID } from "node:crypto";
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
  requestPasswordReset,
  confirmPasswordReset,
  getAdminPasswordHashOverride,
  setAdminPasswordHashOverride,
  markKycChecklistComplete,
  recordConsent,
} from "./auth.js";
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
  loanSchedules,
  notifications,
  consents,
  auditLogs,
  type KycStatus,
  type Role,
} from "./store.js";
import { env } from "./config.js";
import { uploadPrivateDocument } from "./storage/googleDrive.js";
import { calculateCreditScore } from "./credit.js";
import { evaluateLoanEligibility } from "./loanDecision.js";
import {
  initializeRepayment,
  createLoanDisbursement,
  createInvestorPayout,
  initializeWalletFunding,
  verifyTransaction,
} from "./providers/flutterwave.js";
import { verifyBvn, verifyNin, requestCreditReport } from "./providers/prembly.js";

const router = Router();
const normalizePhone = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const digits = value.replace(/[\s()-]/g, "");
  if (digits.startsWith("+234")) return `0${digits.slice(4)}`;
  if (digits.startsWith("234") && digits.length === 13) return `0${digits.slice(3)}`;
  return digits;
};

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
    preferredOtpChannel: z.enum(["SMS", "WHATSAPP", "EMAIL"]).default("EMAIL"),
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
const adminOtpChannelSchema = z.enum(["SMS", "WHATSAPP", "EMAIL"]);
const amountSchema = z.object({ amountNaira: z.number().positive().finite() });
function paginate<T>(items: T[], query: Record<string, unknown>): { items: T[]; meta: { total: number; limit: number; offset: number; hasMore: boolean } } {
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 50));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { items: items.slice(offset, offset + limit), meta: { total: items.length, limit, offset, hasMore: offset + limit < items.length } };
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
  channel: z.enum(["SMS", "WHATSAPP", "EMAIL"]).default("SMS"),
});
const otpVerifySchema = z.object({ challengeId: z.string().min(1), code: z.string().min(4) });
const passwordResetRequestSchema = z.object({ email: z.string().email() });
const passwordResetConfirmSchema = z.object({
  resetId: z.string().min(1),
  token: z.string().min(1),
  newPassword: z.string().min(8),
});
const bvnVerifySchema = z.object({ bvn: z.string().regex(/^\d{11}$/, "BVN must be exactly 11 digits"), firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: z.string().optional() });
const ninVerifySchema = z.object({ nin: z.string().regex(/^\d{11}$/, "NIN must be exactly 11 digits"), firstName: z.string().optional(), lastName: z.string().optional(), dateOfBirth: z.string().optional() });
const payoutAccountSchema = z.object({ accountName: z.string().min(2), accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"), bankCode: z.string().min(2), bankName: z.string().optional() });
const borrowerDisbursementAccountSchema = z.object({
  accountName: z.string().min(2),
  accountNumber: z.string().regex(/^\d{10}$/, "Account number must be 10 digits"),
});
const createInvestmentSchema = z.object({ amountNaira: z.number().positive().finite(), planId: z.string().min(1).optional(), tenureDays: z.number().int().positive().default(90), annualRatePercent: z.number().nonnegative().default(12) });
const earlyLiquiditySchema = z.object({ otpChallengeId: z.string().optional(), otpCode: z.string().optional() });
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
  calculation: z.record(z.unknown()).nullable().default(null),
});
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.DOCUMENT_MAX_SIZE_BYTES },
  fileFilter: (_req, file, callback) =>
    callback(null, env.DOCUMENT_ALLOWED_MIME_TYPES.split(",").includes(file.mimetype)),
});

router.post("/auth/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  if (findUserByEmail(input.email)) {
    res.status(409).json({ ok: false, error: "An account with this email already exists" });
    return;
  }
  const now = new Date().toISOString();
  const user = {
    id: randomUUID(),
    email: input.email.toLowerCase(),
    phone: input.phone,
    fullName: input.fullName,
    passwordHash: await bcrypt.hash(input.password, 12),
    roles: [input.role] as Role[],
    kycStatus: "NOT_STARTED" as KycStatus,
    createdAt: now,
    updatedAt: now,
    isActive: false,
    preferredOtpChannel: input.preferredOtpChannel,
    dateOfBirth: input.dateOfBirth,
    residentialAddress: input.residentialAddress as Record<string, unknown> | undefined,
    occupation: input.occupation,
    sourceOfFunds: input.sourceOfFunds,
  };
  users.push(user);
  if (input.role === "INVESTOR") createWallet(user.id);
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
    res.status(403).json({ ok: false, error: "Verify your OTP before signing in", code: "OTP_REQUIRED" });
    return;
  }
  if (!user.isActive) {
    res.status(403).json({ ok: false, error: "Account is suspended" });
    return;
  }
  user.lastLoginAt = new Date().toISOString();
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

router.post("/auth/admin/login", async (req, res) => {
  const parsed = loginSchema.extend({ channel: adminOtpChannelSchema.default("EMAIL") }).safeParse(req.body);
  if (!parsed.success) {
    res.status(401).json({ ok: false, error: "Invalid admin credentials" });
    return;
  }
  const persistedAdmin = findUserByEmail(parsed.data.email);
  const isEnvironmentAdmin = Boolean(env.ADMIN_EMAIL && parsed.data.email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase());
  const configuredAdminPasswordHash = getAdminPasswordHashOverride() ?? env.ADMIN_PASSWORD_HASH;
  const passwordMatches = persistedAdmin?.roles.includes("ADMIN")
    ? await bcrypt.compare(parsed.data.password, persistedAdmin.passwordHash)
    : isEnvironmentAdmin && Boolean(env.ADMIN_PASSWORD || configuredAdminPasswordHash) && (configuredAdminPasswordHash ? await bcrypt.compare(parsed.data.password, configuredAdminPasswordHash) : parsed.data.password === env.ADMIN_PASSWORD);
  if ((!isEnvironmentAdmin && !persistedAdmin?.roles.includes("ADMIN")) || !passwordMatches) {
    res.status(401).json({ ok: false, error: "Invalid admin credentials" });
    return;
  }
  const admin = {
    id: persistedAdmin?.id ?? "env-admin",
    email: persistedAdmin?.email ?? env.ADMIN_EMAIL!.toLowerCase(),
    phone: persistedAdmin?.phone ?? "",
    fullName: persistedAdmin?.fullName ?? "Velo Administrator",
    passwordHash: persistedAdmin?.passwordHash ?? configuredAdminPasswordHash ?? "",
    roles: ["ADMIN"] as Role[],
    kycStatus: "VERIFIED" as KycStatus,
    createdAt: new Date().toISOString(),
  };
  try {
    const challenge = await createOtpChallenge(admin.id, "LOGIN_STEP_UP", "", admin.email, parsed.data.channel);
    res.json({
      ok: true,
      requiresOtp: true,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: parsed.data.channel,
      resendAvailableAt: challenge.resendAvailableAt,
      resendSecondsRemaining: challenge.resendSecondsRemaining,
      user: { id: admin.id, email: admin.email, fullName: admin.fullName, roles: admin.roles },
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
  const adminId = admin?.roles.includes("ADMIN") ? admin.id : "env-admin";
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
  const persistedAdmin = users.find((user) => user.id === result.userId && user.roles.includes("ADMIN"));
  const configuredAdminPasswordHash = getAdminPasswordHashOverride() ?? env.ADMIN_PASSWORD_HASH;
  const admin = persistedAdmin ?? { id: "env-admin", email: env.ADMIN_EMAIL!, phone: "", fullName: "Velo Administrator", passwordHash: configuredAdminPasswordHash ?? "", roles: ["ADMIN"] as Role[], kycStatus: "VERIFIED" as KycStatus, createdAt: new Date().toISOString() };
  res.json({ ok: true, verified: true, accessToken: issueToken(admin), user: { id: admin.id, email: admin.email, fullName: admin.fullName, roles: admin.roles } });
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
  try {
    const challenge = await createOtpChallenge(user.id, parsed.data.action, user.phone, user.email, parsed.data.channel);
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
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "A valid registration userId is required" });
    return;
  }
  const user = users.find((item) => item.id === parsed.data.userId);
  if (!user || user.otpVerifiedAt) {
    res.status(404).json({ ok: false, error: "Registration not found or already verified" });
    return;
  }
  try {
    const challenge = await createOtpChallenge(user.id, "SIGNUP_VERIFY", user.phone, user.email, user.preferredOtpChannel ?? "EMAIL");
    res.status(201).json({
      ok: true,
      userId: user.id,
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt,
      channel: user.preferredOtpChannel ?? "EMAIL",
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
  res.json({ ok: true, message: "Password reset successful" });
});

router.post("/auth/admin/password-reset/request", async (req, res) => {
  const parsed = z.object({ email: z.string().email(), channel: adminOtpChannelSchema.default("EMAIL") }).safeParse(req.body);
  if (!parsed.success || !env.ADMIN_EMAIL || parsed.data.email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) {
    res.json({ ok: true, message: "If this email is the administrator email, a reset OTP has been sent." });
    return;
  }
  const challenge = await createOtpChallenge("env-admin", "PASSWORD_RESET", "", env.ADMIN_EMAIL, parsed.data.channel);
  res.json({ ok: true, challengeId: challenge.id, expiresAt: challenge.expiresAt, channel: parsed.data.channel, resendAvailableAt: challenge.resendAvailableAt, resendSecondsRemaining: challenge.resendSecondsRemaining, message: "Enter the OTP sent to the selected channel." });
});

router.post("/auth/admin/password-reset/confirm", async (req, res) => {
  const parsed = z.object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/), newPassword: z.string().min(12) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const result = await verifyOtpChallenge(parsed.data.challengeId, parsed.data.code);
  if (!result.ok || result.action !== "PASSWORD_RESET" || result.userId !== "env-admin") {
    res.status(400).json({ ok: false, error: result.error ?? "Admin password reset verification failed" });
    return;
  }
  setAdminPasswordHashOverride(await bcrypt.hash(parsed.data.newPassword, 12));
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

router.patch("/me", requireAuth, (req: AuthRequest, res) => {
  const user = users.find((u) => u.id === req.user?.id);
  if (!user) {
    res.status(404).json({ ok: false, error: "User not found" });
    return;
  }
  const schema = z.object({
    fullName: z.string().min(2).max(120).optional(),
    phone: z.string().min(7).max(20).optional(),
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
  if (parsed.data.phone) user.phone = parsed.data.phone;
  if (parsed.data.dateOfBirth) user.dateOfBirth = parsed.data.dateOfBirth;
  if (parsed.data.residentialAddress) user.residentialAddress = parsed.data.residentialAddress;
  if (parsed.data.occupation) user.occupation = parsed.data.occupation;
  if (parsed.data.sourceOfFunds) user.sourceOfFunds = parsed.data.sourceOfFunds;
  user.updatedAt = new Date().toISOString();
  res.json({ ok: true, user });
});

router.post("/me/roles/add", requireAuth, (req: AuthRequest, res) => {
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
  const userDocs = documents.filter((d) => d.userId === req.user?.id);
  res.json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    bvnLastFour: kyc.bvn ? kyc.bvn.slice(-4) : undefined,
    ninLastFour: kyc.nin ? kyc.nin.slice(-4) : undefined,
    submittedAt: kyc.submittedAt,
    rejectionReason: kyc.rejectionReason,
    documents: userDocs,
    verificationEvents: identityVerificationEvents.filter((e) => e.kycCaseId === kyc.id),
  });
});

router.post("/me/kyc", requireAuth, (req: AuthRequest, res) => {
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
  if (parsed.data.checklist) Object.assign(kyc.checklist, parsed.data.checklist);
  if (parsed.data.bvn) {
    kyc.bvn = parsed.data.bvn;
    kyc.checklist.bvn = true;
  }
  if (parsed.data.nin) {
    kyc.nin = parsed.data.nin;
    kyc.checklist.nin = true;
  }
  if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
  if (parsed.data.statusOverride === "PENDING_VERIFICATION" || Object.values(kyc.checklist).every(Boolean)) {
    kyc.status = "PENDING_VERIFICATION";
    kyc.submittedAt = kyc.submittedAt ?? new Date().toISOString();
  }
  user.kycStatus = kyc.status;
  kyc.updatedAt = new Date().toISOString();
  markKycChecklistComplete(user.id);
  res.status(202).json({
    ok: true,
    status: kyc.status,
    checklist: kyc.checklist,
    message:
      kyc.status === "VERIFIED"
        ? "KYC is verified."
        : kyc.status === "PENDING_VERIFICATION"
        ? "KYC submitted for verification. Provider credentials are required for automated checks."
        : "KYC updated. Complete all checklist items to submit.",
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
  const result = await verifyBvn(parsed.data);
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
  kyc.bvn = parsed.data.bvn;
  if (result.status === "SUCCESS") {
    kyc.checklist.bvn = true;
    kyc.bvnVerifiedAt = new Date().toISOString();
  }
  if (user) {
    if (result.status === "SUCCESS" && !user.fullName.includes(parsed.data.firstName ?? "") && parsed.data.firstName) {
      // Name matched: nothing to override yet — manual review can confirm
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
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
  });
});

router.post("/me/kyc/nin/verify", requireAuth, async (req: AuthRequest, res) => {
  const parsed = ninVerifySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const kyc = findOrCreateKycCase(req.user!.id);
  const user = users.find((u) => u.id === req.user?.id);
  const result = await verifyNin(parsed.data);
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
  kyc.nin = parsed.data.nin;
  if (result.status === "SUCCESS") {
    kyc.checklist.nin = true;
    kyc.ninVerifiedAt = new Date().toISOString();
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
  res.json({
    ok: true,
    verificationStatus: result.status,
    checklist: kyc.checklist,
    providerConfigured: !result.errorMessage?.includes("not configured"),
    error: result.errorMessage,
  });
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
    if (documentType.data === "PROOF_OF_ADDRESS") kyc.checklist.proofOfAddress = true;
    if (documentType.data === "PASSPORT_PHOTO") kyc.checklist.passport = true;
    if (documentType.data === "SIGNATURE") kyc.checklist.signature = true;
    markKycChecklistComplete(req.user!.id);
    res.status(201).json({ ok: true, document: record, checklist: kyc.checklist });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Document storage unavailable",
    });
  }
});

router.post("/me/payout-accounts", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
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
  res.status(202).json({
    ok: true,
    account,
    message: "Payout account saved and requires verification before settlement.",
  });
});

router.post("/me/payout-accounts/:id/verify", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const account = payoutAccounts.find((a) => a.id === req.params.id && a.userId === req.user?.id);
  if (!account) {
    res.status(404).json({ ok: false, error: "Payout account not found" });
    return;
  }
  account.status = "VERIFIED";
  account.verifiedAt = new Date().toISOString();
  account.verificationReference = `local-verification-${randomUUID()}`;
  account.updatedAt = new Date().toISOString();
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
  res.json({ ok: true, wallet, investments: userInvestments, payouts: userPayouts, payoutAccount: account, documents: userDocs });
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

router.put("/investor/payout-account", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
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

router.get("/investor/investments", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  res.json({ ok: true, investments: investments.filter((item) => item.investorId === req.user!.id) });
});

router.post("/investor/investments", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
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
  const annualRate = plan?.annualRatePercent ?? parsed.data.annualRatePercent;
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
  const expectedEarnings = (parsed.data.amountNaira * annualRate * tenure) / 365 / 100;
  const investment = {
    id: randomUUID(),
    investorId: req.user!.id,
    planId: plan?.id,
    planVersion: plan?.version,
    planSnapshot: plan ? { ...plan } : undefined,
    amountNaira: parsed.data.amountNaira,
    expectedEarningsNaira: Math.round(expectedEarnings * 100) / 100,
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

router.get("/investor/transactions", requireAuth, requireRole("INVESTOR"), (req: AuthRequest, res) => {
  const wallet = findWallet(req.user!.id);
  res.json({
    ok: true,
    investments: investments.filter((item) => item.investorId === req.user!.id),
    payouts: payouts.filter((item) => item.userId === req.user!.id),
    ledger: ledgerEntries.filter((e) => e.walletId === wallet.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    walletTransactions: walletTransactions.filter((t) => t.userId === req.user?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  });
});

router.get("/borrower/dashboard", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const userApplications = loanApplications.filter((item) => item.borrowerId === req.user!.id);
  const userLoans = loans.filter((item) => item.borrowerId === req.user!.id);
  const userRepayments = repayments.filter((item) => item.borrowerId === req.user!.id);
  const disbursementAccount = payoutAccounts.find((item) => item.userId === req.user!.id) ?? null;
  res.json({
    ok: true,
    applications: userApplications,
    loans: userLoans,
    repayments: userRepayments,
    disbursementAccount,
  });
});

router.put("/borrower/disbursement-account", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const hasSubmittedApplication = loanApplications.some(
    (item) =>
      item.borrowerId === req.user!.id &&
      (Boolean(item.submittedAt) || !["DRAFT", "IN_PROGRESS", "MORE_INFORMATION_REQUIRED"].includes(item.status))
  );
  if (hasSubmittedApplication) {
    res.status(409).json({ ok: false, error: "The disbursement account cannot be changed after submitting a loan application." });
    return;
  }

  const parsed = borrowerDisbursementAccountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  const existing = payoutAccounts.find((item) => item.userId === req.user!.id);
  const now = new Date().toISOString();
  const account = {
    id: existing?.id ?? randomUUID(),
    userId: req.user!.id,
    bankCode: "VELO",
    bankName: "Velo",
    ...parsed.data,
    status: "PENDING_VERIFICATION" as const,
    updatedAt: now,
    createdAt: existing?.createdAt ?? now,
  };
  if (existing) Object.assign(existing, account);
  else payoutAccounts.push(account);

  res.status(200).json({ ok: true, disbursementAccount: account });
});

router.get("/borrower/loan-products", requireAuth, requireRole("BORROWER"), (_req, res) => {
  res.json({ ok: true, products: loanProducts.filter((p) => p.isActive) });
});

router.post("/borrower/applications", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const parsed = loanApplicationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const input = parsed.data;
  const user = users.find((item) => item.id === req.user!.id);
  const latestExternalCredit = creditReports
    .filter((item) => item.userId === req.user!.id && item.status === "RECEIVED" && item.score != null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
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
    kyc: input.kyc,
    disbursementAccount: { ...input.disbursementAccount, institution: "VELO" },
    collateral: input.collateral,
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
  const externalCreditReport = latestExternalCredit ?? {
    provider: "prembly" as const,
    status: "NOT_REQUESTED" as const,
    score: null,
    reportReference: null,
    requestedAt: null,
    consentRequired: true,
    reason: "Request and receive an external bureau report before it can influence the internal score.",
  };
  const amountNaira = input.loanRequest?.amount ?? 0;
  const eligibility = evaluateLoanEligibility(internalCredit, amountNaira);
  const now = new Date().toISOString();
  creditScores.push({
    id: randomUUID(),
    userId: req.user!.id,
    version: internalCredit.version,
    score: internalCredit.score,
    band: internalCredit.band,
    factors: internalCredit.factors,
    createdAt: internalCredit.calculatedAt,
  });
  const application: (typeof loanApplications)[number] = {
    id: randomUUID(),
    applicationId: input.applicationId ?? randomUUID(),
    borrowerId: req.user!.id,
    applicantType: input.applicantType,
    customerSnapshot,
    creditReportSnapshot: { internal: internalCredit, external: externalCreditReport },
    amountNaira,
    tenureDays: input.loanRequest?.tenure,
    status: "UNDER_REVIEW",
    systemDecision: eligibility as unknown as Record<string, unknown>,
    manualDecision: "PENDING",
    disbursementInstitution: "VELO",
    disbursementAccount: customerSnapshot.disbursementAccount,
    createdAt: now,
    updatedAt: now,
    submittedAt: now,
  };
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
  res.status(201).json({ ok: true, application });
});

router.patch("/borrower/applications/:id", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const application = loanApplications.find((a) => a.id === req.params.id && a.borrowerId === req.user?.id);
  if (!application) {
    res.status(404).json({ ok: false, error: "Application not found" });
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
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }
  const snapshot = application.customerSnapshot ?? {};
  if (parsed.data.personalInfo) Object.assign(snapshot, { personalInfo: parsed.data.personalInfo });
  if (parsed.data.businessInfo) Object.assign(snapshot, { businessInfo: parsed.data.businessInfo });
  application.customerSnapshot = snapshot;
  application.updatedAt = new Date().toISOString();
  res.json({ ok: true, application });
});

router.post("/borrower/applications/:id/submit", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const application = loanApplications.find((a) => a.id === req.params.id && a.borrowerId === req.user?.id);
  if (!application) {
    res.status(404).json({ ok: false, error: "Application not found" });
    return;
  }
  application.status = "SUBMITTED";
  application.submittedAt = application.submittedAt ?? new Date().toISOString();
  application.updatedAt = new Date().toISOString();
  res.json({ ok: true, application });
});

router.get("/borrower/loans", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const userLoans = loans.filter((item) => item.borrowerId === req.user!.id);
  const withSchedules = userLoans.map((loan) => ({
    ...loan,
    schedule: loanSchedules.filter((s) => s.loanId === loan.id),
  }));
  res.json({ ok: true, loans: withSchedules });
});

router.get("/borrower/loans/:loanId", requireAuth, requireRole("BORROWER"), (req: AuthRequest, res) => {
  const loan = loans.find((item) => item.id === req.params.loanId && item.borrowerId === req.user!.id);
  if (!loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  res.json({
    ok: true,
    loan,
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
  const result = await requestCreditReport({
    userId: req.user!.id,
    bvn: findOrCreateKycCase(req.user!.id).bvn,
    nin: findOrCreateKycCase(req.user!.id).nin,
    phone: user?.phone,
    fullName: user?.fullName,
  });
  const report = {
    id: randomUUID(),
    userId: req.user!.id,
    provider: "prembly" as const,
    consentGrantedAt: now,
    requestedAt: now,
    reportReference: result.providerReference,
    status: result.status,
    score: result.score,
    normalizedFields: result.normalizedFields,
    redactedRaw: result.redactedRaw,
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
  const parsed = amountSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "amountNaira must be a positive number" });
    return;
  }
  const user = users.find((item) => item.id === req.user!.id);
  const txRef = `VELO-REPAY-${randomUUID()}`;
  const now = new Date().toISOString();
  const dueAt = loan.dueAt ? new Date(loan.dueAt) : null;
  const onTime = dueAt ? new Date(now) <= dueAt : true;
  const repayment: (typeof repayments)[number] = {
    id: randomUUID(),
    txRef,
    loanId: loan.id,
    borrowerId: req.user!.id,
    amountNaira: parsed.data.amountNaira,
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
      checkout,
      message:
        "Complete Flutterwave checkout. The payment is recorded only after verified webhook settlement.",
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

router.get("/admin/summary", requireAuth, requireRole("ADMIN"), (_req, res) => {
  const approved = loans.filter((l) => ["APPROVED", "DISBURSEMENT_PENDING", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID"].includes(l.status));
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
    kycStatus: "NOT_STARTED" as KycStatus,
    createdAt: now,
    updatedAt: now,
    isActive: true,
  };
  users.push(manager);
  recordAdminAudit(req, "LOAN_MANAGER_CREATED", "USER", manager.id, { role: "LOAN_MANAGER", email: manager.email });
  const { passwordHash: _passwordHash, ...safeManager } = manager;
  res.status(201).json({ ok: true, manager: { ...safeManager, role: "LOAN_MANAGER" } });
});

router.patch("/admin/loan-managers/:id/status", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
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
  res.json({ ok: true, manager: { ...manager, passwordHash: undefined, role: "LOAN_MANAGER" } });
});

router.delete("/admin/loan-managers/:id", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const managerIndex = users.findIndex((user) => user.id === req.params.id && user.roles.includes("LOAN_MANAGER"));
  if (managerIndex < 0) {
    res.status(404).json({ ok: false, error: "Loan manager not found" });
    return;
  }
  const [manager] = users.splice(managerIndex, 1);
  recordAdminAudit(req, "LOAN_MANAGER_DELETED", "USER", manager.id, { email: manager.email, role: "LOAN_MANAGER" });
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
  const parsed = z.object({ email: z.string().email(), fullName: z.string().min(2).max(120), phone: z.preprocess(normalizePhone, z.string().regex(/^0\d{10}$/)), password: z.string().min(12) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (findUserByEmail(parsed.data.email)) { res.status(409).json({ ok: false, error: "An account with this email already exists" }); return; }
  const now = new Date().toISOString();
  const administrator = { id: randomUUID(), email: parsed.data.email.toLowerCase(), phone: parsed.data.phone, fullName: parsed.data.fullName, passwordHash: await bcrypt.hash(parsed.data.password, 12), roles: ["ADMIN"] as Role[], kycStatus: "VERIFIED" as KycStatus, createdAt: now, updatedAt: now, isActive: true };
  users.push(administrator);
  recordAdminAudit(req, "ADMIN_CREATED", "USER", administrator.id, { email: administrator.email });
  const { passwordHash: _passwordHash, ...safeAdministrator } = administrator;
  res.status(201).json({ ok: true, administrator: safeAdministrator });
});

router.patch("/admin/administrators/:id/status", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const parsed = z.object({ isActive: z.boolean() }).safeParse(req.body);
  const administrator = users.find((user) => user.id === req.params.id && user.roles.includes("ADMIN"));
  if (!parsed.success) { res.status(400).json({ ok: false, error: parsed.error.flatten() }); return; }
  if (!administrator) { res.status(404).json({ ok: false, error: "Administrator not found" }); return; }
  administrator.isActive = parsed.data.isActive;
  administrator.updatedAt = new Date().toISOString();
  recordAdminAudit(req, parsed.data.isActive ? "ADMIN_ACTIVATED" : "ADMIN_DEACTIVATED", "USER", administrator.id);
  const { passwordHash: _passwordHash, ...safeAdministrator } = administrator;
  res.json({ ok: true, administrator: safeAdministrator });
});

router.delete("/admin/administrators/:id", requireAuth, requireRole("ADMIN"), (req: AuthRequest, res) => {
  const index = users.findIndex((user) => user.id === req.params.id && user.roles.includes("ADMIN"));
  if (index < 0) { res.status(404).json({ ok: false, error: "Administrator not found" }); return; }
  const [administrator] = users.splice(index, 1);
  recordAdminAudit(req, "ADMIN_DELETED", "USER", administrator.id, { email: administrator.email });
  res.json({ ok: true, deleted: true });
});

router.get("/admin/audit-logs", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, logs: [...auditLogs].sort((first, second) => second.createdAt.localeCompare(first.createdAt)) });
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

router.post("/admin/kyc-cases/:id/decision", requireAuth, requireRole("ADMIN"), (req, res) => {
  const parsed = z
    .object({
      decision: z.enum(["VERIFIED", "PARTIALLY_VERIFIED", "REJECTED", "ACTION_REQUIRED", "SUSPENDED"]),
      note: z.string().max(1000).default(""),
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
  kyc.status = parsed.data.decision as KycStatus;
  kyc.reviewedBy = (req as AuthRequest).user?.id ?? "unknown-admin";
  kyc.reviewedAt = new Date().toISOString();
  if (parsed.data.decision === "REJECTED") kyc.rejectionReason = parsed.data.note || "Admin rejected KYC";
  if (parsed.data.checklistOverride) Object.assign(kyc.checklist, parsed.data.checklistOverride);
  kyc.updatedAt = new Date().toISOString();
  const user = users.find((u) => u.id === kyc.userId);
  if (user) user.kycStatus = kyc.status;
  res.json({ ok: true, case: kyc, before });
});

router.get("/admin/loans", requireAuth, requireRole("ADMIN"), (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const type = typeof req.query.type === "string" ? req.query.type : undefined;
  const search = typeof req.query.search === "string" ? req.query.search.toLowerCase() : undefined;
  const filtered = loanApplications.filter((application) => {
    const snapshot = application.customerSnapshot as Record<string, unknown> | undefined;
    const business = snapshot?.businessInfo as Record<string, unknown> | undefined;
    const applicantType = business?.businessName ? "BUSINESS" : "PERSONAL";
    const searchable = JSON.stringify({ application, snapshot }).toLowerCase();
    return (!status || application.status === status) && (!type || applicantType === type) && (!search || searchable.includes(search));
  });
  const page = paginate(filtered, req.query as Record<string, unknown>);
  res.json({ ok: true, loans: page.items, disbursedLoans: loans, meta: page.meta });
});

router.get("/admin/loans/:loanId", requireAuth, requireRole("ADMIN"), (req, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId || a.applicationId === req.params.loanId);
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.id === req.params.loanId);
  if (!application && !loan) {
    res.status(404).json({ ok: false, error: "Loan not found" });
    return;
  }
  res.json({
    ok: true,
    application,
    loan,
    schedule: loan ? loanSchedules.filter((s) => s.loanId === loan.id) : [],
    repayments: loan ? repayments.filter((r) => r.loanId === loan.id) : [],
    creditHistory: application ? creditHistory.filter((c) => c.userId === application.borrowerId) : [],
  });
});

router.post("/admin/loans/:loanId/decision", requireAuth, requireRole("ADMIN"), (req, res) => {
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
  const application = loanApplications.find((a) => a.id === req.params.loanId);
  if (!application) {
    res.status(404).json({ ok: false, error: "Loan application not found" });
    return;
  }
  application.manualDecision = parsed.data.decision;
  application.manualNote = parsed.data.note;
  application.updatedAt = new Date().toISOString();
  if (parsed.data.decision === "APPROVED") {
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
  res.json({ ok: true, application });
});

router.post("/admin/loans/:loanId/disburse", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const application = loanApplications.find((a) => a.id === req.params.loanId);
  const loan = loans.find((l) => l.applicationId === req.params.loanId || l.id === req.params.loanId);
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
    disbursementAccount?: { accountNumber?: string; bankCode?: string; accountName?: string };
  };
  const account = snapshot.disbursementAccount;
  if (!account?.accountNumber || !account.bankCode) {
    res.status(400).json({ ok: false, error: "Verified disbursement account details are required" });
    return;
  }
  try {
    const transfer = await createLoanDisbursement({
      txRef: `VELO-DISBURSE-${loan.id}`,
      amountNaira: Number(loan.principalNaira),
      accountNumber: account.accountNumber,
      accountBank: account.bankCode,
      beneficiaryName: account.accountName ?? snapshot.fullName ?? "Borrower",
      narration: `Velo loan disbursement ${application?.applicationId ?? loan.id}`,
    });
    loan.status = "DISBURSEMENT_PENDING";
    loan.providerTransfer = transfer;
    const now = new Date().toISOString();
    loan.updatedAt = now;
    creditHistory.push({
      id: randomUUID(),
      userId: loan.borrowerId,
      loanId: loan.id,
      eventType: "LOAN_DISBURSED",
      detail: `Disbursement initiated for loan ${loan.id}`,
      occurredAt: now,
      createdAt: now,
    });
    res.status(202).json({ ok: true, loan, transfer });
  } catch (error) {
    res.status(503).json({
      ok: false,
      error: error instanceof Error ? error.message : "Flutterwave transfer unavailable",
    });
  }
});

router.get("/admin/investment-plans", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, plans: investmentPlans });
});

router.post("/admin/investment-plans", requireAuth, requireRole("ADMIN"), (req, res) => {
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
  res.status(201).json({ ok: true, plan });
});

router.patch("/admin/investment-plans/:id", requireAuth, requireRole("ADMIN"), (req, res) => {
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
  res.json({ ok: true, plan });
});

router.get("/admin/reconciliation", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({
    ok: true,
    providerEvents: providerEvents.map((e) => ({ ...e, event: undefined })),
    unverifiedDeposits: walletTransactions.filter((t) => t.type === "DEPOSIT" && t.status === "PENDING_PROVIDER_CONFIRMATION"),
    unverifiedRepayments: repayments.filter((r) => r.status === "PENDING_PROVIDER_CONFIRMATION"),
    pendingPayouts: payouts.filter((p) => ["PENDING_PROVIDER_CONFIRMATION", "FAILED"].includes(p.status)),
  });
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

router.post("/consents", requireAuth, (req: AuthRequest, res) => {
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
  res.status(201).json({ ok: true, consent });
});

router.get("/admin/loan-products", requireAuth, requireRole("ADMIN"), (_req, res) => {
  res.json({ ok: true, products: loanProducts });
});

router.post("/admin/loan-products", requireAuth, requireRole("ADMIN"), (req, res) => {
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
  res.status(201).json({ ok: true, product });
});

router.patch("/admin/loan-products/:id", requireAuth, requireRole("ADMIN"), (req, res) => {
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

export default router;
