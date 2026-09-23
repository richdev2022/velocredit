import { env } from "../config.js";

// Carries everything Flutterwave returned when a call fails, so callers (e.g.
// loan disbursement) can persist the raw provider response and the admin UI
// can show the REAL reason a transfer failed instead of a bare message.
export class FlutterwaveError extends Error {
  readonly providerResponse: Record<string, unknown>;
  readonly httpStatus: number;
  constructor(message: string, httpStatus: number, providerResponse: unknown) {
    super(message);
    this.name = "FlutterwaveError";
    this.httpStatus = httpStatus;
    this.providerResponse =
      providerResponse && typeof providerResponse === "object"
        ? (providerResponse as Record<string, unknown>)
        : { raw: String(providerResponse ?? "") };
  }
}

async function flutterwaveRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${env.FLUTTERWAVE_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Flutterwave request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let data: (T & { status?: string; message?: string; code?: string }) | null = null;
  try {
    data = JSON.parse(text) as T & { status?: string; message?: string; code?: string };
  } catch (_error) {
    if (!response.ok) throw new FlutterwaveError(`Flutterwave request failed (${response.status}): ${text.slice(0, 200) || response.statusText}`, response.status, { raw: text.slice(0, 2000) || response.statusText });
    throw new FlutterwaveError("Flutterwave returned an invalid response", response.status, { raw: text.slice(0, 2000) });
  }
  if (!response.ok) {
    throw new FlutterwaveError(data?.message || `Flutterwave request failed (${response.status})`, response.status, data);
  }
  return data;
}

export function initializeRepayment(input: {
  txRef: string;
  amountNaira: number;
  email: string;
  phone: string;
  name: string;
  redirectUrl: string;
}) {
  return flutterwaveRequest<{
    status: string;
    data?: { link?: string };
    message?: string;
  }>("/payments", {
    tx_ref: input.txRef,
    amount: input.amountNaira,
    currency: "NGN",
    redirect_url: input.redirectUrl,
    customer: { email: input.email, phonenumber: input.phone, name: input.name },
    customizations: {
      title: "Velo Finance loan repayment",
      description: "Loan repayment",
    },
    payment_options: "card,banktransfer,ussd,account",
  });
}

export function initializeWalletFunding(input: {
  txRef: string;
  amountNaira: number;
  email: string;
  phone: string;
  name: string;
  redirectUrl: string;
}) {
  return flutterwaveRequest<{
    status: string;
    data?: { link?: string };
    message?: string;
  }>("/payments", {
    tx_ref: input.txRef,
    amount: input.amountNaira,
    currency: "NGN",
    redirect_url: input.redirectUrl,
    customer: { email: input.email, phonenumber: input.phone, name: input.name },
    customizations: {
      title: "Velo Finance wallet funding",
      description: "Fund your Velo investor wallet",
    },
    payment_options: "card,banktransfer,ussd,account",
  });
}

export function createInvestorPayout(input: {
  txRef: string;
  amountNaira: number;
  accountNumber: string;
  accountBank: string;
  beneficiaryName: string;
  narration: string;
}) {
  return flutterwaveRequest<{
    status: string;
    data?: { id?: number; reference?: string };
    message?: string;
  }>("/transfers", {
    account_bank: input.accountBank,
    account_number: input.accountNumber,
    amount: input.amountNaira,
    currency: "NGN",
    reference: input.txRef,
    beneficiary_name: input.beneficiaryName,
    narration: input.narration,
    debit_currency: "NGN",
  });
}

export function createLoanDisbursement(input: {
  txRef: string;
  amountNaira: number;
  accountNumber: string;
  accountBank: string;
  beneficiaryName: string;
  narration: string;
}) {
  return flutterwaveRequest<{
    status: string;
    data?: { id?: number; reference?: string };
    message?: string;
  }>("/transfers", {
    account_bank: input.accountBank,
    account_number: input.accountNumber,
    amount: input.amountNaira,
    currency: "NGN",
    reference: input.txRef,
    beneficiary_name: input.beneficiaryName,
    narration: input.narration,
    debit_currency: "NGN",
  });
}

const PROVIDER_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetch(path, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("Flutterwave request timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyTransaction(transactionId: string) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetchWithTimeout(
    `${env.FLUTTERWAVE_BASE_URL}/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const text = await response.text();
  let data: { status?: string; data?: Record<string, unknown>; message?: string };
  try {
    data = JSON.parse(text) as { status?: string; data?: Record<string, unknown>; message?: string };
  } catch (_error) {
    throw new Error(`Flutterwave verification failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  }
  if (!response.ok) throw new Error(data.message || `Flutterwave verification failed (${response.status})`);
  return data;
}

// Verifies a payment by its MERCHANT tx_ref instead of the provider transaction
// id. Used by the wallet-deposit reconciliation sweep: deposits whose redirect
// verification or webhook was missed stay PENDING forever because nobody kept
// the provider transaction id — the tx_ref is always known.
export async function verifyTransactionByReference(txRef: string) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetchWithTimeout(
    `${env.FLUTTERWAVE_BASE_URL}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const text = await response.text();
  let data: { status?: string; data?: Record<string, unknown>; message?: string };
  try {
    data = JSON.parse(text) as { status?: string; data?: Record<string, unknown>; message?: string };
  } catch (_error) {
    throw new Error(`Flutterwave verification failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  }
  if (!response.ok) throw new Error(data.message || `Flutterwave verification failed (${response.status})`);
  return data;
}

export async function verifyTransfer(transferIdOrReference: string, byReference = false) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const path = byReference
    ? `${env.FLUTTERWAVE_BASE_URL}/transfers/reference/${encodeURIComponent(transferIdOrReference)}`
    : `${env.FLUTTERWAVE_BASE_URL}/transfers/${encodeURIComponent(transferIdOrReference)}`;
  const response = await fetchWithTimeout(path, {
    headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` },
  });
  const text = await response.text();
  let data: { status?: string; data?: Record<string, unknown>; message?: string };
  try {
    data = JSON.parse(text) as { status?: string; data?: Record<string, unknown>; message?: string };
  } catch (_error) {
    throw new Error(`Flutterwave transfer verification failed (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  }
  if (!response.ok) throw new Error(data.message || `Flutterwave transfer verification failed (${response.status})`);
  return data;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyTransactionWithRetry(
  transactionId: string,
  maxAttempts = 3,
  backoffMs = 2000
): Promise<{ status: string; data?: Record<string, unknown>; settled: boolean }> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await verifyTransaction(transactionId);
      const fwData = (result.data ?? {}) as Record<string, unknown>;
      const status = String(fwData.status ?? result.status ?? "").toLowerCase();
      const currency = String(fwData.currency ?? "NGN").toUpperCase();
      const amount = Number(fwData.amount ?? 0);
      const settled =
        (status === "successful" || status === "success") &&
        currency === "NGN" &&
        amount > 0;
      if (settled || status === "failed" || attempt === maxAttempts) {
        return { status, data: fwData, settled };
      }
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts) await sleep(backoffMs * attempt);
  }
  return { status: "unknown", settled: false };
}

export async function verifyTransferWithRetry(
  transferId: string,
  reference = "",
  maxAttempts = 3,
  backoffMs = 3000,
  expectedAmountNaira?: number
): Promise<{ status: string; data?: Record<string, unknown>; settled: boolean; raw: unknown }> {
  let lastError: unknown = null;
  let lastRaw: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const byId = transferId ? await verifyTransfer(transferId, false) : null;
      const byRef = reference && !byId ? await verifyTransfer(reference, true) : byId;
      const result = byId ?? byRef;
      lastRaw = result;
      const fwData = (result?.data ?? {}) as Record<string, unknown>;
      const status = String(fwData.status ?? result?.status ?? "").toLowerCase();
      const currency = String(fwData.currency ?? "NGN").toUpperCase();
      const amountMatches = expectedAmountNaira === undefined || Number(fwData.amount ?? 0) === expectedAmountNaira;
      const settled =
        (status === "successful" || status === "success") && currency === "NGN" && amountMatches;
      const terminal = settled || status === "failed" || attempt === maxAttempts;
      if (terminal) {
        return { status, data: fwData, settled, raw: result };
      }
    } catch (err) {
      lastError = err;
      lastRaw = err;
    }
    if (attempt < maxAttempts) await sleep(backoffMs * attempt);
  }
  return { status: lastError instanceof Error ? "error" : "pending", settled: false, raw: lastRaw };
}

// Polls a transfer until Flutterwave reports a TERMINAL status (successful /
// failed / reversed) or the time budget runs out. Used by the loan disbursement
// route so the admin's click can WAIT for the provider's real final answer
// instead of receiving an optimistic "submitted and being processed" response.
export async function pollTransferUntilTerminal(
  transferId: string,
  reference: string,
  expectedAmountNaira?: number,
  opts: { budgetMs?: number; intervalMs?: number } = {}
): Promise<{ status: string; data?: Record<string, unknown>; settled: boolean; failed: boolean; timedOut: boolean; raw: unknown }> {
  const budgetMs = opts.budgetMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + budgetMs;
  let lastRaw: unknown = null;
  let lastStatus = "";
  while (Date.now() < deadline) {
    try {
      const byId = transferId ? await verifyTransfer(transferId, false) : null;
      const byRef = reference && !byId ? await verifyTransfer(reference, true) : byId;
      const result = byId ?? byRef;
      lastRaw = result;
      const fwData = (result?.data ?? {}) as Record<string, unknown>;
      const status = String(fwData.status ?? result?.status ?? "").toLowerCase();
      lastStatus = status;
      const currency = String(fwData.currency ?? "NGN").toUpperCase();
      const amountMatches = expectedAmountNaira === undefined || Number(fwData.amount ?? 0) === expectedAmountNaira;
      if ((status === "successful" || status === "success") && currency === "NGN" && amountMatches) {
        return { status, data: fwData, settled: true, failed: false, timedOut: false, raw: result };
      }
      if (["failed", "reversed", "reverted", "cancelled", "canceled"].includes(status)) {
        return { status, data: fwData, settled: false, failed: true, timedOut: false, raw: result };
      }
    } catch (_error) {
      // Transient verification hiccup — keep polling until the deadline.
    }
    await sleep(Math.max(500, Math.min(intervalMs, deadline - Date.now())));
  }
  const lastData = (lastRaw as { data?: Record<string, unknown> } | null)?.data;
  return { status: lastStatus || "pending", data: lastData, settled: false, failed: false, timedOut: true, raw: lastRaw };
}

// Throws FlutterwaveError (carrying httpStatus + the raw provider payload) so
// callers can distinguish a DEFINITIVE account rejection (4xx — the same
// resolution runs inside transfer creation, so the transfer would fail too)
// from a transient/infrastructure failure (5xx, network, timeout).
// bankName (when known) lets an unrecognized legacy bank code be re-mapped onto
// Flutterwave's live list before the call instead of failing with
// "Unknown Bank Code".
export async function resolveBankAccount(accountNumber: string, bankCode: string, bankName?: string) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const effectiveBankCode = await normalizeBankCodeForFlutterwave(bankCode, bankName);
  const response = await fetchWithTimeout(`${env.FLUTTERWAVE_BASE_URL}/accounts/resolve`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ account_number: accountNumber, account_bank: effectiveBankCode }),
  });
  const text = await response.text();
  let data: { status?: string; data?: { account_name?: string; account_number?: string }; message?: string; code?: string };
  try {
    data = JSON.parse(text) as { status?: string; data?: { account_name?: string; account_number?: string }; message?: string; code?: string };
  } catch (_error) {
    throw new FlutterwaveError(`Account resolution failed (${response.status}): ${text.slice(0, 200) || response.statusText}`, response.status, { raw: text.slice(0, 2000) || response.statusText });
  }
  if (!response.ok) throw new FlutterwaveError(data.message || `Account resolution failed (${response.status})`, response.status, data);
  if (String(data.status || "").toLowerCase() === "error") throw new FlutterwaveError(data.message || "Flutterwave could not resolve this account", response.status || 400, data);
  return data;
}

// ---------------------------------------------------------------------------
// Bank-code normalization
// ---------------------------------------------------------------------------
// Some accounts were saved with codes from OTHER providers' conventions (e.g.
// Paystack-style "999992" for OPay). Flutterwave rejects those with
// "Unknown Bank Code" during account resolution AND transfer creation, which
// used to brick loan disbursements. Fix: keep Flutterwave's live bank list
// cached, and when an incoming code is not recognized, re-derive the correct
// Flutterwave code by matching the BANK NAME against the live list (with a
// static alias table for legacy codes that carries no name).

export type FlutterwaveBank = { id?: number; code: string; name: string; is_nuban_bank?: boolean };

let banksCache: { at: number; banks: FlutterwaveBank[] } | null = null;
const BANKS_CACHE_TTL_MS = 10 * 60_000;

export async function getFlutterwaveBanksCached(force = false): Promise<FlutterwaveBank[]> {
  if (!force && banksCache && Date.now() - banksCache.at < BANKS_CACHE_TTL_MS) return banksCache.banks;
  const result = await listBanks("NG");
  const banks = Array.isArray(result.data)
    ? result.data
        .filter((b) => b && b.code && b.name)
        .map((b) => ({ id: b.id, code: String(b.code).trim(), name: String(b.name).trim(), is_nuban_bank: b.is_nuban_bank ?? true }))
    : [];
  if (banks.length > 0) banksCache = { at: Date.now(), banks };
  return banks.length > 0 ? banks : banksCache?.banks ?? [];
}

// Legacy / third-party-provider codes -> canonical bank names, so a code-only
// record can still be mapped onto Flutterwave's list by name.
const LEGACY_BANK_CODE_ALIASES: Record<string, string> = {
  "999992": "opay",
  "999991": "palmpay",
  "999990": "moniepoint",
  "50515": "moniepoint",
  "50211": "kuda",
  "100004": "opay",
  "090110": "kuda",
};

function normalizeBankNameForMatchLocal(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(plc|ltd|limited|ng|nigeria|nigerian|microfinance|mfb|digital|bank|banks|services)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findBankByName(banks: FlutterwaveBank[], bankName?: string): FlutterwaveBank | null {
  const target = normalizeBankNameForMatchLocal(bankName ?? "");
  if (!target) return null;
  // 1) exact normalized match, 2) containment either way (shortest first so
  // "opay" wins over "opay business" style variants deterministically).
  const sorted = banks.slice().sort((a, b) => a.name.length - b.name.length);
  for (const bank of sorted) {
    if (normalizeBankNameForMatchLocal(bank.name) === target) return bank;
  }
  for (const bank of sorted) {
    const candidate = normalizeBankNameForMatchLocal(bank.name);
    if (candidate && (candidate.includes(target) || target.includes(candidate))) return bank;
  }
  return null;
}

export function isKnownFlutterwaveBankCode(code: string, banks: FlutterwaveBank[]): boolean {
  const normalized = String(code || "").trim();
  if (!normalized) return false;
  return banks.some((b) => b.code === normalized);
}

/**
 * Resolve the bank code Flutterwave will actually accept.
 * Order: code already valid on the live list -> alias code -> bank name on the
 * live list -> legacy alias name matched on the live list. Falls back to the
 * original code when nothing matches (the provider then reports its own error).
 */
export async function normalizeBankCodeForFlutterwave(bankCode: string, bankName?: string): Promise<string> {
  const original = String(bankCode || "").trim();
  if (!original) return original;
  let banks: FlutterwaveBank[] = [];
  try {
    banks = await getFlutterwaveBanksCached();
  } catch (_error) {
    return original; // provider unreachable — keep the code, caller proceeds/warns
  }
  if (banks.length === 0) return original;
  if (isKnownFlutterwaveBankCode(original, banks)) return original;

  // The code is NOT on Flutterwave's list. Try the stored bank name first,
  // then the name implied by a legacy alias table.
  const aliasName = LEGACY_BANK_CODE_ALIASES[original];
  const candidates = [bankName, aliasName].filter(Boolean) as string[];
  for (const candidateName of candidates) {
    const match = findBankByName(banks, candidateName);
    if (match?.code) return match.code;
  }
  return original;
}

export async function listBanks(country = "NG") {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetchWithTimeout(
    `${env.FLUTTERWAVE_BASE_URL}/banks/${encodeURIComponent(country)}`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const text = await response.text();
  let data: {
    status?: string;
    data?: Array<{ id?: number; name?: string; code?: string; is_nuban_bank?: boolean }>;
    message?: string;
  };
  try {
    data = JSON.parse(text) as {
      status?: string;
      data?: Array<{ id?: number; name?: string; code?: string; is_nuban_bank?: boolean }>;
      message?: string;
    };
  } catch (_error) {
    throw new Error(`Could not load banks (${response.status}): ${text.slice(0, 200) || response.statusText}`);
  }
  if (!response.ok) throw new Error(data.message || `Could not load banks (${response.status})`);
  return data;
}
