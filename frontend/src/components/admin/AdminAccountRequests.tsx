import { useEffect, useState } from "react";
import { adminApi, adminListAccountRequests } from "../../services/adminApi";

type AccountRequestType = "INVESTOR_PAYOUT_ACCOUNT" | "BORROWER_DISBURSEMENT_ACCOUNT";
type AccountRequestStatus = "PENDING_APPROVAL" | "APPROVED" | "REJECTED";

type AccountChangeRequest = {
  id: string;
  userId: string;
  type: AccountRequestType;
  status: AccountRequestStatus;
  existingSnapshot?: {
    bankCode?: string;
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
  };
  newSnapshot: {
    bankCode?: string;
    bankName?: string;
    accountNumber?: string;
    accountName?: string;
  };
  reason?: string | null;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  rejectionReason?: string | null;
  createdAt: string;
  user?: {
    fullName?: string;
    email?: string;
    phone?: string;
  };
};

export default function AdminAccountRequests() {
  const [rows, setRows] = useState<AccountChangeRequest[]>([]);
  const [filter, setFilter] = useState<"ALL" | AccountRequestStatus>("PENDING_APPROVAL");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function load() {
    setError("");
    try {
      const res = await adminListAccountRequests({ status: filter !== "ALL" ? filter : undefined });
      if (res.ok) setRows(res.requests ?? []);
      else setError((res as any).error || "Could not load account change requests");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load requests");
    }
  }

  useEffect(() => {
    load();
  }, [filter]);

  async function action(id: string, decision: "APPROVE" | "REJECT", reason = "") {
    setBusy(id);
    setError("");
    try {
      const method = decision === "APPROVE" ? adminApi.approveAccountRequest : adminApi.rejectAccountRequest;
      const res = await method(id, decision === "REJECT" ? { rejectionReason: reason } : undefined);
      if ((res as any).ok || (res as any).success) {
        setRejectFor(null);
        setRejectReason("");
        await load();
      } else {
        setError((res as any).error || "Action failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy("");
    }
  }

  const totalPending = rows.filter((r) => r.status === "PENDING_APPROVAL").length;

  return (
    <div className="space-y-5">
      <div className="velo-card rounded-2xl p-4 sm:p-5 lg:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="font-bold text-velo-900 dark:text-white">Account change queue</h2>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              First-time setups are applied immediately. Subsequent edits require admin approval.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(["PENDING_APPROVAL", "ALL", "APPROVED", "REJECTED"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                  filter === s
                    ? "bg-emerald-600 text-white shadow shadow-emerald-600/20"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                }`}
              >
                {s.replace(/_/g, " ")}
                {s === "PENDING_APPROVAL" && totalPending ? ` · ${totalPending}` : ""}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-100 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-4 text-sm text-red-700 dark:text-red-400">
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="velo-card rounded-2xl p-10 text-center text-sm text-slate-500 dark:text-slate-400">
          No account change requests{filter !== "ALL" ? ` with status ${filter}` : ""}.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((r) => (
            <div
              key={r.id}
              className="velo-card rounded-2xl overflow-hidden"
            >
              <div className="flex flex-col lg:flex-row lg:items-start gap-4 p-4 sm:p-5 lg:p-6">
                <div className="flex-1 min-w-0 space-y-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`badge ${
                        r.status === "PENDING_APPROVAL"
                          ? "badge-pending"
                          : r.status === "APPROVED"
                          ? "badge-completed"
                          : "badge-rejected"
                      }`}
                    >
                      {r.status.replace(/_/g, " ")}
                    </span>
                    <span className="rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                      {r.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-[11px] text-slate-500 dark:text-slate-400">
                      {new Date(r.createdAt).toLocaleString("en-NG")}
                    </span>
                  </div>
                  <div>
                    <div className="text-base font-bold text-velo-900 dark:text-white">
                      {r.user?.fullName || r.userId}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {r.user?.email || "—"} {r.user?.phone ? `· ${r.user.phone}` : ""}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    {r.existingSnapshot && (
                      <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-4">
                        <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-2">
                          Current account
                        </div>
                        <div className="space-y-1 text-sm">
                          <div>
                            <span className="text-slate-500 dark:text-slate-400 text-xs">Bank: </span>
                            <span className="font-semibold text-velo-900 dark:text-white">
                              {r.existingSnapshot.bankName || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 dark:text-slate-400 text-xs">Number: </span>
                            <span className="font-mono font-semibold text-velo-900 dark:text-white">
                              {r.existingSnapshot.accountNumber || "—"}
                            </span>
                          </div>
                          <div>
                            <span className="text-slate-500 dark:text-slate-400 text-xs">Name: </span>
                            <span className="font-semibold text-velo-900 dark:text-white">
                              {r.existingSnapshot.accountName || "—"}
                            </span>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className="rounded-xl border border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-900/10 p-4">
                      <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400 mb-2">
                        Requested account
                      </div>
                      <div className="space-y-1 text-sm">
                        <div>
                          <span className="text-slate-500 dark:text-slate-400 text-xs">Bank: </span>
                          <span className="font-semibold text-velo-900 dark:text-white">
                            {r.newSnapshot.bankName || "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-slate-400 text-xs">Number: </span>
                          <span className="font-mono font-semibold text-velo-900 dark:text-white">
                            {r.newSnapshot.accountNumber || "—"}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-slate-400 text-xs">Name: </span>
                          <span className="font-semibold text-velo-900 dark:text-white">
                            {r.newSnapshot.accountName || "—"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {r.rejectionReason && (
                    <div className="rounded-lg bg-red-50 dark:bg-red-900/20 p-3 text-xs text-red-700 dark:text-red-400">
                      <span className="font-semibold">Rejection reason: </span>
                      {r.rejectionReason}
                    </div>
                  )}
                  {r.reason && (
                    <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 p-3 text-xs text-amber-700 dark:text-amber-400">
                      {r.reason}
                    </div>
                  )}
                  {r.reviewedAt && (
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      Reviewed {new Date(r.reviewedAt).toLocaleString("en-NG")} by {r.reviewedBy || "admin"}
                    </div>
                  )}
                </div>

                {r.status === "PENDING_APPROVAL" && (
                  <div className="lg:w-60 shrink-0 flex flex-col lg:items-end gap-2">
                    <button
                      onClick={() => action(r.id, "APPROVE")}
                      disabled={busy === r.id}
                      className="btn-primary w-full lg:w-auto text-sm"
                    >
                      {busy === r.id ? "Processing…" : "Approve"}
                    </button>
                    <button
                      onClick={() => {
                        setRejectFor(r.id);
                        setRejectReason("");
                      }}
                      disabled={busy === r.id}
                      className="btn-secondary w-full lg:w-auto text-sm border-red-200 text-red-700 hover:bg-red-50 dark:border-red-900/40 dark:text-red-400 dark:hover:bg-red-900/20"
                    >
                      Reject…
                    </button>
                  </div>
                )}
              </div>
              {rejectFor === r.id && (
                <div className="border-t border-slate-100 dark:border-slate-800 p-4 sm:p-5 lg:p-6 bg-slate-50 dark:bg-slate-900/30 space-y-3">
                  <label className="block text-sm font-semibold text-velo-900 dark:text-white">
                    Rejection reason
                  </label>
                  <textarea
                    className="velo-input w-full min-h-[90px]"
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Explain why this request is being rejected (the user will see this)…"
                  />
                  <div className="flex flex-wrap gap-2 justify-end">
                    <button
                      onClick={() => {
                        setRejectFor(null);
                        setRejectReason("");
                      }}
                      className="btn-secondary text-sm"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => action(r.id, "REJECT", rejectReason.trim())}
                      disabled={!rejectReason.trim() || busy === r.id}
                      className="btn-primary text-sm bg-gradient-to-r from-red-600 to-red-500 hover:from-red-700 hover:to-red-600"
                    >
                      Confirm reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
