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

type Row = Record<string, unknown>;

const iso = (value: unknown): string | undefined => {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined;
};

const str = (row: Row, key: string): string => {
  const value = row[key];
  return value == null ? "" : String(value);
};

const strNull = (row: Row, key: string): string | undefined => {
  const value = row[key];
  return value == null ? undefined : String(value);
};

const number = (row: Row, key: string): number => {
  const value = row[key];
  if (value == null) return 0;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
};

const nullableNumber = (row: Row, key: string): number | undefined => {
  const value = row[key];
  if (value == null) return undefined;
  const parsed = typeof value === "number" ? value : Number(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const bool = (row: Row, key: string, fallback = false): boolean => {
  const value = row[key];
  if (value == null) return fallback;
  if (typeof value === "boolean") return value;
  return value === "t" || value === "true" || value === "1" || value === 1;
};

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (value == null) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export type Snapshot = Record<StoreKey, unknown[]>;

export async function rebuildFromDatabase(db: NeonQueryFunction<false, false>): Promise<Snapshot | null> {
  const snapshot: Snapshot = {
    users: [], wallets: [], ledgerEntries: [], walletTransactions: [], kycCases: [],
    identityVerificationEvents: [], documents: [], payoutAccounts: [], investmentPlans: [],
    investments: [], loanApplications: [], loans: [], loanSchedules: [], repayments: [], payouts: [],
    creditHistory: [], creditScores: [], creditReports: [], otpChallenges: [], passwordResetTokens: [],
    notifications: [], providerEvents: [], consents: [], loanProducts: [], auditLogs: [], adminLedger: [],
    platformSettings: [], investorWithdrawals: [], disbursementAccounts: [], loanDisbursements: [],
    accountChangeRequests: [], applicationDrafts: [],
  };

  try {
    const userRows = await db.query("SELECT * FROM users ORDER BY created_at ASC") as Row[];
    const roleRows = await db.query("SELECT user_id, role_id FROM user_roles") as Array<{ user_id: string; role_id: string }>;
    const rolesByUser = new Map<string, User["roles"]>();
    for (const row of roleRows) {
      const roles = rolesByUser.get(row.user_id) ?? [];
      roles.push(row.role_id as User["roles"][number]);
      rolesByUser.set(row.user_id, roles);
    }
    for (const row of userRows) {
      const user: User = {
        id: str(row, "id"),
        email: str(row, "email"),
        phone: str(row, "phone"),
        fullName: str(row, "full_name"),
        passwordHash: str(row, "password_hash"),
        roles: rolesByUser.get(str(row, "id")) ?? [],
        kycStatus: (strNull(row, "kyc_status") ?? "NOT_STARTED") as User["kycStatus"],
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
        lastLoginAt: iso(row.last_login_at),
        isActive: bool(row, "is_active", true),
        preferredOtpChannel: (strNull(row, "preferred_otp_channel") ?? "EMAIL") as User["preferredOtpChannel"],
        otpLoginEnabled: bool(row, "otp_login_enabled"),
        otpVerifiedAt: iso(row.otp_verified_at),
        dateOfBirth: iso(row.date_of_birth)?.slice(0, 10),
        residentialAddress: parseJson<Record<string, unknown> | undefined>(row.residential_address, undefined),
        occupation: strNull(row, "occupation"),
        sourceOfFunds: strNull(row, "source_of_funds"),
        metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
      };
      snapshot.users.push(user);
    }

    for (const row of await db.query("SELECT * FROM wallets") as Row[]) {
      const wallet: Wallet = {
        id: str(row, "id"), userId: str(row, "user_id"),
        availableMinor: number(row, "available_minor"), heldMinor: number(row, "held_minor"),
        pendingDepositMinor: number(row, "pending_deposit_minor"), pendingPayoutMinor: number(row, "pending_payout_minor"),
        totalCreditedMinor: number(row, "total_credited_minor"), totalDebitedMinor: number(row, "total_debited_minor"),
        currency: "NGN",
      };
      snapshot.wallets.push(wallet);
    }

    for (const row of await db.query("SELECT * FROM ledger_entries ORDER BY created_at ASC") as Row[]) {
      const entry: LedgerEntry = {
        id: str(row, "id"), walletId: str(row, "wallet_id"), userId: str(row, "user_id"),
        entryType: str(row, "entry_type") as LedgerEntry["entryType"], referenceId: strNull(row, "reference_id"),
        amountMinor: number(row, "amount_minor"), direction: str(row, "direction") as LedgerEntry["direction"],
        balanceAfterMinor: number(row, "balance_after_minor"), heldAfterMinor: number(row, "held_after_minor"),
        currency: "NGN", description: strNull(row, "description"),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.ledgerEntries.push(entry);
    }

    for (const row of await db.query("SELECT * FROM wallet_transactions ORDER BY created_at ASC") as Row[]) {
      const transaction: WalletTransaction = {
        id: str(row, "id"), userId: str(row, "user_id"), walletId: strNull(row, "wallet_id"),
        type: str(row, "type") as WalletTransaction["type"], amountMinor: number(row, "amount_minor"), currency: "NGN",
        status: str(row, "status") as WalletTransaction["status"],
        provider: strNull(row, "provider") as WalletTransaction["provider"],
        providerReference: strNull(row, "provider_reference"), providerTransactionId: strNull(row, "provider_transaction_id"),
        txRef: strNull(row, "tx_ref"), verifiedAt: iso(row.verified_at),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.walletTransactions.push(transaction);
    }

    for (const row of await db.query("SELECT * FROM kyc_cases ORDER BY created_at ASC") as Row[]) {
      const kyc: KycCase = {
        id: str(row, "id"), userId: str(row, "user_id"), status: str(row, "status") as KycCase["status"],
        categoryResults: parseJson<KycCase["categoryResults"]>(row.category_results, {}),
        bvn: strNull(row, "bvn"), nin: strNull(row, "nin"), bvnVerifiedAt: iso(row.bvn_verified_at),
        ninVerifiedAt: iso(row.nin_verified_at), livenessVerifiedAt: iso(row.liveness_verified_at),
        providerRequestId: strNull(row, "provider_request_id"),
        providerRaw: parseJson<Record<string, unknown> | undefined>(row.provider_raw, undefined),
        submittedAt: iso(row.submitted_at), reviewedBy: strNull(row, "reviewed_by"), reviewedAt: iso(row.reviewed_at),
        verifiedAt: iso(row.verified_at), rejectionReason: strNull(row, "rejection_reason"),
        verifiedDetails: parseJson<Record<string, unknown> | undefined>(row.verified_details, undefined),
        identityPhoto: strNull(row, "identity_photo"), selfieImageData: strNull(row, "selfie_image_data"),
        checklist: parseJson<KycCase["checklist"]>(row.checklist, { bvn: false, nin: false, proofOfAddress: false, passport: false, signature: false, liveness: false }),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.kycCases.push(kyc);
    }

    for (const row of await db.query("SELECT * FROM identity_verification_events ORDER BY created_at ASC") as Row[]) {
      const event: IdentityVerificationEvent = {
        id: str(row, "id"), kycCaseId: str(row, "kyc_case_id"),
        provider: str(row, "provider") as IdentityVerificationEvent["provider"],
        verificationType: str(row, "verification_type") as IdentityVerificationEvent["verificationType"],
        providerReference: strNull(row, "provider_reference"), status: str(row, "status") as IdentityVerificationEvent["status"],
        matchScore: nullableNumber(row, "match_score"),
        rawResponse: parseJson<Record<string, unknown> | undefined>(row.raw_response, undefined),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.identityVerificationEvents.push(event);
    }

    for (const row of await db.query("SELECT * FROM documents ORDER BY created_at ASC") as Row[]) {
      const document: Document = {
        id: str(row, "id"), userId: str(row, "user_id"),
        documentType: str(row, "document_type") as Document["documentType"],
        provider: str(row, "provider") as Document["provider"], providerFileId: str(row, "provider_file_id"),
        fileName: strNull(row, "file_name"), mimeType: strNull(row, "mime_type"), sizeBytes: nullableNumber(row, "size_bytes"),
        status: str(row, "status") as Document["status"], reviewedBy: strNull(row, "reviewed_by"),
        reviewedAt: iso(row.reviewed_at), rejectionReason: strNull(row, "rejection_reason"),
        version: number(row, "version") || 1, createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.documents.push(document);
    }

    for (const row of await db.query("SELECT * FROM payout_accounts ORDER BY created_at ASC") as Row[]) {
      const account: PayoutAccount = {
        id: str(row, "id"), userId: str(row, "user_id"), bankName: strNull(row, "bank_name"),
        bankCode: str(row, "bank_code"), accountNumber: str(row, "account_number"), accountName: strNull(row, "account_name"),
        accountNameEnquiryResult: strNull(row, "account_name_enquiry_result"),
        isDefault: bool(row, "is_default"), status: str(row, "status") as PayoutAccount["status"],
        verifiedAt: iso(row.verified_at), verificationReference: strNull(row, "verification_reference"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.payoutAccounts.push(account);
    }

    for (const row of await db.query("SELECT * FROM disbursement_accounts ORDER BY created_at ASC") as Row[]) {
      const account: DisbursementAccount = {
        id: str(row, "id"), borrowerId: str(row, "borrower_id"), bankName: strNull(row, "bank_name"),
        bankCode: str(row, "bank_code"), accountNumber: str(row, "account_number"), accountName: strNull(row, "account_name"),
        accountNameEnquiryResult: strNull(row, "account_name_enquiry_result"),
        status: str(row, "status") as DisbursementAccount["status"], verifiedAt: iso(row.verified_at),
        verificationReference: strNull(row, "verification_reference"), rejectionReason: strNull(row, "rejection_reason") ?? null,
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.disbursementAccounts.push(account);
    }

    for (const row of await db.query("SELECT * FROM investment_plans ORDER BY created_at ASC") as Row[]) {
      const plan: InvestmentPlan = {
        id: str(row, "id"), name: str(row, "name"), description: strNull(row, "description"), currency: "NGN",
        minAmountNaira: number(row, "min_amount_naira"), maxAmountNaira: number(row, "max_amount_naira"),
        tenureDays: number(row, "tenure_days"), annualRatePercent: number(row, "annual_rate_percent"),
        rateType: str(row, "rate_type") as InvestmentPlan["rateType"], earlyLiquidityAllowed: bool(row, "early_liquidity_allowed"),
        earlyLiquidityFeePercent: number(row, "early_liquidity_fee_percent"), gatewayFeePercent: number(row, "gateway_fee_percent"),
        forfeitInterestOnEarlyExit: bool(row, "forfeit_interest_on_early_exit"), capacityNaira: nullableNumber(row, "capacity_naira"),
        isActive: bool(row, "is_active", true), allowNewInvestmentsAfterClose: bool(row, "allow_new_investments_after_close"),
        version: number(row, "version") || 1, effectiveFrom: iso(row.effective_from) ?? new Date().toISOString(),
        effectiveTo: iso(row.effective_to), createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.investmentPlans.push(plan);
    }

    for (const row of await db.query("SELECT * FROM investments ORDER BY created_at ASC") as Row[]) {
      const investment: Investment = {
        id: str(row, "id"), investorId: str(row, "investor_id"), planId: strNull(row, "plan_id"),
        planVersion: nullableNumber(row, "plan_version"), planSnapshot: parseJson<Record<string, unknown> | undefined>(row.plan_snapshot, undefined),
        amountNaira: number(row, "amount_naira"), expectedEarningsNaira: number(row, "expected_earnings_naira"),
        tenureDays: number(row, "tenure_days"), annualRatePercent: number(row, "annual_rate_percent"),
        startsAt: iso(row.starts_at) ?? new Date().toISOString(), maturesAt: iso(row.matures_at) ?? new Date().toISOString(),
        status: str(row, "status") as Investment["status"], liquidityRequestedAt: iso(row.liquidity_requested_at),
        liquidityApprovedAt: iso(row.liquidity_approved_at), liquidityFeeNaira: nullableNumber(row, "liquidity_fee_naira"),
        netPayoutNaira: nullableNumber(row, "net_payout_naira"), createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.investments.push(investment);
    }

    for (const row of await db.query("SELECT * FROM loan_applications ORDER BY created_at ASC") as Row[]) {
      const application: LoanApplication = {
        id: str(row, "id"), applicationId: str(row, "application_id"), borrowerId: str(row, "borrower_id"),
        applicantType: str(row, "applicant_type") as LoanApplication["applicantType"],
        customerSnapshot: parseJson<Record<string, unknown> | undefined>(row.customer_snapshot, undefined),
        creditReportSnapshot: parseJson<Record<string, unknown> | undefined>(row.credit_report_snapshot, undefined),
        amountNaira: nullableNumber(row, "amount_naira"), tenureDays: nullableNumber(row, "tenure_days"),
        status: str(row, "status") as LoanApplication["status"],
        stageStatuses: parseJson<LoanApplication["stageStatuses"]>(row.stage_statuses, {}),
        stageRejectionNotes: parseJson<LoanApplication["stageRejectionNotes"]>(row.stage_rejection_notes, {}),
        systemDecision: parseJson<Record<string, unknown> | undefined>(row.system_decision, undefined),
        manualDecision: strNull(row, "manual_decision") as LoanApplication["manualDecision"], manualNote: strNull(row, "manual_note"),
        disbursementInstitution: strNull(row, "disbursement_institution") ?? "VELO",
        disbursementAccount: parseJson<Record<string, unknown> | undefined>(row.disbursement_account, undefined),
        signedAgreementUrl: strNull(row, "signed_agreement_url"), createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at), submittedAt: iso(row.submitted_at), approvedAt: iso(row.approved_at),
      };
      snapshot.loanApplications.push(application);
    }

    for (const row of await db.query("SELECT * FROM loans ORDER BY created_at ASC") as Row[]) {
      const loan: Loan = {
        id: str(row, "id"), applicationId: str(row, "application_id"), borrowerId: str(row, "borrower_id"),
        principalNaira: number(row, "principal_naira"), totalInterestNaira: number(row, "total_interest_naira"),
        totalFeesNaira: number(row, "total_fees_naira"), totalRepaymentNaira: number(row, "total_repayment_naira"),
        outstandingNaira: number(row, "outstanding_naira"), tenureDays: number(row, "tenure_days"),
        status: str(row, "status") as Loan["status"], disbursedAt: iso(row.disbursed_at), dueAt: iso(row.due_at), paidAt: iso(row.paid_at),
        providerTransfer: parseJson<Record<string, unknown> | undefined>(row.provider_transfer, undefined),
        providerReference: strNull(row, "provider_reference"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.loans.push(loan);
    }

    for (const row of await db.query("SELECT * FROM loan_schedules ORDER BY loan_id, installment_number ASC") as Row[]) {
      const schedule: LoanSchedule = {
        id: str(row, "id"), loanId: str(row, "loan_id"), installmentNumber: number(row, "installment_number"),
        dueDate: iso(row.due_date) ?? new Date().toISOString(), principalNaira: number(row, "principal_naira"),
        interestNaira: number(row, "interest_naira"), feesNaira: number(row, "fees_naira"), totalDueNaira: number(row, "total_due_naira"),
        totalPaidNaira: number(row, "total_paid_naira"), status: str(row, "status") as LoanSchedule["status"],
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.loanSchedules.push(schedule);
    }

    for (const row of await db.query("SELECT * FROM repayments ORDER BY created_at ASC") as Row[]) {
      const repayment: Repayment = {
        id: str(row, "id"), loanId: str(row, "loan_id"), borrowerId: str(row, "borrower_id"), amountNaira: number(row, "amount_naira"),
        principalNaira: nullableNumber(row, "principal_naira"), interestNaira: nullableNumber(row, "interest_naira"),
        lateFeeNaira: nullableNumber(row, "late_fee_naira"), otherFeesNaira: nullableNumber(row, "other_fees_naira"), currency: "NGN",
        status: str(row, "status") as Repayment["status"], provider: strNull(row, "provider") as Repayment["provider"],
        txRef: strNull(row, "tx_ref"), providerReference: strNull(row, "provider_reference"), channel: strNull(row, "channel"),
        onTime: row.on_time == null ? undefined : bool(row, "on_time"),
        rawResponse: parseJson<Record<string, unknown> | undefined>(row.raw_response, undefined), verifiedAt: iso(row.verified_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.repayments.push(repayment);
    }

    for (const row of await db.query("SELECT * FROM payouts ORDER BY created_at ASC") as Row[]) {
      const payout: Payout = {
        id: str(row, "id"), userId: str(row, "user_id"), investmentId: strNull(row, "investment_id"),
        payoutType: str(row, "payout_type") as Payout["payoutType"], principalNaira: nullableNumber(row, "principal_naira"),
        earningsNaira: nullableNumber(row, "earnings_naira"), feesNaira: nullableNumber(row, "fees_naira"), amountNaira: number(row, "amount_naira"),
        currency: "NGN", status: str(row, "status") as Payout["status"],
        payoutAccountSnapshot: parseJson<Record<string, unknown> | undefined>(row.payout_account_snapshot, undefined),
        providerTransfer: parseJson<Record<string, unknown> | undefined>(row.provider_transfer, undefined), providerReference: strNull(row, "provider_reference"),
        retryCount: number(row, "retry_count"), lastAttemptAt: iso(row.last_attempt_at), error: strNull(row, "error"), idempotencyKey: strNull(row, "idempotency_key"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.payouts.push(payout);
    }

    for (const row of await db.query("SELECT * FROM credit_history_events ORDER BY created_at ASC") as Row[]) {
      const event: CreditHistoryEvent = {
        id: str(row, "id"), userId: str(row, "user_id"), loanId: strNull(row, "loan_id"), repaymentId: strNull(row, "repayment_id"),
        eventType: str(row, "event_type") as CreditHistoryEvent["eventType"], detail: strNull(row, "detail"),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined),
        occurredAt: iso(row.occurred_at) ?? new Date().toISOString(), createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.creditHistory.push(event);
    }

    for (const row of await db.query("SELECT * FROM credit_scores ORDER BY created_at ASC") as Row[]) {
      const score: CreditScore = {
        id: str(row, "id"), userId: str(row, "user_id"), version: str(row, "version"), score: number(row, "score"),
        band: str(row, "band") as CreditScore["band"], factors: parseJson<Array<Record<string, unknown>>>(row.factors, []),
        rulesVersion: strNull(row, "rules_version"), createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.creditScores.push(score);
    }

    for (const row of await db.query("SELECT * FROM credit_reports ORDER BY created_at ASC") as Row[]) {
      const report: CreditReport = {
        id: str(row, "id"), userId: str(row, "user_id"), provider: (strNull(row, "provider") ?? "manual") as CreditReport["provider"],
        consentGrantedAt: iso(row.consent_granted_at), requestedAt: iso(row.requested_at), reportReference: strNull(row, "report_reference"),
        status: str(row, "status") as CreditReport["status"], score: nullableNumber(row, "score"),
        normalizedFields: parseJson<Record<string, unknown> | undefined>(row.normalized_fields, undefined),
        redactedRaw: parseJson<Record<string, unknown> | undefined>(row.redacted_raw, undefined), expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.creditReports.push(report);
    }

    for (const row of await db.query("SELECT * FROM otp_challenges ORDER BY created_at ASC") as Row[]) {
      const challenge: OtpChallenge = {
        id: str(row, "id"), userId: str(row, "user_id"), action: str(row, "action") as OtpChallenge["action"],
        challengeHash: str(row, "challenge_hash"), expiresAt: iso(row.expires_at) ?? new Date().toISOString(),
        attempts: number(row, "attempts"), maxAttempts: number(row, "max_attempts") || 5, consumedAt: iso(row.consumed_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        deliveryChannel: (strNull(row, "delivery_channel") ?? "SMS") as OtpChallenge["deliveryChannel"],
      };
      snapshot.otpChallenges.push(challenge);
    }

    for (const row of await db.query("SELECT * FROM password_reset_tokens ORDER BY created_at ASC") as Row[]) {
      const token: PasswordResetToken = {
        id: str(row, "id"), userId: str(row, "user_id"), tokenHash: str(row, "token_hash"),
        expiresAt: iso(row.expires_at) ?? new Date().toISOString(), consumedAt: iso(row.consumed_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.passwordResetTokens.push(token);
    }

    for (const row of await db.query("SELECT * FROM notifications ORDER BY created_at ASC") as Row[]) {
      const notification: Notification = {
        id: str(row, "id"), userId: str(row, "user_id"), channel: str(row, "channel") as Notification["channel"],
        template: strNull(row, "template"), templateVersion: strNull(row, "template_version"), kind: strNull(row, "kind"),
        subject: strNull(row, "subject"), content: strNull(row, "content"), recipientMasked: strNull(row, "recipient_masked"),
        status: str(row, "status") as Notification["status"], providerMessageId: strNull(row, "provider_message_id"),
        providerStatus: strNull(row, "provider_status"), idempotencyKey: strNull(row, "idempotency_key"),
        relatedEntityType: strNull(row, "related_entity_type"), relatedEntityId: strNull(row, "related_entity_id"),
        error: strNull(row, "error"), retryCount: number(row, "retry_count"), createdAt: iso(row.created_at) ?? new Date().toISOString(),
        sentAt: iso(row.sent_at), deliveredAt: iso(row.delivered_at), failedAt: iso(row.failed_at),
      };
      snapshot.notifications.push(notification);
    }

    for (const row of await db.query("SELECT * FROM provider_webhook_events ORDER BY received_at ASC") as Row[]) {
      const event: ProviderWebhookEvent = {
        id: str(row, "id"), provider: str(row, "provider") as ProviderWebhookEvent["provider"], eventKey: str(row, "event_key"),
        event: parseJson<Record<string, unknown>>(row.event, {}), processed: bool(row, "processed"),
        processingError: strNull(row, "processing_error"), receivedAt: iso(row.received_at) ?? new Date().toISOString(), processedAt: iso(row.processed_at),
      };
      snapshot.providerEvents.push(event);
    }

    for (const row of await db.query("SELECT * FROM consents ORDER BY consented_at ASC") as Row[]) {
      const consent: Consent = {
        id: str(row, "id"), userId: str(row, "user_id"), consentType: str(row, "consent_type") as Consent["consentType"],
        consentedAt: iso(row.consented_at) ?? new Date().toISOString(), withdrawnAt: iso(row.withdrawn_at),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined),
      };
      snapshot.consents.push(consent);
    }

    for (const row of await db.query("SELECT * FROM loan_products ORDER BY created_at ASC") as Row[]) {
      const product: LoanProduct = {
        id: str(row, "id"), name: str(row, "name"), description: strNull(row, "description"),
        minAmountNaira: number(row, "min_amount_naira"), maxAmountNaira: number(row, "max_amount_naira"),
        defaultTenureDays: nullableNumber(row, "default_tenure_days"), interestRatePercent: number(row, "interest_rate_percent"),
        interestType: str(row, "interest_type") as LoanProduct["interestType"], processingFeePercent: number(row, "processing_fee_percent"),
        lateFeePercent: number(row, "late_fee_percent"), lateFeeType: str(row, "late_fee_type") as LoanProduct["lateFeeType"],
        gracePeriodDays: number(row, "grace_period_days"), isActive: bool(row, "is_active", true), version: number(row, "version") || 1,
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.loanProducts.push(product);
    }

    for (const row of await db.query("SELECT * FROM audit_logs ORDER BY created_at ASC") as Row[]) {
      const audit: AuditLog = {
        id: str(row, "id"), userId: strNull(row, "user_id"), action: str(row, "action"), resourceType: strNull(row, "resource_type"),
        resourceId: strNull(row, "resource_id"), metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined),
        ipAddress: strNull(row, "ip_address"), userAgent: strNull(row, "user_agent"), createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.auditLogs.push(audit);
    }

    for (const row of await db.query("SELECT * FROM admin_ledger_entries ORDER BY created_at ASC") as Row[]) {
      const entry: AdminLedgerEntry = {
        id: str(row, "id"), entryType: str(row, "entry_type") as AdminLedgerEntry["entryType"], referenceId: strNull(row, "reference_id"),
        investorId: strNull(row, "investor_id"), borrowerId: strNull(row, "borrower_id"), loanId: strNull(row, "loan_id"),
        amountMinor: number(row, "amount_minor"), direction: str(row, "direction") as AdminLedgerEntry["direction"],
        balanceAfterMinor: number(row, "balance_after_minor"), currency: "NGN", description: strNull(row, "description"),
        metadata: parseJson<Record<string, unknown> | undefined>(row.metadata, undefined), createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      snapshot.adminLedger.push(entry);
    }

    for (const row of await db.query("SELECT * FROM investor_withdrawals ORDER BY created_at ASC") as Row[]) {
      const withdrawal: InvestorWithdrawal = {
        id: str(row, "id"), investorId: str(row, "investor_id"), amountNaira: number(row, "amount_naira"),
        feeNaira: number(row, "fee_naira"), netNaira: number(row, "net_naira"), currency: "NGN", bankCode: str(row, "bank_code"),
        bankName: str(row, "bank_name"), accountNumber: str(row, "account_number"), accountName: str(row, "account_name"),
        status: str(row, "status") as InvestorWithdrawal["status"], narration: strNull(row, "narration"),
        providerTransfer: parseJson<Record<string, unknown> | undefined>(row.provider_transfer, undefined), providerReference: strNull(row, "provider_reference"),
        error: strNull(row, "error"), createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at) ?? new Date().toISOString(), processedAt: iso(row.processed_at),
        retryCount: nullableNumber(row, "retry_count"), lastAttemptAt: iso(row.last_attempt_at),
      };
      snapshot.investorWithdrawals.push(withdrawal);
    }

    for (const row of await db.query("SELECT * FROM disbursements ORDER BY created_at ASC") as Row[]) {
      const account = parseJson<Record<string, unknown>>(row.disbursement_account_snapshot, {});
      const disbursement: LoanDisbursement = {
        id: str(row, "id"), loanId: str(row, "loan_id"), borrowerId: str(row, "borrower_id"), amountNaira: number(row, "amount_naira"),
        currency: "NGN", bankCode: typeof account.bankCode === "string" ? account.bankCode : undefined,
        bankName: typeof account.bankName === "string" ? account.bankName : undefined,
        accountNumber: typeof account.accountNumber === "string" ? account.accountNumber : undefined,
        accountName: typeof account.accountName === "string" ? account.accountName : undefined,
        status: str(row, "status") as LoanDisbursement["status"], providerTransfer: parseJson<Record<string, unknown> | null>(row.provider_transfer, null),
        providerReference: strNull(row, "provider_reference") ?? null,
        applicationId: strNull(row, "application_id") ?? undefined,
        narration: strNull(row, "narration"), error: strNull(row, "error"),
        processedAt: iso(row.processed_at), retryOfId: strNull(row, "retry_of_id"), retryCount: number(row, "retry_count"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.loanDisbursements.push(disbursement);
    }

    for (const row of await db.query("SELECT * FROM account_change_requests ORDER BY created_at ASC") as Row[]) {
      const request: AccountChangeRequest = {
        id: str(row, "id"), userId: str(row, "user_id"), type: str(row, "type") as AccountChangeRequest["type"],
        status: str(row, "status") as AccountChangeRequest["status"],
        existingSnapshot: parseJson<Record<string, unknown> | null>(row.existing_snapshot, null),
        newSnapshot: parseJson<Record<string, unknown>>(row.new_snapshot, {}), reason: strNull(row, "reason") ?? null,
        reviewedBy: strNull(row, "reviewed_by") ?? null, reviewedAt: iso(row.reviewed_at), rejectionReason: strNull(row, "rejection_reason") ?? null,
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at),
      };
      snapshot.accountChangeRequests.push(request);
    }

    for (const row of await db.query("SELECT * FROM application_drafts ORDER BY created_at ASC") as Row[]) {
      const draft: ApplicationDraft = {
        id: str(row, "id"), userId: str(row, "user_id"), applicationId: str(row, "application_id"),
        applicantType: str(row, "applicant_type") as ApplicationDraft["applicantType"],
        data: parseJson<Record<string, unknown>>(row.data, {}), lastSectionIndex: number(row, "last_section_index"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(), updatedAt: iso(row.updated_at) ?? new Date().toISOString(),
      };
      snapshot.applicationDrafts.push(draft);
    }

    for (const row of await db.query("SELECT * FROM system_settings WHERE key = 'platform' ORDER BY updated_at ASC") as Row[]) {
      const setting = parseJson<PlatformSettings | null>(row.value, null);
      if (setting) snapshot.platformSettings.push(setting);
    }

    return snapshot;
  } catch (error) {
    console.error("[rebuildFromDatabase] Error — falling back to runtime_state JSONB:", error);
    return null;
  }
}
