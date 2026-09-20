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

import { useEffect, useMemo, useState } from "react";
import {
  baseConfig,
  config as currentConfig,
  saveAdminOverrides,
  resetAdminOverrides,
  refreshConfig,
  type AdminConfigOverride,
} from "../../utils/config";
import {
  adminGetPlatformSettings,
  adminUpdatePlatformSettings,
  adminSetInvestorEarningRate,
  adminCreditInvestorWallet,
  adminGetLedger,
  adminListInvestors,
  adminListWithdrawals,
  adminRetryWithdrawal,
  type AdminLedgerEntry,
} from "../../services/adminApi";
import { adminListLoanProducts, adminCreateLoanProduct, adminPatchLoanProduct } from "../../services/apiClient";
import { formatNaira } from "../../utils/loanCalculator";
import { calculateLoan } from "../../utils/loanCalculator";
import type { TenureOption, FeeConfiguration, FeeKey, FeeConfig, TenureFeeOverrides, LoanProgramConfig, LoanProgramKey } from "../../types/loan";
import ProgramEditor from "./ProgramEditor";
import Icon from "../Icon";

const FEE_LABELS: Record<FeeKey, string> = {
  interest: "Monthly Interest Rate",
  serviceFee: "Service Fee",
  processingFee: "Processing Fee",
  lateFee: "Default / Late Fee",
};

/** Per-tenure override state: Record<tenureDays, { enabled: boolean, fees }> */
type TenureFeeState = Record<number, {
  enabled: boolean;
  fees: Record<FeeKey, { type: "flat" | "percentage"; value: number; includeUpfront: boolean; enabled?: boolean }>;
}>;

export default function AdminSettings(props?: { displaySection?: "all" | "ledger" | "withdrawals" | "investor-tools" }) {
  const displaySection: NonNullable<typeof props>["displaySection"] = props?.displaySection ?? "all";
  const showConfig = displaySection === "all";
  const showInvestorTools = displaySection === "investor-tools";
  const showWithdrawals = displaySection === "withdrawals";
  const showLedger = displaySection === "ledger";
  const [min, setMin] = useState(currentConfig.loanLimits.min);
  const [max, setMax] = useState(currentConfig.loanLimits.max);
  const [defaultAmount, setDefaultAmount] = useState(currentConfig.loanLimits.defaultAmount);
  const [selectedTenures, setSelectedTenures] = useState<number[]>(() => currentConfig.tenures.map((t) => t.value));
  const [companyName, setCompanyName] = useState(currentConfig.companyName);
  const [companyWebsite, setCompanyWebsite] = useState(currentConfig.companyWebsite);
  const [brandLogoUrl, setBrandLogoUrl] = useState(currentConfig.brandLogoUrl);
  const [lenderSignatoryName, setLenderSignatoryName] = useState(currentConfig.lenderSignatoryName);
  const [lenderSignatoryPosition, setLenderSignatoryPosition] = useState(currentConfig.lenderSignatoryPosition);
  const [lenderSignatorySignatureUrl, setLenderSignatorySignatureUrl] = useState(currentConfig.lenderSignatorySignatureUrl);
  const [apiUrl, setApiUrl] = useState(currentConfig.apiUrl);
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

  const [platformSettings, setPlatformSettings] = useState<any>(null);
  const [platformLoading, setPlatformLoading] = useState(false);
  const [platformMessage, setPlatformMessage] = useState("");
  const [platformError, setPlatformError] = useState("");

  const [withdrawalFeePercent, setWithdrawalFeePercent] = useState(1);
  const [withdrawalFeeFlatNaira, setWithdrawalFeeFlatNaira] = useState(0);
  const [defaultAnnualRate, setDefaultAnnualRate] = useState(12);
  const [adminLedgerBalance, setAdminLedgerBalance] = useState<number | null>(null);

  const [earningInvestorId, setEarningInvestorId] = useState("");
  const [earningRatePercent, setEarningRatePercent] = useState(15);
  const [earningRateSaving, setEarningRateSaving] = useState(false);
  const [earningRateMsg, setEarningRateMsg] = useState("");

  const [creditInvestorId, setCreditInvestorId] = useState("");
  const [creditAmountNaira, setCreditAmountNaira] = useState("50000");
  const [creditReason, setCreditReason] = useState<"MANUAL_CREDIT" | "INVESTMENT_RETURN" | "BONUS" | "CORRECTION">("MANUAL_CREDIT");
  const [creditDescription, setCreditDescription] = useState("");
  const [creditSaving, setCreditSaving] = useState(false);
  const [creditMsg, setCreditMsg] = useState("");

  const [investors, setInvestors] = useState<any[]>([]);
  const [investorsLoading, setInvestorsLoading] = useState(true);
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [withdrawalsLoading, setWithdrawalsLoading] = useState(true);
  const [withdrawalActioning, setWithdrawalActioning] = useState<string | null>(null);

  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerFilter, setLedgerFilter] = useState<string>("");
  const [selectedLedgerEntry, setSelectedLedgerEntry] = useState(null as AdminLedgerEntry | null);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const LEDGER_LIMIT = 20;

  useEffect(() => {
    async function loadAdminData() {
      try {
        const settings = await adminGetPlatformSettings();
        setPlatformSettings(settings.settings);
        setWithdrawalFeePercent(settings.settings.investorWithdrawalFeePercent ?? 1);
        setWithdrawalFeeFlatNaira(Math.round((settings.settings.investorWithdrawalFeeFlatMinor ?? 0) / 100));
        setDefaultAnnualRate(settings.settings.defaultInvestmentAnnualRatePercent ?? 12);
        setAdminLedgerBalance(settings.adminLedgerBalanceMinor ?? 0);
      } catch (e: any) {
        setPlatformError(e.message || "Failed to load platform settings");
      }
      try {
        const inv = await adminListInvestors({ limit: 50 });
        setInvestors(inv.investors ?? []);
      } finally {
        setInvestorsLoading(false);
      }
      try {
        const wd = await adminListWithdrawals({ limit: 50 });
        setWithdrawals(wd.withdrawals ?? []);
      } finally {
        setWithdrawalsLoading(false);
      }
      try {
        const ledger = await adminGetLedger({ limit: LEDGER_LIMIT, offset: 0 });
        setLedgerEntries(ledger.entries ?? []);
        setLedgerTotal(ledger.totalEntries ?? 0);
        if (adminLedgerBalance === null) setAdminLedgerBalance(ledger.balanceMinor ?? 0);
      } finally {
        setLedgerLoading(false);
      }
    }
    void loadAdminData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function reloadLedger(offset: number, entryType?: string) {
    setLedgerLoading(true);
    try {
      const ledger = await adminGetLedger({
        limit: LEDGER_LIMIT,
        offset,
        entryType: entryType || undefined,
      });
      setLedgerEntries(ledger.entries ?? []);
      setLedgerTotal(ledger.totalEntries ?? 0);
      if (adminLedgerBalance === null) setAdminLedgerBalance(ledger.balanceMinor ?? 0);
    } catch (_e) {
      /* ignore, keep stale list */
    } finally {
      setLedgerLoading(false);
    }
  }

  useEffect(() => {
    setLedgerOffset(0);
    void reloadLedger(0, ledgerFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ledgerFilter]);

  async function handleSavePlatformSettings() {
    setPlatformLoading(true);
    setPlatformMessage("");
    setPlatformError("");
    try {
      const result = await adminUpdatePlatformSettings({
        investorWithdrawalFeePercent: Number(withdrawalFeePercent),
        investorWithdrawalFeeFlatNaira: Number(withdrawalFeeFlatNaira),
        defaultInvestmentAnnualRatePercent: Number(defaultAnnualRate),
      });
      setPlatformSettings(result.settings);
      setPlatformMessage("Platform settings saved successfully.");
      setTimeout(() => setPlatformMessage(""), 4000);
    } catch (e: any) {
      setPlatformError(e.message || "Failed to save settings");
    } finally {
      setPlatformLoading(false);
    }
  }

  async function handleSaveEarningRate() {
    if (!earningInvestorId) {
      setEarningRateMsg("Please select an investor first.");
      return;
    }
    setEarningRateSaving(true);
    setEarningRateMsg("");
    try {
      await adminSetInvestorEarningRate(earningInvestorId, Number(earningRatePercent));
      setEarningRateMsg("Investor earning rate saved successfully.");
      setTimeout(() => setEarningRateMsg(""), 4000);
    } catch (e: any) {
      setEarningRateMsg("Error: " + (e.message || "Failed"));
    } finally {
      setEarningRateSaving(false);
    }
  }

  async function handleCreditInvestor() {
    if (!creditInvestorId || !Number(creditAmountNaira)) {
      setCreditMsg("Please select investor and enter valid amount.");
      return;
    }
    setCreditSaving(true);
    setCreditMsg("");
    try {
      await adminCreditInvestorWallet(creditInvestorId, {
        amountNaira: Number(creditAmountNaira),
        reason: creditReason,
        description: creditDescription || undefined,
      });
      setCreditMsg("Investor wallet credited successfully.");
      setCreditAmountNaira("50000");
      setCreditDescription("");
      setTimeout(() => setCreditMsg(""), 4000);
    } catch (e: any) {
      setCreditMsg("Error: " + (e.message || "Failed"));
    } finally {
      setCreditSaving(false);
    }
  }

  async function handleRetryWithdrawal(id: string) {
    setWithdrawalActioning(id);
    try {
      const res = await adminRetryWithdrawal(id);
      setWithdrawals(current => current.map(w => (w.id === id ? res.withdrawal : w)));
    } finally {
      setWithdrawalActioning(null);
    }
  }


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

  function updateGlobalLimits(patch: Partial<LoanProgramConfig["loanLimits"]>) {
    const limits = { min, max, defaultAmount, ...patch };
    if (patch.min !== undefined) setMin(patch.min);
    if (patch.max !== undefined) setMax(patch.max);
    if (patch.defaultAmount !== undefined) setDefaultAmount(patch.defaultAmount);
    setPrograms((current) => ({
      PERSONAL: { ...current.PERSONAL, loanLimits: limits },
      BUSINESS: { ...current.BUSINESS, loanLimits: limits },
    }));
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
      brandLogoUrl: brandLogoUrl !== baseConfig.brandLogoUrl ? brandLogoUrl : undefined,
      lenderSignatoryName: lenderSignatoryName !== baseConfig.lenderSignatoryName ? lenderSignatoryName : undefined,
      lenderSignatoryPosition: lenderSignatoryPosition !== baseConfig.lenderSignatoryPosition ? lenderSignatoryPosition : undefined,
      lenderSignatorySignatureUrl: lenderSignatorySignatureUrl !== baseConfig.lenderSignatorySignatureUrl ? lenderSignatorySignatureUrl : undefined,
      apiUrl: apiUrl !== baseConfig.apiUrl ? apiUrl : undefined,
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
      saveAdminOverrides(overrides);
      refreshConfig(overrides);
      // Refresh the in-memory form source immediately so calculator consumers
      // see the same limits and tenures after saving, without a reload.
      const products = (await adminListLoanProducts()).products;
      for (const [type, program] of Object.entries(programs) as Array<[LoanProgramKey, LoanProgramConfig]>) {
        const existing = products.find((product: any) => String(product.name).toUpperCase().includes(type));
        const productInput = {
          name: `${type === "PERSONAL" ? "Personal" : "Business"} Loan`,
          minAmountNaira: program.loanLimits.min,
          maxAmountNaira: program.loanLimits.max,
          defaultTenureDays: program.tenures[0]?.value || 30,
          interestRatePercent: program.fees.interest.value,
          interestType: "ANNUALIZED" as const,
          processingFeePercent: program.fees.processingFee.type === "percentage" ? program.fees.processingFee.value : 0,
          lateFeePercent: program.fees.lateFee.type === "percentage" ? program.fees.lateFee.value : 0,
          isActive: true,
        };
        if (existing) await adminPatchLoanProduct(existing.id, productInput);
        else await adminCreateLoanProduct(productInput);
      }
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
      resetAdminOverrides();
      refreshConfig({});
    setMin(currentConfig.loanLimits.min);
    setMax(currentConfig.loanLimits.max);
    setDefaultAmount(currentConfig.loanLimits.defaultAmount);
    setSelectedTenures(baseConfig.tenures.map((t) => t.value));
    setCompanyName(baseConfig.companyName);
    setCompanyWebsite(baseConfig.companyWebsite);
    setBrandLogoUrl(baseConfig.brandLogoUrl);
    setLenderSignatoryName(baseConfig.lenderSignatoryName);
    setLenderSignatoryPosition(baseConfig.lenderSignatoryPosition);
    setLenderSignatorySignatureUrl(baseConfig.lenderSignatorySignatureUrl);
    setApiUrl(baseConfig.apiUrl);
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
    <div className="space-y-6 animate-fade-in rounded-2xl text-slate-800 dark:text-slate-200 [&_.bg-white]:bg-slate-900 [&_.bg-slate-50]:bg-slate-950 [&_.border-slate-100]:border-slate-800 [&_.border-slate-200]:border-slate-700 [&_.text-slate-700]:text-slate-200 [&_.text-slate-600]:text-slate-300">
      {showConfig && (
      <>
      {/* Header */}
      <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(15,23,42,0.12)] rounded-2xl dark:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-velo-500 to-velo-600 text-white shadow-md">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09A1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </div>
            <div>
              <h2 className="text-lg font-extrabold text-velo-900 dark:text-white">Loan Settings & Configuration</h2>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5 max-w-xl">
                Adjust loan limits, tenures, fee schedules, branding, and backend URL. Changes are saved for every user.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {saved && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400 text-xs font-bold border border-emerald-100 dark:border-emerald-900/40 animate-fade-in">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Saved
              </span>
            )}
            {!resetConfirm ? (
              <button type="button" onClick={() => setResetConfirm(true)} className="btn-secondary !py-2 text-xs">
                Restore .env defaults
              </button>
            ) : (
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={handleReset} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-100 dark:bg-red-900/20 dark:text-red-400 dark:border-red-900/40 text-xs font-bold hover:bg-red-100 dark:hover:bg-red-900/30">
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
        <div className="rounded-xl border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900/40 p-4 text-sm font-medium text-red-700 dark:text-red-400">{saveError}</div>
      )}

      {formErrors.length > 0 && (
        <div className={`rounded-xl border p-4 ${formErrors.some(e => e.severity === "error") ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-900/40" : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-900/40"}`}>
          <h3 className={`text-sm font-bold mb-1 ${formErrors.some(e => e.severity === "error") ? "text-red-700 dark:text-red-400" : "text-amber-800 dark:text-amber-400"}`}>
            Configuration issues
          </h3>
          <ul className="space-y-1 text-xs">
            {formErrors.map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                <span className="text-slate-400 dark:text-slate-500 mt-0.5">•</span>
                <span><strong>{e.key}:</strong> {e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      </>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {showConfig && (
        <>
        {/* ===== Left: Configuration Sections ===== */}
        <div className="lg:col-span-2 space-y-6">
          <Section title="Personal & Business Loan Programs" subtitle="Configure limits, tenures, rates, fees, and collateral rules independently for each loan type." icon={<Icon name="target" size={20} />}>
            <div className="space-y-5">
              {(["PERSONAL", "BUSINESS"] as LoanProgramKey[]).map((type) => (
                <ProgramEditor key={type} type={type} value={programs[type]} onChange={(value) => setPrograms((current) => ({ ...current, [type]: value }))} />
              ))}
            </div>
          </Section>

          <Section title="Loan Amount Limits" subtitle="Global limits automatically apply to both Personal and Business loans." icon={<Icon name="money" size={20} />}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <NumberField
                label="Minimum Loan Amount (₦)"
                value={min}
                onChange={(value) => updateGlobalLimits({ min: value })}
              />
              <NumberField
                label="Maximum Loan Amount (₦)"
                value={max}
                onChange={(value) => updateGlobalLimits({ max: value })}
              />
              <NumberField
                label="Default Amount (₦)"
                value={defaultAmount}
                onChange={(value) => updateGlobalLimits({ defaultAmount: value })}
              />
            </div>
          </Section>

          <Section title="Repayment Tenures" subtitle="Select the repayment periods available to borrowers." icon={<Icon name="calendar" size={20} />}>
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

          <Section title="Fees Configuration (Global)" subtitle="Each fee can be a flat ₦ amount or a % of the loan amount. Late fee is shown separately by default. These apply to ALL tenures unless you set per-tenure overrides below." icon={<Icon name="money" size={20} />}>
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
            icon={<Icon name="chart" size={20} />}
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
                            {state.enabled ? <span className="inline-flex items-center gap-1 text-emerald-700"><Icon name="check" size={12} />Custom fees active for this tenure</span> : "Using global fees (inherited)"}
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

          <Section title="Company & Branding" subtitle="Displayed throughout the loan portal and documents." icon={<Icon name="bank" size={20} />}>
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
              <Field label="Brand Logo URL">
                <input type="url" value={brandLogoUrl} onChange={(e) => setBrandLogoUrl(e.target.value)} className="velo-input text-sm" placeholder="https://.../logo.png" />
                <div className="mt-2 flex items-center gap-3"><img src={brandLogoUrl} alt="Brand preview" className="h-10 max-w-[180px] object-contain" /><span className="text-xs text-slate-500">Used in navigation, SEO, emails, and agreements where supported.</span></div>
              </Field>
              <Field label="Authorised Signatory Full Name">
                <input type="text" value={lenderSignatoryName} onChange={(e) => setLenderSignatoryName(e.target.value)} className="velo-input text-sm" placeholder="Full name displayed on agreements" />
              </Field>
              <Field label="Authorised Signatory Position">
                <input type="text" value={lenderSignatoryPosition} onChange={(e) => setLenderSignatoryPosition(e.target.value)} className="velo-input text-sm" placeholder="e.g. Director" />
              </Field>
              <Field label="Authorised Signatory Signature URL">
                <input type="url" value={lenderSignatorySignatureUrl} onChange={(e) => setLenderSignatorySignatureUrl(e.target.value)} className="velo-input text-sm" placeholder="https://.../signature.png" />
              </Field>
              <Field label="Frontend API URL">
                <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value.replace(/\/$/, ""))} className="velo-input text-sm" placeholder="https://api.example.com" />
                <div className="velo-helper">Changing this takes effect after a page reload.</div>
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

          <Section title="Environment & Integrations" subtitle="Deployment-controlled values are shown for visibility. Secrets are never exposed in the browser or editable here." icon={<Icon name="lock" size={20} />}>
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Database", "Server secret", "Not exposed"],
                ["JWT signing", "Server secret", "Not exposed"],
                ["Flutterwave", "Payment provider", "Configured by backend"],
                ["Prembly", "Identity provider", "Configured by backend"],
                ["Google Drive", "Private document storage", "Configured by backend"],
                ["Brevo / KUDI / Meta", "Notifications", "Configured by backend"],
                ["Loan policy", "Eligibility thresholds", "Configured by backend"],
                ["Reminder schedule", "Repayment notifications", "Configured by backend"],
              ].map(([name, category, status]) => <div key={name} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700"><div className="text-sm font-semibold text-velo-900 dark:text-white">{name}</div><div className="mt-1 text-xs text-slate-500">{category}</div><div className="mt-2 text-xs font-semibold text-emerald-600">{status}</div></div>)}
            </div>
            <p className="mt-4 text-xs leading-5 text-slate-500">Provider keys, database credentials, admin passwords, JWT secrets, storage credentials, webhook secrets, and OTP secrets must be changed in the deployment environment and are intentionally unavailable to browser administrators.</p>
          </Section>
        </div>

        {/* ===== Right: Live Preview + Info ===== */}
        <div className="space-y-6">
          <div className="velo-card p-4 sm:p-5 lg:p-6 rounded-2xl border-0 shadow-md bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 text-white relative overflow-hidden">
            <div className="absolute -top-16 -right-16 w-48 h-48 bg-velo-300/20 rounded-full blur-2xl animate-float" />
            <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-velo-400/15 rounded-full blur-2xl animate-float-slow" />

            <div className="relative">
              <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/15 border border-white/20 text-[10px] font-bold mb-3">
                <Icon name="sparkles" size={12} />LIVE PREVIEW
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

          <div className="velo-card p-4 sm:p-5 rounded-2xl border-0">
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
      </>)}
      </div>
      {(showInvestorTools || showWithdrawals || showLedger) && (
      <>
      {/* ===== Investor Management + Admin Ledger Center ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* ============ INVESTOR MANAGEMENT ============ */}
          {showInvestorTools && (
          <div className={`space-y-6 ${showLedger ? "lg:col-span-2" : "lg:col-span-3"}`}>
            <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(16,185,129,0.12)] rounded-2xl border-l-4 border-emerald-500 dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
                <div>
                  <h3 className="text-lg font-extrabold text-velo-900 dark:text-white flex items-center gap-2">
                    <Icon name="briefcase" size={22} />Investor Management — Withdrawal Fees &amp; Earning Rates
                  </h3>
                  <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
                    Configure global withdrawal fees, default investment earning rates, and per-investor overrides.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSavePlatformSettings}
                    disabled={platformLoading}
                    className="btn-primary !py-2 !px-4 text-xs !font-extrabold"
                  >
                    {platformLoading ? "Saving…" : <><Icon name="save" size={14} />Save Platform Settings</>}
                  </button>
                </div>
              </div>
              {platformMessage && <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/40 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 px-4 py-2.5 text-sm font-bold mb-4 animate-fade-in">{platformMessage}</div>}
              {platformError && <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 px-4 py-2.5 text-sm font-bold mb-4">{platformError}</div>}
          
              <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Investor Withdrawal Fee (%)
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Percentage of withdrawal amount charged as fee
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      className="velo-input pr-8"
                      value={withdrawalFeePercent}
                      onChange={(e) => setWithdrawalFeePercent(Number(e.target.value))}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">{platformSettings?.investorWithdrawalFeePercent ?? 0}%</span>
                  </div>
                </div>
                
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Flat Withdrawal Fee (₦)
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Fixed flat fee added to every withdrawal
                    </span>
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      className="velo-input !pl-12"
                      value={withdrawalFeeFlatNaira}
                      onChange={(e) => setWithdrawalFeeFlatNaira(Number(e.target.value))}
                    />
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">
                      ₦{Math.round((platformSettings?.investorWithdrawalFeeFlatMinor ?? 0) / 100).toLocaleString("en-NG")}
                    </span>
                  </div>
                </div>
                
                <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4">
                  <label className="text-xs font-bold text-slate-700 block mb-2">
                    Default Investment Annual Rate
                    <span className="text-[10px] font-normal text-slate-500 block mb-1">
                      Default rate used when no plan rate or override is set
                    </span>
                  </label>
                  <div className="relative">
                    <input
                      type="number"
                      step="0.25"
                      min="0"
                      max="100"
                      className="velo-input pr-8"
                      value={defaultAnnualRate}
                      onChange={(e) => setDefaultAnnualRate(Number(e.target.value))}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                  </div>
                  <div className="mt-3 pt-3 border-t border-slate-100 flex justify-between text-[11px]">
                    <span className="text-slate-500">Current</span>
                    <span className="font-extrabold text-emerald-600">{platformSettings?.defaultInvestmentAnnualRatePercent ?? 0}%</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(59,130,246,0.12)] rounded-2xl border-t-4 border-blue-500">
                <h3 className="text-md font-extrabold text-velo-900 mb-1 flex items-center gap-2">
                  <Icon name="chart" size={20} />Set Custom Earning Rate per Investor
                </h3>
                <p className="text-xs text-slate-500 mb-4">Override the default earning rate for a specific investor.</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Select Investor</label>
                    <select
                      className="velo-input text-sm"
                      value={earningInvestorId}
                      onChange={(e) => setEarningInvestorId(e.target.value)}
                      disabled={investorsLoading}
                    >
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.fullName} — {inv.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Annual Earning Rate (%)</label>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max="100"
                        className="velo-input pr-8"
                        value={earningRatePercent}
                        onChange={(e) => setEarningRatePercent(Number(e.target.value))}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                    </div>
                  </div>
                  <button
                    onClick={handleSaveEarningRate}
                    disabled={earningRateSaving}
                    className="btn-primary w-full !py-2.5 !font-extrabold text-sm"
                  >
                    {earningRateSaving ? "Saving…" : <><Icon name="check" size={14} />Save Custom Earning Rate</>}
                  </button>
                  {earningRateMsg && <div className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${earningRateMsg.startsWith("Error:") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}><Icon name={earningRateMsg.startsWith("Error:") ? "alert" : "check"} size={14} />{earningRateMsg.replace(/^Error: /, "")}</div>}
                </div>
              </div>
              
              <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(245,158,11,0.12)] rounded-2xl border-t-4 border-amber-500">
                <h3 className="text-md font-extrabold text-velo-900 mb-1 flex items-center gap-2">
                  <Icon name="wallet" size={20} />Credit Investor Wallet
                </h3>
                <p className="text-xs text-slate-500 mb-4">Manually add funds to an investor's wallet (admin ledger is debited, investor credited).</p>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Select Investor</label>
                    <select
                      className="velo-input text-sm"
                      value={creditInvestorId}
                      onChange={(e) => setCreditInvestorId(e.target.value)}
                      disabled={investorsLoading}
                    >
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {inv.fullName} — {inv.email}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1.5">Amount (₦)</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                        <input
                          type="number"
                          min="100"
                          className="velo-input !pl-12"
                          value={creditAmountNaira}
                          onChange={(e) => setCreditAmountNaira(e.target.value)}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs font-bold text-slate-700 block mb-1.5">Reason</label>
                      <select
                        className="velo-input text-sm"
                        value={creditReason}
                        onChange={(e) => setCreditReason(e.target.value as any)}
                      >
                        <option value="MANUAL_CREDIT">Manual Credit</option>
                        <option value="INVESTMENT_RETURN">Investment Return</option>
                        <option value="BONUS">Bonus</option>
                        <option value="CORRECTION">Correction</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1.5">Description (optional)</label>
                    <input
                      type="text"
                      className="velo-input text-sm"
                      placeholder="Optional note to investor"
                      value={creditDescription}
                      onChange={(e) => setCreditDescription(e.target.value)}
                    />
                  </div>
                  <button
                    onClick={handleCreditInvestor}
                    disabled={creditSaving}
                    className="btn-primary w-full !py-2.5 !font-extrabold text-sm !bg-gradient-to-r !from-emerald-500 !to-emerald-600 hover:!from-emerald-600 hover:!to-emerald-700"
                  >
                    {creditSaving ? "Processing…" : <><Icon name="check" size={14} />Credit Investor Wallet</>}
                  </button>
                  {creditMsg && <div className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold ${creditMsg.startsWith("Error:") ? "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400" : "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400"}`}><Icon name={creditMsg.startsWith("Error:") ? "alert" : "check"} size={14} />{creditMsg.replace(/^Error: /, "")}</div>}
                </div>
              </div>
            </div>
            </div>
          )}

          {/* ============ PENDING WITHDRAWALS ============ */}
          {showWithdrawals && (
          <div className={`space-y-6 ${showLedger ? "lg:col-span-2" : "lg:col-span-3"}`}>
            <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(168,85,247,0.12)] rounded-2xl border-l-4 border-purple-500 dark:bg-slate-900 dark:border-slate-800 dark:shadow-none">
              <div className="flex items-start justify-between mb-4 flex-wrap gap-3">
                <div>
                  <h3 className="text-md font-extrabold text-velo-900 dark:text-white flex items-center gap-2">
                    <Icon name="clock" size={20} />Pending Investor Withdrawals
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Monitor investor withdrawals. Failed payouts can be retried from here.
                  </p>
                </div>
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400 text-xs font-bold border border-amber-100 dark:border-amber-900/40">
                  {withdrawals.filter(w => w.status === "FAILED").length} failed
                </span>
              </div>
              {withdrawalsLoading ? (
                <div className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center">Loading withdrawals…</div>
              ) : withdrawals.length === 0 ? (
                <div className="text-sm text-slate-500 dark:text-slate-400 py-8 text-center rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800">No withdrawal requests yet.</div>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400 text-xs uppercase">
                      <tr>
                        <th className="text-left p-3 font-bold">Investor</th>
                        <th className="text-right p-3 font-bold">Amount</th>
                        <th className="text-right p-3 font-bold">Fee</th>
                        <th className="text-right p-3 font-bold">Net</th>
                        <th className="text-left p-3 font-bold">Bank</th>
                        <th className="text-left p-3 font-bold">Status</th>
                        <th className="text-right p-3 font-bold">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {withdrawals.slice(0, 20).map((w) => (
                        <tr key={w.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="p-3">
                            <div className="font-bold text-velo-900 dark:text-white">{investors.find(i => i.id === w.investorId)?.fullName || w.investorId.slice(0, 8)}</div>
                            <div className="text-[10px] text-slate-500 dark:text-slate-400">{new Date(w.createdAt).toLocaleDateString()}</div>
                          </td>
                          <td className="p-3 text-right font-bold dark:text-slate-200">₦{Number(w.amountNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3 text-right text-red-600 dark:text-red-400 font-semibold">-₦{Number(w.feeNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3 text-right font-extrabold text-emerald-700 dark:text-emerald-400">₦{Number(w.netNaira).toLocaleString("en-NG")}</td>
                          <td className="p-3 dark:text-slate-200">
                            <div className="font-semibold">{w.bankName}</div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">••••••{w.accountNumber.slice(-4)}</div>
                          </td>
                          <td className="p-3">
                            <span className={`inline-flex px-2 py-1 rounded-full text-[10px] font-bold ${
                              w.status === "SUCCESSFUL" ? "bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400" :
                              w.status === "PENDING_APPROVAL" ? "bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400" :
                              w.status === "PROCESSING" ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400" :
                              w.status === "REJECTED" ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400" :
                              w.status === "FAILED" ? "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400" :
                              "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                            }`}>
                              {String(w.status).replace(/_/g, " ")}
                            </span>
                          </td>
                          <td className="p-3 text-right">
                            {w.status === "FAILED" && (
                              <button
                                onClick={() => handleRetryWithdrawal(w.id)}
                                disabled={withdrawalActioning === w.id}
                                className="inline-flex items-center px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-bold transition"
                              >
                                <Icon name="history" size={13} />{withdrawalActioning === w.id ? "Retrying…" : "Retry"}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
          )}

          {/* ============ RIGHT SIDEBAR — Admin Ledger ============ */}
          {showLedger && (
          <div className={`space-y-6 ${showInvestorTools || showWithdrawals ? "lg:col-span-1" : "lg:col-span-3"}`}>
            <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(6,78,59,0.18)] dark:shadow-none rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 text-white overflow-hidden relative">
              <div className="absolute -top-10 -right-10 w-36 h-36 rounded-full bg-white/5 blur-xl"></div>
              <div className="absolute bottom-0 right-10 w-24 h-24 rounded-full bg-emerald-400/20 blur-xl"></div>
              <div className="relative">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-100/80">Admin Ledger Balance</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 text-[10px] font-bold text-emerald-50 border border-white/10">
                    <Icon name="check" size={12} />SYNCED
                  </span>
                </div>
                <div className="mt-1 text-3xl sm:text-4xl font-black tracking-tight">
                  {adminLedgerBalance !== null ? "₦" + Math.round(adminLedgerBalance / 100).toLocaleString("en-NG") : "—"}
                </div>
                <div className="mt-1 text-[11px] text-emerald-100/70">
                  Funds available for investor funding &amp; payouts
                </div>
                <div className="mt-4 pt-4 border-t border-white/10 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-100/70 font-bold mb-0.5">Debits today</div>
                    <div className="text-lg font-extrabold">₦0.00</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-emerald-100/70 font-bold mb-0.5">Last updated</div>
                    <div className="text-sm font-bold">{platformSettings?.updatedAt ? new Date(platformSettings.updatedAt).toLocaleDateString() : "—"}</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="velo-card p-4 sm:p-5 lg:p-6 border-0 shadow-[0_20px_60px_-20px_rgba(15,23,42,0.12)] dark:shadow-none rounded-2xl dark:bg-slate-900 dark:border-slate-800">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-md font-extrabold text-velo-900 dark:text-white flex items-center gap-2">
                    <Icon name="history" size={18} />Admin Ledger Activity
                  </h3>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Debit/Credit entries for all investment ops</p>
                </div>
                <select
                  value={ledgerFilter}
                  onChange={(e) => setLedgerFilter(e.target.value)}
                  className="text-[10px] rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1 text-slate-600 dark:text-slate-300 font-bold focus:outline-none focus:ring-1 focus:ring-velo-500"
                >
                  <option value="">All</option>
                  <option value="INVESTOR_FUNDING">Investor Funding</option>
                  <option value="INVESTMENT_PAYOUT">Investment Payouts</option>
                  <option value="WITHDRAWAL_FEE">Withdrawal Fees</option>
                  <option value="REVERSAL">Reversals</option>
                </select>
              </div>
              {ledgerLoading ? (
                <div className="text-sm text-slate-500 dark:text-slate-400 py-6 text-center">Loading ledger…</div>
              ) : (
                <div className="space-y-2.5 max-h-[480px] overflow-y-auto pr-1">
                  {ledgerEntries
                    .filter(e => !ledgerFilter || e.entryType === ledgerFilter)
                    .map((e) => (
                      <div
                        key={e.id}
                        onClick={() => setSelectedLedgerEntry(e as AdminLedgerEntry)}
                        className="flex items-start gap-3 p-3 rounded-xl border border-slate-100 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:shadow-md cursor-pointer transition"
                      >
                        <div className={`mt-0.5 inline-flex h-7 w-7 items-center justify-center rounded-lg flex-shrink-0 ${e.direction === "DEBIT" ? "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400" : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400"}`}>
                          <Icon name={e.direction === "DEBIT" ? "arrowDown" : "arrowUp"} size={15} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-bold text-xs text-velo-900 dark:text-white truncate">
                              {String(e.entryType).replace(/_/g, " ")}
                            </div>
                            <div className={`font-black text-xs whitespace-nowrap ${e.direction === "DEBIT" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                              {e.direction === "DEBIT" ? "-" : "+"}₦{Math.round(e.amountMinor / 100).toLocaleString("en-NG")}
                            </div>
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400 line-clamp-1">
                            {e.description || "—"}
                          </div>
                          <div className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                            {new Date(e.createdAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                  {ledgerEntries.filter(e => !ledgerFilter || e.entryType === ledgerFilter).length === 0 && (
                    <div className="text-xs text-slate-500 dark:text-slate-400 text-center py-6 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-100 dark:border-slate-800">
                      No ledger entries match this filter.
                    </div>
                  )}
                </div>
              )}

              {!ledgerLoading && ledgerTotal > 0 && (
                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
                  <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
                    Showing {ledgerOffset + 1}–{Math.min(ledgerOffset + LEDGER_LIMIT, ledgerTotal)} of {ledgerTotal} entries
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => {
                        const next = Math.max(0, ledgerOffset - LEDGER_LIMIT);
                        setLedgerOffset(next);
                        void reloadLedger(next, ledgerFilter);
                      }}
                      disabled={ledgerOffset === 0}
                      className="px-2.5 py-1 text-[10px] font-bold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      <span className="inline-flex items-center gap-1"><Icon name="arrowLeft" size={12} />Prev</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const next = Math.min(Math.max(0, ledgerTotal - LEDGER_LIMIT), ledgerOffset + LEDGER_LIMIT);
                        setLedgerOffset(next);
                        void reloadLedger(next, ledgerFilter);
                      }}
                      disabled={ledgerOffset + LEDGER_LIMIT >= ledgerTotal}
                      className="px-2.5 py-1 text-[10px] font-bold rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
                    >
                      <span className="inline-flex items-center gap-1">Next<Icon name="arrowRight" size={12} /></span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          )}

          {selectedLedgerEntry !== null && (
            <div className="fixed inset-0 z-[60] bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 sm:p-6 animate-fade-in" onClick={() => setSelectedLedgerEntry(null)}>
              <div className="velo-card max-w-lg w-full max-h-[90vh] overflow-y-auto rounded-2xl border-0 shadow-elevated dark:bg-slate-900 dark:border-slate-800 animate-slide-in-left" onClick={(ev) => ev.stopPropagation()}>
                <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-start justify-between gap-4 sticky top-0 bg-white dark:bg-slate-900 z-10 rounded-t-2xl">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${selectedLedgerEntry.direction === "DEBIT" ? "bg-red-50 text-red-600" : "bg-emerald-50 text-emerald-600"}`}>
                        <Icon name={selectedLedgerEntry.direction === "DEBIT" ? "arrowDown" : "arrowUp"} size={14} />
                      </span>
                      <h3 className="text-base font-black text-velo-900 dark:text-white">Ledger Entry Details</h3>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Full transaction breakdown and metadata</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedLedgerEntry(null)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 font-bold"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>

                <div className="p-5 space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/60">
                      <div className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider mb-0.5">Entry Type</div>
                      <div className="text-sm font-black text-velo-900 dark:text-white">{String(selectedLedgerEntry.entryType).replace(/_/g, " ")}</div>
                    </div>
                    <div className="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700/60">
                      <div className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider mb-0.5">Direction</div>
                      <div className={`text-sm font-black ${selectedLedgerEntry.direction === "DEBIT" ? "text-red-600" : "text-emerald-600"}`}>{selectedLedgerEntry.direction}</div>
                    </div>
                  </div>

                  <div className={`p-4 rounded-2xl ${selectedLedgerEntry.direction === "DEBIT" ? "bg-red-50 dark:bg-red-950/40 border border-red-100 dark:border-red-900/50" : "bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-100 dark:border-emerald-900/50"}`}>
                    <div className="text-[10px] uppercase font-bold tracking-wider mb-1 opacity-70" style={{ color: selectedLedgerEntry.direction === "DEBIT" ? "#991b1b" : "#065f46" }}>
                      Transaction Amount
                    </div>
                    <div className={`text-2xl font-black ${selectedLedgerEntry.direction === "DEBIT" ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {selectedLedgerEntry.direction === "DEBIT" ? "-" : "+"}₦{Math.round(selectedLedgerEntry.amountMinor / 100).toLocaleString("en-NG")}
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Entry ID</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right font-mono break-all">{selectedLedgerEntry.id}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Created At</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right">{new Date(selectedLedgerEntry.createdAt).toLocaleString()}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Reference ID</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right font-mono">{selectedLedgerEntry.referenceId || "—"}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Investor ID</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right font-mono break-all">{selectedLedgerEntry.investorId || "—"}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Currency</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right">{selectedLedgerEntry.currency}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 dark:border-slate-800">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Balance After</span>
                      <span className="text-[11px] font-black text-emerald-700 dark:text-emerald-400 text-right">₦{Math.round(selectedLedgerEntry.balanceAfterMinor / 100).toLocaleString("en-NG")}</span>
                    </div>
                    <div className="flex items-start justify-between gap-3 py-2">
                      <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400 w-28 flex-shrink-0">Description</span>
                      <span className="text-[11px] font-bold text-velo-900 dark:text-white text-right">{selectedLedgerEntry.description || "—"}</span>
                    </div>
                  </div>

                  {selectedLedgerEntry.metadata && Object.keys(selectedLedgerEntry.metadata).length > 0 && (
                    <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                      <div className="text-[10px] uppercase font-bold text-slate-500 dark:text-slate-400 tracking-wider mb-2">Metadata</div>
                      <pre className="p-3 rounded-xl bg-slate-900 dark:bg-slate-950 text-emerald-400 text-[10px] leading-relaxed overflow-x-auto font-mono border border-slate-800">
                        {JSON.stringify(selectedLedgerEntry.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>

                <div className="p-4 border-t border-slate-100 dark:border-slate-800 sticky bottom-0 bg-white dark:bg-slate-900 rounded-b-2xl">
                  <button
                    type="button"
                    onClick={() => setSelectedLedgerEntry(null)}
                    className="btn-primary w-full !py-2.5 text-xs !font-extrabold"
                  >
                    Close Details
                  </button>
                </div>
              </div>
            </div>
          )}

      </div>
      </>
      )}

      {/* Bottom sticky save bar on mobile */}
      {showConfig && (<div className="lg:hidden sticky bottom-4 -mx-4 sm:-mx-6 px-4 sm:px-6 z-20">
        <div className="velo-card p-3 flex items-center gap-2 shadow-elevated rounded-2xl border-0 dark:bg-slate-900 dark:border-slate-800">
          <div className="flex-1 min-w-0">
            {saved ? (
              <div className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 dark:text-emerald-400"><Icon name="check" size={13} />Settings saved</div>
            ) : (
              <div className="text-xs text-slate-500 dark:text-slate-400">Click Save to persist changes</div>
            )}
          </div>
          <button type="button" onClick={handleSave} disabled={saving || formErrors.some((error) => error.severity === "error")} className="btn-primary !py-2 !px-4 text-xs !font-extrabold shrink-0">
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>)}
    </div>
  );
}

/* =======================================================================
   Small UI helpers
   ======================================================================= */

function Section({ title, subtitle, icon, children }: { title: string; subtitle?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="velo-card p-4 sm:p-5 lg:p-6 rounded-2xl border-0">
      <div className="mb-4">
        <div className="flex items-center gap-2">
          {icon && <span className="inline-flex text-velo-600 leading-none">{icon}</span>}
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
          className="velo-input !pl-12 font-bold text-sm"
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
        <div className="grid grid-cols-[minmax(7.5rem,0.9fr)_minmax(7rem,1fr)_auto] items-center gap-2">
          <select
            value={value.type}
            onChange={(e) => onChange({ ...value, type: e.target.value as "flat" | "percentage" })}
            className={`velo-input !py-2 text-xs font-bold w-full ${compact ? "!py-1.5 text-[10px]" : ""}`}
          >
            <option value="flat">Flat (₦)</option>
            <option value="percentage">Percentage (%)</option>
          </select>
          <input
            type="text"
            inputMode="decimal"
            value={value.value}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onChange({ ...value, value: 0 });
                return;
              }
              const next = Number(raw);
              if (Number.isFinite(next) && next >= 0) onChange({ ...value, value: next });
            }}
            className={`velo-input !py-2 text-base font-bold w-full min-w-0 ${compact ? "!py-1.5 text-sm" : ""}`}
          />
          <span className={`text-xs font-bold text-slate-500 lg:w-6 ${compact ? "text-[10px]" : ""}`}>
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
