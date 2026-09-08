import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

async function premblyRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!env.PREMBLY_API_KEY || !env.PREMBLY_APP_ID) throw new Error("Prembly is not configured");
  const response = await fetch(`${env.PREMBLY_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "x-api-key": env.PREMBLY_API_KEY,
      "app-id": env.PREMBLY_APP_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json() as T & { status?: string; message?: string; detail?: string };
  if (!response.ok) throw new Error(data.message || data.detail || `Prembly request failed (${response.status})`);
  return data;
}

export interface BvnVerificationInput {
  bvn: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
}

export interface VerificationResult {
  status: "SUCCESS" | "FAILED" | "PENDING" | "MANUAL_REVIEW";
  providerReference?: string;
  matchScore?: number;
  matchedFields?: Record<string, boolean>;
  normalizedFields?: Record<string, unknown>;
  rawResponse: Record<string, unknown>;
  errorMessage?: string;
}

export async function verifyBvn(input: BvnVerificationInput): Promise<VerificationResult> {
  try {
    const response = await premblyRequest<Record<string, unknown>>(
      "/identitypass/data-verification/bvn/verification",
      { number: input.bvn, first_name: input.firstName, last_name: input.lastName, dob: input.dateOfBirth }
    );
    const status = String((response as { status?: unknown }).status ?? "").toLowerCase();
    const success = status === "success" || (response as { verification?: { status?: string } }).verification?.status === "verified";
    return {
      status: success ? "SUCCESS" : "MANUAL_REVIEW",
      providerReference: String((response as { reference?: unknown }).reference ?? `${Date.now()}`),
      matchedFields: {},
      normalizedFields: response,
      rawResponse: response,
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "BVN verification failed",
      rawResponse: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export interface NinVerificationInput {
  nin: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
}

export async function verifyNin(input: NinVerificationInput): Promise<VerificationResult> {
  try {
    const response = await premblyRequest<Record<string, unknown>>(
      "/identitypass/data-verification/nin/verification",
      { number: input.nin, first_name: input.firstName, last_name: input.lastName, dob: input.dateOfBirth }
    );
    const status = String((response as { status?: unknown }).status ?? "").toLowerCase();
    const success = status === "success" || (response as { verification?: { status?: string } }).verification?.status === "verified";
    return {
      status: success ? "SUCCESS" : "MANUAL_REVIEW",
      providerReference: String((response as { reference?: unknown }).reference ?? `${Date.now()}`),
      matchedFields: {},
      normalizedFields: response,
      rawResponse: response,
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "NIN verification failed",
      rawResponse: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function requestCreditReport(input: { userId: string; bvn?: string; nin?: string; phone?: string; fullName?: string }): Promise<{ status: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED"; providerReference?: string; score?: number; normalizedFields?: Record<string, unknown>; redactedRaw?: Record<string, unknown>; errorMessage?: string }> {
  if (!env.PREMBLY_API_KEY || !env.PREMBLY_APP_ID) {
    return { status: "NOT_REQUESTED", errorMessage: "Prembly credit bureau product is not configured" };
  }
  return { status: "PENDING", errorMessage: "Exact Prembly credit-bureau product is not yet confirmed; enable after Section 20 decisions." };
}

export function verifyPremblyWebhook(signature: string | undefined, rawBody: string): boolean {
  if (!signature) return false;
  if (env.PREMBLY_WEBHOOK_SECRET) {
    const expected = createHmac("sha256", env.PREMBLY_WEBHOOK_SECRET).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signature);
    if (expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf)) return true;
  }
  if (!env.PREMBLY_API_KEY) return false;
  const fallback = env.PREMBLY_API_KEY.slice(0, signature.length);
  const fallbackBuf = Buffer.from(fallback);
  const receivedBuf = Buffer.from(signature);
  if (fallbackBuf.length === receivedBuf.length && timingSafeEqual(fallbackBuf, receivedBuf)) return true;
  return !env.PREMBLY_WEBHOOK_SECRET && !env.PREMBLY_API_KEY;
}
