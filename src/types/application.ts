// ============================================================================
// src/types/application.ts
// Top-level application state, sections, and status tracking.
// ============================================================================

import type { LoanCalculation } from "./loan";
import type { DocumentMap } from "./documents";

export type ApplicantType = "PERSONAL" | "BUSINESS";

export type ApplicationStatus =
  | "DRAFT"
  | "IN_PROGRESS"
  | "SUBMITTED"
  | "UNDER_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "DISBURSED"
  | "REPAID";

export type SectionKey =
  | "applicantType"
  | "info"          // personal info OR business info
  | "kyc"           // personal KYC OR business rep KYC
  | "financial"     // personal financial OR business financial
  | "businessRep"   // business representative (business only)
  | "loanRequest"
  | "collateral"
  | "agreement"
  | "review";

export type SectionStatus = "not_started" | "in_progress" | "completed" | "skipped" | "locked";

export interface SectionState {
  key: SectionKey;
  label: string;
  status: SectionStatus;
  /** True if this section is required for submission */
  required: boolean;
  /** True if user can skip this section */
  skippable: boolean;
}

// ---------------------------------------------------------------------------
// Personal data
// ---------------------------------------------------------------------------

export interface PersonalInfo {
  fullName: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  residentialAddress: string;
  state: string;
  lga: string;
}

export interface DisbursementAccount {
  accountName: string;
  bankName: string;
  accountNumber: string;
}

export interface PersonalFinancialInfo {
  employmentStatus: "Employed" | "Self-employed" | "Business Owner" | "Other" | "";
  employerBusinessName: string;
  monthlyIncome: string;
  monthlyExpenses: string;
  existingLoanObligations: string;
  expectedRepaymentSource: string;
}

// ---------------------------------------------------------------------------
// Business data
// ---------------------------------------------------------------------------

export interface BusinessInfo {
  businessName: string;
  businessRegistrationNumber: string;
  businessType: "Sole Proprietorship" | "Limited Liability Company" | "Partnership" | "Other" | "";
  businessAddress: string;
  businessIndustry: string;
  yearsInBusiness: string;
}

export interface BusinessRepresentative {
  fullName: string;
  dateOfBirth: string;
  position: "Owner" | "Director" | "Managing Director" | "Partner" | "Manager" | "Other" | "";
  phone: string;
  email: string;
  residentialAddress: string;
}

export interface BusinessFinancialInfo {
  averageMonthlyRevenue: string;
  averageMonthlyExpenses: string;
  existingLoanObligations: string;
  expectedRepaymentSource: string;
}

// ---------------------------------------------------------------------------
// KYC (shared structure — used by both personal KYC and business-rep KYC)
// ---------------------------------------------------------------------------

export type IdentificationType =
  | "National ID Card"
  | "International Passport"
  | "Driver's Licence"
  | "Voter's Card"
  | "";

export interface KycInfo {
  bvn: string;
  nin: string;
  identificationType: IdentificationType;
  identificationNumber: string;
}

// ---------------------------------------------------------------------------
// Loan request
// ---------------------------------------------------------------------------

export interface LoanRequest {
  amount: number;
  tenure: number; // days
  purpose: string;
}

export interface CollateralInfo {
  provided: boolean;
  type: string;
  description: string;
  estimatedValue: string;
  ownership: string;
  location: string;
  documentReference: string;
}

// ---------------------------------------------------------------------------
// Agreement
// ---------------------------------------------------------------------------

export interface AgreementState {
  generatedAt: string | null;
  generatedHtml: string | null;
  signedAgreementAccepted: boolean; // consent checkbox
}

// ---------------------------------------------------------------------------
// Full application state
// ---------------------------------------------------------------------------

export interface ApplicationData {
  applicationId: string;       // VEL-DRAFT-2026-000124 (or VEL-LN-2026-000124 after submission)
  applicantType: ApplicantType | null;
  status: ApplicationStatus;

  /** Last section index the user was on — persisted server-side so resume across devices lands on exact page. */
  lastSectionIndex?: number | null;

  personalInfo: PersonalInfo;
  disbursementAccount: DisbursementAccount;
  personalFinancial: PersonalFinancialInfo;

  businessInfo: BusinessInfo;
  businessRep: BusinessRepresentative;
  businessFinancial: BusinessFinancialInfo;

  kyc: KycInfo;

  loanRequest: LoanRequest;
  collateral: CollateralInfo;
  calculation: LoanCalculation | null;

  documents: DocumentMap;

  agreement: AgreementState;

  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
}

// ---------------------------------------------------------------------------
// Lookup index — used by the resume screen to find drafts by email + phone.
// Stored separately in localStorage, NOT including sensitive KYC fields.
// ---------------------------------------------------------------------------

export interface DraftIndexEntry {
  applicationId: string;
  applicantType: ApplicantType;
  email: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
  status: ApplicationStatus;
  displayName: string; // Full name OR business name
}

// ---------------------------------------------------------------------------
// API responses
// ---------------------------------------------------------------------------

export interface SaveDraftResponse {
  ok: boolean;
  applicationId: string;
  status: ApplicationStatus;
  sheetRow?: number;
  driveFolderUrl?: string;
  documentUrls?: Partial<Record<keyof DocumentMap, string>>;
  message?: string;
  error?: string;
}

export interface SubmitResponse {
  ok: boolean;
  applicationId: string;       // final VEL-LN-... ID
  status: ApplicationStatus;
  sheetRow?: number;
  driveFolderUrl?: string;
  documentUrls?: Partial<Record<keyof DocumentMap, string>>;
  message?: string;
  error?: string;
}

export interface LookupDraftResponse {
  ok: boolean;
  found: boolean;
  application?: ApplicationData;
  /** Server-side stored last section index (populated independently for convenience). */
  lastSectionIndex?: number | null;
  alreadySubmitted?: boolean;
  applicationId?: string;
  status?: ApplicationStatus;
  message?: string;
  error?: string;
}
