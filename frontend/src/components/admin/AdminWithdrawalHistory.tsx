// ============================================================================
// src/components/admin/AdminWithdrawalHistory.tsx
// Investor withdrawal history for admins:
//   • Search (investor name/email/id, bank, account, reference, amount)
//   • Status filter + date-range filter + pagination
//   • Detail view per withdrawal — the complete transaction trail: wallet
//     ledger entries, admin ledger entries, provider transfer payloads
//   • Retry for FAILED withdrawals + CSV export with date range
// ============================================================================

import { useEffect, useState } from "react";
import {
  adminListWithdrawals,
  adminGetWithdrawalDetail,
  adminRetryWithdrawal,
  type AdminWithdrawalDetail,
  type InvestorWithdrawal,
  type WithdrawalSummary,
} from "../../services/adminApi";
import { formatNaira } from "../../utils/loanCalculator";
import Icon from "../Icon";
import CsvExportButton from "../CsvExportButton";
import { Pill } from "./settingsUI";

const STATUS_OPTIONS = ["", "PROCESSING", "SUCCESSFUL", "FAILED", "PENDING_APPROVAL", "REJECTED", "CANCELLED"];
const PAGE_SIZE = 15;

function statusTone(status: string): "success" | "danger" | "info" | "neutral" {
  if (status === "SUCCESSFUL") return "success";
  if (status === "FAILED" || status === "REJECTED") return "danger";
  if (status === "PROCESSING" || status === "PENDING_APPROVAL") return "info";
  return "neutral";
}

export default function AdminWithdrawalHistory() {
  const [rows, setRows] = useState<Array<InvestorWithdrawal & { investor?: { id: string; fullName: string; email: string; phone: string | null } | null }>>([]);
  const [summary, setSummary] = useState<WithdrawalSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [page, setPage] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [detail, setDetail] = useState<AdminWithdrawalDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actioning, setActioning] = useState("");
  const [actionMsg, setActionMsg] = useState("");

  // Debounce the search box so we do not hit the API on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    adminListWithdrawals({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      search: search || undefined,
      status: statusFilter || undefined,
      from: fromDate || undefined,
      to: toDate || undefined,
    })
      .then((response) => {
        if (cancelled) return;
        setRows(response.withdrawals ?? []);
        setTotal(response.total ?? response.withdrawals?.length ?? 0);
        setSummary(response.summary ?? null);
        setError("");
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load withdrawals");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, search, statusFilter, fromDate, toDate]);

  async function openDetail(id: string) {
    setDetailLoading(true);
    setActionMsg("");
    try {
      const data = await adminGetWithdrawalDetail(id);
      setDetail(data);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "Unable to load withdrawal detail");
    } finally {
      setDetailLoading(false);
    }
  }

  async function retry(id: string) {
    setActioning(id);
    setActionMsg("");
    try {
      const result = await adminRetryWithdrawal(id);
      setActionMsg(result.message ?? "Withdrawal retry submitted.");
      if (detail?.withdrawal.id === id) await openDetail(id);
      // refresh list rows (status may have changed)
      const response = await adminListWithdrawals({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search: search || undefined,
        status: statusFilter || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
      });
      setRows(response.withdrawals ?? []);
      setTotal(response.total ?? response.withdrawals?.length ?? 0);
      setSummary(response.summary ?? null);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : "Unable to retry withdrawal");
    } finally {
      setActioning("");
    }
  }

  // ----------------------------- DETAIL VIEW -----------------------------
  if (detail || detailLoading) {
    const w = detail?.withdrawal;
    const investor = detail?.investor;
    return (
      <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => { setDetail(null); setActionMsg(""); }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            ← Back to withdrawal history
          </button>
          {w && (
            <div className="flex items-center gap-2">
              <Pill tone={statusTone(String(w.status))}>{String(w.status).replace(/_/g, " ")}</Pill>
              {w.status === "FAILED" && (
                <button
                  type="button"
                  onClick={() => void retry(w.id)}
                  disabled={actioning === w.id}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50"
                >
                  <Icon name="history" size={13} />{actioning === w.id ? "Retrying…" : "Retry withdrawal"}
                </button>
              )}
            </div>
          )}
        </div>

        {detailLoading && <div className="rounded-2xl border border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900/50 p-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading withdrawal detail…</div>}

        {actionMsg && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-xs font-semibold text-emerald-800 dark:border-emerald-900/50 dark:bg-emerald-900/15 dark:text-emerald-300">{actionMsg}</div>}

        {detail && w && (
          <>
            {/* Facts grid */}
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: "Withdrawal ID", value: w.id, mono: true },
                { label: "Amount", value: formatNaira(Number(w.amountNaira || 0)) },
                { label: "Fee", value: formatNaira(Number(w.feeNaira || 0)) },
                { label: "Net paid", value: formatNaira(Number(w.netNaira || 0)) },
                { label: "Bank", value: `${w.bankName || w.bankCode || "—"}` },
                { label: "Account", value: `${w.accountNumber} · ${w.accountName || ""}` },
                { label: "Provider reference", value: w.providerReference || "—", mono: true },
                { label: "Retries", value: String(w.retryCount ?? 0) },
                { label: "Created", value: w.createdAt ? new Date(w.createdAt).toLocaleString() : "—" },
                { label: "Last attempt", value: w.lastAttemptAt ? new Date(w.lastAttemptAt).toLocaleString() : "—" },
                { label: "Processed", value: w.processedAt ? new Date(w.processedAt).toLocaleString() : "—" },
                { label: "Updated", value: w.updatedAt ? new Date(w.updatedAt).toLocaleString() : "—" },
              ].map((item) => (
                <div key={item.label} className="rounded-xl border border-slate-100 bg-white p-4 dark:border-slate-800 dark:bg-slate-900/50">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{item.label}</div>
                  <div className={`mt-1 break-all text-sm font-semibold text-velo-900 dark:text-white ${item.mono ? "font-mono text-xs" : ""}`}>{item.value}</div>
                </div>
              ))}
            </div>

            {w.error && (
              <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-900/15 dark:text-red-300">
                <strong className="font-bold">Failure reason: </strong>{w.error}
              </div>
            )}

            <div className="grid gap-5 lg:grid-cols-3">
              {/* Investor + wallet */}
              <div className="rounded-2xl border border-slate-100 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
                <h3 className="text-sm font-bold text-velo-900 dark:text-white">Investor</h3>
                {investor ? (
                  <dl className="mt-3 space-y-2 text-sm">
                    <div className="flex justify-between gap-3"><dt className="text-slate-500 dark:text-slate-400">Name</dt><dd className="font-semibold text-velo-900 dark:text-white">{investor.fullName}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500 dark:text-slate-400">Email</dt><dd className="max-w-[60%] truncate font-medium text-slate-700 dark:text-slate-200">{investor.email}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500 dark:text-slate-400">Phone</dt><dd className="font-medium text-slate-700 dark:text-slate-200">{investor.phone || "—"}</dd></div>
                    <div className="flex justify-between gap-3"><dt className="text-slate-500 dark:text-slate-400">KYC</dt><dd><Pill tone={investor.kycStatus === "VERIFIED" ? "success" : "neutral"}>{investor.kycStatus ?? "—"}</Pill></dd></div>
                  </dl>
                ) : <p className="mt-3 text-sm text-slate-500 dark:text-slate-400">Investor record not found.</p>}
                {detail.wallet && (
                  <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div className="flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Wallet available</span><span className="font-bold text-velo-900 dark:text-white">{formatNaira(Math.round(detail.wallet.availableMinor) / 100)}</span></div>
                    <div className="mt-1 flex justify-between text-sm"><span className="text-slate-500 dark:text-slate-400">Wallet held</span><span className="font-bold text-velo-900 dark:text-white">{formatNaira(Math.round(detail.wallet.heldMinor) / 100)}</span></div>
                  </div>
                )}
                {w.narration && (
                  <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Narration</div>
                    <div className="mt-1 text-sm text-slate-700 dark:text-slate-200">{w.narration}</div>
                  </div>
                )}
              </div>

              {/* Investor ledger trail */}
              <LedgerTrailTable
                title="Wallet ledger trail"
                subtitle="Every wallet movement tied to this withdrawal."
                entries={detail.investorLedger}
              />

              {/* Admin ledger trail */}
              <LedgerTrailTable
                title="Admin ledger trail"
                subtitle="Mirror entries, fees and reversals."
                entries={detail.adminLedger}
              />
            </div>

            {/* Provider payloads */}
            <div className="grid gap-5 lg:grid-cols-2">
              <ProviderPayload title="Provider transfer (initiation)" payload={(w.providerTransfer as Record<string, Record<string, unknown>> | undefined)?.initiate} />
              <ProviderPayload title="Provider verification" payload={(w.providerTransfer as Record<string, Record<string, unknown>> | undefined)?.verification} />
            </div>
          </>
        )}
      </div>
    );
  }

  // ----------------------------- LIST VIEW -----------------------------
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="min-w-0 space-y-5">
      {/* Summary */}
      {summary && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryChip label="Withdrawals" value={String(summary.count)} />
          <SummaryChip label="Gross" value={formatNaira(summary.grossNaira)} />
          <SummaryChip label="Fees" value={formatNaira(summary.feeNaira)} />
          <SummaryChip label="Net" value={formatNaira(summary.netNaira)} />
          <SummaryChip label="Successful" value={String(summary.successful)} tone="success" />
          <SummaryChip label="Failed / pending" value={`${summary.failed} / ${summary.pending}`} tone={summary.failed > 0 ? "danger" : "neutral"} />
        </div>
      )}

      {/* Toolbar: search + status + date range + export */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div className="grid gap-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-end">
          <div className="relative lg:w-64">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"><circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" /><path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search investor, bank, reference, amount…"
              className="velo-input w-full pl-9 text-sm"
              aria-label="Search withdrawals"
            />
          </div>
          <label className="block lg:w-44">
            <select
              value={statusFilter}
              onChange={(event) => { setStatusFilter(event.target.value); setPage(0); }}
              className="velo-input text-sm"
              aria-label="Filter by status"
            >
              {STATUS_OPTIONS.map((option) => <option key={option || "all"} value={option}>{option ? option.replace(/_/g, " ") : "All statuses"}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">From</span>
            <input type="date" value={fromDate} max={toDate || undefined} onChange={(event) => { setFromDate(event.target.value); setPage(0); }} className="velo-input px-2 py-2 text-xs" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">To</span>
            <input type="date" value={toDate} min={fromDate || undefined} onChange={(event) => { setToDate(event.target.value); setPage(0); }} className="velo-input px-2 py-2 text-xs" />
          </label>
          {(fromDate || toDate) && (
            <button
              type="button"
              onClick={() => { setFromDate(""); setToDate(""); setPage(0); }}
              className="text-[11px] font-semibold text-slate-500 underline-offset-2 hover:underline dark:text-slate-400"
            >
              Clear dates
            </button>
          )}
        </div>
        <CsvExportButton path="/api/v1/admin/export/withdrawals" params={{ status: statusFilter || undefined }} />
      </div>

      {error && <div className="rounded-xl border border-red-100 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-900/15 dark:text-red-300">{error}</div>}

      <div className="overflow-hidden rounded-2xl border border-slate-100 bg-white dark:border-slate-800 dark:bg-slate-900/50">
        {loading ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">Loading withdrawals…</div>
        ) : rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500 dark:text-slate-400">
            {search || statusFilter || fromDate || toDate ? "No withdrawals match your search or filters." : "No withdrawal requests yet."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wider text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-4 py-3 font-bold">Investor</th>
                  <th className="px-4 py-3 text-right font-bold">Amount</th>
                  <th className="px-4 py-3 text-right font-bold">Fee</th>
                  <th className="px-4 py-3 text-right font-bold">Net</th>
                  <th className="px-4 py-3 font-bold">Destination</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Date</th>
                  <th className="px-4 py-3 text-right font-bold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {rows.map((w) => (
                  <tr
                    key={w.id}
                    className="cursor-pointer transition hover:bg-velo-50/40 dark:hover:bg-slate-800/40"
                    onClick={() => void openDetail(w.id)}
                  >
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-velo-900 dark:text-white">{w.investor?.fullName || `Investor ${w.investorId.slice(0, 8)}`}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">{w.investor?.email || w.investorId}</div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-semibold dark:text-slate-200">{formatNaira(Number(w.amountNaira || 0))}</td>
                    <td className="px-4 py-3.5 text-right font-medium text-red-600 dark:text-red-400">{formatNaira(Number(w.feeNaira || 0))}</td>
                    <td className="px-4 py-3.5 text-right font-bold text-emerald-700 dark:text-emerald-400">{formatNaira(Number(w.netNaira || 0))}</td>
                    <td className="px-4 py-3.5">
                      <div className="font-medium dark:text-slate-200">{w.bankName || w.bankCode || "—"}</div>
                      <div className="font-mono text-[11px] text-slate-500 dark:text-slate-400">••••{String(w.accountNumber).slice(-4)}</div>
                    </td>
                    <td className="px-4 py-3.5"><Pill tone={statusTone(String(w.status))}>{String(w.status).replace(/_/g, " ")}</Pill></td>
                    <td className="px-4 py-3.5 text-xs text-slate-500 dark:text-slate-400">{w.createdAt ? new Date(w.createdAt).toLocaleDateString() : "—"}</td>
                    <td className="px-4 py-3.5 text-right" onClick={(event) => event.stopPropagation()}>
                      <div className="flex justify-end gap-2">
                        <button type="button" className="btn-secondary px-2.5 py-1.5 text-[11px]" onClick={() => void openDetail(w.id)}>View</button>
                        {w.status === "FAILED" && (
                          <button type="button" onClick={() => void retry(w.id)} disabled={actioning === w.id} className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-600 disabled:opacity-50">
                            <Icon name="history" size={13} />{actioning === w.id ? "…" : "Retry"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
          <div className="flex items-center gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800">Previous</button>
            <span>Page {page + 1} of {pages}</span>
            <button type="button" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold transition hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryChip({ label, value, tone = "neutral" }: { label: string; value: string; tone?: "neutral" | "success" | "danger" }) {
  const toneCls = tone === "success" ? "text-emerald-700 dark:text-emerald-400" : tone === "danger" ? "text-red-700 dark:text-red-400" : "text-velo-900 dark:text-white";
  return (
    <div className="rounded-xl border border-slate-100 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900/50">
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 truncate text-sm font-bold sm:text-base ${toneCls}`}>{value}</div>
    </div>
  );
}

function LedgerTrailTable({
  title,
  subtitle,
  entries,
}: {
  title: string;
  subtitle: string;
  entries: AdminWithdrawalDetail["investorLedger"];
}) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <h3 className="text-sm font-bold text-velo-900 dark:text-white">{title}</h3>
      <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">{subtitle}</p>
      {entries.length === 0 ? (
        <p className="mt-4 rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">No ledger entries found for this withdrawal.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {entries.map((entry) => (
            <div key={entry.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3 dark:border-slate-800 dark:bg-slate-800/40">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-velo-900 dark:text-white">{String(entry.entryType).replace(/_/g, " ")}</span>
                <span className={`text-xs font-bold ${entry.direction === "CREDIT" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                  {entry.direction === "CREDIT" ? "+" : "−"}{formatNaira(Math.round(Number(entry.amountMinor) || 0) / 100)}
                </span>
              </div>
              {entry.description && <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-300">{entry.description}</div>}
              <div className="mt-1 flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
                <span>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}</span>
                {entry.balanceAfterMinor != null && <span>Balance after: {formatNaira(Math.round(Number(entry.balanceAfterMinor)) / 100)}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderPayload({ title, payload }: { title: string; payload: Record<string, unknown> | undefined }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-white p-5 dark:border-slate-800 dark:bg-slate-900/50">
      <h3 className="text-sm font-bold text-velo-900 dark:text-white">{title}</h3>
      {payload ? (
        <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-300">{JSON.stringify(payload, null, 2)}</pre>
      ) : (
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">No provider payload captured.</p>
      )}
    </div>
  );
}
