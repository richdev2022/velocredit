import { randomUUID } from "node:crypto";
import { createInvestorPayout } from "./providers/flutterwave.js";
import {
  investments,
  payoutAccounts,
  payouts,
  type Payout,
  findWallet,
  appendLedger,
  appendAdminLedger,
  indexes,
} from "./store.js";

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

export async function runInvestmentMaturitySweep(now = new Date(), batchSize = 200): Promise<void> {
  const candidates: Array<typeof investments[number]> = [];
  for (const investment of investments) {
    if (investment.status !== "ACTIVE" || !investment.maturesAt || new Date(String(investment.maturesAt)) > now) continue;
    if (indexes.payoutsByInvestmentId.has(investment.id)) continue;
    candidates.push(investment);
  }
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    for (const investment of batch) {
      const verifiedAccounts = indexes.payoutAccountsByUserId.get(investment.investorId) ?? [];
      const account = verifiedAccounts.find((item) => item.status === "VERIFIED");
      if (!account) { investment.status = "PAYOUT_ACCOUNT_REQUIRED"; continue; }
      const amountNaira = Number(investment.amountNaira ?? 0) + Number(investment.expectedEarningsNaira ?? 0);
      const amountMinor = Math.round(amountNaira * 100);
      const principalMinor = Math.round(Number(investment.amountNaira ?? 0) * 100);
      const earningsMinor = Math.round(Number(investment.expectedEarningsNaira ?? 0) * 100);
      const wallet = findWallet(investment.investorId);
      appendAdminLedger({
        entryType: "INVESTMENT_RETURN",
        referenceId: investment.id,
        investorId: investment.investorId,
        amountMinor,
        direction: "DEBIT",
        description: `Admin ledger debit for investment maturity return internal credit - investment ${investment.id}`,
        metadata: {
          sweep: true,
          principalMinor,
          earningsMinor,
          maturesAt: investment.maturesAt,
        },
      });
      appendLedger(wallet, {
        entryType: "INVESTMENT_RETURN",
        referenceId: investment.id,
        amountMinor,
        direction: "CREDIT",
        description: `Investment maturity sweep credit - principal + earnings for ${investment.id}`,
        metadata: {
          principalNaira: investment.amountNaira,
          earningsNaira: investment.expectedEarningsNaira,
          maturesAt: investment.maturesAt,
        },
      });
      const payout: Payout = {
        id: randomUUID(),
        investmentId: investment.id,
        userId: investment.investorId,
        payoutType: "INVESTMENT_MATURITY",
        principalNaira: Number(investment.amountNaira ?? 0),
        earningsNaira: Number(investment.expectedEarningsNaira ?? 0),
        feesNaira: 0,
        amountNaira,
        currency: "NGN",
        status: "PENDING_PROVIDER_CONFIRMATION",
        payoutAccountSnapshot: account as unknown as Record<string, unknown>,
        retryCount: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      payouts.push(payout);
      try {
        const transfer = await createInvestorPayout({
          txRef: `VELO-INVESTMENT-MATURITY-${investment.id}`,
          amountNaira,
          accountNumber: String(account.accountNumber),
          accountBank: String(account.bankCode),
          beneficiaryName: String(account.accountName),
          narration: `Velo investment maturity payout ${investment.id}`,
        });
        payout.providerTransfer = transfer as unknown as Record<string, unknown>;
        investment.status = "PAYOUT_PENDING";
      } catch (error) {
        payout.status = "FAILED";
        payout.error = error instanceof Error ? error.message : "Payout failed";
        investment.status = "PAYOUT_FAILED";
      }
    }
    if (i + batchSize < candidates.length) await yieldEventLoop();
  }
}
