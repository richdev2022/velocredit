import { randomUUID, createHash } from "node:crypto";

export type Role = "INVESTOR" | "BORROWER" | "ADMIN";
export type KycStatus = "NOT_STARTED" | "IN_PROGRESS" | "PENDING_VERIFICATION" | "ACTION_REQUIRED" | "VERIFIED" | "PARTIALLY_VERIFIED" | "REJECTED" | "EXPIRED" | "SUSPENDED";
export type LoanStatus = "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "KYC_PENDING" | "UNDER_REVIEW" | "MORE_INFORMATION_REQUIRED" | "APPROVED" | "REJECTED" | "DISBURSEMENT_PENDING" | "DISBURSED" | "ACTIVE" | "PAST_DUE" | "DEFAULTED" | "REPAID" | "CANCELLED" | "WRITTEN_OFF";
export type InvestmentStatus = "PENDING" | "ACTIVE" | "LIQUIDITY_REQUESTED" | "LIQUIDITY_APPROVED" | "MATURITY_PENDING" | "MATURED" | "PAYOUT_PENDING" | "PAID_OUT" | "CANCELLED" | "REJECTED" | "PAYOUT_FAILED" | "PAYOUT_ACCOUNT_REQUIRED";
export type PaymentStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PROVIDER_NOT_CONFIGURED" | "CANCELLED" | "DISPUTED" | "REVERSED";
export type PayoutStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PENDING_APPROVAL" | "CANCELLED";
export type DocumentStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "EXPIRED";
export type OtpAction = "LOGIN_STEP_UP" | "PAYOUT_ACCOUNT_CHANGE" | "EARLY_LIQUIDITY" | "PASSWORD_RESET" | "KYC_VERIFICATION" | "WITHDRAWAL";
export type NotificationChannel = "SMS" | "WHATSAPP" | "EMAIL" | "IN_APP";

export interface User {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  passwordHash: string;
  roles: Role[];
  kycStatus: KycStatus;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
  isActive?: boolean;
  dateOfBirth?: string;
  residentialAddress?: Record<string, unknown>;
  occupation?: string;
  sourceOfFunds?: string;
}

export interface Wallet {
  id: string;
  userId: string;
  availableMinor: number;
  heldMinor: number;
  pendingDepositMinor: number;
  pendingPayoutMinor: number;
  totalCreditedMinor: number;
  totalDebitedMinor: number;
  currency: "NGN";
}

export interface LedgerEntry {
  id: string;
  walletId: string;
  userId: string;
  entryType: "FUNDING" | "INVESTMENT_LOCK" | "INVESTMENT_RELEASE" | "INVESTMENT_RETURN" | "PAYOUT" | "FEE" | "MANUAL_ADJUSTMENT" | "REVERSAL";
  referenceId?: string;
  amountMinor: number;
  direction: "DEBIT" | "CREDIT";
  balanceAfterMinor: number;
  heldAfterMinor: number;
  currency: "NGN";
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WalletTransaction {
  id: string;
  userId: string;
  walletId?: string;
  type: "DEPOSIT" | "WITHDRAWAL" | "INVESTMENT" | "INVESTMENT_RETURN" | "FEE" | "TRANSFER";
  amountMinor: number;
  currency: "NGN";
  status: PaymentStatus | "PENDING" | "COMPLETED";
  provider?: "flutterwave" | "manual";
  providerReference?: string;
  txRef?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export interface KycCase {
  id: string;
  userId: string;
  status: KycStatus;
  bvn?: string;
  nin?: string;
  bvnVerifiedAt?: string;
  ninVerifiedAt?: string;
  providerRequestId?: string;
  providerRaw?: Record<string, unknown>;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  checklist: {
    bvn: boolean;
    nin: boolean;
    proofOfAddress: boolean;
    passport: boolean;
    signature: boolean;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface IdentityVerificationEvent {
  id: string;
  kycCaseId: string;
  provider: "prembly" | "manual";
  verificationType: "BVN" | "NIN" | "PASSPORT" | "ADDRESS" | "SIGNATURE";
  providerReference?: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "MANUAL_REVIEW";
  matchScore?: number;
  rawResponse?: Record<string, unknown>;
  createdAt: string;
}

export interface Document {
  id: string;
  userId: string;
  documentType: "PASSPORT_PHOTO" | "PROOF_OF_ADDRESS" | "SIGNATURE" | "BVN_SLIP" | "NIN_SLIP" | "BUSINESS_REGISTRATION" | "ID_CARD_FRONT" | "ID_CARD_BACK";
  provider: "google_drive" | "s3" | "cloudinary" | "manual";
  providerFileId: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  status: DocumentStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  version: number;
  createdAt: string;
  updatedAt?: string;
}

export interface PayoutAccount {
  id: string;
  userId: string;
  bankName?: string;
  bankCode: string;
  accountNumber: string;
  accountName?: string;
  accountNameEnquiryResult?: string;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "EXPIRED";
  verifiedAt?: string;
  verificationReference?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface InvestmentPlan {
  id: string;
  name: string;
  description?: string;
  currency: "NGN";
  minAmountNaira: number;
  maxAmountNaira: number;
  tenureDays: number;
  annualRatePercent: number;
  rateType: "ANNUALIZED" | "FLAT" | "TENURE_SPECIFIC";
  earlyLiquidityAllowed: boolean;
  earlyLiquidityFeePercent: number;
  gatewayFeePercent: number;
  forfeitInterestOnEarlyExit: boolean;
  capacityNaira?: number;
  isActive: boolean;
  allowNewInvestmentsAfterClose: boolean;
  version: number;
  effectiveFrom: string;
  effectiveTo?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Investment {
  id: string;
  investorId: string;
  planId?: string;
  planVersion?: number;
  planSnapshot?: Record<string, unknown>;
  amountNaira: number;
  expectedEarningsNaira: number;
  tenureDays: number;
  annualRatePercent: number;
  startsAt: string;
  maturesAt: string;
  status: InvestmentStatus;
  liquidityRequestedAt?: string;
  liquidityApprovedAt?: string;
  liquidityFeeNaira?: number;
  netPayoutNaira?: number;
  createdAt: string;
  updatedAt?: string;
}

export interface LoanApplication {
  id: string;
  applicationId: string;
  borrowerId: string;
  applicantType: "PERSONAL" | "BUSINESS";
  customerSnapshot?: Record<string, unknown>;
  creditReportSnapshot?: Record<string, unknown>;
  amountNaira?: number;
  tenureDays?: number;
  status: LoanStatus;
  systemDecision?: Record<string, unknown>;
  manualDecision?: "PENDING" | "APPROVED" | "REJECTED" | "MORE_INFORMATION_REQUIRED";
  manualNote?: string;
  disbursementInstitution: "VELO" | string;
  disbursementAccount?: Record<string, unknown>;
  signedAgreementUrl?: string;
  createdAt: string;
  updatedAt?: string;
  submittedAt?: string;
  approvedAt?: string;
}

export interface Loan {
  id: string;
  applicationId: string;
  borrowerId: string;
  principalNaira: number;
  totalInterestNaira: number;
  totalFeesNaira: number;
  totalRepaymentNaira: number;
  outstandingNaira: number;
  tenureDays: number;
  status: LoanStatus;
  disbursedAt?: string;
  dueAt?: string;
  paidAt?: string;
  providerTransfer?: Record<string, unknown>;
  providerReference?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface LoanSchedule {
  id: string;
  loanId: string;
  installmentNumber: number;
  dueDate: string;
  principalNaira: number;
  interestNaira: number;
  feesNaira: number;
  totalDueNaira: number;
  totalPaidNaira: number;
  status: "PENDING" | "PARTIALLY_PAID" | "PAID" | "OVERDUE" | "WRITTEN_OFF";
  createdAt: string;
  updatedAt?: string;
}

export interface Repayment {
  id: string;
  loanId: string;
  borrowerId: string;
  amountNaira: number;
  principalNaira?: number;
  interestNaira?: number;
  lateFeeNaira?: number;
  otherFeesNaira?: number;
  currency: "NGN";
  status: PaymentStatus;
  provider?: "flutterwave" | "manual";
  txRef?: string;
  providerReference?: string;
  channel?: string;
  onTime?: boolean;
  rawResponse?: Record<string, unknown>;
  verifiedAt?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface Payout {
  id: string;
  userId: string;
  investmentId?: string;
  payoutType: "INVESTMENT_MATURITY" | "EARLY_LIQUIDITY" | "MANUAL";
  principalNaira?: number;
  earningsNaira?: number;
  feesNaira?: number;
  amountNaira: number;
  currency: "NGN";
  status: PayoutStatus;
  payoutAccountSnapshot?: Record<string, unknown>;
  providerTransfer?: Record<string, unknown>;
  providerReference?: string;
  retryCount: number;
  lastAttemptAt?: string;
  error?: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CreditHistoryEvent {
  id: string;
  userId: string;
  loanId?: string;
  repaymentId?: string;
  eventType: "LOAN_APPLIED" | "LOAN_APPROVED" | "LOAN_DISBURSED" | "REPAYMENT_DUE" | "REPAYMENT_VERIFIED" | "REPAYMENT_LATE" | "LOAN_DEFAULTED" | "LOAN_REPAID" | "REPAYMENT_REVERSED";
  detail?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface CreditScore {
  id: string;
  userId: string;
  version: string;
  score: number;
  band: "VERY_POOR" | "POOR" | "FAIR" | "GOOD" | "VERY_GOOD";
  factors: Array<Record<string, unknown>>;
  rulesVersion?: string;
  createdAt: string;
}

export interface CreditReport {
  id: string;
  userId: string;
  provider: "prembly" | "manual";
  consentGrantedAt?: string;
  requestedAt?: string;
  reportReference?: string;
  status: "NOT_REQUESTED" | "PENDING" | "RECEIVED" | "FAILED";
  score?: number;
  normalizedFields?: Record<string, unknown>;
  redactedRaw?: Record<string, unknown>;
  expiresAt?: string;
  createdAt: string;
}

export interface OtpChallenge {
  id: string;
  userId: string;
  action: OtpAction;
  challengeHash: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  consumedAt?: string;
  createdAt: string;
  deliveryChannel: "SMS" | "WHATSAPP" | "EMAIL";
}

export interface PasswordResetToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  channel: NotificationChannel;
  template?: string;
  templateVersion?: string;
  kind?: string;
  subject?: string;
  content?: string;
  recipientMasked?: string;
  status: "PENDING" | "SENT" | "DELIVERED" | "FAILED" | "NOT_CONFIGURED";
  providerMessageId?: string;
  providerStatus?: string;
  idempotencyKey?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  error?: string;
  retryCount: number;
  createdAt: string;
  sentAt?: string;
  deliveredAt?: string;
  failedAt?: string;
}

export interface ProviderWebhookEvent {
  id?: string;
  provider: "flutterwave" | "prembly" | "kudi" | "meta";
  eventKey: string;
  event: Record<string, unknown>;
  processed?: boolean;
  processingError?: string;
  receivedAt: string;
  processedAt?: string;
}

export interface Consent {
  id: string;
  userId: string;
  consentType: "TERMS" | "PRIVACY" | "IDENTITY_VERIFICATION" | "CREDIT_REPORT" | "ELECTRONIC_COMMUNICATIONS" | "INVESTMENT_AGREEMENT" | "LOAN_AGREEMENT";
  consentedAt: string;
  withdrawnAt?: string;
  metadata?: Record<string, unknown>;
}

export interface LoanProduct {
  id: string;
  name: string;
  description?: string;
  minAmountNaira: number;
  maxAmountNaira: number;
  defaultTenureDays?: number;
  interestRatePercent: number;
  interestType: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED";
  processingFeePercent: number;
  lateFeePercent: number;
  lateFeeType: "ONE_TIME" | "COMPOUNDING_DAILY" | "COMPOUNDING_MONTHLY";
  gracePeriodDays: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt?: string;
}

export const users: User[] = [];
export const wallets: Wallet[] = [];
export const ledgerEntries: LedgerEntry[] = [];
export const walletTransactions: WalletTransaction[] = [];
export const kycCases: KycCase[] = [];
export const identityVerificationEvents: IdentityVerificationEvent[] = [];
export const documents: Document[] = [];
export const payoutAccounts: PayoutAccount[] = [];
export const investmentPlans: InvestmentPlan[] = [];
export const investments: Investment[] = [];
export const loanApplications: LoanApplication[] = [];
export const loans: Loan[] = [];
export const loanSchedules: LoanSchedule[] = [];
export const repayments: Repayment[] = [];
export const payouts: Payout[] = [];
export const creditHistory: CreditHistoryEvent[] = [];
export const creditScores: CreditScore[] = [];
export const creditReports: CreditReport[] = [];
export const otpChallenges: OtpChallenge[] = [];
export const passwordResetTokens: PasswordResetToken[] = [];
export const notifications: Notification[] = [];
export const providerEvents: ProviderWebhookEvent[] = [];
export const consents: Consent[] = [];
export const loanProducts: LoanProduct[] = [];

export function createWallet(userId: string): Wallet {
  const existing = wallets.find((w) => w.userId === userId);
  if (existing) return existing;
  const wallet: Wallet = {
    id: randomUUID(),
    userId,
    availableMinor: 0,
    heldMinor: 0,
    pendingDepositMinor: 0,
    pendingPayoutMinor: 0,
    totalCreditedMinor: 0,
    totalDebitedMinor: 0,
    currency: "NGN",
  };
  wallets.push(wallet);
  return wallet;
}

export function findUserByEmail(email: string): User | undefined {
  return users.find((user) => user.email === email.toLowerCase());
}

export function findWallet(userId: string): Wallet {
  return wallets.find((wallet) => wallet.userId === userId) ?? createWallet(userId);
}

export function findOrCreateKycCase(userId: string): KycCase {
  let kyc = kycCases.find((k) => k.userId === userId);
  if (!kyc) {
    kyc = {
      id: randomUUID(),
      userId,
      status: "NOT_STARTED",
      checklist: { bvn: false, nin: false, proofOfAddress: false, passport: false, signature: false },
      createdAt: new Date().toISOString(),
    };
    kycCases.push(kyc);
  }
  return kyc;
}

export function appendLedger(wallet: Wallet, entry: Omit<LedgerEntry, "id" | "walletId" | "userId" | "balanceAfterMinor" | "heldAfterMinor" | "createdAt" | "currency">): LedgerEntry {
  const newBalance = entry.direction === "CREDIT"
    ? wallet.availableMinor + entry.amountMinor
    : wallet.availableMinor - entry.amountMinor;
  const newHeld = entry.entryType === "INVESTMENT_LOCK"
    ? wallet.heldMinor + entry.amountMinor
    : entry.entryType === "INVESTMENT_RELEASE" || entry.entryType === "INVESTMENT_RETURN"
    ? wallet.heldMinor - entry.amountMinor
    : wallet.heldMinor;
  wallet.availableMinor = Math.max(0, newBalance);
  wallet.heldMinor = Math.max(0, newHeld);
  if (entry.direction === "CREDIT") {
    wallet.totalCreditedMinor += entry.amountMinor;
  } else {
    wallet.totalDebitedMinor += entry.amountMinor;
  }
  const record: LedgerEntry = {
    id: randomUUID(),
    walletId: wallet.id,
    userId: wallet.userId,
    balanceAfterMinor: wallet.availableMinor,
    heldAfterMinor: wallet.heldMinor,
    currency: "NGN",
    createdAt: new Date().toISOString(),
    ...entry,
  };
  ledgerEntries.push(record);
  return record;
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOtpCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export function seedInvestmentPlans(): void {
  if (investmentPlans.length > 0) return;
  const now = new Date().toISOString();
  const seedPlans: Omit<InvestmentPlan, "id" | "createdAt" | "updatedAt">[] = [
    { name: "Velo Flex 30", description: "Short-term 30-day plan with competitive returns", currency: "NGN", minAmountNaira: 10000, maxAmountNaira: 5000000, tenureDays: 30, annualRatePercent: 10, rateType: "ANNUALIZED", earlyLiquidityAllowed: false, earlyLiquidityFeePercent: 0, gatewayFeePercent: 0, forfeitInterestOnEarlyExit: false, isActive: true, allowNewInvestmentsAfterClose: false, version: 1, effectiveFrom: now },
    { name: "Velo Growth 90", description: "Quarterly growth plan with steady returns", currency: "NGN", minAmountNaira: 50000, maxAmountNaira: 10000000, tenureDays: 90, annualRatePercent: 12.5, rateType: "ANNUALIZED", earlyLiquidityAllowed: true, earlyLiquidityFeePercent: 2, gatewayFeePercent: 0.5, forfeitInterestOnEarlyExit: false, isActive: true, allowNewInvestmentsAfterClose: false, version: 1, effectiveFrom: now },
    { name: "Velo Max 180", description: "6-month plan with premium returns", currency: "NGN", minAmountNaira: 100000, maxAmountNaira: 20000000, tenureDays: 180, annualRatePercent: 15, rateType: "ANNUALIZED", earlyLiquidityAllowed: true, earlyLiquidityFeePercent: 3, gatewayFeePercent: 0.5, forfeitInterestOnEarlyExit: true, isActive: true, allowNewInvestmentsAfterClose: false, version: 1, effectiveFrom: now },
    { name: "Velo Prime 365", description: "Annual prime plan for maximum yield", currency: "NGN", minAmountNaira: 500000, maxAmountNaira: 50000000, tenureDays: 365, annualRatePercent: 18, rateType: "ANNUALIZED", earlyLiquidityAllowed: true, earlyLiquidityFeePercent: 5, gatewayFeePercent: 0.5, forfeitInterestOnEarlyExit: true, isActive: true, allowNewInvestmentsAfterClose: false, version: 1, effectiveFrom: now },
  ];
  for (const plan of seedPlans) {
    investmentPlans.push({ id: randomUUID(), createdAt: now, ...plan });
  }
}

export function seedLoanProducts(): void {
  if (loanProducts.length > 0) return;
  const now = new Date().toISOString();
  const seed: Omit<LoanProduct, "id" | "createdAt" | "updatedAt">[] = [
    { name: "Velo Personal Quick", description: "Fast personal loan for salaried individuals", minAmountNaira: 50000, maxAmountNaira: 2000000, defaultTenureDays: 90, interestRatePercent: 18, interestType: "SIMPLE_FLAT", processingFeePercent: 2, lateFeePercent: 1, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 3, isActive: true, version: 1 },
    { name: "Velo Business Boost", description: "Working capital for registered SMEs", minAmountNaira: 500000, maxAmountNaira: 10000000, defaultTenureDays: 180, interestRatePercent: 22, interestType: "REDUCING_BALANCE", processingFeePercent: 3, lateFeePercent: 0.5, lateFeeType: "COMPOUNDING_DAILY", gracePeriodDays: 5, isActive: true, version: 1 },
  ];
  for (const product of seed) {
    loanProducts.push({ id: randomUUID(), createdAt: now, ...product });
  }
}
