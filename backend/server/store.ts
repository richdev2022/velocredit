import { randomUUID, createHash } from "node:crypto";
import { randomInt } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { sql } from "./db.js";
import { decomposeAndUpsertAll, type EntityCounts, type Snapshot } from "./decompose.js";
import { rebuildFromDatabase } from "./rebuildFromDatabase.js";

export type Role = "INVESTOR" | "BORROWER" | "ADMIN" | "LOAN_MANAGER";
export const ADMIN_PERMISSIONS = ["overview", "users", "investors", "kyc", "payouts", "loan_applications", "loan_decisions", "loan_disbursements", "loan_repayments", "loan_notifications", "reconciliation", "audit", "staff", "settings", "reports", "investments"] as const;
export type AdminPermission = typeof ADMIN_PERMISSIONS[number];
export type KycStatus = "NOT_STARTED" | "IN_PROGRESS" | "PENDING_VERIFICATION" | "ACTION_REQUIRED" | "VERIFIED" | "PARTIALLY_VERIFIED" | "REJECTED" | "EXPIRED" | "SUSPENDED" | "REVIEWING";
export type LoanStatus = "DRAFT" | "IN_PROGRESS" | "SUBMITTED" | "KYC_PENDING" | "UNDER_REVIEW" | "MORE_INFORMATION_REQUIRED" | "APPROVED" | "REJECTED" | "DISBURSEMENT_PENDING" | "DISBURSED" | "ACTIVE" | "PAST_DUE" | "DEFAULTED" | "REPAID" | "CANCELLED" | "WRITTEN_OFF";
export type InvestmentStatus = "PENDING" | "ACTIVE" | "LIQUIDITY_REQUESTED" | "LIQUIDITY_APPROVED" | "MATURITY_PENDING" | "MATURED" | "PAYOUT_PENDING" | "PAID_OUT" | "CANCELLED" | "REJECTED" | "PAYOUT_FAILED" | "PAYOUT_ACCOUNT_REQUIRED";
export type PaymentStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PROVIDER_NOT_CONFIGURED" | "CANCELLED" | "DISPUTED" | "REVERSED";
export type PayoutStatus = "PENDING_PROVIDER_CONFIRMATION" | "SUCCESSFUL" | "FAILED" | "PENDING_APPROVAL" | "CANCELLED";
export type DocumentStatus = "PENDING_REVIEW" | "VERIFIED" | "REJECTED" | "EXPIRED";
export type OtpAction = "SIGNUP_VERIFY" | "LOGIN_STEP_UP" | "PAYOUT_ACCOUNT_CHANGE" | "EARLY_LIQUIDITY" | "PASSWORD_RESET" | "KYC_VERIFICATION" | "WITHDRAWAL" | "PROFILE_UPDATE";
export type NotificationChannel = "SMS" | "WHATSAPP" | "EMAIL" | "IN_APP";

export interface User {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  passwordHash: string;
  roles: Role[];
    adminPermissions?: AdminPermission[];
  kycStatus: KycStatus;
  createdAt: string;
  updatedAt?: string;
  lastLoginAt?: string;
  isActive?: boolean;
  preferredOtpChannel?: "SMS" | "WHATSAPP" | "EMAIL";
  otpLoginEnabled?: boolean;
  otpVerifiedAt?: string;
  dateOfBirth?: string;
  residentialAddress?: Record<string, unknown>;
  occupation?: string;
  sourceOfFunds?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLog {
  id: string;
  userId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  createdAt: string;
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
  entryType: "FUNDING" | "INVESTMENT_LOCK" | "INVESTMENT_RELEASE" | "INVESTMENT_RETURN" | "PAYOUT" | "FEE" | "MANUAL_ADJUSTMENT" | "REVERSAL" | "WITHDRAWAL_INITIATED" | "WITHDRAWAL_REVERSAL" | "WITHDRAWAL_SETTLEMENT";
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
  providerTransactionId?: string;
  txRef?: string;
  verifiedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
}

export type KycCategory = "BVN" | "NIN" | "LIVENESS" | "ADDRESS" | "PASSPORT" | "SIGNATURE";
export type KycCategoryStatus = "NOT_STARTED" | "PENDING" | "VERIFIED" | "REJECTED" | "PENDING_REVIEW";
export interface KycCategoryResult {
  status: KycCategoryStatus;
  reason?: string;
  updatedAt?: string;
}

export interface KycCase {
  id: string;
  userId: string;
  status: KycStatus;
  categoryResults?: Partial<Record<KycCategory, KycCategoryResult>>;
  bvn?: string;
  nin?: string;
  bvnVerifiedAt?: string;
  ninVerifiedAt?: string;
  livenessVerifiedAt?: string;
  livenessStatus?: string;
  livenessManualUploaded?: boolean;
  providerRequestId?: string;
  providerRaw?: Record<string, unknown>;
  submittedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  verifiedAt?: string;
  rejectionReason?: string;
  verifiedDetails?: Record<string, unknown>;
  identityPhoto?: string;
  identityPhotoUrl?: string;
  selfieImageData?: string;
  checklist: {
    bvn: boolean;
    nin: boolean;
    proofOfAddress: boolean;
    passport: boolean;
    signature: boolean;
    liveness: boolean;
  };
  createdAt: string;
  updatedAt?: string;
}

export interface IdentityVerificationEvent {
  id: string;
  kycCaseId: string;
  provider: "prembly" | "manual";
  verificationType: "BVN" | "NIN" | "LIVENESS" | "PASSPORT" | "ADDRESS" | "SIGNATURE";
  providerReference?: string;
  status: "PENDING" | "SUCCESS" | "FAILED" | "MANUAL_REVIEW" | "PENDING_REVIEW";
  matchScore?: number;
  rawResponse?: Record<string, unknown>;
  createdAt: string;
}

export interface Document {
  id: string;
  userId: string;
  applicationId?: string;
  documentSlot?: string;
  note?: string;
  documentType: "PASSPORT_PHOTO" | "PROOF_OF_ADDRESS" | "SIGNATURE" | "BVN_SLIP" | "NIN_SLIP" | "BUSINESS_REGISTRATION" | "ID_CARD_FRONT" | "ID_CARD_BACK" | "SELFIE_PHOTO";
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
  isDefault?: boolean;
  status: "PENDING_VERIFICATION" | "VERIFIED" | "REJECTED" | "EXPIRED";
  verifiedAt?: string;
  verificationReference?: string;
  createdAt: string;
  updatedAt?: string;
}
export type DisbursementAccountStatus = "ACTIVE" | "PENDING_APPROVAL" | "REJECTED";
export interface DisbursementAccount {
  id: string;
  borrowerId: string;
  bankName?: string;
  bankCode: string;
  accountNumber: string;
  accountName?: string;
  accountNameEnquiryResult?: string;
  status: DisbursementAccountStatus;
  verifiedAt?: string;
  verificationReference?: string;
  rejectionReason?: string | null;
  createdAt: string;
  updatedAt?: string;
}
export type DisbursementStatus = "PENDING" | "PROCESSING" | "SUCCESSFUL" | "FAILED" | "PENDING_APPROVAL";
export interface LoanDisbursement {
  id: string;
  loanId: string;
  applicationId?: string;
  borrowerId: string;
  amountNaira: number;
  currency: "NGN";
  bankCode?: string;
  bankName?: string;
  accountNumber?: string;
  accountName?: string;
  status: DisbursementStatus;
  narration?: string;
  providerTransfer?: Record<string, unknown> | null;
  providerReference?: string | null;
  error?: string | null;
  adminNote?: string | null;
  createdAt: string;
  updatedAt?: string;
  processedAt?: string;
  retryOfId?: string | null;
  retryCount?: number;
}
export type AccountChangeRequestType = "INVESTOR_PAYOUT_ACCOUNT" | "BORROWER_DISBURSEMENT_ACCOUNT";
export type AccountChangeRequestStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";
export interface AccountChangeRequest {
  id: string;
  userId: string;
  type: AccountChangeRequestType;
  status: AccountChangeRequestStatus;
  existingSnapshot?: Record<string, unknown> | null;
  newSnapshot: Record<string, unknown>;
  reason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
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

export type StageStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" | "PENDING_REVIEW" | "APPROVED" | "REJECTED";
export const LOAN_STAGES = [
  { key: "profile", label: "Profile Information" },
  { key: "employment", label: "Employment & Income" },
  { key: "bvn_nin", label: "BVN / NIN Verification" },
  { key: "address", label: "Proof of Address" },
  { key: "liveness", label: "Liveness Check" },
  { key: "loan_details", label: "Loan Terms" },
  { key: "documents", label: "Document Uploads" },
  { key: "disbursement_account", label: "Disbursement Account" },
  { key: "consent", label: "Consent & T&Cs" },
  { key: "credit_review", label: "Credit Review" },
  { key: "risk_review", label: "Risk Assessment" },
  { key: "approval", label: "Final Approval" },
] as const;
export type LoanStageKey = typeof LOAN_STAGES[number]["key"];

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
  stageStatuses: Partial<Record<LoanStageKey, StageStatus>>;
  stageRejectionNotes: Partial<Record<LoanStageKey, string>>;
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

export function seedLoanStageStatuses(app: LoanApplication): LoanApplication {
  if (!app.stageStatuses) app.stageStatuses = {};
  if (!app.stageRejectionNotes) app.stageRejectionNotes = {};
  for (const stage of LOAN_STAGES) {
    if (!app.stageStatuses[stage.key]) {
      app.stageStatuses[stage.key] = "NOT_STARTED";
    }
  }
  return app;
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
  outstandingPrincipalNaira?: number;
  outstandingInterestNaira?: number;
  adminNote?: string;
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

export type InvestorWithdrawalStatus = "PENDING_APPROVAL" | "PROCESSING" | "SUCCESSFUL" | "FAILED" | "REJECTED" | "CANCELLED";

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
  status: InvestorWithdrawalStatus;
  narration?: string;
  providerTransfer?: Record<string, unknown>;
  providerReference?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  processedAt?: string;
  retryCount?: number;
  lastAttemptAt?: string;
  idempotencyKey?: string;
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

export interface AdminLedgerEntry {
  id: string;
  entryType: "INVESTOR_FUNDING" | "INVESTMENT_PAYOUT" | "INVESTMENT_RETURN_CREDIT" | "WITHDRAWAL_FEE" | "PLATFORM_EARNING" | "MANUAL_ADJUSTMENT" | "REVERSAL" | "FUNDING_IN" | "WALLET_CREDIT" | "LOAN_DISBURSEMENT" | "LOAN_REPAYMENT_IN" | "INVESTMENT_RETURN";
  referenceId?: string;
  investorId?: string;
  borrowerId?: string;
  loanId?: string;
  amountMinor: number;
  direction: "DEBIT" | "CREDIT";
  balanceAfterMinor: number;
  currency: "NGN";
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface PlatformSettings {
  id: string;
  investorWithdrawalFeePercent: number;
  investorWithdrawalFeeFlatMinor: number;
  investorWithdrawalMinAmountNaira: number;
  investorEarningRateOverrides: Record<string, number>;
  defaultInvestmentAnnualRatePercent: number;
  updatedAt: string;
  createdAt: string;
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

export interface ApplicationDraft {
  id: string;
  userId: string;
  applicationId: string;
  applicantType: "PERSONAL" | "BUSINESS";
  data: Record<string, unknown>;
  lastSectionIndex: number;
  createdAt: string;
  updatedAt: string;
}

export type StoreKey =
  | "users" | "wallets" | "ledgerEntries" | "walletTransactions" | "kycCases"
  | "identityVerificationEvents" | "documents" | "payoutAccounts" | "investmentPlans"
  | "investments" | "loanApplications" | "loans" | "loanSchedules" | "repayments"
  | "payouts" | "creditHistory" | "creditScores" | "creditReports" | "otpChallenges"
  | "passwordResetTokens" | "notifications" | "providerEvents" | "consents" | "loanProducts" | "auditLogs"
  | "adminLedger" | "platformSettings" | "investorWithdrawals"
  | "disbursementAccounts" | "loanDisbursements" | "accountChangeRequests" | "applicationDrafts";

const storeKeys: StoreKey[] = [
  "users", "wallets", "ledgerEntries", "walletTransactions", "kycCases",
  "identityVerificationEvents", "documents", "payoutAccounts", "investmentPlans",
  "investments", "loanApplications", "loans", "loanSchedules", "repayments", "payouts",
  "creditHistory", "creditScores", "creditReports", "otpChallenges", "passwordResetTokens",
  "notifications", "providerEvents", "consents", "loanProducts", "auditLogs",
  "adminLedger", "platformSettings", "investorWithdrawals",
  "disbursementAccounts", "loanDisbursements", "accountChangeRequests", "applicationDrafts",
];

const rawState = {} as Record<StoreKey, unknown[]>;
const nestedProxyCache = new WeakMap<object, object>();
let hydrating = false;
let pendingPersist: ReturnType<typeof setTimeout> | undefined;
let persistInFlight: Promise<EntityCounts> | undefined;
const dirtyKeys = new Set<StoreKey>();
let nestedDirty = false;

export function isDirtySetEmptyForTestingOnly(): boolean {
  return dirtyKeys.size === 0 && !nestedDirty;
}
export function peekDirtyKeysForTestingOnly(): StoreKey[] {
  if (nestedDirty) return [...storeKeys];
  return [...dirtyKeys];
}

export function requestPersist(key?: StoreKey): void {
  if (hydrating || !sql) return;
  if (key) dirtyKeys.add(key);
  else nestedDirty = true;
  if (pendingPersist) clearTimeout(pendingPersist);
  pendingPersist = setTimeout(() => {
    pendingPersist = undefined;
    void persistStore().catch((error) => {
      console.error("[store/requestPersist] PostgreSQL persistence failed:", error);
    });
  }, 2000);
}

const appendToMultiIndex = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
};

export const indexes = {
  usersByEmail: new Map<string, User>(),
  walletsByUserId: new Map<string, Wallet>(),
  ledgerEntriesByWalletId: new Map<string, LedgerEntry[]>(),
  walletTransactionsByUserId: new Map<string, WalletTransaction[]>(),
  walletTransactionsByTxRef: new Map<string, WalletTransaction>(),
  kycCasesByUserId: new Map<string, KycCase>(),
  identityVerificationEventsByKycCaseId: new Map<string, IdentityVerificationEvent[]>(),
  documentsByUserId: new Map<string, Document[]>(),
  payoutAccountsByUserId: new Map<string, PayoutAccount[]>(),
  investmentsByInvestorId: new Map<string, Investment[]>(),
  investmentsByPlanId: new Map<string, Investment[]>(),
  loanApplicationsByBorrowerId: new Map<string, LoanApplication[]>(),
  loansByBorrowerId: new Map<string, Loan[]>(),
  loansByStatus: new Map<string, Loan[]>(),
  loansByApplicationId: new Map<string, Loan>(),
  loanSchedulesByLoanId: new Map<string, LoanSchedule[]>(),
  repaymentsByLoanId: new Map<string, Repayment[]>(),
  repaymentsByBorrowerId: new Map<string, Repayment[]>(),
  payoutsByUserId: new Map<string, Payout[]>(),
  payoutsByInvestmentId: new Map<string, Payout>(),
  creditHistoryByUserId: new Map<string, CreditHistoryEvent[]>(),
  creditScoresByUserId: new Map<string, CreditScore[]>(),
  creditReportsByUserId: new Map<string, CreditReport[]>(),
  notificationsByUserId: new Map<string, Notification[]>(),
  notificationsByIdempotencyKey: new Map<string, Notification>(),
  auditLogsByUserId: new Map<string, AuditLog[]>(),
  auditLogsByAction: new Map<string, AuditLog[]>(),
  adminLedgerByEntryType: new Map<string, AdminLedgerEntry[]>(),
  investorWithdrawalsByInvestorId: new Map<string, InvestorWithdrawal[]>(),
  disbursementAccountsByBorrowerId: new Map<string, DisbursementAccount[]>(),
  loanDisbursementsByLoanId: new Map<string, LoanDisbursement[]>(),
  consentsByUserId: new Map<string, Consent[]>(),
  otpChallengesByUserId: new Map<string, OtpChallenge[]>(),
  passwordResetTokensByUserId: new Map<string, PasswordResetToken[]>(),
  providerEventsByEventKey: new Map<string, ProviderWebhookEvent>(),
  accountChangeRequestsByUserId: new Map<string, AccountChangeRequest[]>(),
};

export function rebuildIndexes(): void {
  for (const map of Object.values(indexes) as Array<Map<unknown, unknown> | Map<unknown, unknown[]>>) {
    map.clear();
  }
  const seenEmails = new Set<string>();
  const dedupedUsers: typeof users = [];
  for (const u of users) {
    const key = u.email.toLowerCase();
    if (!seenEmails.has(key)) {
      seenEmails.add(key);
      dedupedUsers.push(u);
      indexes.usersByEmail.set(key, u);
    }
  }
  if (dedupedUsers.length !== users.length) {
    users.length = 0;
    users.push(...dedupedUsers);
  }
  const seenWallets = new Set<string>();
  const dedupedWallets: typeof wallets = [];
  for (const w of wallets) {
    if (!seenWallets.has(w.userId)) {
      seenWallets.add(w.userId);
      dedupedWallets.push(w);
      indexes.walletsByUserId.set(w.userId, w);
    }
  }
  if (dedupedWallets.length !== wallets.length) {
    wallets.length = 0;
    wallets.push(...dedupedWallets);
  }
  const seenKyc = new Set<string>();
  const dedupedKyc: typeof kycCases = [];
  for (const k of kycCases) {
    if (!seenKyc.has(k.userId)) {
      seenKyc.add(k.userId);
      dedupedKyc.push(k);
      indexes.kycCasesByUserId.set(k.userId, k);
    }
  }
  if (dedupedKyc.length !== kycCases.length) {
    kycCases.length = 0;
    kycCases.push(...dedupedKyc);
  }
  for (const e of ledgerEntries) appendToMultiIndex(indexes.ledgerEntriesByWalletId, e.walletId, e);
  for (const t of walletTransactions) {
    appendToMultiIndex(indexes.walletTransactionsByUserId, t.userId, t);
    if (t.txRef) indexes.walletTransactionsByTxRef.set(t.txRef, t);
  }
  for (const ev of identityVerificationEvents) appendToMultiIndex(indexes.identityVerificationEventsByKycCaseId, ev.kycCaseId, ev);
  for (const d of documents) appendToMultiIndex(indexes.documentsByUserId, d.userId, d);
  for (const pa of payoutAccounts) appendToMultiIndex(indexes.payoutAccountsByUserId, pa.userId, pa);
  for (const inv of investments) {
    appendToMultiIndex(indexes.investmentsByInvestorId, inv.investorId, inv);
    if (inv.planId) appendToMultiIndex(indexes.investmentsByPlanId, inv.planId, inv);
  }
  for (const la of loanApplications) appendToMultiIndex(indexes.loanApplicationsByBorrowerId, la.borrowerId, la);
  for (const ln of loans) {
    appendToMultiIndex(indexes.loansByBorrowerId, ln.borrowerId, ln);
    appendToMultiIndex(indexes.loansByStatus, String(ln.status), ln);
    indexes.loansByApplicationId.set(ln.applicationId, ln);
  }
  for (const s of loanSchedules) appendToMultiIndex(indexes.loanSchedulesByLoanId, s.loanId, s);
  for (const r of repayments) {
    appendToMultiIndex(indexes.repaymentsByLoanId, r.loanId, r);
    appendToMultiIndex(indexes.repaymentsByBorrowerId, r.borrowerId, r);
  }
  for (const p of payouts) {
    appendToMultiIndex(indexes.payoutsByUserId, p.userId, p);
    if (p.investmentId) indexes.payoutsByInvestmentId.set(p.investmentId, p);
  }
  for (const h of creditHistory) appendToMultiIndex(indexes.creditHistoryByUserId, h.userId, h);
  for (const s of creditScores) appendToMultiIndex(indexes.creditScoresByUserId, s.userId, s);
  for (const r of creditReports) appendToMultiIndex(indexes.creditReportsByUserId, r.userId, r);
  for (const n of notifications) {
    appendToMultiIndex(indexes.notificationsByUserId, n.userId, n);
    if (n.idempotencyKey) indexes.notificationsByIdempotencyKey.set(n.idempotencyKey, n);
  }
  for (const a of auditLogs) {
    if (a.userId) appendToMultiIndex(indexes.auditLogsByUserId, a.userId, a);
    appendToMultiIndex(indexes.auditLogsByAction, a.action, a);
  }
  for (const e of adminLedger) appendToMultiIndex(indexes.adminLedgerByEntryType, e.entryType, e);
  for (const w of investorWithdrawals) appendToMultiIndex(indexes.investorWithdrawalsByInvestorId, w.investorId, w);
  for (const da of disbursementAccounts) appendToMultiIndex(indexes.disbursementAccountsByBorrowerId, da.borrowerId, da);
  for (const d of loanDisbursements) appendToMultiIndex(indexes.loanDisbursementsByLoanId, d.loanId, d);
  for (const c of consents) appendToMultiIndex(indexes.consentsByUserId, c.userId, c);
  for (const o of otpChallenges) appendToMultiIndex(indexes.otpChallengesByUserId, o.userId, o);
  for (const pr of passwordResetTokens) appendToMultiIndex(indexes.passwordResetTokensByUserId, pr.userId, pr);
  for (const pe of providerEvents) indexes.providerEventsByEventKey.set(pe.eventKey, pe);
  for (const acr of accountChangeRequests) appendToMultiIndex(indexes.accountChangeRequestsByUserId, acr.userId, acr);
}

function syncAfterMutation<T>(key: StoreKey, _values: T[]): void {
  if (hydrating) return;
  rebuildIndexes();
  requestPersist(key);
}

function wrapNested<T>(value: T, key: StoreKey): T {
  if (typeof value !== "object" || value === null) return value;
  const existing = nestedProxyCache.get(value);
  if (existing) return existing as T;
  const proxy = new Proxy(value as object, {
    get(target, property, receiver) {
      return wrapNested(Reflect.get(target, property, receiver), key);
    },
    set(target, property, nextValue, receiver) {
      const result = Reflect.set(target, property, wrapNested(nextValue, key), receiver);
      requestPersist(key);
      return result;
    },
    deleteProperty(target, property) {
      const result = Reflect.deleteProperty(target, property);
      requestPersist(key);
      return result;
    },
  });
  nestedProxyCache.set(value as object, proxy);
  return proxy as T;
}

function createPersistentArray<T>(key: StoreKey): T[] {
  const target: T[] = [];
  rawState[key] = target;
  return new Proxy(target, {
    get(array, property, receiver) {
      return wrapNested(Reflect.get(array, property, receiver), key);
    },
    set(array, property, value, receiver) {
      const result = Reflect.set(array, property, wrapNested(value, key), receiver);
      syncAfterMutation(key, array);
      return result;
    },
    deleteProperty(array, property) {
      const result = Reflect.deleteProperty(array, property);
      syncAfterMutation(key, array);
      return result;
    },
  });
}

export const users = createPersistentArray<User>("users");
export const wallets = createPersistentArray<Wallet>("wallets");
export const ledgerEntries = createPersistentArray<LedgerEntry>("ledgerEntries");
export const walletTransactions = createPersistentArray<WalletTransaction>("walletTransactions");
export const kycCases = createPersistentArray<KycCase>("kycCases");
export const identityVerificationEvents = createPersistentArray<IdentityVerificationEvent>("identityVerificationEvents");
export const documents = createPersistentArray<Document>("documents");
export const payoutAccounts = createPersistentArray<PayoutAccount>("payoutAccounts");
export const investmentPlans = createPersistentArray<InvestmentPlan>("investmentPlans");
export const investments = createPersistentArray<Investment>("investments");
export const loanApplications = createPersistentArray<LoanApplication>("loanApplications");
export const loans = createPersistentArray<Loan>("loans");
export const loanSchedules = createPersistentArray<LoanSchedule>("loanSchedules");
export const repayments = createPersistentArray<Repayment>("repayments");
export const payouts = createPersistentArray<Payout>("payouts");
export const creditHistory = createPersistentArray<CreditHistoryEvent>("creditHistory");
export const creditScores = createPersistentArray<CreditScore>("creditScores");
export const creditReports = createPersistentArray<CreditReport>("creditReports");
export const otpChallenges = createPersistentArray<OtpChallenge>("otpChallenges");
export const passwordResetTokens = createPersistentArray<PasswordResetToken>("passwordResetTokens");
export const notifications = createPersistentArray<Notification>("notifications");
export const providerEvents = createPersistentArray<ProviderWebhookEvent>("providerEvents");
export const consents = createPersistentArray<Consent>("consents");
export const loanProducts = createPersistentArray<LoanProduct>("loanProducts");
export const auditLogs = createPersistentArray<AuditLog>("auditLogs");
export const adminLedger = createPersistentArray<AdminLedgerEntry>("adminLedger");
export const platformSettings = createPersistentArray<PlatformSettings>("platformSettings");
export const investorWithdrawals = createPersistentArray<InvestorWithdrawal>("investorWithdrawals");
export const disbursementAccounts = createPersistentArray<DisbursementAccount>("disbursementAccounts");
export const loanDisbursements = createPersistentArray<LoanDisbursement>("loanDisbursements");
export const accountChangeRequests = createPersistentArray<AccountChangeRequest>("accountChangeRequests");
export const applicationDrafts = createPersistentArray<ApplicationDraft>("applicationDrafts");

const collections: Record<StoreKey, unknown[]> = {
  users, wallets, ledgerEntries, walletTransactions, kycCases, identityVerificationEvents,
  documents, payoutAccounts, investmentPlans, investments, loanApplications, loans,
  loanSchedules, repayments, payouts, creditHistory, creditScores, creditReports,
  otpChallenges, passwordResetTokens, notifications, providerEvents, consents, loanProducts, auditLogs,
  adminLedger, platformSettings, investorWithdrawals,
  disbursementAccounts, loanDisbursements, accountChangeRequests, applicationDrafts,
};

function snapshotStore(): Record<StoreKey, unknown[]> {
  return Object.fromEntries(storeKeys.map((key) => [key, rawState[key]])) as Record<StoreKey, unknown[]>;
}

async function persistStoreNow(): Promise<EntityCounts> {
  if (!sql) throw new Error("PostgreSQL is not configured.");
  if (pendingPersist) {
    clearTimeout(pendingPersist);
    pendingPersist = undefined;
  }
  const snap = snapshotStore();
  const changedKeys = nestedDirty || dirtyKeys.size === 0 ? [...storeKeys] : [...dirtyKeys];
  const counts = await decomposeAndUpsertAll(sql, snap, changedKeys);
  await sql.query(
    "INSERT INTO runtime_state (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = CURRENT_TIMESTAMP",
    ["default", JSON.stringify(snap)]
  );
  dirtyKeys.clear();
  nestedDirty = false;
  return counts;
}

export async function persistStore(): Promise<EntityCounts> {
  const previous = persistInFlight ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => persistStoreNow());
  persistInFlight = current;
  try {
    return await current;
  } finally {
    if (persistInFlight === current) persistInFlight = undefined;
  }
}

function applySnapshotToCollections(snap: Record<StoreKey, unknown[]>): void {
  hydrating = true;
  for (const key of storeKeys) {
    const values = snap[key];
    if (Array.isArray(values)) collections[key].push(...values);
  }
  hydrating = false;
}

function snapshotIsMeaningful(snap: Record<string, unknown[]> | null): boolean {
  if (!snap) return false;
  for (const key of Object.keys(snap)) {
    const arr = (snap as Record<string, unknown[]>)[key];
    if (Array.isArray(arr) && arr.length > 0) return true;
  }
  return false;
}

export async function initializeStore(): Promise<void> {
  if (!sql) return;

  const rebuildSnap = await rebuildFromDatabase(sql as unknown as NeonQueryFunction<false, false>);
  const usedRelationalSource = snapshotIsMeaningful(rebuildSnap as unknown as Record<string, unknown[]>);

  if (usedRelationalSource) {
    applySnapshotToCollections(rebuildSnap as unknown as Record<StoreKey, unknown[]>);
  } else {
    const rows = await sql.query("SELECT state FROM runtime_state WHERE id = $1", ["default"]) as Array<{ state: Record<string, unknown[]> | string }>;
    const savedState = rows[0]?.state;
    if (savedState) {
      const parsed = typeof savedState === "string" ? JSON.parse(savedState) as Record<string, unknown[]> : savedState;
      applySnapshotToCollections(parsed);
    } else {
      await persistStore();
    }
  }

  for (const app of loanApplications) {
    seedLoanStageStatuses(app);
  }

  rebuildIndexes();
  seedDefaultCatalog();
  seedAdminLedgerOpeningBalance(0);

  try {
    await decomposeAndUpsertAll(sql as unknown as NeonQueryFunction<false, false>, snapshotStore(), undefined);
  } catch (e) {
    console.error("[store/initializeStore] post-load full decompose pass FAILED:", e);
  }

  dirtyKeys.clear();
  nestedDirty = false;
}

export function createWallet(userId: string): Wallet {
  const existing = indexes.walletsByUserId.get(userId);
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
  return indexes.usersByEmail.get(email.toLowerCase());
}

export function findWallet(userId: string): Wallet {
  return indexes.walletsByUserId.get(userId) ?? createWallet(userId);
}

export function findOrCreateKycCase(userId: string): KycCase {
  let kyc = indexes.kycCasesByUserId.get(userId);
  if (!kyc) {
    kyc = {
      id: randomUUID(),
      userId,
      status: "NOT_STARTED",
      checklist: { bvn: false, nin: false, proofOfAddress: false, passport: false, signature: false, liveness: false },
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
  const newHeld = entry.entryType === "INVESTMENT_LOCK" || entry.entryType === "WITHDRAWAL_INITIATED"
    ? wallet.heldMinor + entry.amountMinor
    : entry.entryType === "INVESTMENT_RELEASE" || entry.entryType === "INVESTMENT_RETURN" || entry.entryType === "WITHDRAWAL_REVERSAL" || entry.entryType === "WITHDRAWAL_SETTLEMENT"
    ? wallet.heldMinor - (entry.entryType === "WITHDRAWAL_SETTLEMENT" ? Number(entry.metadata?.releasedAmountMinor ?? 0) : entry.amountMinor)
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

export function settleWalletDeposit(params: {
  txRef: string;
  providerReference?: string;
  providerTransactionId?: string;
}): { ok: boolean; tx?: WalletTransaction; wallet?: Wallet; user?: User; reason?: string } {
  const tx = indexes.walletTransactionsByTxRef.get(params.txRef);
  if (!tx || tx.type !== "DEPOSIT") return { ok: false, reason: `No pending deposit found for txRef=${params.txRef}` };
  if (tx.status === "SUCCESSFUL") {
    return { ok: true, tx, reason: "already_settled" };
  }
  if (!["PENDING", "PENDING_PROVIDER_CONFIRMATION", "PROVIDER_NOT_CONFIGURED"].includes(String(tx.status))) {
    return { ok: false, reason: `Deposit status=${tx.status} is not settleable` };
  }
  const user = indexes.usersByEmail.size > 0 ? (users.find((u) => u.id === tx.userId) ?? undefined) : undefined;
  const wallet = findWallet(tx.userId);
  const now = new Date().toISOString();
  wallet.pendingDepositMinor = Math.max(0, wallet.pendingDepositMinor - tx.amountMinor);
  appendAdminLedger({
    entryType: "FUNDING_IN",
    referenceId: tx.id,
    investorId: tx.userId,
    amountMinor: tx.amountMinor,
    direction: "CREDIT",
    description: `Admin ledger credit for investor float funding received - txRef: ${params.txRef}`,
    metadata: {
      provider: tx.provider ?? "provider",
      providerReference: params.providerReference,
      providerTransactionId: params.providerTransactionId,
      txRef: params.txRef,
    },
  });
  appendAdminLedger({
    entryType: "WALLET_CREDIT",
    referenceId: tx.id,
    investorId: tx.userId,
    amountMinor: tx.amountMinor,
    direction: "DEBIT",
    description: `Admin ledger debit to credit investor wallet - txRef: ${params.txRef}`,
    metadata: {
      provider: tx.provider ?? "provider",
      providerReference: params.providerReference,
      providerTransactionId: params.providerTransactionId,
      txRef: params.txRef,
    },
  });
  appendLedger(wallet, {
    entryType: "FUNDING",
    referenceId: tx.id,
    amountMinor: tx.amountMinor,
    direction: "CREDIT",
    description: `Wallet funding via ${tx.provider ?? "provider"}${params.providerTransactionId ? ` (${params.providerTransactionId})` : ""}`,
    metadata: { txRef: params.txRef, providerReference: params.providerReference, providerTransactionId: params.providerTransactionId },
  });
  tx.status = "SUCCESSFUL";
  tx.providerReference = params.providerReference ?? tx.providerReference;
  tx.providerTransactionId = params.providerTransactionId ?? tx.providerTransactionId;
  tx.verifiedAt = now;
  tx.updatedAt = now;
  const idx = walletTransactions.indexOf(tx);
  if (idx >= 0) walletTransactions[idx] = tx;
  return { ok: true, tx, wallet, user };
}

export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateOtpCode(): string {
  return randomInt(100000, 1_000_000).toString();
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

let adminLedgerBalanceCache = 0;
let adminLedgerBalanceDirty = true;

export function getAdminLedgerBalanceMinor(): number {
  if (adminLedgerBalanceDirty) {
    let balance = 0;
    for (const entry of adminLedger) {
      balance += entry.direction === "CREDIT" ? entry.amountMinor : -entry.amountMinor;
    }
    adminLedgerBalanceCache = Math.max(0, balance);
    adminLedgerBalanceDirty = false;
  }
  return adminLedgerBalanceCache;
}

export function appendAdminLedger(entry: Omit<AdminLedgerEntry, "id" | "balanceAfterMinor" | "currency" | "createdAt">): AdminLedgerEntry {
  const currentBalance = getAdminLedgerBalanceMinor();
  const newBalance = entry.direction === "CREDIT"
    ? currentBalance + entry.amountMinor
    : currentBalance - entry.amountMinor;
  adminLedgerBalanceCache = Math.max(0, newBalance);
  const record: AdminLedgerEntry = {
    id: randomUUID(),
    balanceAfterMinor: adminLedgerBalanceCache,
    currency: "NGN",
    createdAt: new Date().toISOString(),
    ...entry,
  };
  adminLedger.push(record);
  return record;
}

export function seedAdminLedgerOpeningBalance(openingBalanceMinor: number): void {
  if (adminLedger.length > 0) return;
  if (openingBalanceMinor <= 0) return;
  adminLedgerBalanceDirty = true;
  appendAdminLedger({
    entryType: "MANUAL_ADJUSTMENT",
    amountMinor: openingBalanceMinor,
    direction: "CREDIT",
    description: "Opening balance for admin operating ledger",
  });
}

export function getPlatformSettings(): PlatformSettings {
  if (platformSettings.length > 0) {
    const existing = platformSettings[0];
    if (existing.investorWithdrawalMinAmountNaira === undefined) {
      existing.investorWithdrawalMinAmountNaira = 200;
    }
    return existing;
  }
  const now = new Date().toISOString();
  const defaults: PlatformSettings = {
    id: randomUUID(),
    investorWithdrawalFeePercent: 1,
    investorWithdrawalFeeFlatMinor: 0,
    investorWithdrawalMinAmountNaira: 200,
    investorEarningRateOverrides: {},
    defaultInvestmentAnnualRatePercent: 12,
    updatedAt: now,
    createdAt: now,
  };
  platformSettings.push(defaults);
  return defaults;
}

export function updatePlatformSettings(updates: Partial<Pick<PlatformSettings, "investorWithdrawalFeePercent" | "investorWithdrawalFeeFlatMinor" | "investorWithdrawalMinAmountNaira" | "investorEarningRateOverrides" | "defaultInvestmentAnnualRatePercent">>): PlatformSettings {
  const settings = getPlatformSettings();
  if (updates.investorWithdrawalFeePercent !== undefined) {
    settings.investorWithdrawalFeePercent = Math.max(0, Math.min(100, Number(updates.investorWithdrawalFeePercent)));
  }
  if (updates.investorWithdrawalFeeFlatMinor !== undefined) {
    settings.investorWithdrawalFeeFlatMinor = Math.max(0, Number(updates.investorWithdrawalFeeFlatMinor));
  }
  if (updates.investorWithdrawalMinAmountNaira !== undefined) {
    settings.investorWithdrawalMinAmountNaira = Math.max(200, Number(updates.investorWithdrawalMinAmountNaira));
  }
  if (updates.investorEarningRateOverrides !== undefined) {
    settings.investorEarningRateOverrides = { ...updates.investorEarningRateOverrides };
  }
  if (updates.defaultInvestmentAnnualRatePercent !== undefined) {
    settings.defaultInvestmentAnnualRatePercent = Math.max(0, Math.min(100, Number(updates.defaultInvestmentAnnualRatePercent)));
  }
  settings.updatedAt = new Date().toISOString();
  return settings;
}

export function setInvestorEarningRateOverride(investorId: string, annualRatePercent: number): void {
  const settings = getPlatformSettings();
  const rate = Math.max(0, Math.min(100, Number(annualRatePercent)));
  if (rate > 0) {
    settings.investorEarningRateOverrides[investorId] = rate;
  } else {
    delete settings.investorEarningRateOverrides[investorId];
  }
  settings.updatedAt = new Date().toISOString();
}

export function getEffectiveInvestorRate(investorId: string, planRatePercent: number): number {
  const settings = getPlatformSettings();
  const override = settings.investorEarningRateOverrides[investorId];
  return override ?? planRatePercent ?? settings.defaultInvestmentAnnualRatePercent;
}

export function seedDefaultCatalog(): void {
  seedInvestmentPlans();
  seedLoanProducts();
}

export type JobStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

export type JobRun = {
  id: string;
  jobName: string;
  status: JobStatus;
  startedAt: string;
  completedAt?: string;
  recordsProcessed?: number;
  error?: string;
  metadata?: Record<string, unknown>;
};

const _sqlMaybe = () => sql as unknown as NeonQueryFunction<false, false> | null;

export async function recordJobStart(jobName: string, metadata?: Record<string, unknown>): Promise<string> {
  const db = _sqlMaybe();
  const id = randomUUID();
  if (db) {
    try {
      await db.query(
        `INSERT INTO job_runs (id, job_name, status, started_at, records_processed, metadata)
         VALUES ($1, $2, 'RUNNING', $3, 0, $4::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [id, jobName, new Date(), metadata ? JSON.stringify(metadata) : "{}"]
      );
    } catch (e) {
      console.error("[store/recordJobStart] SQL insert failed:", e);
    }
  }
  return id;
}

export async function recordJobComplete(
  jobId: string,
  status: JobStatus,
  recordsProcessed = 0,
  metadata?: Record<string, unknown>,
  error?: string
): Promise<void> {
  const db = _sqlMaybe();
  if (!db) return;
  try {
    await db.query(
      `UPDATE job_runs
       SET status = $1::text,
           completed_at = CURRENT_TIMESTAMP,
           records_processed = $2,
           metadata = COALESCE($3::jsonb, metadata),
           error = $4
       WHERE id = $5`,
      [status, recordsProcessed, metadata ? JSON.stringify(metadata) : null, error ?? null, jobId]
    );
  } catch (e) {
    console.error("[store/recordJobComplete] SQL update failed:", e);
  }
}

export async function listRecentJobRuns(limit = 50): Promise<Array<Record<string, unknown>>> {
  const db = _sqlMaybe();
  if (!db) return [];
  try {
    const rows = await db.query(
      `SELECT id, job_name, status, started_at, completed_at, records_processed, error, metadata
       FROM job_runs ORDER BY started_at DESC LIMIT $1`,
      [limit]
    ) as unknown as Array<Record<string, unknown>>;
    return rows;
  } catch (e) {
    console.error("[store/listRecentJobRuns] query failed:", e);
    return [];
  }
}

export async function findLastJobRun(jobName: string): Promise<Record<string, unknown> | null> {
  const db = _sqlMaybe();
  if (!db) return null;
  try {
    const rows = await db.query(
      `SELECT id, job_name, status, started_at, completed_at, records_processed, error, metadata
       FROM job_runs WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1`,
      [jobName]
    ) as unknown as Array<Record<string, unknown>>;
    return rows[0] ?? null;
  } catch (e) {
    console.error("[store/findLastJobRun] query failed:", e);
    return null;
  }
}

export async function decomposeRuntimeStateIntoTables(
  scopeKeys?: StoreKey[]
): Promise<EntityCounts | null> {
  const db = _sqlMaybe();
  if (!db) return null;
  const snap = snapshotStore();
  return decomposeAndUpsertAll(db, snap, scopeKeys);
}

export async function reloadStoreFromRelationalTables(): Promise<boolean> {
  const db = _sqlMaybe();
  if (!db) return false;
  const snap = await rebuildFromDatabase(db);
  if (!snapshotIsMeaningful(snap as unknown as Record<string, unknown[]>)) return false;
  hydrating = true;
  for (const key of storeKeys) {
    collections[key].length = 0;
  }
  hydrating = false;
  applySnapshotToCollections(snap as unknown as Record<StoreKey, unknown[]>);
  for (const app of loanApplications) {
    seedLoanStageStatuses(app);
  }
  rebuildIndexes();
  return true;
}

export { storeKeys };
