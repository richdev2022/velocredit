import { env } from "./config.js";
import { investmentMaturityReminderEmail, loanReminderEmail, sendEmail, type ReminderKind } from "./email.js";
import { pushActivityNotification, notifyStaffActivity } from "./notify.js";
import { activityNotifications, investments, loans, notifications, users, indexes, type Notification } from "./store.js";

function reminderKind(daysUntilDue: number): ReminderKind | null { if (daysUntilDue < 0) return "OVERDUE"; if (daysUntilDue === 7) return "SEVEN_DAYS"; if (daysUntilDue === 3) return "THREE_DAYS"; if (daysUntilDue === 0) return "DUE_TODAY"; return null; }

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

export async function runRepaymentReminderSweep(now = new Date(), batchSize = 200): Promise<void> {
  const configuredDays = new Set(env.LOAN_REMINDER_DAYS.split(",").map((value) => Number(value.trim())).filter(Number.isFinite));
  const candidates: Array<{ loan: typeof loans[number]; daysUntilDue: number; dueAt: Date; kind: ReminderKind }> = [];
  for (const loan of loans) {
    if (!loan.dueAt || !["ACTIVE", "PAST_DUE"].includes(String(loan.status))) continue;
    const dueAt = new Date(String(loan.dueAt));
    const daysUntilDue = Math.ceil((dueAt.getTime() - now.getTime()) / 86400000);
    if (daysUntilDue >= 0 && !configuredDays.has(daysUntilDue)) continue;
    const kind = reminderKind(daysUntilDue); if (!kind) continue;
    candidates.push({ loan, daysUntilDue, dueAt, kind });
  }
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    for (const { loan, dueAt, kind } of batch) {
      const user = users.find((item) => item.id === loan.borrowerId); if (!user) continue;
      const key = `${loan.id}:${kind}:${now.toISOString().slice(0, 10)}`;
      if (indexes.notificationsByIdempotencyKey.has(key)) continue;
      const email = loanReminderEmail({ borrowerName: user.fullName, amountNaira: Number(loan.totalRepaymentNaira ?? loan.principalNaira ?? 0), dueDate: dueAt.toLocaleDateString("en-NG"), outstandingNaira: Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? loan.principalNaira ?? 0), lateFee: "Late fees apply according to the signed loan terms.", kind });
      const notification: Notification = {
        id: key,
        idempotencyKey: key,
        userId: user.id,
        channel: "EMAIL",
        status: "PENDING",
        retryCount: 0,
        kind,
        subject: email.subject,
        relatedEntityType: "loan",
        relatedEntityId: loan.id,
        createdAt: now.toISOString(),
      };
      notifications.push(notification);
      try { const result = await sendEmail({ to: user.email, name: user.fullName, subject: email.subject, html: email.html }); notification.status = result.sent ? "SENT" : "NOT_CONFIGURED"; notification.providerMessageId = result.providerReference; } catch (error) { notification.status = "FAILED"; notification.error = error instanceof Error ? error.message : "Email delivery failed"; }
      // In-app bell for the same reminder — the borrower sees it in their
      // notification feed even if the email lands in spam. Idempotent per
      // loan/kind/day against the durable activity feed (survives restarts).
      const overdue = kind === "OVERDUE";
      if (!hasActivityBellToday(user.id, overdue ? "REPAYMENT_OVERDUE" : "REPAYMENT_REMINDER", loan.id, now)) {
        pushActivityNotification({
          userId: user.id,
          title: overdue ? "Your loan repayment is past due" : kind === "DUE_TODAY" ? "Your loan repayment is due today" : `Your loan repayment is due in ${daysUntilLabel(kind)}`,
          body: `₦${Number(loan.outstandingNaira ?? loan.totalRepaymentNaira ?? loan.principalNaira ?? 0).toLocaleString("en-NG")} was due ${dueAt.toLocaleDateString("en-NG")}. Pay from the loan page to keep your repayment history clean${overdue ? " — late fees may apply" : ""}.`,
          category: "LOAN",
          kind: overdue ? "REPAYMENT_OVERDUE" : "REPAYMENT_REMINDER",
          actionLabel: "Repay now",
          actionUrl: `/borrower/loans/${encodeURIComponent(loan.id)}`,
          relatedEntityType: "loan",
          relatedEntityId: loan.id,
        });
      }
    }
    if (i + batchSize < candidates.length) await yieldEventLoop();
  }
}

function daysUntilLabel(kind: ReminderKind): string {
  if (kind === "SEVEN_DAYS") return "7 days";
  if (kind === "THREE_DAYS") return "3 days";
  return "";
}

/**
 * True when an activity bell of `kind` for `entityId` was already pushed to
 * `userId` earlier on the same calendar day. Uses the durable activity feed,
 * so hourly sweep re-runs and process restarts cannot duplicate a bell.
 */
function hasActivityBellToday(userId: string, kind: string, entityId: string, now: Date): boolean {
  const day = now.toISOString().slice(0, 10);
  return activityNotifications.some(
    (row) => row.userId === userId && row.kind === kind && row.relatedEntityId === entityId && String(row.createdAt).slice(0, 10) === day
  );
}

// ---------------------------------------------------------------------------
// Investment maturity reminders — the investor is told their position is
// maturing 7/3/0 days ahead (configurable via INVESTMENT_MATURITY_REMINDER_DAYS)
// so payout-account problems surface BEFORE the money is due to move.
// Idempotent per investment/day via the notification idempotency index.
// ---------------------------------------------------------------------------
export async function runInvestmentMaturityReminderSweep(now = new Date(), batchSize = 200): Promise<void> {
  const configuredDays = new Set(env.INVESTMENT_MATURITY_REMINDER_DAYS.split(",").map((value) => Number(value.trim())).filter(Number.isFinite));
  const candidates: Array<{ investment: typeof investments[number]; daysUntilMaturity: number }> = [];
  for (const investment of investments) {
    if (investment.status !== "ACTIVE" || !investment.maturesAt) continue;
    const maturesAt = new Date(String(investment.maturesAt));
    const daysUntilMaturity = Math.ceil((maturesAt.getTime() - now.getTime()) / 86400000);
    if (daysUntilMaturity < 0 || !configuredDays.has(daysUntilMaturity)) continue;
    candidates.push({ investment, daysUntilMaturity });
  }
  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize);
    for (const { investment, daysUntilMaturity } of batch) {
      const investor = users.find((item) => item.id === investment.investorId);
      if (!investor) continue;
      const key = `inv-maturity:${investment.id}:${daysUntilMaturity}:${now.toISOString().slice(0, 10)}`;
      if (indexes.notificationsByIdempotencyKey.has(key)) continue;
      const totalNaira = Number(investment.amountNaira ?? 0) + Number(investment.expectedEarningsNaira ?? 0);
      const email = investmentMaturityReminderEmail({
        investorName: investor.fullName,
        investmentId: investment.id,
        amountNaira: Number(investment.amountNaira ?? 0),
        expectedEarningsNaira: Number(investment.expectedEarningsNaira ?? 0),
        maturesOn: new Date(String(investment.maturesAt)).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
        daysUntilMaturity,
      });
      const record: Notification = {
        id: key,
        idempotencyKey: key,
        userId: investor.id,
        channel: "EMAIL",
        status: "PENDING",
        retryCount: 0,
        kind: "INVESTMENT_MATURITY_REMINDER",
        subject: email.subject,
        relatedEntityType: "investment",
        relatedEntityId: investment.id,
        createdAt: now.toISOString(),
      };
      notifications.push(record);
      try { const result = await sendEmail({ to: investor.email, name: investor.fullName, subject: email.subject, html: email.html }); record.status = result.sent ? "SENT" : "NOT_CONFIGURED"; record.providerMessageId = result.providerReference; } catch (error) { record.status = "FAILED"; record.error = error instanceof Error ? error.message : "Email delivery failed"; }
      const when = daysUntilMaturity <= 0 ? "today" : daysUntilMaturity === 1 ? "tomorrow" : `in ${daysUntilMaturity} days`;
      if (!hasActivityBellToday(investor.id, "INVESTMENT_MATURITY_REMINDER", investment.id, now)) {
        pushActivityNotification({
          userId: investor.id,
          title: `Your investment matures ${when}`,
          body: `₦${totalNaira.toLocaleString("en-NG")} (principal + expected earnings) matures ${when}. Make sure your payout account details are up to date — the payout is sent automatically on maturity.`,
          category: "INVESTMENT",
          kind: "INVESTMENT_MATURITY_REMINDER",
          actionLabel: "Open investments",
          actionUrl: "/investor",
          relatedEntityType: "investment",
          relatedEntityId: investment.id,
        });
      }
      // Staff only need the due-today signal to pre-verify payout accounts.
      if (daysUntilMaturity <= 0 && !hasActivityBellToday(investor.id, "INVESTMENT_MATURING_TODAY_STAFF", investment.id, now)) {
        notifyStaffActivity({
          title: "Investment maturing today",
          body: `${investor.fullName}'s investment ${investment.id.slice(0, 8)}… (₦${totalNaira.toLocaleString("en-NG")}) matures today — the maturity sweep will initiate the payout automatically.`,
          category: "INVESTMENT",
          kind: "INVESTMENT_MATURING_TODAY_STAFF",
          actionLabel: "Open investor",
          actionUrl: `/admin#view=detail&id=${encodeURIComponent(investor.id)}`,
          relatedEntityType: "investment",
          relatedEntityId: investment.id,
          actorUserId: investor.id,
        });
      }
    }
    if (i + batchSize < candidates.length) await yieldEventLoop();
  }
}
