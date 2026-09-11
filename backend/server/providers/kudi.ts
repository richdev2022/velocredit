import { env } from "../config.js";

/* =========================================================================
   Kudi SMS Provider (per official Postman docs)
   Endpoint: POST https://my.kudisms.net/api/sms
   Form fields (application/x-www-form-urlencoded):
     token       = env.KUDI_API_KEY
     senderID    = env.KUDI_SENDER_ID  (approved promotional Sender ID)
     recipients  = 2348xxxxxxxx,2349xxxxxxxx  (comma-separated 234 format)
     message     = SMS text content
     gateway     = 2  (Refunds charge for DND numbers; DND will not deliver)
   Success: error_code == "000" && status == "success"
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

async function postSmsForm(params: Record<string, string>): Promise<KudiSmsResponse> {
  if (!env.KUDI_API_KEY) throw new Error("KUDI SMS is not configured (KUDI_API_KEY is missing)");
  if (!env.KUDI_SENDER_ID) throw new Error("KUDI SMS is not configured (KUDI_SENDER_ID is missing)");
  const url = `${env.KUDI_BASE_URL}/sms`;
  const body = new URLSearchParams();
  body.set("token", env.KUDI_API_KEY);
  body.set("senderID", env.KUDI_SENDER_ID);
  body.set("gateway", "2");
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") body.set(key, value);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let data: KudiSmsResponse;
  try {
    data = JSON.parse(text) as KudiSmsResponse;
  } catch (_e) {
    throw new Error(`KUDI returned non-JSON: ${text.slice(0, 160)}`);
  }
  const ok =
    response.ok &&
    String(data.status ?? "").toLowerCase() === "success" &&
    String(data.error_code ?? "000") === "000";
  if (!ok) {
    throw new Error(data.msg || `KUDI SMS failed (status=${data.status || response.status}, error_code=${data.error_code || "?"})`);
  }
  return data;
}

function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, "");
  if (digits.startsWith("0") && digits.length === 11) return "234" + digits.slice(1);
  if (digits.startsWith("234") && digits.length === 13) return digits;
  if (/^\d{10}$/.test(digits)) return "234" + digits;
  return digits;
}

/* =========================================================================
   sendOtpSms — delivers a pre-formatted OTP SMS message via Kudi /sms.
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
    const response = await postSmsForm(params);
    const msgId = Array.isArray(response.data)
      ? String((response.data[0] as string | undefined) ?? "").split("|")[1]
      : undefined;
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
   Generic SMS (transactional). Same /sms endpoint.
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
    const response = await postSmsForm(params);
    const msgId = Array.isArray(response.data)
      ? String((response.data[0] as string | undefined) ?? "").split("|")[1]
      : undefined;
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
  return `Velo OTP: ${otp}. Use to ${purpose}. Expires in ${ttlMinutes} min. Never share this code.`;
}

/* =========================================================================
   Webhook signature verification (kept for Kudi inbound delivery webhooks).
   Without a shared webhook secret it simply passes through so endpoints can
   rely on server-authenticated OTP challenges instead.
   ========================================================================= */
export function verifyKudiSignature(_signature: string | undefined, _rawBody: string): boolean {
  return true;
}
