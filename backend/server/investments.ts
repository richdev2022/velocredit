import { randomUUID } from "node:crypto";
import { createInvestorPayout, normalizeBankCodeForFlutterwave } from "./providers/flutterwave.js";
import {
  investments,
  kycCases,
  payoutAccounts,
  payouts,
  users,
  type Payout,
  findWallet,
  appendLedger,
  appendAdminLedger,
  indexes,
} from "./store.js";
import { pushActivityNotification, notifyStaffActivity } from "./notify.js";
import {
  investmentMaturityAccountRequiredEmail,
  investmentMaturityHeldEmail,
  investmentMaturityPayoutEmail,
  investmentPayoutFailedEmail,
  kycActionBlockedEmail,
  sendEmail,
} from "./email.js";
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

/** KYC gate for automatic payouts: the investor must be VERIFIED before money moves. */
export function investorKycSatisfied(investorId: string): boolean {
  const kycStatus = kycCases.find((item) => item.userId === investorId)?.status;
  const userStatus = users.find((u) => u.id === investorId)?.kycStatus;
  const effective = !kycStatus || kycStatus === "NOT_STARTED" ? (userStatus ?? kycStatus ?? "NOT_STARTED") : kycStatus;
  return effective === "VERIFIED" || effective === "PARTIALLY_VERIFIED";
}

// ---------------------------------------------------------------------------
// Maturity notifications — push + email for EVERY maturity outcome. The sweep
// is the only place an investment automatically turns into money movement, so
// the investor (and the back-office team) must hear about it here.
// All sends are fire-and-forget: a notification failure must never prevent
// the payout itself.
// ---------------------------------------------------------------------------
function notifyMaturityAccountRequired(investment: typeof investments[number], totalNaira: number): void {
  const investor = users.find((u) => u.id === investment.investorId);
  if (!investor) return;
  pushActivityNotification({
    userId: investor.id,
    title: "Add a payout account to receive your matured investment",
    body: `Your investment of ₦${Number(investment.amountNaira ?? 0).toLocaleString("en-NG")} matured with ₦${totalNaira.toLocaleString("en-NG")} payable to you, but there is no verified bank account on file. Add one under Payout accounts and we'll send your money right away.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_ACCOUNT_REQUIRED",
    actionLabel: "Add payout account",
    actionUrl: "/investor",
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    ...investmentMaturityAccountRequiredEmail({
      investorName: investor.fullName,
      investmentId: investment.id,
      totalNaira: totalNaira.toLocaleString("en-NG"),
    }),
  }).catch(() => undefined);
  notifyStaffActivity({
    title: "Investor maturity blocked: no payout account",
    body: `${investor.fullName}'s matured investment ${investment.id.slice(0, 8)}… (₦${totalNaira.toLocaleString("en-NG")}) is waiting on a verified payout account. The money stays locked until they add one.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_ACCOUNT_REQUIRED_STAFF",
    actionLabel: "Open investor",
    actionUrl: `/admin#view=detail&id=${encodeURIComponent(investor.id)}`,
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
    actorUserId: investor.id,
  });
}

function notifyMaturityHeldForKyc(investment: typeof investments[number], totalNaira: number): void {
  const investor = users.find((u) => u.id === investment.investorId);
  if (!investor) return;
  pushActivityNotification({
    userId: investor.id,
    title: "Complete KYC to release your matured investment",
    body: `Your investment of ₦${Number(investment.amountNaira ?? 0).toLocaleString("en-NG")} matured with ₦${totalNaira.toLocaleString("en-NG")} payable. Identity verification is required before we can send the money — complete it on the Verification page.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_KYC_HELD",
    actionLabel: "Complete verification",
    actionUrl: "/investor",
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    ...investmentMaturityHeldEmail({
      investorName: investor.fullName,
      investmentId: investment.id,
      totalNaira: totalNaira.toLocaleString("en-NG"),
    }),
  }).catch(() => undefined);
  void sendEmail({ to: investor.email, name: investor.fullName, ...kycActionBlockedEmail({ name: investor.fullName, action: "INVESTOR_PAYOUT" }) }).catch(() => undefined);
  notifyStaffActivity({
    title: "Maturity payout held for KYC approval",
    body: `${investor.fullName}'s matured investment ${investment.id.slice(0, 8)}… (₦${totalNaira.toLocaleString("en-NG")}) produced a payout held in PENDING_APPROVAL until the investor completes KYC.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_KYC_HELD_STAFF",
    actionLabel: "Review payout queue",
    actionUrl: `/admin#view=detail&id=${encodeURIComponent(investor.id)}`,
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
    actorUserId: investor.id,
  });
}

function notifyMaturityPayoutInitiated(investment: typeof investments[number], payout: Payout, bankName: string, accountNumber: string): void {
  const investor = users.find((u) => u.id === investment.investorId);
  if (!investor) return;
  const principalNaira = Number(investment.amountNaira ?? 0);
  const earningsNaira = Number(investment.expectedEarningsNaira ?? 0);
  const totalNaira = Number(payout.amountNaira ?? principalNaira + earningsNaira);
  pushActivityNotification({
    userId: investor.id,
    title: "Investment matured — payout on the way",
    body: `₦${totalNaira.toLocaleString("en-NG")} (principal ₦${principalNaira.toLocaleString("en-NG")} + earnings ₦${earningsNaira.toLocaleString("en-NG")}) is on its way to ${bankName} ${accountNumber.slice(0, 2)}****${accountNumber.slice(-4)}. You'll get a confirmation once the bank settles it.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_MATURED",
    actionLabel: "Open investments",
    actionUrl: "/investor",
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    ...investmentMaturityPayoutEmail({
      investorName: investor.fullName,
      investmentId: investment.id,
      principalNaira,
      earningsNaira,
      totalNaira,
      bankName,
      accountNumber,
    }),
  }).catch(() => undefined);
  notifyStaffActivity({
    title: "Investment maturity payout initiated",
    body: `₦${totalNaira.toLocaleString("en-NG")} maturity payout for ${investor.fullName} (investment ${investment.id.slice(0, 8)}…) was initiated to ${bankName}.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_MATURED_STAFF",
    actionLabel: "Open investor",
    actionUrl: `/admin#view=detail&id=${encodeURIComponent(investor.id)}`,
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
    actorUserId: investor.id,
  });
}

function notifyMaturityPayoutFailed(investment: typeof investments[number], payout: Payout, reason: string): void {
  const investor = users.find((u) => u.id === investment.investorId);
  if (!investor) return;
  const totalNaira = Number(payout.amountNaira ?? investment.amountNaira ?? 0);
  pushActivityNotification({
    userId: investor.id,
    title: "Investment payout needs attention",
    body: `The bank transfer for your matured investment (₦${totalNaira.toLocaleString("en-NG")}) could not be completed: ${reason}. Your money is safe — our team retries automatically; please check your payout account details.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_FAILED",
    actionLabel: "Check payout account",
    actionUrl: "/investor",
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
  });
  void sendEmail({
    to: investor.email,
    name: investor.fullName,
    ...investmentPayoutFailedEmail({
      investorName: investor.fullName,
      investmentId: investment.id,
      totalNaira,
      reason,
    }),
  }).catch(() => undefined);
  notifyStaffActivity({
    title: "Maturity payout failed — needs retry",
    body: `₦${totalNaira.toLocaleString("en-NG")} maturity payout for ${investor.fullName} (investment ${investment.id.slice(0, 8)}…) failed: ${reason}. Retry from the payout queue once the bank details are confirmed.`,
    category: "INVESTMENT",
    kind: "INVESTMENT_PAYOUT_FAILED_STAFF",
    actionLabel: "Open payout queue",
    actionUrl: `/admin#view=detail&id=${encodeURIComponent(investor.id)}`,
    relatedEntityType: "INVESTMENT",
    relatedEntityId: investment.id,
    actorUserId: investor.id,
  });
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
      if (!account) {
        investment.status = "PAYOUT_ACCOUNT_REQUIRED";
        // Tell the investor exactly what is blocking their money and give the
        // team a heads-up — otherwise this row silently sits forever.
        notifyMaturityAccountRequired(investment, Number(investment.amountNaira ?? 0) + Number(investment.expectedEarningsNaira ?? 0));
        continue;
      }
      const amountNaira = Number(investment.amountNaira ?? 0) + Number(investment.expectedEarningsNaira ?? 0);
      const amountMinor = Math.round(amountNaira * 100);
      const principalMinor = Math.round(Number(investment.amountNaira ?? 0) * 100);
      const earningsMinor = Math.round(Number(investment.expectedEarningsNaira ?? 0) * 100);
      // KYC gate (automatic payout): hold the payout for admin approval when
      // the investor's identity verification is not complete. The investment
      // matures into a PENDING_APPROVAL payout that the admin queue releases
      // once KYC is verified — the customer is notified what to do.
      if (!investorKycSatisfied(investment.investorId)) {
        const heldPayout: Payout = {
          id: randomUUID(),
          investmentId: investment.id,
          userId: investment.investorId,
          payoutType: "INVESTMENT_MATURITY",
          principalNaira: Number(investment.amountNaira ?? 0),
          earningsNaira: Number(investment.expectedEarningsNaira ?? 0),
          feesNaira: 0,
          amountNaira,
          currency: "NGN",
          status: "PENDING_APPROVAL",
          payoutAccountSnapshot: account as unknown as Record<string, unknown>,
          error: "Held: investor KYC verification is pending. Approve after the investor completes KYC.",
          retryCount: 0,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        };
        payouts.push(heldPayout);
        investment.status = "PAYOUT_PENDING";
        investment.updatedAt = now.toISOString();
        notifyMaturityHeldForKyc(investment, Number(heldPayout.amountNaira ?? 0));
        continue;
      }
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
      // Two ledger entries instead of one: the principal release must be a
      // INVESTMENT_RELEASE (that is the entry type that unlocks the held
      // balance — see appendLedger), while the earnings are a plain
      // INVESTMENT_RETURN credit. Emitting principal+earnings as one
      // INVESTMENT_RETURN used to over-release the held balance by the
      // earnings amount and corrupt other active investments' holds.
      appendLedger(wallet, {
        entryType: "INVESTMENT_RELEASE",
        referenceId: investment.id,
        amountMinor: principalMinor,
        direction: "CREDIT",
        description: `Investment maturity release - principal for ${investment.id}`,
        metadata: {
          sweep: true,
          maturesAt: investment.maturesAt,
        },
      });
      if (earningsMinor > 0) {
        appendLedger(wallet, {
          entryType: "INVESTMENT_RETURN",
          referenceId: investment.id,
          amountMinor: earningsMinor,
          direction: "CREDIT",
          description: `Investment maturity earnings - ${investment.id}`,
          metadata: {
            sweep: true,
            principalNaira: investment.amountNaira,
            earningsNaira: investment.expectedEarningsNaira,
            maturesAt: investment.maturesAt,
          },
        });
      }
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
        notifyMaturityPayoutInitiated(investment, payout, String(account.bankName ?? account.bankCode ?? "your bank"), String(account.accountNumber ?? ""));
      } catch (error) {
        payout.status = "FAILED";
        payout.error = error instanceof Error ? error.message : "Payout failed";
        investment.status = "PAYOUT_FAILED";
        notifyMaturityPayoutFailed(investment, payout, payout.error ?? "Payout failed");
      }
    }
    if (i + batchSize < candidates.length) await yieldEventLoop();
  }
}
