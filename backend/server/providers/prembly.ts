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
    signal: AbortSignal.timeout(15_000),
  });
  const data = await response.json().catch(() => ({})) as T & { status?: string; message?: string; detail?: string };
  if (!response.ok) throw new Error(data.message || data.detail || `Prembly request failed (${response.status})`);
  return data;
}

function responseRecord(response: Record<string, unknown>): Record<string, unknown> {
  const data = response.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : response;
}

function providerStatus(response: Record<string, unknown>): VerificationResult["status"] {
  const data = responseRecord(response);
  const verification = data.verification;
  const verificationStatus = verification && typeof verification === "object" ? (verification as Record<string, unknown>).status : undefined;
  const raw = String(data.status ?? response.status ?? data.verification_status ?? verificationStatus ?? "").toLowerCase();
  if (["success", "successful", "verified", "approved", "complete", "completed", "true"].includes(raw) || response.success === true || response.status === true || data.status === true) return "SUCCESS";
  if (["failed", "failure", "rejected", "declined", "error"].includes(raw)) return "FAILED";
  if (["pending", "processing", "queued", "in_progress"].includes(raw)) return "PENDING";
  return "MANUAL_REVIEW";
}

function providerReference(response: Record<string, unknown>): string | undefined {
  const data = responseRecord(response);
  const value = data.reference ?? data.request_id ?? data.requestId ?? data.transaction_id ?? response.reference;
  return value == null ? undefined : String(value);
}

function numericField(response: Record<string, unknown>, keys: string[]): number | undefined {
  const data = responseRecord(response);
  for (const key of keys) {
    const value = data[key] ?? response[key];
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return undefined;
}

function redactSensitive(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/bvn|nin|password|token|secret|account.?number/i.test(key)) continue;
    result[key] = entry && typeof entry === "object" ? redactSensitive(entry) : entry;
  }
  return result;
}

function safeIdentityFields(response: Record<string, unknown>): Record<string, unknown> {
  const data = responseRecord(response);
  const keys = ["full_name", "fullName", "name", "first_name", "firstName", "firstname", "last_name", "lastName", "surname", "phone_number", "phoneNumber", "phone", "mobile", "telephoneno", "date_of_birth", "dateOfBirth", "birthdate", "dob", "address", "residence_address", "state", "lga"];
  const fields = Object.fromEntries(keys.filter((key) => typeof data[key] === "string" && String(data[key]).trim()).map((key) => [key, data[key]]));
  if (!fields.full_name && !fields.fullName && (fields.first_name || fields.last_name)) {
    fields.full_name = [fields.first_name, fields.last_name].filter(Boolean).join(" ");
  }
  return fields;
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

async function runIdScan(type: "BVN" | "NIN", number: string): Promise<Record<string, unknown>> {
  return premblyRequest<Record<string, unknown>>(env.PREMBLY_ID_SCAN_PATH, {
    id_type: type.toLowerCase(),
    id_number: number,
    search_mode: "exact",
  });
}

export async function verifyBvn(input: BvnVerificationInput): Promise<VerificationResult> {
  try {
    const response = await premblyRequest<Record<string, unknown>>(
      env.PREMBLY_BVN_PATH,
      { number: input.bvn }
    );
    const idScan = await runIdScan("BVN", input.bvn);
    const status = providerStatus(response);
    const scanStatus = providerStatus(idScan);
    return {
      status: status === "SUCCESS" && scanStatus === "SUCCESS" ? "SUCCESS" : status === "PENDING" || scanStatus === "PENDING" ? "PENDING" : "FAILED",
      providerReference: providerReference(response) ?? `${Date.now()}`,
      matchScore: numericField(response, ["match_score", "matchScore", "confidence"]),
      matchedFields: {},
      normalizedFields: safeIdentityFields(response),
      rawResponse: { identity: response, idScan },
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
      env.PREMBLY_NIN_PATH,
      { number: input.nin }
    );
    const idScan = await runIdScan("NIN", input.nin);
    const status = providerStatus(response);
    const scanStatus = providerStatus(idScan);
    return {
      status: status === "SUCCESS" && scanStatus === "SUCCESS" ? "SUCCESS" : status === "PENDING" || scanStatus === "PENDING" ? "PENDING" : "FAILED",
      providerReference: providerReference(response) ?? `${Date.now()}`,
      matchScore: numericField(response, ["match_score", "matchScore", "confidence"]),
      matchedFields: {},
      normalizedFields: safeIdentityFields(response),
      rawResponse: { identity: response, idScan },
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "NIN verification failed",
      rawResponse: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function verifyIdentityWithFace(input: { type: "BVN" | "NIN"; number: string; image: string; dateOfBirth?: string }): Promise<VerificationResult> {
  try {
    const response = await premblyRequest<Record<string, unknown>>(
      input.type === "BVN" ? env.PREMBLY_BVN_FACE_PATH : env.PREMBLY_NIN_FACE_PATH,
      input.type === "BVN"
        ? { number: input.number, image: input.image }
        : { number_nin: Number(input.number), image: input.image, date_of_birth: input.dateOfBirth }
    );
    const data = responseRecord(response);
    const faceData = data.face_data && typeof data.face_data === "object" ? data.face_data as Record<string, unknown> : undefined;
    const matched = response.status === true && (faceData?.status === undefined || faceData.status === true);
    return {
      status: matched ? "SUCCESS" : "FAILED",
      providerReference: providerReference(response) ?? `${Date.now()}`,
      matchScore: numericField(response, ["confidence_in_percentage", "confidence"]) ?? numericField(faceData ?? {}, ["confidence"]),
      normalizedFields: safeIdentityFields(response),
      rawResponse: redactSensitive(response),
      errorMessage: matched ? undefined : String(response.detail ?? response.message ?? "Prembly face verification failed"),
    };
  } catch (error) {
    return { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Face verification failed", rawResponse: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export async function verifyLiveness(image: Buffer, mimeType: string): Promise<VerificationResult> {
  try {
    const response = await premblyRequest<Record<string, unknown>>(env.PREMBLY_FACE_LIVENESS_PATH, { image: image.toString("base64") });
    const status = providerStatus(response);
    return {
      status,
      providerReference: providerReference(response) ?? `${Date.now()}`,
      rawResponse: redactSensitive(response),
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "Liveness verification failed",
      rawResponse: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export async function requestCreditReport(input: { userId: string; bvn?: string; nin?: string; phone?: string; fullName?: string; dateOfBirth?: string }): Promise<{ status: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED"; providerReference?: string; score?: number; normalizedFields?: Record<string, unknown>; redactedRaw?: Record<string, unknown>; errorMessage?: string }> {
  if (!env.PREMBLY_API_KEY || !env.PREMBLY_APP_ID) {
    return { status: "NOT_REQUESTED", errorMessage: "Prembly credit bureau product is not configured" };
  }
  if (!env.PREMBLY_CREDIT_REPORT_PATH) {
    return { status: "NOT_REQUESTED", errorMessage: "PREMBLY_CREDIT_REPORT_PATH is not configured for the selected bureau product." };
  }
  try {
    const response = await premblyRequest<Record<string, unknown>>(env.PREMBLY_CREDIT_REPORT_PATH, {
      mode: input.bvn ? "ID" : "BIO",
      number: input.bvn,
      customer_name: input.fullName,
      customer_reference: input.userId,
      dob: input.dateOfBirth,
      crb_provider: "crc",
    });
    const status = providerStatus(response);
    const data = responseRecord(response);
    const scoreData = data.score && typeof data.score === "object" ? data.score as Record<string, unknown> : {};
    const score = numericField(response, ["credit_score", "creditScore", "score", "bureau_score", "bureauScore"]) ?? numericField(scoreData, ["totalConsumerScore", "credit_score", "score"]);
    return {
      status: status === "SUCCESS" && score !== undefined ? "RECEIVED" : status === "PENDING" ? "PENDING" : status === "FAILED" ? "FAILED" : "NOT_REQUESTED",
      providerReference: providerReference(response),
      score,
      normalizedFields: responseRecord(response),
      redactedRaw: redactSensitive(response),
    };
  } catch (error) {
    return { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Prembly credit report failed" };
  }
}

export function verifyPremblyWebhook(signature: string | undefined, rawBody: string): boolean {
  if (!signature) return false;
  if (!env.PREMBLY_WEBHOOK_SECRET) return false;
  const provided = signature.replace(/^sha256=/i, "");
  const expected = createHmac("sha256", env.PREMBLY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const receivedBuf = Buffer.from(provided, "hex");
  return expectedBuf.length === receivedBuf.length && timingSafeEqual(expectedBuf, receivedBuf);
}
