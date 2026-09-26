// ============================================================================
// src/components/admin/InvestmentPlansManager.tsx
// "Investment plans" — THE single source of truth for what investors see.
//
// Nothing is hardcoded: the admin creates, configures, deactivates and deletes
// investment plans here, and the investor dashboard renders EXACTLY this
// catalog (GET /investor/investment-plans is served straight from it).
//
// Every plan parameter is editable:
//   identity    — name, description
//   amounts     — min / max investment
//   tenure      — duration in days
//   earnings    — PERCENT (annual % p.a.) or FLAT (fixed ₦ for the whole tenure)
//   liquidity   — early exit allowed + early-exit fee (% or ₦) + forfeit interest
//   fees        — gateway fee (% or ₦)
//   capacity    — total naira the plan accepts across all investors (optional)
//   window      — active flag, allow investments after close, effective-until
//
// Plans save INDEPENDENTLY (POST/PATCH/DELETE /admin/investment-plans) and the
// classic Velo defaults (Flex 30 / Growth 90 / Max 180 / Prime 365) can be
// re-seeded at any time with "Load default plans" — the seed only fills gaps
// and never overwrites admin edits.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  adminListInvestmentPlans,
  adminCreateInvestmentPlan,
  adminPatchInvestmentPlan,
  adminDeleteInvestmentPlan,
  adminSeedInvestmentPlans,
  type InvestmentPlan,
} from "../../services/apiClient";
import Icon from "../Icon";
import { Pill, Toggle, NairaField, Segmented } from "./settingsUI";

type FeeBasisChoice = "PERCENTAGE" | "FLAT";
type PlanRow = InvestmentPlan;

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function naira(n: number | undefined | null): string {
  const v = Number(n ?? 0);
  return `₦${Number.isFinite(v) ? v.toLocaleString("en-NG") : 0}`;
}

/** Human earnings label — percent plans show "% p.a.", flat plans the fixed ₦. */
function earningsLabel(plan: Pick<PlanRow, "earningsBasis" | "earningsFlatNaira" | "annualRatePercent">): string {
  return plan.earningsBasis === "FLAT"
    ? `${naira(plan.earningsFlatNaira ?? 0)} fixed earnings`
    : `${plan.annualRatePercent}% p.a.`;
}

function feeLabel(basis: FeeBasisChoice | undefined, percent: number, flat: number | undefined): string {
  if (basis === "FLAT") return naira(flat ?? 0);
  return `${percent}%`;
}

/** ISO string -> datetime-local input value (local time, minutes precision). */
function isoToLocalInput(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isClosed(plan: Pick<PlanRow, "effectiveTo">, nowIso: string): boolean {
  return Boolean(plan.effectiveTo && plan.effectiveTo <= nowIso);
}

/* ------------------------------------------------------------------ */
/* Editor form state                                                   */
/* ------------------------------------------------------------------ */

interface FormState {
  name: string;
  description: string;
  minAmountNaira: number;
  maxAmountNaira: number;
  tenureDays: number;
  earningsBasis: FeeBasisChoice;
  annualRatePercent: string;
  earningsFlatNaira: number;
  earlyLiquidityAllowed: boolean;
  earlyLiquidityFeeBasis: FeeBasisChoice;
  earlyLiquidityFeePercent: string;
  earlyLiquidityFeeFlatNaira: number;
  forfeitInterestOnEarlyExit: boolean;
  gatewayFeeBasis: FeeBasisChoice;
  gatewayFeePercent: string;
  gatewayFeeFlatNaira: number;
  capacityEnabled: boolean;
  capacityNaira: number;
  isActive: boolean;
  allowNewInvestmentsAfterClose: boolean;
  effectiveToInput: string; // datetime-local, "" = no end
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  minAmountNaira: 10_000,
  maxAmountNaira: 5_000_000,
  tenureDays: 90,
  earningsBasis: "PERCENTAGE",
  annualRatePercent: "12.5",
  earningsFlatNaira: 25_000,
  earlyLiquidityAllowed: false,
  earlyLiquidityFeeBasis: "PERCENTAGE",
  earlyLiquidityFeePercent: "2",
  earlyLiquidityFeeFlatNaira: 5_000,
  forfeitInterestOnEarlyExit: false,
  gatewayFeeBasis: "PERCENTAGE",
  gatewayFeePercent: "0.5",
  gatewayFeeFlatNaira: 1_000,
  capacityEnabled: false,
  capacityNaira: 100_000_000,
  isActive: true,
  allowNewInvestmentsAfterClose: false,
  effectiveToInput: "",
};

function formFromPlan(plan: PlanRow): FormState {
  const flatLiquidity = plan.earlyLiquidityFeeBasis === "FLAT";
  const flatGateway = plan.gatewayFeeBasis === "FLAT";
  const capacity = Number(plan.capacityNaira ?? 0);
  return {
    name: plan.name,
    description: plan.description ?? "",
    minAmountNaira: plan.minAmountNaira,
    maxAmountNaira: plan.maxAmountNaira,
    tenureDays: plan.tenureDays,
    earningsBasis: plan.earningsBasis === "FLAT" ? "FLAT" : "PERCENTAGE",
    annualRatePercent: String(plan.annualRatePercent ?? 0),
    earningsFlatNaira: Number(plan.earningsFlatNaira ?? 0),
    earlyLiquidityAllowed: plan.earlyLiquidityAllowed,
    earlyLiquidityFeeBasis: flatLiquidity ? "FLAT" : "PERCENTAGE",
    earlyLiquidityFeePercent: String(plan.earlyLiquidityFeePercent ?? 0),
    earlyLiquidityFeeFlatNaira: Number(plan.earlyLiquidityFeeFlatNaira ?? 0),
    forfeitInterestOnEarlyExit: plan.forfeitInterestOnEarlyExit,
    gatewayFeeBasis: flatGateway ? "FLAT" : "PERCENTAGE",
    gatewayFeePercent: String(plan.gatewayFeePercent ?? 0),
    gatewayFeeFlatNaira: Number(plan.gatewayFeeFlatNaira ?? 0),
    capacityEnabled: capacity > 0,
    capacityNaira: capacity > 0 ? capacity : 100_000_000,
    isActive: plan.isActive,
    allowNewInvestmentsAfterClose: plan.allowNewInvestmentsAfterClose,
    effectiveToInput: isoToLocalInput(plan.effectiveTo),
  };
}

/** Percent draft input — allows "0.", "12.5" etc. without snapping while typing. */
function PercentInput({ value, onChange, suffix = "%" }: { value: string; onChange: (v: string) => void; suffix?: string }) {
  return (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        className="velo-input pr-8 text-sm font-semibold"
        value={value}
        onChange={(e) => {
          const cleaned = e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
          onChange(cleaned);
        }}
        onBlur={() => {
          const n = Number(value);
          onChange(Number.isFinite(n) && value !== "" ? String(Math.round(n * 100) / 100) : "0");
        }}
      />
      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400 select-none">{suffix}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export default function InvestmentPlansManager() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [seeding, setSeeding] = useState(false);

  // null = closed; "new" = create; plan id = edit
  const [editor, setEditor] = useState(null as null | "new" | string);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [rowBusyId, setRowBusyId] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState("");

  const editingPlan = useMemo(() => (editor && editor !== "new" ? plans.find((p) => p.id === editor) : undefined), [editor, plans]);

  async function load() {
    setLoading(true);
    setListError("");
    try {
      const res = await adminListInvestmentPlans();
      setPlans(res.plans ?? []);
    } catch (e: any) {
      setListError(e?.message || "Failed to load investment plans");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError("");
    setEditor("new");
  }

  function openEdit(plan: PlanRow) {
    setForm(formFromPlan(plan));
    setFormError("");
    setEditor(plan.id);
  }

  function closeEditor() {
    setEditor(null);
    setFormError("");
  }

  function validate(): string {
    if (form.name.trim().length < 2) return "Plan name must be at least 2 characters.";
    if (form.maxAmountNaira < form.minAmountNaira) return "Maximum amount must be greater than or equal to the minimum amount.";
    if (!Number.isInteger(form.tenureDays) || form.tenureDays <= 0) return "Tenure must be a whole number of days greater than zero.";
    if (form.earningsBasis === "FLAT" && form.earningsFlatNaira <= 0) return "A flat-earnings plan needs a fixed naira amount greater than zero.";
    if (form.earningsBasis === "PERCENTAGE" && !(Number(form.annualRatePercent) >= 0)) return "Enter a valid annual rate.";
    if (form.earlyLiquidityAllowed && form.earlyLiquidityFeeBasis === "PERCENTAGE" && !(Number(form.earlyLiquidityFeePercent) >= 0)) return "Enter a valid early-exit fee.";
    if (form.capacityEnabled && form.capacityNaira <= 0) return "Plan capacity must be greater than zero (or turn the cap off).";
    return "";
  }

  async function save() {
    const v = validate();
    if (v) {
      setFormError(v);
      return;
    }
    setSaving(true);
    setFormError("");
    const payloadBase = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      minAmountNaira: form.minAmountNaira,
      maxAmountNaira: form.maxAmountNaira,
      tenureDays: form.tenureDays,
      annualRatePercent: form.earningsBasis === "PERCENTAGE" ? Math.round(Number(form.annualRatePercent || 0) * 100) / 100 : 0,
      earningsBasis: form.earningsBasis,
      earningsFlatNaira: form.earningsBasis === "FLAT" ? form.earningsFlatNaira : undefined,
      earlyLiquidityAllowed: form.earlyLiquidityAllowed,
      earlyLiquidityFeePercent: form.earlyLiquidityAllowed && form.earlyLiquidityFeeBasis === "PERCENTAGE" ? Math.round(Number(form.earlyLiquidityFeePercent || 0) * 100) / 100 : 0,
      earlyLiquidityFeeBasis: form.earlyLiquidityFeeBasis,
      earlyLiquidityFeeFlatNaira: form.earlyLiquidityAllowed && form.earlyLiquidityFeeBasis === "FLAT" ? form.earlyLiquidityFeeFlatNaira : undefined,
      forfeitInterestOnEarlyExit: form.forfeitInterestOnEarlyExit,
      gatewayFeePercent: form.gatewayFeeBasis === "PERCENTAGE" ? Math.round(Number(form.gatewayFeePercent || 0) * 100) / 100 : 0,
      gatewayFeeBasis: form.gatewayFeeBasis,
      gatewayFeeFlatNaira: form.gatewayFeeBasis === "FLAT" ? form.gatewayFeeFlatNaira : undefined,
      capacityNaira: form.capacityEnabled ? form.capacityNaira : null,
      allowNewInvestmentsAfterClose: form.allowNewInvestmentsAfterClose,
      effectiveTo: localInputToIso(form.effectiveToInput),
      isActive: form.isActive,
    };
    try {
      if (editor === "new") {
        // CREATE: the POST schema requires plain values — strip the null
        // "clear" markers (they are only meaningful for PATCH).
        const createPayload: Record<string, unknown> = { ...payloadBase, description: payloadBase.description ?? undefined };
        for (const key of Object.keys(createPayload)) {
          if (createPayload[key] === null) delete createPayload[key];
        }
        const res = await adminCreateInvestmentPlan(createPayload as any);
        setNotice(`Plan "${res.plan.name}" created.`);
      } else if (editor) {
        const res = await adminPatchInvestmentPlan(editor, payloadBase as any);
        setNotice(`Plan "${res.plan.name}" saved (v${res.plan.version}).`);
      }
      closeEditor();
      await load();
    } catch (e: any) {
      setFormError(e?.message || "Failed to save the plan");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(plan: PlanRow) {
    setRowBusyId(plan.id);
    setNotice("");
    try {
      await adminPatchInvestmentPlan(plan.id, { isActive: !plan.isActive });
      setNotice(`"${plan.name}" ${plan.isActive ? "deactivated" : "activated"}.`);
      await load();
    } catch (e: any) {
      setListError(e?.message || "Failed to update the plan");
    } finally {
      setRowBusyId("");
    }
  }

  async function remove(plan: PlanRow) {
    setRowBusyId(plan.id);
    setListError("");
    try {
      await adminDeleteInvestmentPlan(plan.id);
      setNotice(`Plan "${plan.name}" deleted.`);
      setConfirmDeleteId("");
      await load();
    } catch (e: any) {
      setListError(e?.message || "Failed to delete the plan");
      setConfirmDeleteId("");
    } finally {
      setRowBusyId("");
    }
  }

  async function seedDefaults() {
    setSeeding(true);
    setListError("");
    try {
      const res = await adminSeedInvestmentPlans();
      setNotice(
        res.created.length
          ? `Loaded ${res.created.length} default plan${res.created.length === 1 ? "" : "s"}${res.skipped.length ? ` — skipped ${res.skipped.join(", ")} (already exist)` : ""}.`
          : `All default plans already exist${res.skipped.length ? `: ${res.skipped.join(", ")}` : ""}.`,
      );
      await load();
    } catch (e: any) {
      setListError(e?.message || "Failed to load default plans");
    } finally {
      setSeeding(false);
    }
  }

  const nowIso = new Date().toISOString();
  const activeCount = plans.filter((p) => p.isActive).length;

  /* ---------------------------------------------------------------- */

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-velo-900 dark:text-white">
            <Icon name="chart" size={18} /> Investment plans
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500 dark:bg-slate-800 dark:text-slate-300">{plans.length}</span>
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Create and configure every plan investors can invest in — this catalog is exactly what the investor dashboard shows.
            {activeCount > 0 && <span className="ml-1 font-semibold text-emerald-600 dark:text-emerald-400">{activeCount} active</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button onClick={seedDefaults} disabled={seeding} className="btn-secondary !py-2 !px-3.5 text-xs !font-bold">
            {seeding ? "Loading…" : <><Icon name="history" size={14} />Load default plans</>}
          </button>
          <button onClick={openCreate} className="btn-primary !py-2 !px-4 text-xs !font-bold">
            <><Icon name="sparkles" size={14} />New plan</>
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-700 animate-fade-in dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
          <Icon name="check" size={14} />{notice}
        </div>
      )}
      {listError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          <Icon name="alert" size={14} className="mt-0.5 shrink-0" />{listError}
        </div>
      )}

      {/* ---------------- plan cards ---------------- */}
      {loading ? (
        <div className="velo-card px-4 py-10 text-center text-sm font-semibold text-slate-400">Loading investment plans…</div>
      ) : plans.length === 0 ? (
        <div className="velo-card px-4 py-10 text-center">
          <p className="text-sm font-bold text-velo-900 dark:text-white">No investment plans yet</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">
            Investors see exactly what you configure here. Create your first plan, or load the default Velo plans (Flex 30 / Growth 90 / Max 180 / Prime 365) and tune them.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {plans.map((plan) => {
            const closed = isClosed(plan, nowIso);
            const remaining = plan.capacityNaira && plan.capacityNaira > 0 ? plan.remainingCapacityNaira : undefined;
            const fillPct = plan.capacityNaira && plan.capacityNaira > 0 ? Math.min(100, Math.round(((plan.capacityNaira - (remaining ?? 0)) / plan.capacityNaira) * 100)) : null;
            const busy = rowBusyId === plan.id;
            return (
              <div key={plan.id} className={`velo-card p-4 transition-opacity ${plan.isActive ? "" : "opacity-70"} ${busy ? "animate-pulse" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-bold text-velo-900 dark:text-white">{plan.name}</h3>
                      {plan.isActive ? <Pill tone="success">Active</Pill> : <Pill tone="neutral">Inactive</Pill>}
                      {plan.isActive && plan.acceptingInvestments === false && (
                        <Pill tone="warning">{closed && !plan.allowNewInvestmentsAfterClose ? "Closed" : remaining === 0 ? "Fully subscribed" : "Not accepting"}</Pill>
                      )}
                      {plan.earningsBasis === "FLAT" && <Pill tone="info">Flat earnings</Pill>}
                    </div>
                    {plan.description && <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{plan.description}</p>}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-base font-extrabold text-emerald-600 dark:text-emerald-400">{earningsLabel(plan)}</div>
                    <div className="text-[11px] font-semibold text-slate-400">{plan.tenureDays} days</div>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60">
                    <div className="text-slate-400">Min — Max</div>
                    <div className="mt-0.5 font-bold text-velo-900 dark:text-white">{naira(plan.minAmountNaira)} — {naira(plan.maxAmountNaira)}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60">
                    <div className="text-slate-400">Early exit</div>
                    <div className="mt-0.5 font-bold text-velo-900 dark:text-white">
                      {plan.earlyLiquidityAllowed ? `${feeLabel(plan.earlyLiquidityFeeBasis, plan.earlyLiquidityFeePercent, plan.earlyLiquidityFeeFlatNaira)} fee${plan.forfeitInterestOnEarlyExit ? " + forfeit interest" : ""}` : "Not allowed"}
                    </div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60">
                    <div className="text-slate-400">Gateway fee</div>
                    <div className="mt-0.5 font-bold text-velo-900 dark:text-white">{feeLabel(plan.gatewayFeeBasis, plan.gatewayFeePercent, plan.gatewayFeeFlatNaira)}</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 px-2.5 py-1.5 dark:bg-slate-800/60">
                    <div className="text-slate-400">Capacity</div>
                    <div className="mt-0.5 font-bold text-velo-900 dark:text-white">{plan.capacityNaira && plan.capacityNaira > 0 ? `${naira(remaining ?? 0)} left` : "Unlimited"}</div>
                  </div>
                </div>

                {fillPct !== null && (
                  <div className="mt-3">
                    <div className="flex justify-between text-[10px] font-semibold text-slate-400">
                      <span>Subscribed</span>
                      <span>{fillPct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className={`h-full rounded-full transition-all ${fillPct >= 100 ? "bg-red-500" : fillPct >= 80 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(2, fillPct)}%` }} />
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
                  <div className="flex items-center gap-2">
                    <Toggle checked={plan.isActive} onChange={() => void toggleActive(plan)} disabled={busy} size="sm" label={plan.isActive ? "Live" : "Off"} />
                    {plan.effectiveTo && <span className="text-[10px] font-semibold text-slate-400">until {new Date(plan.effectiveTo).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {confirmDeleteId === plan.id ? (
                      <>
                        <span className="text-[11px] font-bold text-red-600 dark:text-red-400">Delete plan?</span>
                        <button onClick={() => void remove(plan)} disabled={busy} className="rounded-lg bg-red-600 px-2.5 py-1.5 text-[11px] font-bold text-white hover:bg-red-700 disabled:opacity-50">Yes, delete</button>
                        <button onClick={() => setConfirmDeleteId("")} className="rounded-lg px-2 py-1.5 text-[11px] font-bold text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => openEdit(plan)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-velo-700 hover:bg-velo-50 dark:border-slate-700 dark:text-velo-300 dark:hover:bg-slate-800">Edit</button>
                        <button onClick={() => setConfirmDeleteId(plan.id)} disabled={busy} className="rounded-lg border border-red-200 px-2.5 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50 dark:border-red-900/60 dark:hover:bg-red-950/40">Delete</button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ---------------- editor modal ---------------- */}
      {editor && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/60 backdrop-blur-sm sm:items-center animate-fade-in" role="dialog" aria-modal="true">
          <button type="button" aria-label="Close editor" className="absolute inset-0 cursor-default" onClick={closeEditor} tabIndex={-1} />
          <div className="relative z-10 flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl dark:bg-slate-900 sm:rounded-3xl">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800">
              <div>
                <h3 className="text-base font-bold text-velo-900 dark:text-white">{editor === "new" ? "Create investment plan" : `Edit ${editingPlan?.name ?? "plan"}`}</h3>
                <p className="text-[11px] text-slate-400">Every parameter below is served to investors exactly as configured.</p>
              </div>
              <button type="button" onClick={closeEditor} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800" aria-label="Close">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
              {/* identity */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-velo-900 dark:text-white">Plan name</span>
                  <input className="velo-input text-sm font-semibold" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Velo Flex 30" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold text-velo-900 dark:text-white">Description <span className="font-normal text-slate-400">(shown to investors)</span></span>
                  <input className="velo-input text-sm" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short-term 30-day plan with competitive returns" />
                </label>
              </div>

              {/* amounts + tenure */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <NairaField compact label="Min investment (₦)" value={form.minAmountNaira} onChange={(n) => setForm({ ...form, minAmountNaira: n })} />
                <NairaField compact label="Max investment (₦)" value={form.maxAmountNaira} onChange={(n) => setForm({ ...form, maxAmountNaira: n })} />
                <label className="block">
                  <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Tenure (days)</span>
                  <input type="number" min={1} step={1} className="velo-input text-sm font-semibold" value={form.tenureDays} onChange={(e) => setForm({ ...form, tenureDays: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                </label>
              </div>

              {/* earnings */}
              <div className="rounded-2xl border border-emerald-100 bg-emerald-50/50 p-3.5 dark:border-emerald-900/40 dark:bg-emerald-950/20">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-velo-900 dark:text-velo-100">Investor earnings</span>
                  <Segmented<FeeBasisChoice>
                    size="sm"
                    value={form.earningsBasis}
                    onChange={(v) => setForm({ ...form, earningsBasis: v })}
                    options={[{ value: "PERCENTAGE", label: "Percent % p.a." }, { value: "FLAT", label: "Flat ₦ for tenure" }]}
                  />
                </div>
                {form.earningsBasis === "PERCENTAGE" ? (
                  <div>
                    <PercentInput value={form.annualRatePercent} onChange={(v) => setForm({ ...form, annualRatePercent: v })} />
                    <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">Annual rate on the invested amount, accrued daily and paid at maturity.</p>
                  </div>
                ) : (
                  <div>
                    <NairaField compact label="Fixed earnings (₦)" value={form.earningsFlatNaira} onChange={(n) => setForm({ ...form, earningsFlatNaira: n })} />
                    <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">The investor earns this fixed amount for the whole tenure regardless of how much they invest. Equivalent p.a. is shown to the platform automatically.</p>
                  </div>
                )}
              </div>

              {/* early liquidity */}
              <div className="rounded-2xl border border-slate-200 p-3.5 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-velo-900 dark:text-velo-100">Early liquidity (exit before maturity)</div>
                    <p className="text-[11px] text-slate-400">Whether investors can request their money back before the tenure ends.</p>
                  </div>
                  <Toggle checked={form.earlyLiquidityAllowed} onChange={(v) => setForm({ ...form, earlyLiquidityAllowed: v })} />
                </div>
                {form.earlyLiquidityAllowed && (
                  <div className="mt-3 space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <div className="mb-1.5 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-semibold text-velo-900 dark:text-white">Early-exit fee</span>
                          <Segmented<FeeBasisChoice>
                            size="sm"
                            value={form.earlyLiquidityFeeBasis}
                            onChange={(v) => setForm({ ...form, earlyLiquidityFeeBasis: v })}
                            options={[{ value: "PERCENTAGE", label: "%" }, { value: "FLAT", label: "₦" }]}
                          />
                        </div>
                        {form.earlyLiquidityFeeBasis === "PERCENTAGE"
                          ? <PercentInput value={form.earlyLiquidityFeePercent} onChange={(v) => setForm({ ...form, earlyLiquidityFeePercent: v })} />
                          : <NairaField compact label="" value={form.earlyLiquidityFeeFlatNaira} onChange={(n) => setForm({ ...form, earlyLiquidityFeeFlatNaira: n })} />}
                      </div>
                      <div className="flex items-end pb-1">
                        <Toggle checked={form.forfeitInterestOnEarlyExit} onChange={(v) => setForm({ ...form, forfeitInterestOnEarlyExit: v })} label="Forfeit accrued interest on early exit" />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* gateway fee */}
              <div className="rounded-2xl border border-slate-200 p-3.5 dark:border-slate-700">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-velo-900 dark:text-velo-100">Gateway fee</div>
                    <p className="text-[11px] text-slate-400">Charged when an investment is created under this plan.</p>
                  </div>
                  <Segmented<FeeBasisChoice>
                    size="sm"
                    value={form.gatewayFeeBasis}
                    onChange={(v) => setForm({ ...form, gatewayFeeBasis: v })}
                    options={[{ value: "PERCENTAGE", label: "%" }, { value: "FLAT", label: "₦" }]}
                  />
                </div>
                {form.gatewayFeeBasis === "PERCENTAGE"
                  ? <PercentInput value={form.gatewayFeePercent} onChange={(v) => setForm({ ...form, gatewayFeePercent: v })} />
                  : <NairaField compact label="" value={form.gatewayFeeFlatNaira} onChange={(n) => setForm({ ...form, gatewayFeeFlatNaira: n })} />}
              </div>

              {/* capacity */}
              <div className="rounded-2xl border border-slate-200 p-3.5 dark:border-slate-700">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-velo-900 dark:text-velo-100">Plan capacity (₦)</div>
                    <p className="text-[11px] text-slate-400">Cap the total naira this plan accepts across all investors. New investments beyond the remaining room are rejected.</p>
                  </div>
                  <Toggle checked={form.capacityEnabled} onChange={(v) => setForm({ ...form, capacityEnabled: v })} />
                </div>
                {form.capacityEnabled && (
                  <div className="mt-3">
                    <NairaField compact label="Total capacity (₦)" value={form.capacityNaira} onChange={(n) => setForm({ ...form, capacityNaira: n })} />
                  </div>
                )}
              </div>

              {/* availability */}
              <div className="rounded-2xl border border-slate-200 p-3.5 dark:border-slate-700">
                <div className="text-xs font-bold text-velo-900 dark:text-velo-100">Availability</div>
                <div className="mt-2.5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Plan is live — visible to investors</span>
                    <Toggle checked={form.isActive} onChange={(v) => setForm({ ...form, isActive: v })} />
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">Allow investments after close</span>
                      <p className="text-[10px] text-slate-400">Keep accepting investments even after the end date below passes.</p>
                    </div>
                    <Toggle checked={form.allowNewInvestmentsAfterClose} onChange={(v) => setForm({ ...form, allowNewInvestmentsAfterClose: v })} />
                  </div>
                  <label className="block">
                    <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Open until <span className="font-normal text-slate-400">(optional end date)</span></span>
                    <input type="datetime-local" className="velo-input text-sm font-semibold" value={form.effectiveToInput} onChange={(e) => setForm({ ...form, effectiveToInput: e.target.value })} />
                  </label>
                </div>
              </div>

              {formError && (
                <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                  <Icon name="alert" size={14} className="mt-0.5 shrink-0" />{formError}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3.5 dark:border-slate-800">
              <button type="button" onClick={closeEditor} className="btn-secondary !py-2.5 !px-4 text-sm">Cancel</button>
              <button type="button" onClick={() => void save()} disabled={saving} className="btn-primary !py-2.5 !px-5 text-sm !font-bold">
                {saving ? "Saving…" : editor === "new" ? "Create plan" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
