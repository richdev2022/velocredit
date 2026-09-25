// ============================================================================
// src/components/admin/ProductCatalogCard.tsx
// "Loan product catalog" — THE single source of truth for loan configuration.
//
// Every product carries its COMPLETE configuration (nothing scattered across
// "global" tabs or per-browser localStorage anymore):
//   identity   — name, description, explicit TYPE (Personal/Business/Serves both)
//   amounts    — min, max AND default application amount
//   tenures    — the exact tenor list borrowers can pick from + default tenor
//   interest   — rate + type (SIMPLE_FLAT / REDUCING_BALANCE / ANNUALIZED)
//                PLUS the per-tenor MONTHLY interest matrix with per-tenor
//                availability (Available / Locked / Hot)
//   fees       — processing fee, service fee, late fee + late fee type
//   rules      — grace period, collateral shown / required, active state
//
// Products save INDEPENDENTLY (PATCH /admin/loan-products/:id) with their own
// saving/error state, so one bad product can never block the others.
// New products can be added inline (POST /admin/loan-products).
// ============================================================================

import { useEffect, useState } from "react";
import {
  adminListLoanProducts,
  adminCreateLoanProduct,
  adminPatchLoanProduct,
  type LoanProduct,
} from "../../services/apiClient";
import { safeNaira, tenorDurationLabel } from "../../utils/config";
import { formatNaira } from "../../utils/loanCalculator";
import Icon from "../Icon";
import { Pill, Toggle, NairaField, PanelCard } from "./settingsUI";

type InterestType = LoanProduct["interestType"];
type LateFeeType = LoanProduct["lateFeeType"];
type ProgramType = NonNullable<LoanProduct["programType"]>;
type TenorStatus = NonNullable<LoanProduct["tenorInterestRates"]>[number]["status"];

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

const PROGRAM_TYPE_OPTIONS: Array<{ value: ProgramType; label: string; hint: string }> = [
  { value: "PERSONAL", label: "Personal", hint: "Serves the Personal Loan application flow." },
  { value: "BUSINESS", label: "Business", hint: "Serves the Business Loan application flow." },
  { value: "BOTH", label: "Both flows", hint: "One product serves Personal AND Business applicants." },
];

const TENURE_PRESETS = [7, 14, 30, 60, 90, 91, 120, 180, 270, 360, 365];

const TENOR_STATUS_OPTIONS: Array<{ value: Exclude<TenorStatus, undefined>; label: string; hint: string }> = [
  { value: "AVAILABLE", label: "Available", hint: "Selectable — rate shown." },
  { value: "LOCKED", label: "Locked", hint: "Visible teaser — NOT selectable, rate hidden." },
  { value: "HOT", label: "Hot", hint: "Selectable with a Hot badge (marketing highlight)." },
];

/** The owner-seeded default pricing table ("Load default" preset). */
const DEFAULT_PRESET = {
  tenures: [30, 60, 91, 180, 360],
  tenorRates: { 30: "18.9", 60: "17.1", 91: "15.9", 180: "10.5", 360: "8.7" } as Record<number, string>,
  tenorStatuses: { 30: "AVAILABLE", 60: "AVAILABLE", 91: "LOCKED", 180: "AVAILABLE", 360: "HOT" } as Record<number, TenorStatus>,
};

interface ProductDraft {
  name: string;
  description: string;
  programType: ProgramType;
  minAmountNaira: number;
  maxAmountNaira: number;
  defaultAmountNaira: number;
  tenures: number[];
  defaultTenureDays: number;
  interestRatePercent: string;
  interestType: InterestType;
  /** Per-tenor MONTHLY interest rates: tenor days -> "" (unset, base rate) or rate string. */
  tenorRates: Record<number, string>;
  /** Per-tenor availability: tenor days -> AVAILABLE / LOCKED / HOT. */
  tenorStatuses: Record<number, TenorStatus>;
  processingFeePercent: string;
  serviceFeePercent: string;
  lateFeePercent: string;
  lateFeeType: LateFeeType;
  gracePeriodDays: number;
  collateralEnabled: boolean;
  collateralRequired: boolean;
  isActive: boolean;
}

function draftFromProduct(product: LoanProduct): ProductDraft {
  const tenures = Array.isArray(product.tenureDays) && product.tenureDays.length > 0
    ? [...product.tenureDays].sort((a, b) => a - b)
    : [];
  const defaultTenure = Number(product.defaultTenureDays ?? 30) || 30;
  const tenorRates: Record<number, string> = {};
  const tenorStatuses: Record<number, TenorStatus> = {};
  if (Array.isArray(product.tenorInterestRates)) {
    for (const entry of product.tenorInterestRates) {
      const days = Number(entry?.tenorDays);
      const rate = Number(entry?.monthlyRatePercent);
      if (Number.isFinite(days) && days > 0 && Number.isFinite(rate) && rate >= 0) tenorRates[days] = String(rate);
      tenorStatuses[days] = (entry?.status ?? "AVAILABLE") as TenorStatus;
    }
  }
  return {
    name: product.name,
    description: product.description ?? "",
    programType: product.programType ?? "PERSONAL",
    minAmountNaira: Number(product.minAmountNaira) || 0,
    maxAmountNaira: Number(product.maxAmountNaira) || 0,
    defaultAmountNaira: Number(product.defaultAmountNaira ?? 0) || 0,
    tenures,
    defaultTenureDays: defaultTenure,
    interestRatePercent: String(product.interestRatePercent ?? 0),
    interestType: product.interestType ?? "SIMPLE_FLAT",
    tenorRates,
    tenorStatuses,
    processingFeePercent: String(product.processingFeePercent ?? 0),
    serviceFeePercent: String(product.serviceFeePercent ?? 0),
    lateFeePercent: String(product.lateFeePercent ?? 0),
    lateFeeType: product.lateFeeType ?? "COMPOUNDING_DAILY",
    gracePeriodDays: Number(product.gracePeriodDays ?? 0) || 0,
    collateralEnabled: product.collateralEnabled ?? true,
    collateralRequired: product.collateralRequired ?? false,
    isActive: Boolean(product.isActive),
  };
}

function emptyDraft(): ProductDraft {
  return {
    name: "",
    description: "",
    programType: "PERSONAL",
    minAmountNaira: 100000,
    maxAmountNaira: 30000000,
    defaultAmountNaira: 100000,
    tenures: [...DEFAULT_PRESET.tenures],
    defaultTenureDays: 30,
    interestRatePercent: "18.9",
    interestType: "SIMPLE_FLAT",
    // Owner-seeded default pricing table ("Load default" preset).
    tenorRates: { ...DEFAULT_PRESET.tenorRates },
    tenorStatuses: { ...DEFAULT_PRESET.tenorStatuses },
    processingFeePercent: "2",
    serviceFeePercent: "0",
    lateFeePercent: "1",
    lateFeeType: "COMPOUNDING_DAILY",
    gracePeriodDays: 3,
    collateralEnabled: true,
    collateralRequired: false,
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
  const defaultAmount = Number(draft.defaultAmountNaira);
  if (!Number.isFinite(defaultAmount) || defaultAmount < 0) {
    errors.defaultAmountNaira = "Default amount must be a valid number.";
  } else if (defaultAmount > 0 && Number.isFinite(min) && Number.isFinite(max) && min < max && (defaultAmount < min || defaultAmount > max)) {
    errors.defaultAmountNaira = "Default amount must fall within the min/max range.";
  }
  if (draft.tenures.length === 0) errors.tenures = "Select at least one repayment tenure.";
  if (!Number.isFinite(Number(draft.defaultTenureDays)) || Number(draft.defaultTenureDays) < 1) {
    errors.defaultTenureDays = "Default tenure must be at least 1 day.";
  } else if (draft.tenures.length > 0 && !draft.tenures.includes(Number(draft.defaultTenureDays))) {
    errors.defaultTenureDays = "Default tenure must be one of the selected tenures.";
  } else if (draft.tenures.length > 0 && (draft.tenorStatuses[Number(draft.defaultTenureDays)] ?? "AVAILABLE") === "LOCKED") {
    errors.defaultTenureDays = "Default tenure is LOCKED — borrowers can never select it. Pick an available tenor or unlock this one.";
  }
  const percentFields: Array<[string, string]> = [
    ["interestRatePercent", "Interest rate"],
    ["processingFeePercent", "Processing fee"],
    ["serviceFeePercent", "Service fee"],
    ["lateFeePercent", "Late fee"],
  ];
  for (const [key, label] of percentFields) {
    const value = Number(draft[key as "interestRatePercent"]);
    if (!Number.isFinite(value) || value < 0) errors[key] = `${label} cannot be negative.`;
    else if (value > 100) errors[key] = `${label} cannot exceed 100%.`;
  }
  // Per-tenor monthly rates: every filled entry must be a valid percent.
  for (const [days, raw] of Object.entries(draft.tenorRates)) {
    if (raw === undefined || raw.trim() === "") continue;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) errors.tenorRates = `Monthly rate for ${days} days must be a valid number.`;
    else if (value > 100) errors.tenorRates = `Monthly rate for ${days} days cannot exceed 100%.`;
  }
  // A LOCKED tenor MUST carry its own rate: with no entry the tenor would
  // silently fall back to AVAILABLE + base-rate pricing for borrowers.
  for (const [days, status] of Object.entries(draft.tenorStatuses)) {
    if (status !== "LOCKED") continue;
    const raw = draft.tenorRates[Number(days)];
    if (raw === undefined || String(raw).trim() === "") {
      errors.tenorRates = `Set a monthly rate for the locked ${days}-day tenor — it is hidden while locked but prices the tenor once unlocked.`;
    }
  }
  if (!Number.isFinite(Number(draft.gracePeriodDays)) || Number(draft.gracePeriodDays) < 0) errors.gracePeriodDays = "Grace period cannot be negative.";
  return errors;
}

function buildPayload(draft: ProductDraft) {
  // Per-tenor monthly rates + availability: keep only filled rate entries,
  // sorted by tenor; the status rides on every entry (default AVAILABLE).
  const tenorInterestRates = Object.entries(draft.tenorRates)
    .map(([days, raw]) => ({ tenorDays: Number(days), raw, status: (draft.tenorStatuses[Number(days)] ?? "AVAILABLE") as TenorStatus }))
    .filter(({ tenorDays, raw }) => Number.isFinite(tenorDays) && tenorDays > 0 && raw !== undefined && raw.trim() !== "")
    .map(({ tenorDays, raw, status }) => ({ tenorDays, monthlyRatePercent: Number(raw), status }))
    .sort((a, b) => a.tenorDays - b.tenorDays);
  return {
    name: draft.name.trim(),
    description: draft.description.trim() || undefined,
    programType: draft.programType,
    minAmountNaira: Number(draft.minAmountNaira),
    maxAmountNaira: Number(draft.maxAmountNaira),
    defaultAmountNaira: Number(draft.defaultAmountNaira) > 0 ? Number(draft.defaultAmountNaira) : undefined,
    defaultTenureDays: Number(draft.defaultTenureDays),
    tenureDays: [...draft.tenures].sort((a, b) => a - b),
    tenorInterestRates,
    interestRatePercent: Number(draft.interestRatePercent),
    interestType: draft.interestType,
    processingFeePercent: Number(draft.processingFeePercent),
    serviceFeePercent: Number(draft.serviceFeePercent),
    lateFeePercent: Number(draft.lateFeePercent),
    lateFeeType: draft.lateFeeType,
    gracePeriodDays: Number(draft.gracePeriodDays),
    collateralEnabled: draft.collateralEnabled,
    collateralRequired: draft.collateralEnabled && draft.collateralRequired,
    isActive: draft.isActive,
  };
}

/** Decimal-safe percent input (typing "0.", "0.5", "12.75" never snaps back). */
function PercentField({ label, value, onChange, helpText }: { label: string; value: string; onChange: (next: string) => void; helpText?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">{label}</span>
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
          className="velo-input !pr-8 text-sm font-semibold"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400 select-none">%</span>
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
          className={`rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-all duration-150 ${
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">{children}</div>;
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
  const programHint = PROGRAM_TYPE_OPTIONS.find((o) => o.value === draft.programType)?.hint;
  const tenures = [...draft.tenures].sort((a, b) => a - b);
  const [customTenorInput, setCustomTenorInput] = useState("");
  const [customTenorError, setCustomTenorError] = useState("");

  /** Remove a tenor AND its rate/status entries; keep the default tenure valid. */
  function removeTenor(days: number) {
    const selected = draft.tenures.filter((t) => t !== days);
    const { [days]: _rate, ...restRates } = draft.tenorRates;
    const { [days]: _status, ...restStatuses } = draft.tenorStatuses;
    onDraftChange({
      tenures: selected,
      tenorRates: restRates,
      tenorStatuses: restStatuses,
      // Keep the default tenure valid as the list changes.
      ...(selected.length > 0 && !selected.includes(Number(draft.defaultTenureDays))
        ? { defaultTenureDays: [...selected].sort((a, b) => a - b)[0] }
        : {}),
    });
  }

  /** Add a tenor (1–3650 days, deduped); its rate starts at the base rate. */
  function addTenor(days: number) {
    const value = Math.trunc(Number(days));
    if (!Number.isFinite(value) || value < 1 || value > 3650) {
      setCustomTenorError("Tenor must be between 1 and 3650 days.");
      return;
    }
    if (draft.tenures.includes(value)) {
      setCustomTenorError(`${value} days is already on the tenor list.`);
      return;
    }
    setCustomTenorError("");
    setCustomTenorInput("");
    onDraftChange({
      tenures: [...draft.tenures, value].sort((a, b) => a - b),
      tenorRates: { ...draft.tenorRates, [value]: draft.interestRatePercent || "" },
    });
  }

  function commitCustomTenor() {
    if (customTenorInput.trim() === "") {
      setCustomTenorError("Enter a tenor in days first.");
      return;
    }
    addTenor(Number(customTenorInput));
  }
  return (
    <div className="space-y-4 rounded-xl border border-velo-100 bg-velo-50/40 p-4 dark:border-velo-800 dark:bg-velo-900/10">
      {/* Identity */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Product name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onDraftChange({ name: e.target.value })}
            placeholder="e.g. Personal Loan"
            className={`velo-input text-sm font-semibold ${errors.name ? "velo-input-error" : ""}`}
          />
          {errors.name && <p className="velo-error-text">{errors.name}</p>}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Description (optional)</span>
          <input
            type="text"
            value={draft.description}
            onChange={(e) => onDraftChange({ description: e.target.value })}
            placeholder="Shown to borrowers on the product card"
            className="velo-input text-sm"
          />
        </label>
      </div>

      {/* Product type — explicit, never guessed from the name */}
      <div>
        <SectionLabel>Product type</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <SegmentedOptions value={draft.programType} options={PROGRAM_TYPE_OPTIONS.map(({ value, label }) => ({ value, label }))} onChange={(v) => onDraftChange({ programType: v })} />
          <p className="self-center text-[11px] text-slate-400 dark:text-slate-500">{programHint}</p>
        </div>
      </div>

      {/* Amounts */}
      <div>
        <SectionLabel>Amount limits</SectionLabel>
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
            <NairaField compact label="Default amount" value={draft.defaultAmountNaira} onChange={(n) => onDraftChange({ defaultAmountNaira: n })} helpText="Pre-selected on the borrower form" />
            {errors.defaultAmountNaira && <p className="velo-error-text">{errors.defaultAmountNaira}</p>}
          </div>
        </div>
      </div>

      {/* Tenures + custom tenor */}
      <div>
        <SectionLabel>Repayment tenures</SectionLabel>
        <div className="flex flex-wrap gap-1.5">
          {TENURE_PRESETS.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => (draft.tenures.includes(days) ? removeTenor(days) : addTenor(days))}
              className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition ${
                draft.tenures.includes(days)
                  ? "border-velo-500 bg-velo-500 text-white"
                  : "border-slate-200 bg-white text-slate-500 hover:border-velo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
              }`}
            >
              {days}d
            </button>
          ))}
          <span className="mx-1 hidden w-px self-stretch bg-slate-200 dark:bg-slate-700 sm:block" />
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={customTenorInput}
              onChange={(e) => {
                setCustomTenorInput(e.target.value.replace(/\D/g, ""));
                setCustomTenorError("");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitCustomTenor();
                }
              }}
              placeholder="Custom days"
              aria-label="Custom tenor in days"
              className="velo-input !w-28 !py-1 text-[11px]"
            />
            <button
              type="button"
              onClick={commitCustomTenor}
              className="rounded-full border border-velo-300 bg-white px-2.5 py-1 text-[10px] font-bold text-velo-700 transition hover:bg-velo-50 dark:border-velo-700 dark:bg-slate-900 dark:text-velo-300"
            >
              + Add
            </button>
          </div>
        </div>
        {customTenorError && <p className="velo-error-text mt-1">{customTenorError}</p>}
        {errors.tenures && <p className="velo-error-text mt-1">{errors.tenures}</p>}
        {tenures.length > 0 && (
          <div className="mt-2.5">
            <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Default tenure</span>
            <div className="flex flex-wrap gap-1.5">
              {tenures.map((days) => (
                <button
                  key={days}
                  type="button"
                  onClick={() => onDraftChange({ defaultTenureDays: days })}
                  className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold transition ${
                    Number(draft.defaultTenureDays) === days
                      ? "border-velo-500 bg-velo-50 text-velo-700 dark:border-velo-400 dark:bg-velo-900/40 dark:text-velo-200"
                      : "border-slate-200 bg-white text-slate-500 hover:border-velo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400"
                  }`}
                >
                  {days} days
                </button>
              ))}
            </div>
            {errors.defaultTenureDays && <p className="velo-error-text mt-1">{errors.defaultTenureDays}</p>}
          </div>
        )}
      </div>

      {/* Interest */}
      <div>
        <SectionLabel>Interest</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <PercentField label="Interest rate" value={draft.interestRatePercent} onChange={(v) => onDraftChange({ interestRatePercent: v })} helpText="Base rate — used when a tenor has no rate below" />
          <div>
            <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Interest type</span>
            <SegmentedOptions value={draft.interestType} options={INTEREST_TYPE_OPTIONS.map(({ value, label }) => ({ value, label }))} onChange={(v) => onDraftChange({ interestType: v })} />
            {interestHint && <div className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">{interestHint}</div>}
          </div>
        </div>
        {errors.interestRatePercent && <p className="velo-error-text">{errors.interestRatePercent}</p>}
      </div>

      {/* Per-tenor MONTHLY interest rates + availability */}
      {tenures.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold text-velo-900 dark:text-white">Monthly interest rate per tenor</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Interest = principal × rate × (tenor ÷ 30). Leave a rate empty to use the base rate. Locked tenors stay visible to borrowers but cannot be selected and their rate is never shown.
              </p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => onDraftChange({
                  tenures: [...DEFAULT_PRESET.tenures],
                  tenorRates: { ...DEFAULT_PRESET.tenorRates },
                  tenorStatuses: { ...DEFAULT_PRESET.tenorStatuses },
                  ...(!DEFAULT_PRESET.tenures.includes(Number(draft.defaultTenureDays)) ? { defaultTenureDays: 30 } : {}),
                })}
                className="rounded-lg border border-velo-300 bg-velo-50 px-2.5 py-1.5 text-[10px] font-bold text-velo-700 transition hover:bg-velo-100 dark:border-velo-700 dark:bg-velo-900/40 dark:text-velo-200 dark:hover:bg-velo-900/70"
              >
                Load default
              </button>
              <button
                type="button"
                onClick={() => onDraftChange({ tenorRates: Object.fromEntries(tenures.map((days) => [days, draft.interestRatePercent || "0"])) })}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-velo-700 transition hover:border-velo-300 hover:bg-velo-50 dark:border-slate-700 dark:text-velo-300 dark:hover:bg-slate-800"
              >
                Fill all with base
              </button>
              <button
                type="button"
                onClick={() => onDraftChange({ tenorRates: {}, tenorStatuses: Object.fromEntries(tenures.map((days) => [days, "AVAILABLE"])) as Record<number, TenorStatus> })}
                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-bold text-slate-500 transition hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              >
                Clear all
              </button>
            </div>
          </div>
          <div className="mt-2.5 overflow-x-auto">
            <table className="w-full min-w-[540px] text-left">
              <thead>
                <tr className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  <th className="py-1.5 pr-3">Tenure</th>
                  <th className="py-1.5 pr-3">Duration</th>
                  <th className="py-1.5 pr-3">Monthly interest</th>
                  <th className="py-1.5 pr-3">Status</th>
                  <th className="py-1.5 text-right">Remove</th>
                </tr>
              </thead>
              <tbody>
                {tenures.map((days) => {
                  const status = (draft.tenorStatuses[days] ?? "AVAILABLE") as TenorStatus;
                  const statusHint = TENOR_STATUS_OPTIONS.find((o) => o.value === status)?.hint;
                  const isDefaultTenor = Number(draft.defaultTenureDays) === days;
                  return (
                    <tr key={days} className="border-t border-slate-100 align-top dark:border-slate-800">
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-bold text-slate-600 dark:text-slate-300">{days} Days</span>
                          {isDefaultTenor && (
                            <span className="rounded-full bg-velo-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-velo-700 dark:bg-velo-900/60 dark:text-velo-200">Default</span>
                          )}
                          {status === "HOT" && (
                            <span className="rounded-full bg-orange-500 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-white">Hot</span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-xs text-slate-500 dark:text-slate-400">{tenorDurationLabel(days)}</td>
                      <td className="py-2 pr-3">
                        <div className="relative w-24">
                          <input
                            type="text"
                            inputMode="decimal"
                            value={draft.tenorRates[days] ?? ""}
                            onChange={(e) => {
                              const cleaned = e.target.value.replace(/[^\d.]/g, "");
                              const firstDot = cleaned.indexOf(".");
                              const normalized = firstDot >= 0
                                ? cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "")
                                : cleaned;
                              onDraftChange({ tenorRates: { ...draft.tenorRates, [days]: normalized } });
                            }}
                            onBlur={(e) => {
                              const raw = e.target.value.trim();
                              if (raw === "") { onDraftChange({ tenorRates: { ...draft.tenorRates, [days]: "" } }); return; }
                              const n = Number(raw);
                              onDraftChange({ tenorRates: { ...draft.tenorRates, [days]: String(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0) } });
                            }}
                            placeholder={`${draft.interestRatePercent || 0} base`}
                            className="velo-input !py-1.5 !pr-7 text-xs font-semibold"
                            aria-label={`Monthly interest rate for ${days} days`}
                          />
                          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-bold text-slate-400 select-none">%</span>
                        </div>
                        <p className="mt-1 text-[10px] font-medium text-slate-400 dark:text-slate-500">per month</p>
                      </td>
                      <td className="py-2 pr-3">
                        <select
                          value={status}
                          onChange={(e) => onDraftChange({ tenorStatuses: { ...draft.tenorStatuses, [days]: e.target.value as TenorStatus } })}
                          className="velo-input !py-1.5 text-xs font-semibold"
                          aria-label={`Availability for ${days} days`}
                        >
                          {TENOR_STATUS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                        <p className="mt-1 max-w-[200px] text-[10px] text-slate-400 dark:text-slate-500">{statusHint}</p>
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          onClick={() => removeTenor(days)}
                          className="rounded-lg border border-slate-200 px-2 py-1 text-[10px] font-bold text-slate-400 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600 dark:border-slate-700 dark:hover:border-red-900 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                          aria-label={`Remove the ${days}-day tenor`}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {errors.tenorRates && <p className="velo-error-text mt-1.5">{errors.tenorRates}</p>}
        </div>
      )}

      {/* Fees */}
      <div>
        <SectionLabel>Fees</SectionLabel>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <PercentField label="Processing fee" value={draft.processingFeePercent} onChange={(v) => onDraftChange({ processingFeePercent: v })} />
            {errors.processingFeePercent && <p className="velo-error-text">{errors.processingFeePercent}</p>}
          </div>
          <div>
            <PercentField label="Service fee" value={draft.serviceFeePercent} onChange={(v) => onDraftChange({ serviceFeePercent: v })} helpText="One-off admin fee" />
            {errors.serviceFeePercent && <p className="velo-error-text">{errors.serviceFeePercent}</p>}
          </div>
          <div>
            <PercentField label="Late fee" value={draft.lateFeePercent} onChange={(v) => onDraftChange({ lateFeePercent: v })} />
            {errors.lateFeePercent && <p className="velo-error-text">{errors.lateFeePercent}</p>}
          </div>
          <div>
            <span className="mb-1.5 block text-[11px] font-semibold text-velo-900 dark:text-white">Late fee type</span>
            <SegmentedOptions value={draft.lateFeeType} options={LATE_FEE_TYPE_OPTIONS} onChange={(v) => onDraftChange({ lateFeeType: v })} />
          </div>
        </div>
      </div>

      {/* Rules: grace, collateral, active */}
      <div className="space-y-2.5 border-t border-velo-100 pt-3.5 dark:border-velo-800">
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-3">
          <div>
            <NairaField compact label="Grace period (days)" value={draft.gracePeriodDays} onChange={(n) => onDraftChange({ gracePeriodDays: n })} />
            {errors.gracePeriodDays && <p className="velo-error-text">{errors.gracePeriodDays}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 rounded-xl bg-white px-3.5 py-2.5 dark:bg-slate-900 sm:justify-start">
            <div>
              <div className="text-xs font-semibold text-velo-900 dark:text-white">Collateral section</div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Ask applicants for collateral details.</div>
            </div>
            <Toggle size="sm" checked={draft.collateralEnabled} onChange={(on) => onDraftChange({ collateralEnabled: on, ...(on ? {} : { collateralRequired: false }) })} />
          </div>
          {draft.collateralEnabled && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-white px-3.5 py-2.5 dark:bg-slate-900 sm:justify-start">
              <div>
                <div className="text-xs font-semibold text-velo-900 dark:text-white">Require media</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">Collateral proof is mandatory.</div>
              </div>
              <Toggle size="sm" checked={draft.collateralRequired} onChange={(on) => onDraftChange({ collateralRequired: on })} />
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-3">
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

  const programTypePill = (product: LoanProduct) => {
    if (product.programType === "BUSINESS") return <Pill tone="info">Business</Pill>;
    if (product.programType === "BOTH") return <Pill tone="neutral">Both flows</Pill>;
    if (product.programType === "PERSONAL") return <Pill tone="success">Personal</Pill>;
    return <Pill tone="warning">Legacy name-match</Pill>;
  };

  return (
    <PanelCard
      title="Loan product catalog"
      description="The complete loan configuration — every product carries its type, amounts, tenures, interest, fees, grace period and collateral rules. Borrowers only see ACTIVE products, served strictly by the product type."
      icon={<Icon name="bank" size={18} />}
      action={
        <div className="flex items-center gap-2">
          <Pill tone={catalog.length > 0 && activeCount === 0 ? "warning" : "info"}>{loading ? "…" : `${activeCount}/${catalog.length} active`}</Pill>
          <button
            type="button"
            onClick={startCreate}
            disabled={editingId === "new"}
            className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-3 py-2 text-[11px] font-bold text-white shadow transition hover:bg-velo-600 disabled:opacity-50"
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
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">No active loan products</p>
              <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300/80">Borrowers cannot see or select any loan product right now. Activate at least one product to reopen applications.</p>
            </div>
            <button
              type="button"
              onClick={() => void activateAll()}
              disabled={activatingAll}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-amber-500 px-3 py-2 text-[11px] font-bold text-white shadow transition hover:bg-amber-600 disabled:opacity-60"
            >
              {activatingAll ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Activating…</> : "Activate all"}
            </button>
          </div>
        )}

        {/* Inline creation editor */}
        {editingId === "new" && (
          <div className="rounded-xl border-2 border-dashed border-velo-300 bg-white p-4 dark:border-velo-700 dark:bg-slate-900">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-bold text-velo-900 dark:text-white">New loan product</p>
              <Pill tone="info">Draft</Pill>
            </div>
            <ProductEditor draft={draft} onDraftChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} errors={draftErrors} />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={cancelEdit} className="rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEdit}
                disabled={savingId !== null}
                className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-4 py-2 text-xs font-bold text-white shadow transition hover:bg-velo-600 disabled:opacity-60"
              >
                {savingId !== null ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Creating…</> : "Create product"}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <p className="velo-helper py-4 text-center">Loading loan products…</p>
        ) : catalog.length === 0 && editingId !== "new" ? (
          <p className="velo-helper py-4 text-center">No loan products yet — click “Add product” to create the first one.</p>
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
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">{product.name}</p>
                      <Pill tone={product.isActive ? "success" : "warning"}>{product.isActive ? "Active" : "Inactive"}</Pill>
                      {programTypePill(product)}
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
                        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[11px] font-bold text-velo-700 transition hover:border-velo-300 hover:bg-velo-50 dark:border-slate-700 dark:bg-slate-900 dark:text-velo-300 dark:hover:border-velo-700 dark:hover:bg-slate-800"
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
                    <span>Default: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.defaultAmountNaira ? `₦${safeNaira(product.defaultAmountNaira)}` : "—"}</span></span>
                    <span>Interest: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.interestRatePercent}% {String(product.interestType ?? "").toLowerCase().replace(/_/g, " ")}</span></span>
                    <span>Tenures: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.tenureDays?.length ? product.tenureDays.map((d) => `${d}d`).join(" · ") : `${product.defaultTenureDays ?? "—"}d default`}</span></span>
                    {product.tenorInterestRates && product.tenorInterestRates.length > 0 && (
                      <span>
                        Per-tenor monthly:{" "}
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {product.tenorInterestRates
                            .map((r) =>
                              r.status === "LOCKED"
                                ? `${r.tenorDays}d locked`
                                : `${r.tenorDays}d ${r.monthlyRatePercent}%${r.status === "HOT" ? " (Hot)" : ""}`
                            )
                            .join(" · ")}
                        </span>
                      </span>
                    )}
                    <span>Processing: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.processingFeePercent}%</span></span>
                    <span>Service: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.serviceFeePercent ?? 0}%</span></span>
                    <span>Late fee: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.lateFeePercent}% {String(product.lateFeeType ?? "").toLowerCase().replace(/_/g, " ")}</span></span>
                    <span>Grace: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.gracePeriodDays ?? "—"}d</span></span>
                    <span>Collateral: <span className="font-semibold text-slate-700 dark:text-slate-200">{product.collateralEnabled === false ? "Off" : product.collateralRequired ? "Required" : "Optional"}</span></span>
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
                        <button type="button" onClick={cancelEdit} className="rounded-xl px-4 py-2 text-xs font-semibold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveEdit}
                          disabled={savingId !== null}
                          className="inline-flex items-center gap-1.5 rounded-xl bg-velo-500 px-4 py-2 text-xs font-bold text-white shadow transition hover:bg-velo-600 disabled:opacity-60"
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
