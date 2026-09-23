import type { NeonQueryFunction } from "@neondatabase/serverless";
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

const date = (value: string | undefined | null): Date | null => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const big = (value: number | bigint | undefined | null): string | null =>
  value === undefined || value === null ? null : String(value);

const json = (value: unknown): string => JSON.stringify(value ?? null);

const column = (value: string): string => `"${value.replace(/"/g, '""')}"`;

const BATCH_SIZE = 100;

type UpsertArgs<T> = {
  table: string;
  pkColumns: string[];
  columns: Array<{
    snake: string;
    get: (row: T) => unknown;
    json?: boolean;
    asDate?: boolean;
    asBig?: boolean;
  }>;
};

// Postgres accepts at most 65535 bind parameters per statement. Keep a wide
// safety margin: chunk size = min(MAX_ROWS_PER_STATEMENT, floor(60000 / columns)).
const MAX_ROWS_PER_STATEMENT = 100;

export async function upsertEntities<T>(
  db: NeonQueryFunction<false, false>,
  rows: readonly T[],
  args: UpsertArgs<T>
): Promise<number> {
  if (rows.length === 0) return 0;

  const columns = args.columns.map((entry) => column(entry.snake));
  const conflict = args.pkColumns.map(column).join(", ");
  const updates = args.columns
    .filter((entry) => !args.pkColumns.includes(entry.snake))
    .map((entry) => `${column(entry.snake)} = EXCLUDED.${column(entry.snake)}`)
    .join(", ");

  // Multi-row INSERT ... ON CONFLICT. One round trip per chunk instead of one
  // round trip per row — with a serverless driver (Neon) each query is an HTTPS
  // round trip, so per-row queries made every mutation take seconds to minutes.
  const rowsPerStatement = Math.max(1, Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(60000 / args.columns.length)));

  let processed = 0;
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const chunk = rows.slice(start, start + rowsPerStatement);
    const tuples: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 0;
    for (const row of chunk) {
      const placeholders: string[] = [];
      for (const entry of args.columns) {
        paramIndex += 1;
        placeholders.push(`$${paramIndex}`);
        const value = entry.get(row);
        if (entry.asDate) values.push(date(value as string | undefined | null));
        else if (entry.asBig) values.push(big(value as number | bigint | undefined | null));
        else if (entry.json) values.push(typeof value === "string" ? value : json(value));
        else values.push(value ?? null);
      }
      tuples.push(`(${placeholders.join(", ")})`);
    }
    const statement = `INSERT INTO ${args.table} (${columns.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (${conflict}) ${updates ? `DO UPDATE SET ${updates}` : "DO NOTHING"}`;
    await db.query(statement, values);
    processed += chunk.length;
  }
  return processed;
}

export type Snapshot = Record<StoreKey, readonly unknown[]>;
export type EntityCounts = Partial<Record<StoreKey, number>>;

const allStoreKeys: StoreKey[] = [
  "users", "wallets", "ledgerEntries", "walletTransactions", "kycCases",
  "identityVerificationEvents", "documents", "payoutAccounts", "investmentPlans",
  "investments", "loanApplications", "loans", "loanSchedules", "repayments",
  "payouts", "creditHistory", "creditScores", "creditReports", "otpChallenges",
  "passwordResetTokens", "notifications", "providerEvents", "consents", "loanProducts",
  "auditLogs", "adminLedger", "platformSettings", "investorWithdrawals",
  "disbursementAccounts", "loanDisbursements", "accountChangeRequests", "applicationDrafts",
];

export async function decomposeAndUpsertAll(
  db: NeonQueryFunction<false, false>,
  snapshot: Snapshot,
  changedKeys?: StoreKey[]
): Promise<EntityCounts> {
  const scope = new Set(changedKeys?.length ? changedKeys : allStoreKeys);
  const counts: EntityCounts = {};
  const has = (key: StoreKey) => scope.has(key);
  const add = (key: StoreKey, value: number) => {
    counts[key] = (counts[key] ?? 0) + value;
  };

  if (has("loanProducts")) {
    add("loanProducts", await upsertEntities<LoanProduct>(db, snapshot.loanProducts as readonly LoanProduct[], {
      table: "loan_products",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "name", get: (row) => row.name },
        { snake: "description", get: (row) => row.description },
        { snake: "min_amount_naira", get: (row) => row.minAmountNaira },
        { snake: "max_amount_naira", get: (row) => row.maxAmountNaira },
        { snake: "default_tenure_days", get: (row) => row.defaultTenureDays },
        { snake: "interest_rate_percent", get: (row) => row.interestRatePercent },
        { snake: "interest_type", get: (row) => row.interestType },
        { snake: "processing_fee_percent", get: (row) => row.processingFeePercent },
        { snake: "late_fee_percent", get: (row) => row.lateFeePercent },
        { snake: "late_fee_type", get: (row) => row.lateFeeType },
        { snake: "grace_period_days", get: (row) => row.gracePeriodDays },
        { snake: "is_active", get: (row) => row.isActive },
        { snake: "version", get: (row) => row.version },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("investmentPlans")) {
    add("investmentPlans", await upsertEntities<InvestmentPlan>(db, snapshot.investmentPlans as readonly InvestmentPlan[], {
      table: "investment_plans",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "name", get: (row) => row.name },
        { snake: "description", get: (row) => row.description },
        { snake: "currency", get: (row) => row.currency },
        { snake: "min_amount_naira", get: (row) => row.minAmountNaira },
        { snake: "max_amount_naira", get: (row) => row.maxAmountNaira },
        { snake: "tenure_days", get: (row) => row.tenureDays },
        { snake: "annual_rate_percent", get: (row) => row.annualRatePercent },
        { snake: "rate_type", get: (row) => row.rateType },
        { snake: "early_liquidity_allowed", get: (row) => row.earlyLiquidityAllowed },
        { snake: "early_liquidity_fee_percent", get: (row) => row.earlyLiquidityFeePercent },
        { snake: "gateway_fee_percent", get: (row) => row.gatewayFeePercent },
        { snake: "forfeit_interest_on_early_exit", get: (row) => row.forfeitInterestOnEarlyExit },
        { snake: "capacity_naira", get: (row) => row.capacityNaira },
        { snake: "is_active", get: (row) => row.isActive },
        { snake: "allow_new_investments_after_close", get: (row) => row.allowNewInvestmentsAfterClose },
        { snake: "version", get: (row) => row.version },
        { snake: "effective_from", get: (row) => row.effectiveFrom, asDate: true },
        { snake: "effective_to", get: (row) => row.effectiveTo, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("platformSettings")) {
    for (const setting of snapshot.platformSettings as readonly PlatformSettings[]) {
      await db.query(
        `INSERT INTO system_settings (id, key, value, created_at, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         ON CONFLICT (id) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [setting.id, "platform", JSON.stringify(setting), date(setting.createdAt), date(setting.updatedAt)]
      );
      add("platformSettings", 1);
    }
  }

  if (has("users")) {
    const sourceUsers = snapshot.users as readonly User[];
    add("users", await upsertEntities<User>(db, sourceUsers, {
      table: "users",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "email", get: (row) => row.email },
        { snake: "phone", get: (row) => row.phone },
        { snake: "full_name", get: (row) => row.fullName },
        { snake: "password_hash", get: (row) => row.passwordHash },
        { snake: "kyc_status", get: (row) => row.kycStatus },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
        { snake: "last_login_at", get: (row) => row.lastLoginAt, asDate: true },
        { snake: "is_active", get: (row) => row.isActive ?? true },
        { snake: "preferred_otp_channel", get: (row) => row.preferredOtpChannel },
        { snake: "otp_login_enabled", get: (row) => row.otpLoginEnabled ?? false },
        { snake: "otp_verified_at", get: (row) => row.otpVerifiedAt, asDate: true },
        { snake: "date_of_birth", get: (row) => row.dateOfBirth, asDate: true },
        { snake: "residential_address", get: (row) => row.residentialAddress, json: true },
        { snake: "occupation", get: (row) => row.occupation },
        { snake: "source_of_funds", get: (row) => row.sourceOfFunds },
        { snake: "metadata", get: (row) => row.metadata ?? {}, json: true },
      ],
    }));
    for (const user of sourceUsers) {
      for (const role of user.roles) {
        await db.query(
          `INSERT INTO roles (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
          [role, role]
        );
        await db.query(
          `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT (user_id, role_id) DO NOTHING`,
          [user.id, role]
        );
      }
      if (user.roles.includes("BORROWER")) {
        await db.query(
          `INSERT INTO borrower_profiles (id, user_id, date_of_birth, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, updated_at = EXCLUDED.updated_at`,
          [`borrower-${user.id}`, user.id, date(user.dateOfBirth), date(user.createdAt), date(user.updatedAt ?? user.createdAt)]
        );
      }
      if (user.roles.includes("INVESTOR")) {
        await db.query(
          `INSERT INTO investor_profiles (id, user_id, date_of_birth, occupation, source_of_funds, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id) DO UPDATE SET date_of_birth = EXCLUDED.date_of_birth, occupation = EXCLUDED.occupation, source_of_funds = EXCLUDED.source_of_funds, updated_at = EXCLUDED.updated_at`,
          [`investor-${user.id}`, user.id, date(user.dateOfBirth), user.occupation ?? null, user.sourceOfFunds ?? null, date(user.createdAt), date(user.updatedAt ?? user.createdAt)]
        );
      }
      if (user.roles.includes("ADMIN")) {
        await db.query(
          `INSERT INTO admin_profiles (id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`,
          [`admin-${user.id}`, user.id, date(user.createdAt)]
        );
      }
      const address = user.residentialAddress;
      if (address) {
        await db.query(
          `INSERT INTO addresses (id, user_id, line1, state, lga, is_primary, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)
           ON CONFLICT (id) DO UPDATE SET line1 = EXCLUDED.line1, state = EXCLUDED.state, lga = EXCLUDED.lga, updated_at = EXCLUDED.updated_at`,
          [
            `address-${user.id}`,
            user.id,
            typeof address.full === "string" ? address.full : null,
            typeof address.state === "string" ? address.state : null,
            typeof address.lga === "string" ? address.lga : null,
            date(user.createdAt),
            date(user.updatedAt ?? user.createdAt),
          ]
        );
      }
    }
  }

  if (has("wallets")) {
    add("wallets", await upsertEntities<Wallet>(db, snapshot.wallets as readonly Wallet[], {
      table: "wallets",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "available_minor", get: (row) => row.availableMinor, asBig: true },
        { snake: "held_minor", get: (row) => row.heldMinor, asBig: true },
        { snake: "pending_deposit_minor", get: (row) => row.pendingDepositMinor, asBig: true },
        { snake: "pending_payout_minor", get: (row) => row.pendingPayoutMinor, asBig: true },
        { snake: "total_credited_minor", get: (row) => row.totalCreditedMinor, asBig: true },
        { snake: "total_debited_minor", get: (row) => row.totalDebitedMinor, asBig: true },
        { snake: "currency", get: (row) => row.currency },
      ],
    }));
  }

  if (has("kycCases")) {
    add("kycCases", await upsertEntities<KycCase>(db, snapshot.kycCases as readonly KycCase[], {
      table: "kyc_cases",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "status", get: (row) => row.status },
        { snake: "bvn", get: (row) => row.bvn },
        { snake: "nin", get: (row) => row.nin },
        { snake: "category_results", get: (row) => row.categoryResults ?? {}, json: true },
        { snake: "bvn_verified_at", get: (row) => row.bvnVerifiedAt, asDate: true },
        { snake: "nin_verified_at", get: (row) => row.ninVerifiedAt, asDate: true },
        { snake: "liveness_verified_at", get: (row) => row.livenessVerifiedAt, asDate: true },
        { snake: "liveness_status", get: (row) => row.livenessStatus },
        { snake: "liveness_manual_uploaded", get: (row) => row.livenessManualUploaded ?? false },
        { snake: "verified_at", get: (row) => row.verifiedAt, asDate: true },
        { snake: "verified_details", get: (row) => row.verifiedDetails, json: true },
        { snake: "identity_photo", get: (row) => (row as any).identityPhotoUrl ?? row.identityPhoto },
        { snake: "selfie_image_data", get: (row) => row.selfieImageData },
        { snake: "provider_request_id", get: (row) => row.providerRequestId },
        { snake: "provider_raw", get: (row) => row.providerRaw, json: true },
        { snake: "checklist", get: (row) => row.checklist, json: true },
        { snake: "submitted_at", get: (row) => row.submittedAt, asDate: true },
        { snake: "reviewed_by", get: (row) => row.reviewedBy },
        { snake: "reviewed_at", get: (row) => row.reviewedAt, asDate: true },
        { snake: "rejection_reason", get: (row) => row.rejectionReason },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("identityVerificationEvents")) {
    add("identityVerificationEvents", await upsertEntities<IdentityVerificationEvent>(db, snapshot.identityVerificationEvents as readonly IdentityVerificationEvent[], {
      table: "identity_verification_events",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "kyc_case_id", get: (row) => row.kycCaseId },
        { snake: "provider", get: (row) => row.provider },
        { snake: "verification_type", get: (row) => row.verificationType },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "status", get: (row) => row.status },
        { snake: "match_score", get: (row) => row.matchScore },
        { snake: "raw_response", get: (row) => row.rawResponse, json: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("documents")) {
    add("documents", await upsertEntities<Document>(db, snapshot.documents as readonly Document[], {
      table: "documents",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "application_id", get: (row) => row.applicationId },
        { snake: "document_slot", get: (row) => row.documentSlot },
        { snake: "note", get: (row) => row.note },
        { snake: "document_type", get: (row) => row.documentType },
        { snake: "provider", get: (row) => row.provider },
        { snake: "provider_file_id", get: (row) => row.providerFileId },
        { snake: "file_name", get: (row) => row.fileName },
        { snake: "mime_type", get: (row) => row.mimeType },
        { snake: "size_bytes", get: (row) => row.sizeBytes, asBig: true },
        { snake: "status", get: (row) => row.status },
        { snake: "reviewed_by", get: (row) => row.reviewedBy },
        { snake: "reviewed_at", get: (row) => row.reviewedAt, asDate: true },
        { snake: "rejection_reason", get: (row) => row.rejectionReason },
        { snake: "version", get: (row) => row.version },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("payoutAccounts")) {
    add("payoutAccounts", await upsertEntities<PayoutAccount>(db, snapshot.payoutAccounts as readonly PayoutAccount[], {
      table: "payout_accounts",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "bank_name", get: (row) => row.bankName },
        { snake: "bank_code", get: (row) => row.bankCode },
        { snake: "account_number", get: (row) => row.accountNumber },
        { snake: "account_name", get: (row) => row.accountName },
        { snake: "account_name_enquiry_result", get: (row) => row.accountNameEnquiryResult },
        { snake: "is_default", get: (row) => row.isDefault ?? false },
        { snake: "status", get: (row) => row.status },
        { snake: "verified_at", get: (row) => row.verifiedAt, asDate: true },
        { snake: "verification_reference", get: (row) => row.verificationReference },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("disbursementAccounts")) {
    add("disbursementAccounts", await upsertEntities<DisbursementAccount>(db, snapshot.disbursementAccounts as readonly DisbursementAccount[], {
      table: "disbursement_accounts",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "bank_name", get: (row) => row.bankName },
        { snake: "bank_code", get: (row) => row.bankCode },
        { snake: "account_number", get: (row) => row.accountNumber },
        { snake: "account_name", get: (row) => row.accountName },
        { snake: "account_name_enquiry_result", get: (row) => row.accountNameEnquiryResult },
        { snake: "status", get: (row) => row.status },
        { snake: "verified_at", get: (row) => row.verifiedAt, asDate: true },
        { snake: "verification_reference", get: (row) => row.verificationReference },
        { snake: "rejection_reason", get: (row) => row.rejectionReason },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("otpChallenges")) {
    add("otpChallenges", await upsertEntities<OtpChallenge>(db, snapshot.otpChallenges as readonly OtpChallenge[], {
      table: "otp_challenges",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "action", get: (row) => row.action },
        { snake: "challenge_hash", get: (row) => row.challengeHash },
        { snake: "expires_at", get: (row) => row.expiresAt, asDate: true },
        { snake: "attempts", get: (row) => row.attempts },
        { snake: "max_attempts", get: (row) => row.maxAttempts },
        { snake: "consumed_at", get: (row) => row.consumedAt, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "delivery_channel", get: (row) => row.deliveryChannel },
      ],
    }));
  }

  if (has("passwordResetTokens")) {
    add("passwordResetTokens", await upsertEntities<PasswordResetToken>(db, snapshot.passwordResetTokens as readonly PasswordResetToken[], {
      table: "password_reset_tokens",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "token_hash", get: (row) => row.tokenHash },
        { snake: "expires_at", get: (row) => row.expiresAt, asDate: true },
        { snake: "consumed_at", get: (row) => row.consumedAt, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("notifications")) {
    add("notifications", await upsertEntities<Notification>(db, snapshot.notifications as readonly Notification[], {
      table: "notifications",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "channel", get: (row) => row.channel },
        { snake: "template", get: (row) => row.template },
        { snake: "template_version", get: (row) => row.templateVersion },
        { snake: "kind", get: (row) => row.kind },
        { snake: "subject", get: (row) => row.subject },
        { snake: "content", get: (row) => row.content },
        { snake: "recipient_masked", get: (row) => row.recipientMasked },
        { snake: "status", get: (row) => row.status },
        { snake: "provider_message_id", get: (row) => row.providerMessageId },
        { snake: "provider_status", get: (row) => row.providerStatus },
        { snake: "idempotency_key", get: (row) => row.idempotencyKey },
        { snake: "related_entity_type", get: (row) => row.relatedEntityType },
        { snake: "related_entity_id", get: (row) => row.relatedEntityId },
        { snake: "error", get: (row) => row.error },
        { snake: "retry_count", get: (row) => row.retryCount },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "sent_at", get: (row) => row.sentAt, asDate: true },
        { snake: "delivered_at", get: (row) => row.deliveredAt, asDate: true },
        { snake: "failed_at", get: (row) => row.failedAt, asDate: true },
      ],
    }));
  }

  if (has("consents")) {
    add("consents", await upsertEntities<Consent>(db, snapshot.consents as readonly Consent[], {
      table: "consents",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "consent_type", get: (row) => row.consentType },
        { snake: "consented_at", get: (row) => row.consentedAt, asDate: true },
        { snake: "withdrawn_at", get: (row) => row.withdrawnAt, asDate: true },
        { snake: "metadata", get: (row) => row.metadata, json: true },
      ],
    }));
  }

  if (has("providerEvents")) {
    add("providerEvents", await upsertEntities<ProviderWebhookEvent>(db, snapshot.providerEvents as readonly ProviderWebhookEvent[], {
      table: "provider_webhook_events",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id ?? `${row.provider}:${row.eventKey}` },
        { snake: "provider", get: (row) => row.provider },
        { snake: "event_key", get: (row) => row.eventKey },
        { snake: "event", get: (row) => row.event, json: true },
        { snake: "processed", get: (row) => row.processed ?? false },
        { snake: "processing_error", get: (row) => row.processingError },
        { snake: "received_at", get: (row) => row.receivedAt, asDate: true },
        { snake: "processed_at", get: (row) => row.processedAt, asDate: true },
      ],
    }));
  }

  // NOTE (FK ordering): entities that reference loans/repayments
  // (credit_history_events, admin_ledger_entries) MUST be upserted AFTER the
  // loans/repayments blocks below. They used to live here, BEFORE
  // loan_applications/loans — so approving a loan (which pushes a
  // LOAN_APPROVED credit event for the brand-new loan id) violated
  // credit_history_events.loan_id → loans(id) and the whole persist failed
  // with 503 "Unable to save your information", even though the in-memory
  // mutation had already been applied. All loan-child blocks now live in the
  // "loan children" section near the end of this function.
  if (has("investorWithdrawals")) {
    add("investorWithdrawals", await upsertEntities<InvestorWithdrawal>(db, snapshot.investorWithdrawals as readonly InvestorWithdrawal[], {
      table: "investor_withdrawals",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "investor_id", get: (row) => row.investorId },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "fee_naira", get: (row) => row.feeNaira },
        { snake: "net_naira", get: (row) => row.netNaira },
        { snake: "currency", get: (row) => row.currency },
        { snake: "bank_code", get: (row) => row.bankCode },
        { snake: "bank_name", get: (row) => row.bankName },
        { snake: "account_number", get: (row) => row.accountNumber },
        { snake: "account_name", get: (row) => row.accountName },
        { snake: "status", get: (row) => row.status },
        { snake: "narration", get: (row) => row.narration },
        { snake: "provider_transfer", get: (row) => row.providerTransfer, json: true },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "error", get: (row) => row.error },
        { snake: "processed_at", get: (row) => row.processedAt, asDate: true },
        { snake: "retry_count", get: (row) => row.retryCount ?? 0 },
        { snake: "last_attempt_at", get: (row) => row.lastAttemptAt, asDate: true },
        { snake: "idempotency_key", get: (row) => row.idempotencyKey },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("accountChangeRequests")) {
    add("accountChangeRequests", await upsertEntities<AccountChangeRequest>(db, snapshot.accountChangeRequests as readonly AccountChangeRequest[], {
      table: "account_change_requests",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "type", get: (row) => row.type },
        { snake: "status", get: (row) => row.status },
        { snake: "existing_snapshot", get: (row) => row.existingSnapshot, json: true },
        { snake: "new_snapshot", get: (row) => row.newSnapshot, json: true },
        { snake: "reason", get: (row) => row.reason },
        { snake: "reviewed_by", get: (row) => row.reviewedBy },
        { snake: "reviewed_at", get: (row) => row.reviewedAt, asDate: true },
        { snake: "rejection_reason", get: (row) => row.rejectionReason },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("loanApplications")) {
    add("loanApplications", await upsertEntities<LoanApplication>(db, snapshot.loanApplications as readonly LoanApplication[], {
      table: "loan_applications",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "application_id", get: (row) => row.applicationId },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "applicant_type", get: (row) => row.applicantType },
        { snake: "customer_snapshot", get: (row) => row.customerSnapshot, json: true },
        { snake: "credit_report_snapshot", get: (row) => row.creditReportSnapshot, json: true },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "tenure_days", get: (row) => row.tenureDays },
        { snake: "status", get: (row) => row.status },
        { snake: "stage_statuses", get: (row) => row.stageStatuses ?? {}, json: true },
        { snake: "stage_rejection_notes", get: (row) => row.stageRejectionNotes ?? {}, json: true },
        { snake: "system_decision", get: (row) => row.systemDecision, json: true },
        { snake: "manual_decision", get: (row) => row.manualDecision },
        { snake: "manual_note", get: (row) => row.manualNote },
        { snake: "disbursement_institution", get: (row) => row.disbursementInstitution },
        { snake: "disbursement_account", get: (row) => row.disbursementAccount, json: true },
        { snake: "signed_agreement_url", get: (row) => row.signedAgreementUrl },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
        { snake: "submitted_at", get: (row) => row.submittedAt, asDate: true },
        { snake: "approved_at", get: (row) => row.approvedAt, asDate: true },
      ],
    }));
  }

  if (has("applicationDrafts")) {
    add("applicationDrafts", await upsertEntities<ApplicationDraft>(db, snapshot.applicationDrafts as readonly ApplicationDraft[], {
      table: "application_drafts",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "application_id", get: (row) => row.applicationId },
        { snake: "applicant_type", get: (row) => row.applicantType },
        { snake: "data", get: (row) => row.data, json: true },
        { snake: "last_section_index", get: (row) => row.lastSectionIndex },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt, asDate: true },
      ],
    }));
  }

  if (has("loans")) {
    add("loans", await upsertEntities<Loan>(db, snapshot.loans as readonly Loan[], {
      table: "loans",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "application_id", get: (row) => row.applicationId },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "principal_naira", get: (row) => row.principalNaira },
        { snake: "total_interest_naira", get: (row) => row.totalInterestNaira },
        { snake: "total_fees_naira", get: (row) => row.totalFeesNaira },
        { snake: "total_repayment_naira", get: (row) => row.totalRepaymentNaira },
        { snake: "outstanding_naira", get: (row) => row.outstandingNaira },
        { snake: "outstanding_principal_naira", get: (row) => row.outstandingPrincipalNaira },
        { snake: "outstanding_interest_naira", get: (row) => row.outstandingInterestNaira },
        { snake: "admin_note", get: (row) => row.adminNote },
        { snake: "tenure_days", get: (row) => row.tenureDays },
        { snake: "status", get: (row) => row.status },
        { snake: "disbursed_at", get: (row) => row.disbursedAt, asDate: true },
        { snake: "due_at", get: (row) => row.dueAt, asDate: true },
        { snake: "paid_at", get: (row) => row.paidAt, asDate: true },
        { snake: "provider_transfer", get: (row) => row.providerTransfer, json: true },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("loanSchedules")) {
    add("loanSchedules", await upsertEntities<LoanSchedule>(db, snapshot.loanSchedules as readonly LoanSchedule[], {
      table: "loan_schedules",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "loan_id", get: (row) => row.loanId },
        { snake: "installment_number", get: (row) => row.installmentNumber },
        { snake: "due_date", get: (row) => row.dueDate, asDate: true },
        { snake: "principal_naira", get: (row) => row.principalNaira },
        { snake: "interest_naira", get: (row) => row.interestNaira },
        { snake: "fees_naira", get: (row) => row.feesNaira },
        { snake: "total_due_naira", get: (row) => row.totalDueNaira },
        { snake: "total_paid_naira", get: (row) => row.totalPaidNaira },
        { snake: "status", get: (row) => row.status },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("repayments")) {
    add("repayments", await upsertEntities<Repayment>(db, snapshot.repayments as readonly Repayment[], {
      table: "repayments",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "loan_id", get: (row) => row.loanId },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "principal_naira", get: (row) => row.principalNaira },
        { snake: "interest_naira", get: (row) => row.interestNaira },
        { snake: "late_fee_naira", get: (row) => row.lateFeeNaira },
        { snake: "other_fees_naira", get: (row) => row.otherFeesNaira },
        { snake: "currency", get: (row) => row.currency },
        { snake: "status", get: (row) => row.status },
        { snake: "provider", get: (row) => row.provider },
        { snake: "tx_ref", get: (row) => row.txRef },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "channel", get: (row) => row.channel },
        { snake: "on_time", get: (row) => row.onTime },
        { snake: "raw_response", get: (row) => row.rawResponse, json: true },
        { snake: "verified_at", get: (row) => row.verifiedAt, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("loanDisbursements")) {
    add("loanDisbursements", await upsertEntities<LoanDisbursement>(db, snapshot.loanDisbursements as readonly LoanDisbursement[], {
      table: "disbursements",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "loan_id", get: (row) => row.loanId },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "currency", get: (row) => row.currency },
        { snake: "status", get: (row) => row.status },
        { snake: "disbursement_account_snapshot", get: (row) => ({
          bankCode: row.bankCode,
          bankName: row.bankName,
          accountNumber: row.accountNumber,
          accountName: row.accountName,
        }), json: true },
        { snake: "provider_transfer", get: (row) => row.providerTransfer, json: true },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "application_id", get: (row) => row.applicationId },
        { snake: "narration", get: (row) => row.narration },
        { snake: "error", get: (row) => row.error },
        { snake: "processed_at", get: (row) => row.processedAt, asDate: true },
        { snake: "retry_of_id", get: (row) => row.retryOfId },
        { snake: "retry_count", get: (row) => row.retryCount ?? 0 },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  // ── Loan children that reference loans/repayments ─────────────────────────
  // These MUST come after loans/loanSchedules/repayments above, otherwise the
  // FK constraints (credit_history_events.loan_id → loans(id),
  // admin_ledger_entries.loan_id → loans(id), …) fail on freshly-created
  // loans (e.g. the LOAN_APPROVED credit event written when an admin approves
  // an application).

  if (has("creditHistory")) {
    add("creditHistory", await upsertEntities<CreditHistoryEvent>(db, snapshot.creditHistory as readonly CreditHistoryEvent[], {
      table: "credit_history_events",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "loan_id", get: (row) => row.loanId },
        { snake: "repayment_id", get: (row) => row.repaymentId },
        { snake: "event_type", get: (row) => row.eventType },
        { snake: "detail", get: (row) => row.detail },
        { snake: "metadata", get: (row) => row.metadata, json: true },
        { snake: "occurred_at", get: (row) => row.occurredAt, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("creditScores")) {
    add("creditScores", await upsertEntities<CreditScore>(db, snapshot.creditScores as readonly CreditScore[], {
      table: "credit_scores",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "version", get: (row) => row.version },
        { snake: "score", get: (row) => row.score },
        { snake: "band", get: (row) => row.band },
        { snake: "factors", get: (row) => row.factors, json: true },
        { snake: "rules_version", get: (row) => row.rulesVersion },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("creditReports")) {
    add("creditReports", await upsertEntities<CreditReport>(db, snapshot.creditReports as readonly CreditReport[], {
      table: "credit_reports",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "provider", get: (row) => row.provider },
        { snake: "consent_granted_at", get: (row) => row.consentGrantedAt, asDate: true },
        { snake: "requested_at", get: (row) => row.requestedAt, asDate: true },
        { snake: "report_reference", get: (row) => row.reportReference },
        { snake: "status", get: (row) => row.status },
        { snake: "score", get: (row) => row.score },
        { snake: "normalized_fields", get: (row) => row.normalizedFields, json: true },
        { snake: "redacted_raw", get: (row) => row.redactedRaw, json: true },
        { snake: "expires_at", get: (row) => row.expiresAt, asDate: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("adminLedger")) {
    add("adminLedger", await upsertEntities<AdminLedgerEntry>(db, snapshot.adminLedger as readonly AdminLedgerEntry[], {
      table: "admin_ledger_entries",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "entry_type", get: (row) => row.entryType },
        { snake: "reference_id", get: (row) => row.referenceId },
        { snake: "investor_id", get: (row) => row.investorId },
        { snake: "borrower_id", get: (row) => row.borrowerId },
        { snake: "loan_id", get: (row) => row.loanId },
        { snake: "amount_minor", get: (row) => row.amountMinor, asBig: true },
        { snake: "direction", get: (row) => row.direction },
        { snake: "balance_after_minor", get: (row) => row.balanceAfterMinor, asBig: true },
        { snake: "currency", get: (row) => row.currency },
        { snake: "description", get: (row) => row.description },
        { snake: "metadata", get: (row) => row.metadata, json: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  // audit_logs only references users, but it is cheap and safe to persist it
  // here alongside the other child entities.
  if (has("auditLogs")) {
    add("auditLogs", await upsertEntities<AuditLog>(db, snapshot.auditLogs as readonly AuditLog[], {
      table: "audit_logs",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "action", get: (row) => row.action },
        { snake: "resource_type", get: (row) => row.resourceType },
        { snake: "resource_id", get: (row) => row.resourceId },
        { snake: "metadata", get: (row) => row.metadata, json: true },
        { snake: "ip_address", get: (row) => row.ipAddress },
        { snake: "user_agent", get: (row) => row.userAgent },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("investments")) {
    add("investments", await upsertEntities<Investment>(db, snapshot.investments as readonly Investment[], {
      table: "investments",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "investor_id", get: (row) => row.investorId },
        { snake: "plan_id", get: (row) => row.planId },
        { snake: "plan_version", get: (row) => row.planVersion ?? 1 },
        { snake: "plan_snapshot", get: (row) => row.planSnapshot, json: true },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "expected_earnings_naira", get: (row) => row.expectedEarningsNaira },
        { snake: "tenure_days", get: (row) => row.tenureDays },
        { snake: "annual_rate_percent", get: (row) => row.annualRatePercent },
        { snake: "starts_at", get: (row) => row.startsAt, asDate: true },
        { snake: "matures_at", get: (row) => row.maturesAt, asDate: true },
        { snake: "status", get: (row) => row.status },
        { snake: "liquidity_requested_at", get: (row) => row.liquidityRequestedAt, asDate: true },
        { snake: "liquidity_approved_at", get: (row) => row.liquidityApprovedAt, asDate: true },
        { snake: "liquidity_fee_naira", get: (row) => row.liquidityFeeNaira },
        { snake: "net_payout_naira", get: (row) => row.netPayoutNaira },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("payouts")) {
    add("payouts", await upsertEntities<Payout>(db, snapshot.payouts as readonly Payout[], {
      table: "payouts",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "investment_id", get: (row) => row.investmentId },
        { snake: "payout_type", get: (row) => row.payoutType },
        { snake: "principal_naira", get: (row) => row.principalNaira },
        { snake: "earnings_naira", get: (row) => row.earningsNaira },
        { snake: "fees_naira", get: (row) => row.feesNaira },
        { snake: "amount_naira", get: (row) => row.amountNaira },
        { snake: "currency", get: (row) => row.currency },
        { snake: "status", get: (row) => row.status },
        { snake: "payout_account_snapshot", get: (row) => row.payoutAccountSnapshot, json: true },
        { snake: "provider_transfer", get: (row) => row.providerTransfer, json: true },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "retry_count", get: (row) => row.retryCount },
        { snake: "last_attempt_at", get: (row) => row.lastAttemptAt, asDate: true },
        { snake: "error", get: (row) => row.error },
        { snake: "idempotency_key", get: (row) => row.idempotencyKey },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("ledgerEntries")) {
    add("ledgerEntries", await upsertEntities<LedgerEntry>(db, snapshot.ledgerEntries as readonly LedgerEntry[], {
      table: "ledger_entries",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "wallet_id", get: (row) => row.walletId },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "entry_type", get: (row) => row.entryType },
        { snake: "reference_id", get: (row) => row.referenceId },
        { snake: "amount_minor", get: (row) => row.amountMinor, asBig: true },
        { snake: "direction", get: (row) => row.direction },
        { snake: "balance_after_minor", get: (row) => row.balanceAfterMinor, asBig: true },
        { snake: "held_after_minor", get: (row) => row.heldAfterMinor, asBig: true },
        { snake: "currency", get: (row) => row.currency },
        { snake: "description", get: (row) => row.description },
        { snake: "metadata", get: (row) => row.metadata, json: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
      ],
    }));
  }

  if (has("walletTransactions")) {
    add("walletTransactions", await upsertEntities<WalletTransaction>(db, snapshot.walletTransactions as readonly WalletTransaction[], {
      table: "wallet_transactions",
      pkColumns: ["id"],
      columns: [
        { snake: "id", get: (row) => row.id },
        { snake: "user_id", get: (row) => row.userId },
        { snake: "wallet_id", get: (row) => row.walletId },
        { snake: "type", get: (row) => row.type },
        { snake: "amount_minor", get: (row) => row.amountMinor, asBig: true },
        { snake: "currency", get: (row) => row.currency },
        { snake: "status", get: (row) => row.status },
        { snake: "provider", get: (row) => row.provider },
        { snake: "provider_reference", get: (row) => row.providerReference },
        { snake: "provider_transaction_id", get: (row) => row.providerTransactionId },
        { snake: "tx_ref", get: (row) => row.txRef },
        { snake: "verified_at", get: (row) => row.verifiedAt, asDate: true },
        { snake: "metadata", get: (row) => row.metadata, json: true },
        { snake: "created_at", get: (row) => row.createdAt, asDate: true },
        { snake: "updated_at", get: (row) => row.updatedAt ?? row.createdAt, asDate: true },
      ],
    }));
  }

  return counts;
}
