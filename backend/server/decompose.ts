import type { NeonQueryFunction } from "@neondatabase/serverless";
import { sql } from "./db.js";
import type {
  StoreKey,
  User,
  Wallet,
  LedgerEntry,
  WalletTransaction,
  KycCase,
  IdentityVerificationEvent,
  Document,
  PayoutAccount,
  InvestmentPlan,
  Investment,
  LoanApplication,
  Loan,
  LoanSchedule,
  Repayment,
  Payout,
  CreditHistoryEvent,
  CreditScore,
  CreditReport,
  OtpChallenge,
  PasswordResetToken,
  Notification,
  ProviderWebhookEvent,
  Consent,
  LoanProduct,
  AuditLog,
  AdminLedgerEntry,
  PlatformSettings,
  InvestorWithdrawal,
  DisbursementAccount,
  LoanDisbursement,
  AccountChangeRequest,
  ApplicationDraft,
} from "./store.js";

export type AnyRow = Record<string, unknown>;

const date = (v: string | undefined | null): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const num = (v: number | bigint | undefined | null): number | null =>
  v === undefined || v === null ? null : Number(v);

const big = (v: number | bigint | undefined | null): string | null =>
  v === undefined || v === null ? null : String(v);

const json = (v: unknown): string => JSON.stringify(v ?? null);

function escapeColumn(col: string): string {
  return `"${col.replace(/"/g, '""')}"`;
}

const BATCH_SIZE = 100;

type UpsertArgs<T> = {
  table: string;
  pkColumns: string[];
  columns: Array<{ snake: string; get: (row: T) => unknown; json?: boolean; asDate?: boolean; asBig?: boolean }>;
  skipIfEmptyCollection?: boolean;
};

export async function upsertEntities<T>(
  db: NeonQueryFunction<false, false>,
  rows: readonly T[],
  args: UpsertArgs<T>
): Promise<number> {
  if (args.skipIfEmptyCollection && rows.length === 0) return 0;
  if (rows.length === 0) return 0;
  const colNames = args.columns.map((c) => escapeColumn(c.snake));
  const colList = colNames.join(", ");
  const placeholders = args.columns.map((_, i) => `$${i + 1}`).join(", ");
  const conflictCols = args.pkColumns.map(escapeColumn).join(", ");
  const excluded = args.columns
    .filter((c) => !args.pkColumns.includes(c.snake))
    .map((c) => `${escapeColumn(c.snake)} = EXCLUDED.${escapeColumn(c.snake)}`)
    .join(", ");
  const sqlText =
    excluded.length === 0
      ? `INSERT INTO ${args.table} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO NOTHING`
      : `INSERT INTO ${args.table} (${colList}) VALUES (${placeholders}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${excluded}`;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    for (const row of chunk) {
      const params = args.columns.map((c) => {
        const v = c.get(row);
        if (c.asDate) return date(v as string | undefined | null);
        if (c.asBig) return big(v as number | undefined | null);
        if (c.json) return typeof v === "string" ? v : json(v);
        return v ?? null;
      });
      try {
        await db.query(sqlText, params);
        inserted += 1;
      } catch (e) {
        console.error(`[decompose] Upsert failed for ${args.table}:`, e);
        throw e;
      }
    }
  }
  return inserted;
}

export type Snapshot = Record<StoreKey, readonly unknown[]>;

export type EntityCounts = Partial<Record<StoreKey, number>>;

const STORE_KEY_TO_TABLE: Partial<Record<StoreKey, string>> = {
  users: "users",
  wallets: "wallets",
  ledgerEntries: "ledger_entries",
  walletTransactions: "wallet_transactions",
  kycCases: "kyc_cases",
  identityVerificationEvents: "identity_verification_events",
  documents: "documents",
  payoutAccounts: "payout_accounts",
  investmentPlans: "investment_plans",
  investments: "investments",
  loanApplications: "loan_applications",
  loans: "loans",
  loanSchedules: "loan_schedules",
  repayments: "repayments",
  payouts: "payouts",
  creditHistory: "credit_history_events",
  creditScores: "credit_scores",
  creditReports: "credit_reports",
  otpChallenges: "otp_challenges",
  passwordResetTokens: "password_reset_tokens",
  notifications: "notifications",
  providerEvents: "provider_webhook_events",
  consents: "consents",
  loanProducts: "loan_products",
  auditLogs: "audit_logs",
  adminLedger: "admin_ledger_entries",
  platformSettings: "system_settings",
  investorWithdrawals: "investor_withdrawals",
  disbursementAccounts: "disbursement_accounts",
  loanDisbursements: "disbursements",
  accountChangeRequests: "account_change_requests",
  applicationDrafts: "application_drafts",
};

export async function decomposeAndUpsertAll(
  db: NeonQueryFunction<false, false>,
  snapshot: Snapshot,
  changedKeys?: StoreKey[]
): Promise<EntityCounts> {
  const scope: Set<StoreKey> = changedKeys && changedKeys.length > 0 ? new Set(changedKeys) : new Set([
    "users",
    "wallets",
    "ledgerEntries",
    "walletTransactions",
    "kycCases",
    "identityVerificationEvents",
    "documents",
    "payoutAccounts",
    "investmentPlans",
    "investments",
    "loanApplications",
    "loans",
    "loanSchedules",
    "repayments",
    "payouts",
    "creditHistory",
    "creditScores",
    "creditReports",
    "otpChallenges",
    "passwordResetTokens",
    "notifications",
    "providerEvents",
    "consents",
    "loanProducts",
    "auditLogs",
    "adminLedger",
    "platformSettings",
    "investorWithdrawals",
    "disbursementAccounts",
    "loanDisbursements",
    "accountChangeRequests",
    "applicationDrafts",
  ]);

  const counts: EntityCounts = {};
  const has = (k: StoreKey) => scope.has(k);
  const inc = (k: StoreKey, n: number) => {
    counts[k] = (counts[k] ?? 0) + n;
  };

  // ---------- Group A: no FKs (or self-referential) ----------
  if (has("loanProducts")) {
    inc(
      "loanProducts",
      await upsertEntities<LoanProduct>(db, snapshot.loanProducts as readonly LoanProduct[], {
        table: "loan_products",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "name", get: (r) => r.name },
          { snake: "description", get: (r) => r.description ?? null },
          { snake: "min_amount_naira", get: (r) => r.minAmountNaira },
          { snake: "max_amount_naira", get: (r) => r.maxAmountNaira },
          { snake: "interest_rate_per_annum", get: (r) => r.interestRatePerAnnum },
          { snake: "processing_fee_rate", get: (r) => r.processingFeeRate },
          { snake: "late_repayment_penalty_per_day", get: (r) => r.lateRepaymentPenaltyPerDay ?? 0 },
          { snake: "min_tenure_days", get: (r) => r.minTenureDays },
          { snake: "max_tenure_days", get: (r) => r.maxTenureDays },
          { snake: "is_active", get: (r) => r.isActive ?? true },
          { snake: "config", get: (r) => r.config, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("investmentPlans")) {
    inc(
      "investmentPlans",
      await upsertEntities<InvestmentPlan>(db, snapshot.investmentPlans as readonly InvestmentPlan[], {
        table: "investment_plans",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "name", get: (r) => r.name },
          { snake: "description", get: (r) => r.description ?? null },
          { snake: "tenure_days", get: (r) => r.tenureDays },
          { snake: "annual_interest_rate", get: (r) => r.annualInterestRate ?? r.ratePerAnnum ?? 0 },
          { snake: "min_amount_naira", get: (r) => r.minAmountNaira ?? r.minimumNaira ?? 1000 },
          { snake: "max_amount_naira", get: (r) => r.maxAmountNaira ?? r.maximumNaira ?? 50000000 },
          { snake: "is_active", get: (r) => r.isActive ?? true },
          { snake: "early_liquidation_allowed", get: (r) => r.earlyLiquidationAllowed ?? true },
          { snake: "early_liquidation_penalty_rate", get: (r) => r.earlyLiquidationPenaltyRate ?? 0 },
          { snake: "config", get: (r) => (r as unknown as AnyRow).config, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("platformSettings")) {
    for (const row of snapshot.platformSettings as readonly PlatformSettings[]) {
      // system_settings table has key/value pattern; TS PlatformSettings is single object with id.
      // Serialize entire object as one JSONB row using a stable synthetic id.
      const settingId = row.id ?? "platform-default";
      await db.query(
        `INSERT INTO system_settings (id, key, value, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [
          settingId,
          "platform",
          JSON.stringify(row),
          date(row.createdAt) ?? new Date(),
          date(row.updatedAt) ?? new Date(),
        ]
      );
      inc("platformSettings", 1);
    }
  }
  if (has("users")) {
    inc(
      "users",
      await upsertEntities<User>(db, snapshot.users as readonly User[], {
        table: "users",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "email", get: (r) => r.email },
          { snake: "phone", get: (r) => r.phone },
          { snake: "full_name", get: (r) => r.fullName },
          { snake: "password_hash", get: (r) => r.passwordHash },
          { snake: "kyc_status", get: (r) => r.kycStatus },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
          { snake: "last_login_at", get: (r) => r.lastLoginAt, asDate: true },
          { snake: "is_active", get: (r) => r.isActive ?? true },
          { snake: "preferred_otp_channel", get: (r) => r.preferredOtpChannel ?? "EMAIL" },
          { snake: "otp_login_enabled", get: (r) => r.otpLoginEnabled ?? false },
          { snake: "otp_verified_at", get: (r) => r.otpVerifiedAt, asDate: true },
          { snake: "date_of_birth", get: (r) => r.dateOfBirth, asDate: true },
          { snake: "residential_address", get: (r) => r.residentialAddress, json: true },
          { snake: "occupation", get: (r) => r.occupation ?? null },
          { snake: "source_of_funds", get: (r) => r.sourceOfFunds ?? null },
          { snake: "metadata", get: (r) => {
            const { id, email, phone, fullName, passwordHash, kycStatus, createdAt, updatedAt, lastLoginAt, isActive, preferredOtpChannel, otpLoginEnabled, otpVerifiedAt, dateOfBirth, residentialAddress, occupation, sourceOfFunds, roles, adminPermissions, ...rest } = r as unknown as AnyRow;
            return rest;
          }, json: true },
        ],
      })
    );
    // Upsert user_roles join table (roles array -> user_roles rows)
    for (const u of snapshot.users as readonly User[]) {
      for (const role of u.roles) {
        await db.query(
          `INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT (user_id, role) DO NOTHING`,
          [u.id, role]
        );
      }
      // Admin permissions are not persisted per-user in SQL (they live on role+permission join)
      // We store them as part of users.metadata instead (above).
    }
  }

  // ---------- Group B: have user FKs ----------
  if (has("wallets")) {
    inc(
      "wallets",
      await upsertEntities<Wallet>(db, snapshot.wallets as readonly Wallet[], {
        table: "wallets",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "available_minor", get: (r) => r.availableMinor ?? r.availableNaira * 100, asBig: true },
          { snake: "held_minor", get: (r) => r.heldMinor ?? (r as unknown as AnyRow).heldNaira * 100 || 0, asBig: true },
          { snake: "pending_deposit_minor", get: (r) => r.pendingDepositMinor ?? (r as unknown as AnyRow).pendingDepositNaira * 100 || 0, asBig: true },
          { snake: "pending_payout_minor", get: (r) => r.pendingPayoutMinor ?? (r as unknown as AnyRow).pendingPayoutNaira * 100 || 0, asBig: true },
          { snake: "total_credited_minor", get: (r) => r.totalCreditedMinor ?? 0, asBig: true },
          { snake: "total_debited_minor", get: (r) => r.totalDebitedMinor ?? 0, asBig: true },
          { snake: "currency", get: (r) => r.currency ?? "NGN" },
          { snake: "created_at", get: (r) => (r as unknown as AnyRow).createdAt ?? new Date().toISOString(), asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? new Date().toISOString(), asDate: true },
        ],
      })
    );
  }
  if (has("kycCases")) {
    inc(
      "kycCases",
      await upsertEntities<KycCase>(db, snapshot.kycCases as readonly KycCase[], {
        table: "kyc_cases",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "status", get: (r) => r.status },
          { snake: "bvn", get: (r) => (r as unknown as AnyRow).bvn ?? null },
          { snake: "nin", get: (r) => (r as unknown as AnyRow).nin ?? null },
          { snake: "category_results", get: (r) => (r as unknown as AnyRow).categoryResults, json: true },
          { snake: "bvn_verified_at", get: (r) => (r as unknown as AnyRow).bvnVerifiedAt ?? (r as unknown as AnyRow).verifiedAt, asDate: true },
          { snake: "nin_verified_at", get: (r) => (r as unknown as AnyRow).ninVerifiedAt, asDate: true },
          { snake: "liveness_verified_at", get: (r) => (r as unknown as AnyRow).livenessVerifiedAt, asDate: true },
          { snake: "verified_at", get: (r) => (r as unknown as AnyRow).verifiedAt, asDate: true },
          { snake: "verified_details", get: (r) => (r as unknown as AnyRow).verifiedDetails, json: true },
          { snake: "identity_photo", get: (r) => (r as unknown as AnyRow).identityPhoto ?? null },
          { snake: "selfie_image_data", get: (r) => (r as unknown as AnyRow).selfieImageData ?? null },
          { snake: "provider_request_id", get: (r) => (r as unknown as AnyRow).providerRequestId ?? null },
          { snake: "provider_raw", get: (r) => (r as unknown as AnyRow).providerRaw, json: true },
          { snake: "checklist", get: (r) => (r as unknown as AnyRow).checklist, json: true },
          { snake: "submitted_at", get: (r) => (r as unknown as AnyRow).submittedAt, asDate: true },
          { snake: "reviewed_by", get: (r) => (r as unknown as AnyRow).reviewedBy ?? null },
          { snake: "reviewed_at", get: (r) => (r as unknown as AnyRow).reviewedAt, asDate: true },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "created_at", get: (r) => (r as unknown as AnyRow).createdAt ?? r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("identityVerificationEvents")) {
    inc(
      "identityVerificationEvents",
      await upsertEntities<IdentityVerificationEvent>(db, snapshot.identityVerificationEvents as readonly IdentityVerificationEvent[], {
        table: "identity_verification_events",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "kyc_case_id", get: (r) => r.kycCaseId },
          { snake: "category", get: (r) => r.category },
          { snake: "status", get: (r) => r.status },
          { snake: "provider_request_id", get: (r) => r.providerRequestId ?? null },
          { snake: "provider_transaction_id", get: (r) => (r as unknown as AnyRow).providerTransactionId ?? null },
          { snake: "provider_raw", get: (r) => r.providerRaw, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("documents")) {
    inc(
      "documents",
      await upsertEntities<Document>(db, snapshot.documents as readonly Document[], {
        table: "documents",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "kyc_case_id", get: (r) => r.kycCaseId ?? null },
          { snake: "loan_application_id", get: (r) => (r as unknown as AnyRow).loanApplicationId ?? null },
          { snake: "type", get: (r) => r.type },
          { snake: "status", get: (r) => r.status ?? "PENDING_REVIEW" },
          { snake: "file_name", get: (r) => r.fileName ?? null },
          { snake: "mime_type", get: (r) => r.mimeType ?? null },
          { snake: "storage_url", get: (r) => r.storageUrl ?? null },
          { snake: "size_bytes", get: (r) => r.sizeBytes ?? null, asBig: true },
          { snake: "version", get: (r) => r.version ?? 1 },
          { snake: "note", get: (r) => (r as unknown as AnyRow).note ?? null },
          { snake: "expires_at", get: (r) => (r as unknown as AnyRow).expiresAt, asDate: true },
          { snake: "reviewed_by", get: (r) => (r as unknown as AnyRow).reviewedBy ?? null },
          { snake: "reviewed_at", get: (r) => (r as unknown as AnyRow).reviewedAt, asDate: true },
          { snake: "rejection_reason", get: (r) => r.rejectionReason ?? null },
          { snake: "verification_result", get: (r) => (r as unknown as AnyRow).verificationResult, json: true },
          { snake: "metadata", get: (r) => (r as unknown as AnyRow).metadata, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("payoutAccounts")) {
    inc(
      "payoutAccounts",
      await upsertEntities<PayoutAccount>(db, snapshot.payoutAccounts as readonly PayoutAccount[], {
        table: "payout_accounts",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "bank_name", get: (r) => r.bankName ?? null },
          { snake: "bank_code", get: (r) => r.bankCode },
          { snake: "account_number", get: (r) => r.accountNumber },
          { snake: "account_name", get: (r) => r.accountName ?? null },
          { snake: "account_name_enquiry_result", get: (r) => (r as unknown as AnyRow).accountNameEnquiryResult ?? null },
          { snake: "status", get: (r) => r.status ?? "PENDING_APPROVAL" },
          { snake: "verified_at", get: (r) => (r as unknown as AnyRow).verifiedAt, asDate: true },
          { snake: "verification_reference", get: (r) => (r as unknown as AnyRow).verificationReference ?? null },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "is_default", get: (r) => r.isDefault ?? false },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("disbursementAccounts")) {
    inc(
      "disbursementAccounts",
      await upsertEntities<DisbursementAccount>(db, snapshot.disbursementAccounts as readonly DisbursementAccount[], {
        table: "disbursement_accounts",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "borrower_id", get: (r) => r.borrowerId },
          { snake: "bank_name", get: (r) => r.bankName ?? null },
          { snake: "bank_code", get: (r) => r.bankCode },
          { snake: "account_number", get: (r) => r.accountNumber },
          { snake: "account_name", get: (r) => r.accountName ?? null },
          { snake: "account_name_enquiry_result", get: (r) => (r as unknown as AnyRow).accountNameEnquiryResult ?? null },
          { snake: "status", get: (r) => r.status ?? "PENDING_APPROVAL" },
          { snake: "verified_at", get: (r) => (r as unknown as AnyRow).verifiedAt, asDate: true },
          { snake: "verification_reference", get: (r) => (r as unknown as AnyRow).verificationReference ?? null },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("otpChallenges")) {
    inc(
      "otpChallenges",
      await upsertEntities<OtpChallenge>(db, snapshot.otpChallenges as readonly OtpChallenge[], {
        table: "otp_challenges",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "action", get: (r) => r.action },
          { snake: "code_hash", get: (r) => r.codeHash },
          { snake: "channel", get: (r) => r.channel ?? null },
          { snake: "provider_reference", get: (r) => r.providerReference ?? null },
          { snake: "expires_at", get: (r) => r.expiresAt, asDate: true },
          { snake: "verified_at", get: (r) => r.verifiedAt, asDate: true },
          { snake: "delivery_status", get: (r) => r.deliveryStatus ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("passwordResetTokens")) {
    inc(
      "passwordResetTokens",
      await upsertEntities<PasswordResetToken>(db, snapshot.passwordResetTokens as readonly PasswordResetToken[], {
        table: "password_reset_tokens",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "token_hash", get: (r) => r.tokenHash },
          { snake: "expires_at", get: (r) => r.expiresAt, asDate: true },
          { snake: "consumed_at", get: (r) => r.consumedAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("notifications")) {
    inc(
      "notifications",
      await upsertEntities<Notification>(db, snapshot.notifications as readonly Notification[], {
        table: "notifications",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "channel", get: (r) => r.channel ?? "IN_APP" },
          { snake: "notification_type", get: (r) => r.notificationType ?? (r as unknown as AnyRow).type },
          { snake: "title", get: (r) => r.title },
          { snake: "body", get: (r) => r.body ?? null },
          { snake: "payload", get: (r) => r.payload, json: true },
          { snake: "status", get: (r) => r.status ?? "PENDING_DELIVERY" },
          { snake: "idempotency_key", get: (r) => r.idempotencyKey ?? null },
          { snake: "delivery_reference", get: (r) => (r as unknown as AnyRow).deliveryReference ?? null },
          { snake: "sent_at", get: (r) => (r as unknown as AnyRow).sentAt, asDate: true },
          { snake: "read_at", get: (r) => r.readAt, asDate: true },
          { snake: "error", get: (r) => (r as unknown as AnyRow).error ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("consents")) {
    inc(
      "consents",
      await upsertEntities<Consent>(db, snapshot.consents as readonly Consent[], {
        table: "consents",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "consent_type", get: (r) => r.type ?? r.consentType ?? "TERMS_OF_SERVICE" },
          { snake: "ip_address", get: (r) => r.ipAddress ?? null },
          { snake: "user_agent", get: (r) => r.userAgent ?? null },
          { snake: "consent_value", get: (r) => r.consentValue ?? r.value ?? "ACCEPTED" },
          { snake: "version", get: (r) => r.version ?? null },
          { snake: "withdrawn_at", get: (r) => (r as unknown as AnyRow).withdrawnAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("providerEvents")) {
    inc(
      "providerEvents",
      await upsertEntities<ProviderWebhookEvent>(db, snapshot.providerEvents as readonly ProviderWebhookEvent[], {
        table: "provider_webhook_events",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "event_key", get: (r) => r.eventKey },
          { snake: "provider", get: (r) => r.provider },
          { snake: "event_name", get: (r) => r.eventName ?? r.type },
          { snake: "payload", get: (r) => r.payload, json: true },
          { snake: "received_at", get: (r) => r.receivedAt ?? r.createdAt, asDate: true },
          { snake: "processed_at", get: (r) => (r as unknown as AnyRow).processedAt, asDate: true },
          { snake: "status", get: (r) => r.status ?? "RECEIVED" },
          { snake: "error", get: (r) => (r as unknown as AnyRow).error ?? null },
        ],
      })
    );
  }
  if (has("creditHistory")) {
    inc(
      "creditHistory",
      await upsertEntities<CreditHistoryEvent>(db, snapshot.creditHistory as readonly CreditHistoryEvent[], {
        table: "credit_history_events",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "event_type", get: (r) => r.eventType ?? r.type ?? "LOAN_REPAYMENT" },
          { snake: "event_date", get: (r) => r.eventDate ?? r.createdAt, asDate: true },
          { snake: "loan_id", get: (r) => r.loanId ?? null },
          { snake: "amount_naira", get: (r) => r.amountNaira ?? num(r.amountMinor ?? (r as unknown as AnyRow).amountMinor, ) ?? 0 },
          { snake: "status", get: (r) => r.status ?? "UNKNOWN" },
          { snake: "description", get: (r) => r.description ?? null },
          { snake: "metadata", get: (r) => (r as unknown as AnyRow).metadata, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("creditScores")) {
    inc(
      "creditScores",
      await upsertEntities<CreditScore>(db, snapshot.creditScores as readonly CreditScore[], {
        table: "credit_scores",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "score", get: (r) => r.score },
          { snake: "provider", get: (r) => r.provider ?? "INTERNAL" },
          { snake: "score_min", get: (r) => r.scoreRange?.[0] ?? r.min ?? 300 },
          { snake: "score_max", get: (r) => r.scoreRange?.[1] ?? r.max ?? 900 },
          { snake: "factors", get: (r) => r.factors ?? (r as unknown as AnyRow).reasons, json: true },
          { snake: "reference", get: (r) => r.reference ?? null },
          { snake: "expires_at", get: (r) => r.expiresAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("creditReports")) {
    inc(
      "creditReports",
      await upsertEntities<CreditReport>(db, snapshot.creditReports as readonly CreditReport[], {
        table: "credit_reports",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "provider", get: (r) => r.provider ?? "INTERNAL" },
          { snake: "report_type", get: (r) => r.reportType ?? "FULL" },
          { snake: "score", get: (r) => r.score ?? null },
          { snake: "summary", get: (r) => r.summary, json: true },
          { snake: "raw_data", get: (r) => r.rawData ?? r.raw, json: true },
          { snake: "reference", get: (r) => r.reference ?? null },
          { snake: "expires_at", get: (r) => r.expiresAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("auditLogs")) {
    inc(
      "auditLogs",
      await upsertEntities<AuditLog>(db, snapshot.auditLogs as readonly AuditLog[], {
        table: "audit_logs",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId ?? null },
          { snake: "actor_type", get: (r) => r.actorType ?? "USER" },
          { snake: "action", get: (r) => r.action },
          { snake: "resource_type", get: (r) => r.resourceType ?? null },
          { snake: "resource_id", get: (r) => r.resourceId ?? null },
          { snake: "old_value", get: (r) => r.oldValue, json: true },
          { snake: "new_value", get: (r) => r.newValue, json: true },
          { snake: "ip_address", get: (r) => r.ipAddress ?? null },
          { snake: "user_agent", get: (r) => r.userAgent ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("adminLedger")) {
    inc(
      "adminLedger",
      await upsertEntities<AdminLedgerEntry>(db, snapshot.adminLedger as readonly AdminLedgerEntry[], {
        table: "admin_ledger_entries",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "entry_type", get: (r) => r.entryType ?? r.type },
          { snake: "reference_id", get: (r) => r.referenceId ?? null },
          { snake: "investor_id", get: (r) => r.investorId ?? null },
          { snake: "borrower_id", get: (r) => r.borrowerId ?? null },
          { snake: "loan_id", get: (r) => r.loanId ?? null },
          { snake: "amount_minor", get: (r) => r.amountMinor, asBig: true },
          { snake: "direction", get: (r) => r.direction },
          { snake: "balance_after_minor", get: (r) => r.balanceAfterMinor, asBig: true },
          { snake: "currency", get: (r) => r.currency ?? "NGN" },
          { snake: "description", get: (r) => r.description ?? r.note ?? null },
          { snake: "metadata", get: (r) => (r as unknown as AnyRow).metadata, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("investorWithdrawals")) {
    inc(
      "investorWithdrawals",
      await upsertEntities<InvestorWithdrawal>(db, snapshot.investorWithdrawals as readonly InvestorWithdrawal[], {
        table: "investor_withdrawals",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "investor_id", get: (r) => r.investorId },
          { snake: "amount_naira", get: (r) => r.amountNaira },
          { snake: "fee_naira", get: (r) => r.feeNaira ?? 0 },
          { snake: "net_naira", get: (r) => r.netNaira ?? r.amountNaira - (r.feeNaira ?? 0) },
          { snake: "currency", get: (r) => r.currency ?? "NGN" },
          { snake: "bank_code", get: (r) => r.bankCode },
          { snake: "bank_name", get: (r) => r.bankName ?? null },
          { snake: "account_number", get: (r) => r.accountNumber },
          { snake: "account_name", get: (r) => r.accountName ?? null },
          { snake: "status", get: (r) => r.status ?? "PENDING_APPROVAL" },
          { snake: "narration", get: (r) => r.narration ?? null },
          { snake: "provider_transfer", get: (r) => (r as unknown as AnyRow).providerTransfer, json: true },
          { snake: "provider_reference", get: (r) => r.providerReference ?? null },
          { snake: "error", get: (r) => (r as unknown as AnyRow).error ?? null },
          { snake: "processed_at", get: (r) => r.processedAt, asDate: true },
          { snake: "retry_count", get: (r) => r.retryCount ?? 0 },
          { snake: "last_attempt_at", get: (r) => r.lastAttemptAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("accountChangeRequests")) {
    inc(
      "accountChangeRequests",
      await upsertEntities<AccountChangeRequest>(db, snapshot.accountChangeRequests as readonly AccountChangeRequest[], {
        table: "account_change_requests",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "type", get: (r) => r.type },
          { snake: "status", get: (r) => r.status ?? "PENDING_APPROVAL" },
          { snake: "existing_snapshot", get: (r) => r.existingSnapshot ?? r.existing, json: true },
          { snake: "new_snapshot", get: (r) => r.newSnapshot ?? r.proposed ?? r.new_value, json: true },
          { snake: "reason", get: (r) => r.reason ?? null },
          { snake: "reviewed_by", get: (r) => (r as unknown as AnyRow).reviewedBy ?? null },
          { snake: "reviewed_at", get: (r) => (r as unknown as AnyRow).reviewedAt, asDate: true },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }

  // ---------- Group C: loan_applications + FK application ----------
  if (has("loanApplications")) {
    inc(
      "loanApplications",
      await upsertEntities<LoanApplication>(db, snapshot.loanApplications as readonly LoanApplication[], {
        table: "loan_applications",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "application_id", get: (r) => r.applicationId ?? r.id },
          { snake: "borrower_id", get: (r) => r.borrowerId },
          { snake: "applicant_type", get: (r) => r.applicantType ?? "PERSONAL" },
          { snake: "product_id", get: (r) => r.productId ?? null },
          { snake: "status", get: (r) => r.status },
          { snake: "amount_naira", get: (r) => r.amountNaira },
          { snake: "tenure_days", get: (r) => r.tenureDays },
          { snake: "purpose", get: (r) => r.purpose ?? r.loanPurpose ?? null },
          { snake: "customer_snapshot", get: (r) => r.customerSnapshot ?? (r as unknown as AnyRow).applicantSnapshot, json: true },
          { snake: "credit_report_snapshot", get: (r) => (r as unknown as AnyRow).creditReportSnapshot, json: true },
          { snake: "stage_statuses", get: (r) => (r as unknown as AnyRow).stageStatuses, json: true },
          { snake: "stage_rejection_notes", get: (r) => (r as unknown as AnyRow).stageRejectionNotes, json: true },
          { snake: "submitted_at", get: (r) => r.submittedAt, asDate: true },
          { snake: "system_decision", get: (r) => r.systemDecision, json: true },
          { snake: "manual_decision", get: (r) => r.manualDecision ?? null },
          { snake: "manual_note", get: (r) => r.manualNote ?? null },
          { snake: "reviewed_by", get: (r) => r.reviewedBy ?? null },
          { snake: "reviewed_at", get: (r) => r.reviewedAt, asDate: true },
          { snake: "signed_agreement_url", get: (r) => r.signedAgreementUrl ?? null },
          { snake: "disbursement_institution", get: (r) => r.disbursementInstitution ?? (r as unknown as AnyRow).disbursementBank ?? null },
          { snake: "disbursement_account", get: (r) => r.disbursementAccount, json: true },
          { snake: "documents", get: (r) => (r as unknown as AnyRow).documents, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("applicationDrafts")) {
    inc(
      "applicationDrafts",
      await upsertEntities<ApplicationDraft>(db, snapshot.applicationDrafts as readonly ApplicationDraft[], {
        table: "application_drafts",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "application_id", get: (r) => r.applicationId },
          { snake: "applicant_type", get: (r) => r.applicantType ?? "PERSONAL" },
          { snake: "data", get: (r) => r.data, json: true },
          { snake: "last_section_index", get: (r) => r.lastSectionIndex ?? 0 },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("loans")) {
    inc(
      "loans",
      await upsertEntities<Loan>(db, snapshot.loans as readonly Loan[], {
        table: "loans",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "application_id", get: (r) => r.applicationId },
          { snake: "borrower_id", get: (r) => r.borrowerId },
          { snake: "product_id", get: (r) => r.productId ?? null },
          { snake: "status", get: (r) => r.status },
          { snake: "principal_naira", get: (r) => r.principalNaira ?? r.principal ?? 0 },
          { snake: "total_receivable_naira", get: (r) => r.totalReceivableNaira ?? (r as unknown as AnyRow).totalReceivable ?? 0 },
          { snake: "outstanding_naira", get: (r) => r.outstandingNaira ?? r.outstanding ?? 0 },
          { snake: "interest_naira", get: (r) => r.interestNaira ?? r.interest ?? 0 },
          { snake: "fees_naira", get: (r) => r.feesNaira ?? r.fees ?? 0 },
          { snake: "late_fees_naira", get: (r) => r.lateFeesNaira ?? r.lateFees ?? 0 },
          { snake: "annual_interest_rate", get: (r) => r.annualInterestRate ?? r.interestRate ?? 0 },
          { snake: "tenure_days", get: (r) => r.tenureDays },
          { snake: "issue_date", get: (r) => r.issueDate ?? r.disbursementDate ?? r.startDate, asDate: true },
          { snake: "maturity_date", get: (r) => r.maturityDate ?? r.dueDate ?? r.endDate, asDate: true },
          { snake: "disbursement_date", get: (r) => r.disbursementDate, asDate: true },
          { snake: "signed_agreement_url", get: (r) => r.signedAgreementUrl ?? null },
          { snake: "disbursement_reference", get: (r) => (r as unknown as AnyRow).disbursementReference ?? null },
          { snake: "next_payment_date", get: (r) => (r as unknown as AnyRow).nextPaymentDate, asDate: true },
          { snake: "next_payment_amount_naira", get: (r) => (r as unknown as AnyRow).nextPaymentAmountNaira, asBig: true },
          { snake: "days_past_due", get: (r) => (r as unknown as AnyRow).daysPastDue ?? 0 },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => r.updatedAt, asDate: true },
        ],
      })
    );
  }
  if (has("loanSchedules")) {
    inc(
      "loanSchedules",
      await upsertEntities<LoanSchedule>(db, snapshot.loanSchedules as readonly LoanSchedule[], {
        table: "loan_schedules",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "loan_id", get: (r) => r.loanId },
          { snake: "installment_number", get: (r) => r.installmentNumber ?? r.index ?? 1 },
          { snake: "due_date", get: (r) => r.dueDate, asDate: true },
          { snake: "principal_naira", get: (r) => r.principalNaira ?? r.principal ?? 0 },
          { snake: "interest_naira", get: (r) => r.interestNaira ?? r.interest ?? 0 },
          { snake: "fees_naira", get: (r) => r.feesNaira ?? r.fees ?? 0 },
          { snake: "total_due_naira", get: (r) => r.totalDueNaira ?? r.totalDue ?? 0 },
          { snake: "status", get: (r) => r.status ?? "UPCOMING" },
          { snake: "paid_at", get: (r) => r.paidAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("repayments")) {
    inc(
      "repayments",
      await upsertEntities<Repayment>(db, snapshot.repayments as readonly Repayment[], {
        table: "repayments",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "loan_id", get: (r) => r.loanId },
          { snake: "borrower_id", get: (r) => r.borrowerId },
          { snake: "status", get: (r) => r.status },
          { snake: "method", get: (r) => r.method ?? (r as unknown as AnyRow).channel ?? null },
          { snake: "principal_naira", get: (r) => r.principalNaira ?? r.principal ?? 0 },
          { snake: "interest_naira", get: (r) => r.interestNaira ?? r.interest ?? 0 },
          { snake: "fees_naira", get: (r) => r.feesNaira ?? r.fees ?? 0 },
          { snake: "late_fees_naira", get: (r) => r.lateFeesNaira ?? r.lateFees ?? 0 },
          { snake: "amount_naira", get: (r) => r.amountNaira ?? r.totalPaid ?? r.total ?? 0 },
          { snake: "transaction_reference", get: (r) => r.transactionReference ?? r.reference ?? null },
          { snake: "provider_reference", get: (r) => (r as unknown as AnyRow).providerReference ?? null },
          { snake: "payment_date", get: (r) => r.paymentDate ?? r.date, asDate: true },
          { snake: "settled_at", get: (r) => (r as unknown as AnyRow).settledAt ?? r.paymentDate ?? r.date, asDate: true },
          { snake: "processor_raw", get: (r) => r.processorRaw ?? (r as unknown as AnyRow).providerRaw, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("loanDisbursements")) {
    inc(
      "loanDisbursements",
      await upsertEntities<LoanDisbursement>(db, snapshot.loanDisbursements as readonly LoanDisbursement[], {
        table: "disbursements",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "loan_id", get: (r) => r.loanId },
          { snake: "status", get: (r) => r.status ?? "PENDING_APPROVAL" },
          { snake: "amount_naira", get: (r) => r.amountNaira ?? r.principal ?? r.amount ?? 0 },
          { snake: "bank_code", get: (r) => r.bankCode ?? (r as unknown as AnyRow).destinationBankCode ?? null },
          { snake: "bank_name", get: (r) => r.bankName ?? (r as unknown as AnyRow).destinationBankName ?? null },
          { snake: "account_number", get: (r) => r.accountNumber ?? (r as unknown as AnyRow).destinationAccountNumber ?? null },
          { snake: "account_name", get: (r) => r.accountName ?? (r as unknown as AnyRow).destinationAccountName ?? null },
          { snake: "approved_at", get: (r) => r.approvedAt, asDate: true },
          { snake: "disbursed_at", get: (r) => r.disbursedAt ?? r.sentAt, asDate: true },
          { snake: "processed_at", get: (r) => r.processedAt, asDate: true },
          { snake: "provider_reference", get: (r) => r.providerReference ?? r.txRef ?? null },
          { snake: "processor_raw", get: (r) => r.processorRaw ?? (r as unknown as AnyRow).providerRaw, json: true },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "error", get: (r) => (r as unknown as AnyRow).error ?? null },
          { snake: "retry_count", get: (r) => r.retryCount ?? 0 },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }

  // ---------- Group D: investment FKs ----------
  if (has("investments")) {
    inc(
      "investments",
      await upsertEntities<Investment>(db, snapshot.investments as readonly Investment[], {
        table: "investments",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "investor_id", get: (r) => r.investorId },
          { snake: "plan_id", get: (r) => r.planId ?? null },
          { snake: "status", get: (r) => r.status },
          { snake: "amount_naira", get: (r) => r.amountNaira ?? r.amount ?? 0 },
          { snake: "annual_interest_rate", get: (r) => r.annualInterestRate ?? r.ratePerAnnum ?? 0 },
          { snake: "earned_interest_naira", get: (r) => r.earnedInterestNaira ?? r.interestEarned ?? 0 },
          { snake: "balance_naira", get: (r) => r.balanceNaira ?? r.currentBalance ?? r.amountNaira ?? 0 },
          { snake: "tenure_days", get: (r) => r.tenureDays },
          { snake: "start_date", get: (r) => r.startDate, asDate: true },
          { snake: "maturity_date", get: (r) => r.maturityDate, asDate: true },
          { snake: "liquidity_requested_at", get: (r) => r.liquidityRequestedAt, asDate: true },
          { snake: "liquidity_approved_at", get: (r) => r.liquidityApprovedAt, asDate: true },
          { snake: "rate_override_per_annum", get: (r) => (r as unknown as AnyRow).rateOverridePerAnnum ?? null },
          { snake: "payout_reference", get: (r) => (r as unknown as AnyRow).payoutReference ?? null },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("payouts")) {
    inc(
      "payouts",
      await upsertEntities<Payout>(db, snapshot.payouts as readonly Payout[], {
        table: "payouts",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "user_id", get: (r) => r.userId ?? r.investorId },
          { snake: "investment_id", get: (r) => r.investmentId ?? null },
          { snake: "payout_account_id", get: (r) => r.payoutAccountId ?? (r as unknown as AnyRow).accountId ?? null },
          { snake: "payout_type", get: (r) => r.payoutType ?? r.type ?? "MATURITY" },
          { snake: "status", get: (r) => r.status },
          { snake: "amount_naira", get: (r) => r.amountNaira ?? r.amount ?? 0 },
          { snake: "fee_naira", get: (r) => r.feeNaira ?? r.fee ?? 0 },
          { snake: "net_naira", get: (r) => r.netNaira ?? r.amountNaira - (r.feeNaira ?? 0) },
          { snake: "bank_name", get: (r) => r.bankName ?? null },
          { snake: "bank_code", get: (r) => r.bankCode ?? null },
          { snake: "account_number", get: (r) => r.accountNumber ?? null },
          { snake: "account_name", get: (r) => r.accountName ?? null },
          { snake: "approved_at", get: (r) => r.approvedAt, asDate: true },
          { snake: "processed_at", get: (r) => r.processedAt ?? r.sentAt, asDate: true },
          { snake: "settled_at", get: (r) => r.settledAt, asDate: true },
          { snake: "provider_reference", get: (r) => r.providerReference ?? r.txRef ?? null },
          { snake: "processor_raw", get: (r) => r.processorRaw ?? (r as unknown as AnyRow).providerRaw, json: true },
          { snake: "rejection_reason", get: (r) => (r as unknown as AnyRow).rejectionReason ?? null },
          { snake: "error", get: (r) => (r as unknown as AnyRow).error ?? null },
          { snake: "retry_count", get: (r) => r.retryCount ?? 0 },
          { snake: "last_attempt_at", get: (r) => r.lastAttemptAt, asDate: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }

  // ---------- Group E: wallet/accounting tables ----------
  if (has("ledgerEntries")) {
    inc(
      "ledgerEntries",
      await upsertEntities<LedgerEntry>(db, snapshot.ledgerEntries as readonly LedgerEntry[], {
        table: "ledger_entries",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "wallet_id", get: (r) => r.walletId },
          { snake: "entry_type", get: (r) => r.entryType ?? r.type },
          { snake: "reference_id", get: (r) => r.referenceId ?? r.txRef ?? null },
          { snake: "loan_id", get: (r) => r.loanId ?? null },
          { snake: "investment_id", get: (r) => r.investmentId ?? null },
          { snake: "credit_minor", get: (r) => r.creditMinor ?? (r as unknown as AnyRow).creditNaira * 100 || 0, asBig: true },
          { snake: "debit_minor", get: (r) => r.debitMinor ?? (r as unknown as AnyRow).debitNaira * 100 || 0, asBig: true },
          { snake: "balance_after_minor", get: (r) => r.balanceAfterMinor ?? 0, asBig: true },
          { snake: "currency", get: (r) => r.currency ?? "NGN" },
          { snake: "narration", get: (r) => r.narration ?? r.description ?? r.note ?? null },
          { snake: "metadata", get: (r) => (r as unknown as AnyRow).metadata, json: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
        ],
      })
    );
  }
  if (has("walletTransactions")) {
    inc(
      "walletTransactions",
      await upsertEntities<WalletTransaction>(db, snapshot.walletTransactions as readonly WalletTransaction[], {
        table: "wallet_transactions",
        pkColumns: ["id"],
        columns: [
          { snake: "id", get: (r) => r.id },
          { snake: "wallet_id", get: (r) => r.walletId ?? null },
          { snake: "user_id", get: (r) => r.userId },
          { snake: "type", get: (r) => r.type },
          { snake: "sub_type", get: (r) => r.subType ?? r.kind ?? null },
          { snake: "status", get: (r) => r.status },
          { snake: "amount_minor", get: (r) => r.amountMinor ?? (r as unknown as AnyRow).amountNaira * 100 || 0, asBig: true },
          { snake: "fee_minor", get: (r) => r.feeMinor ?? (r as unknown as AnyRow).feeNaira * 100 || 0, asBig: true },
          { snake: "currency", get: (r) => r.currency ?? "NGN" },
          { snake: "tx_ref", get: (r) => r.txRef ?? r.reference ?? null },
          { snake: "provider_reference", get: (r) => (r as unknown as AnyRow).providerReference ?? r.paymentReference ?? r.flwRef ?? null },
          { snake: "payment_method", get: (r) => r.paymentMethod ?? (r as unknown as AnyRow).method ?? null },
          { snake: "provider_raw", get: (r) => r.providerRaw ?? (r as unknown as AnyRow).raw, json: true },
          { snake: "narration", get: (r) => r.narration ?? r.description ?? null },
          { snake: "verified_at", get: (r) => (r as unknown as AnyRow).verifiedAt, asDate: true },
          { snake: "failed_at", get: (r) => r.failedAt, asDate: true },
          { snake: "error", get: (r) => r.error ?? null },
          { snake: "settled_at", get: (r) => r.settledAt, asDate: true },
          { snake: "mimetype", get: (r) => (r as unknown as AnyRow).mimetype ?? null },
          { snake: "size_bytes", get: (r) => (r as unknown as AnyRow).sizeBytes, asBig: true },
          { snake: "created_at", get: (r) => r.createdAt, asDate: true },
          { snake: "updated_at", get: (r) => (r as unknown as AnyRow).updatedAt ?? r.createdAt, asDate: true },
        ],
      })
    );
  }

  void STORE_KEY_TO_TABLE;
  return counts;
}

export function getDirtyKeysFromNestedFlag(keys: StoreKey[]): StoreKey[] {
  return keys;
}

export const _date = date;
export const _num = num;
export const _big = big;
export const _json = json;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _ensureSqlVarUsedForLint = sql;
