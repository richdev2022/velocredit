// ============================================================================
// src/utils/config.ts
// Centralised runtime configuration loader & validator.
//
// All VITE_* env variables are read here exactly once. Components must never
// read import.meta.env directly — they import from this module instead.
//
// ADMIN OVERRIDE SYSTEM (new):
//   The admin dashboard can override any .env value at runtime. Overrides are
//   written to localStorage under the ADMIN_CONFIG_KEY. These apply to the
//   browser that saved them — handy for demo, staging, or adjusting terms
//   without redeploying.
// ============================================================================

import type { FeeConfig, FeeConfiguration, LoanLimits, TenureOption, TenureFeeOverrides, LoanProgramConfig, LoanProgramKey, LoanProgramOverrides } from "../types/loan";

// ---------------------------------------------------------------------------
// Admin override layer — reads localStorage
// ---------------------------------------------------------------------------

export const ADMIN_CONFIG_KEY = "velo:admin-config";

export interface AdminConfigOverride {
  loanLimits?: Partial<LoanLimits>;
  tenures?: TenureOption[];
  fees?: Partial<Record<keyof FeeConfiguration, Partial<FeeConfig>>>;
  /** Per-tenure fee overrides (days => partial fee config) */
  tenureFees?: TenureFeeOverrides;
  loanPrograms?: LoanProgramOverrides;
  companyName?: string;
  companyWebsite?: string;
  brandLogoUrl?: string;
  apiUrl?: string;
  loanManagerEmails?: string[];
  adminEmails?: string[];
}

export function loadAdminOverrides(): AdminConfigOverride {
  try {
    const raw = localStorage.getItem(ADMIN_CONFIG_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return (p && typeof p === "object") ? p : {};
  } catch {
    return {};
  }
}

export function saveAdminOverrides(data: AdminConfigOverride): void {
  try {
    localStorage.setItem(ADMIN_CONFIG_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn("[config] Failed to save admin overrides", e);
  }
}

export function resetAdminOverrides(): void {
  try {
    localStorage.removeItem(ADMIN_CONFIG_KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Raw env access (centralised here only)
// ---------------------------------------------------------------------------

const env = import.meta.env;

function getStr(key: string, fallback = ""): string {
  const v = env[key];
  return v === undefined ? fallback : String(v);
}

function getNum(key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getBool(key: string, fallback = false): boolean {
  const v = env[key];
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).toLowerCase() === "true";
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface AppConfig {
  loanLimits: LoanLimits;
  tenures: TenureOption[];
  fees: FeeConfiguration;
  /** Per-tenure fee overrides (days => partial fee config) */
  tenureFees: TenureFeeOverrides;
  companyName: string;
  companyWebsite: string;
  brandLogoUrl: string;
  apiUrl: string;
  loanManagerEmails: string[];
  adminEmails: string[];
  loanPrograms: Record<LoanProgramKey, LoanProgramConfig>;
}

/**
 * Resolve the effective FeeConfiguration for a given tenure (in days).
 * Merges global fees with any per-tenure overrides.
 */
export function resolveFeesForTenure(
  cfg: AppConfig,
  tenureDays: number
): FeeConfiguration {
  const global = cfg.fees;
  const overrides = cfg.tenureFees?.[tenureDays];
  if (!overrides) return global;
  return {
    interest:      { ...global.interest,      ...(overrides.interest      || {}) },
    serviceFee:    { ...global.serviceFee,    ...(overrides.serviceFee    || {}) },
    processingFee: { ...global.processingFee, ...(overrides.processingFee || {}) },
    lateFee:       { ...global.lateFee,       ...(overrides.lateFee       || {}) },
  };
}

function buildTenures(): TenureOption[] {
  const raw = getStr("VITE_LOAN_TENURES", "30,60,90,180");
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => ({
      value: n,
      label: `${n} Days`,
    }));
}

function buildFee(key: string, defaultType: "flat" | "percentage", defaultValue: number, includeUpfront: boolean): FeeConfig {
  const type = (getStr(`VITE_${key}_TYPE`, defaultType).toLowerCase() as "flat" | "percentage");
  const value = getNum(`VITE_${key}_VALUE`, defaultValue);
  return { type, value, includeUpfront };
}

// Base config — from .env
const baseConfig: AppConfig = {
  loanLimits: {
    min: getNum("VITE_LOAN_MIN_AMOUNT", 100000),
    max: getNum("VITE_LOAN_MAX_AMOUNT", 30000000),
    defaultAmount: getNum("VITE_LOAN_DEFAULT_AMOUNT", 3000000),
  },
  tenures: buildTenures(),
  fees: {
    interest:      buildFee("INTEREST",      "percentage", 5,      true),
    serviceFee:   buildFee("SERVICE_FEE",    "percentage", 2,      true),
    processingFee:buildFee("PROCESSING_FEE", "flat",       5000,   true),
    lateFee:      buildFee("LATE_FEE",       "percentage", 5,      getBool("VITE_INCLUDE_LATE_FEE_UPFRONT", false)),
  },
  tenureFees: {},
  loanPrograms: {} as Record<LoanProgramKey, LoanProgramConfig>,
  companyName: getStr("VITE_COMPANY_NAME", "Velo Finance LTD"),
  companyWebsite: getStr("VITE_COMPANY_WEBSITE", "www.velofinance.co"),
  brandLogoUrl: getStr("VITE_BRAND_LOGO_URL", "https://i.ibb.co/b57jKwmk/Velo-New-Logo-2.png"),
  apiUrl: getStr("VITE_API_URL", "http://localhost:4000").replace(/\/$/, ""),
  loanManagerEmails: getStr("VITE_LOAN_MANAGER_EMAILS", "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
  adminEmails: getStr("VITE_ADMIN_EMAILS", "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
};

/** Deep-merge tenureFees overrides onto base */
function mergeTenureFees(base: TenureFeeOverrides, overrides?: TenureFeeOverrides): TenureFeeOverrides {
  if (!overrides) return { ...base };
  const result: TenureFeeOverrides = { ...base };
  for (const key of Object.keys(overrides)) {
    const k = Number(key);
    if (overrides[k] === null || overrides[k] === undefined) {
      delete result[k];
    } else {
      result[k] = { ...(result[k] || {}), ...overrides[k] };
      const clean: Partial<FeeConfiguration> = {};
      (Object.keys(result[k]) as (keyof FeeConfiguration)[]).forEach((fk) => {
        if (result[k][fk] !== undefined) clean[fk] = result[k][fk];
      });
      if (Object.keys(clean).length === 0) delete result[k];
      else result[k] = clean;
    }
  }
  return result;
}

// Effective config — apply admin overrides on top of base
function buildProgram(base: LoanProgramConfig, override?: Partial<LoanProgramConfig>): LoanProgramConfig {
  return {
    ...base,
    loanLimits: { ...base.loanLimits, ...(override?.loanLimits || {}) },
    tenures: override?.tenures && override.tenures.length > 0 ? override.tenures : base.tenures,
    fees: {
      interest: { ...base.fees.interest, ...(override?.fees?.interest || {}) },
      serviceFee: { ...base.fees.serviceFee, ...(override?.fees?.serviceFee || {}) },
      processingFee: { ...base.fees.processingFee, ...(override?.fees?.processingFee || {}) },
      lateFee: { ...base.fees.lateFee, ...(override?.fees?.lateFee || {}) },
    },
    tenureFees: mergeTenureFees(base.tenureFees, override?.tenureFees),
    collateral: { ...base.collateral, ...(override?.collateral || {}) },
  };
}

const baseProgram: LoanProgramConfig = {
  loanLimits: baseConfig.loanLimits,
  tenures: baseConfig.tenures,
  fees: baseConfig.fees,
  tenureFees: baseConfig.tenureFees,
  collateral: { enabled: true, required: false },
};

const personalInterest = buildFee(
  "PERSONAL_INTEREST",
  "percentage",
  getNum("VITE_INTEREST_VALUE", 5),
  true,
);
const businessInterest = buildFee(
  "BUSINESS_INTEREST",
  "percentage",
  getNum("VITE_INTEREST_VALUE", 5),
  true,
);

const basePrograms: Record<LoanProgramKey, LoanProgramConfig> = {
  PERSONAL: buildProgram({
    ...baseProgram,
    fees: { ...baseProgram.fees, interest: personalInterest },
    collateral: { enabled: true, required: true },
  }),
  BUSINESS: buildProgram({
    ...baseProgram,
    fees: { ...baseProgram.fees, interest: businessInterest },
    collateral: { enabled: true, required: true },
  }),
};
baseConfig.loanPrograms = basePrograms;

export function getEffectiveConfig(overrides: AdminConfigOverride = loadAdminOverrides()): AppConfig {
  const eff: AppConfig = {
    ...baseConfig,
    loanLimits: { ...baseConfig.loanLimits, ...(overrides.loanLimits || {}) },
    tenures: overrides.tenures && overrides.tenures.length > 0 ? overrides.tenures : baseConfig.tenures,
    fees: {
      interest:      { ...baseConfig.fees.interest,      ...(overrides.fees?.interest || {}) },
      serviceFee:    { ...baseConfig.fees.serviceFee,    ...(overrides.fees?.serviceFee || {}) },
      processingFee: { ...baseConfig.fees.processingFee, ...(overrides.fees?.processingFee || {}) },
      lateFee:       { ...baseConfig.fees.lateFee,       ...(overrides.fees?.lateFee || {}) },
    },
    tenureFees: mergeTenureFees(baseConfig.tenureFees, overrides.tenureFees),
    loanPrograms: {
      PERSONAL: buildProgram(basePrograms.PERSONAL, overrides.loanPrograms?.PERSONAL),
      BUSINESS: buildProgram(basePrograms.BUSINESS, overrides.loanPrograms?.BUSINESS),
    },
    companyName: overrides.companyName || baseConfig.companyName,
    companyWebsite: overrides.companyWebsite || baseConfig.companyWebsite,
    brandLogoUrl: overrides.brandLogoUrl || baseConfig.brandLogoUrl,
    apiUrl: overrides.apiUrl || baseConfig.apiUrl,
    loanManagerEmails: overrides.loanManagerEmails ?? baseConfig.loanManagerEmails,
    adminEmails: overrides.adminEmails ?? baseConfig.adminEmails,
  };
  return eff;
}

// Default export — re-computed every import (so admin overrides apply)
export const config = getEffectiveConfig();

export function getLoanProgram(type: LoanProgramKey): LoanProgramConfig {
  return config.loanPrograms[type];
}

// Re-export base for the admin UI (to show env-default values)
export { baseConfig };

// ---------------------------------------------------------------------------
// Live-reload helper for admin UI — call this to refresh `config` from storage
// ---------------------------------------------------------------------------

export function refreshConfig(overrides: AdminConfigOverride = loadAdminOverrides()): void {
  const fresh = getEffectiveConfig(overrides);
  Object.assign(config, fresh);
  config.loanLimits = { ...fresh.loanLimits };
  config.tenures = fresh.tenures.slice();
  config.fees = { ...fresh.fees };
  config.tenureFees = { ...fresh.tenureFees };
  config.loanPrograms = fresh.loanPrograms;
}

export async function loadRemoteConfig(): Promise<void> {
  refreshConfig();
}

// ---------------------------------------------------------------------------
// Validation — surfaces clear errors during development if .env is wrong
// ---------------------------------------------------------------------------

export interface ConfigError {
  key: string;
  message: string;
  severity: "error" | "warning";
}

export function validateConfig(): ConfigError[] {
  const errors: ConfigError[] = [];
  const { loanLimits, fees, tenures } = config;


  if (!(loanLimits.min < loanLimits.max)) {
    errors.push({
      key: "LOAN_LIMITS",
      message: `Minimum loan amount (₦${loanLimits.min.toLocaleString()}) must be less than maximum loan amount (₦${loanLimits.max.toLocaleString()}).`,
      severity: "error",
    });
  }

  if (loanLimits.defaultAmount < loanLimits.min || loanLimits.defaultAmount > loanLimits.max) {
    errors.push({
      key: "LOAN_DEFAULT",
      message: `Default loan amount (₦${loanLimits.defaultAmount.toLocaleString()}) must be between min (₦${loanLimits.min.toLocaleString()}) and max (₦${loanLimits.max.toLocaleString()}).`,
      severity: "error",
    });
  }

  (Object.keys(fees) as (keyof FeeConfiguration)[]).forEach((k) => {
    const f = fees[k];
    if (f.type !== "flat" && f.type !== "percentage") {
      errors.push({
        key: `VITE_${k.toUpperCase()}_TYPE`,
        message: `Fee type for "${k}" must be "flat" or "percentage" — got "${f.type}".`,
        severity: "error",
      });
    }
    if (f.type === "percentage" && (f.value < 0 || f.value > 100)) {
      errors.push({
        key: `VITE_${k.toUpperCase()}_VALUE`,
        message: `Percentage fee "${k}" must be between 0 and 100 — got ${f.value}.`,
        severity: "error",
      });
    }
    if (f.value < 0) {
      errors.push({
        key: `VITE_${k.toUpperCase()}_VALUE`,
        message: `Fee value for "${k}" cannot be negative — got ${f.value}.`,
        severity: "error",
      });
    }
  });

  if (tenures.length === 0) {
    errors.push({
      key: "VITE_LOAN_TENURES",
      message: "At least one valid tenure must be configured (comma-separated positive days).",
      severity: "error",
    });
  }

  return errors;
}

let configChecked = false;
export function ensureConfigValid(): void {
  if (configChecked) return;
  configChecked = true;
  const errors = validateConfig();
  const hardErrors = errors.filter((e) => e.severity === "error");
  if (hardErrors.length > 0 && import.meta.env.DEV) {
    console.error("[Velo Finance] Configuration errors detected:\n" +
      hardErrors.map((e) => `  • ${e.key}: ${e.message}`).join("\n"));
  }
}

ensureConfigValid();
