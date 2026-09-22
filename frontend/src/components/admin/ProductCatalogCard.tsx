// ============================================================================
// src/components/admin/ProductCatalogCard.tsx
// "Loan product catalog" — EVERY product fully editable.
//
// Replaces the old view-only catalog list. The admin can now edit ALL loan
// products (not just the two application-flow programs), including:
//   name, description, min/max amount, default tenure, interest rate,
//   interest type (SIMPLE_FLAT / REDUCING_BALANCE / ANNUALIZED),
//   processing fee, late fee, late fee type (ONE_TIME / COMPOUNDING_DAILY /
//   COMPOUNDING_MONTHLY), grace period and active state.
//
// Each product saves INDEPENDENTLY (PATCH /admin/loan-products/:id) with its
// own saving/error state, so one bad product can never block the others.
// New products can be added inline (POST /admin/loan-products).
// ============================================================================

import { useEffect, useState } from "react";
import {
  adminListLoanProducts,
  adminCreateLoanProduct,
  adminPatchLoanProduct,
  type LoanProduct,
} from "../../services/apiClient";
import { safeNaira } from "../../utils/config";
import { formatNaira } from "../../utils/loanCalculator";
import Icon from "../Icon";
import { Pill, Toggle, NairaField, PanelCard } from "./settingsUI";

type InterestType = LoanProduct["interestType"];
type LateFeeType = LoanProduct["lateFeeType"];

const INTEREST_TYPE_OPTIONS: Array<{ value: InterestType; label: string; hint: string }> = [
  { value: "SIMPLE_FLAT", label: "Simple flat", hint: "Percent of the principal per 30-day month, prorated over the tenure." },
  { value: "ANNUALIZED", label: "Annualized", hint: "Yearly rate prorated over the selected tenure." },
  { value: "REDUCING_BALANCE", label: "Reducing balance", hint: "Percent charged monthly on the outstanding balance." },
];

const LATE_FEE_TYPE_OPTIONS: Array<{ value: LateFeeType; label: string }> = [
  { value: "ONE_TIME", label: "One time" },
  { value: "COMPOUNDING_DAILY", label: "Daily comp." },
  { value: "COMPOUNDING_MONTHLY", label: "Monthly comp." },
];

const TENURE_PRESETS = [30, 60, 90, 180, 365];

interface ProductDraft {
  name: string;
  description: string;
  minAmountNaira: number;
  maxAmountNaira: number;
  defaultTenureDays: number;
  interestRatePercent: string;
  interestType: InterestType;
  processingFeePercent: string;
  lateFeePercent: string;
  lateFeeType: LateFeeType;
  gracePeriodDays: number;
  isActive: boolean;
}

function draftFromProduct(product: LoanProduct): ProductDraft {
  return {
    name: product.name,
    description: product.description ?? "",
    minAmountNaira: Number(product.minAmountNaira) || 0,
    maxAmountNaira: Number(product.maxAmountNaira) || 0,
    defaultTenureDays: Number(product.defaultTenureDays ?? 30) || 30,
    interestRatePercent: String(product.interestRatePercent ?? 0),
    interestType: product.interestType ?? "SIMPLE_FLAT",
    processingFeePercent: String(product.processingFeePercent ?? 0),
    lateFeePercent: String(product.lateFeePercent ?? 0),
    lateFeeType: product.lateFeeType ?? "COMPOUNDING_DAILY",
    gracePeriodDays: Number(product.gracePeriodDays ?? 0) || 0,
    isActive: Boolean(product.isActive),
  };
}

function emptyDraft(): ProductDraft {
  return {
    name: "",
    description: "",
    minAmountNaira: 100000,
    maxAmountNaira: 3000000,
    defaultTenureDays: 90,
    interestRatePercent: "5",
    interestType: "ANNUALIZED",
    processingFeePercent: "2",
    lateFeePercent: "1",
    lateFeeType: "COMPOUNDING_DAILY",
    gracePeriodDays: 3,
    isActive: true,
  };
}

function validateDraft(draft: ProductDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name || draft.name.trim().length < 2) errors.name = "Product name is required (at least 2 characters).";
  const min = Number(draft.minAmountNaira);
  const max = Number(draft.maxAmountNaira);
  if (!Number.isFinite(min) || min <= 0) errors.minAmountNaira = "Minimum amount must be a positive number.";
  if (!Number.isFinite(max) || max <= 0) errors.maxAmountNaira = "Maximum amount must be a positive number.";
  if (!errors.minAmountNaira && !errors.maxAmountNaira && min >= max) errors.minAmountNaira = "Minimum must be less than maximum.";
  if (!Number.isFinite(Number(draft.defaultTenureDays)) || Number(draft.defaultTenureDays) < 1) errors.defaultTenureDays = "Default tenure must be at least 1 day.";
  const percentFields: Array<[string, string]> = [
    ["interestRatePercent", "Interest rate"],
    ["processingFeePercent", "Processing fee"],
    ["lateFeePercent", "Late fee"],
  ];
  for (const [key, label] of percentFields) {
    const value = Number(draft[key as "interestRatePercent"]);
    if (!Number.isFinite(value) || value < 0) errors[key] = `${label} cannot be negative.`;
    else if (value > 100) errors[key] = `${label} cannot exceed 100%.`;
  }
  if (!Number.isFinite(Number(draft.gracePeriodDays)) || Number(draft.gracePeriodDays) < 0) errors.gracePeriodDays = "Grace period cannot be negative.";
  return errors;
}

function buildPayload(draft: ProductDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    minAmountNaira: Number(draft.minAmountNaira),
    maxAmountNaira: Number(draft.maxAmountNaira),
    defaultTenureDays: Number(draft.defaultTenureDays),
    interestRatePercent: Number(draft.interestRatePercent),
    interestType: draft.interestType,
    processingFeePercent: Number(draft.processingFeePercent),
    lateFeePercent: Number(draft.lateFeePercent),
    lateFeeType: draft.lateFeeType,
    gracePeriodDays: Number(draft.gracePeriodDays),
    isActive: draft.isActive,
  };
}

/** Decimal-safe percent input (typing "0.", "0.5", "12.75" never snaps back). */
function PercentField({ label, value, onChange, helpText }: { label: string; value: string; onChange: (next: string) => void; helpText?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-bold text-velo-900 dark:text-white">{label}</span>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => {
            const cleaned = e.target.value.replace(/[^\d.]/g, "");
            const firstDot = cleaned.indexOf(".");
            const normalized = firstDot >= 0
              ? cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "")
              : cleaned;
            onChange(normalized);
          }}
          onBlur={() => {
            const n = Number(value);
            onChange(Number.isFinite(n) && value !== "" ? String(Math.round(n * 100) / 100) : "0");
          }}
          placeholder="0"
          className="velo-input !pr-8 text-sm font-bold"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-black text-slate-400 select-none">%</span>
      </div>
      {helpText && <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{helpText}</div>}
    </label>
  );
}

function SegmentedOptions<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (next: T) => void }) {
  return (
    <div className="grid gap-0.5 rounded-xl bg-slate-100 p-1 dark:bg-slate-800" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`rounded-lg px-2 py-1.5 text-[11px] font-bold transition-all duration-150 ${
            value === opt.value
              ? "bg-white text-velo-700 shadow-sm dark:bg-slate-900 dark:text-velo-300"
              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ProductEditor({
  draft,
  onDraftChange,
  errors,
}: {
  draft: ProductDraft;
  onDraftChange: (patch: Partial<ProductDraft>) => void;
  errors: Record<string, string>;
}) {
  const interestHint = INTEREST_TYPE_OPTIONS.find((o) => o.value === draft.interestType)?.hint;
  return (
    <div className="space-y-4 rounded-xl border border-velo-100 bg-velo-50/40 p-4 dark:border-velo-800 dark:bg-velo-900/10">
      {/* Identity */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-velo-900 dark:text-white">Product name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onDraftChange({ name: e.target.value })}
            placeholder="e.g. Personal Loan"
            className={`velo-input text-sm font-bold ${errors.name ? "velo-input-error" : ""}`}
          />
          {errors.name && <p className="velo-error-text">{errors.name}</p>}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-bold text-velo-900 dark:text-white">Description (optional)</span>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => onDraftChange({ description: e.target.value })}
            placeholder="Shown to borrowers on the product card"
            className="velo-input text-sm"
          />
        </label>
      </div>

      {/* Amounts */}
      <div>
        <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Amount limits</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <NairaField compact label="Minimum" value={draft.minAmountNaira} onChange={(n) => onDraftChange({ minAmountNaira: n })} />
            {errors.minAmountNaira && <p className="velo-error-text">{errors.minAmountNaira}</p>}
          </div>
          <div>
            <NairaField compact label="Maximum" value={draft.maxAmountNaira} onChange={(n) => onDraftChange({ maxAmountNaira: n })} />
            {errors.maxAmountNaira && <p className="velo-error-text">{errors.maxAmountNaira}</p>}
          </div>
          <div>
            <NairaField compact label="Default tenure (days)" value={draft.defaultTenureDays} onChange={(n) => onDraftChange({ defaultTenureDays: n })} />
            {errors.defaultTenureDays && <p className="velo-error-text">{errors.defaultTenureDays}</p>}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {TENURE_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => onDraftChange({ defaultTenureDays: days })}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-bold transition ${
                Number(draft.defaultTenureDays) === days
                  ? "border-velo-500 bg-velo-500 text-white"
                  : "border-slate-200 bg-white text-slate-500 hover:border-velo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
              }`}
            >
              {days}d
            </button>
          ))}
        </div>
      </div>

      {/* Interest */}
      <div>
        <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Interest</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <PercentField label="Interest rate" value={draft.interestRatePercent} onChange={(v) => onDraftChange({ interestRatePercent: v })} />
          <div>
            <span className="mb-1.5 block text-[11px] font-bold text-velo-900 dark:text-white">Interest type</span>
            <SegmentedOptions value={draft.interestType} options={INTEREST_TYPE_OPTIONS.map(({ value, label }) => ({ value, label }))} onChange={(v) => onDraftChange({ interestType: v })} />
            {interestHint && <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{interestHint}</div>}
          </div>
        </div>
        {errors.interestRatePercent && <p className="velo-error-text">{errors.interestRatePercent}</p>}
      </div>

      {/* Fees */}
      <div>
        <div className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400 dark:text-slate-500">Fees</div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <PercentField label="Processing fee" value={draft.processingFeePercent} onChange={(v) => onDraftChange({ processingFeePercent: v })} />
            {errors.processingFeePercent && <p className="velo-error-text">{errors.processingFeePercent}</p>}
          </div>
          <div>
            <PercentField label="Late fee" value={draft.lateFeePercent} onChange={(v) => onDraftChange({ lateFeePercent: v })} />
            {errors.lateFeePercent && <p className="velo-error-text">{errors.lateFeePercent}</p>}
          </div>
          <div>
            <span className="mb-1.5 block text-[11px] font-bold text-velo-900 dark:text-white">Late fee type</span>
            <SegmentedOptions value={draft.lateFeeType} options={LATE_FEE_TYPE_OPTIONS} onChange={(v) => onDraftChange({ lateFeeType: v })} />
          </div>
        </div>
      </div>

      {/* Grace period + active */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
        <div>
          <NairaField compact label="Grace period (days)" value={draft.gracePeriodDays} onChange={(n) => onDraftChange({ gracePeriodDays: n })} />
          {errors.gracePeriodDays && <p className="velo-error-text">{errors.gracePeriodDays}</p>}
        </div>
        <div className="flex items-center gap-3 sm:col-span-2 sm:justify-end sm:pt-4">
          <Toggle checked={draft.isActive} onChange={(on) => onDraftChange({ isActive: on })} label={draft.isActive ? "Active — visible to borrowers" : "Inactive — hidden from borrowers"} />
        </div>
      </div>
    </div>
  );
}

export default function ProductCatalogCard({ refreshSignal = 0, onCatalogChanged }: { refreshSignal?: number; onCatalogChanged?: () => void }) {
  const [catalog, setCatalog] = useState<LoanProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null); // product id | "new"
  const [draft, setDraft] = useState<ProductDraft>(emptyDraft);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [activatingAll, setActivatingAll] = useState(false);

  const activeCount = catalog.filter((p) => p.isActive).length;
  const allInactive = catalog.length > 0 && activeCount === 0;

  async function refresh(): Promise<void> {
    try {
      const response = await adminListLoanProducts();
      setCatalog(response.products ?? []);
      setLoadError("");
    } catch (e: any) {
      setLoadError(e?.message || "Failed to load loan products");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [refreshSignal]);

  function startEdit(product: LoanProduct) {
    setActionError("");
    setDraftErrors({});
    setEditingId(product.id);
    setDraft(draftFromProduct(product));
  }

  function startCreate() {
    setActionError("");
    setDraftErrors({});
    setEditingId("new");
    setDraft(emptyDraft());
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftErrors({});
    setActionError("");
  }

  async function saveEdit() {
    const errors = validateDraft(draft);
    setDraftErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const payload = buildPayload(draft);
    setSavingId(editingId);
    setActionError("");
    try {
      if (editingId === "new") {
        await adminCreateLoanProduct(payload);
      } else if (editingId) {
        await adminPatchLoanProduct(editingId, payload);
      }
      setEditingId(null);
      await refresh();
      onCatalogChanged?.();
    } catch (e: any) {
      const flat = e?.message ? e.message : "Save failed — please retry.";
      setActionError(flat);
    } finally {
      setSavingId(null);
    }
  }

  async function toggleActive(product: LoanProduct, nextActive: boolean) {
    setTogglingId(product.id);
    const previous = catalog;
    setCatalog((current) => current.map((p) => (p.id === product.id ? { ...p, isActive: nextActive } : p)));
    try {
      const updated = await adminPatchLoanProduct(product.id, { isActive: nextActive });
      setCatalog((current) => current.map((p) => (p.id === product.id ? updated.product : p)));
      onCatalogChanged?.();
    } catch (e: any) {
      setCatalog(previous);
      setActionError(`Could not ${nextActive ? "activate" : "deactivate"} "${product.name}": ${e?.message || "unknown error"}`);
    } finally {
      setTogglingId(null);
    }
  }

  // One-click recovery for the "everything is inactive" misconfiguration —
  // that state used to silently brick the borrower application funnel.
  async function activateAll() {
    const inactive = catalog.filter((p) => !p.isActive);
    if (inactive.length === 0) return;
    setActivatingAll(true);
    setActionError("");
    let failures = 0;
    for (const product of inactive) {
      try {
        const updated = await adminPatchLoanProduct(product.id, { isActive: true });
        setCatalog((current) => current.map((p) => (p.id === product.id ? updated.product : p)));
      } catch {
        failures += 1;
      }
    }
    setActivatingAll(false);
    if (failures > 0) {
      setActionError(`Activated ${inactive.length - failures} of ${inactive.length} products — ${failures} failed, please retry.`);
    }
    onCatalogChanged?.();
  }

  return (
    <PanelCard
      title="Loan product catalog"
      description="Every loan product on the platform — fully editable. Borrowers only see ACTIVE products, mapped strictly by the product type they select."
      icon={<Icon name="bank" size={18} />}
      action={
        <div className="flex items-center gap-2">
          <Pill tone={catalog.length > 0 && activeCount === 0 ? "warning" : "info"}>{loading ? "…" : `${activeCount}/${catalog.length} active`}</Pill>
          <button
            type="button"
            onClick={startCreate}
            disabled={editingId === "new"}
            className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-3 py-2 text-[11px] font-black text-white shadow transition hover:bg-velo-600 disabled:opacity-50"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
            Add product
          </button>
        </div>
      }
    >
      <div className="space-y-3 py-2">
        {loadError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{loadError}</p>
        )}
        {actionError && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">{actionError}</p>
        )}

        {allInactive && editingId !== "new" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 dark:border-amber-700/60 dark:bg-amber-900/20">
            <div className="min-w-0">
              <p className="text-sm font-bold text-amber-800 dark:text-amber-200">No active loan products</p>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300/80">Borrowers cannot see or select any loan product right now. Activate at least one product to reopen applications.</p>
            </div>
            <button
              type="button"
              onClick={() => void activateAll()}
              disabled={activatingAll}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-[11px] font-black text-white shadow transition hover:bg-amber-600 disabled:opacity-60"
            >
              {activatingAll ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Activating…</> : "Activate all"}
            </button>
          </div>
        )}

        {/* Inline creation editor */}
        {editingId === "new" && (
          <div className="rounded-xl border-2 border-dashed border-velo-300 bg-white p-4 dark:border-velo-700 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-black text-velo-900 dark:text-white">New loan product</p>
              <Pill tone="info">Draft</Pill>
            </div>
            <ProductEditor draft={draft} onDraftChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} errors={draftErrors} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={cancelEdit} className="rounded-xl px-4 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={savingId !== null}
                className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-4 py-2 text-xs font-black text-white shadow transition hover:bg-velo-600 disabled:opacity-60"
              >
                {savingId !== null ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Creating…</> : "Create product"}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="velo-helper py-4 text-center">Loading loan products…</p>
        ) : catalog.length === 0 && editingId !== "new" ? (
          <p className="velo-helper py-4 text-center">No loan products yet — click “Add product” to create the first one, or save a program below.</p>
        ) : (
          catalog.map((product) => {
            const editing = editingId === product.id;
            return (
              <div
                key={product.id}
                className={`rounded-xl border p-4 transition ${product.isActive
                  ? "border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900"
                  : "border-dashed border-slate-300 bg-slate-50 dark:border-slate-600 dark:bg-slate-900/60"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-slate-900 dark:text-white">{product.name}</p>
                      <Pill tone={product.isActive ? "success" : "warning"}>{product.isActive ? "Active" : "Inactive"}</Pill>
                      <Pill tone="neutral">v{product.version}</Pill>
                    </div>
                    {product.description && (
                      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{product.description}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {!editing && (
                      <button
                        type="button"
                        onClick={() => startEdit(product)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-black text-velo-700 transition hover:border-velo-300 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-velo-300 dark:hover:border-velo-700 dark:hover:bg-slate-800"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                        Edit
                      </button>
                    )}
                    <Toggle
                      checked={product.isActive}
                      disabled={togglingId === product.id || editing}
                      onChange={(value) => void toggleActive(product, value)}
                      label={product.isActive ? "Active" : "Inactive"}
                    />
                  </div>
                </div>

                {!editing && (
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                    <span>Range: <span className="font-semibold text-slate-700 dark:text-slate-200">₦{safeNaira(product.minAmountNaira)} – ₦{safeNaira(product.maxAmountNaira)}</span></span>
                    <span>Interest: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.interestRatePercent}% {String(product.interestType ?? "").toLowerCase().replace(/_/g, " ")}</span></span>
                    <span>Tenure: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.defaultTenureDays ?? "—"} days</span></span>
                    <span>Processing: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.processingFeePercent}%</span></span>
                    <span>Late fee: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.lateFeePercent}% {String(product.lateFeeType ?? "").toLowerCase().replace(/_/g, " ")}</span></span>
                    <span>Grace: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.gracePeriodDays ?? "—"}d</span></span>
                  </div>
                )}

                {editing && (
                  <div className="mt-3">
                    <ProductEditor draft={draft} onDraftChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} errors={draftErrors} />
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[11px] text-slate-400 dark:text-slate-500">
                        Current range {formatNaira(product.minAmountNaira)} – {formatNaira(product.maxAmountNaira)} · v{product.version}
                      </p>
                      <div className="flex gap-2">
                        <button type="button" onClick={cancelEdit} className="rounded-xl px-4 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={savingId !== null}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-4 py-2 text-xs font-black text-white shadow transition hover:bg-velo-600 disabled:opacity-60"
                        >
                          {savingId !== null ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Saving…</> : "Save changes"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </PanelCard>
  );
}
