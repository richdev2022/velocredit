// ============================================================================
// src/utils/unifiedTxs.test.ts
// Pins the transaction-history dedup contract. The backend intentionally writes
// overlapping bookkeeping records for the same money movement; buildUnifiedTxs
// must render each money movement EXACTLY once:
//   - funding  = wallet DEPOSIT tx + FUNDING ledger row  → ONE row
//   - investment = INVESTMENT_LOCK ledger + INVESTMENT wallet tx + investment
//     record                                            → ONE row
//   - withdrawal = WITHDRAWAL_INITIATED ledger + withdrawal record → ONE row
//   - admin credits / returns / fees / reversals stay untouched
// ============================================================================

import { describe, expect, it } from "vitest";
import { buildUnifiedTxs, type TransactionData } from "./unifiedTxs";

const depositId = "dep-1";
const depositRef = "VELO-FUND-123";
const investmentId = "inv-1";
const withdrawalId = "wd-1";

function seededData(): TransactionData {
  return {
    walletTransactions: [
      { id: depositId, type: "DEPOSIT", amountMinor: 10_000_000, status: "SUCCESSFUL", txRef: depositRef, createdAt: "2026-09-20T10:00:00Z", provider: "flutterwave" },
      { id: "wtx-inv", type: "INVESTMENT", amountMinor: 25_000_000, status: "COMPLETED", txRef: `VELO-INVEST-${investmentId}`, createdAt: "2026-09-21T10:00:00Z" },
    ],
    ledger: [
      { id: "led-fund", entryType: "FUNDING", referenceId: depositId, amountMinor: 10_000_000, direction: "CREDIT", createdAt: "2026-09-20T10:05:00Z", metadata: { txRef: depositRef }, description: "Wallet funding via flutterwave" },
      { id: "led-lock", entryType: "INVESTMENT_LOCK", referenceId: investmentId, amountMinor: 25_000_000, direction: "DEBIT", createdAt: "2026-09-21T10:05:00Z", description: "Investment locked" },
      { id: "led-credit", entryType: "MANUAL_ADJUSTMENT", referenceId: "admin-1", amountMinor: 5_000_000, direction: "CREDIT", createdAt: "2026-09-19T10:00:00Z", description: "Admin credit" },
    ],
    investments: [
      { id: investmentId, amountNaira: 250_000, status: "ACTIVE", createdAt: "2026-09-21T10:00:00Z", planSnapshot: { name: "Velo Flex 30" } },
    ],
    withdrawals: [
      { id: withdrawalId, amountNaira: 50_000, status: "SUCCESSFUL", createdAt: "2026-09-22T10:00:00Z", bankName: "GTBank", accountNumber: "0123456789" },
    ],
    ledger_withdrawal_hint: undefined,
  } as TransactionData;
}

// The withdrawal ledger row the backend writes alongside the record.
const withLedgerWithdrawal = (data: TransactionData): TransactionData => ({
  ...data,
  ledger: [
    ...(data.ledger ?? []),
    { id: "led-wd", entryType: "WITHDRAWAL_INITIATED", referenceId: withdrawalId, amountMinor: 5_000_000, direction: "DEBIT", createdAt: "2026-09-22T10:00:00Z", description: "Withdrawal initiated" },
  ],
});

describe("buildUnifiedTxs dedup contract", () => {
  it("renders wallet funding exactly once (no duplicate FUNDING ledger row)", () => {
    const rows = buildUnifiedTxs(seededData());
    const fundingRows = rows.filter((r) => r.id === depositId || r.kind === "DEPOSIT");
    const ledgerFunding = rows.filter((r) => r.kind === "FUNDING");
    expect(fundingRows).toHaveLength(1);
    expect(ledgerFunding).toHaveLength(0);
    expect(fundingRows[0].label).toBe("Wallet funding");
    expect(fundingRows[0].status).toBe("SUCCESSFUL");
    expect(fundingRows[0].amountMinor).toBe(10_000_000);
  });

  it("dedups funding by txRef when referenceId does not match", () => {
    const data = seededData();
    data.ledger = (data.ledger ?? []).map((e) =>
      (e as { id: string }).id === "led-fund" ? { ...e, referenceId: "different-id" } : e,
    );
    const rows = buildUnifiedTxs(data);
    expect(rows.filter((r) => r.kind === "DEPOSIT" || r.kind === "FUNDING")).toHaveLength(1);
  });

  it("renders an investment exactly once (plan name, live status)", () => {
    const rows = buildUnifiedTxs(seededData());
    const investmentRows = rows.filter((r) => r.kind === "INVESTMENT");
    const lockRows = rows.filter((r) => r.kind === "INVESTMENT_LOCK");
    expect(investmentRows).toHaveLength(1);
    expect(lockRows).toHaveLength(0);
    expect(investmentRows[0].label).toBe("Investment: Velo Flex 30");
    expect(investmentRows[0].status).toBe("ACTIVE");
    expect(investmentRows[0].direction).toBe("DEBIT");
  });

  it("never turns the INVESTMENT wallet tx into a phantom credit", () => {
    const rows = buildUnifiedTxs(seededData());
    const phantom = rows.filter((r) => r.label === "INVESTMENT");
    expect(phantom).toHaveLength(0);
    expect(rows.filter((r) => r.direction === "CREDIT").every((r) => r.amountMinor >= 0)).toBe(true);
  });

  it("renders a withdrawal exactly once with its LIVE status", () => {
    const rows = buildUnifiedTxs(withLedgerWithdrawal(seededData()));
    const withdrawalRows = rows.filter((r) => r.kind === "PAYOUT" && r.direction === "DEBIT");
    expect(withdrawalRows).toHaveLength(1);
    expect(withdrawalRows[0].label).toContain("GTBank");
    expect(withdrawalRows[0].status).toBe("SUCCESSFUL");
  });

  it("keeps unmatched ledger rows (admin credits) as OTHER/CREDIT", () => {
    const rows = buildUnifiedTxs(seededData());
    const adminCredit = rows.find((r) => r.id === "led-credit");
    expect(adminCredit).toBeDefined();
    expect(adminCredit!.direction).toBe("CREDIT");
    expect(adminCredit!.label).toBe("MANUAL ADJUSTMENT");
    expect(adminCredit!.status).toBe("COMPLETED");
  });

  it("skips ₦0 WITHDRAWAL_SETTLEMENT bookkeeping markers", () => {
    const data = withLedgerWithdrawal(seededData());
    data.ledger = [
      ...(data.ledger ?? []),
      { id: "led-settle", entryType: "WITHDRAWAL_SETTLEMENT", referenceId: withdrawalId, amountMinor: 0, direction: "DEBIT", createdAt: "2026-09-22T10:05:00Z" },
    ];
    const rows = buildUnifiedTxs(data);
    expect(rows.filter((r) => r.id === "led-settle")).toHaveLength(0);
  });

  it("still shows a PENDING deposit (before provider confirmation)", () => {
    const data = seededData();
    data.walletTransactions = (data.walletTransactions ?? []).map((tx) =>
      (tx as { id: string }).id === depositId ? { ...tx, status: "PENDING_PROVIDER_CONFIRMATION" } : tx,
    );
    // A pending deposit has NOT settled yet — no ledger row exists for it.
    data.ledger = (data.ledger ?? []).filter((e) => (e as { id: string }).id !== "led-fund");
    const rows = buildUnifiedTxs(data);
    const funding = rows.find((r) => r.id === depositId);
    expect(funding).toBeDefined();
    expect(funding!.status).toBe("PENDING PROVIDER CONFIRMATION");
  });

  it("keeps INVESTMENT_LOCK ledger rows when the investment record is missing (legacy data)", () => {
    const data = seededData();
    data.investments = [];
    const rows = buildUnifiedTxs(data);
    // Without the first-class row the ledger row is the only representation.
    expect(rows.filter((r) => r.kind === "INVESTMENT_LOCK")).toHaveLength(1);
  });

  it("sorts rows newest first and guarantees unique ids", () => {
    const rows = buildUnifiedTxs(withLedgerWithdrawal(seededData()));
    for (let i = 1; i < rows.length; i++) {
      expect(new Date(rows[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(rows[i].createdAt).getTime());
    }
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(rows.length);
  });

  it("returns an empty list for null input", () => {
    expect(buildUnifiedTxs(null)).toEqual([]);
  });
});
