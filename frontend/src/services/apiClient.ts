import { config } from "../utils/config";

export type Role = "INVESTOR" | "BORROWER" | "ADMIN";
export type KycStatus = "NOT_STARTED" | "IN_PROGRESS" | "PENDING_VERIFICATION" | "ACTION_REQUIRED" | "PARTIALLY_VERIFIED" | "VERIFIED" | "REJECTED" | "EXPIRED" | "SUSPENDED";
export type LoanStatus = "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "KYC_PENDING" | "UNDER_REVIEW" | "MORE_INFORMATION_REQUIRED" | "APPROVED" | "REJECTED" | "DISBURSEMENT_PENDING" | "DISBURSED" | "ACTIVE" | "PAST_DUE" | "DEFAULTED" | "REPAID" | "CANCELLED" | "WRITTEN_OFF";
export type InvestmentStatus = "PENDING" | "ACTIVE" | "LIQUIDITY_REQUESTED" | "LIQUIDITY_APPROVED" | "MATURITY_PENDING" | "MATURED" | "PAYOUT_PENDING" | "PAID_OUT" | "CANCELLED" | "REJECTED" | "PAYOUT_FAILED" | "PAYOUT_ACCOUNT_REQUIRED";
export type PaymentStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PROVIDER_NOT_CONFIGURED" | "CANCELLED" | "DISPUTED" | "REVERSED" | "PENDING" | "COMPLETED";
export type PayoutStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PENDING_APPROVAL" | "CANCELLED";
export type OtpAction = "SIGNUP_VERIFY" | "LOGIN_STEP_UP" | "PAYOUT_ACCOUNT_CHANGE" | "EARLY_LIQUIDITY" | "PASSWORD_RESET" | "KYC_VERIFICATION" | "WITHDRAWAL";
export type ConsentType = "TERMS" | "PRIVACY" | "IDENTITY_VERIFICATION" | "CREDIT_REPORT" | "INVESTMENT_AGREEMENT" | "LOAN_AGREEMENT" | "ELECTRONIC_COMMUNICATIONS";
export type NotificationChannel = "SMS" | "EMAIL" | "WHATSAPP" | "IN_APP";

export interface SessionUser { id: string; email: string; fullName: string; phone: string; roles: Role[]; kycStatus?: KycStatus; createdAt: string; }
export interface AuthResponse { ok: true; accessToken: string; user: SessionUser; }
export type OtpChannel = "SMS" | "WHATSAPP" | "EMAIL";
export interface RegistrationVerification { userId: string; challengeId: string; expiresAt: string; channel: OtpChannel; resendAvailableAt: string; resendSecondsRemaining: number; }
export interface RegistrationResponse { ok: true; user: SessionUser; verification: RegistrationVerification; message: string; }
export interface PaginationMeta { total: number; limit: number; offset: number; }

const TOKEN_KEY = "velo:access-token";
const API_URL = config.apiUrl;

export function getAccessToken(): string | null { return sessionStorage.getItem(TOKEN_KEY); }
export function clearAccessToken(): void { sessionStorage.removeItem(TOKEN_KEY); }
export function setAccessToken(token: string): void { sessionStorage.setItem(TOKEN_KEY, token); }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const isFormData = options.body instanceof FormData;
  if (!isFormData && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const adminToken = sessionStorage.getItem("velo:admin-token");
  const token = path.startsWith("/api/v1/admin/") ? adminToken || getAccessToken() : getAccessToken() || adminToken;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body as T;
}

export interface RegisterInput {
  email: string;
  phone: string;
  fullName: string;
  password: string;
  role: Exclude<Role, "ADMIN">;
  preferredOtpChannel: OtpChannel;
  consents: {
    terms: boolean;
    privacy: boolean;
    identityVerification: boolean;
    electronicCommunications: boolean;
    creditReport?: boolean;
  };
}

export async function register(input: RegisterInput): Promise<RegistrationResponse> {
  return request("/api/v1/auth/register", { method: "POST", body: JSON.stringify(input) });
}

export async function resendRegistrationOtp(userId: string, channel?: OtpChannel): Promise<RegistrationVerification> {
  const response = await request<{ ok: true } & RegistrationVerification>("/api/v1/auth/register/resend-otp", { method: "POST", body: JSON.stringify(channel ? { userId, channel } : { userId }) });
  return response;
}

export async function verifyRegistrationOtp(input: { userId: string; challengeId: string; code: string }): Promise<AuthResponse & { verified: true }> {
  const response = await request<AuthResponse & { verified: true }>("/api/v1/auth/register/verify-otp", { method: "POST", body: JSON.stringify(input) });
  setAccessToken(response.accessToken);
  return response;
}

export interface LoginOtpRequired { ok: false; requiresOtp: true; code: "OTP_REQUIRED"; userId: string; email: string; fullName?: string; channels: OtpChannel[]; error: string; }
export interface LoginSuccess { ok: true; accessToken: string; user: SessionUser; }

export async function login(input: { email: string; password: string }): Promise<LoginSuccess | LoginOtpRequired> {
  const headers = new Headers({ "Content-Type": "application/json" });
  const adminToken = sessionStorage.getItem("velo:admin-token");
  const token = getAccessToken() || adminToken;
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}/api/v1/auth/login`, { method: "POST", body: JSON.stringify(input), headers });
  const body = await response.json().catch(() => ({}));
  if (response.ok) {
    setAccessToken(body.accessToken);
    return body as LoginSuccess;
  }
  if (response.status === 403 && body.code === "OTP_REQUIRED") {
    return { ok: false, requiresOtp: true, code: "OTP_REQUIRED", userId: body.userId, email: body.email, fullName: body.fullName, channels: body.channels ?? ["EMAIL"], error: body.error ?? "Account verification required" };
  }
  throw new Error(body.error || body.message || `Request failed (${response.status})`);
}

export async function adminLogin(input: { email: string; password: string }): Promise<AuthResponse> {
  const response = await request<AuthResponse>("/api/v1/auth/admin/login", { method: "POST", body: JSON.stringify(input) });
  setAccessToken(response.accessToken);
  return response;
}

export async function refreshToken(): Promise<AuthResponse> {
  return request("/api/v1/auth/refresh", { method: "POST" });
}

export async function logout(): Promise<{ ok: true }> {
  try {
    await request("/api/v1/auth/logout", { method: "POST" });
  } finally {
    clearAccessToken();
  }
  return { ok: true };
}

export interface OtpRequestResponse { ok: true; challengeId: string; expiresAt: string; delivered: boolean; channel?: NotificationChannel; resendAvailableAt: string; resendSecondsRemaining: number; }
export async function requestOtp(action: OtpAction, channel?: NotificationChannel, target?: string): Promise<OtpRequestResponse> {
  return request("/api/v1/auth/otp/request", { method: "POST", body: JSON.stringify({ action, channel, target }) });
}

export interface OtpVerifyResponse { ok: true; verified: true; }
export async function verifyOtp(challengeId: string, code: string): Promise<OtpVerifyResponse> {
  return request("/api/v1/auth/otp/verify", { method: "POST", body: JSON.stringify({ challengeId, code }) });
}

export interface PasswordResetRequestResponse { ok: true; resetId?: string; message: string; }
export async function requestPasswordReset(email: string): Promise<PasswordResetRequestResponse> {
  return request("/api/v1/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email }) });
}

export async function confirmPasswordReset(resetId: string, token: string, newPassword: string): Promise<{ ok: true }> {
  return request("/api/v1/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ resetId, token, newPassword }) });
}

export async function getCurrentUser(): Promise<{ ok: true; user: SessionUser }> { return request("/api/v1/me"); }

export interface MePatchInput { fullName?: string; phone?: string; address?: Record<string, unknown>; }
export async function patchMe(input: MePatchInput): Promise<{ ok: true; user: SessionUser }> {
  return request("/api/v1/me", { method: "PATCH", body: JSON.stringify(input) });
}

export async function addUserRole(role: Exclude<Role, "ADMIN">): Promise<{ ok: true; user: SessionUser; message: string }> {
  return request("/api/v1/me/roles/add", { method: "POST", body: JSON.stringify({ role }) });
}

export interface KycChecklist { personalInfoCompleted: boolean; phoneVerified: boolean; bvnVerified: boolean; ninVerified: boolean; proofOfIdentityUploaded: boolean; proofOfAddressUploaded: boolean; selfieUploaded: boolean; }
export interface KycResponse { ok: true; status: KycStatus; checklist: KycChecklist; verificationStatus?: "PENDING" | "SUCCESS" | "FAILED" | "MANUAL_REVIEW"; providerConfigured?: boolean; error?: string; verifiedDetails?: Record<string, unknown>; bvnLast4?: string; ninLast4?: string; submittedAt?: string; verifiedAt?: string; rejectedReason?: string; documents: unknown[]; verificationEvents: unknown[]; }
export async function getMyKyc(): Promise<KycResponse> { return request("/api/v1/me/kyc"); }

export interface KycUpdateInput { statusOverride?: Extract<KycStatus, "IN_PROGRESS" | "PENDING_VERIFICATION">; checklist?: { bvn?: boolean; nin?: boolean; proofOfAddress?: boolean; passport?: boolean; signature?: boolean }; bvn?: string; nin?: string; }
export async function updateMyKyc(input: KycUpdateInput): Promise<KycResponse> {
  return request("/api/v1/me/kyc", { method: "POST", body: JSON.stringify(input) });
}

export async function submitKyc(): Promise<KycResponse> {
  return updateMyKyc({ statusOverride: "PENDING_VERIFICATION" });
}

export async function verifyMyBvn(bvn: string, firstName?: string, lastName?: string, dateOfBirth?: string, otpChannel?: "SMS"|"WHATSAPP"): Promise<KycResponse> {
  return request("/api/v1/me/kyc/bvn/verify", { method: "POST", body: JSON.stringify({ bvn, firstName, lastName, dateOfBirth, otpChannel }) });
}

export async function verifyMyNin(nin: string, firstName?: string, lastName?: string, dateOfBirth?: string, otpChannel?: "SMS"|"WHATSAPP"): Promise<KycResponse> {
  return request("/api/v1/me/kyc/nin/verify", { method: "POST", body: JSON.stringify({ nin, firstName, lastName, dateOfBirth, otpChannel }) });
}

export type KycOtpChallenge = {
  requiresPhoneVerification: true;
  challengeId: string;
  expiresAt: string;
  channel: "SMS"|"WHATSAPP"|"EMAIL";
  phoneLastFour: string;
  resendAvailableAt: string;
  resendSecondsRemaining: number;
};
export interface KycOtpConfirmResponse { ok: true; idType: "BVN"|"NIN"; checklist: Record<string, unknown>; status?: string; message: string; }
export async function confirmKycOwnershipOtp(params: { idType: "BVN"|"NIN"; challengeId: string; code: string }): Promise<KycOtpConfirmResponse> {
  return request("/api/v1/me/kyc/verify-confirm-otp", { method: "POST", body: JSON.stringify(params) });
}
export async function resendKycOwnershipOtp(params: { idType: "BVN"|"NIN"; challengeId: string; channel?: "SMS"|"WHATSAPP" }): Promise<{ ok: true; challengeId: string; expiresAt: string; channel: "SMS"|"WHATSAPP"|"EMAIL"; resendAvailableAt: string; resendSecondsRemaining: number; }> {
  return request("/api/v1/me/kyc/verify-resend-otp", { method: "POST", body: JSON.stringify(params) });
}
export async function verifyMyLiveness(file: File, input?: { idType?: "BVN" | "NIN"; idNumber?: string; dateOfBirth?: string }): Promise<KycResponse> {
  const form = new FormData();
  form.append("image", file);
  if (input?.idType) form.append("idType", input.idType);
  if (input?.idNumber) form.append("idNumber", input.idNumber);
  if (input?.dateOfBirth) form.append("dateOfBirth", input.dateOfBirth);
  return request("/api/v1/me/kyc/liveness/verify", { method: "POST", body: form });
}
export async function completePremblyWidgetVerification(input: { status: "SUCCESS" | "FAILED"; providerReference?: string; rawResponse?: Record<string, unknown>; selfieImageData?: string }): Promise<KycResponse> {
  return request("/api/v1/me/kyc/prembly-widget/complete", { method: "POST", body: JSON.stringify(input) });
}

export interface DocumentUploadResponse { ok: true; document: { id: string; documentType: string; fileName: string; status: string; uploadedAt: string; }; checklist: { bvn?: boolean; nin?: boolean; proofOfAddress?: boolean; passport?: boolean; signature?: boolean } }
export async function uploadKycDocument(documentType: string, file: File, note?: string): Promise<DocumentUploadResponse> {
  const form = new FormData();
  form.append("documentType", documentType);
  form.append("document", file);
  if (note) form.append("note", note);
  return request("/api/v1/me/kyc/documents", { method: "POST", body: form });
}

export interface PayoutAccountInput { bankCode: string; bankName: string; accountNumber: string; accountName: string; }
export interface PayoutAccountResponse { ok: true; payoutAccount: { id: string; bankCode: string; bankName: string; accountNumberMasked: string; accountName: string; status: string; verifiedAt?: string; }; }
export async function createPayoutAccount(input: PayoutAccountInput): Promise<PayoutAccountResponse> {
  return request("/api/v1/me/payout-accounts", { method: "POST", body: JSON.stringify(input) });
}

export async function verifyPayoutAccount(id: string, otpChallengeId?: string, otpCode?: string): Promise<PayoutAccountResponse> {
  return request(`/api/v1/me/payout-accounts/${encodeURIComponent(id)}/verify`, { method: "POST", body: JSON.stringify({ otpChallengeId, otpCode }) });
}

export interface InvestorDashboardResponse { ok: true; wallet: { id: string; userId: string; currency: "NGN"; availableMinor: number; heldMinor: number; pendingDepositMinor: number; pendingPayoutMinor: number; totalCreditedMinor: number; totalDebitedMinor: number; }; investments: Array<{ id: string; planId?: string; amountNaira: number; expectedEarningsNaira: number; tenureDays: number; annualRatePercent: number; startsAt: string; maturesAt: string; status: InvestmentStatus; planSnapshot?: Record<string, unknown>; }>; payouts: unknown[]; payoutAccount: unknown; documents: unknown[]; }
export async function getInvestorDashboard(): Promise<InvestorDashboardResponse> { return request("/api/v1/investor/dashboard"); }

export interface WalletResponse { ok: true; wallet: { id: string; currency: "NGN"; availableMinor: number; heldMinor: number; pendingDepositMinor: number; pendingPayoutMinor: number; totalCreditedMinor: number; totalDebitedMinor: number; userId: string; }; ledger: unknown[]; transactions: unknown[]; }
export async function getInvestorWallet(): Promise<WalletResponse> { return request("/api/v1/investor/wallet"); }

export interface InvestorPayoutAccountResponse { ok: true; account?: { id: string; bankCode: string; bankName?: string; accountNumber: string; accountName?: string; status: string; verifiedAt?: string; }; }
export async function getInvestorPayoutAccount(): Promise<InvestorPayoutAccountResponse> { return request("/api/v1/investor/payout-account"); }

export interface PayoutAccountUpdateInput { bankCode: string; bankName: string; accountNumber: string; accountName: string; otpChallengeId?: string; otpCode?: string; }
export async function updateInvestorPayoutAccount(input: PayoutAccountUpdateInput): Promise<InvestorPayoutAccountResponse> {
  return request("/api/v1/investor/payout-account", { method: "PUT", body: JSON.stringify(input) });
}

export interface InvestmentPlan { id: string; version: number; name: string; description?: string; currency: "NGN"; minAmountNaira: number; maxAmountNaira: number; tenureDays: number; annualRatePercent: number; rateType: "ANNUALIZED" | "FLAT" | "TENURE_SPECIFIC"; earlyLiquidityAllowed: boolean; earlyLiquidityFeePercent: number; gatewayFeePercent: number; forfeitInterestOnEarlyExit: boolean; capacityNaira?: number; isActive: boolean; allowNewInvestmentsAfterClose: boolean; effectiveFrom: string; effectiveTo?: string; createdAt: string; updatedAt?: string; }
export async function getInvestmentPlans(): Promise<{ ok: true; plans: InvestmentPlan[] }> { return request("/api/v1/investor/investment-plans"); }

export interface WalletFundingResponse { ok: true; txRef: string; amountNaira: number; checkout?: { status?: string; data?: { link?: string }; message?: string; error?: string }; message: string; }
export async function fundWallet(amountNaira: number): Promise<WalletFundingResponse> {
  return request("/api/v1/investor/wallet/funding", { method: "POST", body: JSON.stringify({ amountNaira }) });
}

export async function verifyWalletFunding(transactionId: string): Promise<{ ok: boolean; txRef?: string; reason?: string; settled?: unknown; }> {
  return request("/api/v1/investor/wallet/funding/verify", { method: "POST", body: JSON.stringify({ transactionId }) });
}

export interface InvestmentListResponse { ok: true; investments: unknown[]; meta?: PaginationMeta; }
export async function getInvestments(limit = 50, offset = 0): Promise<InvestmentListResponse> {
  return request(`/api/v1/investor/investments?limit=${limit}&offset=${offset}`);
}

export interface CreateInvestmentInput { planId?: string; amountNaira: number; tenureDays?: number; annualRatePercent?: number; }
export interface CreateInvestmentResponse { ok: true; investment: { id: string; planId?: string; amountNaira: number; expectedEarningsNaira: number; tenureDays: number; annualRatePercent: number; startsAt: string; maturesAt: string; status: InvestmentStatus; planSnapshot?: Record<string, unknown>; planVersion?: number; }; }
export async function createInvestment(input: CreateInvestmentInput): Promise<CreateInvestmentResponse> {
  return request("/api/v1/investor/investments", { method: "POST", body: JSON.stringify(input) });
}

export interface LiquidityRequestInput { investmentId: string; otpChallengeId?: string; otpCode?: string; }
export interface LiquidityResponse { ok: true; investment: { id: string; status: InvestmentStatus; }; breakdown: { principalNaira: number; earningsNaira: number; liquidityFeeNaira: number; gatewayFeeNaira: number; netPayoutNaira: number; }; payout?: { id: string; status: PayoutStatus; amountNaira: number; }; }
export async function requestEarlyLiquidity(input: LiquidityRequestInput): Promise<LiquidityResponse> {
  return request(`/api/v1/investor/investments/${encodeURIComponent(input.investmentId)}/liquidity`, { method: "POST", body: JSON.stringify(input) });
}

export async function getInvestorTransactions(limit = 100, offset = 0): Promise<{ ok: true; investments: unknown[]; payouts: unknown[]; ledger: unknown[]; walletTransactions: unknown[]; meta?: PaginationMeta; }> {
  return request(`/api/v1/investor/transactions?limit=${limit}&offset=${offset}`);
}

export interface BorrowerDashboardResponse { ok: true; applications: unknown[]; loans: unknown[]; repayments: unknown[]; disbursementAccount: { id: string; bankCode: string; bankName?: string; accountNumber: string; accountName?: string; status: string; } | null; }
export async function getBorrowerDashboard(): Promise<BorrowerDashboardResponse> { return request("/api/v1/borrower/dashboard"); }

export interface BorrowerDisbursementAccountInput { accountNumber: string; accountName: string; }
export async function updateBorrowerDisbursementAccount(input: BorrowerDisbursementAccountInput): Promise<{ ok: true; disbursementAccount: BorrowerDashboardResponse["disbursementAccount"] }> {
  return request("/api/v1/borrower/disbursement-account", { method: "PUT", body: JSON.stringify(input) });
}

export interface LoanProduct { id: string; name: string; description?: string; minAmountNaira: number; maxAmountNaira: number; defaultTenureDays?: number; interestRatePercent: number; interestType: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED"; processingFeePercent: number; lateFeePercent: number; lateFeeType: "ONE_TIME" | "COMPOUNDING_DAILY" | "COMPOUNDING_MONTHLY"; gracePeriodDays: number; isActive: boolean; version: number; createdAt: string; updatedAt?: string; }
export async function getLoanProducts(): Promise<{ ok: true; products: LoanProduct[] }> { return request("/api/v1/borrower/loan-products"); }

export interface LoanApplicationInput { productId: string; principalNaira: number; tenureDays: number; purpose?: string; personalInfo?: Record<string, unknown>; businessInfo?: Record<string, unknown>; financial?: Record<string, unknown>; references?: unknown[]; }
export interface LoanApplicationResponse { ok: true; application: { id: string; status: LoanStatus; productId: string; principalNaira: number; tenureDays: number; createdAt: string; updatedAt: string; }; }
export async function createLoanApplication(input: LoanApplicationInput): Promise<LoanApplicationResponse> {
  return request("/api/v1/borrower/applications", { method: "POST", body: JSON.stringify(input) });
}

export async function patchLoanApplication(id: string, input: Partial<LoanApplicationInput>): Promise<LoanApplicationResponse> {
  return request(`/api/v1/borrower/applications/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function submitLoanApplication(id: string): Promise<LoanApplicationResponse> {
  return request(`/api/v1/borrower/applications/${encodeURIComponent(id)}/submit`, { method: "POST" });
}

export interface SubmitBorrowerApplicationResponse { ok: true; loan?: { applicationId?: string; id?: string; status?: LoanStatus }; error?: string; }
export async function submitBorrowerApplication(input: Record<string, unknown>): Promise<SubmitBorrowerApplicationResponse> {
  const application = input as Partial<LoanApplicationInput> & { applicationId?: string; id?: string };
  const existingId = application.applicationId || application.id;
  let appId: string;
  if (existingId) {
    const { productId, principalNaira, tenureDays, purpose, personalInfo, businessInfo, financial, references } = application;
    const patchResult = await patchLoanApplication(existingId, { productId, principalNaira, tenureDays, purpose, personalInfo, businessInfo, financial, references });
    appId = patchResult.application.id;
  } else {
    const { productId, principalNaira, tenureDays, purpose, personalInfo, businessInfo, financial, references } = application;
    if (!productId || !principalNaira || !tenureDays) {
      throw new Error("Missing required fields: productId, principalNaira, tenureDays");
    }
    const createResult = await createLoanApplication({ productId, principalNaira, tenureDays, purpose, personalInfo, businessInfo, financial, references });
    appId = createResult.application.id;
  }
  const submitResult = await submitLoanApplication(appId);
  return { ok: true, loan: { applicationId: submitResult.application.id, id: submitResult.application.id, status: submitResult.application.status } };
}

export interface BorrowerLoansResponse { ok: true; loans: unknown[]; meta?: PaginationMeta; }
export async function getBorrowerLoans(id?: string): Promise<BorrowerLoansResponse> {
  const path = id ? `/api/v1/borrower/loans/${encodeURIComponent(id)}` : "/api/v1/borrower/loans";
  return request(path);
}

export async function getBorrowerCreditHistory(): Promise<{ ok: true; events: unknown[]; scores: unknown[]; reports: unknown[]; }> {
  return request("/api/v1/borrower/credit-history");
}

export interface CreditScoreResponse { ok: true; score: { score: number; band: string; sources: Record<string, number>; calculatedAt: string; userId: string; }; }
export async function getBorrowerCreditScore(): Promise<CreditScoreResponse> { return request("/api/v1/borrower/credit-score"); }

export interface CreditReportRequestResponse { ok: true; status: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED"; report?: { id: string; provider: string; score?: number; pulledAt?: string; }; message?: string; }
export async function requestCreditReport(otpChallengeId?: string, otpCode?: string): Promise<CreditReportRequestResponse> {
  return request("/api/v1/borrower/credit-report/request", { method: "POST", body: JSON.stringify({ otpChallengeId, otpCode }) });
}

export interface RepaymentInitResponse {
  ok: true;
  repayment: { id: string; loanId: string; amountNaira: number; txRef: string; status: PaymentStatus; };
  checkout?: { type: "flutterwave_standard_checkout"; url: string; txRef: string; amountNaira: number; currency: "NGN"; };
  repaymentContext?: {
    isFullPayoff: boolean;
    minAllowedNaira: number;
    maxAllowedNaira: number;
    outstandingNaira: number;
    estimatedPrincipalNaira: number;
    estimatedInterestNaira: number;
  };
  error?: string;
  message?: string;
  minAllowedNaira?: number;
  maxAllowedNaira?: number;
}
export async function initializeLoanRepayment(loanId: string, amountNaira: number): Promise<RepaymentInitResponse> {
  return request(`/api/v1/borrower/loans/${encodeURIComponent(loanId)}/repayments`, { method: "POST", body: JSON.stringify({ amountNaira }) });
}

export interface AdminSummaryResponse { ok: true; totals: Record<string, number>; recentActivity: unknown[]; }
export async function getAdminSummary(): Promise<AdminSummaryResponse> { return request("/api/v1/admin/summary"); }

export interface AdminInvestorsResponse { ok: true; investors: unknown[]; meta?: PaginationMeta; }
export async function adminListInvestors(limit = 50, offset = 0): Promise<AdminInvestorsResponse> {
  return request(`/api/v1/admin/investors?limit=${limit}&offset=${offset}`);
}

export interface AdminPayoutsResponse { ok: true; payouts: unknown[]; meta?: PaginationMeta; }
export async function adminListPayouts(limit = 50, offset = 0): Promise<AdminPayoutsResponse> {
  return request(`/api/v1/admin/payouts?limit=${limit}&offset=${offset}`);
}

export async function adminRetryPayout(payoutId: string): Promise<{ ok: true; payout: unknown; }> {
  return request(`/api/v1/admin/payouts/${encodeURIComponent(payoutId)}/retry`, { method: "POST" });
}

export interface AdminUsersResponse { ok: true; users: unknown[]; meta?: PaginationMeta; }
export async function adminListUsers(limit = 50, offset = 0, role?: Role, status?: string): Promise<AdminUsersResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (role) params.set("role", role);
  if (status) params.set("status", status);
  return request(`/api/v1/admin/users?${params.toString()}`);
}

export interface AdminKycCasesResponse { ok: true; cases: unknown[]; meta?: PaginationMeta; }
export async function adminListKycCases(limit = 50, offset = 0, status?: KycStatus): Promise<AdminKycCasesResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) params.set("status", status);
  return request(`/api/v1/admin/kyc-cases?${params.toString()}`);
}

export interface KycDecisionInput { decision: "VERIFIED" | "PARTIALLY_VERIFIED" | "REJECTED" | "ACTION_REQUIRED" | "SUSPENDED"; note?: string; rejectedReason?: string; checklistOverride?: Partial<KycChecklist>; }
export async function adminDecideKyc(id: string, input: KycDecisionInput): Promise<{ ok: true; case: unknown; }> {
  return request(`/api/v1/admin/kyc-cases/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(input) });
}

export interface AdminLoansResponse { ok: true; loans: unknown[]; disbursedLoans: unknown[]; meta?: PaginationMeta; }
export async function adminListLoans(limit = 50, offset = 0, status?: LoanStatus): Promise<AdminLoansResponse> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (status) params.set("status", status);
  return request(`/api/v1/admin/loans?${params.toString()}`);
}

export interface AdminLoanDetailResponse { ok: true; loan: unknown; application: unknown; schedules: unknown[]; repayments: unknown[]; creditHistory: unknown[]; }
export async function adminGetLoan(id: string): Promise<AdminLoanDetailResponse> {
  return request(`/api/v1/admin/loans/${encodeURIComponent(id)}`);
}

export interface LoanDecisionInput { decision: "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED"; note?: string; manualDecision?: boolean; approvedTermsOverride?: Record<string, unknown>; }
export async function adminDecideLoan(id: string, input: LoanDecisionInput): Promise<{ ok: true; loan?: unknown; application: unknown; }> {
  return request(`/api/v1/admin/loans/${encodeURIComponent(id)}/decision`, { method: "POST", body: JSON.stringify(input) });
}

export interface DisbursementInput { note?: string; }
export async function adminDisburseLoan(id: string, input?: DisbursementInput): Promise<{ ok: true; loan: unknown; disbursement: unknown; }> {
  return request(`/api/v1/admin/loans/${encodeURIComponent(id)}/disburse`, { method: "POST", body: JSON.stringify(input ?? {}) });
}

export interface AdminInvestmentPlansResponse { ok: true; plans: InvestmentPlan[]; }
export async function adminListInvestmentPlans(): Promise<AdminInvestmentPlansResponse> {
  return request("/api/v1/admin/investment-plans");
}

export interface AdminCreatePlanInput { name: string; description?: string; minAmountNaira: number; maxAmountNaira: number; annualRatePercent: number; tenureDays: number; rateType?: "ANNUALIZED" | "FLAT" | "TENURE_SPECIFIC"; earlyLiquidityAllowed: boolean; earlyLiquidityFeePercent: number; gatewayFeePercent: number; forfeitInterestOnEarlyExit: boolean; capacityNaira?: number; isActive?: boolean; }
export async function adminCreateInvestmentPlan(input: AdminCreatePlanInput): Promise<{ ok: true; plan: InvestmentPlan; }> {
  return request("/api/v1/admin/investment-plans", { method: "POST", body: JSON.stringify(input) });
}

export async function adminPatchInvestmentPlan(id: string, input: Partial<AdminCreatePlanInput> & { isActive?: boolean }): Promise<{ ok: true; plan: InvestmentPlan; }> {
  return request(`/api/v1/admin/investment-plans/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export interface AdminLoanProductsResponse { ok: true; products: LoanProduct[]; }
export async function adminListLoanProducts(): Promise<AdminLoanProductsResponse> {
  return request("/api/v1/admin/loan-products");
}

export interface AdminCreateLoanProductInput { name: string; description?: string; minAmountNaira: number; maxAmountNaira: number; defaultTenureDays?: number; interestRatePercent: number; interestType?: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED"; processingFeePercent?: number; lateFeePercent?: number; lateFeeType?: "ONE_TIME" | "COMPOUNDING_DAILY" | "COMPOUNDING_MONTHLY"; gracePeriodDays?: number; isActive?: boolean; }
export async function adminCreateLoanProduct(input: AdminCreateLoanProductInput): Promise<{ ok: true; product: LoanProduct; }> {
  return request("/api/v1/admin/loan-products", { method: "POST", body: JSON.stringify(input) });
}

export async function adminPatchLoanProduct(id: string, input: Partial<AdminCreateLoanProductInput>): Promise<{ ok: true; product: LoanProduct; }> {
  return request(`/api/v1/admin/loan-products/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(input) });
}

export async function adminApprovePayout(payoutId: string): Promise<{ ok: true; payout: unknown; transfer?: unknown; }> {
  return request(`/api/v1/admin/payouts/${encodeURIComponent(payoutId)}/approve`, { method: "POST" });
}

export interface AdminReconciliationResponse { ok: true; providerEvents: unknown[]; unverifiedDeposits: unknown[]; unverifiedRepayments: unknown[]; pendingPayouts: unknown[]; lastSyncAt?: string; }
export async function adminGetReconciliation(limit = 100): Promise<AdminReconciliationResponse> {
  return request(`/api/v1/admin/reconciliation?limit=${limit}`);
}

export interface AdminReportsInput { startDate: string; endDate: string; currency?: "NGN"; timezone?: string; }
export interface AdminReportsResponse { ok: true; period: { start: string; end: string; timezone: string; currency: "NGN"; }; sections: Record<string, unknown>; summary: Record<string, number>; }
export async function adminGenerateReports(input: AdminReportsInput): Promise<AdminReportsResponse> {
  const params = new URLSearchParams({ startDate: input.startDate, endDate: input.endDate, currency: input.currency || "NGN", timezone: input.timezone || "Africa/Lagos" });
  return request(`/api/v1/admin/reports?${params.toString()}`);
}

export async function recordConsent(userId: string, type: ConsentType): Promise<{ ok: true; consent: unknown; }> {
  return request("/api/v1/consents", { method: "POST", body: JSON.stringify({ userId, type }) });
}

export async function getNotifications(limit = 50, offset = 0): Promise<{ ok: true; notifications: unknown[]; meta?: PaginationMeta; }> {
  return request(`/api/v1/notifications?limit=${limit}&offset=${offset}`);
}
