import { randomUUID } from "node:crypto";
import { createInvestorPayout, normalizeBankCodeForFlutterwave } from "./providers/flutterwave.js";
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
export function calculateInvestmentAccrual(investment: { amountNaira: number; annualRatePercent: number; tenureDays: number; startsAt: string; maturesAt: string }, now = new Date()) {
  const startsAt = new Date(investment.startsAt);
  const maturesAt = new Date(investment.maturesAt);
  const elapsedDays = Math.max(0, Math.min(investment.tenureDays, Math.floor((Math.min(now.getTime(), maturesAt.getTime()) - startsAt.getTime()) / 86400000)));
  const dailyEarningsNaira = (Number(investment.amountNaira) * Number(investment.annualRatePercent) / 100) / 365;
  const accruedEarningsNaira = Math.round(dailyEarningsNaira * elapsedDays * 100) / 100;
  const expectedEarningsNaira = Math.round(dailyEarningsNaira * investment.tenureDays * 100) / 100;
  return {
    dailyEarningsNaira: Math.round(dailyEarningsNaira * 100) / 100,
    accruedEarningsNaira,
    expectedEarningsNaira,
    elapsedDays,
    remainingDays: Math.max(0, investment.tenureDays - elapsedDays),
    isMatured: now.getTime() >= maturesAt.getTime(),
  };
}

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
        // Bank-code normalization: legacy payout accounts may carry codes from
        // other providers' conventions that Flutterwave rejects ("Unknown Bank
        // Code") — re-map against Flutterwave's live bank list first.
        let payoutBankCode = String(account.bankCode);
        try {
          const normalized = await normalizeBankCodeForFlutterwave(payoutBankCode, String(account.bankName ?? account.bankCode ?? ""));
          if (normalized && normalized !== payoutBankCode) {
            payoutBankCode = normalized;
            account.bankCode = normalized;
            account.updatedAt = now.toISOString();
          }
        } catch (_normError) {
          // Bank list unavailable — proceed with the stored code.
        }
        const transfer = await createInvestorPayout({
          txRef: `VELO-INVESTMENT-MATURITY-${investment.id}`,
          amountNaira,
          accountNumber: String(account.accountNumber),
          accountBank: payoutBankCode,
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
