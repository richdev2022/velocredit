const fs = require('fs');
let content = fs.readFileSync('frontend/src/services/adminApi.ts', 'utf8');

const additions = `
export interface PlatformSettingsResponse {
  ok: true;
  settings: {
    id: string;
    investorWithdrawalFeePercent: number;
    investorWithdrawalFeeFlatMinor: number;
    investorEarningRateOverrides: Record<string, number>;
    defaultInvestmentAnnualRatePercent: number;
    updatedAt: string;
    createdAt: string;
  };
  adminLedgerBalanceMinor: number;
  adminLedgerBalanceNaira: number;
}

export interface AdminLedgerEntry {
  id: string;
  entryType: "INVESTOR_FUNDING" | "INVESTMENT_PAYOUT" | "INVESTMENT_RETURN_CREDIT" | "WITHDRAWAL_FEE" | "PLATFORM_EARNING" | "MANUAL_ADJUSTMENT" | "REVERSAL";
  referenceId?: string;
  investorId?: string;
  amountMinor: number;
  direction: "DEBIT" | "CREDIT";
  balanceAfterMinor: number;
  currency: "NGN";
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AdminLedgerResponse {
  ok: true;
  balanceMinor: number;
  balanceNaira: number;
  totalEntries: number;
  entries: AdminLedgerEntry[];
  limit: number;
  offset: number;
}

export async function adminGetPlatformSettings(): Promise<PlatformSettingsResponse> {
  return request<PlatformSettingsResponse>("/api/v1/admin/settings/platform");
}

export async function adminUpdatePlatformSettings(input: {
  investorWithdrawalFeePercent?: number;
  investorWithdrawalFeeFlatMinor?: number;
  investorWithdrawalFeeFlatNaira?: number;
  defaultInvestmentAnnualRatePercent?: number;
}): Promise<{ ok: true; settings: PlatformSettingsResponse["settings"] }> {
  return request("/api/v1/admin/settings/platform", { method: "PUT", body: JSON.stringify(input) });
}

export async function adminSetInvestorEarningRate(investorId: string, annualRatePercent: number): Promise<{
  ok: true;
  investor: { id: string; fullName: string; email: string; earningRatePercent: number };
  settings: PlatformSettingsResponse["settings"];
}> {
  return request(\`/api/v1/admin/investors/\${encodeURIComponent(investorId)}/earning-rate\`, {
    method: "PUT",
    body: JSON.stringify({ annualRatePercent }),
  });
}

export async function adminCreditInvestorWallet(investorId: string, input: {
  amountNaira: number;
  description?: string;
  reason?: "MANUAL_CREDIT" | "INVESTMENT_RETURN" | "BONUS" | "CORRECTION";
}): Promise<{
  ok: true;
  walletBalanceMinor: number;
  walletBalanceNaira: number;
  transactionId: string;
}> {
  return request(\`/api/v1/admin/investors/\${encodeURIComponent(investorId)}/credit-wallet\`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function adminGetLedger(opts: { limit?: number; offset?: number; entryType?: string } = {}): Promise<AdminLedgerResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.entryType) params.set("entryType", opts.entryType);
  return request<AdminLedgerResponse>(\`/api/v1/admin/ledger?\${params.toString()}\`);
}

export async function adminListInvestors(opts: { limit?: number; offset?: number } = {}): Promise<{
  ok: true;
  total: number;
  investors: Array<{ id: string; email: string; fullName: string; phone: string; role: string; status: string; createdAt: string; }>;
}> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  return request(\`/api/v1/admin/investors?\${params.toString()}\`);
}

export interface InvestorWithdrawal {
  id: string;
  investorId: string;
  amountNaira: number;
  feeNaira: number;
  netNaira: number;
  currency: "NGN";
  bankCode: string;
  bankName: string;
  accountNumber: string;
  accountName: string;
  status: "PENDING_APPROVAL" | "PROCESSING" | "SUCCESSFUL" | "FAILED" | "REJECTED" | "CANCELLED";
  narration?: string;
  providerTransfer?: Record<string, unknown>;
  providerReference?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
}

export async function adminListWithdrawals(opts: { investorId?: string; status?: string; limit?: number; offset?: number } = {}): Promise<{
  ok: true;
  total: number;
  withdrawals: InvestorWithdrawal[];
}> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const basePath = opts.investorId
    ? \`/api/v1/admin/investors/\${encodeURIComponent(opts.investorId)}/withdrawals\`
    : "/api/v1/admin/withdrawals";
  return request(\`\${basePath}?\${params.toString()}\`);
}

export async function adminApproveWithdrawal(withdrawalId: string): Promise<{ ok: true; withdrawal: InvestorWithdrawal; providerResponse?: unknown }> {
  return request(\`/api/v1/admin/withdrawals/\${encodeURIComponent(withdrawalId)}/approve\`, { method: "PUT" });
}

export async function adminRejectWithdrawal(withdrawalId: string, reason?: string): Promise<{ ok: true; withdrawal: InvestorWithdrawal }> {
  return request(\`/api/v1/admin/withdrawals/\${encodeURIComponent(withdrawalId)}/reject\`, {
    method: "PUT",
    body: JSON.stringify({ reason }),
  });
}
`;

content = content + additions;
fs.writeFileSync('frontend/src/services/adminApi.ts', content);
console.log("✅ Admin API methods added successfully");
