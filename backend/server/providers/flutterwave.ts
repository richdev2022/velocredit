import { env } from "../config.js";

async function flutterwaveRequest<T>(path: string, body: Record<string, unknown>): Promise<T> {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetch(`${env.FLUTTERWAVE_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as T & { status?: string; message?: string };
  if (!response.ok) throw new Error(data.message || `Flutterwave request failed (${response.status})`);
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

export async function verifyTransaction(transactionId: string) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetch(
    `${env.FLUTTERWAVE_BASE_URL}/transactions/${encodeURIComponent(transactionId)}/verify`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const data = (await response.json()) as {
    status?: string;
    data?: Record<string, unknown>;
    message?: string;
  };
  if (!response.ok) throw new Error(data.message || `Flutterwave verification failed (${response.status})`);
  return data;
}

export async function resolveBankAccount(accountNumber: string, bankCode: string) {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetch(
    `${env.FLUTTERWAVE_BASE_URL}/accounts/resolve?account_number=${encodeURIComponent(
      accountNumber
    )}&account_bank=${encodeURIComponent(bankCode)}`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const data = (await response.json()) as {
    status?: string;
    data?: { account_name?: string; account_number?: string };
    message?: string;
  };
  if (!response.ok) throw new Error(data.message || `Account resolution failed (${response.status})`);
  return data;
}

export async function listBanks(country = "NG") {
  if (!env.FLUTTERWAVE_SECRET_KEY) throw new Error("Flutterwave is not configured");
  const response = await fetch(
    `${env.FLUTTERWAVE_BASE_URL}/banks/${encodeURIComponent(country)}`,
    { headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}` } }
  );
  const data = (await response.json()) as {
    status?: string;
    data?: Array<{ id?: number; name?: string; code?: string; is_nuban_bank?: boolean }>;
    message?: string;
  };
  if (!response.ok) throw new Error(data.message || `Could not load banks (${response.status})`);
  return data;
}
