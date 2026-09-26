// ============================================================================
// backend/server/notify.ts
// Shared activity-notification helpers (the in-app notification bell).
//
// One durable record per platform event that concerns a user, each carrying a
// deep-link so the bell CTA opens the exact page (loan detail, KYC, wallet…).
// Fire-and-forget safe by contract: a notification failure must NEVER break
// the business transaction that produced the event.
//
// Lives in its own module (instead of routes.ts) so index.ts (Flutterwave
// webhook), investments.ts (maturity sweep) and reminders.ts can push bells
// too without importing the whole Express router.
// ============================================================================

import { randomUUID } from "node:crypto";
import { activityNotifications, indexes, users, type ActivityNotification } from "./store.js";

const MAX_ACTIVITY_NOTIFICATIONS_PER_USER = 300;

export function pushActivityNotification(input: {
  userId: string;
  title: string;
  body: string;
  category: ActivityNotification["category"];
  kind?: string;
  actionLabel?: string;
  actionUrl?: string;
  actorUserId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}): ActivityNotification | undefined {
  try {
    if (!input.userId || !users.some((user) => user.id === input.userId)) return undefined;
    const now = new Date().toISOString();
    const notification: ActivityNotification = {
      id: randomUUID(),
      userId: input.userId,
      title: input.title.slice(0, 160),
      body: input.body.slice(0, 1200),
      category: input.category,
      kind: input.kind,
      actionLabel: input.actionLabel,
      actionUrl: input.actionUrl,
      actorUserId: input.actorUserId,
      relatedEntityType: input.relatedEntityType,
      relatedEntityId: input.relatedEntityId,
      createdAt: now,
    };
    activityNotifications.push(notification);
    // Keep the feed bounded — drop the oldest rows beyond the per-user cap.
    const userRows = indexes.activityNotificationsByUserId.get(input.userId);
    if (userRows && userRows.length > MAX_ACTIVITY_NOTIFICATIONS_PER_USER) {
      const overflow = userRows
        .slice()
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(0, userRows.length - MAX_ACTIVITY_NOTIFICATIONS_PER_USER);
      const overflowIds = new Set(overflow.map((row) => row.id));
      for (let i = activityNotifications.length - 1; i >= 0; i -= 1) {
        if (overflowIds.has(activityNotifications[i].id)) activityNotifications.splice(i, 1);
      }
    }
    return notification;
  } catch (error) {
    console.warn("[notify] pushActivityNotification failed (non-fatal):", error);
    return undefined;
  }
}

/** Every active back-office staff member (administrators + loan managers). */
export function activeStaffMembers(): Array<{ id: string; email: string; fullName: string }> {
  return users
    .filter((user) => user.isActive !== false && (user.roles.includes("ADMIN") || user.roles.includes("LOAN_MANAGER")))
    .map((user) => ({ id: user.id, email: user.email, fullName: user.fullName }));
}

/** Push one activity notification to every staff member (in-app bell). */
export function notifyStaffActivity(input: {
  title: string;
  body: string;
  category: ActivityNotification["category"];
  kind?: string;
  actionLabel?: string;
  actionUrl?: string;
  actorUserId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}): void {
  for (const staff of activeStaffMembers()) {
    pushActivityNotification({ ...input, userId: staff.id });
  }
}

/**
 * Push one activity notification to every ADMIN and to every loan manager
 * holding the "loan_notifications" permission — the exact audience that gets
 * repayment emails, so bells and inboxes always agree.
 */
export function notifyMoneyTeamActivity(input: {
  title: string;
  body: string;
  category: ActivityNotification["category"];
  kind?: string;
  actionLabel?: string;
  actionUrl?: string;
  actorUserId?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
}): void {
  const audience = users.filter(
    (user) =>
      user.isActive !== false &&
      (user.roles.includes("ADMIN") || (user.roles.includes("LOAN_MANAGER") && user.adminPermissions?.includes("loan_notifications")))
  );
  for (const staff of audience) {
    pushActivityNotification({ ...input, userId: staff.id });
  }
}
