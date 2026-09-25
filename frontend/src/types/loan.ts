// ============================================================================
// src/types/loan.ts
// Core loan domain types: fee configuration, calculation results, tenures.
// ============================================================================

export type FeeType = "flat" | "percentage";
export type LoanProgramKey = "PERSONAL" | "BUSINESS";

export interface CollateralConfig {
  enabled: boolean;
  required: boolean;
}

/**
 * The backend loan product whose terms are CURRENTLY applied to a program.
 * Captured by applyLoanProduct / applyLoanProducts so the borrower UI can
 * render loan information (name, range, interest, fees, grace period) for
 * EXACTLY the product the admin configured — never an anonymous mix.
 */
export interface AppliedLoanProductInfo {
  id?: string;
  name: string;
  description?: string;
  /** Explicit flow mapping stamped by the backend (admin's choice). */
  programType?: "PERSONAL" | "BUSINESS" | "BOTH" | null;
  minAmountNaira: number;
  maxAmountNaira: number;
  /** Pre-selected amount on the borrower form (within [min,max]). */
  defaultAmountNaira?: number;
  defaultTenureDays?: number;
  /** Allowed tenor list (days) — the tenure picker renders exactly this. */
  tenureDays?: number[];
  interestRatePercent: number;
  interestType: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED";
  processingFeePercent: number;
  /** One-off administration fee on the loan amount (percent). */
  serviceFeePercent: number;
  lateFeePercent: number;
  lateFeeType?: "ONE_TIME" | "COMPOUNDING_DAILY" | "COMPOUNDING_MONTHLY";
  gracePeriodDays?: number;
  /** Collateral rules configured on the product itself. */
  collateralEnabled?: boolean;
  collateralRequired?: boolean;
}

export interface LoanProgramConfig {
  loanLimits: LoanLimits;
  tenures: TenureOption[];
  fees: FeeConfiguration;
  tenureFees: TenureFeeOverrides;
  collateral: CollateralConfig;
  /**
   * Name of the backend loan product whose terms are currently applied to
   * this program (set by applyLoanProducts). Lets the borrower UI show WHICH
   * product drives the amounts/fees instead of an anonymous mix.
   */
  productName?: string;
  /**
   * Full detail of the applied product (set by applyLoanProduct /
   * applyLoanProducts). Preferred source for the borrower product banner.
   */
  product?: AppliedLoanProductInfo | null;
}

export type LoanProgramOverrides = Partial<Record<LoanProgramKey, Partial<LoanProgramConfig>>>;

export type FeeKey =
  | "interest"
  | "serviceFee"
  | "processingFee"
  | "lateFee";

/** A single fee's configuration, as read from .env */
export interface FeeConfig {
  type: FeeType;
  value: number;
  /** Whether this fee is active globally */
  enabled?: boolean;
  /** Whether this fee should be included in the initial repayment total */
  includeUpfront: boolean;
  /**
   * Interest semantics carried over from the loan product catalog. Only used
   * for the INTEREST fee:
   *   SIMPLE_FLAT / REDUCING_BALANCE -> percent of principal per 30-day month,
   *                                    prorated over the tenure (legacy math).
   *   ANNUALIZED                     -> yearly percent prorated over the
   *                                    tenure (days / 365).
   * Absent = legacy monthly behaviour.
   */
  interestType?: "SIMPLE_FLAT" | "REDUCING_BALANCE" | "ANNUALIZED";
}

/**
 * Full runtime fee configuration block. Each fee the application knows about
 * must be represented here so that the calculator and UI stay in sync.
 */
export interface FeeConfiguration {
  interest: FeeConfig;
  serviceFee: FeeConfig;
  processingFee: FeeConfig;
  lateFee: FeeConfig;
}

/**
 * Per-tenure fee overrides.
 * Maps a tenure (in days) to a partial FeeConfiguration.
 * Any fee not specified for the given tenure falls back to the global config.
 */
export type TenureFeeOverrides = Record<number, Partial<FeeConfiguration>>;

/** Result of a single fee calculation */
export interface FeeBreakdownItem {
  key: FeeKey;
  label: string;
  amount: number;
  /** "Loan Cost" | "Application Fee" | "Default Fee" */
  category: FeeCategory;
}

export type FeeCategory = "loan-cost" | "application-fee" | "default-fee";

/** Full loan calculation result */
export interface LoanCalculation {
  loanAmount: number;
  interest: number;
  serviceFee: number;
  processingFee: number;
  lateFee: number;
  totalFees: number;        // sum of upfront fees only (loan cost + application fees)
  totalRepayment: number;   // loanAmount + totalFees
  upfrontFees: number;      // application + interest (what is paid/added at disbursement)
  loanCost: number;         // interest only
  defaultFee: number;       // late fee (separate, shown only as informational)
  tenure: number;            // days
  tenureLabel: string;      // "30 Days"
  disbursementDate: string;  // ISO date string
  repaymentDate: string;    // ISO date string
  repaymentDateLabel: string;// "30 October 2026"
  breakdown: FeeBreakdownItem[];
}

export interface TenureOption {
  value: number;       // days
  label: string;       // "30 Days"
}

export interface LoanLimits {
  min: number;
  max: number;
  defaultAmount: number;
}
