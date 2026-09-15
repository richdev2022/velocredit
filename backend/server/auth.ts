import { randomUUID, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import jwt, { type SignOptions } from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { env } from "./config.js";
import {
  findUserByEmail,
  users,
  otpChallenges,
  passwordResetTokens,
  notifications,
  findOrCreateKycCase,
  ADMIN_PERMISSIONS,
  auditLogs,
  consents,
  generateOtpCode,
  hashToken,
  type OtpAction,
  type User,
  type AdminPermission,
  type KycStatus,
  documents,
  identityVerificationEvents,
  indexes,
} from "./store.js";
import { sendOtpSms, maskPhone, formatOtpMessage } from "./providers/kudi.js";
// import { sendSms, maskPhone, formatOtpMessage } from "./providers/kudi.js"; // legacy generic SMS, replaced with Kudi Send OTP endpoint
import { sendEmail, welcomeEmail, loginAttemptEmail } from "./email.js";
import { sendWhatsAppText, maskPhoneForWa } from "./providers/meta.js";

const secret = env.JWT_SECRET ?? "local-development-secret-change-me-please-32chars-min";

export type AuthRequest = Request & {
  user?: Pick<User, "id" | "email" | "roles" | "fullName" | "kycStatus" | "adminPermissions">;
};

export function issueToken(user: User): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      fullName: user.fullName,
      roles: user.roles,
      adminPermissions: user.roles.includes("ADMIN") ? [...ADMIN_PERMISSIONS] : user.adminPermissions,
      kycStatus: user.kycStatus,
    },
    secret,
    { expiresIn: env.JWT_EXPIRES_IN ?? "2h" } as SignOptions
  );
}

export function issueRefreshToken(user: User): { id: string; token: string; tokenHash: string; expiresAt: string } {
  const token = randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return { id: randomUUID(), token, tokenHash, expiresAt };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ ok: false, error: "Authentication required" });
    return;
  }
  try {
    const payload = jwt.verify(token, secret) as {
      sub: string;
      email: string;
      fullName: string;
      roles: User["roles"];
      adminPermissions?: AdminPermission[];
      kycStatus?: string;
    };
    req.user = {
      id: payload.sub,
      email: payload.email,
      fullName: payload.fullName,
      roles: payload.roles,
      adminPermissions: payload.roles.includes("ADMIN") ? [...ADMIN_PERMISSIONS] : payload.adminPermissions,
      kycStatus: (payload.kycStatus ?? "NOT_STARTED") as User["kycStatus"],
    };
    if (req.originalUrl.includes("/api/v1/admin/")) {
      auditLogs.push({ id: randomUUID(), userId: req.user.id, action: "ADMIN_ENDPOINT_CALL", resourceType: "ENDPOINT", resourceId: req.originalUrl.split("?")[0], metadata: { method: req.method }, ipAddress: req.ip, userAgent: req.get("user-agent") ?? undefined, createdAt: new Date().toISOString() });
    }
    next();
  } catch {
    res.status(401).json({ ok: false, error: "Invalid or expired token" });
  }
}

export function requireRole(...roles: User["roles"][number][]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const isFullAdmin = req.user?.roles.includes("ADMIN");
    const requiredPermission = adminPermissionForPath(req.path);
    const hasManagerPermission = req.user?.roles.includes("LOAN_MANAGER") && Boolean(requiredPermission && (req.user.adminPermissions ?? []).includes(requiredPermission));
    const borrowerInvestorUnion = new Set(roles.filter((r) => r === "BORROWER" || r === "INVESTOR"));
    const hasEitherBorrowerInvestor = (req.user?.roles.includes("BORROWER") || req.user?.roles.includes("INVESTOR")) ?? false;
    const unionMatches = borrowerInvestorUnion.size > 0 && hasEitherBorrowerInvestor;
    const adminMatches = roles.includes("ADMIN") && (isFullAdmin || hasManagerPermission);
    const otherRoles = roles.filter((r) => r !== "BORROWER" && r !== "INVESTOR" && r !== "ADMIN");
    const otherMatches = otherRoles.length > 0 && otherRoles.some((r) => req.user?.roles.includes(r));
    const directMatches = !borrowerInvestorUnion.size && !adminMatches && roles.some((r) => req.user?.roles.includes(r));
    if (!req.user || !(unionMatches || adminMatches || otherMatches || directMatches)) {
      res.status(403).json({ ok: false, error: "Insufficient permissions" });
      return;
    }
    next();
  };
}

function adminPermissionForPath(path: string): AdminPermission | undefined {
  if (path.includes("/summary")) return "overview";
  if (path.includes("/users")) return "users";
  if (path.includes("/investors")) return "investors";
  if (path.includes("/kyc")) return "kyc";
  if (path.includes("/payouts")) return "payouts";
  if (path.includes("/loans") || path.includes("/loan-products")) return "loans";
  if (path.includes("/reconciliation")) return "reconciliation";
  if (path.includes("/audit")) return "audit";
  if (path.includes("/administrators") || path.includes("/loan-managers")) return "staff";
  if (path.includes("/investment-plans")) return "investments";
  if (path.includes("/reports")) return "reports";
  if (path.includes("/config") || path.includes("/migrations")) return "settings";
  return undefined;
}

export class OtpRateLimitError extends Error {
  constructor(public readonly resendAvailableAt: string, public readonly resendSecondsRemaining: number) {
    super("Please wait before requesting another OTP.");
    this.name = "OtpRateLimitError";
  }
}

async function deliverOtp(input: {
  userId: string;
  action: OtpAction;
  phone?: string;
  email?: string;
  channel: "SMS" | "WHATSAPP" | "EMAIL";
  code: string;
  smsText: string;
  ttlMinutes: number;
  createdAt: Date;
}): Promise<void> {
  const { userId, action, phone, email, channel, code, smsText, ttlMinutes, createdAt } = input;
  if (phone && channel === "SMS") {
    try {
      const result = await sendOtpSms({ recipients: phone, message: smsText, otpLength: code.length, otpDurationMinutes: ttlMinutes, otpAttempts: Math.max(1, Math.min(6, Math.round(env.OTP_MAX_ATTEMPTS))), channel: "sms" });
      notifications.push({ id: randomUUID(), userId, channel: "SMS", kind: "OTP", recipientMasked: maskPhone(phone), status: result.sent ? "SENT" : result.error ? "FAILED" : "NOT_CONFIGURED", providerMessageId: result.providerMessageId, error: result.error, retryCount: 0, createdAt: createdAt.toISOString(), sentAt: result.sent ? createdAt.toISOString() : undefined, failedAt: result.error ? createdAt.toISOString() : undefined });
      if (!result.sent && env.NODE_ENV !== "production") console.warn(`[createOtpChallenge] SMS send failed for action=${action} user=${userId}: ${result.error || "unknown"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notifications.push({ id: randomUUID(), userId, channel: "SMS", kind: "OTP", recipientMasked: maskPhone(phone), status: "FAILED", error: message, retryCount: 0, createdAt: createdAt.toISOString(), failedAt: createdAt.toISOString() });
    }
  }
  if (phone && channel === "WHATSAPP") {
    try {
      const result = await sendWhatsAppText({ to: phone, text: smsText });
      notifications.push({ id: randomUUID(), userId, channel: "WHATSAPP", kind: "OTP", recipientMasked: maskPhoneForWa(phone), status: result.sent ? "SENT" : result.error ? "FAILED" : "NOT_CONFIGURED", providerMessageId: result.providerMessageId, error: result.error, retryCount: 0, createdAt: createdAt.toISOString(), sentAt: result.sent ? createdAt.toISOString() : undefined, failedAt: result.error ? createdAt.toISOString() : undefined });
    } catch {
      // The challenge remains usable when the delivery provider is unavailable.
    }
  }
  if (email && channel === "EMAIL") {
    try {
      const result = await sendEmail({ to: email, name: users.find((user) => user.id === userId)?.fullName ?? "User", subject: `Velo OTP — ${action.replace(/_/g, " ")}`, html: `<div style="font-family:Arial,sans-serif"><h2>Velo One-Time Code</h2><p>Code: <strong style="font-size:28px">${code}</strong></p><p>Use to ${action.replace(/_/g, " ").toLowerCase()}. Expires in ${ttlMinutes} minutes.</p><p>Never share this code with anyone.</p></div>` });
      notifications.push({ id: randomUUID(), userId, channel: "EMAIL", kind: "OTP", subject: `Velo OTP — ${action.replace(/_/g, " ")}`, recipientMasked: email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"), status: result.sent ? "SENT" : "NOT_CONFIGURED", providerMessageId: result.providerReference, retryCount: 0, createdAt: createdAt.toISOString(), sentAt: result.sent ? createdAt.toISOString() : undefined });
    } catch {
      // The challenge remains usable when the delivery provider is unavailable.
    }
  }
  if (env.NODE_ENV !== "production") console.log(`[DEV OTP] user=${userId} action=${action} code=${code}`);
}

export async function createOtpChallenge(
  userId: string,
  action: OtpAction,
  phone?: string,
  email?: string,
  channel: "SMS" | "WHATSAPP" | "EMAIL" = "SMS",
  options: { skipRateLimit?: boolean } = {}
): Promise<{ id: string; expiresAt: string; resendAvailableAt: string; resendSecondsRemaining: number; channel: "SMS"|"WHATSAPP"|"EMAIL"; phone?: string; email?: string; }> {
  const now = new Date();
  const latest = otpChallenges
    .filter((challenge) => challenge.userId === userId && challenge.action === action && !challenge.consumedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest) {
    const resendAvailableAt = new Date(new Date(latest.createdAt).getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000);
    const resendSecondsRemaining = Math.max(0, Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000));
    if (resendSecondsRemaining > 0 && !options.skipRateLimit) throw new OtpRateLimitError(resendAvailableAt.toISOString(), resendSecondsRemaining);
  }
  const expiresAt = new Date(now.getTime() + env.OTP_TTL_SECONDS * 1000).toISOString();
  const code = generateOtpCode();
  const challengeHash = hashToken(code);
  const challenge = {
    id: randomUUID(),
    userId,
    action,
    challengeHash,
    expiresAt,
    attempts: 0,
    maxAttempts: env.OTP_MAX_ATTEMPTS,
    createdAt: now.toISOString(),
    deliveryChannel: channel,
    phone,
    email,
  };
  otpChallenges.push(challenge);
  const ttlMinutes = Math.max(1, Math.round(env.OTP_TTL_SECONDS / 60));
  const smsText = formatOtpMessage(code, action, ttlMinutes);
  void deliverOtp({ userId, action, phone, email, channel, code, smsText, ttlMinutes, createdAt: now });
  const resendAvailableAt = new Date(now.getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000).toISOString();
  return {
    id: challenge.id,
    expiresAt,
    resendAvailableAt,
    resendSecondsRemaining: env.OTP_RESEND_COOLDOWN_SECONDS,
    channel,
    phone,
    email,
  };
}

export function findOtpChallenge(challengeId: string): (undefined | { id: string; userId: string; action: OtpAction; expiresAt: string; attempts: number; maxAttempts: number; createdAt: string; deliveryChannel: "SMS"|"WHATSAPP"|"EMAIL"; phone?: string; email?: string; consumedAt?: string }) {
  return otpChallenges.find((c) => c.id === challengeId) as any;
}

export async function verifyOtpChallenge(challengeId: string, inputCode: string): Promise<{ ok: boolean; userId?: string; action?: OtpAction; error?: string }> {
  const challenge = otpChallenges.find((c) => c.id === challengeId);
  if (!challenge) return { ok: false, error: "Challenge not found" };
  const now = new Date().toISOString();
  if (challenge.consumedAt) return { ok: false, error: "Challenge already used" };
  if (challenge.expiresAt < now) return { ok: false, error: "Challenge expired" };
  if (challenge.attempts >= challenge.maxAttempts) return { ok: false, error: "Too many attempts" };
  challenge.attempts += 1;
  const expected = Buffer.from(challenge.challengeHash);
  const received = Buffer.from(hashToken(inputCode));
  const matches = expected.length === received.length && timingSafeEqual(expected, received);
  if (!matches) {
    if (challenge.attempts >= challenge.maxAttempts) {
      return { ok: false, error: "Maximum attempts exceeded" };
    }
    return { ok: false, error: `Invalid code. ${challenge.maxAttempts - challenge.attempts} attempt(s) remaining.` };
  }
  challenge.consumedAt = now;
  return { ok: true, userId: challenge.userId, action: challenge.action };
}

export async function requestPasswordReset(email: string): Promise<{ ok: boolean; resetId?: string; message: string }> {
  const user = findUserByEmail(email);
  if (!user) {
    return { ok: true, message: "If this email is registered, a reset link has been sent." };
  }
  const token = randomUUID();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const reset: (typeof passwordResetTokens)[number] = {
    id: randomUUID(),
    userId: user.id,
    tokenHash,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  passwordResetTokens.push(reset);
  try {
    await sendEmail({
      to: user.email,
      name: user.fullName,
      subject: "Reset your Velo password",
      html: `<div style="font-family:Arial,sans-serif"><h2>Password reset request</h2><p>Hello ${user.fullName}, use this token to reset your password. It expires in 30 minutes.</p><p>Reset token: <strong style="font-family:monospace;font-size:16px">${reset.id}:${token}</strong></p><p>If you did not request this, please ignore this email.</p></div>`,
    });
  } catch {
    // ignore — user gets the same response
  }
  return { ok: true, resetId: reset.id, message: "If this email is registered, a reset link has been sent." };
}

export async function confirmPasswordReset(resetId: string, rawToken: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
  const record = passwordResetTokens.find((r) => r.id === resetId);
  if (!record) return { ok: false, error: "Invalid reset reference" };
  if (record.consumedAt) return { ok: false, error: "Reset already used" };
  if (record.expiresAt < new Date().toISOString()) return { ok: false, error: "Reset expired" };
  const expected = Buffer.from(record.tokenHash);
  const received = Buffer.from(hashToken(rawToken));
  if (!(expected.length === received.length && timingSafeEqual(expected, received))) {
    return { ok: false, error: "Invalid reset token" };
  }
  const user = users.find((u) => u.id === record.userId);
  if (!user) return { ok: false, error: "User not found" };
  const now = new Date().toISOString();
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.updatedAt = now;
  record.consumedAt = now;
  return { ok: true };
}

export function markKycChecklistComplete(userId: string): void {
  const kyc = findOrCreateKycCase(userId);
  const requiredChecks = ["bvn", "nin", "liveness", "proofOfAddress", "signature"] as const;
  const allDone = requiredChecks.every((key) => kyc.checklist[key]);
  const anyDone = requiredChecks.some((key) => kyc.checklist[key]);
  const now = new Date().toISOString();
  const submittedStatuses = ["PENDING_VERIFICATION", "REVIEWING", "VERIFIED", "REJECTED"] as const;
  if (allDone) {
    if (kyc.status === "NOT_STARTED" || kyc.status === "IN_PROGRESS" || kyc.status === "ACTION_REQUIRED") {
      kyc.status = "PENDING_VERIFICATION";
      if (!kyc.submittedAt) kyc.submittedAt = now;
    }
  } else if (anyDone) {
    if (!(submittedStatuses as readonly KycStatus[]).includes(kyc.status)) kyc.status = "IN_PROGRESS";
  } else {
    if (!(submittedStatuses as readonly KycStatus[]).includes(kyc.status) && kyc.status !== "NOT_STARTED") kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = now;
  const user = users.find((u) => u.id === userId);
  if (user) user.kycStatus = kyc.status;
}

export type KycResetCategory = "BVN" | "NIN" | "LIVENESS" | "ADDRESS" | "ALL";

export function resetKycCategory(userId: string, category: KycResetCategory): { ok: boolean; error?: string; checklist?: any; status?: any } {
  const kyc = indexes?.kycCasesByUserId ? indexes.kycCasesByUserId.get(userId) ?? findOrCreateKycCase(userId) : findOrCreateKycCase(userId);
  const cat = String(category).toUpperCase();
  const now = new Date().toISOString();
  if (cat === "BVN" || cat === "ALL") {
    kyc.categoryResults = { ...(kyc.categoryResults ?? {}), BVN: { status: "NOT_STARTED", updatedAt: now } };
    kyc.bvn = undefined;
    kyc.bvnVerifiedAt = undefined;
    kyc.checklist.bvn = false;
    if (kyc.providerRaw && typeof kyc.providerRaw === "object") delete (kyc.providerRaw as any).bvn;
    if (kyc.verifiedDetails && typeof kyc.verifiedDetails === "object") delete (kyc.verifiedDetails as any).bvn;
    const keep = identityVerificationEvents.filter((e) => !(e.kycCaseId === kyc.id && e.verificationType === "BVN"));
    identityVerificationEvents.length = 0;
    identityVerificationEvents.push(...keep);
  }
  if (cat === "NIN" || cat === "ALL") {
    kyc.categoryResults = { ...(kyc.categoryResults ?? {}), NIN: { status: "NOT_STARTED", updatedAt: now } };
    kyc.nin = undefined;
    kyc.ninVerifiedAt = undefined;
    kyc.checklist.nin = false;
    if (kyc.providerRaw && typeof kyc.providerRaw === "object") delete (kyc.providerRaw as any).nin;
    if (kyc.verifiedDetails && typeof kyc.verifiedDetails === "object") delete (kyc.verifiedDetails as any).nin;
    const keep = identityVerificationEvents.filter((e) => !(e.kycCaseId === kyc.id && e.verificationType === "NIN"));
    identityVerificationEvents.length = 0;
    identityVerificationEvents.push(...keep);
  }
  if (cat === "LIVENESS" || cat === "ALL") {
    kyc.categoryResults = { ...(kyc.categoryResults ?? {}), LIVENESS: { status: "NOT_STARTED", updatedAt: now } };
    kyc.livenessVerifiedAt = undefined;
    kyc.checklist.liveness = false;
    kyc.selfieImageData = undefined;
    kyc.identityPhoto = undefined;
    const keep = identityVerificationEvents.filter((e) => !(e.kycCaseId === kyc.id && ((e.verificationType as string) === "LIVENESS" || (e.verificationType as string) === "FACE_MATCH" || (e.verificationType as string) === "BVN_LIVENESS" || (e.verificationType as string) === "NIN_LIVENESS")));
    identityVerificationEvents.length = 0;
    identityVerificationEvents.push(...keep);
  }
  if (cat === "ADDRESS" || cat === "ALL") {
    kyc.categoryResults = { ...(kyc.categoryResults ?? {}), ADDRESS: { status: "NOT_STARTED", updatedAt: now } };
    kyc.checklist.proofOfAddress = false;
    const keepDocs = documents.filter((d) => !(d.userId === userId && (d.documentType === "PROOF_OF_ADDRESS")));
    documents.length = 0;
    documents.push(...keepDocs);
  }
  if (cat === "ALL") {
    kyc.checklist.passport = false;
    kyc.checklist.signature = false;
    kyc.status = "NOT_STARTED";
    kyc.submittedAt = undefined;
    kyc.verifiedAt = undefined;
    kyc.rejectionReason = undefined;
    kyc.categoryResults = {};
    kyc.providerRequestId = undefined;
    kyc.providerRaw = undefined;
    kyc.verifiedDetails = undefined;
    const keepAll = identityVerificationEvents.filter((e) => e.kycCaseId !== kyc.id);
    identityVerificationEvents.length = 0;
    identityVerificationEvents.push(...keepAll);
    const keepAllDocs = documents.filter((d) => d.userId !== userId);
    documents.length = 0;
    documents.push(...keepAllDocs);
  } else {
    if (kyc.status === "VERIFIED") kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = now;
  markKycChecklistComplete(userId);
  return { ok: true, checklist: kyc.checklist, status: kyc.status };
}

export function recordConsent(userId: string, consentType: Parameters<typeof consents.push>[0]["consentType"]): (typeof consents)[number] {
  const now = new Date().toISOString();
  const consent = { id: randomUUID(), userId, consentType, consentedAt: now };
  consents.push(consent);
  return consent;
}
