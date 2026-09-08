import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

async function kudiRequest<T>(path: string, params: Record<string, string>): Promise<T> {
  if (!env.KUDI_API_KEY) throw new Error("KUDI SMS is not configured");
  const url = new URL(`${env.KUDI_BASE_URL}${path}`);
  url.searchParams.set("token", env.KUDI_API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) url.searchParams.set(key, value);
  }
  const response = await fetch(url.toString());
  const data = await response.json() as T & { status?: string; message?: string };
  if (!response.ok) throw new Error(data.message || `KUDI request failed (${response.status})`);
  return data;
}

export interface SmsSendInput {
  to: string;
  message: string;
  senderId?: string;
}

export async function sendSms(input: SmsSendInput): Promise<{ sent: boolean; providerMessageId?: string; status: string; error?: string }> {
  try {
    const response = await kudiRequest<Record<string, unknown>>("/sms", {
      sender_id: input.senderId || env.KUDI_SENDER_ID || "Velo",
      message: input.message,
      recipient: input.to,
    });
    const ok = String((response as { status?: unknown }).status ?? "").toLowerCase() === "sent" ||
      String((response as { msg?: unknown }).msg ?? "").toLowerCase().includes("sent") ||
      Boolean((response as { message_id?: unknown }).message_id);
    return {
      sent: ok,
      providerMessageId: String((response as { message_id?: unknown }).message_id ?? ""),
      status: String((response as { status?: unknown }).status ?? "queued"),
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
