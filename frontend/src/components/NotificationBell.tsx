// ============================================================================
// src/components/NotificationBell.tsx
// In-app notification bell shared by the borrower, investor and admin
// dashboards. Polls the activity feed, shows an unread badge and opens a
// responsive panel where every notification carries a CTA that deep-links to
// the exact page it is about (loan detail, KYC, wallet, admin console…).
// Works with BOTH session types: apiClient prefers the customer token and
// falls back to the admin token automatically.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  getActivityNotifications,
  markActivityNotificationsRead,
  type ActivityNotification,
} from "../services/apiClient";

const POLL_INTERVAL_MS = 20_000;

const CATEGORY_STYLES: Record<string, { bg: string; icon: JSX.Element }> = {
  LOAN: {
    bg: "bg-blue-50 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <path d="M2 10h20" />
      </svg>
    ),
  },
  KYC: {
    bg: "bg-violet-50 text-violet-600 dark:bg-violet-900/40 dark:text-violet-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="m9 12 2 2 4-4" />
      </svg>
    ),
  },
  WALLET: {
    bg: "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
        <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
      </svg>
    ),
  },
  INVESTMENT: {
    bg: "bg-amber-50 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 3v18h18" />
        <path d="m7 14 4-4 4 4 5-5" />
      </svg>
    ),
  },
  BROADCAST: {
    bg: "bg-indigo-50 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </svg>
    ),
  },
  SYSTEM: {
    bg: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
    icon: (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
    ),
  },
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
}

export default function NotificationBell({ tone = "light" }: { tone?: "light" | "dark" }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<ActivityNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    try {
      const response = await getActivityNotifications(50);
      setNotifications(response.notifications ?? []);
      setUnreadCount(response.unreadCount ?? 0);
    } catch {
      // Signed-out or provider hiccup — the bell simply stays quiet.
    }
  }, []);

  // Initial load + polling keeps the badge fresh; the panel reloads on open.
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void load();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setLoading(true);
      await load();
      setLoading(false);
    }
  }

  async function openNotification(item: ActivityNotification) {
    if (!item.readAt) {
      // Optimistic — keep the UI snappy even on a slow network.
      setUnreadCount((count) => Math.max(0, count - 1));
      setNotifications((rows) => rows.map((row) => (row.id === item.id ? { ...row, readAt: new Date().toISOString() } : row)));
      void markActivityNotificationsRead({ ids: [item.id] }).catch(() => undefined);
    }
    if (item.actionUrl) {
      setOpen(false);
      navigate(item.actionUrl);
    }
  }

  async function markAllRead() {
    setUnreadCount(0);
    setNotifications((rows) => rows.map((row) => ({ ...row, readAt: row.readAt ?? new Date().toISOString() })));
    void markActivityNotificationsRead({ all: true }).catch(() => undefined);
  }

  const iconTone = tone === "dark"
    ? "text-slate-200 hover:bg-white/10"
    : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800";

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
        onClick={() => void toggle()}
        className={`relative inline-flex h-9 w-9 items-center justify-center rounded-full transition ${iconTone}`}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white shadow">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed inset-x-2 top-16 z-[60] sm:absolute sm:inset-x-auto sm:right-0 sm:top-11 sm:w-96">
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-slate-700 dark:bg-slate-900 animate-fade-in">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-velo-900 dark:text-white">Notifications</h2>
                {unreadCount > 0 && (
                  <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-600 dark:bg-red-900/40 dark:text-red-300">
                    {unreadCount} new
                  </span>
                )}
              </div>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  className="text-[11px] font-semibold text-velo-600 hover:underline dark:text-velo-400"
                >
                  Mark all read
                </button>
              )}
            </div>

            <div className="max-h-[70vh] overflow-y-auto sm:max-h-96">
              {loading && notifications.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-slate-400 dark:text-slate-500">Loading notifications…</div>
              ) : notifications.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <svg className="mx-auto mb-2 text-slate-300 dark:text-slate-600" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                  </svg>
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400">You're all caught up</p>
                  <p className="mt-0.5 text-[11px] text-slate-400 dark:text-slate-500">Updates about your loans, verification and wallet will appear here.</p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {notifications.map((item) => {
                    const style = CATEGORY_STYLES[item.category] ?? CATEGORY_STYLES.SYSTEM;
                    const unread = !item.readAt;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          onClick={() => void openNotification(item)}
                          className={`flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-slate-50 dark:hover:bg-slate-800/60 ${unread ? "bg-velo-50/40 dark:bg-slate-800/30" : ""}`}
                        >
                          <span className={`mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${style.bg}`}>
                            {style.icon}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-start justify-between gap-2">
                              <span className={`text-xs ${unread ? "font-bold text-velo-900 dark:text-white" : "font-semibold text-slate-700 dark:text-slate-200"}`}>
                                {item.title}
                              </span>
                              {unread && <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-velo-500" aria-hidden="true" />}
                            </span>
                            <span className="mt-0.5 block line-clamp-3 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                              {item.body}
                            </span>
                            <span className="mt-1 flex items-center justify-between gap-2">
                              <span className="text-[10px] text-slate-400 dark:text-slate-500">{relativeTime(item.createdAt)}</span>
                              {item.actionUrl && (
                                <span className="text-[10px] font-bold text-velo-600 dark:text-velo-400">
                                  {item.actionLabel || "View"} →
                                </span>
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
