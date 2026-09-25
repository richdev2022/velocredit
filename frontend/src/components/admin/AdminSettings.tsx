// ============================================================================
// src/components/admin/AdminSettings.tsx
// Platform Settings console — completely redesigned "admin console" layout.
//
// Visual language (see ./settingsUI.tsx): tabbed navigation, settings rows,
// toggle switches, segmented fee editors, naira-chip inputs. Fully responsive
// with explicit dark: variants.
//
// SINGLE SOURCE OF TRUTH (2026-09 consolidation):
//   Loan configuration (amounts, tenures, interest, fees, grace, collateral,
//   Personal/Business mapping) lives ENTIRELY on the loan product catalog —
//   persisted in PostgreSQL via /admin/loan-products. The former "Loan
//   programs" per-program editor and the "Global limits / Fees & charges"
//   tabs (which only wrote to THIS browser's localStorage and fought with the
//   catalog) have been removed. What remains here: branding & access (also
//   mirrored to localStorage), investor tools, withdrawals, ledger.
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
  adminUpdateMaintenanceMode,
  adminListAnnouncements,
  adminCreateAnnouncement,
  adminUpdateAnnouncement,
  adminDeleteAnnouncement,
  adminListBanners,
  adminUploadBanner,
  adminUpdateBanner,
  adminDeleteBanner,
  type AdminAnnouncement,
  type AdminBanner,
  type AdminLedgerEntry,
} from "../../services/adminApi";
import AdminWithdrawalHistory from "./AdminWithdrawalHistory";
import CsvExportButton from "../CsvExportButton";
import ProductCatalogCard from "./ProductCatalogCard";
import Icon from "../Icon";
import { Pill, Toggle, SettingRow, PanelCard } from "./settingsUI";

/** Per-tenure override state: Record<tenureDays, { enabled: boolean, fees }> */
type SettingsTab = "programs" | "branding" | "engagement" | "system";

// Banner uploads used to time out because raw phone photos (3 MB → ~4 MB of
// base64) were posted through the API's JSON envelope. Banners are downscaled
// and re-encoded as JPEG in the browser BEFORE upload, so the request is
// typically 100–300 KB and uploads in seconds on any connection.
const BANNER_JSON_BUDGET_CHARS = 1_400_000; // ≈1.05 MB binary — safely inside the API envelope
async function compressBannerImage(originalDataUrl: string, file: File): Promise<{ dataUrl: string; mimeType: string; sizeBytes: number }> {
  const readBlob = (blob: Blob) => new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not encode the image"));
    reader.readAsDataURL(blob);
  });
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("decode-failed"));
      img.src = originalDataUrl;
    });
    // Progressive passes: stop as soon as the encoded size fits the envelope.
    const passes: Array<{ maxEdge: number; quality: number }> = [
      { maxEdge: 1600, quality: 0.85 },
      { maxEdge: 1280, quality: 0.72 },
      { maxEdge: 1024, quality: 0.6 },
    ];
    for (const pass of passes) {
      const scale = Math.min(1, pass.maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const width = Math.max(1, Math.round(image.naturalWidth * scale));
      const height = Math.max(1, Math.round(image.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.fillStyle = "#ffffff"; // JPEG has no alpha — flatten transparency onto white
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", pass.quality));
      if (blob && Math.ceil((blob.size * 4) / 3) + 32 <= BANNER_JSON_BUDGET_CHARS) {
        return { dataUrl: await readBlob(blob), mimeType: "image/jpeg", sizeBytes: blob.size };
      }
    }
  } catch {
    // Decode failed (e.g. HEIC in some browsers) — fall through to the
    // original-size check below.
  }
  if (originalDataUrl.length <= BANNER_JSON_BUDGET_CHARS + 32) {
    return { dataUrl: originalDataUrl, mimeType: file.type || "image/jpeg", sizeBytes: file.size };
  }
  throw new Error("This image is too large to upload. Please pick a JPG or PNG — smaller images are compressed automatically.");
}

const SETTINGS_TABS: Array<{ key: SettingsTab; label: string; icon: React.ReactNode }> = [
  { key: "programs", label: "Loan Products", icon: <Icon name="target" size={15} /> },
  { key: "branding", label: "Branding & Access", icon: <Icon name="bank" size={15} /> },
  { key: "engagement", label: "Maintenance & Announcements", icon: <Icon name="sparkles" size={15} /> },
  { key: "system", label: "System", icon: <Icon name="lock" size={15} /> },
];

export default function AdminSettings(props?: { displaySection?: "all" | "ledger" | "withdrawals" | "investor-tools" }) {
  const displaySection: NonNullable<typeof props>["displaySection"] = props?.displaySection ?? "all";
  const showConfig = displaySection === "all";
  const showInvestorTools = displaySection === "investor-tools";
  const showWithdrawals = displaySection === "withdrawals";
  const showLedger = displaySection === "ledger";
  const [activeTab, setActiveTab] = useState<SettingsTab>("programs");
  const [companyName, setCompanyName] = useState(currentConfig.companyName);
  const [companyWebsite, setCompanyWebsite] = useState(currentConfig.companyWebsite);
  const [brandLogoUrl, setBrandLogoUrl] = useState(currentConfig.brandLogoUrl);
  const [lenderSignatoryName, setLenderSignatoryName] = useState(currentConfig.lenderSignatoryName);
  const [lenderSignatoryPosition, setLenderSignatoryPosition] = useState(currentConfig.lenderSignatoryPosition);
  const [lenderSignatorySignatureUrl, setLenderSignatorySignatureUrl] = useState(currentConfig.lenderSignatorySignatureUrl);
  const [apiUrl, setApiUrl] = useState(currentConfig.apiUrl);
  const [loanManagerEmails, setLoanManagerEmails] = useState(currentConfig.loanManagerEmails.join(", "));
  const [adminEmails, setAdminEmails] = useState(currentConfig.adminEmails.join(", "));

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

  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [ledgerLoading, setLedgerLoading] = useState(true);
  const [ledgerFilter, setLedgerFilter] = useState<string>("");
  const [selectedLedgerEntry, setSelectedLedgerEntry] = useState(null as AdminLedgerEntry | null);
  const [ledgerOffset, setLedgerOffset] = useState(0);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const LEDGER_LIMIT = 20;

  // Loan product catalog — rendered by the self-contained ProductCatalogCard
  // (every product fully editable: type, amounts, tenures, interest, fees,
  // grace, collateral, active). It saves straight to the backend catalog —
  // the authoritative loan configuration for the whole platform.

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

  async function handleSave() {
    // Loan configuration lives ENTIRELY on the backend loan product catalog
    // (edited on the Loan Products tab — saved per product via /admin/loan-products).
    // What is saved HERE is the platform identity / access layer, mirrored to
    // localStorage so every page of this browser picks it up instantly.
    const overrides: AdminConfigOverride = {
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

    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      saveAdminOverrides(overrides);
      refreshConfig(overrides);
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
      setCompanyName(baseConfig.companyName);
      setCompanyWebsite(baseConfig.companyWebsite);
      setBrandLogoUrl(baseConfig.brandLogoUrl);
      setLenderSignatoryName(baseConfig.lenderSignatoryName);
      setLenderSignatoryPosition(baseConfig.lenderSignatoryPosition);
      setLenderSignatorySignatureUrl(baseConfig.lenderSignatorySignatureUrl);
      setApiUrl(baseConfig.apiUrl);
      setLoanManagerEmails(baseConfig.loanManagerEmails.join(", "));
      setAdminEmails(baseConfig.adminEmails.join(", "));
      setResetConfirm(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Unable to restore defaults.");
    } finally {
      setSaving(false);
    }
  }

  const saveDisabled = saving;

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
                    Loan products, branding and access — the product catalog is the complete loan configuration for every user on the platform.
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
                  className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-velo-100 px-4 py-2 text-xs font-bold text-velo-800 shadow-lg transition hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-60"
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
                <ProductCatalogCard />
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

              {activeTab === "engagement" && <EngagementSettings />}

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
              {activeTab === "programs" && (
                <PanelCard title="Single source of truth" icon={<Icon name="sparkles" size={16} />}>
                  <div className="space-y-2.5 py-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
                    <p>Every loan term lives on the product itself: type (Personal / Business / Both), amount range + default, tenor list + default tenor, interest and type, processing / service / late fees, grace period, collateral and active state.</p>
                    <p>Products are persisted in PostgreSQL — every borrower sees exactly the same terms on every device, and applications capture an immutable snapshot of the product they applied under.</p>
                    <p>The former per-program editors and global limits/fees tabs stored settings ONLY in the editing admin's browser — they have been removed to end the conflicts.</p>
                  </div>
                </PanelCard>
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
                    "Loan Products save straight to the backend catalog (PostgreSQL) — every borrower sees the same terms.",
                    "Branding & access settings apply to this deployment and mirror to the browser for instant page loads.",
                    "Loan applications capture an immutable product snapshot, so later product edits never change agreed loans.",
                    "Restore defaults resets branding/access to the deployed baseline (loan products are untouched).",
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

          {/* ============ WITHDRAWAL HISTORY ============ */}
          {showWithdrawals && (
            <div className="min-w-0 lg:col-span-3">
              <div className="mb-4">
                <h2 className="text-lg font-bold text-velo-900 dark:text-white">Withdrawal history</h2>
                <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
                  Search, filter and audit every investor withdrawal. Click a row for the complete transaction trail.
                </p>
              </div>
              <AdminWithdrawalHistory />
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
                  <div className="flex items-center gap-2">
                    <select
                      value={ledgerFilter}
                      onChange={(e) => setLedgerFilter(e.target.value)}
                      className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[10px] font-semibold text-slate-600 focus:outline-none focus:ring-1 focus:ring-velo-500 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    >
                      <option value="">All</option>
                      <option value="INVESTOR_FUNDING">Investor Funding</option>
                      <option value="INVESTMENT_PAYOUT">Investment Payouts</option>
                      <option value="WITHDRAWAL_OUT">Withdrawals (wallet debited)</option>
                      <option value="WITHDRAWAL_FEE">Withdrawal Fees</option>
                      <option value="LOAN_DISBURSEMENT">Loan Disbursements</option>
                      <option value="LOAN_REPAYMENT_IN">Loan Repayments</option>
                      <option value="REVERSAL">Reversals</option>
                    </select>
                    <CsvExportButton path="/api/v1/admin/export/ledger" params={{ status: ledgerFilter || undefined }} compact />
                  </div>
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

// ---------------------------------------------------------------------------
// EngagementSettings — maintenance-mode toggle, announcement composer and the
// banner upload manager. Announcements render as a smooth horizontal text
// slider (with an alert icon) on the Borrower and Investor dashboards; banners
// render as an auto-sliding horizontal carousel on both dashboards.
// ---------------------------------------------------------------------------
function EngagementSettings() {
  // --- Maintenance mode -------------------------------------------------
  const [maintenanceOn, setMaintenanceOn] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceLoading, setMaintenanceLoading] = useState(true);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceMsg, setMaintenanceMsg] = useState("");
  const [maintenanceErr, setMaintenanceErr] = useState("");

  // --- Announcements ----------------------------------------------------
  const [announcements, setAnnouncements] = useState<AdminAnnouncement[]>([]);
  const [newAnnouncement, setNewAnnouncement] = useState("");
  const [announcementBusy, setAnnouncementBusy] = useState(false);
  const [announcementMsg, setAnnouncementMsg] = useState("");
  const [announcementErr, setAnnouncementErr] = useState("");
  const [editingAnnouncementId, setEditingAnnouncementId] = useState("");
  const [editingAnnouncementText, setEditingAnnouncementText] = useState("");
  const [announcementSaving, setAnnouncementSaving] = useState(false);

  // --- Banners ----------------------------------------------------------
  const [banners, setBanners] = useState<AdminBanner[]>([]);
  const [bannerName, setBannerName] = useState("");
  const [bannerData, setBannerData] = useState<{ dataUrl: string; mimeType: string; sizeBytes: number } | null>(null);
  const [bannerLinkUrl, setBannerLinkUrl] = useState("");
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerMsg, setBannerMsg] = useState("");
  const [bannerErr, setBannerErr] = useState("");

  async function loadAll() {
    setMaintenanceLoading(true);
    try {
      const [platform, announcementList, bannerList] = await Promise.all([
        adminGetPlatformSettings(),
        adminListAnnouncements(),
        adminListBanners(),
      ]);
      const settings = platform.settings;
      setMaintenanceOn(settings?.maintenanceMode === true);
      setMaintenanceMessage(settings?.maintenanceMessage ?? "");
      setAnnouncements(announcementList.announcements ?? []);
      setBanners(bannerList.banners ?? []);
    } catch (err) {
      setMaintenanceErr(err instanceof Error ? err.message : "Unable to load engagement settings");
    } finally {
      setMaintenanceLoading(false);
    }
  }
  useEffect(() => {
    void loadAll();
  }, []);

  async function toggleMaintenance(next: boolean) {
    setMaintenanceBusy(true);
    setMaintenanceMsg("");
    setMaintenanceErr("");
    try {
      const response = await adminUpdateMaintenanceMode(next, maintenanceMessage);
      setMaintenanceOn(next);
      const emailed = (response as { maintenanceEmailed?: number }).maintenanceEmailed;
      setMaintenanceMsg(
        next
          ? `Maintenance mode is ON. Customers cannot sign in and see the maintenance modal.${typeof emailed === "number" ? ` Notification email queued for ${emailed} user(s).` : ""}`
          : `Maintenance mode is OFF. The platform is back online.${typeof emailed === "number" ? ` Back-online email queued for ${emailed} user(s).` : ""}`
      );
    } catch (err) {
      setMaintenanceErr(err instanceof Error ? err.message : "Unable to update maintenance mode");
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function addAnnouncement() {
    if (newAnnouncement.trim().length < 3) return;
    setAnnouncementBusy(true);
    setAnnouncementMsg("");
    setAnnouncementErr("");
    try {
      await adminCreateAnnouncement(newAnnouncement.trim());
      setNewAnnouncement("");
      setAnnouncementMsg("Announcement published — it is live on both customer dashboards.");
      const list = await adminListAnnouncements();
      setAnnouncements(list.announcements ?? []);
    } catch (err) {
      setAnnouncementErr(err instanceof Error ? err.message : "Unable to publish announcement");
    } finally {
      setAnnouncementBusy(false);
    }
  }

  async function toggleAnnouncement(item: AdminAnnouncement) {
    try {
      await adminUpdateAnnouncement(item.id, { isActive: !item.isActive });
      const list = await adminListAnnouncements();
      setAnnouncements(list.announcements ?? []);
    } catch (err) {
      setAnnouncementErr(err instanceof Error ? err.message : "Unable to update announcement");
    }
  }

  async function removeAnnouncement(item: AdminAnnouncement) {
    try {
      await adminDeleteAnnouncement(item.id);
      const list = await adminListAnnouncements();
      setAnnouncements(list.announcements ?? []);
    } catch (err) {
      setAnnouncementErr(err instanceof Error ? err.message : "Unable to delete announcement");
    }
  }

  function startAnnouncementEdit(item: AdminAnnouncement) {
    setEditingAnnouncementId(item.id);
    setEditingAnnouncementText(item.message);
    setAnnouncementMsg("");
    setAnnouncementErr("");
  }

  async function saveAnnouncementEdit() {
    if (!editingAnnouncementId || editingAnnouncementText.trim().length < 3) return;
    setAnnouncementSaving(true);
    setAnnouncementMsg("");
    setAnnouncementErr("");
    try {
      await adminUpdateAnnouncement(editingAnnouncementId, { message: editingAnnouncementText.trim() });
      const list = await adminListAnnouncements();
      setAnnouncements(list.announcements ?? []);
      setEditingAnnouncementId("");
      setEditingAnnouncementText("");
      setAnnouncementMsg("Announcement updated and saved — the new text is live on both customer dashboards.");
    } catch (err) {
      setAnnouncementErr(err instanceof Error ? err.message : "Unable to save the announcement");
    } finally {
      setAnnouncementSaving(false);
    }
  }

  function pickBannerFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setBannerErr("Banner must be an image (JPG, PNG or WebP).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setBannerErr("Banner must be 8 MB or smaller.");
      return;
    }
    setBannerErr("");
    setBannerMsg("");
    const reader = new FileReader();
    reader.onerror = () => setBannerErr("Could not read the image file. Please try another one.");
    reader.onload = () => {
      void compressBannerImage(String(reader.result ?? ""), file)
        .then((result) => {
          setBannerData(result);
          setBannerMsg(`Image optimized to ${Math.max(1, Math.round(result.sizeBytes / 1024))} KB — uploads stay fast on any connection.`);
          if (!bannerName.trim()) setBannerName(file.name.replace(/\.[^.]+$/, ""));
        })
        .catch((err) => setBannerErr(err instanceof Error ? err.message : "Could not process the image. Please use a JPG or PNG."));
    };
    reader.readAsDataURL(file);
  }

  async function uploadBanner() {
    if (!bannerData) {
      setBannerErr("Choose a banner image first.");
      return;
    }
    if (!bannerName.trim()) {
      setBannerErr("Give the banner a name (e.g. 'December promo').");
      return;
    }
    setBannerBusy(true);
    setBannerMsg("");
    setBannerErr("");
    try {
      await adminUploadBanner({ name: bannerName.trim(), imageData: bannerData.dataUrl, mimeType: bannerData.mimeType, linkUrl: bannerLinkUrl.trim() || undefined });
      setBannerMsg("Banner uploaded — it is now live in the customer dashboard carousel.");
      setBannerData(null);
      setBannerName("");
      setBannerLinkUrl("");
      const list = await adminListBanners();
      setBanners(list.banners ?? []);
    } catch (err) {
      setBannerErr(err instanceof Error ? err.message : "Unable to upload banner");
    } finally {
      setBannerBusy(false);
    }
  }

  async function toggleBanner(item: AdminBanner) {
    try {
      await adminUpdateBanner(item.id, { isActive: !item.isActive });
      const list = await adminListBanners();
      setBanners(list.banners ?? []);
    } catch (err) {
      setBannerErr(err instanceof Error ? err.message : "Unable to update banner");
    }
  }

  async function removeBanner(item: AdminBanner) {
    try {
      await adminDeleteBanner(item.id);
      const list = await adminListBanners();
      setBanners(list.banners ?? []);
    } catch (err) {
      setBannerErr(err instanceof Error ? err.message : "Unable to delete banner");
    }
  }

  return (
    <div className="space-y-5">
      <PanelCard
        title="Maintenance mode"
        description="Take the platform offline for planned work. Customers cannot sign in while it is ON, and every active user is emailed when you toggle it ON or OFF."
        icon={<Icon name="alert" size={18} />}
        tone={maintenanceOn ? "amber" : "default"}
      >
        {maintenanceLoading ? (
          <p className="py-3 text-sm text-slate-500 dark:text-slate-400">Loading current status…</p>
        ) : (
          <div className="py-3 space-y-4">
            <SettingRow
              label={maintenanceOn ? "Platform is under maintenance" : "Platform is online"}
              description={maintenanceOn
                ? "Customer sign-in shows a friendly maintenance modal. Admins can still sign in to the console."
                : "Everything is operating normally."}
              stacked
            >
              <Toggle
                checked={maintenanceOn}
                onChange={(value) => void toggleMaintenance(value)}
                disabled={maintenanceBusy}
                label={maintenanceOn ? "Maintenance ON" : "Maintenance OFF"}
              />
            </SettingRow>
            <SettingRow
              label="Message shown to customers"
              description="Displayed on the maintenance modal and included in the email notification. Max 500 characters."
              stacked
            >
              <textarea
                value={maintenanceMessage}
                onChange={(event) => setMaintenanceMessage(event.target.value)}
                rows={3}
                maxLength={500}
                placeholder="Velo is currently undergoing scheduled maintenance. We'll email you as soon as the system is back up — thank you for your patience."
                className="velo-input text-sm"
              />
            </SettingRow>
            {maintenanceMsg && <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{maintenanceMsg}</p>}
            {maintenanceErr && <p className="text-sm font-medium text-red-600 dark:text-red-400">{maintenanceErr}</p>}
          </div>
        )}
      </PanelCard>

      <PanelCard
        title="Announcements"
        description="Short messages that slide smoothly (with an alert icon) across the Borrower and Investor dashboards. Hovering pauses the slider."
        icon={<Icon name="message" size={18} />}
      >
        <div className="py-3 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <div className="flex-1">
              <textarea
                value={newAnnouncement}
                onChange={(event) => setNewAnnouncement(event.target.value)}
                rows={2}
                maxLength={280}
                placeholder="e.g. New: instant disbursement now available for approved loans."
                className="velo-input text-sm"
              />
              <p className="mt-1 text-[11px] text-slate-400">{newAnnouncement.length}/280 characters</p>
            </div>
            <button type="button" className="btn-primary shrink-0 text-xs" disabled={announcementBusy || newAnnouncement.trim().length < 3} onClick={() => void addAnnouncement()}>
              {announcementBusy ? "Publishing…" : "Publish announcement"}
            </button>
          </div>
          {announcementMsg && <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{announcementMsg}</p>}
          {announcementErr && <p className="text-sm font-medium text-red-600 dark:text-red-400">{announcementErr}</p>}
          {announcements.length > 0 && (
            <ul className="space-y-2">
              {announcements.map((item) => (
                <li key={item.id} className="flex flex-col gap-2 rounded-xl border border-slate-200 px-3.5 py-3 dark:border-slate-700">
                  {editingAnnouncementId === item.id ? (
                    <div className="space-y-2">
                      <textarea
                        value={editingAnnouncementText}
                        onChange={(event) => setEditingAnnouncementText(event.target.value)}
                        rows={2}
                        maxLength={280}
                        className="velo-input text-sm"
                        autoFocus
                      />
                      <p className="text-[11px] text-slate-400">{editingAnnouncementText.length}/280 characters</p>
                      <div className="flex items-center gap-2">
                        <button type="button" className="btn-primary text-[11px]" disabled={announcementSaving || editingAnnouncementText.trim().length < 3} onClick={() => void saveAnnouncementEdit()}>
                          {announcementSaving ? "Saving…" : "Save changes"}
                        </button>
                        <button type="button" className="btn-ghost text-[11px]" onClick={() => { setEditingAnnouncementId(""); setEditingAnnouncementText(""); }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-velo-900 dark:text-white" title={item.message}>{item.message}</p>
                        <p className="text-[11px] text-slate-400">
                          {new Date(item.createdAt).toLocaleString()} · {item.isActive ? "live" : "hidden"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button type="button" className="btn-secondary text-[11px]" onClick={() => startAnnouncementEdit(item)}>
                          Edit
                        </button>
                        <button type="button" className="btn-secondary text-[11px]" onClick={() => void toggleAnnouncement(item)}>
                          {item.isActive ? "Hide" : "Show"}
                        </button>
                        <button type="button" className="text-[11px] font-semibold text-red-600 underline underline-offset-2 dark:text-red-400" onClick={() => void removeAnnouncement(item)}>
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </PanelCard>

      <PanelCard
        title="Dashboard banners"
        description="Upload promotional banners — they auto-slide horizontally across the top of both customer dashboards."
        icon={<Icon name="sparkles" size={18} />}
      >
        <div className="py-3 space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingRow label="Banner image" description="JPG, PNG or WebP · up to 8 MB. Large photos are compressed automatically before upload. Recommended width 1200×400." stacked>
              <input type="file" accept="image/*" onChange={pickBannerFile} className="velo-input text-sm" />
            </SettingRow>
            <SettingRow label="Banner name" description="Internal label for the banner list." stacked>
              <input value={bannerName} onChange={(event) => setBannerName(event.target.value)} className="velo-input text-sm" placeholder="e.g. December promo" />
            </SettingRow>
            <SettingRow label="Click-through link" description="Optional URL opened when customers tap the banner." stacked>
              <input type="url" value={bannerLinkUrl} onChange={(event) => setBannerLinkUrl(event.target.value)} className="velo-input text-sm" placeholder="https://…" />
            </SettingRow>
          </div>
          {bannerData && (
            <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
              <img src={bannerData.dataUrl} alt="Banner preview" className="max-h-40 w-full object-cover" />
            </div>
          )}
          <button type="button" className="btn-primary text-xs" disabled={bannerBusy || !bannerData} onClick={() => void uploadBanner()}>
            {bannerBusy ? "Uploading…" : "Upload banner"}
          </button>
          {bannerMsg && <p className="block text-sm font-medium text-emerald-700 dark:text-emerald-400">{bannerMsg}</p>}
          {bannerErr && <p className="block text-sm font-medium text-red-600 dark:text-red-400">{bannerErr}</p>}
          {banners.length > 0 && (
            <ul className="grid gap-3 sm:grid-cols-2">
              {banners.map((item) => (
                <li key={item.id} className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                  {item.imageData && <img src={item.imageData} alt={item.name} className="h-28 w-full object-cover" />}
                  <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-velo-900 dark:text-white">{item.name}</p>
                      <p className="text-[11px] text-slate-400">{item.isActive ? "live in carousel" : "hidden"} · {new Date(item.createdAt).toLocaleDateString()}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button type="button" className="btn-secondary text-[11px]" onClick={() => void toggleBanner(item)}>
                        {item.isActive ? "Hide" : "Show"}
                      </button>
                      <button type="button" className="text-[11px] font-semibold text-red-600 underline underline-offset-2 dark:text-red-400" onClick={() => void removeBanner(item)}>
                        Delete
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PanelCard>
    </div>
  );
}
