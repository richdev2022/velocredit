// ============================================================================
// src/components/admin/AdminNotifications.tsx
// Admin "Notifications" workspace:
//   1. SEND — push a notification (in-app always, email optional) to a single
//      user, every borrower, every investor or the entire customer base,
//      with title, description, optional deep-link CTA.
//   2. HISTORY — the most recent broadcasts (title, recipients, channels).
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  adminListNotificationUsers,
  adminListSentNotifications,
  adminSendNotification,
  type AdminSentBroadcast,
} from "../../services/adminApi";

type Audience = "ALL" | "BORROWER" | "INVESTOR" | "USER";

export default function AdminNotifications() {
  const [audience, setAudience] = useState<Audience>("ALL");
  const [userId, setUserId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [actionUrl, setActionUrl] = useState("");
  const [actionLabel, setActionLabel] = useState("");
  const [sendEmail, setSendEmail] = useState(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [users, setUsers] = useState<Array<{ id: string; email: string; fullName: string; roles: string[]; isActive?: boolean }>>([]);
  const [userSearch, setUserSearch] = useState("");
  const [broadcasts, setBroadcasts] = useState<AdminSentBroadcast[]>([]);

  useEffect(() => {
    // The picker needs users for every audience except the ALL broadcast.
    if (audience === "ALL") return;
    let cancelled = false;
    // BORROWER/INVESTOR fetch role-filtered lists; a specific-user pick
    // searches across every active account.
    const role = audience === "BORROWER" ? "BORROWER" : audience === "INVESTOR" ? "INVESTOR" : undefined;
    adminListNotificationUsers({ role })
      .then((response) => { if (!cancelled) setUsers(response.users ?? []); })
      .catch(() => { if (!cancelled) setUsers([]); });
    return () => { cancelled = true; };
  }, [audience]);

  useEffect(() => {
    adminListSentNotifications()
      .then((response) => setBroadcasts(response.broadcasts ?? []))
      .catch(() => setBroadcasts([]));
  }, []);

  const filteredUsers = useMemo(() => {
    const needle = userSearch.trim().toLowerCase();
    if (!needle) return users.slice(0, 60);
    return users.filter((user) => user.fullName.toLowerCase().includes(needle) || user.email.toLowerCase().includes(needle)).slice(0, 60);
  }, [users, userSearch]);

  const selectedUser = users.find((user) => user.id === userId);

  const canSend = title.trim().length >= 2 && body.trim().length >= 2 && (audience !== "USER" || Boolean(userId)) && !sending;

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setMessage(null);
    try {
      const response = await adminSendNotification({
        userId: audience === "USER" ? userId : undefined,
        targetRole: audience === "USER" ? undefined : audience,
        title: title.trim(),
        body: body.trim(),
        category: "BROADCAST",
        actionUrl: actionUrl.trim() || undefined,
        actionLabel: actionUrl.trim() ? (actionLabel.trim() || "Open") : undefined,
        sendEmail,
      });
      setMessage({
        ok: true,
        text: `Notification delivered to ${response.recipients} recipient${response.recipients === 1 ? "" : "s"}${response.emailed ? " (in-app + email)" : " (in-app)"}.`,
      });
      setTitle("");
      setBody("");
      setActionUrl("");
      setActionLabel("");
      setUserId("");
      setSendEmail(false);
      adminListSentNotifications().then((refresh) => setBroadcasts(refresh.broadcasts ?? [])).catch(() => undefined);
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Unable to send the notification." });
    } finally {
      setSending(false);
      setTimeout(() => setMessage(null), 8000);
    }
  }

  return (
    <div className="space-y-5">
      {/* ------------------------------ SEND ------------------------------ */}
      <div className="velo-card p-4 sm:p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Send a notification</h2>
            <p className="mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              Delivers an in-app notification to the recipient's dashboard bell — optionally also by email. Use a deep-link so the CTA opens the exact page (e.g. <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-800">/borrower</code>, <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-800">/investor</code>, <code className="rounded bg-slate-100 px-1 py-0.5 text-[10px] dark:bg-slate-800">/kyc</code>).
            </p>
          </div>
        </div>

        <div className="mt-4 grid gap-4">
          <div>
            <label className="velo-label" htmlFor="notify-audience">Recipients</label>
            <select
              id="notify-audience"
              className="velo-input"
              value={audience}
              onChange={(event) => { setAudience(event.target.value as Audience); setUserId(""); }}
            >
              <option value="ALL">All users (every active account)</option>
              <option value="BORROWER">All borrowers</option>
              <option value="INVESTOR">All investors</option>
              <option value="USER">A specific user</option>
            </select>
          </div>

          {audience === "USER" && (
            <div>
              <label className="velo-label" htmlFor="notify-user">Recipient user</label>
              <input
                id="notify-user"
                className="velo-input"
                placeholder="Search by name or email…"
                value={selectedUser ? `${selectedUser.fullName} (${selectedUser.email})` : userSearch}
                onChange={(event) => { if (selectedUser) { setUserId(""); } setUserSearch(event.target.value); }}
              />
              {!selectedUser && userSearch.trim() && (
                <div className="mt-2 max-h-48 overflow-y-auto rounded-xl border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredUsers.length === 0 && (
                    <div className="px-3 py-3 text-xs text-slate-400">No users match “{userSearch}”.</div>
                  )}
                  {filteredUsers.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs hover:bg-velo-50/60 dark:hover:bg-slate-800/60"
                      onClick={() => { setUserId(user.id); setUserSearch(""); }}
                    >
                      <span className="font-semibold text-velo-900 dark:text-white">{user.fullName}</span>
                      <span className="text-slate-500 dark:text-slate-400 truncate">{user.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="velo-label" htmlFor="notify-title">Title</label>
              <input
                id="notify-title"
                className="velo-input"
                maxLength={160}
                placeholder="e.g. Scheduled maintenance this weekend"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div>
              <label className="velo-label" htmlFor="notify-action-url">Deep-link URL (optional)</label>
              <input
                id="notify-action-url"
                className="velo-input"
                maxLength={300}
                placeholder="/borrower"
                value={actionUrl}
                onChange={(event) => setActionUrl(event.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="velo-label" htmlFor="notify-body">Description</label>
            <textarea
              id="notify-body"
              className="velo-input"
              rows={5}
              maxLength={2000}
              placeholder="Write the full message your recipients will see on their dashboard…"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
            <div className="mt-1 text-right text-[10px] text-slate-400">{body.trim().length}/2000</div>
          </div>

          {actionUrl.trim() && (
            <div>
              <label className="velo-label" htmlFor="notify-action-label">CTA label</label>
              <input
                id="notify-action-label"
                className="velo-input"
                maxLength={60}
                placeholder="Open"
                value={actionLabel}
                onChange={(event) => setActionLabel(event.target.value)}
              />
            </div>
          )}

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300 text-velo-600 focus:ring-velo-500"
              checked={sendEmail}
              onChange={(event) => setSendEmail(event.target.checked)}
            />
            Also send as email
          </label>

          {message && (
            <div className={`rounded-lg px-3 py-2.5 text-xs font-medium ${message.ok ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300" : "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"}`}>
              {message.text}
            </div>
          )}

          <div>
            <button type="button" className="btn-primary" disabled={!canSend} onClick={() => void handleSend()}>
              {sending ? "Sending…" : `Send notification${audience !== "USER" ? ` to all ${audience === "ALL" ? "users" : audience.toLowerCase() + "s"}` : ""}`}
            </button>
          </div>
        </div>
      </div>

      {/* ---------------------------- HISTORY ---------------------------- */}
      <div className="velo-card p-4 sm:p-5">
        <h2 className="text-sm font-semibold text-velo-900 dark:text-white">Recently sent</h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">The latest broadcasts from the admin team.</p>
        {broadcasts.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/30 p-6 text-center text-xs text-slate-500 dark:text-slate-400">
            No notifications sent yet.
          </div>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 dark:divide-slate-800">
            {broadcasts.map((broadcast) => (
              <li key={broadcast.id} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-bold text-velo-900 dark:text-white">{broadcast.title}</span>
                  <span className="text-[10px] text-slate-400 dark:text-slate-500">
                    {broadcast.createdAt ? new Date(broadcast.createdAt).toLocaleString("en-NG") : "—"} · {broadcast.sentByName}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">{broadcast.body}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px]">
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 font-semibold text-slate-600 dark:bg-slate-800 dark:text-slate-300">{broadcast.recipients} recipient{broadcast.recipients === 1 ? "" : "s"}</span>
                  {broadcast.emailed && <span className="rounded-full bg-blue-50 px-2 py-0.5 font-semibold text-blue-600 dark:bg-blue-900/40 dark:text-blue-300">email</span>}
                  <span className="rounded-full bg-indigo-50 px-2 py-0.5 font-semibold text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300">in-app</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
