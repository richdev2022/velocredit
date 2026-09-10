import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

async function kudiPostForm<T>(path: string, fields: Record<string, string>): Promise<T> {
  if (!env.KUDI_API_KEY) throw new Error("KUDI SMS is not configured");
  const url = `${env.KUDI_BASE_URL}${path}`;
  const params = new URLSearchParams();
  params.set("token", env.KUDI_API_KEY);
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== "") params.set(key, value);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });
  const text = await response.text();
  let data: T & { status?: string; msg?: string; error_code?: string };
  try {
    data = JSON.parse(text) as T & { status?: string; msg?: string; error_code?: string };
  } catch (_e) {
    throw new Error(`KUDI returned non-JSON: ${text.slice(0, 120)}`);
  }
  const errorCode = data.error_code;
  const success =
    String(data.status ?? "").toLowerCase() === "success" &&
    (errorCode === undefined || errorCode === "000");
  if (!success || !response.ok) {
    throw new Error(data.msg || `KUDI request failed (status=${data.status || response.status}, code=${errorCode || "?"})`);
  }
  return data;
}

/* =========================================================================
   OTP SMS — uses Kudi official Send OTP endpoint:
   POST https://my.kudisms.net/api/sendotp
   form-data: token, senderID, recipients, appnamecode, templatecode,
              otp_type, otp_length, otp_duration, otp_attempts, channel=sms
   ========================================================================= */
export interface KudiSendOtpInput {
  recipients: string;
  senderID?: string;
  otpType?: "NUMERIC" | "ALPHANUMERIC";
  otpLength?: number;
  otpDurationMinutes?: number;
  otpAttempts?: number;
  channel?: "sms" | "voiceotp";
}

export interface KudiSendOtpResponse {
  status: string;
  error_code: string;
  verification_id?: string;
  cost?: string;
  data?: string;
  msg?: string;
  length?: number;
  page?: number;
  balance?: string;
}

export async function sendOtpSms(input: KudiSendOtpInput): Promise<{
  sent: boolean;
  providerMessageId?: string;
  verificationId?: string;
  status: string;
  error?: string;
}> {
  try {
    const senderID = input.senderID || env.KUDI_SENDER_ID;
    if (!senderID) throw new Error("KUDI approved sender ID is required");
    if (!env.KUDI_APP_NAME_CODE) throw new Error("KUDI_APP_NAME_CODE (approved App Name Code) is required");
    if (!env.KUDI_OTP_TEMPLATE_CODE) throw new Error("KUDI_OTP_TEMPLATE_CODE (approved SMS OTP Template Code) is required");
    const response = await kudiPostForm<KudiSendOtpResponse>("/sendotp", {
      senderID,
      recipients: input.recipients,
      appnamecode: env.KUDI_APP_NAME_CODE,
      templatecode: env.KUDI_OTP_TEMPLATE_CODE,
      otp_type: input.otpType || "NUMERIC",
      otp_length: String(input.otpLength || 6),
      otp_duration: String(input.otpDurationMinutes || 5),
      otp_attempts: String(input.otpAttempts || 2),
      channel: input.channel || "sms",
    });
    return {
      sent: true,
      providerMessageId: response.verification_id,
      verificationId: response.verification_id,
      status: response.status || "SENT",
    };
  } catch (error) {
    return {
      sent: false,
      status: "FAILED",
      error: error instanceof Error ? error.message : "KUDI send OTP failed",
    };
  }
}

/* =========================================================================
   Verify OTP (optional — we use internal challenge hashing; provided here
   for completeness in case you later want to fully trust Kudi for OTP)
   POST https://my.kudisms.net/api/verifyotp
   form-data: token, verification_id, otp
   ========================================================================= */
export interface KudiVerifyOtpResponse {
  status: string;
  error_code: string;
  verification_id?: string;
  cost?: string;
  balance?: string;
  msg?: string;
  attempts?: number;
}

export async function verifyOtpSms(verificationId: string, otp: string): Promise<{ verified: boolean; error?: string; attempts?: number }> {
  try {
    const response = await kudiPostForm<KudiVerifyOtpResponse>("/verifyotp", {
      verification_id: verificationId,
      otp,
    });
    return {
      verified: response.error_code === "000" || String(response.status || "").toLowerCase() === "success",
      attempts: response.attempts,
    };
  } catch (error) {
    return {
      verified: false,
      error: error instanceof Error ? error.message : "KUDI verify OTP failed",
    };
  }
}

/* =========================================================================
   Generic SMS (legacy — kept for non-OTP transactional SMS when needed.
   Uses Kudi /autocomposesms with gateway=2 per docs.
   CURRENTLY UNUSED for OTP flow (user's problem statement) but kept to
   preserve backward compatibility for any future non-OTP SMS needs.
   ========================================================================= */
export interface SmsSendInput {
  to: string;
  message: string;
  senderId?: string;
}

export async function sendSms(input: SmsSendInput): Promise<{ sent: boolean; providerMessageId?: string; status: string; error?: string }> {
  try {
    const senderId = input.senderId || env.KUDI_SENDER_ID || "Velo";
    const body = JSON.stringify({
      token: env.KUDI_API_KEY,
      gateway: 2,
      data: [[senderId, input.to, input.message]],
    });
    const url = `${env.KUDI_BASE_URL}/autocomposesms`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch (_e) {
      /* autocomposesms docs say no response body on success — treat as ok if 2xx */
    }
    const ok = response.ok ||
      String(data.status ?? "").toLowerCase() === "sent" ||
      String((data as { msg?: string }).msg ?? "").toLowerCase().includes("sent");
    return {
      sent: ok,
      providerMessageId: String((data as { message_id?: unknown }).message_id ?? ""),
      status: String(data.status ?? response.ok ? "queued" : "FAILED"),
    };
  } catch (error) {
    return { sent: false, status: "FAILED", error: error instanceof Error ? error.message : "KUDI send failed" };
  }
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 7) return "***";
  return `${digits.slice(0, 3)}****${digits.slice(-3)}`;
}

export function formatOtpMessage(otp: string, action: string, ttlMinutes: number): string {
  const verbs: Record<string, string> = {
    SIGNUP_VERIFY: "verify your Velo account",
    LOGIN_STEP_UP: "secure your login",
    PAYOUT_ACCOUNT_CHANGE: "change your payout account",
    EARLY_LIQUIDITY: "request early liquidity",
    PASSWORD_RESET: "reset your password",
    KYC_VERIFICATION: "complete identity verification",
    WITHDRAWAL: "authorize withdrawal",
  };
  const purpose = verbs[action] || "complete this action";
  return `Velo OTP: ${otp}. Use to ${purpose}. Expires in ${ttlMinutes} min. Never share this code.`;
}

export function verifyKudiSignature(signature: string | undefined, rawBody: string): boolean {
  if (!signature) return false;
  if (env.KUDI_WEBHOOK_SECRET) {
    const expected = createHmac("sha256", env.KUDI_WEBHOOK_SECRET).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    if (expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf)) return true;
  }
  if (env.KUDI_API_KEY) {
    const fallback = env.KUDI_API_KEY.slice(0, signature.length);
    const fallbackBuf = Buffer.from(fallback);
    const receivedBuf = Buffer.from(signature);
    if (fallbackBuf.length === receivedBuf.length && timingSafeEqual(fallbackBuf, receivedBuf)) return true;
  }
  return !env.KUDI_WEBHOOK_SECRET && !env.KUDI_API_KEY;
}
