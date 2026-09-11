import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";

/* =========================================================================
   Prembly Provider — BVN Advance + NIN Advance (per official API docs)
   Base URL:   https://api.prembly.com
   Auth:       ONLY the `x-api-key` header — there is NO x-app-id header.
   Endpoints:
     BVN:  POST /verification/bvn       Body: { "number": "54651333604" }
     NIN:  POST /verification/vnin      Body: { "number_nin": "12345678901" }
     BVN face-match:  POST /verification/bvn_w_face
     NIN face-match:  POST /verification/nin_w_face
   Success: status === true && response_code === "00" && verification_status === "verified"
   Response: under `data` — firstName, middleName, lastName, phoneNumber1,
             phoneNumber2, dateOfBirth, residentialAddress, lgaOfOrigin,
             stateOfOrigin, gender, maritalStatus, nationality, title, nin,
             bvn, base64Image (the portrait photo from NIBSS / NIMC records)
   ========================================================================= */

const BASE = env.PREMBLY_BASE_URL.replace(/\/$/, "");
const TIMEOUT_MS = 15_000;

export type VerificationStatus = "SUCCESS" | "FAILED" | "PENDING" | "MANUAL_REVIEW";

export interface VerificationResult {
  status: VerificationStatus;
  matchScore?: number;
  errorMessage?: string;
  providerReference?: string;
  normalizedFields?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-api-key": env.PREMBLY_API_KEY ?? "",
  };
  return h;
}

async function premblyPost(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.PREMBLY_API_KEY) throw new Error("Prembly is not configured.");
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try { data = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch (_e) { data = { rawText: text }; }
  if (!res.ok) {
    const msg = String(((data as { message?: unknown; detail?: unknown }).message ?? (data as { detail?: unknown }).detail ?? text) || `HTTP ${res.status}`);
    throw new Error(`Prembly ${path} failed: ${msg.slice(0, 180)}`);
  }
  return data;
}

function responseRecord(response: Record<string, unknown>): Record<string, unknown> {
  const data = response.data;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : response;
}

function providerStatus(statusLike: unknown): VerificationStatus {
  const s = String(statusLike ?? "").toLowerCase();
  if (s.includes("verif") && !s.includes("not") && !s.includes("fail")) return "SUCCESS";
  if (s.includes("success") || s.includes("approved") || s.includes("pass")) return "SUCCESS";
  if (s.includes("fail") || s.includes("reject") || s.includes("denied")) return "FAILED";
  if (s.includes("pending") || s.includes("process") || s.includes("queued")) return "PENDING";
  if (s.includes("review") || s.includes("manual")) return "MANUAL_REVIEW";
  return "FAILED";
}

function successFromResponse(response: Record<string, unknown>): boolean {
  const topStatus = typeof response.status === "boolean" ? response.status : undefined;
  const topCode = String((response as { response_code?: unknown }).response_code ?? "");
  const vStatus = String((response as { verification_status?: unknown }).verification_status ?? "");
  const nestedVerif = (response as { verification?: Record<string, unknown> }).verification;
  const nestedStatus = nestedVerif && typeof nestedVerif === "object" ? String((nestedVerif as { status?: unknown }).status ?? "") : "";
  if (topStatus === false) return false;
  const ok =
    (topStatus === true || topCode === "00" || topCode === "0" || topCode === "200") &&
    (vStatus === "verified" || nestedStatus === "VERIFIED" || nestedStatus === "verified" || !vStatus && !nestedStatus);
  return ok;
}

function safeIdentityFields(response: Record<string, unknown>): Record<string, unknown> {
  const data = responseRecord(response);
  const keys = ["bvn", "nin", "firstName", "middleName", "lastName", "nameOnCard", "phoneNumber1", "phoneNumber2", "dateOfBirth", "email", "residentialAddress", "address", "stateOfOrigin", "stateOfResidence", "lgaOfOrigin", "lgaOfResidence", "lga", "state", "gender", "maritalStatus", "nationality", "title", "base64Image", "photo", "photograph", "image", "face_image", "selfie", "registrationDate", "enrollmentBank", "enrollmentBranch", "levelOfAccount", "watchListed", "watchListMessage"];
  const fields = Object.fromEntries(keys.filter((key) => {
    const val = data[key];
    if (typeof val === "string" && val.trim()) return true;
    if (typeof val === "boolean") return true;
    return false;
  }).map((key) => [key, data[key]]));
  if (!fields.full_name && !fields.fullName && (fields.firstName || fields.lastName)) {
    fields.full_name = [fields.title ? `${String(fields.title)} ` : "", fields.firstName, fields.middleName ? String(fields.middleName) + " " : "", fields.lastName].filter(Boolean).join(" ");
    fields.fullName = fields.full_name;
  }
  if (!fields.phone && (fields.phoneNumber1 || fields.phoneNumber2)) {
    fields.phone = (fields.phoneNumber1 as string | undefined) || (fields.phoneNumber2 as string | undefined) || "";
    fields.phone_number = fields.phone;
  }
  if (fields.dateOfBirth && !fields.dob) { fields.dob = fields.dateOfBirth; fields.date_of_birth = fields.dateOfBirth; }
  if (fields.residentialAddress && !fields.address) { fields.address = fields.residentialAddress; }
  if (fields.stateOfOrigin) { fields.state = fields.stateOfOrigin; }
  if (fields.lgaOfOrigin) { fields.lga = fields.lgaOfOrigin; }
  const photoCandidates = ["base64Image", "photo", "photograph", "image", "face_image", "selfie"];
  for (const key of photoCandidates) {
    if (typeof fields[key] === "string" && fields[key].length > 20) {
      fields.identityPhoto = fields[key] as string;
      break;
    }
  }
  return fields;
}

export interface BvnInput { number: string; firstName?: string; lastName?: string; dateOfBirth?: string; }
export interface NinInput { number: string; firstName?: string; lastName?: string; dateOfBirth?: string; }
export interface IdentityWithFaceInput { type: "BVN" | "NIN"; number: string; image: string; dateOfBirth?: string; }
export interface LivenessInput { imageBase64: string; mimeType?: string; }
export interface CreditReportInput {
  mode: "ID" | "BIO";
  number?: string;
  customer_name?: string;
  dob?: string;
  crb_provider?: "crc" | "first-central";
}

async function runIdScanIfConfigured(payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    if (!env.PREMBLY_ID_SCAN_PATH) return undefined;
    return await premblyPost(env.PREMBLY_ID_SCAN_PATH, payload);
  } catch (_e) { /* optional */ return undefined; }
}

export async function verifyBvn(input: BvnInput): Promise<VerificationResult> {
  try {
    const body: Record<string, unknown> = { number: input.number };
    const response = await premblyPost(env.PREMBLY_BVN_PATH, body);
    const idScan = await runIdScanIfConfigured({ mode: "bvn", id: input.number, ...body });
    const ok = successFromResponse(response);
    const normalized = safeIdentityFields(response);
    if (input.firstName && !normalized.firstName) normalized.firstName = input.firstName;
    if (input.lastName && !normalized.lastName) normalized.lastName = input.lastName;
    if (input.dateOfBirth && !normalized.dateOfBirth) normalized.dateOfBirth = input.dateOfBirth;
    return {
      status: ok ? "SUCCESS" : providerStatus((response as { verification_status?: unknown }).verification_status ?? (response as { verification?: Record<string, unknown> }).verification?.status),
      providerReference: (String((response as { transaction_id?: unknown }).transaction_id ?? (response as { reference_id?: unknown }).reference_id ?? (response as { verification?: Record<string, unknown> }).verification?.verification_id ?? "") || undefined),
      normalizedFields: normalized,
      errorMessage: ok ? undefined : String((response as { message?: unknown; detail?: unknown; msg?: unknown }).message ?? (response as { detail?: unknown }).detail ?? (response as { msg?: unknown }).msg ?? "BVN verification was not successful"),
      rawResponse: { bvn: response, idScan: idScan ?? undefined },
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "Unable to verify BVN at this time",
    };
  }
}

export async function verifyNin(input: NinInput): Promise<VerificationResult> {
  try {
    const body: Record<string, unknown> = { number_nin: input.number };
    const response = await premblyPost(env.PREMBLY_NIN_PATH, body);
    const idScan = await runIdScanIfConfigured({ mode: "nin", id: input.number, ...body });
    const ok = successFromResponse(response);
    const normalized = safeIdentityFields(response);
    if (input.firstName && !normalized.firstName) normalized.firstName = input.firstName;
    if (input.lastName && !normalized.lastName) normalized.lastName = input.lastName;
    if (input.dateOfBirth && !normalized.dateOfBirth) normalized.dateOfBirth = input.dateOfBirth;
    return {
      status: ok ? "SUCCESS" : providerStatus((response as { verification_status?: unknown }).verification_status ?? (response as { verification?: Record<string, unknown> }).verification?.status),
      providerReference: (String((response as { transaction_id?: unknown }).transaction_id ?? (response as { reference_id?: unknown }).reference_id ?? (response as { verification?: Record<string, unknown> }).verification?.verification_id ?? "") || undefined),
      normalizedFields: normalized,
      errorMessage: ok ? undefined : String((response as { message?: unknown; detail?: unknown; msg?: unknown }).message ?? (response as { detail?: unknown }).detail ?? (response as { msg?: unknown }).msg ?? "NIN verification was not successful"),
      rawResponse: { nin: response, idScan: idScan ?? undefined },
    };
  } catch (error) {
    return {
      status: "FAILED",
      errorMessage: error instanceof Error ? error.message : "Unable to verify NIN at this time",
    };
  }
}

export async function verifyIdentityWithFace(input: IdentityWithFaceInput): Promise<VerificationResult> {
  const path = input.type === "BVN" ? env.PREMBLY_BVN_FACE_PATH : env.PREMBLY_NIN_FACE_PATH;
  const body: Record<string, unknown> = input.type === "BVN"
    ? { number: input.number, image: input.image }
    : { number_nin: input.number, image: input.image };
  if (input.dateOfBirth) body.dateOfBirth = input.dateOfBirth;
  try {
    const response = await premblyPost(path, body);
    const ok = successFromResponse(response);
    const matchScoreRaw =
      (response as { verification?: Record<string, unknown> }).verification?.match_score ??
      (response as { matchScore?: unknown }).matchScore ??
      (response as { match_score?: unknown }).match_score ??
      (response as { data?: Record<string, unknown> }).data?.match_score;
    const matchScore = typeof matchScoreRaw === "number" ? matchScoreRaw : typeof matchScoreRaw === "string" ? Number(matchScoreRaw) : undefined;
    return {
      status: ok ? "SUCCESS" : providerStatus((response as { verification_status?: unknown }).verification_status),
      matchScore,
      normalizedFields: safeIdentityFields(response),
      providerReference: String((response as { transaction_id?: unknown }).transaction_id ?? (response as { reference_id?: unknown }).reference_id ?? "") || undefined,
      errorMessage: ok ? undefined : String((response as { message?: unknown; detail?: unknown }).message ?? (response as { detail?: unknown }).detail ?? "Face match did not pass"),
      rawResponse: response,
    };
  } catch (error) {
    return { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Face verification unavailable" };
  }
}

export async function verifyLiveness(image: string, _mimeType?: string): Promise<VerificationResult> {
  try {
    const response = await premblyPost(env.PREMBLY_FACE_LIVENESS_PATH, { image });
    const ok = successFromResponse(response);
    return {
      status: ok ? "SUCCESS" : providerStatus((response as { verification_status?: unknown }).verification_status),
      errorMessage: ok ? undefined : String((response as { message?: unknown }).message ?? "Liveness did not pass"),
      providerReference: String((response as { transaction_id?: unknown }).transaction_id ?? "") || undefined,
      rawResponse: response,
    };
  } catch (error) {
    return { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Liveness check unavailable" };
  }
}

export async function requestCreditReport(input: CreditReportInput): Promise<VerificationResult> {
  try {
    const provider: "crc" | "first-central" = input.crb_provider ?? "first-central";
    const body: Record<string, unknown> =
      input.mode === "ID"
        ? { number: input.number, mode: "ID", crb_provider: provider, ...(input.customer_name ? { customer_name: input.customer_name } : {}) }
        : { customer_name: input.customer_name, dob: input.dob, mode: "BIO", crb_provider: provider };
    const response = await premblyPost(env.PREMBLY_CREDIT_REPORT_PATH, body);
    const ok = successFromResponse(response);
    const data = responseRecord(response);
    const normalized: Record<string, unknown> = { ...response };
    const scoreKeys = ["score", "creditScore", "credit_score", "bureauScore", "riskScore", "risk_score"];
    for (const key of scoreKeys) {
      const top = (response as Record<string, unknown>)[key];
      const nested = (data as Record<string, unknown>)[key];
      if (typeof top === "number" || typeof nested === "number") {
        normalized.score = typeof top === "number" ? top : nested;
        break;
      }
    }
    return {
      status: ok ? "SUCCESS" : providerStatus((response as { verification_status?: unknown }).verification_status),
      errorMessage: ok ? undefined : String(((response as { message?: unknown; detail?: unknown }).message ?? (response as { detail?: unknown }).detail ?? "Credit bureau lookup failed") as unknown as string),
      normalizedFields: normalized,
      rawResponse: response,
      providerReference: (String(((response as { transaction_id?: unknown }).transaction_id ?? (response as { reference_id?: unknown }).reference_id ?? "") as unknown as string) || undefined),
    };
  } catch (error) {
    return { status: "FAILED", errorMessage: error instanceof Error ? error.message : "Credit report unavailable" };
  }
}

export function verifyPremblyWebhook(signature: string | undefined, rawBody: string): boolean {
  if (!signature) return false;
  if (!env.PREMBLY_WEBHOOK_SECRET) return true;
  const expected = createHmac("sha512", env.PREMBLY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  return false;
}
