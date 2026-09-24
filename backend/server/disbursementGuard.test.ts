import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Duplicate-disbursement guard tests (2026-09):
 * A loan that has already been disbursed and is live (DISBURSED / ACTIVE /
 * PAST_DUE / DEFAULTED / REPAID / WRITTEN_OFF) can NEVER be disbursed again:
 *   1. POST /admin/loans/:loanId/disburse → 409 ALREADY_DISBURSED
 *      "Loan already disbursed and active, can't disburse duplicate loan."
 *      (ACTIVE, DISBURSED and REPAID statuses all covered.)
 *   2. The application status backstops the loan record: an inconsistent
 *      loan.status=APPROVED with application.status=ACTIVE is still blocked.
 *   3. No over-blocking: a genuinely APPROVED loan still flows past the new
 *      guard to the pre-existing approval gate.
 *   4. The pre-existing SUCCESSFUL/in-flight transfer guard stays intact.
 *   5. POST /admin/disbursements/:id/retry for a FAILED attempt on an
 *      already-disbursed loan → 409 ALREADY_DISBURSED (a settled loan must
 *      never be re-funded via a retry).
 *   6. No over-blocking on retry: a FAILED attempt on an APPROVED loan still
 *      proceeds past the new guard.
 */

const TEST_PREFIX = `test-disburse-guard-${Date.now()}`;

type StoreModule = typeof import("./store.js");

let storeMod: StoreModule;
let request: ReturnType<typeof import("supertest")>;
let users: any[];
let loans: any[];
let loanApplications: any[];
let loanDisbursements: any[];
let disbursementAccounts: any[];
let kycCases: any[];

const seededIds: { users: string[]; loans: string[]; applications: string[]; disbursements: string[]; accounts: string[]; kyc: string[] } = {
  users: [], loans: [], applications: [], disbursements: [], accounts: [], kyc: [],
};

function tempBorrower(suffix: string) {
  const email = `${TEST_PREFIX}-${suffix}@example.com`;
  const id = `user-${TEST_PREFIX}-${suffix}-${Math.random().toString(36).slice(2, 10)}`;
  users.push({
    id,
    email,
    fullName: `Guard ${suffix}`,
    phone: "0803" + String(1_000_000 + Math.floor(Math.random() * 8_999_999)).padStart(7, "0"),
    passwordHash: "$2a$10$placeholder",
    roles: ["BORROWER"],
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  seededIds.users.push(id);
  return users[users.length - 1];
}

function seedKycVerified(borrowerId: string) {
  const id = `kyc-${Math.random().toString(36).slice(2, 12)}`;
  kycCases.push({ id, userId: borrowerId, status: "VERIFIED", createdAt: new Date().toISOString() });
  seededIds.kyc.push(id);
}

function seedLoanPair(opts: {
  suffix: string;
  loanStatus: string;
  applicationStatus: string;
  manualDecision?: string;
}) {
  const borrower = tempBorrower(opts.suffix);
  const internalId = `app-internal-${Math.random().toString(36).slice(2, 12)}`;
  const publicId = `0009${Math.floor(Math.random() * 90 + 10)}-guard-${Math.random().toString(36).slice(2, 8)}`;
  const loanInternalId = `loan-internal-${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  loanApplications.push({
    id: internalId,
    applicationId: publicId,
    borrowerId: borrower.id,
    applicantType: "PERSONAL",
    status: opts.applicationStatus,
    manualDecision: opts.manualDecision,
    createdAt: now,
    updatedAt: now,
    customerSnapshot: { fullName: borrower.fullName, disbursementAccount: { accountName: borrower.fullName, accountNumber: "0123456789", bankCode: "058", bankName: "GTBank" } },
  });
  loans.push({
    id: loanInternalId,
    applicationId: internalId,
    borrowerId: borrower.id,
    status: opts.loanStatus,
    principalNaira: 150000,
    createdAt: now,
    updatedAt: now,
  });
  seededIds.applications.push(internalId);
  seededIds.loans.push(loanInternalId);
  return { borrower, internalId, publicId, loanInternalId };
}

function seedDisbursementRow(opts: { loanId: string; applicationId: string; borrowerId: string; status: string; withAccount?: boolean }) {
  const id = `disb-${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  loanDisbursements.push({
    id,
    loanId: opts.loanId,
    applicationId: opts.applicationId,
    borrowerId: opts.borrowerId,
    amountNaira: 150000,
    currency: "NGN",
    bankCode: opts.withAccount ? "058" : undefined,
    accountNumber: opts.withAccount ? "0123456789" : undefined,
    accountName: opts.withAccount ? "Guard Tester" : undefined,
    status: opts.status,
    narration: "Velo loan disbursement test",
    retryCount: 0,
    retryOfId: null,
    providerTransfer: null,
    providerReference: null,
    error: opts.status === "FAILED" ? "Insufficient balance" : null,
    createdAt: now,
    updatedAt: now,
  });
  seededIds.disbursements.push(id);
  return loanDisbursements[loanDisbursements.length - 1];
}

function getApp() {
  return (globalThis as any).__testApp;
}

describe("Duplicate-disbursement guard — a disbursed loan can never be disbursed again", () => {
  beforeAll(async () => {
    vi.doMock("./providers/prembly.js", () => ({
      verifyBvn: vi.fn(),
      verifyNin: vi.fn(),
      verifyIdentityWithFace: vi.fn(),
      verifyLiveness: vi.fn(),
      requestCreditReport: vi.fn(),
      requestCommercialCreditReport: vi.fn(),
      verifyPremblyWebhook: vi.fn(() => true),
      isTimeoutError: vi.fn(() => false),
    }));

    vi.doMock("./providers/flutterwave.js", () => ({
      initializeRepayment: vi.fn(),
      createLoanDisbursement: vi.fn(),
      createInvestorPayout: vi.fn(),
      initializeWalletFunding: vi.fn(),
      verifyTransaction: vi.fn(),
      verifyTransactionByReference: vi.fn(),
      verifyTransactionWithRetry: vi.fn(),
      verifyTransferWithRetry: vi.fn(),
      pollTransferUntilTerminal: vi.fn(),
      resolveBankAccount: vi.fn(),
      listBanks: vi.fn(async () => []),
      normalizeBankCodeForFlutterwave: vi.fn(async () => undefined),
      FlutterwaveError: class FlutterwaveError extends Error {
        providerResponse?: unknown;
        httpStatus?: number;
      },
    }));

    vi.doMock("./auth.js", async (importOriginal) => {
      const orig = (await importOriginal()) as any;
      return {
        ...orig,
        requireAuth: (_req: any, _res: any, next: any) => next(),
        requireRole: (..._roles: string[]) => (_req: any, _res: any, next: any) => next(),
        createOtpChallenge: vi.fn(),
      };
    });

    // Hermetic: the real store module is used in-memory only — DB init and
    // persistence are stubbed out.
    vi.doMock("./store.js", async (importOriginal) => {
      const orig = (await importOriginal()) as StoreModule;
      return {
        ...orig,
        initializeStore: vi.fn(async () => ({})),
        persistStore: vi.fn(async () => ({})),
      };
    });

    const express = (await import("express")).default;
    const supertestPkg = await import("supertest");
    request = (supertestPkg as any).default || supertestPkg;

    storeMod = await import("./store.js");
    const routesMod = await import("./routes.js");

    users = (storeMod as any).users;
    loans = (storeMod as any).loans;
    loanApplications = (storeMod as any).loanApplications;
    loanDisbursements = (storeMod as any).loanDisbursements;
    disbursementAccounts = (storeMod as any).disbursementAccounts;
    kycCases = (storeMod as any).kycCases;

    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => {
      req.user = { id: "admin-test", roles: ["ADMIN"] };
      next();
    });
    app.use("/api/v1", routesMod.default);
    (globalThis as any).__testApp = app;
  }, 60_000);

  afterAll(async () => {
    const drop = (list: any[], ids: string[], key: string) => {
      for (let i = list.length - 1; i >= 0; i--) if (ids.includes(list[i][key])) list.splice(i, 1);
    };
    drop(users, seededIds.users, "id");
    drop(loans, seededIds.loans, "id");
    drop(loanApplications, seededIds.applications, "id");
    drop(loanDisbursements, seededIds.disbursements, "id");
    drop(disbursementAccounts, seededIds.accounts, "id");
    drop(kycCases, seededIds.kyc, "id");
    console.log(`[disbursementGuard.test] cleaned seed rows (prefix=${TEST_PREFIX})`);
  }, 30_000);

  const DISBURSED_MESSAGE = "Loan already disbursed and active, can't disburse duplicate loan.";

  it("ACTIVE loan → 409 ALREADY_DISBURSED and NO new transfer row is created", async () => {
    const { publicId, loanInternalId } = seedLoanPair({ suffix: "active", loanStatus: "ACTIVE", applicationStatus: "ACTIVE", manualDecision: "APPROVED" });
    const rowsBefore = loanDisbursements.length;
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe("ALREADY_DISBURSED");
    expect(res.body.error).toBe(DISBURSED_MESSAGE);
    // The guard must fire BEFORE any transfer row is pushed.
    expect(loanDisbursements.length).toBe(rowsBefore);
    expect(loanDisbursements.some((d: any) => d.loanId === loanInternalId)).toBe(false);
  }, 30_000);

  it("DISBURSED loan → 409 ALREADY_DISBURSED", async () => {
    const { publicId } = seedLoanPair({ suffix: "disbursed", loanStatus: "DISBURSED", applicationStatus: "ACTIVE", manualDecision: "APPROVED" });
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DISBURSED");
    expect(res.body.error).toBe(DISBURSED_MESSAGE);
  }, 30_000);

  it("REPAID loan → 409 ALREADY_DISBURSED (a repaid loan is never re-funded)", async () => {
    const { publicId } = seedLoanPair({ suffix: "repaid", loanStatus: "REPAID", applicationStatus: "REPAID", manualDecision: "APPROVED" });
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DISBURSED");
    expect(res.body.error).toBe(DISBURSED_MESSAGE);
  }, 30_000);

  it("application status backstop: loan APPROVED but application ACTIVE is still blocked", async () => {
    const { publicId } = seedLoanPair({ suffix: "desync", loanStatus: "APPROVED", applicationStatus: "ACTIVE", manualDecision: "APPROVED" });
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DISBURSED");
    expect(res.body.error).toBe(DISBURSED_MESSAGE);
  }, 30_000);

  it("no over-blocking: a genuinely APPROVED loan still reaches the normal flow", async () => {
    // manualDecision intentionally missing → the pre-existing approval gate
    // answers (NOT the ALREADY_DISBURSED guard).
    const { publicId } = seedLoanPair({ suffix: "approved", loanStatus: "APPROVED", applicationStatus: "APPROVED" });
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBeUndefined();
    expect(String(res.body.error)).toMatch(/approval is required before disbursement/i);
  }, 30_000);

  it("pre-existing transfer guard intact: SUCCESSFUL row on an APPROVED loan → 409 already in progress or completed", async () => {
    const { borrower, internalId, publicId, loanInternalId } = seedLoanPair({ suffix: "successrow", loanStatus: "APPROVED", applicationStatus: "APPROVED", manualDecision: "APPROVED" });
    seedKycVerified(borrower.id);
    const accountId = `acct-${Math.random().toString(36).slice(2, 10)}`;
    disbursementAccounts.push({
      id: accountId,
      borrowerId: borrower.id,
      accountName: borrower.fullName,
      accountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rejectionReason: null,
    });
    seededIds.accounts.push(accountId);
    seedDisbursementRow({ loanId: loanInternalId, applicationId: internalId, borrowerId: borrower.id, status: "SUCCESSFUL", withAccount: true });
    const res = await request(getApp()).post(`/api/v1/admin/loans/${publicId}/disburse`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBeUndefined();
    expect(String(res.body.error)).toMatch(/already in progress or completed/i);
  }, 30_000);

  it("retry endpoint: FAILED attempt on an ACTIVE loan → 409 ALREADY_DISBURSED (no re-fund via retry)", async () => {
    const { borrower, internalId, loanInternalId } = seedLoanPair({ suffix: "retryactive", loanStatus: "ACTIVE", applicationStatus: "ACTIVE", manualDecision: "APPROVED" });
    const row = seedDisbursementRow({ loanId: loanInternalId, applicationId: internalId, borrowerId: borrower.id, status: "FAILED" });
    const res = await request(getApp()).post(`/api/v1/admin/disbursements/${row.id}/retry`).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ALREADY_DISBURSED");
    expect(res.body.error).toBe(DISBURSED_MESSAGE);
  }, 30_000);

  it("retry endpoint: no over-blocking — FAILED attempt on an APPROVED loan passes the new guard", async () => {
    const { borrower, internalId, loanInternalId } = seedLoanPair({ suffix: "retryok", loanStatus: "APPROVED", applicationStatus: "APPROVED", manualDecision: "APPROVED" });
    seedKycVerified(borrower.id);
    // No bank details on the failed row and no saved account → the retry
    // reaches the account-freshness gate (proves the ALREADY_DISBURSED guard
    // did not fire).
    const row = seedDisbursementRow({ loanId: loanInternalId, applicationId: internalId, borrowerId: borrower.id, status: "FAILED" });
    const res = await request(getApp()).post(`/api/v1/admin/disbursements/${row.id}/retry`).send({});
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/missing bank\/account details/i);
  }, 30_000);
});
