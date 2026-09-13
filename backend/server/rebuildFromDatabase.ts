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

function iso(d: unknown): string | undefined {
  if (!d) return undefined;
  const v = d instanceof Date ? d.toISOString() : typeof d === "string" ? d : undefined;
  return v;
}

function str(row: Row, key: string): string {
  const v = row[key];
  return v == null ? "" : String(v);
}

function strNull(row: Row, key: string): string | undefined {
  const v = row[key];
  return v == null ? undefined : String(v);
}

function numOrZero(row: Row, key: string): number {
  const v = row[key];
  if (v == null) return 0;
  if (typeof v === "number") return v;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

function numNull(row: Row, key: string): number | undefined {
  const v = row[key];
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : undefined;
}

function intNull(row: Row, key: string): number | undefined {
  const v = row[key];
  if (v == null) return undefined;
  if (typeof v === "number") return Math.trunc(v);
  const n = Number(String(v));
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function bigIntToNum(row: Row, key: string): number {
  const v = row[key];
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

function bool(row: Row, key: string, fallback = false): boolean {
  const v = row[key];
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "t" || v === "true" || v === "1";
  return Boolean(v);
}

function parseJson<T = unknown>(v: unknown): T {
  if (v == null) return null as unknown as T;
  if (typeof v === "object") return v as T;
  if (typeof v === "string") {
    if (v.length === 0) return null as unknown as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null as unknown as T;
    }
  }
  return null as unknown as T;
}

export type Snapshot = Record<StoreKey, unknown[]>;

export async function rebuildFromDatabase(db: NeonQueryFunction<false, false>): Promise<Snapshot | null> {
  // Return null if any core table is empty (i.e. the tables haven't been seeded yet),
  // so caller falls back to the runtime_state JSONB blob instead.
  const empty: Snapshot = {
    users: [], wallets: [], ledgerEntries: [], walletTransactions: [],
    kycCases: [], identityVerificationEvents: [], documents: [], payoutAccounts: [],
    investmentPlans: [], investments: [], loanApplications: [], loans: [],
    loanSchedules: [], repayments: [], payouts: [], creditHistory: [],
    creditScores: [], creditReports: [], otpChallenges: [], passwordResetTokens: [],
    notifications: [], providerEvents: [], consents: [], loanProducts: [],
    auditLogs: [], adminLedger: [], platformSettings: [], investorWithdrawals: [],
    disbursementAccounts: [], loanDisbursements: [], accountChangeRequests: [],
    applicationDrafts: [],
  };

  try {
    // Users — also pull user_roles join table
    const usersRows = await db.query("SELECT * FROM users ORDER BY created_at ASC") as Row[];
    const rolesRows = await db.query("SELECT user_id, role FROM user_roles") as Array<{ user_id: string; role: string }>;
    const rolesByUser = new Map<string, string[]>();
    for (const r of rolesRows) {
      if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
      rolesByUser.get(r.user_id)!.push(r.role as User["roles"][number]);
    }
    for (const row of usersRows) {
      const u: User = {
        id: str(row, "id"),
        email: str(row, "email"),
        phone: str(row, "phone"),
        fullName: str(row, "full_name"),
        passwordHash: str(row, "password_hash"),
        roles: (rolesByUser.get(str(row, "id")) ?? []) as User["roles"],
        kycStatus: (strNull(row, "kyc_status") ?? "NOT_STARTED") as User["kycStatus"],
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
        lastLoginAt: iso(row.last_login_at),
        isActive: bool(row, "is_active", true),
        preferredOtpChannel: (strNull(row, "preferred_otp_channel") as User["preferredOtpChannel"]) ?? "EMAIL",
        otpLoginEnabled: bool(row, "otp_login_enabled", false),
        otpVerifiedAt: iso(row.otp_verified_at),
        dateOfBirth: iso(row.date_of_birth)?.slice(0, 10),
        residentialAddress: parseJson(row.residential_address),
        occupation: strNull(row, "occupation"),
        sourceOfFunds: strNull(row, "source_of_funds"),
        ...(parseJson<Record<string, unknown>>(row.metadata) ?? {}),
      };
      empty.users.push(u);
    }

    const walletsRows = await db.query("SELECT * FROM wallets") as Row[];
    for (const row of walletsRows) {
      const w: Wallet = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        availableMinor: bigIntToNum(row, "available_minor"),
        availableNaira: 0,
        heldMinor: bigIntToNum(row, "held_minor"),
        heldNaira: 0,
        pendingDepositMinor: bigIntToNum(row, "pending_deposit_minor"),
        pendingDepositNaira: 0,
        pendingPayoutMinor: bigIntToNum(row, "pending_payout_minor"),
        pendingPayoutNaira: 0,
        totalCreditedMinor: bigIntToNum(row, "total_credited_minor"),
        totalDebitedMinor: bigIntToNum(row, "total_debited_minor"),
        currency: strNull(row, "currency") ?? "NGN",
      } as Wallet;
      w.availableNaira = w.availableMinor / 100;
      w.heldNaira = w.heldMinor / 100;
      w.pendingDepositNaira = w.pendingDepositMinor / 100;
      w.pendingPayoutNaira = w.pendingPayoutMinor / 100;
      (w as unknown as { createdAt?: string }).createdAt = iso(row.created_at);
      (w as unknown as { updatedAt?: string }).updatedAt = iso(row.updated_at);
      empty.wallets.push(w);
    }

    const ledgerRows = await db.query("SELECT * FROM ledger_entries ORDER BY created_at ASC") as Row[];
    for (const row of ledgerRows) {
      const e: LedgerEntry = {
        id: str(row, "id"),
        walletId: str(row, "wallet_id"),
        entryType: (str(row, "entry_type") ?? "ADJUSTMENT") as LedgerEntry["entryType"],
        referenceId: strNull(row, "reference_id"),
        loanId: strNull(row, "loan_id"),
        investmentId: strNull(row, "investment_id"),
        creditMinor: bigIntToNum(row, "credit_minor"),
        debitMinor: bigIntToNum(row, "debit_minor"),
        balanceAfterMinor: bigIntToNum(row, "balance_after_minor"),
        currency: strNull(row, "currency") ?? "NGN",
        narration: strNull(row, "narration"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        metadata: parseJson(row.metadata) ?? undefined,
      };
      empty.ledgerEntries.push(e);
    }

    const wtxRows = await db.query("SELECT * FROM wallet_transactions ORDER BY created_at ASC") as Row[];
    for (const row of wtxRows) {
      const t: WalletTransaction = {
        id: str(row, "id"),
        walletId: strNull(row, "wallet_id"),
        userId: str(row, "user_id"),
        type: str(row, "type") as WalletTransaction["type"],
        subType: strNull(row, "sub_type") as WalletTransaction["subType"],
        status: (str(row, "status") ?? "SUCCESSFUL") as WalletTransaction["status"],
        amountMinor: bigIntToNum(row, "amount_minor"),
        feeMinor: bigIntToNum(row, "fee_minor"),
        currency: strNull(row, "currency") ?? "NGN",
        txRef: strNull(row, "tx_ref"),
        paymentMethod: strNull(row, "payment_method"),
        providerRaw: parseJson(row.provider_raw) ?? undefined,
        narration: strNull(row, "narration"),
        verifiedAt: iso(row.verified_at),
        failedAt: iso(row.failed_at),
        error: strNull(row, "error"),
        settledAt: iso(row.settled_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
        providerReference: strNull(row, "provider_reference"),
      };
      empty.walletTransactions.push(t);
    }

    const kycRows = await db.query("SELECT * FROM kyc_cases ORDER BY created_at ASC") as Row[];
    for (const row of kycRows) {
      const k: KycCase = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        status: (str(row, "status") ?? "NOT_STARTED") as KycCase["status"],
        bvn: strNull(row, "bvn"),
        nin: strNull(row, "nin"),
        categoryResults: parseJson(row.category_results) ?? {},
        bvnVerifiedAt: iso(row.bvn_verified_at),
        ninVerifiedAt: iso(row.nin_verified_at),
        livenessVerifiedAt: iso(row.liveness_verified_at),
        verifiedAt: iso(row.verified_at),
        verifiedDetails: parseJson(row.verified_details) ?? undefined,
        identityPhoto: strNull(row, "identity_photo"),
        selfieImageData: strNull(row, "selfie_image_data"),
        providerRequestId: strNull(row, "provider_request_id"),
        providerRaw: parseJson(row.provider_raw) ?? undefined,
        checklist: parseJson<KycCase["checklist"]>(row.checklist) ?? ({
          bvn: false, nin: false, proofOfAddress: false, passport: false, signature: false, liveness: false,
        } as unknown as KycCase["checklist"]),
        submittedAt: iso(row.submitted_at),
        reviewedBy: strNull(row, "reviewed_by"),
        reviewedAt: iso(row.reviewed_at),
        rejectionReason: strNull(row, "rejection_reason"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.kycCases.push(k);
    }

    const idRows = await db.query("SELECT * FROM identity_verification_events ORDER BY created_at ASC") as Row[];
    for (const row of idRows) {
      const ev: IdentityVerificationEvent = {
        id: str(row, "id"),
        kycCaseId: str(row, "kyc_case_id"),
        category: str(row, "category") as IdentityVerificationEvent["category"],
        status: (str(row, "status") ?? "PENDING") as IdentityVerificationEvent["status"],
        providerRequestId: strNull(row, "provider_request_id"),
        providerTransactionId: strNull(row, "provider_transaction_id"),
        providerRaw: parseJson(row.provider_raw) ?? undefined,
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.identityVerificationEvents.push(ev);
    }

    const docRows = await db.query("SELECT * FROM documents ORDER BY created_at ASC") as Row[];
    for (const row of docRows) {
      const d: Document = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        kycCaseId: strNull(row, "kyc_case_id"),
        type: (str(row, "type") ?? "PASSPORT") as Document["type"],
        status: (strNull(row, "status") ?? "PENDING_REVIEW") as Document["status"],
        fileName: strNull(row, "file_name"),
        mimeType: strNull(row, "mime_type"),
        storageUrl: strNull(row, "storage_url"),
        sizeBytes: bigIntToNum(row, "size_bytes") || undefined,
        version: intNull(row, "version") ?? 1,
        note: strNull(row, "note"),
        expiresAt: iso(row.expires_at),
        reviewedBy: strNull(row, "reviewed_by"),
        reviewedAt: iso(row.reviewed_at),
        rejectionReason: strNull(row, "rejection_reason"),
        verificationResult: parseJson(row.verification_result) ?? undefined,
        metadata: parseJson(row.metadata) ?? undefined,
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.documents.push(d);
    }

    const paRows = await db.query("SELECT * FROM payout_accounts ORDER BY created_at ASC") as Row[];
    for (const row of paRows) {
      const p: PayoutAccount = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        bankName: strNull(row, "bank_name"),
        bankCode: str(row, "bank_code"),
        accountNumber: str(row, "account_number"),
        accountName: strNull(row, "account_name"),
        status: (strNull(row, "status") ?? "PENDING_APPROVAL") as PayoutAccount["status"],
        verifiedAt: iso(row.verified_at),
        verificationReference: strNull(row, "verification_reference"),
        rejectionReason: strNull(row, "rejection_reason"),
        isDefault: bool(row, "is_default", false),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      (p as unknown as { accountNameEnquiryResult?: string }).accountNameEnquiryResult = strNull(row, "account_name_enquiry_result");
      empty.payoutAccounts.push(p);
    }

    const daRows = await db.query("SELECT * FROM disbursement_accounts ORDER BY created_at ASC") as Row[];
    for (const row of daRows) {
      const d: DisbursementAccount = {
        id: str(row, "id"),
        borrowerId: str(row, "borrower_id"),
        bankName: strNull(row, "bank_name"),
        bankCode: str(row, "bank_code"),
        accountNumber: str(row, "account_number"),
        accountName: strNull(row, "account_name"),
        status: (strNull(row, "status") ?? "PENDING_APPROVAL") as DisbursementAccount["status"],
        verifiedAt: iso(row.verified_at),
        verificationReference: strNull(row, "verification_reference"),
        rejectionReason: strNull(row, "rejection_reason"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.disbursementAccounts.push(d);
    }

    const invPlans = await db.query("SELECT * FROM investment_plans ORDER BY created_at ASC") as Row[];
    for (const row of invPlans) {
      const p: InvestmentPlan = {
        id: str(row, "id"),
        name: str(row, "name"),
        description: strNull(row, "description"),
        tenureDays: numOrZero(row, "tenure_days"),
        annualInterestRate: numOrZero(row, "annual_interest_rate"),
        minAmountNaira: numOrZero(row, "min_amount_naira"),
        maxAmountNaira: numOrZero(row, "max_amount_naira"),
        isActive: bool(row, "is_active", true),
        earlyLiquidationAllowed: bool(row, "early_liquidation_allowed", true),
        earlyLiquidationPenaltyRate: numOrZero(row, "early_liquidation_penalty_rate"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      (p as unknown as { minimumNaira?: number }).minimumNaira = p.minAmountNaira;
      (p as unknown as { maximumNaira?: number }).maximumNaira = p.maxAmountNaira;
      (p as unknown as { ratePerAnnum?: number }).ratePerAnnum = p.annualInterestRate;
      (p as unknown as { config?: unknown }).config = parseJson(row.config);
      empty.investmentPlans.push(p);
    }

    const invs = await db.query("SELECT * FROM investments ORDER BY created_at ASC") as Row[];
    for (const row of invs) {
      const i: Investment = {
        id: str(row, "id"),
        investorId: str(row, "investor_id"),
        planId: strNull(row, "plan_id"),
        status: (str(row, "status") ?? "PENDING") as Investment["status"],
        amountNaira: numOrZero(row, "amount_naira"),
        annualInterestRate: numOrZero(row, "annual_interest_rate"),
        earnedInterestNaira: numOrZero(row, "earned_interest_naira"),
        balanceNaira: numOrZero(row, "balance_naira"),
        tenureDays: numOrZero(row, "tenure_days"),
        startDate: iso(row.start_date),
        maturityDate: iso(row.maturity_date),
        liquidityRequestedAt: iso(row.liquidity_requested_at),
        liquidityApprovedAt: iso(row.liquidity_approved_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.investments.push(i);
    }

    const apps = await db.query("SELECT * FROM loan_applications ORDER BY created_at ASC") as Row[];
    for (const row of apps) {
      const a: LoanApplication = {
        id: str(row, "id"),
        applicationId: strNull(row, "application_id") ?? str(row, "id"),
        borrowerId: str(row, "borrower_id"),
        applicantType: (strNull(row, "applicant_type") ?? "PERSONAL") as LoanApplication["applicantType"],
        productId: strNull(row, "product_id"),
        status: (str(row, "status") ?? "DRAFT") as LoanApplication["status"],
        amountNaira: numOrZero(row, "amount_naira"),
        tenureDays: numOrZero(row, "tenure_days"),
        purpose: strNull(row, "purpose"),
        customerSnapshot: parseJson(row.customer_snapshot) ?? undefined,
        creditReportSnapshot: parseJson(row.credit_report_snapshot) ?? undefined,
        stageStatuses: parseJson<LoanApplication["stageStatuses"]>(row.stage_statuses) ?? {} as LoanApplication["stageStatuses"],
        stageRejectionNotes: parseJson<Record<string, string>>(row.stage_rejection_notes) ?? {},
        submittedAt: iso(row.submitted_at),
        systemDecision: parseJson(row.system_decision) ?? undefined,
        manualDecision: strNull(row, "manual_decision") as LoanApplication["manualDecision"],
        manualNote: strNull(row, "manual_note"),
        reviewedBy: strNull(row, "reviewed_by"),
        reviewedAt: iso(row.reviewed_at),
        signedAgreementUrl: strNull(row, "signed_agreement_url"),
        disbursementInstitution: strNull(row, "disbursement_institution"),
        disbursementAccount: parseJson(row.disbursement_account) ?? undefined,
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.loanApplications.push(a);
    }

    const drafts = await db.query("SELECT * FROM application_drafts ORDER BY created_at ASC") as Row[];
    for (const row of drafts) {
      const d: ApplicationDraft = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        applicationId: str(row, "application_id"),
        applicantType: (strNull(row, "applicant_type") ?? "PERSONAL") as ApplicationDraft["applicantType"],
        data: parseJson<Record<string, unknown>>(row.data) ?? {},
        lastSectionIndex: numOrZero(row, "last_section_index"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.applicationDrafts.push(d);
    }

    const loans = await db.query("SELECT * FROM loans ORDER BY created_at ASC") as Row[];
    for (const row of loans) {
      const l: Loan = {
        id: str(row, "id"),
        applicationId: str(row, "application_id"),
        borrowerId: str(row, "borrower_id"),
        productId: strNull(row, "product_id"),
        status: (str(row, "status") ?? "DRAFT") as Loan["status"],
        principalNaira: numOrZero(row, "principal_naira"),
        totalReceivableNaira: numOrZero(row, "total_receivable_naira"),
        outstandingNaira: numOrZero(row, "outstanding_naira"),
        interestNaira: numOrZero(row, "interest_naira"),
        feesNaira: numOrZero(row, "fees_naira"),
        lateFeesNaira: numOrZero(row, "late_fees_naira"),
        annualInterestRate: numOrZero(row, "annual_interest_rate"),
        tenureDays: numOrZero(row, "tenure_days"),
        issueDate: iso(row.issue_date),
        maturityDate: iso(row.maturity_date),
        disbursementDate: iso(row.disbursement_date),
        signedAgreementUrl: strNull(row, "signed_agreement_url"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.loans.push(l);
    }

    const sched = await db.query("SELECT * FROM loan_schedules ORDER BY loan_id, installment_number ASC") as Row[];
    for (const row of sched) {
      const s: LoanSchedule = {
        id: str(row, "id"),
        loanId: str(row, "loan_id"),
        installmentNumber: numOrZero(row, "installment_number"),
        dueDate: iso(row.due_date),
        principalNaira: numOrZero(row, "principal_naira"),
        interestNaira: numOrZero(row, "interest_naira"),
        feesNaira: numOrZero(row, "fees_naira"),
        totalDueNaira: numOrZero(row, "total_due_naira"),
        status: (strNull(row, "status") ?? "UPCOMING") as LoanSchedule["status"],
        paidAt: iso(row.paid_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.loanSchedules.push(s);
    }

    const rep = await db.query("SELECT * FROM repayments ORDER BY created_at ASC") as Row[];
    for (const row of rep) {
      const r: Repayment = {
        id: str(row, "id"),
        loanId: str(row, "loan_id"),
        borrowerId: str(row, "borrower_id"),
        status: (str(row, "status") ?? "SUCCESSFUL") as Repayment["status"],
        method: strNull(row, "method") as Repayment["method"],
        principalNaira: numOrZero(row, "principal_naira"),
        interestNaira: numOrZero(row, "interest_naira"),
        feesNaira: numOrZero(row, "fees_naira"),
        lateFeesNaira: numOrZero(row, "late_fees_naira"),
        amountNaira: numOrZero(row, "amount_naira"),
        transactionReference: strNull(row, "transaction_reference"),
        paymentDate: iso(row.payment_date),
        settledAt: iso(row.settled_at),
        processorRaw: parseJson(row.processor_raw) ?? undefined,
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.repayments.push(r);
    }

    const pay = await db.query("SELECT * FROM payouts ORDER BY created_at ASC") as Row[];
    for (const row of pay) {
      const p: Payout = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        investmentId: strNull(row, "investment_id"),
        payoutAccountId: strNull(row, "payout_account_id"),
        payoutType: (strNull(row, "payout_type") ?? "MATURITY") as Payout["payoutType"],
        status: (str(row, "status") ?? "PENDING_APPROVAL") as Payout["status"],
        amountNaira: numOrZero(row, "amount_naira"),
        feeNaira: numOrZero(row, "fee_naira"),
        netNaira: numOrZero(row, "net_naira"),
        bankName: strNull(row, "bank_name"),
        bankCode: strNull(row, "bank_code"),
        accountNumber: strNull(row, "account_number"),
        accountName: strNull(row, "account_name"),
        approvedAt: iso(row.approved_at),
        processedAt: iso(row.processed_at),
        settledAt: iso(row.settled_at),
        providerReference: strNull(row, "provider_reference"),
        processorRaw: parseJson(row.processor_raw) ?? undefined,
        retryCount: numOrZero(row, "retry_count"),
        lastAttemptAt: iso(row.last_attempt_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.payouts.push(p);
    }

    const disb = await db.query("SELECT * FROM disbursements ORDER BY created_at ASC") as Row[];
    for (const row of disb) {
      const d: LoanDisbursement = {
        id: str(row, "id"),
        loanId: str(row, "loan_id"),
        status: (strNull(row, "status") ?? "PENDING_APPROVAL") as LoanDisbursement["status"],
        amountNaira: numOrZero(row, "amount_naira"),
        bankCode: strNull(row, "bank_code"),
        bankName: strNull(row, "bank_name"),
        accountNumber: strNull(row, "account_number"),
        accountName: strNull(row, "account_name"),
        approvedAt: iso(row.approved_at),
        disbursedAt: iso(row.disbursed_at),
        processedAt: iso(row.processed_at),
        providerReference: strNull(row, "provider_reference"),
        processorRaw: parseJson(row.processor_raw) ?? undefined,
        retryCount: numOrZero(row, "retry_count"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.loanDisbursements.push(d);
    }

    const ch = await db.query("SELECT * FROM credit_history_events ORDER BY created_at ASC") as Row[];
    for (const row of ch) {
      const h: CreditHistoryEvent = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        type: (strNull(row, "event_type") ?? "LOAN_REPAYMENT") as CreditHistoryEvent["type"],
        eventDate: iso(row.event_date),
        loanId: strNull(row, "loan_id"),
        amountNaira: numOrZero(row, "amount_naira"),
        status: (strNull(row, "status") ?? "UNKNOWN") as CreditHistoryEvent["status"],
        description: strNull(row, "description"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      (h as unknown as { metadata?: unknown }).metadata = parseJson(row.metadata);
      empty.creditHistory.push(h);
    }

    const cs = await db.query("SELECT * FROM credit_scores ORDER BY created_at ASC") as Row[];
    for (const row of cs) {
      const min = numNull(row, "score_min") ?? 300;
      const max = numNull(row, "score_max") ?? 900;
      const s: CreditScore = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        score: numOrZero(row, "score"),
        provider: strNull(row, "provider") ?? "INTERNAL",
        scoreRange: [min, max] as [number, number],
        factors: parseJson<string[]>(row.factors) ?? [],
        reference: strNull(row, "reference"),
        expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.creditScores.push(s);
    }

    const cr = await db.query("SELECT * FROM credit_reports ORDER BY created_at ASC") as Row[];
    for (const row of cr) {
      const r: CreditReport = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        provider: strNull(row, "provider") ?? "INTERNAL",
        reportType: (strNull(row, "report_type") ?? "FULL") as CreditReport["reportType"],
        score: numNull(row, "score"),
        summary: parseJson(row.summary) ?? {},
        rawData: parseJson(row.raw_data) ?? undefined,
        reference: strNull(row, "reference"),
        expiresAt: iso(row.expires_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.creditReports.push(r);
    }

    const otp = await db.query("SELECT * FROM otp_challenges ORDER BY created_at ASC") as Row[];
    for (const row of otp) {
      const o: OtpChallenge = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        action: str(row, "action") as OtpChallenge["action"],
        codeHash: str(row, "code_hash"),
        channel: strNull(row, "channel") as OtpChallenge["channel"],
        providerReference: strNull(row, "provider_reference"),
        expiresAt: iso(row.expires_at),
        verifiedAt: iso(row.verified_at),
        deliveryStatus: strNull(row, "delivery_status") as OtpChallenge["deliveryStatus"],
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.otpChallenges.push(o);
    }

    const prt = await db.query("SELECT * FROM password_reset_tokens ORDER BY created_at ASC") as Row[];
    for (const row of prt) {
      const t: PasswordResetToken = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        tokenHash: str(row, "token_hash"),
        expiresAt: iso(row.expires_at),
        consumedAt: iso(row.consumed_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.passwordResetTokens.push(t);
    }

    const notif = await db.query("SELECT * FROM notifications ORDER BY created_at ASC") as Row[];
    for (const row of notif) {
      const n: Notification = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        channel: (strNull(row, "channel") ?? "IN_APP") as Notification["channel"],
        notificationType: strNull(row, "notification_type"),
        title: str(row, "title"),
        body: strNull(row, "body"),
        payload: parseJson(row.payload) ?? {},
        status: (strNull(row, "status") ?? "PENDING_DELIVERY") as Notification["status"],
        idempotencyKey: strNull(row, "idempotency_key"),
        sentAt: iso(row.sent_at),
        readAt: iso(row.read_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.notifications.push(n);
    }

    const pe = await db.query("SELECT * FROM provider_webhook_events ORDER BY received_at ASC") as Row[];
    for (const row of pe) {
      const p: ProviderWebhookEvent = {
        id: str(row, "id"),
        eventKey: str(row, "event_key"),
        provider: str(row, "provider"),
        type: strNull(row, "event_name") ?? "unknown",
        payload: parseJson(row.payload) ?? {},
        receivedAt: iso(row.received_at),
        processedAt: iso(row.processed_at),
        status: (strNull(row, "status") ?? "RECEIVED") as ProviderWebhookEvent["status"],
      };
      empty.providerEvents.push(p);
    }

    const cons = await db.query("SELECT * FROM consents ORDER BY created_at ASC") as Row[];
    for (const row of cons) {
      const c: Consent = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        type: (strNull(row, "consent_type") ?? "TERMS_OF_SERVICE") as Consent["type"],
        ipAddress: strNull(row, "ip_address"),
        userAgent: strNull(row, "user_agent"),
        consentValue: (strNull(row, "consent_value") ?? "ACCEPTED") as Consent["consentValue"],
        version: strNull(row, "version"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.consents.push(c);
    }

    const lp = await db.query("SELECT * FROM loan_products ORDER BY created_at ASC") as Row[];
    for (const row of lp) {
      const pr: LoanProduct = {
        id: str(row, "id"),
        name: str(row, "name"),
        description: strNull(row, "description"),
        minAmountNaira: numOrZero(row, "min_amount_naira"),
        maxAmountNaira: numOrZero(row, "max_amount_naira"),
        interestRatePerAnnum: numOrZero(row, "interest_rate_per_annum"),
        processingFeeRate: numOrZero(row, "processing_fee_rate"),
        lateRepaymentPenaltyPerDay: numOrZero(row, "late_repayment_penalty_per_day"),
        minTenureDays: numOrZero(row, "min_tenure_days"),
        maxTenureDays: numOrZero(row, "max_tenure_days"),
        isActive: bool(row, "is_active", true),
        config: parseJson(row.config) ?? {},
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.loanProducts.push(pr);
    }

    const audit = await db.query("SELECT * FROM audit_logs ORDER BY created_at ASC") as Row[];
    for (const row of audit) {
      const a: AuditLog = {
        id: str(row, "id"),
        userId: strNull(row, "user_id"),
        actorType: (strNull(row, "actor_type") ?? "USER") as AuditLog["actorType"],
        action: str(row, "action"),
        resourceType: strNull(row, "resource_type"),
        resourceId: strNull(row, "resource_id"),
        oldValue: parseJson(row.old_value),
        newValue: parseJson(row.new_value),
        ipAddress: strNull(row, "ip_address"),
        userAgent: strNull(row, "user_agent"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      empty.auditLogs.push(a);
    }

    const adminLed = await db.query("SELECT * FROM admin_ledger_entries ORDER BY created_at ASC") as Row[];
    for (const row of adminLed) {
      const a: AdminLedgerEntry = {
        id: str(row, "id"),
        entryType: str(row, "entry_type") as AdminLedgerEntry["entryType"],
        referenceId: strNull(row, "reference_id"),
        investorId: strNull(row, "investor_id"),
        borrowerId: strNull(row, "borrower_id"),
        loanId: strNull(row, "loan_id"),
        amountMinor: bigIntToNum(row, "amount_minor"),
        direction: (str(row, "direction") ?? "CREDIT") as AdminLedgerEntry["direction"],
        balanceAfterMinor: bigIntToNum(row, "balance_after_minor"),
        currency: strNull(row, "currency") ?? "NGN",
        description: strNull(row, "description"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
      };
      (a as unknown as { metadata?: unknown }).metadata = parseJson(row.metadata);
      empty.adminLedger.push(a);
    }

    const iw = await db.query("SELECT * FROM investor_withdrawals ORDER BY created_at ASC") as Row[];
    for (const row of iw) {
      const w: InvestorWithdrawal = {
        id: str(row, "id"),
        investorId: str(row, "investor_id"),
        amountNaira: numOrZero(row, "amount_naira"),
        feeNaira: numOrZero(row, "fee_naira"),
        netNaira: numOrZero(row, "net_naira"),
        currency: strNull(row, "currency") ?? "NGN",
        bankCode: str(row, "bank_code"),
        bankName: strNull(row, "bank_name"),
        accountNumber: str(row, "account_number"),
        accountName: strNull(row, "account_name"),
        status: (strNull(row, "status") ?? "PENDING_APPROVAL") as InvestorWithdrawal["status"],
        narration: strNull(row, "narration"),
        providerTransfer: parseJson(row.provider_transfer) ?? undefined,
        providerReference: strNull(row, "provider_reference"),
        processedAt: iso(row.processed_at),
        retryCount: numOrZero(row, "retry_count"),
        lastAttemptAt: iso(row.last_attempt_at),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.investorWithdrawals.push(w);
    }

    const acr = await db.query("SELECT * FROM account_change_requests ORDER BY created_at ASC") as Row[];
    for (const row of acr) {
      const r: AccountChangeRequest = {
        id: str(row, "id"),
        userId: str(row, "user_id"),
        type: str(row, "type"),
        status: (strNull(row, "status") ?? "PENDING_APPROVAL") as AccountChangeRequest["status"],
        existingSnapshot: parseJson(row.existing_snapshot) ?? {},
        newSnapshot: parseJson(row.new_snapshot) ?? {},
        reason: strNull(row, "reason"),
        reviewedBy: strNull(row, "reviewed_by"),
        reviewedAt: iso(row.reviewed_at),
        rejectionReason: strNull(row, "rejection_reason"),
        createdAt: iso(row.created_at) ?? new Date().toISOString(),
        updatedAt: iso(row.updated_at),
      };
      empty.accountChangeRequests.push(r);
    }

    const ps = await db.query("SELECT * FROM system_settings WHERE key = 'platform' ORDER BY updated_at ASC") as Row[];
    for (const row of ps) {
      const parsed = parseJson<Partial<PlatformSettings>>(row.value);
      const p: PlatformSettings = {
        id: str(row, "id"),
        ...(parsed ?? {}),
      } as PlatformSettings;
      empty.platformSettings.push(p);
    }

    return empty;
  } catch (e) {
    console.error("[rebuildFromDatabase] Error — falling back to runtime_state JSONB:", e);
    return null;
  }
}
