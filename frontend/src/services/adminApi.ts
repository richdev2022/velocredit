import type { AdminConfigOverride } from "../utils/config";
import { config } from "../utils/config";

const ADMIN_TOKEN_KEY = "velo:admin-token";
const ADMIN_ROLE_KEY = "velo:admin-role";
const API_URL = config.apiUrl;
const REQUEST_TIMEOUT_MS = 120_000;
export interface AdminApplicationSummary { applicationId: string; applicantType: "PERSONAL" | "BUSINESS"; status: string; applicantName: string; email: string; phone: string; loanAmount: number; totalRepayment: number; tenure: string; repaymentDate: string; dateCreated: string; dateSubmitted: string; dateUpdated: string; driveFolderUrl: string; }
export interface AdminApplicationDetail { applicationId: string; applicantType: "PERSONAL" | "BUSINESS"; status: string; createdAt: string; updatedAt: string; submittedAt: string; personalInfo: any; businessInfo: any; businessRep: any; kyc: any; financial: any; loan: any; documents: any; customerSnapshot?: any; creditReportSnapshot?: any; }
export interface AdminStats { counts: Record<string, number>; total: number; totalLoanAmount: number; totalRepayment: number; totalLoanDisbursed: number; realizedRevenue: number; awaitingRevenue: number; }

function token() { return sessionStorage.getItem(ADMIN_TOKEN_KEY); }
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token()) headers.set("Authorization", `Bearer ${token()}`);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers, signal: options.signal ?? controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("The request timed out. Please try again.");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const body = await response.json().catch(() => ({}));
  const invalidOrExpiredToken = typeof body.error === "string" && /invalid or expired token/i.test(body.error);
  if (response.status === 401 || invalidOrExpiredToken) { clearAdminToken(); window.dispatchEvent(new Event("velo:admin-unauthorized")); }
  if (!response.ok) throw new Error(body.error || body.message || "Admin API request failed");
  return body as T;
}
export function getAdminToken() { return token(); }
export function setAdminToken(value: string) { sessionStorage.setItem(ADMIN_TOKEN_KEY, value); }
export function getAdminRole() { return sessionStorage.getItem(ADMIN_ROLE_KEY); }
export function getAdminPermissions(): AdminPermission[] { try { return JSON.parse(sessionStorage.getItem("velo:admin-permissions") || "[]") as AdminPermission[]; } catch { return []; } }
export function setAdminRole(value: string) { sessionStorage.setItem(ADMIN_ROLE_KEY, value); }
export function clearAdminToken() { sessionStorage.removeItem(ADMIN_TOKEN_KEY); sessionStorage.removeItem(ADMIN_ROLE_KEY); sessionStorage.removeItem("velo:admin-permissions"); }
export async function adminLogout() { return request<{ ok: true }>("/api/v1/auth/admin/logout", { method: "POST" }); }

export type AdminOtpChannel = "SMS" | "WHATSAPP" | "EMAIL";
export interface AdminOtpChallenge { challengeId: string; expiresAt: string; channel: AdminOtpChannel; resendAvailableAt: string; resendSecondsRemaining: number; }
export async function adminLogin(email: string, password: string, channel: AdminOtpChannel): Promise<{ ok: true; requiresOtp: true; user: { roles: string[]; adminPermissions?: AdminPermission[] }; verification: AdminOtpChallenge }> {
	const response = await request<{ ok: true; requiresOtp: true; user: { roles: string[]; adminPermissions?: AdminPermission[] }; challengeId: string; expiresAt: string; channel: AdminOtpChannel; resendAvailableAt: string; resendSecondsRemaining: number }>("/api/v1/auth/admin/login", { method: "POST", body: JSON.stringify({ email, password, channel }) });
	return { ok: true, requiresOtp: true, user: response.user, verification: { challengeId: response.challengeId, expiresAt: response.expiresAt, channel: response.channel, resendAvailableAt: response.resendAvailableAt, resendSecondsRemaining: response.resendSecondsRemaining } };
}
export async function resendAdminLoginOtp(challengeId: string, email: string, channel: AdminOtpChannel) { return request<{ ok: true } & AdminOtpChallenge>("/api/v1/auth/admin/login/resend-otp", { method: "POST", body: JSON.stringify({ challengeId, email, channel }) }); }
export async function verifyAdminLoginOtp(challengeId: string, code: string) {
	const response = await request<{ ok: true; accessToken: string; user: { roles: string[]; adminPermissions?: AdminPermission[] } }>("/api/v1/auth/admin/login/verify-otp", { method: "POST", body: JSON.stringify({ challengeId, code }) });
		setAdminToken(response.accessToken); setAdminRole(response.user.roles[0] || "ADMIN"); sessionStorage.setItem("velo:admin-permissions", JSON.stringify(response.user.adminPermissions ?? [])); return { ok: true, role: response.user.roles[0] || "ADMIN" };
}
export async function adminListApplications(opts: { status?: string; type?: string; search?: string; limit?: number; offset?: number } = {}): Promise<{ total: number; applications: AdminApplicationSummary[] }> { const params = new URLSearchParams(); if (opts.status) params.set("status", opts.status); if (opts.type) params.set("type", opts.type); if (opts.search) params.set("search", opts.search); params.set("limit", String(opts.limit || 20)); params.set("offset", String(opts.offset || 0)); const response = await request<{ loans: any[]; meta?: { total?: number } }>(`/api/v1/admin/loans?${params.toString()}`); const applications = (response.loans || []).map((loan) => ({ applicationId: loan.applicationId || loan.id, applicantType: (loan.customerSnapshot?.businessInfo?.businessName ? "BUSINESS" : "PERSONAL") as "PERSONAL" | "BUSINESS", status: loan.status, applicantName: loan.customerSnapshot?.fullName || "Borrower", email: loan.customerSnapshot?.email || "", phone: loan.customerSnapshot?.phone || "", loanAmount: Number(loan.amountNaira || 0), totalRepayment: Number(loan.totalRepaymentNaira || 0), tenure: `${loan.tenureDays || 0} days`, repaymentDate: loan.dueAt || "", dateCreated: loan.createdAt, dateSubmitted: loan.createdAt, dateUpdated: loan.createdAt, driveFolderUrl: "" })); return { total: response.meta?.total || applications.length, applications }; }
export async function adminGetApplication(id: string): Promise<AdminApplicationDetail> {
  const response = await request<{ loan?: any; application?: any }>(`/api/v1/admin/loans/${encodeURIComponent(id)}`);
  const loan = response.loan || response.application || {};
  const source = response.application || loan;
  const snapshot = source.customerSnapshot || loan.customerSnapshot || {};
  const calculation = snapshot.calculation || {};
  const normalizedLoan = {
    ...loan,
    amount: loan.amount ?? loan.amountNaira ?? loan.principalNaira ?? 0,
    tenure: loan.tenure ?? loan.tenureDays ?? 0,
    purpose: loan.purpose ?? snapshot.loanRequest?.purpose ?? "",
    interest: loan.interest ?? loan.totalInterestNaira ?? calculation.interest ?? 0,
    serviceFee: loan.serviceFee ?? calculation.serviceFee ?? 0,
    processingFee: loan.processingFee ?? loan.totalFeesNaira ?? calculation.processingFee ?? 0,
    lateFee: loan.lateFee ?? calculation.lateFee ?? 0,
    totalFees: loan.totalFees ?? loan.totalFeesNaira ?? calculation.totalFees ?? 0,
    totalRepayment: loan.totalRepayment ?? loan.totalRepaymentNaira ?? calculation.totalRepayment ?? 0,
    disbursementDate: loan.disbursementDate ?? loan.disbursedAt,
    repaymentDate: loan.repaymentDate ?? loan.dueAt ?? calculation.repaymentDate,
  };
  const applicantType = (source.applicantType || (snapshot.businessInfo?.businessName ? "BUSINESS" : "PERSONAL")) as "PERSONAL" | "BUSINESS";
  return {
    applicationId: source.applicationId || loan.applicationId || loan.id,
    applicantType,
    status: source.status || loan.status,
    createdAt: source.createdAt || loan.createdAt,
    updatedAt: source.updatedAt || loan.updatedAt || loan.createdAt,
    submittedAt: source.submittedAt || loan.createdAt,
    personalInfo: snapshot.personalInfo || {},
    businessInfo: snapshot.businessInfo || {},
    businessRep: snapshot.businessRep || {},
    kyc: snapshot.kyc || {},
    financial: snapshot.personalFinancial || snapshot.businessFinancial || {},
    loan: normalizedLoan,
    documents: source.documents || snapshot.documents || loan.documents || {},
    customerSnapshot: snapshot,
    creditReportSnapshot: source.creditReportSnapshot || loan.creditReportSnapshot,
  };
}
export async function adminUpdateStatus(id: string, decision: "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED") { const response = await request<{ application: { status: string } }>(`/api/v1/admin/loans/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify({ decision }) }); return { ok: true, status: response.application.status }; }
export async function adminDisburseLoan(id: string): Promise<{ ok: true; loan: any; disbursement: LoanDisbursement }> { return request(`/api/v1/admin/loans/${encodeURIComponent(id)}/disburse`, { method: "POST", body: JSON.stringify({}) }); }
export async function adminListStats(): Promise<AdminStats> { const response = await request<{ totals: Record<string, number> }>("/api/v1/admin/summary"); return { counts: {}, total: response.totals.users || 0, totalLoanAmount: 0, totalRepayment: 0, totalLoanDisbursed: 0, realizedRevenue: 0, awaitingRevenue: response.totals.pendingPayments || 0 }; }
export async function adminSaveConfig(overrides: AdminConfigOverride) { return overrides; }
export async function adminResetConfig() { return { ok: true }; }
export const ADMIN_PERMISSIONS = ["overview", "users", "investors", "kyc", "payouts", "loans", "loan_notifications", "reconciliation", "audit", "staff", "settings", "reports", "investments"] as const;
export type AdminPermission = typeof ADMIN_PERMISSIONS[number];
export interface LoanManager { id: string; email: string; fullName: string; phone: string; role: "LOAN_MANAGER"; adminPermissions?: AdminPermission[]; isActive?: boolean; createdAt: string; }
export async function adminListLoanManagers(): Promise<{ ok: true; managers: LoanManager[] }> { return request("/api/v1/admin/loan-managers"); }
export async function adminCreateLoanManager(email: string, name: string, _appUrl: string, phone: string, password: string, permissions: AdminPermission[] = [...ADMIN_PERMISSIONS]) {
	return request<{ ok: true; manager: LoanManager }>("/api/v1/admin/loan-managers", { method: "POST", body: JSON.stringify({ email, fullName: name, phone, password, role: "LOAN_MANAGER", permissions }) });
}
export async function adminSetLoanManagerStatus(id: string, isActive: boolean) { return request<{ ok: true; manager: LoanManager }>(`/api/v1/admin/loan-managers/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ isActive }) }); }
export async function adminDeleteLoanManager(id: string) { return request<{ ok: true; deleted: true }>(`/api/v1/admin/loan-managers/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export interface Administrator { id: string; email: string; fullName: string; phone: string; roles: string[]; adminPermissions?: AdminPermission[]; isActive?: boolean; createdAt: string; }
export async function adminListAdministrators() { return request<{ ok: true; administrators: Administrator[] }>("/api/v1/admin/administrators"); }
export async function adminCreateAdministrator(email: string, name: string, phone: string, password: string, roles: string[] = ["ADMIN"], permissions: AdminPermission[] = [...ADMIN_PERMISSIONS]) { return request<{ ok: true; administrator: Administrator }>("/api/v1/admin/administrators", { method: "POST", body: JSON.stringify({ email, fullName: name, phone, password, roles, permissions }) }); }
export async function adminSetAdministratorStatus(id: string, isActive: boolean) { return request<{ ok: true; administrator: Administrator }>(`/api/v1/admin/administrators/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ isActive }) }); }
export async function adminDeleteAdministrator(id: string) { return request<{ ok: true; deleted: true }>(`/api/v1/admin/administrators/${encodeURIComponent(id)}`, { method: "DELETE" }); }
export async function setLoanManagerPassword(_token: string, _password: string) { return { ok: false, error: "Loan manager provisioning API is not yet enabled on the Node backend." }; }
export async function requestAdminPasswordReset(email: string, channel: AdminOtpChannel) { return request<{ ok: true; message: string } & AdminOtpChallenge>("/api/v1/auth/admin/password-reset/request", { method: "POST", body: JSON.stringify({ email, channel }) }); }
export async function resetAdminPassword(challengeId: string, otp: string, password: string) { return request<{ ok: true; message: string }>("/api/v1/auth/admin/password-reset/confirm", { method: "POST", body: JSON.stringify({ challengeId, code: otp, newPassword: password }) }); }

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
  return request(`/api/v1/admin/investors/${encodeURIComponent(investorId)}/earning-rate`, {
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
  return request(`/api/v1/admin/investors/${encodeURIComponent(investorId)}/credit-wallet`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function adminGetLedger(opts: { limit?: number; offset?: number; entryType?: string } = {}): Promise<AdminLedgerResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.entryType) params.set("entryType", opts.entryType);
  return request<AdminLedgerResponse>(`/api/v1/admin/ledger?${params.toString()}`);
}

export async function adminListInvestors(opts: { limit?: number; offset?: number } = {}): Promise<{
  ok: true;
  total: number;
  investors: Array<{ id: string; email: string; fullName: string; phone: string; role: string; status: string; createdAt: string; }>;
}> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  return request(`/api/v1/admin/investors?${params.toString()}`);
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
  retryCount?: number;
  lastAttemptAt?: string;
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
    ? `/api/v1/admin/investors/${encodeURIComponent(opts.investorId)}/withdrawals`
    : "/api/v1/admin/withdrawals";
  return request(`${basePath}?${params.toString()}`);
}

export async function adminRetryWithdrawal(withdrawalId: string): Promise<{ ok: true; withdrawal: InvestorWithdrawal; providerResponse?: unknown; message?: string }> {
  return request(`/api/v1/admin/withdrawals/${encodeURIComponent(withdrawalId)}/retry`, { method: "POST" });
}

export type DisbursementStatus = "PENDING" | "PROCESSING" | "SUCCESSFUL" | "FAILED" | "PENDING_APPROVAL";
export interface LoanDisbursement {
  id: string;
  loanId: string;
  borrowerId: string;
  borrowerName?: string;
  amountNaira: number;
  currency: "NGN";
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  status: DisbursementStatus;
  narration?: string;
  applicationId?: string;
  providerTransfer?: Record<string, unknown>;
  providerReference?: string;
  error?: string;
  adminNote?: string;
  createdAt: string;
  updatedAt?: string;
  processedAt?: string;
  retryOfId?: string | null;
  retryCount?: number;
}
export async function adminListDisbursements(opts: { borrowerId?: string; status?: string; limit?: number; offset?: number } = {}): Promise<{
  ok: true;
  total: number;
  disbursements: LoanDisbursement[];
}> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const basePath = opts.borrowerId
    ? `/api/v1/admin/borrowers/${encodeURIComponent(opts.borrowerId)}/disbursements`
    : "/api/v1/admin/disbursements";
  return request(`${basePath}?${params.toString()}`);
}
export async function adminRetryDisbursement(disbursementId: string): Promise<{ ok: true; disbursement: LoanDisbursement; providerResponse?: unknown }> {
  return request(`/api/v1/admin/disbursements/${encodeURIComponent(disbursementId)}/retry`, { method: "POST" });
}
export interface AccountChangeRequest {
  id: string;
  userId: string;
  type: "INVESTOR_PAYOUT_ACCOUNT" | "BORROWER_DISBURSEMENT_ACCOUNT";
  status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
  existingSnapshot?: Record<string, unknown>;
  newSnapshot: Record<string, unknown>;
  reason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  user?: { fullName?: string; email?: string; phone?: string };
}
export async function adminListAccountRequests(opts: { status?: AccountChangeRequest["status"]; userId?: string; limit?: number; offset?: number } = {}): Promise<{ ok: true; total: number; requests: AccountChangeRequest[] }> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.userId) params.set("userId", opts.userId);
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  return request(`/api/v1/admin/account-requests?${params.toString()}`);
}
export async function adminApproveAccountRequest(requestId: string): Promise<{ ok: true; request: AccountChangeRequest }> {
  return request(`/api/v1/admin/account-requests/${encodeURIComponent(requestId)}/approve`, { method: "PUT" });
}
export async function adminRejectAccountRequest(requestId: string, input?: { rejectionReason?: string }): Promise<{ ok: true; request: AccountChangeRequest }> {
  return request(`/api/v1/admin/account-requests/${encodeURIComponent(requestId)}/reject`, { method: "PUT", body: JSON.stringify(input ?? {}) });
}

export interface AdminAuditLogEntry {
  id: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}
export async function adminListAuditLogs(opts: { limit?: number; offset?: number } = {}): Promise<{ ok: true; logs: AdminAuditLogEntry[] }> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  return request(`/api/v1/admin/audit-logs?${params.toString()}`);
}

export async function adminCreateUser(input: { email: string; fullName: string; phone: string; password: string; roles?: Array<"INVESTOR" | "BORROWER"> }): Promise<{ ok: true; user: { id: string; email: string; fullName: string; phone: string; roles: string[]; isActive?: boolean; createdAt: string } }> {
  return request("/api/v1/admin/users", { method: "POST", body: JSON.stringify(input) });
}
export async function adminPatchUserRoles(userId: string, roles: Array<"INVESTOR" | "BORROWER">): Promise<{ ok: true; user: { id: string; email: string; fullName: string; phone: string; roles: string[] } }> {
  return request(`/api/v1/admin/users/${encodeURIComponent(userId)}/roles`, { method: "PATCH", body: JSON.stringify({ roles }) });
}
export async function adminPatchUserStatus(userId: string, isActive: boolean): Promise<{ ok: true; user: { id: string; email: string; fullName: string; isActive: boolean } }> {
  return request(`/api/v1/admin/users/${encodeURIComponent(userId)}/status`, { method: "PATCH", body: JSON.stringify({ isActive }) });
}
export async function adminEditUser(userId: string, input: { fullName?: string; phone?: string }): Promise<{ ok: true; user: { id: string; email: string; fullName: string; phone: string; roles: string[] } }> {
  return request(`/api/v1/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export type KycResetCategory = "BVN" | "NIN" | "LIVENESS" | "ADDRESS" | "ALL";
export async function adminResetKycCategory(userId: string, category: KycResetCategory): Promise<{ ok: true; category: KycResetCategory; checklist: Record<string, boolean>; status: string; kyc: { id: string; userId: string; status: string; checklist: Record<string, boolean>; updatedAt: string } }> {
  return request(`/api/v1/admin/users/${encodeURIComponent(userId)}/kyc-reset`, { method: "POST", body: JSON.stringify({ category }) });
}

export const adminApi = {
  approveAccountRequest: async (id: string, _opts?: unknown) => adminApproveAccountRequest(id),
  rejectAccountRequest: async (id: string, opts?: { rejectionReason?: string }) => adminRejectAccountRequest(id, opts),
  listAccountRequests: adminListAccountRequests,
  retryDisbursement: adminRetryDisbursement,
  listDisbursements: adminListDisbursements,
  listAuditLogs: adminListAuditLogs,
  createUser: adminCreateUser,
  patchUserRoles: adminPatchUserRoles,
  patchUserStatus: adminPatchUserStatus,
  editUser: adminEditUser,
  retryPayout: async (id: string) => {
    // Existing wrapper for consistency if called
    const { adminRetryPayout } = await import("./apiClient");
    return adminRetryPayout(id);
  },
};
