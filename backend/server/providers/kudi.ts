import { timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

/* =========================================================================
   Kudi SMS Provider (Corporate — per official Postman docs for Corporate Sender IDs)
   Endpoint: POST https://my.kudisms.net/api/corporate
   Form fields (multipart/form-data):
     token       = env.KUDI_API_KEY
     senderID    = env.KUDI_SENDER_ID  (approved Corporate Sender ID only)
     recipients  = 2348xxxxxxxx,2349xxxxxxxx  (comma-separated 234 format)
     message     = SMS text content
   Success: error_code == "000" && status == "success"
   balance + cost + length + page are also returned.
   ========================================================================= */

export interface KudiSmsResponse {
  status: string;
  error_code: string;
  cost?: string;
  data?: unknown;
  msg?: string;
  length?: number;
  page?: number;
  balance?: string;
}

export interface KudiPostDebug {
  url: string;
  method: "GET" | "POST";
  maskedForm: Record<string, string>;
  httpStatus: number;
  rawBody: string;
  parsed: KudiSmsResponse | undefined;
  ok: boolean;
}

export let lastKudiPostDebug: KudiPostDebug | undefined = undefined;

async function kudiRequest(params: Record<string, string>): Promise<KudiSmsResponse> {
  if (!env.KUDI_API_KEY) throw new Error("KUDI SMS is not configured (KUDI_API_KEY is missing)");
  if (!env.KUDI_SENDER_ID) throw new Error("KUDI SMS is not configured (KUDI_SENDER_ID is missing)");
  const base = `${env.KUDI_BASE_URL}/corporate`;
  const allParams: Record<string, string> = {
    token: env.KUDI_API_KEY,
    senderID: env.KUDI_SENDER_ID,
  };
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") allParams[k] = v;
  }
  const maskedForm: Record<string, string> = {};
  for (const [k, v] of Object.entries(allParams)) {
    maskedForm[k] = k === "token" ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
  }
  const fd = new FormData();
  for (const [k, v] of Object.entries(allParams)) fd.append(k, v);
  const debug: KudiPostDebug = { url: base, method: "POST", maskedForm, httpStatus: 0, rawBody: "", parsed: undefined, ok: false };
  if (env.NODE_ENV !== "production") {
    console.log("[KudiSMS] POST", base, "multipart form=", JSON.stringify(maskedForm));
  }
  const response = await fetch(base, {
    method: "POST",
    body: fd,
    signal: AbortSignal.timeout(20_000),
  });
  debug.httpStatus = response.status;
  const text = await response.text();
  debug.rawBody = text;
  let data: KudiSmsResponse;
  try {
    data = JSON.parse(text) as KudiSmsResponse;
    debug.parsed = data;
  } catch (_e) {
    lastKudiPostDebug = debug;
    throw new Error(`KUDI returned non-JSON HTTP${response.status}: ${text.slice(0, 160)}`);
  }
  const ok =
    response.ok &&
    String(data.status ?? "").toLowerCase() === "success" &&
    String(data.error_code ?? "000") === "000";
  debug.ok = ok;
  lastKudiPostDebug = debug;
  if (env.NODE_ENV !== "production") {
    console.log("[KudiSMS] HTTP", response.status, "response=", text.slice(0, 500));
  }
  if (!ok) {
    throw new Error(data.msg || (data as unknown as { message?: string }).message || `KUDI SMS failed (HTTP ${response.status}, status=${data.status || "?"}, error_code=${data.error_code || "?"})`);
  }
  return data;
}

export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 11) return "234" + digits.slice(1);
  if (digits.startsWith("234") && digits.length === 13) return digits;
  if (/^\d{10}$/.test(digits)) return "234" + digits;
  return digits;
}

/* =========================================================================
   extractMessageId — Kudi corporate endpoint returns data as plain string:
      "2348...|98a0ca4c-8609-92a0-9f68-cfaf59c78da6"
   Older promo endpoint returned a 1-element array of same pipe-encoded strings.
   We handle both shapes and always return the UUID portion (after |).
   ========================================================================= */
function extractMessageId(data: unknown): string | undefined {
  const raw = Array.isArray(data) ? (data[0] as unknown) : data;
  const s = typeof raw === "string" ? raw : "";
  const uuid = s.split("|")[1];
  return uuid && uuid.length > 4 ? uuid : undefined;
}

/* =========================================================================
   sendOtpSms — delivers a pre-formatted OTP SMS message via Kudi /corporate.
   The OTP code is already embedded in the `message` by the caller (via
   formatOtpMessage in auth.ts), so we just forward to the generic endpoint.
   Signature is kept compatible with auth.ts usage (callers pass recipients,
   otpLength etc. — we only care about `recipients` here).
   ========================================================================= */
export interface KudiSendOtpInput {
  recipients: string;
  message?: string;
  senderID?: string;
  otpType?: "NUMERIC" | "ALPHANUMERIC";
  otpLength?: number;
  otpDurationMinutes?: number;
  otpAttempts?: number;
  channel?: "sms" | "voiceotp";
}

export async function sendOtpSms(input: KudiSendOtpInput & { message?: string }): Promise<{
  sent: boolean;
  providerMessageId?: string;
  verificationId?: string;
  status: string;
  error?: string;
}> {
  try {
    if (!input.message) {
      throw new Error("OTP message content is required");
    }
    const normalizedRecipient = normalizePhone(input.recipients);
    const params: Record<string, string> = {
      recipients: normalizedRecipient,
      message: input.message,
    };
    if (input.senderID) {
      params.senderID = input.senderID;
    }
    const response = await kudiRequest(params);
    const msgId = extractMessageId(response.data);
    return {
      sent: true,
      providerMessageId: msgId,
      verificationId: msgId,
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
   Generic SMS (transactional). Same /corporate endpoint.
   ========================================================================= */
export interface SmsSendInput {
  to: string;
  message: string;
  senderId?: string;
}

export async function sendSms(input: SmsSendInput): Promise<{ sent: boolean; providerMessageId?: string; status: string; error?: string }> {
  try {
    const params: Record<string, string> = {
      recipients: normalizePhone(input.to),
      message: input.message,
    };
    if (input.senderId) params.senderID = input.senderId;
    const response = await kudiRequest(params);
    const msgId = extractMessageId(response.data);
    return {
      sent: true,
      providerMessageId: msgId,
      status: response.status || "queued",
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
  return `Velo: Use ${otp} to ${purpose}. Valid for ${ttlMinutes} minute(s). Please keep this number private and never disclose it to anyone.`;
}

/* =========================================================================
   Webhook signature verification for Kudi inbound delivery webhooks.
   If a shared `KUDI_WEBHOOK_SECRET` is configured, the inbound request must
   carry it in the `X-Kudi-Signature` header (a constant-time-equal match).
   Without the shared secret the verifier passes through so the endpoint
   remains usable for OTP delivery only — but production deployments should
   set `KUDI_WEBHOOK_SECRET` to close this unauthenticated public endpoint.
   ========================================================================= */
export function verifyKudiSignature(signature: string | undefined, _rawBody: string): boolean {
  const secret = env.KUDI_WEBHOOK_SECRET;
  if (!secret) {
    // Soft-permit in dev/staging when the secret is not configured.
    return true;
  }
  if (!signature) return false;
  try {
    const a = Buffer.from(String(signature).trim());
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
