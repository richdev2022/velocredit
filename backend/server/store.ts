import { randomUUID, createHash } from "node:crypto";
import { randomInt } from "node:crypto";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { sql } from "./db.js";
import { decomposeAndUpsertAll, type EntityCounts, type Snapshot } from "./decompose.js";
import { rebuildFromDatabase, rebuildLoanProductsFromDatabase } from "./rebuildFromDatabase.js";

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
export type NotificationChannel = "SMS" | "EMAIL" | "IN_APP";

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
  preferredOtpChannel?: "SMS" | "EMAIL";
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
  entryType: "FUNDING" | "INVESTMENT_LOCK" | "INVESTMENT_RELEASE" | "INVESTMENT_RETURN" | "PAYOUT" | "FEE" | "MANUAL_ADJUSTMENT" | "REVERSAL" | "WITHDRAWAL_INITIATED" | "WITHDRAWAL_REVERSAL" | "WITHDRAWAL_SETTLEMENT" | "HOLD_RELEASE" | "HOLD_RESTORE";
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
  provider: "google_drive" | "s3" | "cloudinary" | "manual" | "inline";
  providerFileId: string;
  /**
   * Inline base64 data URL kept on the record while the archive upload
   * (Google Drive) has not completed — or when Drive is unavailable — so the
   * document is immediately durable, viewable and survives restarts.
   */
  inlineData?: string;
  /** Set when the background archive upload failed; inlineData remains authoritative. */
  uploadError?: string;
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
export type AccountChangeRequestStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "AUTO_APPROVED";
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

/**
 * Immutable snapshot of the loan-product terms attached to an application or
 * loan at the moment the terms were locked in.
 *
 * BACKWARD COMPATIBILITY CONTRACT: products can later be renamed, edited or
 * deactivated by the admin — the snapshot preserves what the borrower actually
 * saw/agreed to so loan information never renders empty for ongoing loans.
 */
export interface LoanProductSnapshot {
  productId?: string;
  productName: string;
  minAmountNaira?: number;
  maxAmountNaira?: number;
  defaultTenureDays?: number;
  interestRatePercent?: number;
  interestType?: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED";
  processingFeePercent?: number;
  lateFeePercent?: number;
  lateFeeType?: "ONE_TIME" | "COMPOUNDING_DAILY" | "COMPOUNDING_MONTHLY";
  gracePeriodDays?: number;
  capturedAt?: string;
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
  /** Product the application is being processed under (may be a stale id — the resolver re-maps intelligently). */
  loanProductId?: string;
  /** Terms captured when the product was linked; rendered when the product row is gone/renamed. */
  productSnapshot?: LoanProductSnapshot;
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
  /** Product the loan was created under (stale-id tolerant — see resolver). */
  loanProductId?: string;
  /** Terms snapshot captured at approval; survives later product edits/renames. */
  productSnapshot?: LoanProductSnapshot;
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
  /** Disbursement failed because Flutterwave rejected the borrower's bank
   *  account — the customer must re-provide a valid account from Settings
   *  (admin can also trigger this request explicitly). */
  disbursementAccountNeedsUpdate?: boolean;
  disbursementAccountRequestedAt?: string;
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
  deliveryChannel: "SMS" | "EMAIL";
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
  entryType: "INVESTOR_FUNDING" | "INVESTMENT_PAYOUT" | "INVESTMENT_RETURN_CREDIT" | "WITHDRAWAL_FEE" | "PLATFORM_EARNING" | "MANUAL_ADJUSTMENT" | "REVERSAL" | "FUNDING_IN" | "WALLET_CREDIT" | "LOAN_DISBURSEMENT" | "LOAN_DISBURSEMENT_REVERSAL" | "LOAN_REPAYMENT_IN" | "INVESTMENT_RETURN" | "WITHDRAWAL_OUT" | "WITHDRAWAL_OUT_REVERSAL";
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

export interface PlatformAnnouncement {
  id: string;
  message: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface PlatformBanner {
  id: string;
  name: string;
  /** Data URL (base64) so the banner survives both in-memory and Postgres (jsonb) persistence. */
  imageData: string;
  linkUrl?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt?: string;
}

export interface PlatformSettings {
  id: string;
  investorWithdrawalFeePercent: number;
  investorWithdrawalFeeFlatMinor: number;
  investorWithdrawalMinAmountNaira: number;
  investorEarningRateOverrides: Record<string, number>;
  defaultInvestmentAnnualRatePercent: number;
  /** When true, non-admin sign-in is blocked with a maintenance modal and every active user is emailed. */
  maintenanceMode?: boolean;
  maintenanceMessage?: string;
  maintenanceUpdatedAt?: string;
  announcements?: PlatformAnnouncement[];
  banners?: PlatformBanner[];
  /** Guards the one-time default banners/announcement seed so admin deletions stick. */
  engagementSeeded?: boolean;
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
    // Hole-tolerant: a half-mutated array must never crash the rebuild.
    if (!u || typeof u.email !== "string") continue;
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
    if (!w || typeof w.userId !== "string") continue;
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
    if (!k || typeof k.userId !== "string") continue;
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

const lastIndexedIndex = {} as Record<StoreKey, number | undefined>;

function syncAfterMutation<T>(key: StoreKey, _values: T[], property?: string | symbol, priorLength?: number): void {
  if (hydrating) return;
  // Hot path: appending a brand-new tail element (arr.push(x), arr[arr.length] = x).
  // Index just the new item instead of rebuilding every index across every
  // collection — the old full rebuild per push made every mutation O(total rows).
  if (
    typeof property === "string" &&
    /^\d+$/.test(property) &&
    priorLength !== undefined &&
    Number(property) === priorLength
  ) {
    const arr = rawState[key] as T[];
    const item = arr[Number(property)];
    if (item !== undefined) {
      indexSingleItem(key, item);
      lastIndexedIndex[key] = Number(property);
      requestPersist(key);
      return;
    }
  }
  // Length changes, replacements, deletes and bulk splices: do the safe full rebuild.
  if (property === "length" && priorLength !== undefined) {
    const arr = rawState[key] as unknown[];
    const newLength = arr.length;
    if (newLength === priorLength) return; // no-op (e.g. the trailing length set of push)
    if (newLength === priorLength + 1 && lastIndexedIndex[key] === newLength - 1) {
      return; // tail of a push — the item was already indexed above
    }
  }
  lastIndexedIndex[key] = undefined;
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

// Mirrors the per-item work of rebuildIndexes() for a single appended element.
function indexSingleItem<T>(key: StoreKey, item: T): void {
  const wrapped = wrapNested(item, key);
  switch (key) {
    case "users": {
      const u = wrapped as unknown as User;
      const emailKey = u.email.toLowerCase();
      if (!indexes.usersByEmail.has(emailKey)) indexes.usersByEmail.set(emailKey, u);
      break;
    }
    case "wallets": {
      const w = wrapped as unknown as Wallet;
      if (!indexes.walletsByUserId.has(w.userId)) indexes.walletsByUserId.set(w.userId, w);
      break;
    }
    case "kycCases": {
      const k = wrapped as unknown as KycCase;
      if (!indexes.kycCasesByUserId.has(k.userId)) indexes.kycCasesByUserId.set(k.userId, k);
      break;
    }
    case "ledgerEntries":
      appendToMultiIndex(indexes.ledgerEntriesByWalletId, (wrapped as unknown as LedgerEntry).walletId, wrapped as unknown as LedgerEntry);
      break;
    case "walletTransactions": {
      const t = wrapped as unknown as WalletTransaction;
      appendToMultiIndex(indexes.walletTransactionsByUserId, t.userId, t);
      if (t.txRef) indexes.walletTransactionsByTxRef.set(t.txRef, t);
      break;
    }
    case "identityVerificationEvents":
      appendToMultiIndex(indexes.identityVerificationEventsByKycCaseId, (wrapped as unknown as IdentityVerificationEvent).kycCaseId, wrapped as unknown as IdentityVerificationEvent);
      break;
    case "documents":
      appendToMultiIndex(indexes.documentsByUserId, (wrapped as unknown as Document).userId, wrapped as unknown as Document);
      break;
    case "payoutAccounts":
      appendToMultiIndex(indexes.payoutAccountsByUserId, (wrapped as unknown as PayoutAccount).userId, wrapped as unknown as PayoutAccount);
      break;
    case "investments": {
      const inv = wrapped as unknown as Investment;
      appendToMultiIndex(indexes.investmentsByInvestorId, inv.investorId, inv);
      if (inv.planId) appendToMultiIndex(indexes.investmentsByPlanId, inv.planId, inv);
      break;
    }
    case "loanApplications":
      appendToMultiIndex(indexes.loanApplicationsByBorrowerId, (wrapped as unknown as LoanApplication).borrowerId, wrapped as unknown as LoanApplication);
      break;
    case "loans": {
      const ln = wrapped as unknown as Loan;
      appendToMultiIndex(indexes.loansByBorrowerId, ln.borrowerId, ln);
      appendToMultiIndex(indexes.loansByStatus, String(ln.status), ln);
      indexes.loansByApplicationId.set(ln.applicationId, ln);
      break;
    }
    case "loanSchedules":
      appendToMultiIndex(indexes.loanSchedulesByLoanId, (wrapped as unknown as LoanSchedule).loanId, wrapped as unknown as LoanSchedule);
      break;
    case "repayments": {
      const r = wrapped as unknown as Repayment;
      appendToMultiIndex(indexes.repaymentsByLoanId, r.loanId, r);
      appendToMultiIndex(indexes.repaymentsByBorrowerId, r.borrowerId, r);
      break;
    }
    case "payouts": {
      const p = wrapped as unknown as Payout;
      appendToMultiIndex(indexes.payoutsByUserId, p.userId, p);
      if (p.investmentId) indexes.payoutsByInvestmentId.set(p.investmentId, p);
      break;
    }
    case "creditHistory":
      appendToMultiIndex(indexes.creditHistoryByUserId, (wrapped as unknown as CreditHistoryEvent).userId, wrapped as unknown as CreditHistoryEvent);
      break;
    case "creditScores":
      appendToMultiIndex(indexes.creditScoresByUserId, (wrapped as unknown as CreditScore).userId, wrapped as unknown as CreditScore);
      break;
    case "creditReports":
      appendToMultiIndex(indexes.creditReportsByUserId, (wrapped as unknown as CreditReport).userId, wrapped as unknown as CreditReport);
      break;
    case "notifications": {
      const n = wrapped as unknown as Notification;
      appendToMultiIndex(indexes.notificationsByUserId, n.userId, n);
      if (n.idempotencyKey) indexes.notificationsByIdempotencyKey.set(n.idempotencyKey, n);
      break;
    }
    case "auditLogs": {
      const a = wrapped as unknown as AuditLog;
      if (a.userId) appendToMultiIndex(indexes.auditLogsByUserId, a.userId, a);
      appendToMultiIndex(indexes.auditLogsByAction, a.action, a);
      break;
    }
    case "adminLedger":
      appendToMultiIndex(indexes.adminLedgerByEntryType, (wrapped as unknown as AdminLedgerEntry).entryType, wrapped as unknown as AdminLedgerEntry);
      break;
    case "investorWithdrawals":
      appendToMultiIndex(indexes.investorWithdrawalsByInvestorId, (wrapped as unknown as InvestorWithdrawal).investorId, wrapped as unknown as InvestorWithdrawal);
      break;
    case "disbursementAccounts":
      appendToMultiIndex(indexes.disbursementAccountsByBorrowerId, (wrapped as unknown as DisbursementAccount).borrowerId, wrapped as unknown as DisbursementAccount);
      break;
    case "loanDisbursements":
      appendToMultiIndex(indexes.loanDisbursementsByLoanId, (wrapped as unknown as LoanDisbursement).loanId, wrapped as unknown as LoanDisbursement);
      break;
    case "consents":
      appendToMultiIndex(indexes.consentsByUserId, (wrapped as unknown as Consent).userId, wrapped as unknown as Consent);
      break;
    case "otpChallenges":
      appendToMultiIndex(indexes.otpChallengesByUserId, (wrapped as unknown as OtpChallenge).userId, wrapped as unknown as OtpChallenge);
      break;
    case "passwordResetTokens":
      appendToMultiIndex(indexes.passwordResetTokensByUserId, (wrapped as unknown as PasswordResetToken).userId, wrapped as unknown as PasswordResetToken);
      break;
    case "providerEvents":
      indexes.providerEventsByEventKey.set((wrapped as unknown as ProviderWebhookEvent).eventKey, wrapped as unknown as ProviderWebhookEvent);
      break;
    case "accountChangeRequests":
      appendToMultiIndex(indexes.accountChangeRequestsByUserId, (wrapped as unknown as AccountChangeRequest).userId, wrapped as unknown as AccountChangeRequest);
      break;
    default:
      // loanProducts, investmentPlans, platformSettings, applicationDrafts are not indexed.
      break;
  }
}

function createPersistentArray<T>(key: StoreKey): T[] {
  const target: T[] = [];
  rawState[key] = target;
  // Bulk mutators that Array.prototype.splice/pop/shift/… execute as sequences
  // of intermediate index deletes + element shifts. Re-running the index sync
  // on EVERY intermediate step used to (a) rebuild all indexes O(n) times and
  // (b) walk a HALF-MUTATED array — a hole from the already-deleted tail read
  // as `undefined` and crashed rebuildIndexes ("Cannot read properties of
  // undefined (reading 'email')"). We now run the mutator directly on the
  // target array and sync exactly ONCE after it completes.
  const BULK_MUTATORS = new Set(["splice", "pop", "shift", "unshift"]);
  return new Proxy(target, {
    get(array, property, receiver) {
      if (typeof property === "string" && BULK_MUTATORS.has(property)) {
        const impl = (Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>)[property];
        return (...args: unknown[]) => {
          const result = impl.apply(array, args);
          syncAfterMutation(key, array, "length");
          return wrapNested(result, key);
        };
      }
      return wrapNested(Reflect.get(array, property, receiver), key);
    },
    set(array, property, value, receiver) {
      const priorLength = array.length;
      const result = Reflect.set(array, property, wrapNested(value, key), receiver);
      syncAfterMutation(key, array, property, priorLength);
      return result;
    },
    deleteProperty(array, property) {
      const result = Reflect.deleteProperty(array, property);
      // Numeric-index deletes are INTERMEDIATE splice steps (handled natively
      // above) or rare explicit `delete arr[i]`. Do NOT rebuild here — the
      // subsequent `set length` (splice) or the dirty sweeper handles it.
      if (typeof property === "string" && /^\d+$/.test(property)) {
        requestPersist(key);
      } else {
        syncAfterMutation(key, array, property);
      }
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
  dirtyKeys.clear();
  nestedDirty = false;
  // The full-state JSONB mirror in runtime_state is a boot FALLBACK only (the
  // relational tables are the primary source). Serialising and shipping the
  // entire store on every mutation made persists grow unboundedly with data
  // volume — now it is written in the background at most once per minute.
  scheduleStateSnapshot();
  return counts;
}

const STATE_SNAPSHOT_MIN_INTERVAL_MS = 60_000;
let lastSnapshotAt = 0;
let snapshotInFlight: Promise<void> | undefined;
let snapshotTimer: ReturnType<typeof setTimeout> | undefined;

function writeStateSnapshot(snap: Record<StoreKey, unknown[]>): Promise<void> {
  if (!sql) return Promise.resolve();
  return sql.query(
    "INSERT INTO runtime_state (id, state) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = CURRENT_TIMESTAMP",
    ["default", JSON.stringify(snap)]
  ).then(() => undefined);
}

function scheduleStateSnapshot(force = false): void {
  if (!sql) return;
  const elapsed = Date.now() - lastSnapshotAt;
  if (!force && elapsed < STATE_SNAPSHOT_MIN_INTERVAL_MS) {
    if (!snapshotTimer && snapshotInFlight === undefined) {
      snapshotTimer = setTimeout(() => {
        snapshotTimer = undefined;
        scheduleStateSnapshot(true);
      }, Math.max(1_000, STATE_SNAPSHOT_MIN_INTERVAL_MS - elapsed));
      (snapshotTimer as unknown as { unref?: () => void }).unref?.();
    }
    return;
  }
  if (snapshotInFlight) return;
  lastSnapshotAt = Date.now();
  const snap = snapshotStore();
  snapshotInFlight = writeStateSnapshot(snap).catch((error) => {
    console.error("[store] runtime_state snapshot write failed (will retry on next persist):", error);
  }).finally(() => {
    snapshotInFlight = undefined;
  });
}

// Safety net: if a persist failed or was skipped (e.g. the DB was unreachable),
// retry in the background so in-memory state eventually converges to disk
// without any request having to wait for it.
let sweeperStarted = false;
function startPersistSweeper(): void {
  if (sweeperStarted || !sql) return;
  sweeperStarted = true;
  const dirtySweep = setInterval(() => {
    if (hydrating) return;
    if (dirtyKeys.size > 0 || nestedDirty) {
      void persistStore().catch((error) => {
        console.error("[store/sweeper] PostgreSQL persistence retry failed:", error);
      });
    }
  }, 20_000);
  (dirtySweep as unknown as { unref?: () => void }).unref?.();
  const snapshotSweep = setInterval(() => {
    if (hydrating) return;
    scheduleStateSnapshot(true);
  }, 120_000);
  (snapshotSweep as unknown as { unref?: () => void }).unref?.();
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

// Idempotency guard: initializeStore() is called from startup AND from the
// Google Sheets seeding path (processRowsIntoStore). Without this guard a
// second invocation would push the SAME database rows into the persistent
// arrays a second time — the exact mechanism that once produced loan-product
// duplicates sharing identical ids in the served catalog.
let storeInitPromise: Promise<void> | null = null;

export function initializeStore(): Promise<void> {
  if (!storeInitPromise) {
    storeInitPromise = doInitializeStore().catch((error) => {
      // Allow a later call to retry (e.g. the DB was unreachable at boot).
      storeInitPromise = null;
      throw error;
    });
  }
  return storeInitPromise;
}

async function doInitializeStore(): Promise<void> {
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
  seedDefaultEngagement();
  seedAdminLedgerOpeningBalance(0);

  // Self-heal legacy duplicated catalog rows (same id / same name) BEFORE the
  // post-load decompose pass, so the clean snapshot is what gets upserted.
  if (normalizeCatalogCollections()) {
    console.warn("[store/initializeStore] Removed duplicated catalog rows (loan products / investment plans) from loaded state.");
    try {
      await persistStore();
    } catch (e) {
      console.error("[store/initializeStore] persisting the de-duplicated snapshot failed:", e);
    }
  }

  try {
    await decomposeAndUpsertAll(sql as unknown as NeonQueryFunction<false, false>, snapshotStore(), undefined);
  } catch (e) {
    console.error("[store/initializeStore] post-load full decompose pass FAILED:", e);
  }

  // Kill ghost catalog rows for good (see purgeGhostCatalogRows): survivors
  // are already upserted by the decompose pass above, so anything still in
  // Postgres that memory does not know about is stale garbage.
  await purgeGhostCatalogRows();

  startPersistSweeper();

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
  // Held-balance semantics: holds are created by INVESTMENT_LOCK and
  // WITHDRAWAL_INITIATED and released ONLY by their matching principal
  // entries. INVESTMENT_RETURN deliberately does NOT touch the held balance —
  // it credits earnings (which were never locked) and, before the maturity
  // sweep was split into principal+earnings entries, it used to over-release
  // the hold by principal+earnings and silently corrupt OTHER active
  // investments' holds. HOLD_RELEASE / HOLD_RESTORE are reconciliation
  // entries: they move money between available and the investor's view of it,
  // never between hold buckets, so they never change `held` either.
  const newHeld = entry.entryType === "INVESTMENT_LOCK" || entry.entryType === "WITHDRAWAL_INITIATED"
    ? wallet.heldMinor + entry.amountMinor
    : entry.entryType === "INVESTMENT_RELEASE" || entry.entryType === "WITHDRAWAL_REVERSAL" || entry.entryType === "WITHDRAWAL_SETTLEMENT"
    ? Math.max(0, wallet.heldMinor - (entry.entryType === "WITHDRAWAL_SETTLEMENT" ? Number(entry.metadata?.releasedAmountMinor ?? 0) : entry.amountMinor))
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

// ---------------------------------------------------------------------------
// Catalog normalization (self-healing).
//
// Production once served FOUR loan products where two pairs shared the SAME
// id: the admin-configured rows ("Personal Loan" / "Business Loan", version 2)
// plus stale pre-rename copies of the very same rows ("Velo Personal Quick" /
// "Velo Business Boost", version 1) that survived in a legacy snapshot. Any
// consumer that iterates the list (borrower limits overlay, admin type match)
// then let the LAST duplicate win — resurrecting ₦50,000 seeds after the
// admin had configured ₦200.
//
// normalizeCatalogCollections() collapses these ghosts in place:
//   1. same id        -> keep the highest `version` (tie-break: newest updatedAt)
//   2. same name (ci) -> keep the newest `updatedAt` (guards distinct-id twins)
// and reports whether anything was removed so callers can re-persist the
// healed snapshot.
// ---------------------------------------------------------------------------

type NormalizableRecord = { id: string; version?: number; createdAt?: string; updatedAt?: string };

// Version MUST strictly dominate the timestamp: epoch millis are ~1.75e12, so
// the multiplier (1e16) must exceed any possible Date.parse value for a
// "highest version wins, timestamp only breaks ties" ordering.
const CATALOG_RANK_VERSION_WEIGHT = 1e16;

function catalogRecordRank(record: NormalizableRecord): number {
  const version = Number.isFinite(record.version) ? Number(record.version) : 0;
  const updated = Math.min(Math.max(Date.parse(record.updatedAt ?? "") || 0, 0), CATALOG_RANK_VERSION_WEIGHT - 1);
  return version * CATALOG_RANK_VERSION_WEIGHT + updated;
}

function dedupeCatalogInPlace<T extends NormalizableRecord>(items: T[], nameOf: (item: T) => string): boolean {
  if (items.length <= 1) return false;
  const byId = new Map<string, T>();
  for (const item of items) {
    const current = byId.get(item.id);
    if (!current || catalogRecordRank(item) > catalogRecordRank(current)) byId.set(item.id, item);
  }
  const byName = new Map<string, T>();
  for (const item of byId.values()) {
    const key = nameOf(item).trim().toLowerCase();
    const current = byName.get(key);
    if (!current || catalogRecordRank(item) > catalogRecordRank(current)) byName.set(key, item);
  }
  if (byName.size === items.length) return false;
  // Preserve original ordering of the surviving records (splice in place so
  // the persistent-array proxy marks the collection dirty for persistence).
  const survivors = new Set(byName.values());
  const kept = items.filter((item) => survivors.has(item));
  items.splice(0, items.length, ...kept);
  return true;
}

/** Dedupe the loan-product catalog in place. Returns true when rows were removed. */
export function normalizeLoanProducts(): boolean {
  return dedupeCatalogInPlace(loanProducts, (p) => p.name);
}

/** Dedupe loan products AND investment plans (same seed/duplication pattern). */
export function normalizeCatalogCollections(): boolean {
  const loanRemoved = normalizeLoanProducts();
  let plansRemoved = false;
  if (investmentPlans.length > 1) {
    plansRemoved = dedupeCatalogInPlace(investmentPlans, (p) => p.name);
  }
  return loanRemoved || plansRemoved;
}

// ---------------------------------------------------------------------------
// Catalog resilience helpers.
//
// Production incident: GET /borrower/loan-products returned { products: [] }
// while the admin had products configured. Three independent holes made that
// possible:
//   1. Ghost rows — dedupeCatalogInPlace() collapses duplicates IN MEMORY but
//      nothing ever DELETEd them from Postgres, so every restart re-loaded the
//      ghosts and re-collapsed them (and any consumer reading the raw table
//      kept seeing stale/contradictory rows).
//   2. Partial hydration — if a boot raced (Neon cold start, transient query
//      failure) the in-memory catalog could stay empty for the life of the
//      process, because the seed only runs during initializeStore().
//   3. All-inactive state — the borrower endpoint served `active only`; with
//      every product toggled off the response was `[]` and the whole borrowing
//      funnel silently bricked.
// The helpers below close all three holes.
// ---------------------------------------------------------------------------

/**
 * DELETE catalog rows that no longer exist in memory (ghost rows left behind
 * by the historical append-instead-of-upsert bug). Skipped when the in-memory
 * catalog is empty so a partial boot can never wipe the table.
 */
export async function purgeGhostCatalogRows(): Promise<void> {
  if (!sql) return;
  try {
    const productIds = loanProducts.map((p) => p.id);
    if (productIds.length > 0) {
      await sql.query("DELETE FROM loan_products WHERE NOT (id = ANY($1::text[]))", [productIds]);
    }
    const planIds = investmentPlans.map((p) => p.id);
    if (planIds.length > 0) {
      await sql.query("DELETE FROM investment_plans WHERE NOT (id = ANY($1::text[]))", [planIds]);
    }
  } catch (e) {
    console.error("[store/purgeGhostCatalogRows] failed:", e);
  }
}

/**
 * Re-read the authoritative loan-product catalog straight from Postgres and
 * replace the in-memory array with it (deduped). Used when the process booted
 * without a usable catalog (partial hydration) — borrowers and admins must not
 * be stuck with an empty list until the next restart.
 */
export async function reloadLoanProductsFromDb(): Promise<number> {
  if (!sql) return loanProducts.length;
  try {
    const products = await rebuildLoanProductsFromDatabase(sql as unknown as NeonQueryFunction<false, false>);
    loanProducts.splice(0, loanProducts.length, ...products);
    normalizeLoanProducts();
  } catch (e) {
    console.error("[store/reloadLoanProductsFromDb] failed:", e);
  }
  return loanProducts.length;
}

/**
 * Hard guarantee that the in-memory catalog is populated before a borrower- or
 * admin-facing response is built: DB reload first, seed defaults last.
 */
export async function ensureLoanProductsLoaded(): Promise<number> {
  if (loanProducts.length > 0) return loanProducts.length;
  const reloaded = await reloadLoanProductsFromDb();
  if (reloaded > 0) return reloaded;
  seedLoanProducts();
  return loanProducts.length;
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
    if (!Array.isArray(existing.announcements)) existing.announcements = [];
    if (!Array.isArray(existing.banners)) existing.banners = [];
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
    maintenanceMode: false,
    maintenanceMessage: "",
    announcements: [],
    banners: [],
    updatedAt: now,
    createdAt: now,
  };
  platformSettings.push(defaults);
  return defaults;
}

export function updatePlatformSettings(updates: Partial<Pick<PlatformSettings, "investorWithdrawalFeePercent" | "investorWithdrawalFeeFlatMinor" | "investorWithdrawalMinAmountNaira" | "investorEarningRateOverrides" | "defaultInvestmentAnnualRatePercent" | "maintenanceMode" | "maintenanceMessage">>): PlatformSettings {
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
  if (updates.maintenanceMode !== undefined) {
    settings.maintenanceMode = Boolean(updates.maintenanceMode);
    settings.maintenanceUpdatedAt = new Date().toISOString();
  }
  if (updates.maintenanceMessage !== undefined) {
    settings.maintenanceMessage = String(updates.maintenanceMessage).slice(0, 500);
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

// ---------------------------------------------------------------------------
// Default engagement content — seeds three branded dashboard banners and one
// welcome announcement the FIRST time the platform boots. The seed is guarded
// by the persisted `engagementSeeded` flag: once an admin deletes or edits
// the seeded content, it is never re-added on restart.
// ---------------------------------------------------------------------------
function brandedBannerSvg(input: { headline: string; subline: string; accent: string; accentDark: string; badge: string }): string {
  const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400">',
    '<defs>',
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${input.accent}"/><stop offset="1" stop-color="${input.accentDark}"/></linearGradient>`,
    '<radialGradient id="glow" cx="0.85" cy="0.15" r="0.9"><stop offset="0" stop-color="#ffffff" stop-opacity="0.28"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>',
    '</defs>',
    '<rect width="1200" height="400" fill="url(#bg)"/>',
    '<rect width="1200" height="400" fill="url(#glow)"/>',
    '<circle cx="1050" cy="330" r="150" fill="#ffffff" opacity="0.08"/>',
    '<circle cx="1120" cy="90" r="90" fill="#ffffff" opacity="0.10"/>',
    '<circle cx="880" cy="40" r="46" fill="#ffffff" opacity="0.07"/>',
    '<g transform="translate(70,84)">',
    '<rect width="64" height="64" rx="18" fill="#ffffff" opacity="0.95"/>',
    '<path d="M20 44 L32 20 L44 44 Z" fill="#0f766e"/><circle cx="32" cy="40" r="5" fill="#f59e0b"/>',
    '</g>',
    '<text x="152" y="126" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#ffffff">Velo</text>',
    `<rect x="70" y="176" width="${24 + escaped(input.badge).length * 13}" height="38" rx="19" fill="#ffffff" opacity="0.18"/>`,
    `<text x="86" y="201" font-family="Arial, Helvetica, sans-serif" font-size="19" font-weight="700" fill="#ffffff" letter-spacing="2">${escaped(input.badge)}</text>`,
    `<text x="70" y="272" font-family="Arial, Helvetica, sans-serif" font-size="52" font-weight="800" fill="#ffffff">${escaped(input.headline)}</text>`,
    `<text x="70" y="322" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="#ffffff" opacity="0.85">${escaped(input.subline)}</text>`,
    '</svg>',
  ].join("");
}

function svgBannerDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

export function seedDefaultEngagement(): void {
  const settings = getPlatformSettings();
  if (settings.engagementSeeded) return;
  const now = new Date().toISOString();
  if ((settings.banners ?? []).length === 0) {
    const defaults: Array<{ name: string; badge: string; headline: string; subline: string; accent: string; accentDark: string }> = [
      { name: "Instant loans", badge: "FAST CASH", headline: "Instant Loans, Zero Stress", subline: "Apply in minutes and get funded the same day", accent: "#0f766e", accentDark: "#134e4a" },
      { name: "Invest and earn", badge: "GROW MONEY", headline: "Invest & Earn up to 18% p.a.", subline: "Start with as little as 10,000 Naira today", accent: "#b45309", accentDark: "#7c2d12" },
      { name: "Verify once", badge: "KYC", headline: "Verify Once, Unlock Everything", subline: "Borrow, invest and withdraw after one quick check", accent: "#1d4ed8", accentDark: "#312e81" },
    ];
    settings.banners = defaults.map((item) => ({
      id: randomUUID(),
      name: item.name,
      imageData: svgBannerDataUrl(brandedBannerSvg({ badge: item.badge, headline: item.headline, subline: item.subline, accent: item.accent, accentDark: item.accentDark })),
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }));
  }
  if ((settings.announcements ?? []).length === 0) {
    const message = "Welcome to Velo! Get instant loans disbursed in minutes and grow your money with investments earning up to 18% per year. Complete your KYC once to unlock borrowing, investing and withdrawals.";
    settings.announcements = [{ id: randomUUID(), message, isActive: true, createdAt: now, updatedAt: now }];
  }
  settings.engagementSeeded = true;
  settings.updatedAt = now;
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
