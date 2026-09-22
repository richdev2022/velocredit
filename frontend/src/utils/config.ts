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
  lenderSignatoryName?: string;
  lenderSignatoryPosition?: string;
  lenderSignatorySignatureUrl?: string;
  apiUrl?: string;
  loanManagerEmails?: string[];
  adminEmails?: string[];
  globalLimitsEnabled?: boolean;
  globalFeesEnabled?: boolean;
  globalInterestEnabled?: boolean;
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

const PRODUCTION_API_URL = "https://velocredit.onrender.com";

export function resolveApiUrl(configuredUrl: string, hostname = typeof window === "undefined" ? "" : window.location.hostname): string {
  const normalized = configuredUrl.trim().replace(/\/$/, "");
  const isLocalHost = /^(localhost|127\.0\.0\.1)$/.test(hostname);
  const pointsToLocalApi = /^(https?:\/\/)(localhost|127\.0\.0\.1)(:\d+)?$/i.test(normalized);
  if (pointsToLocalApi && hostname && !isLocalHost) return PRODUCTION_API_URL;
  return normalized;
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
  lenderSignatoryName: string;
  lenderSignatoryPosition: string;
  lenderSignatorySignatureUrl: string;
  apiUrl: string;
  loanManagerEmails: string[];
  adminEmails: string[];
  globalLimitsEnabled: boolean;
  globalFeesEnabled: boolean;
  globalInterestEnabled: boolean;
  premblyWidgetId: string;
  premblyWidgetKey: string;
  premblyWidgetIsTest: boolean;
  loanPrograms: Record<LoanProgramKey, LoanProgramConfig>;
}

/**
 * Coerce possibly-corrupt loan-limit values (null / undefined / NaN / negative,
 * e.g. written to localStorage by an older buggy build or returned by a bad API
 * response) into finite, ordered numbers with env-default fallbacks.
 *
 * Every consumer of `config.loanLimits` — admin console, borrower calculator,
 * loan application — goes through this, so a single corrupt key can no longer
 * crash the Admin page (TypeError: Cannot read properties of undefined reading
 * 'toLocaleString') or render ₦NaN on the borrower side.
 */
export function sanitizeLoanLimits(limits: Partial<LoanLimits> | null | undefined): LoanLimits {
  const fb = baseConfig.loanLimits;
  const num = (v: unknown, fallback: number): number => {
    // null/undefined/"" are "missing" — Number(null) is 0, which would
    // otherwise sneak past the finite check as a bogus ₦0 limit.
    if (v === null || v === undefined || v === "") return fallback;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const rawMin = num(limits?.min, fb.min);
  const rawMax = num(limits?.max, fb.max);
  // Enforce ordering invariants: min <= max
  const min = Math.min(rawMin, rawMax);
  const max = Math.max(rawMin, rawMax);
  let defaultAmount = num(limits?.defaultAmount, fb.defaultAmount);
  if (defaultAmount < min) defaultAmount = min;
  if (defaultAmount > max) defaultAmount = max;
  return { min, max, defaultAmount };
}

/** Safe naira formatter — never throws, falls back to a dash for bad input. */
export function safeNaira(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : "—";
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
  globalLimitsEnabled: true,
  globalFeesEnabled: true,
  globalInterestEnabled: true,
  loanPrograms: {} as Record<LoanProgramKey, LoanProgramConfig>,
  companyName: getStr("VITE_COMPANY_NAME", "Velo Finance LTD"),
  companyWebsite: getStr("VITE_COMPANY_WEBSITE", "www.velofinance.co"),
  brandLogoUrl: getStr("VITE_BRAND_LOGO_URL", "https://i.ibb.co/b57jKwmk/Velo-New-Logo-2.png"),
  lenderSignatoryName: getStr("VITE_LENDER_SIGNATORY_NAME"),
  lenderSignatoryPosition: getStr("VITE_LENDER_SIGNATORY_POSITION"),
  lenderSignatorySignatureUrl: getStr("VITE_LENDER_SIGNATORY_SIGNATURE_URL"),
  apiUrl: resolveApiUrl(getStr("VITE_API_URL", "http://localhost:4000")),
  loanManagerEmails: getStr("VITE_LOAN_MANAGER_EMAILS", "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
  adminEmails: getStr("VITE_ADMIN_EMAILS", "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
  premblyWidgetId: getStr("VITE_PREMBLY_WIDGET_ID"),
  premblyWidgetKey: getStr("VITE_PREMBLY_WIDGET_KEY"),
  premblyWidgetIsTest: getBool("VITE_PREMBLY_WIDGET_IS_TEST", false),
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
function buildProgram(base: LoanProgramConfig, override?: Partial<LoanProgramConfig>, globalLimits?: LoanLimits): LoanProgramConfig {
  return {
    ...base,
    loanLimits: globalLimits
      ? sanitizeLoanLimits(globalLimits)
      : sanitizeLoanLimits({ ...base.loanLimits, ...(override?.loanLimits || {}) }),
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
  const loanLimits = sanitizeLoanLimits({ ...baseConfig.loanLimits, ...(overrides.loanLimits || {}) });
  const eff: AppConfig = {
    ...baseConfig,
    loanLimits,
    tenures: overrides.tenures && overrides.tenures.length > 0 ? overrides.tenures : baseConfig.tenures,
    globalLimitsEnabled: overrides.globalLimitsEnabled ?? true,
    globalFeesEnabled: overrides.globalFeesEnabled ?? true,
    globalInterestEnabled: overrides.globalInterestEnabled ?? true,
    fees: {
      interest:      { ...baseConfig.fees.interest,      ...(overrides.fees?.interest || {}) },
      serviceFee:    { ...baseConfig.fees.serviceFee,    ...(overrides.fees?.serviceFee || {}) },
      processingFee: { ...baseConfig.fees.processingFee, ...(overrides.fees?.processingFee || {}) },
      lateFee:       { ...baseConfig.fees.lateFee,       ...(overrides.fees?.lateFee || {}) },
    },
    tenureFees: mergeTenureFees(baseConfig.tenureFees, overrides.tenureFees),
    loanPrograms: {
      PERSONAL: buildProgram(basePrograms.PERSONAL, overrides.loanPrograms?.PERSONAL, (overrides.globalLimitsEnabled ?? true) ? loanLimits : undefined),
      BUSINESS: buildProgram(basePrograms.BUSINESS, overrides.loanPrograms?.BUSINESS, (overrides.globalLimitsEnabled ?? true) ? loanLimits : undefined),
    },
    companyName: overrides.companyName || baseConfig.companyName,
    companyWebsite: overrides.companyWebsite || baseConfig.companyWebsite,
    brandLogoUrl: overrides.brandLogoUrl || baseConfig.brandLogoUrl,
    lenderSignatoryName: overrides.lenderSignatoryName || baseConfig.lenderSignatoryName,
    lenderSignatoryPosition: overrides.lenderSignatoryPosition || baseConfig.lenderSignatoryPosition,
    lenderSignatorySignatureUrl: overrides.lenderSignatorySignatureUrl || baseConfig.lenderSignatorySignatureUrl,
    apiUrl: overrides.apiUrl || baseConfig.apiUrl,
    loanManagerEmails: overrides.loanManagerEmails ?? baseConfig.loanManagerEmails,
    adminEmails: overrides.adminEmails ?? baseConfig.adminEmails,
    premblyWidgetId: baseConfig.premblyWidgetId,
    premblyWidgetKey: baseConfig.premblyWidgetKey,
    premblyWidgetIsTest: baseConfig.premblyWidgetIsTest,
  };
  return eff;
}

// Default export — re-computed every import (so admin overrides apply)
export const config = getEffectiveConfig();

export function getLoanProgram(type: LoanProgramKey): LoanProgramConfig {
  return config.loanPrograms[type];
}

export function applyLoanProducts(products: Array<{
  id?: string;
  name: string;
  minAmountNaira: number;
  maxAmountNaira: number;
  defaultTenureDays?: number;
  interestRatePercent: number;
  processingFeePercent: number;
  lateFeePercent: number;
  version?: number;
  updatedAt?: string;
  isActive?: boolean;
  programType?: "PERSONAL" | "BUSINESS" | "BOTH" | null;
}>): void {
  // ---------------------------------------------------------------------------
  // Defensive product resolution.
  //
  // The borrower endpoint must only return the admin-configured catalog, but a
  // legacy backend once served FOUR products where two pairs shared an id
  // (admin-renamed "Personal Loan" v2 + stale seed "Velo Personal Quick" v1).
  // Applying every product in order let the LAST one win and resurrected the
  // ₦50,000 seeds over the admin's ₦200 configuration on every page load.
  //
  // Resolution rules:
  //   1. Ignore inactive products (the backend filters them, but never trust it).
  //   2. De-duplicate by id  -> keep the highest `version` (tie: newest updatedAt).
  //   3. De-duplicate by name-> keep the newest `updatedAt`.
  //   4. Per program type (PERSONAL/BUSINESS) apply ONLY the single
  //      highest-ranked matching product — never a mix.
  //   5. Products the admin renamed away from the personal/business keywords
  //      are mapped via the backend's explicit `programType` first, then a
  //      deterministic fallback — so the borrower NEVER ends up with empty
  //      loan information for either flow.
  // ---------------------------------------------------------------------------
  type Ranked = (typeof products)[number] & { __rank: number };
  const rankOf = (p: { version?: number; updatedAt?: string }): number => {
    // version dominates (PATCH always bumps it), updatedAt only breaks ties.
    const version = Number.isFinite(p.version) ? Number(p.version) : 0;
    const updated = Math.min(Math.max(Date.parse(p.updatedAt ?? "") || 0, 0), 1e16 - 1);
    return version * 1e16 + updated;
  };

  const seenById = new Map<string, Ranked>();
  const seenByName = new Map<string, Ranked>();
  for (const product of products) {
    if (product.isActive === false) continue;
    const ranked: Ranked = { ...product, __rank: rankOf(product) };
    const idKey = typeof product.id === "string" && product.id ? product.id : `anon:${product.name}`;
    const currentById = seenById.get(idKey);
    if (!currentById || ranked.__rank > currentById.__rank) seenById.set(idKey, ranked);
    const nameKey = product.name.trim().toLowerCase();
    const currentByName = seenByName.get(nameKey);
    if (!currentByName || ranked.__rank > currentByName.__rank) seenByName.set(nameKey, ranked);
  }
  // A product survives only if it is BOTH the best for its id AND its name.
  const unique = [...seenById.values()].filter((p) => seenByName.get(p.name.trim().toLowerCase()) === p);

  const applied = new Set<string>();
  // Name -> program mapping (same precedence as before: a name containing
  // "business" maps to BUSINESS even if it also contains "personal").
  const matchesType = (name: string, type: LoanProgramKey): boolean =>
    type === "BUSINESS"
      ? /business/i.test(name)
      : /personal/i.test(name) && !/business/i.test(name);
  const explicitTypesFor = (product: Ranked, type: LoanProgramKey): boolean =>
    product.programType === type || product.programType === "BOTH";
  const applyProduct = (product: Ranked, type: LoanProgramKey): void => {
    const program = config.loanPrograms[type];
    const limits = {
      min: Number(product.minAmountNaira),
      max: Number(product.maxAmountNaira),
      defaultAmount: Math.min(Number(product.maxAmountNaira), Math.max(Number(product.minAmountNaira), program.loanLimits.defaultAmount)),
    };
    // Validate: min < max, both finite, min >= 0. Skip invalid products
    // rather than clobbering good config with bad data.
    if (!Number.isFinite(limits.min) || !Number.isFinite(limits.max) || limits.min >= limits.max || limits.min < 0) {
      return;
    }
    config.loanPrograms[type] = {
      ...program,
      loanLimits: sanitizeLoanLimits(limits),
      // Products expose a default tenure, not the complete admin-configured
      // tenor list. Keep the configured list so calculator options and
      // validation remain consistent with admin settings.
      tenures: program.tenures,
      productName: product.name,
      fees: {
        ...program.fees,
        interest: { ...program.fees.interest, value: Number(product.interestRatePercent) },
        processingFee: { ...program.fees.processingFee, type: "percentage", value: Number(product.processingFeePercent) },
        lateFee: { ...program.fees.lateFee, type: "percentage", value: Number(product.lateFeePercent) },
      },
    };
    applied.add(type);
  };

  // Pass 1 — explicit backend classification (keyword names or programType).
  const appliedProductIds = new Set<string>();
  const idOf = (p: Ranked): string => (typeof p.id === "string" && p.id ? p.id : `anon:${p.name}`);
  for (const type of ["PERSONAL", "BUSINESS"] as LoanProgramKey[]) {
    // Single authoritative product for this type: highest version, then newest
    // updatedAt. Anything else in the list is ignored for this program.
    const candidates = unique.filter((p) => explicitTypesFor(p, type) || matchesType(p.name, type));
    if (candidates.length === 0) continue;
    const product = candidates.reduce((best, p) => (p.__rank > best.__rank ? p : best), candidates[0]);
    applyProduct(product, type);
    appliedProductIds.add(idOf(product));
  }

  // Pass 2 — deterministic fallback so a flow NEVER renders empty loan info
  // (admin may have renamed products away from the personal/business keywords
  // without the backend being able to classify them). Cheapest unclaimed
  // active product first -> PERSONAL, next -> BUSINESS. When every unclassified
  // product is already claimed (single-product platform), the SAME product
  // serves the remaining flow too — an empty program is never acceptable.
  for (const type of ["PERSONAL", "BUSINESS"] as LoanProgramKey[]) {
    if (applied.has(type)) continue;
    const candidatesForType = (ignoreClaims: boolean) => unique
      .filter((p) => ignoreClaims || !appliedProductIds.has(idOf(p)))
      .filter((p) => !p.programType || p.programType === "BOTH" || (!matchesType(p.name, "PERSONAL") && !matchesType(p.name, "BUSINESS")))
      .sort((a, b) => Number(a.minAmountNaira) - Number(b.minAmountNaira));
    const fallback = candidatesForType(false)[0] ?? candidatesForType(true)[0];
    if (fallback) {
      applyProduct(fallback, type);
      appliedProductIds.add(idOf(fallback));
    }
  }
  // Only overwrite the global config.loanLimits if we actually applied a
  // PERSONAL product. Otherwise leave the env-default / localStorage-overridden
  // values intact so the borrower doesn't see a stale seeded ₦50,000 from
  // the backend when the admin has set a different value.
  if (applied.has("PERSONAL")) {
    const personal = config.loanPrograms.PERSONAL;
    config.loanLimits = sanitizeLoanLimits(personal.loanLimits);
    config.tenures = personal.tenures.slice();
  }
}

// Re-export base for the admin UI (to show env-default values)
export { baseConfig };

// ---------------------------------------------------------------------------
// Live-reload helper for admin UI — call this to refresh `config` from storage
// ---------------------------------------------------------------------------

export function refreshConfig(overrides: AdminConfigOverride = loadAdminOverrides()): void {
  const fresh = getEffectiveConfig(overrides);
  Object.assign(config, fresh);
  config.loanLimits = sanitizeLoanLimits(fresh.loanLimits);
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


  const nMin = Number(loanLimits?.min);
  const nMax = Number(loanLimits?.max);
  const nDefault = Number(loanLimits?.defaultAmount);
  if (!Number.isFinite(nMin) || !Number.isFinite(nMax) || !(nMin < nMax)) {
    errors.push({
      key: "LOAN_LIMITS",
      message: `Minimum loan amount (₦${safeNaira(nMin)}) must be less than maximum loan amount (₦${safeNaira(nMax)}).`,
      severity: "error",
    });
  }

  if (Number.isFinite(nMin) && Number.isFinite(nMax) && Number.isFinite(nDefault) && (nDefault < nMin || nDefault > nMax)) {
    errors.push({
      key: "LOAN_DEFAULT",
      message: `Default loan amount (₦${safeNaira(nDefault)}) must be between min (₦${safeNaira(nMin)}) and max (₦${safeNaira(nMax)}).`,
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
