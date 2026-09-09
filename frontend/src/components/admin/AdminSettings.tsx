// ============================================================================
// src/components/admin/AdminSettings.tsx
// Visual loan configuration editor.
//
// Changes are saved as "admin overrides" in localStorage and applied to the
// running `config` object via refreshConfig(). The overrides live in the
// same browser that saves them until the Node admin configuration API is enabled.
//
// Use this page to tweak loan limits, tenures, fees, company info without
// editing the .env file.
// ============================================================================

import { useMemo, useState } from "react";
import {
  baseConfig,
  config as currentConfig,
  saveAdminOverrides,
  resetAdminOverrides,
  refreshConfig,
  type AdminConfigOverride,
} from "../../utils/config";
import { adminResetConfig, adminSaveConfig } from "../../services/adminApi";
import { formatNaira } from "../../utils/loanCalculator";
import { calculateLoan } from "../../utils/loanCalculator";
import type { TenureOption, FeeConfiguration, FeeKey, FeeConfig, TenureFeeOverrides, LoanProgramConfig, LoanProgramKey } from "../../types/loan";
import ProgramEditor from "./ProgramEditor";

const FEE_LABELS: Record<FeeKey, string> = {
  interest: "Monthly Interest Rate",
  serviceFee: "Service Fee",
  processingFee: "Processing Fee",
  lateFee: "Default / Late Fee",
};

/** Per-tenure override state: Record<tenureDays, { enabled: boolean, fees }> */
type TenureFeeState = Record<number, {
  enabled: boolean;
  fees: Record<FeeKey, { type: "flat" | "percentage"; value: number; includeUpfront: boolean }>;
}>;

export default function AdminSettings() {
  const [min, setMin] = useState(currentConfig.loanLimits.min);
  const [max, setMax] = useState(currentConfig.loanLimits.max);
  const [defaultAmount, setDefaultAmount] = useState(currentConfig.loanLimits.defaultAmount);
  const [selectedTenures, setSelectedTenures] = useState<number[]>(() => currentConfig.tenures.map((t) => t.value));
  const [companyName, setCompanyName] = useState(currentConfig.companyName);
  const [companyWebsite, setCompanyWebsite] = useState(currentConfig.companyWebsite);
  const [loanManagerEmails, setLoanManagerEmails] = useState(currentConfig.loanManagerEmails.join(", "));
  const [adminEmails, setAdminEmails] = useState(currentConfig.adminEmails.join(", "));
  const [programs, setPrograms] = useState<Record<LoanProgramKey, LoanProgramConfig>>(() => ({
    PERSONAL: structuredClone(currentConfig.loanPrograms.PERSONAL),
    BUSINESS: structuredClone(currentConfig.loanPrograms.BUSINESS),
  }));

  const [fees, setFees] = useState<Record<FeeKey, { type: "flat" | "percentage"; value: number; includeUpfront: boolean }>>(() => ({
    interest:      { ...currentConfig.fees.interest },
    serviceFee:    { ...currentConfig.fees.serviceFee },
    processingFee: { ...currentConfig.fees.processingFee },
    lateFee:       { ...currentConfig.fees.lateFee },
  }));

  const [tenureFees, setTenureFees] = useState<TenureFeeState>(() => {
    const state: TenureFeeState = {};
    currentConfig.tenures.forEach((t) => {
      const override = currentConfig.tenureFees?.[t.value];
      state[t.value] = {
        enabled: !!override,
        fees: {
          interest:      { ...currentConfig.fees.interest,      ...(override?.interest      || {}) },
          serviceFee:    { ...currentConfig.fees.serviceFee,    ...(override?.serviceFee    || {}) },
          processingFee: { ...currentConfig.fees.processingFee, ...(override?.processingFee || {}) },
          lateFee:       { ...currentConfig.fees.lateFee,       ...(override?.lateFee       || {}) },
        },
      };
    });
    return state;
  });

  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);

  const tenureOptions: TenureOption[] = useMemo(() => {
    const values = new Set([...baseConfig.tenures, ...currentConfig.tenures].map((tenure) => tenure.value));
    return [...values].sort((a, b) => a - b).map((value) => ({ value, label: `${value} Days` }));
  }, []);

  const tenures = useMemo(
    () => tenureOptions.filter((tenure) => selectedTenures.includes(tenure.value)),
    [selectedTenures, tenureOptions],
  );

  // When tenures list changes, sync tenureFees state (add new, keep existing)
  const tenureFeesSynced: TenureFeeState = useMemo(() => {
    const next: TenureFeeState = { ...tenureFees };
    tenures.forEach((t) => {
      if (!next[t.value]) {
        next[t.value] = {
          enabled: false,
          fees: {
            interest:      { ...fees.interest },
            serviceFee:    { ...fees.serviceFee },
            processingFee: { ...fees.processingFee },
            lateFee:       { ...fees.lateFee },
          },
        };
      }
    });
    return next;
  }, [tenures, tenureFees, fees]);

  const previewCalc = useMemo(() => {
    const safeDef = Math.min(Math.max(defaultAmount, min), max);
    const safeTenure = tenures.length > 0 ? tenures[Math.floor(tenures.length / 2)].value : 30;
    return calculateLoan(safeDef, safeTenure, {
      fees: {
        interest: fees.interest,
        serviceFee: fees.serviceFee,
        processingFee: fees.processingFee,
        lateFee: fees.lateFee,
      } as any,
    });
  }, [defaultAmount, min, max, tenures, fees]);

  const formErrors = useMemo(() => {
    const errs: { key: string; message: string; severity: "error" | "warning" }[] = [];
    if (!(min < max)) {
      errs.push({ key: "LOAN_LIMITS", message: `Minimum (₦${min.toLocaleString()}) must be less than Maximum (₦${max.toLocaleString()}).`, severity: "error" });
    }
    if (defaultAmount < min || defaultAmount > max) {
      errs.push({ key: "LOAN_DEFAULT", message: `Default amount (₦${defaultAmount.toLocaleString()}) must be between min (₦${min.toLocaleString()}) and max (₦${max.toLocaleString()}).`, severity: "error" });
    }
    if (tenures.length === 0) {
      errs.push({ key: "TENURES", message: "Add at least one valid tenure (comma-separated days).", severity: "error" });
    }
    (Object.keys(fees) as FeeKey[]).forEach((k) => {
      const f = fees[k];
      if (f.type !== "flat" && f.type !== "percentage") {
        errs.push({ key: `${k.toUpperCase()}_TYPE`, message: `${FEE_LABELS[k]} type must be flat or percentage.`, severity: "error" });
      }
      if (f.type === "percentage" && (f.value < 0 || f.value > 100)) {
        errs.push({ key: `${k.toUpperCase()}_VALUE`, message: `${FEE_LABELS[k]} percentage must be between 0 and 100 (got ${f.value}).`, severity: "error" });
      }
      if (f.value < 0) {
        errs.push({ key: `${k.toUpperCase()}_VALUE`, message: `${FEE_LABELS[k]} value cannot be negative.`, severity: "error" });
      }
    });
    // Validate tenure fees too
    tenures.forEach((t) => {
      const tf = tenureFeesSynced[t.value];
      if (tf?.enabled) {
        (Object.keys(tf.fees) as FeeKey[]).forEach((k) => {
          const f = tf.fees[k];
          if (f.type === "percentage" && (f.value < 0 || f.value > 100)) {
            errs.push({ key: `T${t.value}_${k.toUpperCase()}_VALUE`, message: `[${t.value}d] ${FEE_LABELS[k]} % must be 0-100 (got ${f.value}).`, severity: "error" });
          }
          if (f.value < 0) {
            errs.push({ key: `T${t.value}_${k.toUpperCase()}_VALUE`, message: `[${t.value}d] ${FEE_LABELS[k]} cannot be negative.`, severity: "error" });
          }
        });
      }
    });
    return errs;
  }, [min, max, defaultAmount, tenures, fees, tenureFeesSynced]);

  function buildTenureFeesOverrides(): TenureFeeOverrides | undefined {
    const result: TenureFeeOverrides = {};
    tenures.forEach((t) => {
      const tf = tenureFeesSynced[t.value];
      if (!tf?.enabled) return;
      const base: Partial<FeeConfiguration> = {};
      (Object.keys(tf.fees) as FeeKey[]).forEach((k) => {
        const globalFees = baseConfig.fees[k];
        const f = tf.fees[k];
        if (f.type !== globalFees.type || f.value !== globalFees.value || f.includeUpfront !== globalFees.includeUpfront) {
          base[k] = f;
        }
      });
      if (Object.keys(base).length > 0) result[t.value] = base;
    });
    return Object.keys(result).length > 0 ? result : undefined;
  }

  async function handleSave() {
    const overrides: AdminConfigOverride = {
      loanLimits: {
        min: min !== baseConfig.loanLimits.min ? min : undefined,
        max: max !== baseConfig.loanLimits.max ? max : undefined,
        defaultAmount: defaultAmount !== baseConfig.loanLimits.defaultAmount ? defaultAmount : undefined,
      },
      tenures: JSON.stringify(tenures) !== JSON.stringify(baseConfig.tenures) ? tenures : undefined,
      fees: {},
      tenureFees: buildTenureFeesOverrides(),
      loanPrograms: programs,
      companyName: companyName !== baseConfig.companyName ? companyName : undefined,
      companyWebsite: companyWebsite !== baseConfig.companyWebsite ? companyWebsite : undefined,
      loanManagerEmails: loanManagerEmails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
      adminEmails: adminEmails.split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
    };
    (Object.keys(fees) as FeeKey[]).forEach((k) => {
      const b = baseConfig.fees[k];
      const f = fees[k];
      if (f.type !== b.type || f.value !== b.value || f.includeUpfront !== b.includeUpfront) {
        overrides.fees![k] = f;
      }
    });
    if (overrides.fees && Object.keys(overrides.fees).length === 0) overrides.fees = undefined;
    if (overrides.loanLimits && Object.keys(overrides.loanLimits).length === 0) overrides.loanLimits = undefined;

    setSaving(true);
    setSaveError("");
    try {
      const savedOverrides = await adminSaveConfig(overrides);
      saveAdminOverrides(savedOverrides);
      refreshConfig(savedOverrides);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to save settings.");
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    setSaveError("");
    try {
      await adminResetConfig();
      resetAdminOverrides();
      refreshConfig({});
    setMin(currentConfig.loanLimits.min);
    setMax(currentConfig.loanLimits.max);
    setDefaultAmount(currentConfig.loanLimits.defaultAmount);
    setSelectedTenures(baseConfig.tenures.map((t) => t.value));
    setCompanyName(baseConfig.companyName);
    setCompanyWebsite(baseConfig.companyWebsite);
    setLoanManagerEmails(baseConfig.loanManagerEmails.join(", "));
    setAdminEmails(baseConfig.adminEmails.join(", "));
    setPrograms({ PERSONAL: structuredClone(baseConfig.loanPrograms.PERSONAL), BUSINESS: structuredClone(baseConfig.loanPrograms.BUSINESS) });
    setFees({
      interest:      { ...baseConfig.fees.interest },
      serviceFee:    { ...baseConfig.fees.serviceFee },
      processingFee: { ...baseConfig.fees.processingFee },
      lateFee:       { ...baseConfig.fees.lateFee },
    });
    const resetState: TenureFeeState = {};
    baseConfig.tenures.forEach((t) => {
      resetState[t.value] = {
        enabled: false,
        fees: {
          interest:      { ...baseConfig.fees.interest },
          serviceFee:    { ...baseConfig.fees.serviceFee },
          processingFee: { ...baseConfig.fees.processingFee },
          lateFee:       { ...baseConfig.fees.lateFee },
        },
      };
    });
    setTenureFees(resetState);
      setResetConfirm(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to restore defaults.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="velo-card p-5 sm:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(15,23,42,0.12)] rounded-2xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-velo-500 to-velo-600 text-white shadow-md">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09A1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-velo-900">Loan Settings & Configuration</h2>
              <p className="text-sm text-slate-500 mt-0.5 max-w-xl">
                Adjust loan limits, tenures, fee schedules, branding, and backend URL. Changes are saved for every user.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saved && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-100 animate-fade-in">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Saved ✓
              </span>
            )}
            {!resetConfirm ? (
              <button type="button" onClick={() => setResetConfirm(true)} className="btn-secondary !py-2 text-xs">
                Restore .env defaults
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={handleReset} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-100 text-xs font-bold hover:bg-red-100">
                  Yes, reset all
                </button>
                <button type="button" onClick={() => setResetConfirm(false)} className="btn-ghost text-xs !py-2">
                  Cancel
                </button>
              </div>
            )}
            <button type="button" onClick={handleSave} disabled={saving || formErrors.some((error) => error.severity === "error")} className="btn-primary !py-2 text-xs !px-4 !font-extrabold">
              {saving ? "Saving…" : "Save Settings"}
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700">{saveError}</div>
      )}

      {formErrors.length > 0 && (
        <div className={`rounded-xl border p-4 ${formErrors.some(e => e.severity === "error") ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
          <h3 className={`text-sm font-bold mb-1 ${formErrors.some(e => e.severity === "error") ? "text-red-700" : "text-amber-800"}`}>
            Configuration issues
          </h3>
          <ul className="space-y-1 text-xs">
            {formErrors.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-slate-700">
                <span className="text-slate-400 mt-0.5">•</span>
                <span><strong>{e.key}:</strong> {e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* ===== Left: Configuration Sections ===== */}
        <div className="lg:col-span-2 space-y-6">
          <Section title="Personal & Business Loan Programs" subtitle="Configure limits, tenures, rates, fees, and collateral rules independently for each loan type." icon="🎯">
            <div className="space-y-5">
              {(["PERSONAL", "BUSINESS"] as LoanProgramKey[]).map((type) => (
                <ProgramEditor key={type} type={type} value={programs[type]} onChange={(value) => setPrograms((current) => ({ ...current, [type]: value }))} />
              ))}
            </div>
          </Section>

          <Section title="Loan Amount Limits" subtitle="Legacy global defaults retained for compatibility. New applications use the loan program settings above." icon="💰">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <NumberField
                label="Minimum Loan Amount (₦)"
                value={min}
                onChange={setMin}
              />
              <NumberField
                label="Maximum Loan Amount (₦)"
                value={max}
                onChange={setMax}
              />
              <NumberField
                label="Default Amount (₦)"
                value={defaultAmount}
                onChange={setDefaultAmount}
              />
            </div>
          </Section>

          <Section title="Repayment Tenures" subtitle="Select the repayment periods available to borrowers." icon="📅">
            <Field label="Tenures (days)">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {tenureOptions.map((tenure) => (
                  <label key={tenure.value} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold text-velo-900 cursor-pointer hover:border-velo-300 transition-colors">
                    <input
                      type="checkbox"
                      checked={selectedTenures.includes(tenure.value)}
                      onChange={(event) => setSelectedTenures((current) => event.target.checked
                        ? [...current, tenure.value].sort((a, b) => a - b)
                        : current.filter((value) => value !== tenure.value))}
                      className="h-4 w-4 rounded accent-velo-500"
                    />
                    {tenure.value} days
                  </label>
                ))}
              </div>
              {tenures.length === 0 && <span className="mt-2 block text-xs text-red-600">Select at least one tenure.</span>}
            </Field>
          </Section>

          <Section title="Fees Configuration (Global)" subtitle="Each fee can be a flat ₦ amount or a % of the loan amount. Late fee is shown separately by default. These apply to ALL tenures unless you set per-tenure overrides below." icon="💸">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(Object.keys(FEE_LABELS) as FeeKey[]).map((k) => (
                <FeeField
                  key={k}
                  feeKey={k}
                  label={FEE_LABELS[k]}
                  baseFee={baseConfig.fees[k]}
                  value={fees[k]}
                  onChange={(v) => setFees({ ...fees, [k]: v })}
                />
              ))}
            </div>
          </Section>

          <Section
            title="Per-Tenure Fee Overrides"
            subtitle="Optional: Set DIFFERENT fees per loan tenor. Toggle a tenure ON to override global fees. Any fee left untoggled inherits from the Global config above."
            icon="📊"
          >
            <div className="space-y-3">
              {tenures.length === 0 && (
                <div className="text-xs text-slate-500 italic">Add tenures above first to configure per-tenure fees.</div>
              )}
              {tenures.map((t) => {
                const state = tenureFeesSynced[t.value];
                if (!state) return null;
                return (
                  <div
                    key={t.value}
                    className={`rounded-2xl border transition-all duration-200 overflow-hidden ${
                      state.enabled
                        ? "border-velo-300 bg-gradient-to-br from-velo-50/60 to-white shadow-sm"
                        : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between p-4 border-b border-inherit">
                      <div className="flex items-center gap-3">
                        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={state.enabled}
                            onChange={(e) =>
                              setTenureFees({
                                ...tenureFeesSynced,
                                [t.value]: { ...state, enabled: e.target.checked },
                              })
                            }
                            className="h-5 w-5 rounded accent-velo-500 cursor-pointer"
                          />
                        </label>
                        <div>
                          <div className="text-sm font-extrabold text-velo-900">
                            {t.value} Day Tenure
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {state.enabled
                              ? "✅ Custom fees ACTIVE for this tenure"
                              : "Using global fees (inherited)"}
                          </div>
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold border ${
                          state.enabled
                            ? "bg-velo-500 text-white border-velo-500 shadow-sm"
                            : "bg-slate-100 text-slate-500 border-slate-200"
                        }`}
                      >
                        {state.enabled ? "CUSTOM" : "GLOBAL"}
                      </span>
                    </div>
                    {state.enabled && (
                      <div className="p-4 pt-0">
                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
                          {(Object.keys(FEE_LABELS) as FeeKey[]).map((k) => (
                            <FeeField
                              key={k}
                              feeKey={k}
                              label={`${FEE_LABELS[k]} (${t.value}d only)`}
                              baseFee={fees[k]}
                              baseLabel="Global"
                              value={state.fees[k]}
                              onChange={(v) =>
                                setTenureFees({
                                  ...tenureFeesSynced,
                                  [t.value]: {
                                    ...state,
                                    fees: { ...state.fees, [k]: v },
                                  },
                                })
                              }
                              compact
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          <Section title="Company & Branding" subtitle="Displayed throughout the loan portal and documents." icon="🏢">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field label="Company Name">
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className="velo-input text-sm"
                />
              </Field>
              <Field label="Company Website (no protocol)">
                <input
                  type="text"
                  value={companyWebsite}
                  onChange={(e) => setCompanyWebsite(e.target.value)}
                  className="velo-input text-sm"
                  placeholder="www.yourcompany.com"
                />
              </Field>
              <Field label="Administrator Emails">
                <input
                  type="text"
                  value={adminEmails}
                  onChange={(e) => setAdminEmails(e.target.value)}
                  className="velo-input text-sm"
                  placeholder="admin@company.com, owner@company.com"
                />
                <div className="velo-helper">These administrators receive loan application and status notifications and can use password reset.</div>
              </Field>
              <Field label="Loan Manager Emails">
                <input
                  type="text"
                  value={loanManagerEmails}
                  onChange={(e) => setLoanManagerEmails(e.target.value)}
                  className="velo-input text-sm"
                  placeholder="manager@company.com, team@company.com"
                />
                <div className="velo-helper">Comma-separated recipients for new applications and loan status updates.</div>
              </Field>
            </div>
          </Section>
        </div>

        {/* ===== Right: Live Preview + Info ===== */}
        <div className="space-y-6">
          <div className="velo-card p-5 sm:p-6 rounded-2xl border-0 shadow-md bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 text-white relative overflow-hidden">
            <div className="absolute -top-16 -right-16 w-48 h-48 bg-velo-300/20 rounded-full blur-2xl animate-float" />
            <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-velo-400/15 rounded-full blur-2xl animate-float-slow" />

            <div className="relative">
              <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/15 border border-white/20 text-[10px] font-bold mb-3">
                🔮 LIVE PREVIEW
              </div>
              <h3 className="font-extrabold text-white mb-0.5">Sample Calculation</h3>
              <p className="text-xs text-white/70 mb-4">
                Default amount × middle tenure (selected program fees)
              </p>

              <div className="space-y-1.5 mb-4">
                <PreviewRow label="Principal" value={formatNaira(previewCalc.loanAmount)} />
                <PreviewRow label="Interest" value={formatNaira(previewCalc.interest)} />
                <PreviewRow label="Service Fee" value={formatNaira(previewCalc.serviceFee)} />
                <PreviewRow label="Processing Fee" value={formatNaira(previewCalc.processingFee)} />
                {previewCalc.lateFee > 0 && (
                  <PreviewRow label="Default Fee (if any)" value={formatNaira(previewCalc.lateFee)} muted />
                )}
              </div>

              <div className="border-t border-white/15 pt-3 mb-4">
                <div className="flex justify-between items-center">
                  <span className="text-white/80 text-xs font-bold">TOTAL REPAYMENT</span>
                  <span className="text-2xl font-black tracking-tight animate-bounce-subtle" key={previewCalc.totalRepayment}>
                    {formatNaira(previewCalc.totalRepayment)}
                  </span>
                </div>
                <div className="flex justify-between items-center mt-2 text-[11px] text-white/70">
                  <span>Tenure: <strong className="text-white/90">{previewCalc.tenureLabel}</strong></span>
                  <span>Due: <strong className="text-white/90">{previewCalc.repaymentDateLabel || "..."}</strong></span>
                </div>
              </div>

              <button
                type="button"
                onClick={handleSave}
                disabled={saving || formErrors.some((error) => error.severity === "error")}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-white text-velo-700 font-extrabold shadow-lg transition-all duration-200 hover:shadow-xl hover:scale-[1.01] disabled:cursor-not-allowed disabled:opacity-60"
              >
                {saving ? "Saving…" : "Apply These Settings"}
              </button>
            </div>
          </div>

          <div className="velo-card p-5 rounded-2xl border-0">
            <h3 className="font-bold text-velo-900 text-sm mb-2 flex items-center gap-1.5">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-velo-500"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="1.8"/><path d="M12 8v5M12 16h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              How this works
            </h3>
            <ul className="space-y-2 text-xs text-slate-600">
              <li className="flex gap-2"><span className="text-velo-500 font-bold">1.</span>Settings are saved to the shared Velo configuration.</li>
              <li className="flex gap-2"><span className="text-velo-500 font-bold">2.</span>Every applicant receives the saved settings when the site loads.</li>
              <li className="flex gap-2"><span className="text-velo-500 font-bold">3.</span>Per-tenure fee schedules take precedence over the global fees.</li>
              <li className="flex gap-2"><span className="text-velo-500 font-bold">4.</span>Restore defaults removes the shared override and returns to the deployed baseline.</li>
            </ul>
          </div>

        </div>
      </div>

      {/* Bottom sticky save bar on mobile */}
      <div className="lg:hidden sticky bottom-4 -mx-4 sm:-mx-6 px-4 sm:px-6 z-20">
        <div className="velo-card p-3 flex items-center gap-2 shadow-elevated rounded-2xl border-0">
          <div className="flex-1 min-w-0">
            {saved ? (
              <div className="text-xs font-bold text-emerald-700">✓ Settings saved</div>
            ) : (
              <div className="text-xs text-slate-500">Click Save to persist changes</div>
            )}
          </div>
          <button type="button" onClick={handleSave} disabled={saving || formErrors.some((error) => error.severity === "error")} className="btn-primary !py-2 !px-4 text-xs !font-extrabold shrink-0">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* =======================================================================
   Small UI helpers
   ======================================================================= */

function Section({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: string; children: React.ReactNode }) {
  return (
    <div className="velo-card p-5 sm:p-6 rounded-2xl border-0">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          {icon && <span className="text-xl leading-none">{icon}</span>}
          <h3 className="font-extrabold text-velo-900 text-base">{title}</h3>
        </div>
        {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-velo-900 mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function NumberField({ label, value, onChange, helpText }: { label: string; value: number; onChange: (n: number) => void; helpText?: string }) {
  return (
    <Field label={label}>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 font-bold text-sm">₦</span>
        <input
          type="text"
          inputMode="numeric"
          value={value.toLocaleString("en-NG")}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/[^0-9]/g, ""));
            onChange(Number.isFinite(n) ? n : 0);
          }}
          className="velo-input pl-8 font-bold text-sm"
        />
      </div>
      {helpText && <div className="text-[11px] text-slate-400 mt-1">{helpText}</div>}
    </Field>
  );
}

function FeeField({
  feeKey, label, baseFee, value, onChange, compact, baseLabel,
}: {
  feeKey: FeeKey;
  label: string;
  baseFee: { type: "flat" | "percentage"; value: number; includeUpfront: boolean };
  value: { type: "flat" | "percentage"; value: number; includeUpfront: boolean };
  onChange: (v: { type: "flat" | "percentage"; value: number; includeUpfront: boolean }) => void;
  compact?: boolean;
  baseLabel?: string;
}) {
  return (
    <div className={`rounded-xl border border-slate-200 p-4 hover:border-velo-200 hover:shadow-sm transition-all duration-200 ${compact ? "p-3" : ""}`}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className={`font-extrabold text-velo-900 ${compact ? "text-xs" : "text-sm"}`}>{label}</div>
        </div>
      </div>
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <select
            value={value.type}
            onChange={(e) => onChange({ ...value, type: e.target.value as "flat" | "percentage" })}
            className={`velo-input !py-2 text-xs font-bold w-28 shrink-0 ${compact ? "!py-1.5 text-[10px]" : ""}`}
          >
            <option value="flat">Flat (₦)</option>
            <option value="percentage">Percentage (%)</option>
          </select>
          <input
            type="number"
            min={0}
            step={value.type === "percentage" ? 0.1 : 500}
            value={value.value}
            onChange={(e) => onChange({ ...value, value: Number(e.target.value) || 0 })}
            className={`velo-input !py-2 text-sm font-bold flex-1 ${compact ? "!py-1.5 text-xs" : ""}`}
          />
          <span className={`text-xs font-bold text-slate-500 w-6 ${compact ? "text-[10px]" : ""}`}>
            {value.type === "flat" ? "₦" : "%"}
          </span>
        </div>
        <label className={`flex items-center gap-2 text-slate-600 cursor-pointer select-none ${compact ? "text-[10px]" : "text-[11px]"}`}>
          <input
            type="checkbox"
            checked={value.includeUpfront}
            onChange={(e) => onChange({ ...value, includeUpfront: e.target.checked })}
            className="h-3.5 w-3.5 rounded accent-velo-500"
          />
          <span>Include in upfront total repayment</span>
        </label>
      </div>
    </div>
  );
}

function PreviewRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex justify-between items-center py-0.5 ${muted ? "opacity-50" : ""}`}>
      <span className="text-[11px] text-white/75">{label}</span>
      <span className="text-sm font-bold">{value}</span>
    </div>
  );
}
