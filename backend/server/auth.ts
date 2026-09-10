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
} from "./store.js";
import { sendSms, maskPhone, formatOtpMessage } from "./providers/kudi.js";
import { sendEmail } from "./email.js";
import { sendWhatsAppText, maskPhoneForWa } from "./providers/meta.js";

const secret = env.JWT_SECRET ?? "local-development-secret-change-me-please-32chars-min";
let adminPasswordHashOverride: string | undefined;

export function getAdminPasswordHashOverride(): string | undefined {
  return adminPasswordHashOverride;
}

export function setAdminPasswordHashOverride(value: string): void {
  adminPasswordHashOverride = value;
}

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
  if (path.includes("/config")) return "settings";
  return undefined;
}

export class OtpRateLimitError extends Error {
  constructor(public readonly resendAvailableAt: string, public readonly resendSecondsRemaining: number) {
    super("Please wait before requesting another OTP.");
    this.name = "OtpRateLimitError";
  }
}

export async function createOtpChallenge(
  userId: string,
  action: OtpAction,
  phone?: string,
  email?: string,
  channel: "SMS" | "WHATSAPP" | "EMAIL" = "SMS"
): Promise<{ id: string; expiresAt: string; resendAvailableAt: string; resendSecondsRemaining: number; channel: "SMS"|"WHATSAPP"|"EMAIL"; phone?: string; email?: string; }> {
  const now = new Date();
  const latest = otpChallenges
    .filter((challenge) => challenge.userId === userId && challenge.action === action && !challenge.consumedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest) {
    const resendAvailableAt = new Date(new Date(latest.createdAt).getTime() + env.OTP_RESEND_COOLDOWN_SECONDS * 1000);
    const resendSecondsRemaining = Math.max(0, Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000));
    if (resendSecondsRemaining > 0) throw new OtpRateLimitError(resendAvailableAt.toISOString(), resendSecondsRemaining);
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
  if (phone && channel === "SMS") {
    try {
      const result = await sendSms({ to: phone, message: smsText });
      notifications.push({
        id: randomUUID(),
        userId,
        channel: "SMS",
        kind: "OTP",
        recipientMasked: maskPhone(phone),
        status: result.sent ? "SENT" : result.error ? "FAILED" : "NOT_CONFIGURED",
        providerMessageId: result.providerMessageId,
        error: result.error,
        retryCount: 0,
        createdAt: now.toISOString(),
        sentAt: result.sent ? now.toISOString() : undefined,
        failedAt: result.error ? now.toISOString() : undefined,
      });
    } catch {
      // Still return the challenge ID — local-dev OTPs should be discoverable via logs
    }
  }
  if (phone && channel === "WHATSAPP") {
    try {
      const result = await sendWhatsAppText({ to: phone, text: smsText });
      notifications.push({
        id: randomUUID(),
        userId,
        channel: "WHATSAPP",
        kind: "OTP",
        recipientMasked: maskPhoneForWa(phone),
        status: result.sent ? "SENT" : result.error ? "FAILED" : "NOT_CONFIGURED",
        providerMessageId: result.providerMessageId,
        error: result.error,
        retryCount: 0,
        createdAt: now.toISOString(),
        sentAt: result.sent ? now.toISOString() : undefined,
        failedAt: result.error ? now.toISOString() : undefined,
      });
    } catch {
      // Still return the challenge ID so local development can use the logged OTP.
    }
  }
  if (email && channel === "EMAIL") {
    try {
      const result = await sendEmail({
        to: email,
        name: users.find((u) => u.id === userId)?.fullName ?? "User",
        subject: `Velo OTP — ${action.replace(/_/g, " ")}`,
        html: `<div style="font-family:Arial,sans-serif"><h2>Velo One-Time Code</h2><p>Code: <strong style="font-size:28px">${code}</strong></p><p>Use to ${action.replace(/_/g, " ").toLowerCase()}. Expires in ${ttlMinutes} minutes.</p><p>Never share this code with anyone.</p></div>`,
      });
      notifications.push({
        id: randomUUID(),
        userId,
        channel: "EMAIL",
        kind: "OTP",
        subject: `Velo OTP — ${action.replace(/_/g, " ")}`,
        recipientMasked: email.replace(/^(.{3})[^@]*@(.*)$/, "$1***@$2"),
        status: result.sent ? "SENT" : "NOT_CONFIGURED",
        providerMessageId: result.providerReference,
        retryCount: 0,
        createdAt: now.toISOString(),
        sentAt: result.sent ? now.toISOString() : undefined,
      });
    } catch {
      // ignore
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[DEV OTP] user=${userId} action=${action} code=${code}`);
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
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  record.consumedAt = new Date().toISOString();
  return { ok: true };
}

export function markKycChecklistComplete(userId: string): void {
  const kyc = findOrCreateKycCase(userId);
  const allDone = Object.values(kyc.checklist).every(Boolean);
  const anyDone = Object.values(kyc.checklist).some(Boolean);
  const now = new Date().toISOString();
  if (allDone) {
    if (kyc.status === "NOT_STARTED" || kyc.status === "IN_PROGRESS" || kyc.status === "PENDING_VERIFICATION" || kyc.status === "ACTION_REQUIRED") {
      kyc.status = "VERIFIED";
      kyc.verifiedAt = now;
      if (!kyc.submittedAt) kyc.submittedAt = now;
    }
  } else if (anyDone) {
    if (kyc.status === "NOT_STARTED") kyc.status = "IN_PROGRESS";
  }
  kyc.updatedAt = now;
  const user = users.find((u) => u.id === userId);
  if (user) user.kycStatus = kyc.status;
}

export function recordConsent(userId: string, consentType: Parameters<typeof consents.push>[0]["consentType"]): (typeof consents)[number] {
  const now = new Date().toISOString();
  const consent = { id: randomUUID(), userId, consentType, consentedAt: now };
  consents.push(consent);
  return consent;
}
