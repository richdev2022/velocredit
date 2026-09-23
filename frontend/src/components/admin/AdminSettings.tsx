// ============================================================================
// src/components/admin/AdminSettings.tsx
// Platform Settings console — completely redesigned "admin console" layout.
//
// Visual language (see ./settingsUI.tsx): tabbed navigation, settings rows,
// toggle switches, segmented fee editors, naira-chip inputs. Fully responsive
// with explicit dark: variants.
//
// Functionality preserved 1:1 from the previous design:
//   - Backend-first save flow (PATCH loan products BEFORE localStorage write)
//   - 60s save timeout to tolerate Render cold starts, per-product errors
//   - Per-tenure fee overrides, global limits/fees toggles
//   - Platform settings (withdrawal fees, default investment rate)
//   - Investor tools (earning rate, wallet credit), withdrawals, ledger
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import {
  baseConfig,
  config as currentConfig,
  saveAdminOverrides,
  resetAdminOverrides,
  refreshConfig,
  sanitizeLoanLimits,
  safeNaira,
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
import type { TenureOption, FeeConfiguration, FeeKey, TenureFeeOverrides, LoanProgramConfig, LoanProgramKey } from "../../types/loan";
import ProgramEditor from "./ProgramEditor";
import ProductCatalogCard from "./ProductCatalogCard";
import Icon from "../Icon";
import { Pill, Toggle, SettingRow, NairaField, FeeEditor, Chip, PanelCard, type FeeValue } from "./settingsUI";

const FEE_LABELS: Record<FeeKey, string> = {
  interest: "Monthly Interest Rate",
  serviceFee: "Service Fee",
  processingFee: "Processing Fee",
  lateFee: "Default / Late Fee",
};

const FEE_DESCRIPTIONS: Record<FeeKey, string> = {
  interest: "Cost of borrowing, applied on the principal for the chosen tenure.",
  serviceFee: "One-off administration fee charged on the loan amount.",
  processingFee: "Deducted or charged at disbursement for processing the application.",
  lateFee: "Penalty applied when a repayment is missed or overdue.",
};

/** Per-tenure override state: Record<tenureDays, { enabled: boolean, fees }> */
type TenureFeeState = Record<number, {
  enabled: boolean;
  fees: Record<FeeKey, FeeValue>;
}>;

type SettingsTab = "programs" | "limits" | "fees" | "branding" | "system";

const SETTINGS_TABS: Array<{ key: SettingsTab; label: string; icon: React.ReactNode }> = [
  { key: "programs", label: "Loan Programs", icon: <Icon name="target" size={15} /> },
  { key: "limits", label: "Limits & Tenures", icon: <Icon name="money" size={15} /> },
  { key: "fees", label: "Fees & Charges", icon: <Icon name="chart" size={15} /> },
  { key: "branding", label: "Branding & Access", icon: <Icon name="bank" size={15} /> },
  { key: "system", label: "System", icon: <Icon name="lock" size={15} /> },
];

export default function AdminSettings(props?: { displaySection?: "all" | "ledger" | "withdrawals" | "investor-tools" }) {
  const displaySection: NonNullable<typeof props>["displaySection"] = props?.displaySection ?? "all";
  const showConfig = displaySection === "all";
  const showInvestorTools = displaySection === "investor-tools";
  const showWithdrawals = displaySection === "withdrawals";
  const showLedger = displaySection === "ledger";
  const [activeTab, setActiveTab] = useState<SettingsTab>("programs");
  // Initialize from the sanitized limits — a corrupt localStorage override or a
  // bad API response must never put undefined/NaN into these states (that used
  // to crash the whole Admin page inside the formErrors useMemo with
  // "Cannot read properties of undefined (reading 'toLocaleString')").
  const safeInitLimits = sanitizeLoanLimits(currentConfig?.loanLimits);
  const [min, setMin] = useState(safeInitLimits.min);
  const [max, setMax] = useState(safeInitLimits.max);
  const [defaultAmount, setDefaultAmount] = useState(safeInitLimits.defaultAmount);
  const [globalLimitsEnabled, setGlobalLimitsEnabled] = useState(currentConfig.globalLimitsEnabled);
  // Unified single toggle: when ON, the four global fees (interest, serviceFee,
  // processingFee, lateFee) override every program. When OFF, each program uses
  // its own per-program fee configuration. We still persist both legacy flags
  // (globalFeesEnabled / globalInterestEnabled) for backward compatibility,
  // but they are always written with the same value.
  const [globalTransactionsEnabled, setGlobalTransactionsEnabled] = useState(
    Boolean(currentConfig.globalFeesEnabled) && Boolean(currentConfig.globalInterestEnabled),
  );
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

  const [fees, setFees] = useState<Record<FeeKey, FeeValue>>(() => ({
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

  // Loan product catalog — rendered by the self-contained ProductCatalogCard
  // (every product fully editable + activatable + creatable). refreshSignal is
  // bumped whenever the program save flow creates/patches backend products so
  // the catalog card re-fetches and stays in sync.
  const [catalogRefresh, setCatalogRefresh] = useState(0);

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
    const baseTenures = Array.isArray(baseConfig?.tenures) ? baseConfig.tenures : [];
    const currentTenures = Array.isArray(currentConfig?.tenures) ? currentConfig.tenures : [];
    const values = new Set([...baseTenures, ...currentTenures].map((tenure) => tenure?.value).filter((v) => Number.isFinite(v)));
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
    // Guard against undefined/NaN — Math.min/max with undefined yields NaN and
    // would silently poison the preview panel.
    const nMin = Number.isFinite(Number(min)) ? Number(min) : baseConfig.loanLimits.min;
    const nMax = Number.isFinite(Number(max)) ? Number(max) : baseConfig.loanLimits.max;
    const lo = Math.min(nMin, nMax);
    const hi = Math.max(nMin, nMax);
    const nDef = Number.isFinite(Number(defaultAmount)) ? Number(defaultAmount) : lo;
    const safeDef = Math.min(Math.max(nDef, lo), hi);
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
    // Coerce states through Number() first — they can transiently hold NaN/
    // undefined from input parsing. Use safeNaira() so formatting never throws
    // even when a value is still undefined.
    const nMin = Number(min);
    const nMax = Number(max);
    const nDefault = Number(defaultAmount);
    const minFinite = Number.isFinite(nMin);
    const maxFinite = Number.isFinite(nMax);
    const defFinite = Number.isFinite(nDefault);
    if (!minFinite || !maxFinite) {
      errs.push({ key: "LOAN_LIMITS", message: "Minimum and Maximum loan amounts must be valid numbers.", severity: "error" });
    } else if (!(nMin < nMax)) {
      errs.push({ key: "LOAN_LIMITS", message: `Minimum (₦${safeNaira(nMin)}) must be less than Maximum (₦${safeNaira(nMax)}).`, severity: "error" });
    }
    if (minFinite && maxFinite && defFinite && (nDefault < nMin || nDefault > nMax)) {
      errs.push({ key: "LOAN_DEFAULT", message: `Default amount (₦${safeNaira(nDefault)}) must be between min (₦${safeNaira(nMin)}) and max (₦${safeNaira(nMax)}).`, severity: "error" });
    } else if (!defFinite) {
      errs.push({ key: "LOAN_DEFAULT", message: "Default loan amount must be a valid number.", severity: "error" });
    }
    if (tenures.length === 0) {
      errs.push({ key: "TENURES", message: "Select at least one repayment tenure.", severity: "error" });
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
    const nMin = Number.isFinite(Number(patch.min)) ? Number(patch.min)
      : Number.isFinite(Number(min)) ? Number(min) : baseConfig.loanLimits.min;
    const nMax = Number.isFinite(Number(patch.max)) ? Number(patch.max)
      : Number.isFinite(Number(max)) ? Number(max) : baseConfig.loanLimits.max;
    const nDef = Number.isFinite(Number(patch.defaultAmount)) ? Number(patch.defaultAmount)
      : Number.isFinite(Number(defaultAmount)) ? Number(defaultAmount) : nMin;
    const limits = { min: nMin, max: nMax, defaultAmount: nDef };
    if (patch.min !== undefined) setMin(nMin);
    if (patch.max !== undefined) setMax(nMax);
    if (patch.defaultAmount !== undefined) setDefaultAmount(nDef);
    setPrograms((current) => ({
      PERSONAL: { ...current.PERSONAL, loanLimits: limits },
      BUSINESS: { ...current.BUSINESS, loanLimits: limits },
    }));
  }

  async function withSaveTimeout<T>(operation: Promise<T>, timeoutMs = 60000): Promise<T> {
    let timeoutId: number | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Saving configuration timed out. The backend may be cold-starting — please try again in a moment.")), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
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
      globalLimitsEnabled,
      globalFeesEnabled: globalTransactionsEnabled,
      globalInterestEnabled: globalTransactionsEnabled,
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
    setSaved(false);
    setSaveError("");
    try {
      const activePrograms = Object.fromEntries(
        (Object.entries(programs) as Array<[LoanProgramKey, LoanProgramConfig]>).map(([type, program]) => [type, {
          ...program,
          loanLimits: globalLimitsEnabled ? { min: Number(min) || 0, max: Number(max) || 0, defaultAmount: Number(defaultAmount) || 0 } : program.loanLimits,
          fees: globalTransactionsEnabled
            ? { ...program.fees, ...fees }
            : { ...program.fees },
        }]),
      ) as Record<LoanProgramKey, LoanProgramConfig>;
      overrides.loanPrograms = activePrograms;

      // ===== Push to backend FIRST, then write to localStorage only on success =====
      // This ensures the admin's localStorage doesn't get out of sync with the
      // backend. If the backend PATCH fails (timeout, 404, 503, etc.), we
      // surface the error and DON'T write to localStorage — so the admin
      // knows the save didn't land and can retry.
      const patchErrors: string[] = [];
      await withSaveTimeout((async () => {
        const products = (await adminListLoanProducts()).products;
        for (const [type, program] of Object.entries(activePrograms) as Array<[LoanProgramKey, LoanProgramConfig]>) {
          // Staged matching, best bind first:
          //   1. the product this program is BOUND to by its live name (set by
          //      applyLoanProducts — rename-safe), then
          //   2. an ACTIVE product whose name carries the type keyword, then
          //   3. any product with the keyword.
          // Never a blanket OR-chain: that could bind the program to the wrong
          // (inactive/stale) product when several names share the keyword.
          const keyword = type === "PERSONAL" ? /personal/i : /business/i;
          const existing
            = (program.productName
              ? products.find((product: any) => String(product.name).toLowerCase() === String(program.productName).toLowerCase())
              : undefined)
            ?? products.find((product: any) => product.isActive && keyword.test(product.name))
            ?? products.find((product: any) => keyword.test(product.name));
          // Preserve the admin's product NAME on update — forcing the name back
          // to "Personal/Business Loan" on every save renamed custom products,
          // tripped the duplicate-name guard (409) and desynced the binding.
          const productName = existing ? existing.name : `${type === "PERSONAL" ? "Personal" : "Business"} Loan`;
          const productInput = {
            name: productName,
            minAmountNaira: program.loanLimits.min,
            maxAmountNaira: program.loanLimits.max,
            defaultTenureDays: program.tenures[0]?.value || 30,
            interestRatePercent: program.fees.interest.value,
            interestType: "ANNUALIZED" as const,
            processingFeePercent: program.fees.processingFee.type === "percentage" ? program.fees.processingFee.value : 0,
            lateFeePercent: program.fees.lateFee.type === "percentage" ? program.fees.lateFee.value : 0,
            isActive: existing?.isActive ?? true,
          };
          try {
            if (existing) await adminPatchLoanProduct(existing.id, productInput);
            else await adminCreateLoanProduct(productInput);
          } catch (err) {
            patchErrors.push(`${type}: ${err instanceof Error ? err.message : "unknown error"}`);
          }
        }
      })());

      if (patchErrors.length > 0) {
        throw new Error(`Backend save failed for: ${patchErrors.join("; ")}. Local settings were NOT saved — please retry.`);
      }

      // Only write to localStorage + refreshConfig AFTER the backend succeeded.
      saveAdminOverrides(overrides);
      refreshConfig(overrides);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      // The save flow may have created/patched backend products — bump the
      // catalog card so it re-fetches the authoritative list.
      setCatalogRefresh((v) => v + 1);
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
      setMin(currentConfig.loanLimits?.min ?? baseConfig.loanLimits.min);
      setMax(currentConfig.loanLimits?.max ?? baseConfig.loanLimits.max);
      setDefaultAmount(currentConfig.loanLimits?.defaultAmount ?? baseConfig.loanLimits.defaultAmount);
      setGlobalLimitsEnabled(true);
      setGlobalTransactionsEnabled(true);
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

  const saveDisabled = saving || formErrors.some((error) => error.severity === "error");

  return (
    <div className="space-y-5">
      {showConfig && (
        <>
          {/* ===== Console header ===== */}
          <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 text-white shadow-elevated">
            <div className="pointer-events-none absolute -right-20 -top-24 h-64 w-64 rounded-full bg-velo-400/20 blur-3xl" />
            <div className="pointer-events-none absolute -bottom-24 -left-10 h-48 w-48 rounded-full bg-sky-400/10 blur-3xl" />
            <div className="relative flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3.5">
                <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09A1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-bold tracking-tight sm:text-xl">Platform Settings</h2>
                  <p className="mt-0.5 text-xs leading-5 text-white/70 sm:max-w-xl sm:text-[13px]">
                    Configure loan programs, limits, fees, branding and access — saved for every user on the platform.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {saving && (
                  <Pill tone="info"><span className="h-2 w-2 animate-pulse rounded-full bg-velo-400" />Saving…</Pill>
                )}
                {!saving && saved && (
                  <Pill tone="success" ><span className="flex h-3 w-3 items-center justify-center"><svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/></svg></span>Saved</Pill>
                )}
                {!saving && !saved && (
                  <span className="hidden items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-white/70 sm:inline-flex">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />Live for all users
                  </span>
                )}
                {!resetConfirm ? (
                  <button
                    type="button"
                    onClick={() => setResetConfirm(true)}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/20 bg-white/10 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-white/20 disabled:opacity-50"
                    disabled={saving}
                  >
                    Restore defaults
                  </button>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <button type="button" onClick={handleReset} disabled={saving} className="inline-flex items-center gap-1.5 rounded-xl bg-red-500 px-3.5 py-2 text-xs font-bold text-white shadow transition hover:bg-red-600 disabled:opacity-50">
                      Yes, reset all
                    </button>
                    <button type="button" onClick={() => setResetConfirm(false)} className="rounded-xl px-3 py-2 text-xs font-semibold text-white/80 transition hover:bg-white/10">
                      Cancel
                    </button>
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveDisabled}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-white px-4 py-2 text-xs font-bold text-velo-800 shadow-lg transition hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {saving ? (
                    <><span className="h-3 w-3 animate-spin rounded-full border-2 border-velo-600 border-t-transparent" />Saving…</>
                  ) : (
                    <><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/></svg>Save settings</>
                  )}
                </button>
              </div>
            </div>
          </div>

          {/* ===== Error surfaces ===== */}
          {saveError && (
            <div className="flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
              <Icon name="alert" size={18} />
              <div className="min-w-0 flex-1">{saveError}</div>
            </div>
          )}
          {formErrors.length > 0 && (
            <div className={`rounded-2xl border p-4 ${formErrors.some(e => e.severity === "error") ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/40" : "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/40"}`}>
              <div className={`mb-1.5 flex items-center gap-2 text-sm font-bold ${formErrors.some(e => e.severity === "error") ? "text-red-700 dark:text-red-300" : "text-amber-700 dark:text-amber-300"}`}>
                <Icon name="alert" size={15} />{formErrors.some(e => e.severity === "error") ? "Fix these before saving" : "Review these warnings"}
              </div>
              <ul className="space-y-1 text-xs">
                {formErrors.map((e, i) => (
                  <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                    <span className="mt-0.5 text-slate-400">•</span>
                    <span><strong className="font-semibold">{e.key}:</strong> {e.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* ===== Sticky tab bar ===== */}
          <div className="sticky top-14 z-20 -mx-1 bg-slate-50/95 px-1 py-2 backdrop-blur dark:bg-slate-950/95 sm:top-16">
            <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1 shadow-sm dark:border-slate-800 dark:bg-slate-900" role="tablist">
              {SETTINGS_TABS.map((tab) => {
                const active = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    role="tab"
                    aria-selected={active}
                    type="button"
                    onClick={() => setActiveTab(tab.key)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all duration-150 ${
                      active
                        ? "bg-velo-500 text-white shadow-sm"
                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
                    }`}
                  >
                    {tab.icon}
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ===== Tab content + context sidebar ===== */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <div className="min-w-0 space-y-5 xl:col-span-2">
              {activeTab === "programs" && (
                <>
                  {/* Fully editable catalog — every product (name, range,
                      tenure, interest + type, fees, grace period, active). */}
                  <ProductCatalogCard refreshSignal={catalogRefresh} />

                  <PanelCard
                    title="Loan programs"
                    description="Each program controls the limits, tenures, rates, fees and collateral rules its applicants see."
                    icon={<Icon name="target" size={18} />}
                    action={<Pill tone="info">2 application flows</Pill>}
                  >
                    <div className="space-y-4 py-2">
                      {(["PERSONAL", "BUSINESS"] as LoanProgramKey[]).map((type) => (
                        <ProgramEditor key={type} type={type} value={programs[type]} onChange={(value) => setPrograms((current) => ({ ...current, [type]: value }))} />
                      ))}
                    </div>
                  </PanelCard>
                </>
              )}

              {activeTab === "limits" && (
                <>
                  <PanelCard
                    title="Global loan limits"
                    description="Apply one range to both programs, or switch off to use each program's own limits."
                    icon={<Icon name="money" size={18} />}
                    action={<Toggle checked={globalLimitsEnabled} onChange={setGlobalLimitsEnabled} label={globalLimitsEnabled ? "Global" : "Per program"} />}
                  >
                    <div className={globalLimitsEnabled ? "" : "pointer-events-none opacity-50"}>
                      <div className="grid grid-cols-1 gap-4 py-3 sm:grid-cols-3">
                        <NairaField label="Minimum loan" value={min} onChange={(value) => updateGlobalLimits({ min: value })} />
                        <NairaField label="Maximum loan" value={max} onChange={(value) => updateGlobalLimits({ max: value })} />
                        <NairaField label="Default amount" value={defaultAmount} onChange={(value) => updateGlobalLimits({ defaultAmount: value })} helpText="Pre-selected on the application form" />
                      </div>
                    </div>
                    {!globalLimitsEnabled && (
                      <p className="pb-3 text-[11px] font-semibold text-amber-600 dark:text-amber-400">Per-program limits are edited on the Loan Programs tab.</p>
                    )}
                  </PanelCard>

                  <PanelCard
                    title="Repayment tenures"
                    description="Select the repayment periods available to borrowers."
                    icon={<Icon name="calendar" size={18} />}
                    action={<Pill tone={tenures.length === 0 ? "danger" : "neutral"}>{tenures.length} selected</Pill>}
                  >
                    <div className="flex flex-wrap gap-2 py-3">
                      {tenureOptions.map((tenure) => (
                        <Chip
                          key={tenure.value}
                          selected={selectedTenures.includes(tenure.value)}
                          onClick={() => setSelectedTenures((current) =>
                            current.includes(tenure.value)
                              ? current.filter((value) => value !== tenure.value)
                              : [...current, tenure.value].sort((a, b) => a - b)
                          )}
                        >
                          {tenure.value} days
                        </Chip>
                      ))}
                    </div>
                    {tenures.length === 0 && <p className="pb-3 text-xs font-semibold text-red-600">Select at least one tenure.</p>}
                  </PanelCard>

                  <PanelCard
                    title="Per-tenure fee overrides"
                    description="Optional: give specific tenors their own fee schedule. Fees left unchanged inherit from the global fees."
                    icon={<Icon name="chart" size={18} />}
                  >
                    <div className="space-y-3 py-3">
                      {tenures.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                          Select tenures above to configure per-tenure fees.
                        </div>
                      )}
                      {tenures.map((t) => {
                        const state = tenureFeesSynced[t.value];
                        if (!state) return null;
                        return (
                          <div
                            key={t.value}
                            className={`overflow-hidden rounded-2xl border transition-all duration-200 ${
                              state.enabled
                                ? "border-velo-300 bg-velo-50/50 dark:border-velo-700 dark:bg-velo-900/20"
                                : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3 p-3.5">
                              <div className="flex items-center gap-3">
                                <Toggle size="sm" checked={state.enabled} onChange={(on) => setTenureFees({ ...tenureFeesSynced, [t.value]: { ...state, enabled: on } })} />
                                <div>
                                  <div className="text-sm font-bold text-velo-900 dark:text-white">{t.value} days</div>
                                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                                    {state.enabled ? "Custom fees active for this tenure" : "Using global fees (inherited)"}
                                  </div>
                                </div>
                              </div>
                              <Pill tone={state.enabled ? "info" : "neutral"}>{state.enabled ? "CUSTOM" : "GLOBAL"}</Pill>
                            </div>
                            {state.enabled && (
                              <div className="grid grid-cols-1 gap-3 border-t border-velo-100 p-3.5 dark:border-velo-800/60 md:grid-cols-2">
                                {(Object.keys(FEE_LABELS) as FeeKey[]).map((k) => (
                                  <FeeEditor
                                    key={k}
                                    label={FEE_LABELS[k]}
                                    value={state.fees[k]}
                                    baseline={fees[k]}
                                    baselineLabel="Global"
                                    onChange={(v) => setTenureFees({ ...tenureFeesSynced, [t.value]: { ...state, fees: { ...state.fees, [k]: v } } })}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </PanelCard>
                </>
              )}

              {activeTab === "fees" && (
                <PanelCard
                  title="Global fees & charges"
                  description="When global fees are ON, the four fees below override every loan program. When OFF, each program uses its own per-program fees."
                  icon={<Icon name="chart" size={18} />}
                  action={<Toggle checked={globalTransactionsEnabled} onChange={setGlobalTransactionsEnabled} label={globalTransactionsEnabled ? "Global" : "Per program"} />}
                >
                  <div className={globalTransactionsEnabled ? "space-y-4 py-3" : "space-y-4 py-3"}>
                    {(Object.keys(FEE_LABELS) as FeeKey[]).map((k) => (
                      <FeeEditor
                        key={k}
                        label={FEE_LABELS[k]}
                        description={FEE_DESCRIPTIONS[k]}
                        value={fees[k]}
                        baseline={baseConfig.fees[k]}
                        baselineLabel="default"
                        onChange={(v) => setFees({ ...fees, [k]: v })}
                      />
                    ))}
                  </div>
                  {!globalTransactionsEnabled && (
                    <p className="pb-3 text-[11px] font-semibold text-amber-600 dark:text-amber-400">Per-program fees are edited on the Loan Programs tab.</p>
                  )}
                </PanelCard>
              )}

              {activeTab === "branding" && (
                <PanelCard
                  title="Company, branding & access"
                  description="Displayed throughout the loan portal, emails and agreement documents."
                  icon={<Icon name="bank" size={18} />}
                >
                  <div className="py-1">
                    <SettingRow label="Company name" description="Legal entity name shown on agreements and receipts.">
                      <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="velo-input text-sm" />
                    </SettingRow>
                    <SettingRow label="Company website" description="Shown in the portal footer and documents (no protocol).">
                      <input type="text" value={companyWebsite} onChange={(e) => setCompanyWebsite(e.target.value)} className="velo-input text-sm" placeholder="www.yourcompany.com" />
                    </SettingRow>
                    <SettingRow label="Brand logo URL" description="Used in navigation, SEO, emails and agreements." stacked>
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <input type="url" value={brandLogoUrl} onChange={(e) => setBrandLogoUrl(e.target.value)} className="velo-input text-sm" placeholder="https://.../logo.png" />
                        <div className="flex h-12 w-32 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-800">
                          {brandLogoUrl ? <img src={brandLogoUrl} alt="Brand preview" className="max-h-10 max-w-full object-contain" /> : <span className="text-[10px] text-slate-400">No logo</span>}
                        </div>
                      </div>
                    </SettingRow>
                    <SettingRow label="Authorised signatory" description="Name and position printed on loan agreements.">
                      <div className="space-y-2">
                        <input type="text" value={lenderSignatoryName} onChange={(e) => setLenderSignatoryName(e.target.value)} className="velo-input text-sm" placeholder="Full name" />
                        <input type="text" value={lenderSignatoryPosition} onChange={(e) => setLenderSignatoryPosition(e.target.value)} className="velo-input text-sm" placeholder="e.g. Director" />
                      </div>
                    </SettingRow>
                    <SettingRow label="Signatory signature URL" description="Signature image appended to agreements.">
                      <input type="url" value={lenderSignatorySignatureUrl} onChange={(e) => setLenderSignatorySignatureUrl(e.target.value)} className="velo-input text-sm" placeholder="https://.../signature.png" />
                    </SettingRow>
                    <SettingRow label="Frontend API URL" description="Takes effect after a page reload.">
                      <input type="url" value={apiUrl} onChange={(e) => setApiUrl(e.target.value.replace(/\/$/, ""))} className="velo-input text-sm" placeholder="https://api.example.com" />
                    </SettingRow>
                    <SettingRow label="Administrator emails" description="Receive loan notifications; can use password reset." stacked>
                      <input type="text" value={adminEmails} onChange={(e) => setAdminEmails(e.target.value)} className="velo-input text-sm" placeholder="admin@company.com, owner@company.com" />
                    </SettingRow>
                    <SettingRow label="Loan manager emails" description="Comma-separated recipients for applications and status updates." stacked last>
                      <input type="text" value={loanManagerEmails} onChange={(e) => setLoanManagerEmails(e.target.value)} className="velo-input text-sm" placeholder="manager@company.com, team@company.com" />
                    </SettingRow>
                  </div>
                </PanelCard>
              )}

              {activeTab === "system" && (
                <PanelCard
                  title="Environment & integrations"
                  description="Deployment-controlled values, shown for visibility only."
                  icon={<Icon name="lock" size={18} />}
                >
                  <div className="grid gap-3 py-3 sm:grid-cols-2">
                    {[
                      ["Database", "Server secret"],
                      ["JWT signing", "Server secret"],
                      ["Flutterwave", "Payment provider"],
                      ["Prembly", "Identity provider"],
                      ["Google Drive", "Document storage"],
                      ["Brevo / KUDI / Meta", "Notifications"],
                      ["Loan policy", "Eligibility thresholds"],
                      ["Reminder schedule", "Repayment notifications"],
                    ].map(([name, category]) => (
                      <div key={name} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3.5 py-3 dark:border-slate-700">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-velo-900 dark:text-white">{name}</div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400">{category}</div>
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Backend
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="border-t border-slate-100 py-3 text-[11px] leading-5 text-slate-500 dark:border-slate-800 dark:text-slate-400">
                    Provider keys, database credentials, admin passwords, JWT secrets, storage and webhook secrets are configured in the deployment environment and are intentionally never exposed to the browser.
                  </p>
                </PanelCard>
              )}
            </div>

            {/* ===== Context sidebar ===== */}
            <div className="min-w-0 space-y-5">
              {(activeTab === "limits" || activeTab === "fees" || activeTab === "programs") && (
                <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-velo-900 via-velo-800 to-velo-700 p-5 text-white shadow-elevated">
                  <div className="pointer-events-none absolute -right-12 -top-12 h-40 w-40 rounded-full bg-velo-300/20 blur-2xl" />
                  <div className="relative">
                    <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[10px] font-bold tracking-wider">
                      <Icon name="sparkles" size={11} />LIVE PREVIEW
                    </span>
                    <h3 className="mb-0.5 text-sm font-bold">Sample calculation</h3>
                    <p className="mb-4 text-[11px] text-white/70">Default amount × middle tenure, using global fees.</p>
                    <div className="mb-3 space-y-1">
                      <PreviewRow label="Principal" value={formatNaira(previewCalc.loanAmount)} />
                      <PreviewRow label="Interest" value={formatNaira(previewCalc.interest)} />
                      <PreviewRow label="Service Fee" value={formatNaira(previewCalc.serviceFee)} />
                      <PreviewRow label="Processing Fee" value={formatNaira(previewCalc.processingFee)} />
                      {previewCalc.lateFee > 0 && <PreviewRow label="Default Fee (if any)" value={formatNaira(previewCalc.lateFee)} muted />}
                    </div>
                    <div className="border-t border-white/15 pt-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-bold tracking-wider text-white/80">TOTAL REPAYMENT</span>
                        <span key={previewCalc.totalRepayment} className="animate-bounce-subtle text-xl font-bold tracking-tight sm:text-2xl">
                          {formatNaira(previewCalc.totalRepayment)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex justify-between text-[10px] text-white/70">
                        <span>Tenure: <strong className="text-white/90">{previewCalc.tenureLabel}</strong></span>
                        <span>Due: <strong className="text-white/90">{previewCalc.repaymentDateLabel || "…"}</strong></span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "branding" && (
                <PanelCard title="How branding is used" icon={<Icon name="sparkles" size={16} />}>
                  <ul className="space-y-2.5 py-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    {[
                      "The company name appears on agreements, receipts and emails.",
                      "The logo renders in the portal navigation and PDF documents.",
                      "The signatory block is printed on every loan agreement.",
                      "Admin emails receive application and status notifications.",
                    ].map((line) => (
                      <li key={line} className="flex gap-2">
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-velo-500" />{line}
                      </li>
                    ))}
                  </ul>
                </PanelCard>
              )}

              {activeTab === "system" && (
                <PanelCard title="Security model" icon={<Icon name="lock" size={16} />}>
                  <div className="space-y-2.5 py-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    <p>Secrets live only on the server. The browser admin console edits product configuration — never credentials.</p>
                    <p>To rotate a provider key or database credential, update the environment variables in your hosting dashboard and redeploy.</p>
                  </div>
                </PanelCard>
              )}

              <PanelCard title="How this works" icon={<Icon name="history" size={16} />}>
                <ol className="space-y-2.5 py-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
                  {[
                    "Settings are saved to the shared Velo configuration and pushed to the backend.",
                    "Every applicant receives the saved settings when the site loads.",
                    "Per-tenure fee schedules take precedence over the global fees.",
                    "Restore defaults returns to the deployed baseline configuration.",
                  ].map((line, i) => (
                    <li key={line} className="flex gap-2.5">
                      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-velo-100 text-[10px] font-bold text-velo-700 dark:bg-velo-900 dark:text-velo-300">{i + 1}</span>
                      {line}
                    </li>
                  ))}
                </ol>
              </PanelCard>
            </div>
          </div>
        </>
      )}

      {(showInvestorTools || showWithdrawals || showLedger) && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {/* ============ INVESTOR MANAGEMENT ============ */}
          {showInvestorTools && (
            <div className={`min-w-0 space-y-5 ${showLedger ? "lg:col-span-2" : "lg:col-span-3"}`}>
              <PanelCard
                title="Investor management"
                description="Global withdrawal fees, default investment earning rate, and per-investor overrides."
                icon={<Icon name="briefcase" size={18} />}
                tone="emerald"
                action={
                  <button onClick={handleSavePlatformSettings} disabled={platformLoading} className="btn-primary !py-2 !px-4 text-xs !font-bold">
                    {platformLoading ? "Saving…" : <><Icon name="save" size={14} />Save platform settings</>}
                  </button>
                }
              >
                {platformMessage && (
                  <div className="mb-1 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-700 animate-fade-in dark:border-emerald-900/50 dark:bg-emerald-950/40 dark:text-emerald-300">
                    <Icon name="check" size={14} />{platformMessage}
                  </div>
                )}
                {platformError && (
                  <div className="mb-1 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs font-semibold text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
                    <Icon name="alert" size={14} />{platformError}
                  </div>
                )}
                <SettingRow
                  label="Investor withdrawal fee (%)"
                  description="Percentage of the withdrawal amount charged as a fee."
                  last
                >
                  <div className="relative">
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="100"
                      className="velo-input pr-8 text-sm font-semibold"
                      value={withdrawalFeePercent}
                      onChange={(e) => setWithdrawalFeePercent(Number(e.target.value))}
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                  </div>
                </SettingRow>
              </PanelCard>

              <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                <PanelCard
                  title="Withdrawal fee (flat)"
                  description="Fixed fee added to every investor withdrawal."
                  icon={<Icon name="wallet" size={18} />}
                  tone="emerald"
                >
                  <div className="py-2">
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        className="velo-input !pl-9 text-sm font-semibold"
                        value={withdrawalFeeFlatNaira}
                        onChange={(e) => setWithdrawalFeeFlatNaira(Number(e.target.value))}
                      />
                    </div>
                    <div className="mt-3 flex justify-between border-t border-slate-100 pt-3 text-[11px] dark:border-slate-800">
                      <span className="text-slate-500">Currently saved</span>
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">
                        ₦{Math.round((platformSettings?.investorWithdrawalFeeFlatMinor ?? 0) / 100).toLocaleString("en-NG")}
                      </span>
                    </div>
                  </div>
                </PanelCard>

                <PanelCard
                  title="Default investment rate"
                  description="Annual rate used when no plan rate or override is set."
                  icon={<Icon name="chart" size={18} />}
                  tone="emerald"
                >
                  <div className="py-2">
                    <div className="relative">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max="100"
                        className="velo-input pr-8 text-sm font-semibold"
                        value={defaultAnnualRate}
                        onChange={(e) => setDefaultAnnualRate(Number(e.target.value))}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                    </div>
                    <div className="mt-3 flex justify-between border-t border-slate-100 pt-3 text-[11px] dark:border-slate-800">
                      <span className="text-slate-500">Currently saved</span>
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">{platformSettings?.defaultInvestmentAnnualRatePercent ?? 0}%</span>
                    </div>
                  </div>
                </PanelCard>

                <PanelCard
                  title="Custom earning rate"
                  description="Override the default annual earning rate for one investor."
                  icon={<Icon name="chart" size={18} />}
                  tone="sky"
                >
                  <div className="space-y-3 py-2">
                    <select className="velo-input text-sm" value={earningInvestorId} onChange={(e) => setEarningInvestorId(e.target.value)} disabled={investorsLoading}>
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>{inv.fullName} — {inv.email}</option>
                      ))}
                    </select>
                    <div className="relative">
                      <input
                        type="number"
                        step="0.25"
                        min="0"
                        max="100"
                        className="velo-input pr-8 text-sm font-semibold"
                        value={earningRatePercent}
                        onChange={(e) => setEarningRatePercent(Number(e.target.value))}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">%</span>
                    </div>
                    <button onClick={handleSaveEarningRate} disabled={earningRateSaving} className="btn-primary w-full !py-2.5 !font-bold text-sm">
                      {earningRateSaving ? "Saving…" : <><Icon name="check" size={14} />Save earning rate</>}
                    </button>
                    {earningRateMsg && <InlineMessage message={earningRateMsg} />}
                  </div>
                </PanelCard>

                <PanelCard
                  title="Credit investor wallet"
                  description="Add funds manually — the admin ledger is debited, the investor credited."
                  icon={<Icon name="wallet" size={18} />}
                  tone="amber"
                >
                  <div className="space-y-3 py-2">
                    <select className="velo-input text-sm" value={creditInvestorId} onChange={(e) => setCreditInvestorId(e.target.value)} disabled={investorsLoading}>
                      <option value="">{investorsLoading ? "Loading investors…" : "Select investor…"}</option>
                      {investors.map((inv) => (
                        <option key={inv.id} value={inv.id}>{inv.fullName} — {inv.email}</option>
                      ))}
                    </select>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 z-10 -translate-y-1/2 text-sm font-bold text-slate-400">₦</span>
                        <input type="number" min="100" className="velo-input !pl-9 text-sm font-semibold" value={creditAmountNaira} onChange={(e) => setCreditAmountNaira(e.target.value)} />
                      </div>
                      <select className="velo-input text-sm" value={creditReason} onChange={(e) => setCreditReason(e.target.value as any)}>
                        <option value="MANUAL_CREDIT">Manual Credit</option>
                        <option value="INVESTMENT_RETURN">Investment Return</option>
                        <option value="BONUS">Bonus</option>
                        <option value="CORRECTION">Correction</option>
                      </select>
                    </div>
                    <input type="text" className="velo-input text-sm" placeholder="Optional note to investor" value={creditDescription} onChange={(e) => setCreditDescription(e.target.value)} />
                    <button
                      onClick={handleCreditInvestor}
                      disabled={creditSaving}
                      className="w-full rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 px-5 py-2.5 text-sm font-bold text-white shadow transition hover:from-emerald-600 hover:to-emerald-700 disabled:opacity-50"
                    >
                      {creditSaving ? "Processing…" : <><Icon name="check" size={14} />Credit investor wallet</>}
                    </button>
                    {creditMsg && <InlineMessage message={creditMsg} />}
                  </div>
                </PanelCard>
              </div>
            </div>
          )}

          {/* ============ PENDING WITHDRAWALS ============ */}
          {showWithdrawals && (
            <div className={`min-w-0 space-y-5 ${showLedger ? "lg:col-span-2" : "lg:col-span-3"}`}>
              <PanelCard
                title="Pending investor withdrawals"
                description="Monitor investor withdrawals. Failed payouts can be retried from here."
                icon={<Icon name="clock" size={18} />}
                tone="violet"
                action={<Pill tone={withdrawals.filter(w => w.status === "FAILED").length > 0 ? "warning" : "neutral"}>{withdrawals.filter(w => w.status === "FAILED").length} failed</Pill>}
              >
                {withdrawalsLoading ? (
                  <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">Loading withdrawals…</div>
                ) : withdrawals.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">No withdrawal requests yet.</div>
                ) : (
                  <div className="scrollable-sm overflow-x-auto py-2">
                    <table className="w-full min-w-[640px] text-sm">
                      <thead className="text-[10px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                        <tr className="border-b border-slate-200 dark:border-slate-700">
                          <th className="p-3 text-left font-bold">Investor</th>
                          <th className="p-3 text-right font-bold">Amount</th>
                          <th className="p-3 text-right font-bold">Fee</th>
                          <th className="p-3 text-right font-bold">Net</th>
                          <th className="p-3 text-left font-bold">Bank</th>
                          <th className="p-3 text-left font-bold">Status</th>
                          <th className="p-3 text-right font-bold">Action</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {withdrawals.slice(0, 20).map((w) => (
                          <tr key={w.id} className="transition hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="p-3">
                              <div className="font-semibold text-velo-900 dark:text-white">{investors.find(i => i.id === w.investorId)?.fullName || w.investorId.slice(0, 8)}</div>
                              <div className="text-[10px] text-slate-500 dark:text-slate-400">{new Date(w.createdAt).toLocaleDateString()}</div>
                            </td>
                            <td className="p-3 text-right font-semibold dark:text-slate-200">₦{Number(w.amountNaira).toLocaleString("en-NG")}</td>
                            <td className="p-3 text-right font-semibold text-red-600 dark:text-red-400">-₦{Number(w.feeNaira).toLocaleString("en-NG")}</td>
                            <td className="p-3 text-right font-bold text-emerald-700 dark:text-emerald-400">₦{Number(w.netNaira).toLocaleString("en-NG")}</td>
                            <td className="p-3 dark:text-slate-200">
                              <div className="font-semibold">{w.bankName}</div>
                              <div className="text-[11px] text-slate-500 dark:text-slate-400">••••{w.accountNumber.slice(-4)}</div>
                            </td>
                            <td className="p-3">
                              <Pill tone={w.status === "SUCCESSFUL" ? "success" : w.status === "FAILED" || w.status === "REJECTED" ? "danger" : w.status === "PENDING_APPROVAL" || w.status === "PROCESSING" ? "info" : "neutral"}>
                                {String(w.status).replace(/_/g, " ")}
                              </Pill>
                            </td>
                            <td className="p-3 text-right">
                              {w.status === "FAILED" && (
                                <button
                                  onClick={() => handleRetryWithdrawal(w.id)}
                                  disabled={withdrawalActioning === w.id}
                                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-[11px] font-semibold text-white transition hover:bg-amber-600"
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
              </PanelCard>
            </div>
          )}

          {/* ============ ADMIN LEDGER ============ */}
          {showLedger && (
            <div className={`min-w-0 space-y-5 ${showInvestorTools || showWithdrawals ? "lg:col-span-1" : "lg:col-span-3"}`}>
              <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-600 via-emerald-700 to-emerald-800 p-5 text-white shadow-elevated">
                <div className="pointer-events-none absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/5 blur-xl" />
                <div className="relative">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-100/80">Admin ledger balance</span>
                    <Pill tone="success">Synced</Pill>
                  </div>
                  <div className="mt-1 text-3xl font-bold tracking-tight sm:text-4xl">
                    {adminLedgerBalance !== null ? "₦" + Math.round(adminLedgerBalance / 100).toLocaleString("en-NG") : "—"}
                  </div>
                  <div className="mt-1 text-[11px] text-emerald-100/70">Funds available for investor funding &amp; payouts</div>
                  <div className="mt-4 grid grid-cols-2 gap-3 border-t border-white/10 pt-4">
                    <div>
                      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100/70">Debits today</div>
                      <div className="text-lg font-bold">₦0.00</div>
                    </div>
                    <div>
                      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-100/70">Last updated</div>
                      <div className="text-sm font-semibold">{platformSettings?.updatedAt ? new Date(platformSettings.updatedAt).toLocaleDateString() : "—"}</div>
                    </div>
                  </div>
                </div>
              </div>

              <PanelCard
                title="Ledger activity"
                description="Debit/credit entries for all investment operations."
                icon={<Icon name="history" size={18} />}
                action={
                  <select
                    value={ledgerFilter}
                    onChange={(e) => setLedgerFilter(e.target.value)}
                    className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600 focus:outline-none focus:ring-1 focus:ring-velo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    <option value="">All</option>
                    <option value="INVESTOR_FUNDING">Investor Funding</option>
                    <option value="INVESTMENT_PAYOUT">Investment Payouts</option>
                    <option value="WITHDRAWAL_FEE">Withdrawal Fees</option>
                    <option value="REVERSAL">Reversals</option>
                  </select>
                }
              >
                {ledgerLoading ? (
                  <div className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">Loading ledger…</div>
                ) : (
                  <div className="max-h-[480px] space-y-2 overflow-y-auto py-2 pr-1">
                    {ledgerEntries
                      .filter(e => !ledgerFilter || e.entryType === ledgerFilter)
                      .map((e) => (
                        <button
                          type="button"
                          key={e.id}
                          onClick={() => setSelectedLedgerEntry(e as AdminLedgerEntry)}
                          className="flex w-full items-start gap-3 rounded-xl border border-slate-100 p-3 text-left transition hover:border-slate-300 hover:bg-slate-50 hover:shadow-sm dark:border-slate-800 dark:hover:border-slate-600 dark:hover:bg-slate-800/50"
                        >
                          <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${e.direction === "DEBIT" ? "bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-400" : "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400"}`}>
                            <Icon name={e.direction === "DEBIT" ? "arrowDown" : "arrowUp"} size={15} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="flex items-start justify-between gap-2">
                              <span className="truncate text-xs font-semibold text-velo-900 dark:text-white">{String(e.entryType).replace(/_/g, " ")}</span>
                              <span className={`whitespace-nowrap text-xs font-bold ${e.direction === "DEBIT" ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                                {e.direction === "DEBIT" ? "-" : "+"}₦{Math.round(e.amountMinor / 100).toLocaleString("en-NG")}
                              </span>
                            </span>
                            <span className="mt-0.5 line-clamp-1 block text-[10px] text-slate-500 dark:text-slate-400">{e.description || "—"}</span>
                            <span className="mt-0.5 block text-[10px] text-slate-400 dark:text-slate-500">{new Date(e.createdAt).toLocaleString()}</span>
                          </span>
                        </button>
                      ))}
                    {ledgerEntries.filter(e => !ledgerFilter || e.entryType === ledgerFilter).length === 0 && (
                      <div className="rounded-xl border border-dashed border-slate-200 py-6 text-center text-xs text-slate-500 dark:border-slate-700 dark:text-slate-400">
                        No ledger entries match this filter.
                      </div>
                    )}
                  </div>
                )}

                {!ledgerLoading && ledgerTotal > 0 && (
                  <div className="flex items-center justify-between gap-2 border-t border-slate-100 py-3 dark:border-slate-800">
                    <div className="text-[10px] font-semibold text-slate-500 dark:text-slate-400">
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
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
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
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[10px] font-semibold text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700"
                      >
                        <span className="inline-flex items-center gap-1">Next<Icon name="arrowRight" size={12} /></span>
                      </button>
                    </div>
                  </div>
                )}
              </PanelCard>
            </div>
          )}

          {selectedLedgerEntry !== null && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm animate-fade-in sm:p-6" onClick={() => setSelectedLedgerEntry(null)}>
              <div className="velo-card max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl shadow-elevated dark:bg-slate-900 dark:border-slate-800" onClick={(ev) => ev.stopPropagation()}>
                <div className="sticky top-0 z-10 flex items-start justify-between gap-4 rounded-t-2xl border-b border-slate-100 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <span className={`inline-flex h-6 w-6 items-center justify-center rounded-md ${selectedLedgerEntry.direction === "DEBIT" ? "bg-red-50 text-red-600 dark:bg-red-900/30" : "bg-emerald-50 text-emerald-600 dark:bg-emerald-900/30"}`}>
                        <Icon name={selectedLedgerEntry.direction === "DEBIT" ? "arrowDown" : "arrowUp"} size={14} />
                      </span>
                      <h3 className="text-base font-bold text-velo-900 dark:text-white">Ledger entry details</h3>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400">Full transaction breakdown and metadata</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedLedgerEntry(null)}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg font-semibold text-slate-500 transition hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
                  >
                    <Icon name="x" size={16} />
                  </button>
                </div>

                <div className="space-y-4 p-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-700/60 dark:bg-slate-800/60">
                      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Entry type</div>
                      <div className="text-sm font-bold text-velo-900 dark:text-white">{String(selectedLedgerEntry.entryType).replace(/_/g, " ")}</div>
                    </div>
                    <div className="rounded-xl border border-slate-100 bg-slate-50 p-3 dark:border-slate-700/60 dark:bg-slate-800/60">
                      <div className="mb-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Direction</div>
                      <div className={`text-sm font-bold ${selectedLedgerEntry.direction === "DEBIT" ? "text-red-600" : "text-emerald-600"}`}>{selectedLedgerEntry.direction}</div>
                    </div>
                  </div>

                  <div className={`rounded-2xl border p-4 ${selectedLedgerEntry.direction === "DEBIT" ? "border-red-100 bg-red-50 dark:border-red-900/50 dark:bg-red-950/40" : "border-emerald-100 bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/40"}`}>
                    <div className="mb-1 text-[10px] font-bold uppercase tracking-wider opacity-70" style={{ color: selectedLedgerEntry.direction === "DEBIT" ? "#991b1b" : "#065f46" }}>
                      Transaction amount
                    </div>
                    <div className={`text-2xl font-bold ${selectedLedgerEntry.direction === "DEBIT" ? "text-red-700 dark:text-red-400" : "text-emerald-700 dark:text-emerald-400"}`}>
                      {selectedLedgerEntry.direction === "DEBIT" ? "-" : "+"}₦{Math.round(selectedLedgerEntry.amountMinor / 100).toLocaleString("en-NG")}
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {([
                      ["Entry ID", selectedLedgerEntry.id, true],
                      ["Created at", new Date(selectedLedgerEntry.createdAt).toLocaleString(), false],
                      ["Reference ID", selectedLedgerEntry.referenceId || "—", true],
                      ["Investor ID", selectedLedgerEntry.investorId || "—", true],
                      ["Currency", selectedLedgerEntry.currency, false],
                      ["Balance after", "₦" + Math.round(selectedLedgerEntry.balanceAfterMinor / 100).toLocaleString("en-NG"), false],
                      ["Description", selectedLedgerEntry.description || "—", false],
                    ] as Array<[string, string, boolean]>).map(([label, value, mono]) => (
                      <div key={label} className="flex items-start justify-between gap-3 border-b border-slate-100 py-2 last:border-0 dark:border-slate-800">
                        <span className="w-28 shrink-0 text-[11px] font-semibold text-slate-500 dark:text-slate-400">{label}</span>
                        <span className={`break-all text-right text-[11px] font-semibold text-velo-900 dark:text-white ${mono ? "font-mono" : ""}`}>{value}</span>
                      </div>
                    ))}
                  </div>

                  {selectedLedgerEntry.metadata && Object.keys(selectedLedgerEntry.metadata).length > 0 && (
                    <div className="border-t border-slate-100 pt-3 dark:border-slate-800">
                      <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">Metadata</div>
                      <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900 p-3 font-mono text-[10px] leading-relaxed text-emerald-400 dark:bg-slate-950">
                        {JSON.stringify(selectedLedgerEntry.metadata, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>

                <div className="sticky bottom-0 rounded-b-2xl border-t border-slate-100 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
                  <button type="button" onClick={() => setSelectedLedgerEntry(null)} className="btn-primary w-full !py-2.5 text-xs !font-bold">
                    Close details
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Mobile sticky save bar ===== */}
      {showConfig && (
        <div className="sticky bottom-4 z-20 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:hidden">
          <div className="velo-card flex items-center gap-2 rounded-2xl border-0 p-3 shadow-elevated dark:bg-slate-900 dark:border-slate-800">
            <div className="min-w-0 flex-1">
              {saved ? (
                <div className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400"><Icon name="check" size={13} />Settings saved</div>
              ) : saving ? (
                <div className="text-xs font-semibold text-velo-600 dark:text-velo-400">Saving…</div>
              ) : (
                <div className="text-xs text-slate-500 dark:text-slate-400">Tap save to persist changes</div>
              )}
            </div>
            <button type="button" onClick={handleSave} disabled={saveDisabled} className="btn-primary shrink-0 !py-2 !px-4 text-xs !font-bold">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* =======================================================================
   Small local helpers
   ======================================================================= */

function InlineMessage({ message }: { message: string }) {
  const isError = message.startsWith("Error:");
  return (
    <div className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold ${
      isError
        ? "bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300"
        : "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
    }`}>
      <Icon name={isError ? "alert" : "check"} size={14} />{message.replace(/^Error: /, "")}
    </div>
  );
}

function PreviewRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between py-0.5 ${muted ? "opacity-50" : ""}`}>
      <span className="text-[11px] text-white/75">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}
