import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Repayment settlement + activity-notification tests (2026-09):
 *   1. settleLoanRepayment() applies a partial repayment: balance reduced,
 *      ledger row written, borrower + staff bells pushed, idempotent on retry.
 *   2. A full payoff flips the loan (and its application) to REPAID with a
 *      distinct "fully repaid" borrower bell.
 *   3. Every admin + loan-manager with the loan_notifications permission gets
 *      the staff bell; borrowers of other loans do NOT get staff bells.
 *   4. markRepaymentFailed() flips a pending repayment to FAILED (no bells).
 *   5. Investment maturity sweep: no verified payout account →
 *      PAYOUT_ACCOUNT_REQUIRED + investor/staff bells; KYC-pending investor
 *      → PENDING_APPROVAL payout + KYC-held bells.
 *   6. Investment maturity reminders: 7/3/0-day sweep sends email channel-log
 *      + investor bell exactly once per day (idempotent), staff bell on
 *      due-today only.
 */

vi.mock("./providers/flutterwave.js", () => ({
  initializeRepayment: vi.fn(),
  createLoanDisbursement: vi.fn(),
  createInvestorPayout: vi.fn(async () => ({ data: { id: "tw-test", reference: "ref-test" } })),
  initializeWalletFunding: vi.fn(),
  verifyTransaction: vi.fn(),
  verifyTransactionByReference: vi.fn(async (_ref: string) => ({ status: "error", data: null })),
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

const TEST_PREFIX = `test-repaynotify-${Date.now()}`;

type StoreModule = typeof import("./store.js");

let storeMod: StoreModule;
let repaymentsMod: typeof import("./repayments.js");
let investmentsMod: typeof import("./investments.js");
let remindersMod: typeof import("./reminders.js");
let notifyMod: typeof import("./notify.js");

let users: any[];
let loans: any[];
let loanApplications: any[];
let repayments: any[];
let adminLedger: any[];
let investments: any[];
let payoutAccounts: any[];
let payouts: any[];
let kycCases: any[];
let activityNotifications: any[];
let notifications: any[];

const seededIds = { users: [] as string[], loans: [] as string[], applications: [] as string[], repayments: [] as string[], investments: [] as string[], accounts: [] as string[], kyc: [] as string[] };

function seedUser(suffix: string, roles: string[], extra: Record<string, unknown> = {}) {
  const id = `user-${TEST_PREFIX}-${suffix}`;
  users.push({
    id,
    email: `${TEST_PREFIX}-${suffix}@example.com`,
    fullName: `Tester ${suffix}`,
    passwordHash: "$2a$10$placeholder",
    roles,
    isActive: true,
    createdAt: new Date().toISOString(),
    ...extra,
  });
  seededIds.users.push(id);
  return users[users.length - 1];
}

function seedKyc(userId: string, status: string) {
  const id = `kyc-${Math.random().toString(36).slice(2, 12)}`;
  kycCases.push({ id, userId, status, createdAt: new Date().toISOString() });
  seededIds.kyc.push(id);
  return id;
}

function seedLoanAndRepayment(opts: { suffix: string; outstandingNaira: number; repaymentAmountNaira: number; principalNaira?: number }) {
  const borrower = seedUser(`borrower-${opts.suffix}`, ["BORROWER"]);
  const now = new Date().toISOString();
  const internalId = `app-${Math.random().toString(36).slice(2, 12)}`;
  loanApplications.push({
    id: internalId,
    applicationId: `0009-notify-${Math.random().toString(36).slice(2, 8)}`,
    borrowerId: borrower.id,
    applicantType: "PERSONAL",
    status: "ACTIVE",
    createdAt: now,
    updatedAt: now,
  });
  seededIds.applications.push(internalId);
  const loanId = `loan-${Math.random().toString(36).slice(2, 12)}`;
  loans.push({
    id: loanId,
    applicationId: internalId,
    borrowerId: borrower.id,
    status: "ACTIVE",
    principalNaira: opts.principalNaira ?? 100000,
    totalRepaymentNaira: 115000,
    outstandingNaira: opts.outstandingNaira,
    dueAt: new Date(Date.now() + 20 * 86400000).toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  seededIds.loans.push(loanId);
  const repaymentId = `rep-${Math.random().toString(36).slice(2, 12)}`;
  const txRef = `VELO-REPAY-${repaymentId}`;
  repayments.push({
    id: repaymentId,
    txRef,
    loanId,
    borrowerId: borrower.id,
    amountNaira: opts.repaymentAmountNaira,
    currency: "NGN",
    status: "PENDING_PROVIDER_CONFIRMATION",
    createdAt: now,
  });
  seededIds.repayments.push(repaymentId);
  return { borrower, loan: loans[loans.length - 1], repayment: repayments[repayments.length - 1], txRef };
}

function bell(userId: string, kind: string) {
  return activityNotifications.filter((row) => row.userId === userId && row.kind === kind);
}

function ledgerRows(referenceId: string) {
  return adminLedger.filter((row) => row.referenceId === referenceId && row.entryType === "LOAN_REPAYMENT_IN");
}

beforeAll(async () => {
  storeMod = await import("./store.js");
  notifyMod = await import("./notify.js");
  repaymentsMod = await import("./repayments.js");
  investmentsMod = await import("./investments.js");
  remindersMod = await import("./reminders.js");

  users = (storeMod as any).users;
  loans = (storeMod as any).loans;
  loanApplications = (storeMod as any).loanApplications;
  repayments = (storeMod as any).repayments;
  adminLedger = (storeMod as any).adminLedger;
  investments = (storeMod as any).investments;
  payoutAccounts = (storeMod as any).payoutAccounts;
  payouts = (storeMod as any).payouts;
  kycCases = (storeMod as any).kycCases;
  activityNotifications = (storeMod as any).activityNotifications;
  notifications = (storeMod as any).notifications;
}, 60_000);

afterAll(async () => {
  const drop = (list: any[], ids: string[], key: string) => {
    for (let i = list.length - 1; i >= 0; i--) if (ids.includes(list[i][key])) list.splice(i, 1);
  };
  drop(users, seededIds.users, "id");
  drop(loans, seededIds.loans, "id");
  drop(loanApplications, seededIds.applications, "id");
  drop(repayments, seededIds.repayments, "id");
  drop(investments, seededIds.investments, "id");
  drop(payoutAccounts, seededIds.accounts, "id");
  drop(kycCases, seededIds.kyc, "id");
  console.log(`[repaymentNotifications.test] cleaned seed rows (prefix=${TEST_PREFIX})`);
}, 30_000);

describe("settleLoanRepayment — balance, ledger, notifications, idempotency", () => {
  it("partial repayment: reduces outstanding, keeps loan ACTIVE, notifies borrower + staff exactly once", async () => {
    const admin = seedUser("admin-partial", ["ADMIN"]);
    const manager = seedUser("manager-partial", ["LOAN_MANAGER"], { adminPermissions: ["loan_notifications"] });
    const managerNoPerm = seedUser("manager-noperm", ["LOAN_MANAGER"], { adminPermissions: ["overview"] });
    const { loan, repayment, txRef } = seedLoanAndRepayment({ suffix: "partial", outstandingNaira: 115000, repaymentAmountNaira: 50000 });

    const borrowerBellsBefore = bell(borrowerIdOf(loan), "LOAN_REPAYMENT_CONFIRMED").length;
    const adminBellsBefore = bell(admin.id, "LOAN_REPAYMENT_STAFF").length;
    const ledgerBefore = ledgerRows(repayment.id).length;

    const result = repaymentsMod.settleLoanRepayment({ txRef, providerReference: "fw-123", providerTransactionId: "42", source: "WEBHOOK" });

    expect(result.ok).toBe(true);
    expect(repayment.status).toBe("SUCCESSFUL");
    expect(loan.outstandingNaira).toBe(65000);
    expect(loan.status).toBe("ACTIVE");
    expect(ledgerRows(repayment.id).length).toBe(ledgerBefore + 1);

    const borrowerBells = bell(borrowerIdOf(loan), "LOAN_REPAYMENT_CONFIRMED");
    expect(borrowerBells.length).toBe(borrowerBellsBefore + 1);
    expect(borrowerBells[borrowerBells.length - 1].actionUrl).toBe(`/borrower/loans/${loan.id}`);
    expect(borrowerBells[borrowerBells.length - 1].category).toBe("LOAN");

    const adminBells = bell(admin.id, "LOAN_REPAYMENT_STAFF");
    expect(adminBells.length).toBe(adminBellsBefore + 1);
    expect(String(adminBells[adminBells.length - 1].actionUrl)).toContain("/admin#view=detail&id=");

    expect(bell(manager.id, "LOAN_REPAYMENT_STAFF").length).toBe(1);
    // Loan managers WITHOUT the loan_notifications permission are not notified.
    expect(bell(managerNoPerm.id, "LOAN_REPAYMENT_STAFF").length).toBe(0);

    // Idempotent: a webhook + redirect double-fire must not double anything.
    const second = repaymentsMod.settleLoanRepayment({ txRef, providerReference: "fw-123", source: "RETURN_REDIRECT" });
    expect(second.ok).toBe(true);
    expect(second.reason).toBe("already_settled");
    expect(ledgerRows(repayment.id).length).toBe(ledgerBefore + 1);
    expect(bell(admin.id, "LOAN_REPAYMENT_STAFF").length).toBe(adminBellsBefore + 1);
    expect(bell(borrowerIdOf(loan), "LOAN_REPAYMENT_CONFIRMED").length).toBe(borrowerBellsBefore + 1);
    expect(loan.outstandingNaira).toBe(65000);

    expect(bell(admin.id, "LOAN_REPAYMENT_STAFF")[0].userId).toBe(admin.id);
    void manager;
  });

  it("full payoff: loan + application flip to REPAID with a distinct borrower bell", async () => {
    const admin = seedUser("admin-full", ["ADMIN"]);
    const seed = seedLoanAndRepayment({ suffix: "full", outstandingNaira: 20000, repaymentAmountNaira: 20000 });
    const application = loanApplications.find((a: any) => a.id === seed.loan.applicationId);

    const result = repaymentsMod.settleLoanRepayment({ txRef: seed.txRef, source: "RECONCILE_SWEEP" });

    expect(result.ok).toBe(true);
    expect(result.fullyRepaid).toBe(true);
    expect(seed.loan.status).toBe("REPAID");
    expect(seed.loan.paidAt).toBeTruthy();
    expect(application.status).toBe("REPAID");

    const repaidBells = bell(borrowerIdOf(seed.loan), "LOAN_REPAID");
    expect(repaidBells.length).toBe(1);
    expect(repaidBells[0].title).toContain("fully repaid");
    expect(bell(admin.id, "LOAN_REPAYMENT_STAFF").length).toBe(1);
  });

  it("markRepaymentFailed flips a pending repayment to FAILED without bells", async () => {
    seedUser("admin-fail", ["ADMIN"]);
    const { repayment, txRef } = seedLoanAndRepayment({ suffix: "fail", outstandingNaira: 90000, repaymentAmountNaira: 10000 });
    const staffBellsBefore = activityNotifications.filter((row) => row.kind === "LOAN_REPAYMENT_STAFF").length;

    const failed = repaymentsMod.markRepaymentFailed(txRef, "Provider reported payment status=cancelled");
    expect(failed?.status).toBe("FAILED");
    expect(activityNotifications.filter((row) => row.kind === "LOAN_REPAYMENT_STAFF").length).toBe(staffBellsBefore);
    void repayment;
  });
});

describe("runInvestmentMaturitySweep — outcome notifications", () => {
  it("no verified payout account → PAYOUT_ACCOUNT_REQUIRED + investor/staff bells", async () => {
    const investor = seedUser("investor-noacct", ["INVESTOR"]);
    seedKyc(investor.id, "VERIFIED");
    const staff = seedUser("staff-noacct", ["ADMIN"]);
    const investmentId = `inv-${Math.random().toString(36).slice(2, 12)}`;
    investments.push({
      id: investmentId,
      investorId: investor.id,
      amountNaira: 250000,
      expectedEarningsNaira: 15000,
      tenureDays: 90,
      annualRatePercent: 24,
      startsAt: new Date(Date.now() - 100 * 86400000).toISOString(),
      maturesAt: new Date(Date.now() - 10 * 86400000).toISOString(),
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    seededIds.investments.push(investmentId);

    await investmentsMod.runInvestmentMaturitySweep(new Date(), 50);

    const row = investments.find((item: any) => item.id === investmentId);
    expect(row.status).toBe("PAYOUT_ACCOUNT_REQUIRED");
    const investorBells = bell(investor.id, "INVESTMENT_PAYOUT_ACCOUNT_REQUIRED");
    expect(investorBells.length).toBe(1);
    expect(investorBells[0].body).toContain("265,000");
    expect(bell(staff.id, "INVESTMENT_PAYOUT_ACCOUNT_REQUIRED_STAFF").length).toBe(1);
    void investorBells;
  });

  it("verified account but pending KYC → PENDING_APPROVAL payout + KYC-held bells", async () => {
    const investor = seedUser("investor-kycgate", ["INVESTOR"]);
    seedKyc(investor.id, "PENDING");
    const staff = seedUser("staff-kycgate", ["ADMIN"]);
    const investmentId = `inv-${Math.random().toString(36).slice(2, 12)}`;
    investments.push({
      id: investmentId,
      investorId: investor.id,
      amountNaira: 100000,
      expectedEarningsNaira: 8000,
      tenureDays: 60,
      annualRatePercent: 20,
      startsAt: new Date(Date.now() - 70 * 86400000).toISOString(),
      maturesAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    seededIds.investments.push(investmentId);
    const accountId = `pacct-${Math.random().toString(36).slice(2, 12)}`;
    payoutAccounts.push({
      id: accountId,
      userId: investor.id,
      accountNumber: "0123456789",
      bankCode: "058",
      bankName: "GTBank",
      accountName: investor.fullName,
      status: "VERIFIED",
      createdAt: new Date().toISOString(),
    });
    seededIds.accounts.push(accountId);

    await investmentsMod.runInvestmentMaturitySweep(new Date(), 50);

    const row = investments.find((item: any) => item.id === investmentId);
    expect(row.status).toBe("PAYOUT_PENDING");
    const held = payouts.find((item: any) => item.investmentId === investmentId);
    expect(held?.status).toBe("PENDING_APPROVAL");
    expect(bell(investor.id, "INVESTMENT_PAYOUT_KYC_HELD").length).toBe(1);
    expect(bell(staff.id, "INVESTMENT_PAYOUT_KYC_HELD_STAFF").length).toBe(1);
  });
});

describe("runInvestmentMaturityReminderSweep — 7/3/0-day reminders", () => {
  it("matures in 7 days: email channel-log + investor bell, no staff bell; second run is idempotent", async () => {
    const investor = seedUser("investor-rem7", ["INVESTOR"]);
    const staff = seedUser("staff-rem7", ["ADMIN"]);
    const investmentId = `inv-${Math.random().toString(36).slice(2, 12)}`;
    investments.push({
      id: investmentId,
      investorId: investor.id,
      amountNaira: 500000,
      expectedEarningsNaira: 30000,
      tenureDays: 90,
      annualRatePercent: 24,
      startsAt: new Date(Date.now() - 83 * 86400000).toISOString(),
      maturesAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    seededIds.investments.push(investmentId);

    await remindersMod.runInvestmentMaturityReminderSweep(new Date(), 50);

    const bellRows = bell(investor.id, "INVESTMENT_MATURITY_REMINDER");
    expect(bellRows.length).toBe(1);
    expect(bellRows[0].body).toContain("530,000");
    const emailRows = notifications.filter((row: any) => row.idempotencyKey?.startsWith(`inv-maturity:${investmentId}:7:`));
    expect(emailRows.length).toBe(1);
    expect(bell(staff.id, "INVESTMENT_MATURING_TODAY_STAFF").length).toBe(0);

    await remindersMod.runInvestmentMaturityReminderSweep(new Date(), 50);
    expect(bell(investor.id, "INVESTMENT_MATURITY_REMINDER").length).toBe(1);
    expect(notifications.filter((row: any) => row.idempotencyKey?.startsWith(`inv-maturity:${investmentId}:7:`)).length).toBe(1);
  });

  it("matures today: staff also get the due-today signal", async () => {
    const investor = seedUser("investor-rem0", ["INVESTOR"]);
    const staff = seedUser("staff-rem0", ["ADMIN"]);
    const investmentId = `inv-${Math.random().toString(36).slice(2, 12)}`;
    investments.push({
      id: investmentId,
      investorId: investor.id,
      amountNaira: 75000,
      expectedEarningsNaira: 5000,
      tenureDays: 30,
      annualRatePercent: 24,
      startsAt: new Date(Date.now() - 30 * 86400000).toISOString(),
      maturesAt: new Date(Date.now() - 3600_000).toISOString(),
      status: "ACTIVE",
      createdAt: new Date().toISOString(),
    });
    seededIds.investments.push(investmentId);

    await remindersMod.runInvestmentMaturityReminderSweep(new Date(), 50);

    expect(bell(investor.id, "INVESTMENT_MATURITY_REMINDER").length).toBe(1);
    const staffBells = bell(staff.id, "INVESTMENT_MATURING_TODAY_STAFF");
    expect(staffBells.length).toBe(1);
    expect(staffBells[0].body).toContain("80,000");
    void notifyMod;
  });
});

function borrowerIdOf(loan: any): string {
  return loan.borrowerId;
}
