import { beforeAll, describe, expect, it } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";
import { decomposeAndUpsertAll } from "./decompose.js";

// A fake Neon query function that ENFORCES the production foreign-key
// constraints relevant to loan persistence. It records every INSERT in order
// and throws exactly like Postgres (23503 foreign_key_violation) when a child
// row references a parent that has not been inserted yet.
//
// This is the regression harness for the "Unable to Save Information" incident:
// decomposeAndUpsertAll used to upsert credit_history_events BEFORE loans, so
// approving a loan (which pushes a LOAN_APPROVED credit event for the brand-new
// loan id) violated credit_history_events.loan_id → loans(id), the whole
// persist failed, and the admin saw a 503 even though the approval had been
// applied in memory.

type FakeRow = Record<string, unknown>;

const INSERT_RE = /^INSERT INTO ([a-z_]+) \(([^)]*)\) VALUES/i;

function makeFakeDb(existing: Record<string, FakeRow[]> = {}) {
  const tables: Record<string, FakeRow[]> = {};
  for (const [table, rows] of Object.entries(existing)) tables[table] = rows.map((r) => ({ ...r }));
  const insertOrder: string[] = [];

  const foreignKeys: Array<{ table: string; column: string; parentTable: string; parentColumn: string }> = [
    { table: "loans", column: "application_id", parentTable: "loan_applications", parentColumn: "id" },
    { table: "loan_schedules", column: "loan_id", parentTable: "loans", parentColumn: "id" },
    { table: "repayments", column: "loan_id", parentTable: "loans", parentColumn: "id" },
    { table: "disbursements", column: "loan_id", parentTable: "loans", parentColumn: "id" },
    { table: "credit_history_events", column: "loan_id", parentTable: "loans", parentColumn: "id" },
    { table: "credit_history_events", column: "repayment_id", parentTable: "repayments", parentColumn: "id" },
    { table: "admin_ledger_entries", column: "loan_id", parentTable: "loans", parentColumn: "id" },
    { table: "payouts", column: "investment_id", parentTable: "investments", parentColumn: "id" },
    { table: "investments", column: "plan_id", parentTable: "investment_plans", parentColumn: "id" },
  ];

  const db = {
    async query(statement: string, values: unknown[] = []) {
      const match = statement.match(INSERT_RE);
      if (!match) return [] as FakeRow[];
      const table = match[1];
      const columns = match[2].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
      insertOrder.push(table);
      // enforce foreign keys against everything inserted SO FAR plus seed rows
      for (const fk of foreignKeys.filter((f) => f.table === table)) {
        const colIndex = columns.indexOf(fk.column);
        if (colIndex === -1) continue;
        const value = values[colIndex];
        if (value === null || value === undefined) continue;
        const parents = [...(tables[fk.parentTable] ?? [])];
        const found = parents.some((row) => String(row[fk.parentColumn]) === String(value));
        if (!found) {
          const err = new Error(
            `insert or update on table "${table}" violates foreign key constraint "${table}_${fk.column}_fkey"`
          ) as Error & { code?: string };
          err.code = "23503";
          throw err;
        }
      }
      const row: FakeRow = {};
      columns.forEach((col, i) => { row[col] = values[i]; });
      if (!tables[table]) tables[table] = [];
      tables[table].push(row);
      return [] as FakeRow[];
    },
  };
  return { db: db as unknown as NeonQueryFunction<false, false>, tables, insertOrder };
}

const now = new Date().toISOString();

// Every StoreKey, pre-initialised to an empty array so a FULL-store persist
// (changedKeys === undefined) can run against the fake db.
const allStoreKeys = [
  "users", "wallets", "ledgerEntries", "walletTransactions", "kycCases",
  "identityVerificationEvents", "documents", "payoutAccounts", "investmentPlans",
  "investments", "loanApplications", "loans", "loanSchedules", "repayments",
  "payouts", "creditHistory", "creditScores", "creditReports", "otpChallenges",
  "passwordResetTokens", "notifications", "providerEvents", "consents", "loanProducts",
  "auditLogs", "adminLedger", "platformSettings", "investorWithdrawals",
  "disbursementAccounts", "loanDisbursements", "accountChangeRequests", "applicationDrafts",
];

function baseSnapshot() {
  const snap: Record<string, unknown[]> = {};
  for (const key of allStoreKeys) snap[key] = [];
  snap.users = [{
    id: "user-1", fullName: "Test Borrower", email: "borrower@test.ng", role: "BORROWER",
    roles: ["BORROWER"], createdAt: now,
  }];
  return snap as unknown as Parameters<typeof decomposeAndUpsertAll>[1];
}

describe("decomposeAndUpsertAll FK-safe persistence ordering", () => {
  beforeAll(() => {
    // decompose reads no env; import is side-effect free.
  });

  it("persists a fresh loan approval without FK violations (loans before credit_history_events)", async () => {
    const { db, insertOrder } = makeFakeDb();
    const snap = baseSnapshot();
    (snap as Record<string, unknown[]>).loanApplications = [{
      id: "app-1", applicationId: "VEL-APP-1", borrowerId: "user-1", applicantType: "PERSONAL",
      amountNaira: 50000, tenureDays: 30, status: "APPROVED", manualDecision: "APPROVED",
      customerSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {}, createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).loans = [{
      id: "loan-1", applicationId: "app-1", borrowerId: "user-1", principalNaira: 50000,
      totalInterestNaira: 750, totalFeesNaira: 0, totalRepaymentNaira: 50750, outstandingNaira: 50750,
      tenureDays: 30, status: "DISBURSEMENT_PENDING", dueAt: now, createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).loanSchedules = [{
      id: "sched-1", loanId: "loan-1", installmentNumber: 1, dueDate: now.slice(0, 10),
      principalNaira: 50000, interestNaira: 750, feesNaira: 0, totalDueNaira: 50750, totalPaidNaira: 0,
      status: "PENDING", createdAt: now,
    }];
    (snap as Record<string, unknown[]>).creditHistory = [{
      id: "ch-1", userId: "user-1", loanId: "loan-1", eventType: "LOAN_APPROVED",
      detail: "Application VEL-APP-1 approved", occurredAt: now, createdAt: now,
    }];
    (snap as Record<string, unknown[]>).auditLogs = [{
      id: "audit-1", userId: "admin-1", action: "LOAN_APPROVED", resourceType: "LOAN_APPLICATION",
      resourceId: "app-1", metadata: { applicationId: "VEL-APP-1" }, createdAt: now,
    }];

    const changedKeys = ["loanApplications", "loans", "loanSchedules", "creditHistory", "auditLogs"] as never[];
    const counts = await decomposeAndUpsertAll(db, snap, changedKeys);

    expect(counts.loans).toBe(1);
    expect(counts.creditHistory).toBe(1);
    // loans row MUST be inserted before the credit event that references it
    const loanIdx = insertOrder.indexOf("loans");
    const creditIdx = insertOrder.indexOf("credit_history_events");
    expect(loanIdx).toBeGreaterThanOrEqual(0);
    expect(creditIdx).toBeGreaterThan(loanIdx);
  });

  it("persists a loan disbursement + admin ledger debit after the loan exists", async () => {
    const { db, insertOrder, tables } = makeFakeDb({
      loan_applications: [{ id: "app-2", applicationId: "VEL-APP-2", borrowerId: "user-1" }],
      loans: [{ id: "loan-2", application_id: "app-2", borrower_id: "user-1", status: "APPROVED" }],
    });
    const snap = baseSnapshot();
    (snap as Record<string, unknown[]>).loanDisbursements = [{
      id: "disb-1", loanId: "loan-2", applicationId: "app-2", borrowerId: "user-1",
      amountNaira: 50000, currency: "NGN", bankCode: "999992", bankName: "Opay",
      accountNumber: "9164819320", accountName: "TEST USER", status: "FAILED",
      narration: "Velo loan disbursement VEL-APP-2", retryCount: 0, retryOfId: null,
      providerTransfer: { status: "error", message: "Transfer creation failed" },
      providerReference: null, error: "Transfer creation failed", createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).adminLedger = [{
      id: "ledger-1", entryType: "LOAN_DISBURSEMENT", referenceId: "loan-2", borrowerId: "user-1",
      loanId: "loan-2", amountMinor: 5000000, direction: "DEBIT", currency: "NGN",
      description: "Admin ledger debit for loan disbursement", metadata: { provider: "flutterwave" },
      createdAt: now,
    }];

    const changedKeys = ["loanDisbursements", "adminLedger"] as never[];
    await decomposeAndUpsertAll(db, snap, changedKeys);

    expect(tables.disbursements).toHaveLength(1);
    expect((tables.disbursements?.[0] as FakeRow).error).toBe("Transfer creation failed");
    expect(tables.admin_ledger_entries).toHaveLength(1);
    const disbursementIdx = insertOrder.indexOf("disbursements");
    const ledgerIdx = insertOrder.indexOf("admin_ledger_entries");
    expect(disbursementIdx).toBeGreaterThanOrEqual(0);
    expect(ledgerIdx).toBeGreaterThan(disbursementIdx);
  });

  it("persists a LOAN_DISBURSED credit event together with the disbursement confirmation", async () => {
    // Full approval + disbursement in ONE persist (small stores often persist
    // everything at once): loans, schedules, disbursements, credit history and
    // ledger all in a single snapshot.
    const { db } = makeFakeDb();
    const snap = baseSnapshot();
    (snap as Record<string, unknown[]>).loanApplications = [{
      id: "app-3", applicationId: "VEL-APP-3", borrowerId: "user-1", amountNaira: 50000,
      tenureDays: 30, status: "ACTIVE", customerSnapshot: {}, stageStatuses: {}, stageRejectionNotes: {},
      createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).loans = [{
      id: "loan-3", applicationId: "app-3", borrowerId: "user-1", principalNaira: 50000,
      totalInterestNaira: 750, totalFeesNaira: 0, totalRepaymentNaira: 50750, outstandingNaira: 50750,
      tenureDays: 30, status: "ACTIVE", disbursedAt: now, dueAt: now, createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).loanSchedules = [{
      id: "sched-3", loanId: "loan-3", installmentNumber: 1, dueDate: now.slice(0, 10),
      principalNaira: 50000, interestNaira: 750, feesNaira: 0, totalDueNaira: 50750, totalPaidNaira: 0,
      status: "PENDING", createdAt: now,
    }];
    (snap as Record<string, unknown[]>).loanDisbursements = [{
      id: "disb-3", loanId: "loan-3", applicationId: "app-3", borrowerId: "user-1",
      amountNaira: 50000, currency: "NGN", bankCode: "058", accountNumber: "0123456789",
      accountName: "TEST USER", status: "SUCCESSFUL", narration: "Velo loan disbursement VEL-APP-3",
      retryCount: 1, retryOfId: null, providerTransfer: { status: "success" },
      providerReference: "ref-3", error: null, processedAt: now, createdAt: now, updatedAt: now,
    }];
    (snap as Record<string, unknown[]>).creditHistory = [{
      id: "ch-3", userId: "user-1", loanId: "loan-3", eventType: "LOAN_DISBURSED",
      detail: "Disbursement confirmed via Flutterwave ref-3", occurredAt: now, createdAt: now,
    }];
    (snap as Record<string, unknown[]>).adminLedger = [{
      id: "ledger-3", entryType: "LOAN_DISBURSEMENT", referenceId: "loan-3", borrowerId: "user-1",
      loanId: "loan-3", amountMinor: 5000000, direction: "DEBIT", currency: "NGN",
      description: "Admin ledger debit for loan disbursement", metadata: {}, createdAt: now,
    }];

    await expect(decomposeAndUpsertAll(db, snap, undefined)).resolves.toBeDefined();
  });
});
