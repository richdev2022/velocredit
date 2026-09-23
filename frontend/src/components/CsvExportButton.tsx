// ============================================================================
// src/components/CsvExportButton.tsx
// Reusable "Export CSV" control with a date-range picker.
//
// The backend serializes and returns a real text/csv attachment
// (Content-Disposition); this component only downloads it — no client-side
// data munging, so arbitrarily large date ranges work.
//
// Used on every table page: admin (withdrawals, loans, payouts, ledger, KYC),
// investor (transactions, investments) and borrower (repayments, schedule).
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { config } from "../utils/config";

export interface CsvExportButtonProps {
  /** API path INCLUDING the /api/v1 prefix, e.g. /api/v1/admin/export/withdrawals */
  path: string;
  /** Extra query params appended to the export request (status filter, loanId…). */
  params?: Record<string, string | undefined>;
  /** Optional label override (defaults to "Export CSV"). */
  label?: string;
  /** Compact styling for tight toolbars. */
  compact?: boolean;
}

function pickToken(path: string): string | null {
  const adminToken = sessionStorage.getItem("velo:admin-token");
  const userToken = sessionStorage.getItem("velo:access-token");
  return path.startsWith("/api/v1/admin/") ? adminToken || userToken : userToken || adminToken;
}

export default function CsvExportButton({ path, params, label = "Export CSV", compact = false }: CsvExportButtonProps) {
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the popover when clicking outside or pressing Escape.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function handleExport() {
    setBusy(true);
    setError("");
    try {
      const query = new URLSearchParams();
      if (from) query.set("from", from);
      if (to) query.set("to", to);
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value) query.set(key, value);
      }
      const search = query.toString();
      const token = pickToken(path);
      const response = await fetch(`${config.apiUrl}${path}${search ? `?${search}` : ""}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!response.ok) {
        let message = `Export failed (${response.status})`;
        try {
          const body = await response.json();
          if (body?.error) message = String(body.error);
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      // Prefer the filename the server suggested via Content-Disposition.
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `velocredit-${Date.now()}.csv`;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4_000);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={busy}
        className={`inline-flex items-center gap-1.5 rounded-lg border border-velo-200 bg-white font-semibold text-velo-700 transition hover:bg-velo-50 disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-velo-300 dark:hover:bg-slate-700 ${
          compact ? "px-2.5 py-1.5 text-[11px]" : "px-3 py-2 text-xs"
        }`}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
        {busy ? "Preparing…" : label}
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-4 shadow-xl dark:border-slate-700 dark:bg-slate-900">
          <p className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Export to CSV</p>
          <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
            Pick a date range (optional) and download the file. Leave both empty to export everything.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">From</span>
              <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} className="velo-input mt-1 px-2 py-1.5 text-xs" />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">To</span>
              <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} className="velo-input mt-1 px-2 py-1.5 text-xs" />
            </label>
          </div>
          {error && <p className="mt-2 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] font-semibold text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-[11px] font-semibold text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
              onClick={() => { setFrom(""); setTo(""); }}
            >
              Clear dates
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              disabled={busy}
              className="rounded-lg bg-velo-600 px-3.5 py-2 text-xs font-bold text-white shadow transition hover:bg-velo-700 disabled:opacity-50"
            >
              {busy ? "Preparing…" : "Download CSV"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
