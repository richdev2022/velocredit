// ============================================================================
// scripts/e2eWalletReconcileTest.ts
// In-process end-to-end test for the wallet HOLD reconciliation.
//
// Regression harness for the production incident: an investor with ZERO
// investments and ZERO withdrawals saw `heldMinor: 40000` on their dashboard
// (a phantom ₦400 "locked" balance with no backing record), while
// available + held broke the `available = totalCredited - totalDebited`
// invariant (140000 + 40000 ≠ 230000 − 90000).
//
// Boots the real Express API in development mode (in-memory store), seeds the
// exact corrupted production state through the same store functions the
// production routes use, mints real JWTs and asserts:
//   A. Phantom hold (the reported incident): held 40000 with NO investments
//      and NO withdrawals  ->  dashboard returns held=0 and the ₦400 credited
//      back via a HOLD_RELEASE ledger row; invariant restored.
//   B. In-flight withdrawal: a live PROCESSING withdrawal KEEPS its hold.
//   C. Stale-but-resolved withdrawal: status stuck on PROCESSING but a
//      WITHDRAWAL_SETTLEMENT entry exists -> hold released.
//   D. Over-release (legacy multi-investment corruption): held below the
//      backing records -> HOLD_RESTORE debits the money back out of available.
//   E. Stuck withdrawal with NO provider transfer id, older than 15 minutes
//      -> FAILED + reversal when /investor/withdrawals/status is polled.
// ============================================================================

process.env.NODE_ENV = "development";
process.env.API_PORT = "4401";
process.env.API_HOST = "127.0.0.1";
process.env.API_PUBLIC_URL = "http://127.0.0.1:4401";
delete process.env.DATABASE_URL;

import { randomUUID } from "node:crypto";

const BASE = "http://127.0.0.1:4401";
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function report(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function seedInvestor(store: typeof import("../backend/server/store.js"), email: string): { id: string; token: string } {
  const id = randomUUID();
  store.users.push({
    id,
    email,
    phone: "+2348030000000",
    fullName: "Reconcile Test Investor",
    passwordHash: "x",
    roles: ["INVESTOR"],
    kycStatus: "VERIFIED",
    createdAt: new Date().toISOString(),
    isActive: true,
  } as never);
  const token = (authModule as typeof import("../backend/server/auth.js")).issueToken(store.users.find((u) => u.id === id)!);
  return { id, token };
}

let authModule: typeof import("../backend/server/auth.js");

async function main(): Promise<void> {
  await import("../backend/server/index.js");
  const store = await import("../backend/server/store.js");
  authModule = await import("../backend/server/auth.js");

  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) { up = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) throw new Error("API did not start within 30s");
  console.log("API is up. Seeding scenarios…\n");

  const getJson = async (path: string, token: string): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };

  // =========================================================================
  // Scenario A — the exact production incident (phantom ₦400 hold).
  // =========================================================================
  const a = seedInvestor(store, "reconcile-a@example.com");
  const walletA = store.findWallet(a.id);
  walletA.availableMinor = 140_000;
  walletA.heldMinor = 40_000;
  walletA.pendingDepositMinor = 500_000;
  walletA.totalCreditedMinor = 230_000;
  walletA.totalDebitedMinor = 90_000;
  // NO investments, NO withdrawals, NO payouts — the money is simply GONE from
  // the investor's view while "held" shows ₦400.

  const dashA = await getJson("/api/v1/investor/dashboard", a.token);
  const wA = dashA.body?.wallet ?? {};
  report("A: dashboard returns 200", dashA.status === 200, `status=${dashA.status}`);
  report("A: phantom hold cleared (held=0)", Number(wA.heldMinor) === 0, `heldMinor=${wA.heldMinor}`);
  report("A: ₦400 refunded to available", Number(wA.availableMinor) === 180_000, `availableMinor=${wA.availableMinor}`);
  report("A: credited includes the refund", Number(wA.totalCreditedMinor) === 270_000, `totalCreditedMinor=${wA.totalCreditedMinor}`);
  report("A: invariant available = credited - debited", Number(wA.availableMinor) === Number(wA.totalCreditedMinor) - Number(wA.totalDebitedMinor), `${wA.availableMinor} vs ${wA.totalCreditedMinor}-${wA.totalDebitedMinor}`);
  const ledgerA = store.ledgerEntries.filter((e) => e.walletId === walletA.id);
  const releaseRow = ledgerA.find((e) => e.entryType === "HOLD_RELEASE");
  report("A: HOLD_RELEASE audit row written", Boolean(releaseRow) && Number(releaseRow?.amountMinor) === 40_000, JSON.stringify(releaseRow ? { type: releaseRow.entryType, amount: releaseRow.amountMinor } : null));

  // =========================================================================
  // Scenario B — a LIVE in-flight withdrawal keeps its hold.
  // =========================================================================
  const b = seedInvestor(store, "reconcile-b@example.com");
  const walletB = store.findWallet(b.id);
  store.appendLedger(walletB, {
    entryType: "FUNDING",
    referenceId: randomUUID(),
    amountMinor: 1_000_000,
    direction: "CREDIT",
    description: "Test funding",
  });
  const withdrawalB = {
    id: randomUUID(),
    investorId: b.id,
    amountNaira: 3000,
    feeNaira: 0,
    netNaira: 3000,
    currency: "NGN" as const,
    bankCode: "100004",
    bankName: "Opay",
    accountNumber: "8163349199",
    accountName: "Test Investor",
    status: "PROCESSING" as const,
    retryCount: 0,
    lastAttemptAt: new Date().toISOString(),
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.investorWithdrawals.push(withdrawalB as never);
  store.appendLedger(walletB, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: withdrawalB.id,
    amountMinor: 300_000,
    direction: "DEBIT",
    description: "Withdrawal to Opay *9199",
  });
  const dashB = await getJson("/api/v1/investor/dashboard", b.token);
  const wB = dashB.body?.wallet ?? {};
  report("B: in-flight withdrawal hold KEPT", Number(wB.heldMinor) === 300_000, `heldMinor=${wB.heldMinor}`);
  report("B: available untouched by reconcile", Number(wB.availableMinor) === 700_000, `availableMinor=${wB.availableMinor}`);

  // =========================================================================
  // Scenario C — stale PROCESSING status but outcome entry already exists.
  // =========================================================================
  const c = seedInvestor(store, "reconcile-c@example.com");
  const walletC = store.findWallet(c.id);
  store.appendLedger(walletC, {
    entryType: "FUNDING",
    referenceId: randomUUID(),
    amountMinor: 500_000,
    direction: "CREDIT",
    description: "Test funding",
  });
  const withdrawalC = {
    id: randomUUID(),
    investorId: c.id,
    amountNaira: 2000,
    feeNaira: 0,
    netNaira: 2000,
    currency: "NGN" as const,
    bankCode: "100004",
    bankName: "Opay",
    accountNumber: "8163349199",
    accountName: "Test Investor",
    status: "PROCESSING" as const,
    retryCount: 0,
    idempotencyKey: randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  store.investorWithdrawals.push(withdrawalC as never);
  store.appendLedger(walletC, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: withdrawalC.id,
    amountMinor: 200_000,
    direction: "DEBIT",
    description: "Withdrawal to Opay *9199",
  });
  // The transfer actually SETTLED, but the process died before the withdrawal
  // record's status was flipped — only the settlement entry exists.
  store.appendLedger(walletC, {
    entryType: "WITHDRAWAL_SETTLEMENT",
    referenceId: withdrawalC.id,
    amountMinor: 0,
    direction: "CREDIT",
    description: "Release funds held for successful withdrawal",
    metadata: { releasedAmountMinor: 200_000 },
  });
  const dashC = await getJson("/api/v1/investor/dashboard", c.token);
  const wC = dashC.body?.wallet ?? {};
  report("C: stale PROCESSING withdrawal hold released", Number(wC.heldMinor) === 0, `heldMinor=${wC.heldMinor}`);
  report("C: no double refund (available stays 300000)", Number(wC.availableMinor) === 300_000, `availableMinor=${wC.availableMinor}`);

  // =========================================================================
  // Scenario D — legacy over-release ate another investment's hold.
  // =========================================================================
  const d = seedInvestor(store, "reconcile-d@example.com");
  const walletD = store.findWallet(d.id);
  store.appendLedger(walletD, {
    entryType: "FUNDING",
    referenceId: randomUUID(),
    amountMinor: 900_000,
    direction: "CREDIT",
    description: "Test funding",
  });
  const invD1 = randomUUID();
  const invD2 = randomUUID();
  store.investments.push({ id: invD1, investorId: d.id, amountNaira: 4000, status: "PAID_OUT", createdAt: new Date().toISOString() } as never);
  store.investments.push({ id: invD2, investorId: d.id, amountNaira: 4000, status: "ACTIVE", createdAt: new Date().toISOString() } as never);
  store.appendLedger(walletD, { entryType: "INVESTMENT_LOCK", referenceId: invD1, amountMinor: 400_000, direction: "DEBIT", description: "Investment 1 locked" });
  store.appendLedger(walletD, { entryType: "INVESTMENT_LOCK", referenceId: invD2, amountMinor: 400_000, direction: "DEBIT", description: "Investment 2 locked" });
  // Legacy sweep release: one INVESTMENT_RETURN of principal+earnings (450000)
  // against a 400000 hold — the old appendLedger clamped held at 0 and then
  // the second lock made it look like only 400000 was held. Simulate the
  // resulting corrupted counter: inv2's hold lost 50000 to the over-release.
  store.appendLedger(walletD, { entryType: "INVESTMENT_RELEASE", referenceId: invD1, amountMinor: 400_000, direction: "CREDIT", description: "Principal release" });
  store.appendLedger(walletD, { entryType: "INVESTMENT_RETURN", referenceId: invD1, amountMinor: 50_000, direction: "CREDIT", description: "Earnings" });
  walletD.heldMinor = 350_000; // corrupted snapshot of the legacy bug
  const dashD = await getJson("/api/v1/investor/dashboard", d.token);
  const wD = dashD.body?.wallet ?? {};
  report("D: missing hold restored from backing records", Number(wD.heldMinor) === 400_000, `heldMinor=${wD.heldMinor}`);
  // 900k funding − 400k lock1 − 400k lock2 + 400k release1 + 50k earnings
  // − 50k HOLD_RESTORE = 500000.
  report("D: restored money left available", Number(wD.availableMinor) === 500_000, `availableMinor=${wD.availableMinor}`);
  report("D: invariant available = credited - debited", Number(wD.availableMinor) === Number(wD.totalCreditedMinor) - Number(wD.totalDebitedMinor), `${wD.availableMinor} vs ${wD.totalCreditedMinor}-${wD.totalDebitedMinor}`);

  // =========================================================================
  // Scenario E — stuck withdrawal (no provider transfer id, >15min) reversed.
  // =========================================================================
  const e = seedInvestor(store, "reconcile-e@example.com");
  const walletE = store.findWallet(e.id);
  store.appendLedger(walletE, {
    entryType: "FUNDING",
    referenceId: randomUUID(),
    amountMinor: 500_000,
    direction: "CREDIT",
    description: "Test funding",
  });
  const withdrawalE = {
    id: randomUUID(),
    investorId: e.id,
    amountNaira: 500,
    feeNaira: 0,
    netNaira: 500,
    currency: "NGN" as const,
    bankCode: "100004",
    bankName: "Opay",
    accountNumber: "8163349199",
    accountName: "Test Investor",
    status: "PROCESSING" as const,
    retryCount: 0,
    idempotencyKey: randomUUID(),
    createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    // NO providerTransfer — the transfer was never initiated.
  };
  store.investorWithdrawals.push(withdrawalE as never);
  store.appendLedger(walletE, {
    entryType: "WITHDRAWAL_INITIATED",
    referenceId: withdrawalE.id,
    amountMinor: 50_000,
    direction: "DEBIT",
    description: "Withdrawal to Opay *9199",
  });
  const statusE = await getJson("/api/v1/investor/withdrawals/status", e.token);
  report("E: withdrawals/status returns 200", statusE.status === 200, `status=${statusE.status}`);
  // Background verification is async — poll the store for the reversal.
  let reversed = false;
  for (let i = 0; i < 40 && !reversed; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    reversed = (withdrawalE as unknown as { status: string }).status === "FAILED";
  }
  report("E: stuck withdrawal FAILED after timeout", reversed, `status=${(withdrawalE as unknown as { status: string }).status}`);
  const dashE = await getJson("/api/v1/investor/dashboard", e.token);
  const wE = dashE.body?.wallet ?? {};
  report("E: hold released back to available", Number(wE.availableMinor) === 500_000 && Number(wE.heldMinor) === 0, `availableMinor=${wE.availableMinor} heldMinor=${wE.heldMinor}`);

  // ---- Summary ------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.error("FAILED CHECKS:");
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

main().catch((error) => {
  console.error("e2eWalletReconcileTest crashed:", error);
  process.exit(1);
});
