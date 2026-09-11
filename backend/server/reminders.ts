import { env } from "./config.js";
import { loanReminderEmail, sendEmail, type ReminderKind } from "./email.js";
import { loans, notifications, users, indexes, type Notification } from "./store.js";

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
    }
    if (i + batchSize < candidates.length) await yieldEventLoop();
  }
}
