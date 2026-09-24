// ============================================================================
// src/components/admin/CreditBureauReportModal.tsx
// Beautiful, structured rendering of the external credit-bureau response.
//
// The raw Prembly payload used to be dumped as a JSON <pre> block on the
// admin detail card. This modal turns that same payload into a readable
// report: verification outcome hero, bureau score, thin-file notices,
// verification trail (references/transaction IDs), the identity audit
// (masked BVN/NIN), provider billing, DSVI risk signals, commercial/consumer
// bureau details — with the raw JSON kept in a collapsed audit section.
// ============================================================================

import React, { useEffect } from "react";
import Icon from "../Icon";
import { formatDateLabel } from "../../utils/loanCalculator";

export interface CreditBureauExternalSnapshot {
  provider?: string;
  product?: string;
  status?: string;
  score?: number | null;
  reportReference?: string | null;
  requestedAt?: string | null;
  consentGrantedAt?: string | null;
  pulledAt?: string | null;
  reason?: string;
  normalizedFields?: Record<string, unknown> | null;
}

interface CreditBureauReportModalProps {
  open: boolean;
  onClose: () => void;
  external?: CreditBureauExternalSnapshot | null;
  borrowerName?: string;
  applicationId?: string;
}

type ReportView = "VERIFIED" | "NO_RECORD" | "FAILED" | "PENDING" | "EMPTY";

function isObj(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function prettyKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function scoreBand(score: number): { label: string; className: string } {
  if (score >= 750) return { label: "Excellent", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-200" };
  if (score >= 670) return { label: "Good", className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" };
  if (score >= 580) return { label: "Fair", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200" };
  return { label: "Poor", className: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" };
}

const BREAKDOWN_LABELS: Record<string, string> = {
  repaymentHistoryScore: "Repayment history",
  noOfAccountsScore: "Number of accounts",
  amountOwedScore: "Amount owed",
  creditTypeMixScore: "Credit type mix",
  creditHistoryLengthScore: "Credit history length",
  totalAccounts: "Total accounts",
  totalAccountsGoodStanding: "Accounts in good standing",
  totalAccountsBadStanding: "Accounts in bad standing",
  totalOutstandingDebtNGN: "Total outstanding debt",
  totalAmountOverdueNGN: "Total amount overdue",
  totalAccountsInArrears: "Accounts in arrears",
  totalForeignAccounts: "Foreign accounts",
  totalForeignOutstandingDebtNGN: "Foreign outstanding debt",
};

const COMMERCIAL_SECTION_LABELS: Record<string, string> = {
  businessName: "Business name",
  registrationNumber: "Registration number (RC)",
  commercialId: "Commercial ID",
  industrySector: "Industry sector",
  dateOfIncorporation: "Date of incorporation",
  taxIdentificationNumber: "Tax identification number",
  businessAddress: "Business address",
  highestDelinquencyRating: "Highest delinquency rating",
};

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 00-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function TrailRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null;
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</span>
      <span className={`break-all text-sm font-medium text-velo-900 dark:text-white ${mono ? "font-mono text-[13px]" : ""}`}>{value}</span>
    </div>
  );
}

function Chip({ tone, children }: { tone: "emerald" | "sky" | "amber" | "slate" | "violet"; children: React.ReactNode }) {
  const tones: Record<string, string> = {
    emerald: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800",
    sky: "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800",
    amber: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800",
    slate: "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
    violet: "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function BreakdownValue({ value }: { value: unknown }) {
  if (isObj(value)) {
    const num = value.numerator ?? value.n;
    const den = value.denominator ?? value.d;
    const pct = value.pct;
    if (num != null && den != null) {
      return (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-velo-900 dark:text-white">{String(num)}/{String(den)}</span>
          {typeof pct === "number" && (
            <span className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
            </span>
          )}
        </span>
      );
    }
    return <span className="font-mono text-velo-900 dark:text-white">{JSON.stringify(value)}</span>;
  }
  return <span className="font-mono text-velo-900 dark:text-white">{str(value)}</span>;
}

export default function CreditBureauReportModal({ open, onClose, external, borrowerName, applicationId }: CreditBureauReportModalProps) {
  // ESC to close + body scroll lock while the modal is up.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  const nf = (external?.normalizedFields ?? {}) as Record<string, any>;
  const verification = isObj(nf.verification) ? nf.verification : {};
  const billing = isObj(nf.billing_info) ? nf.billing_info : {};
  const dsvi = isObj(nf.dsvi) ? nf.dsvi : {};
  const breakdown = isObj(nf.breakdown) ? nf.breakdown : null;
  const facility = isObj(nf.facilityPerformanceSummary) ? nf.facilityPerformanceSummary : null;
  const isCommercial = String(nf.reportType || external?.product || "").toUpperCase().includes("COMMERCIAL");

  const reportStatus = String(external?.status || "").toUpperCase();
  const view: ReportView =
    reportStatus === "RECEIVED"
      ? str(nf.bureauNotice)
        ? "NO_RECORD"
        : "VERIFIED"
      : reportStatus === "PENDING"
        ? "PENDING"
        : reportStatus === "FAILED"
          ? "FAILED"
          : "EMPTY";

  const score = typeof external?.score === "number" ? external.score : typeof nf.score === "number" ? nf.score : null;
  const band = score != null ? scoreBand(score) : null;
  const providerLabel = external?.provider ? external.provider.charAt(0).toUpperCase() + external.provider.slice(1) : "Prembly";
  const productLabel = isCommercial ? "Commercial (Business) Advance" : "Consumer Advance";
  const statusMeta: Record<ReportView, { label: string; pillClass: string }> = {
    VERIFIED: { label: "VERIFIED", pillClass: "bg-white/20 text-white ring-1 ring-white/40" },
    NO_RECORD: { label: "NO BUREAU RECORD", pillClass: "bg-sky-100 text-sky-800 ring-1 ring-sky-300" },
    FAILED: { label: "FAILED", pillClass: "bg-red-500 text-white ring-1 ring-red-300" },
    PENDING: { label: "IN PROGRESS", pillClass: "bg-amber-400 text-amber-950 ring-1 ring-amber-300" },
    EMPTY: { label: "NOT REQUESTED", pillClass: "bg-white/20 text-white ring-1 ring-white/40" },
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-slate-950/70 backdrop-blur-sm px-0 pb-0 sm:items-center sm:p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credit-bureau-modal-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[94vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[92vh] sm:rounded-2xl dark:bg-slate-900"
        onClick={(event) => event.stopPropagation()}
      >
        {/* ---------- Header ---------- */}
        <div className="relative bg-gradient-to-br from-emerald-600 via-emerald-700 to-velo-800 px-5 pb-5 pt-4 text-white sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-100/90">Credit Bureau Report</p>
              <h2 id="credit-bureau-modal-title" className="mt-1 text-lg font-semibold sm:text-xl">
                {borrowerName || "Borrower"}
              </h2>
              {applicationId && <p className="mt-0.5 font-mono text-[11px] text-emerald-100/80">{applicationId}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close credit bureau report"
              className="rounded-full bg-white/10 p-2 text-white transition hover:bg-white/25"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-bold tracking-wide ${statusMeta[view].pillClass}`}>
              {view === "PENDING" && <Spinner className="h-3 w-3" />}
              {statusMeta[view].label}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold text-white ring-1 ring-white/30">
              <Icon name="shield" size={12} />
              {providerLabel}
            </span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold text-white ring-1 ring-white/30">
              {isCommercial ? <Icon name="briefcase" size={12} /> : <Icon name="wallet" size={12} />}
              {productLabel}
            </span>
            {str(nf.dataMode) && (
              <span className="inline-flex items-center rounded-full bg-white/15 px-3 py-1 text-[11px] font-semibold text-white ring-1 ring-white/30">
                Data: {str(nf.dataMode)}
              </span>
            )}
          </div>
        </div>

        {/* ---------- Body ---------- */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5 sm:px-6">
          {/* Hero — outcome */}
        {view === "VERIFIED" && (
            <div className="rounded-2xl border border-emerald-200 bg-gradient-to-b from-emerald-50 to-white p-5 text-center dark:border-emerald-800/60 dark:from-emerald-900/20 dark:to-slate-900">
              <div className="mx-auto mb-2 flex h-11 w-11 items-center justify-center rounded-full bg-emerald-500 text-white shadow-md shadow-emerald-500/30">
                <Icon name="check" size={22} strokeWidth={2.6} />
              </div>
              <p className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">Verification successful</p>
              {str(nf.message) && !/no record/i.test(str(nf.message)) && (
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{str(nf.message)}</p>
              )}
              {score != null ? (
                <div className="mt-4">
                  <div className="flex items-end justify-center gap-2">
                    <span className="text-5xl font-bold tracking-tight text-velo-900 dark:text-white">{score}</span>
                    <span className="pb-1.5 text-sm text-slate-500 dark:text-slate-400">/ 850</span>
                  </div>
                  {band && (
                    <span className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-bold ${band.className}`}>{band.label}</span>
                  )}
                  {str(nf.creditRiskDescription) && (
                    <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{str(nf.creditRiskDescription)}</p>
                  )}
                </div>
              ) : str(nf.bureauReference) ? (
                <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
                  Bureau reference: <span className="font-mono">{str(nf.bureauReference)}</span>
                </p>
              ) : null}
            </div>
          )}

          {view === "NO_RECORD" && (
            <div className="rounded-2xl border border-sky-200 bg-gradient-to-b from-sky-50 to-white p-5 dark:border-sky-800/60 dark:from-sky-900/20 dark:to-slate-900">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-sky-500 text-white shadow-md shadow-sky-500/30">
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-sky-900 dark:text-sky-200">Verification successful — no bureau record</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    The bureau was queried successfully, but this customer does not have a credit history file yet (a “thin file”).
                    This is <strong>not an error</strong> and no score is returned. Assess this application primarily on the internal
                    score, repayment capacity and collateral.
                  </p>
                  {str(nf.bureauNotice) && (
                    <p className="mt-2 rounded-lg bg-sky-100/70 px-3 py-2 text-xs font-medium text-sky-900 dark:bg-sky-900/40 dark:text-sky-200">
                      Bureau notice: “{str(nf.bureauNotice)}”
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {view === "FAILED" && (
            <div className="rounded-2xl border border-red-200 bg-gradient-to-b from-red-50 to-white p-5 dark:border-red-800/60 dark:from-red-900/20 dark:to-slate-900">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-red-500 text-white shadow-md shadow-red-500/30">
                  <Icon name="alert" size={20} />
                </div>
                <div>
                  <p className="text-sm font-semibold text-red-800 dark:text-red-200">The bureau check failed</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {str(external?.reason) || str(nf.reason) || "The provider could not complete this lookup."}
                  </p>
                  <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                    You can retry with the “Run credit bureau check” button — the report card refreshes automatically.
                  </p>
                </div>
              </div>
            </div>
          )}

          {view === "PENDING" && (
            <div className="rounded-2xl border border-amber-200 bg-gradient-to-b from-amber-50 to-white p-5 dark:border-amber-800/60 dark:from-amber-900/20 dark:to-slate-900">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-amber-400 text-amber-950 shadow-md shadow-amber-400/30">
                  <Spinner />
                </div>
                <div>
                  <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Bureau check in progress</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {str(nf.note) || "Real bureau lookups can take up to a minute. This report refreshes automatically — no action needed."}
                  </p>
                </div>
              </div>
            </div>
          )}

          {view === "EMPTY" && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400">
              No external bureau report has been requested yet. Use “Run credit bureau check” to pull one.
            </div>
          )}

          {/* DSVI risk signals */}
          {Object.keys(dsvi).length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
                <Icon name="target" size={13} /> Risk signals
              </h3>
              <div className="flex flex-wrap gap-2">
                {dsvi.score != null && (
                  <Chip tone="slate">DSVI score: <span className="font-mono">{str(dsvi.score)}</span></Chip>
                )}
                {str(dsvi.risk_label) && (
                  <Chip tone={String(dsvi.risk_label).toLowerCase() === "low" ? "emerald" : String(dsvi.risk_label).toLowerCase() === "high" ? "amber" : "slate"}>
                    Risk: {str(dsvi.risk_label).toUpperCase()}
                  </Chip>
                )}
                {str(dsvi.sensitivity_tier) && <Chip tone="slate">Sensitivity: {str(dsvi.sensitivity_tier).toUpperCase()}</Chip>}
              </div>
            </section>
          )}

          {/* Verification trail */}
          <section>
            <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
              <Icon name="history" size={13} /> Verification trail
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <TrailRow label="Verification status" value={str(verification.status) || str(nf.verification_status)} />
              <TrailRow label="Response code" value={str(nf.response_code)} mono />
              <TrailRow label="Provider reference" value={str(nf.reference_id) || str(external?.reportReference)} mono />
              <TrailRow label="Transaction ID" value={str(nf.transaction_id)} mono />
              <TrailRow label="Verification ID" value={str(verification.verification_id)} mono />
              <TrailRow label="Verification reference" value={str(verification.reference)} mono />
              <TrailRow label="Triggered via" value={str(nf.source)} />
              <TrailRow label="Requested" value={external?.requestedAt ? formatDateLabel(external.requestedAt) : ""} />
              <TrailRow label="Report pulled" value={external?.pulledAt ? formatDateLabel(external.pulledAt) : ""} />
              <TrailRow label="Consent granted" value={external?.consentGrantedAt ? formatDateLabel(external.consentGrantedAt) : ""} />
            </div>
          </section>

          {/* Identity audit */}
          {(str(nf.bvnMasked) || str(nf.ninMasked) || str(nf.rcNumber) || nf.bvnProvided || nf.ninOnFile) && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
                <Icon name="lock" size={13} /> Identity used for this check
              </h3>
              <div className="flex flex-wrap gap-2">
                {(nf.bvnProvided || str(nf.bvnMasked)) && (
                  <Chip tone="emerald">
                    <Icon name="check" size={11} /> BVN {str(nf.bvnMasked) ? <span className="font-mono">{str(nf.bvnMasked)}</span> : "provided"}
                  </Chip>
                )}
                {(nf.ninOnFile || str(nf.ninMasked)) && (
                  <Chip tone="sky">
                    NIN {str(nf.ninMasked) ? <span className="font-mono">{str(nf.ninMasked)}</span> : "on file"}
                  </Chip>
                )}
                {str(nf.rcNumber) && <Chip tone="violet">RC: <span className="font-mono">{str(nf.rcNumber)}</span></Chip>}
                {str(nf.companyName) && <Chip tone="violet">{str(nf.companyName)}</Chip>}
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                The Prembly credit-bureau API is strictly BVN-driven — the full BVN is always what is queried; the NIN is kept on record only. Full identifiers never appear in this report.
              </p>
            </section>
          )}

          {/* Billing */}
          {Object.keys(billing).length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
                <Icon name="money" size={13} /> Provider billing
              </h3>
              <div className="rounded-xl border border-slate-100 p-3 dark:border-slate-800">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-600 dark:text-slate-300">{billing.was_charged ? "Charged to provider wallet" : "No charge"}</span>
                  {billing.was_charged && (
                    <span className="font-semibold text-velo-900 dark:text-white">
                      ₦{str(billing.amount)} {str(billing.currency)}
                    </span>
                  )}
                </div>
                {str(billing.note) && <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">{str(billing.note)}</p>}
              </div>
            </section>
          )}

          {/* Commercial business details */}
          {isCommercial && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
                <Icon name="briefcase" size={13} /> Business bureau details
              </h3>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {Object.entries(COMMERCIAL_SECTION_LABELS).map(([key, label]) =>
                  str(nf[key]) ? <TrailRow key={key} label={label} value={str(nf[key])} /> : null
                )}
              </div>
              {Array.isArray(nf.directors) && nf.directors.length > 0 && (
                <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
                  {nf.directors.length} director{nf.directors.length === 1 ? "" : "s"} listed on the bureau file.
                </p>
              )}
              {facility && Object.keys(facility).length > 0 && (
                <div className="mt-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Facility performance summary</p>
                  <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
                    {Object.entries(facility).slice(0, 8).map(([key, value]) => (
                      <div key={key} className="flex items-center justify-between gap-2 border-b border-slate-50 py-1 last:border-0 dark:border-slate-800">
                        <dt className="text-slate-500 dark:text-slate-400">{prettyKey(key)}</dt>
                        <dd className="font-medium text-velo-900 dark:text-white">{str(value) || "—"}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}
            </section>
          )}

          {/* Consumer score breakdown */}
          {breakdown && Object.keys(breakdown).length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-velo-800 dark:text-velo-300">
                <Icon name="chart" size={13} /> Score breakdown
              </h3>
              <dl className="rounded-xl border border-slate-100 p-3 dark:border-slate-800">
                {Object.entries(breakdown).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between gap-3 border-b border-slate-50 py-1.5 text-xs last:border-0 dark:border-slate-800">
                    <dt className="text-slate-500 dark:text-slate-400">{BREAKDOWN_LABELS[key] ?? prettyKey(key)}</dt>
                    <dd><BreakdownValue value={value} /></dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* Raw provider response (audit) */}
          <details className="rounded-xl border border-slate-100 dark:border-slate-800">
            <summary className="cursor-pointer select-none px-4 py-3 text-xs font-semibold text-slate-600 hover:text-velo-700 dark:text-slate-300 dark:hover:text-velo-300">
              Raw provider response (audit)
            </summary>
            <pre className="mx-4 mb-4 max-h-64 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[10.5px] leading-relaxed text-slate-700 dark:bg-slate-900 dark:text-slate-300">
{JSON.stringify(nf, null, 2)}
            </pre>
          </details>
        </div>

        {/* ---------- Footer ---------- */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50/60 px-5 py-3.5 sm:px-6 dark:border-slate-800 dark:bg-slate-800/40">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Source: {providerLabel} · data queried via the verified BVN · rendered by Velo
          </p>
          <button type="button" onClick={onClose} className="btn-primary text-xs">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
