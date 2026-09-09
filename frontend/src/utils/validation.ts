// ============================================================================
// src/utils/validation.ts
// Lightweight runtime validators + zod schemas for forms.
// BVN/NIN are validated for FORMAT ONLY — never sent off-device except to
// the trusted Apps Script backend.
// ============================================================================

import { z } from "zod";
import {
  ALLOWED_DOC_EXTENSIONS,
  ALLOWED_DOC_MIME,
  MAX_DOC_SIZE_BYTES,
  type FileValidationResult,
} from "../types/documents";
import { config } from "./config";

// ---------------------------------------------------------------------------
// Nigerian-format helpers (format only — NOT a security check)
// ---------------------------------------------------------------------------

const BVN_REGEX = /^\d{11}$/;
const NIN_REGEX = /^\d{11}$/;
const PHONE_REGEX = /^(?:\+?234|0)?\d{10}$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v: string): boolean {
  return EMAIL_REGEX.test(v.trim());
}

export function isValidPhone(v: string): boolean {
  const cleaned = v.replace(/[\s-]/g, "");
  return PHONE_REGEX.test(cleaned);
}

export function isValidBvn(v: string): boolean {
  return BVN_REGEX.test(v.trim());
}

export function isValidNin(v: string): boolean {
  return NIN_REGEX.test(v.trim());
}

// ---------------------------------------------------------------------------
// File validation
// ---------------------------------------------------------------------------

export function validateDocumentFile(file: File, media = false): FileValidationResult {
  if (!file) return { valid: false, error: "No file selected." };

  if (file.size > MAX_DOC_SIZE_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { valid: false, error: `File is ${mb} MB. Maximum allowed size is 10 MB.` };
  }

  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const allowedExtensions = media ? [...ALLOWED_DOC_EXTENSIONS] : ALLOWED_DOC_EXTENSIONS.filter((item) => !["mp4", "mov", "webm"].includes(item));
  if (!allowedExtensions.includes(ext as never)) {
    return { valid: false, error: `File type ".${ext}" is not allowed. Use ${media ? "JPG, PNG, MP4, MOV, or WEBM" : "PDF, JPG, JPEG, or PNG"}.` };
  }

  if (!media && !ALLOWED_DOC_MIME.includes(file.type as never)) {
    // Some browsers don't set MIME for .pdf etc.; rely on extension as fallback.
    if (!ext) {
      return { valid: false, error: "Unable to determine file type." };
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// Zod schemas (used by react-hook-form)
// ---------------------------------------------------------------------------

export const personalInfoSchema = z.object({
  fullName: z.string().min(3, "Full name is required (at least 3 characters)."),
  phone: z.string().refine(isValidPhone, "Enter a valid Nigerian phone number."),
  email: z.string().refine(isValidEmail, "Enter a valid email address."),
  dateOfBirth: z.string().min(1, "Date of birth is required."),
  residentialAddress: z.string().min(10, "Enter your full residential address."),
  state: z.string().min(1, "Select your state."),
  lga: z.string().min(1, "Select your LGA."),
});

export const disbursementAccountSchema = z.object({
  accountName: z.string().min(3, "Account name is required."),
  bankName: z.string().min(2, "Bank name is required."),
  accountNumber: z.string().regex(/^\d{10}$/, "Account number must be exactly 10 digits."),
});

export const personalFinancialSchema = z.object({
  employmentStatus: z.string().min(1, "Select your employment status."),
  employerBusinessName: z.string().optional().default(""),
  monthlyIncome: z.string().min(1, "Monthly income is required."),
  monthlyExpenses: z.string().min(1, "Monthly expenses are required."),
  existingLoanObligations: z.string().optional().default(""),
  expectedRepaymentSource: z.string().min(3, "Tell us how you intend to repay this loan."),
});

export const businessInfoSchema = z.object({
  businessName: z.string().min(2, "Business name is required."),
  businessRegistrationNumber: z.string().optional().default(""),
  businessType: z.string().min(1, "Select your business type."),
  businessAddress: z.string().min(10, "Enter your business address."),
  businessIndustry: z.string().min(1, "Select your industry."),
  yearsInBusiness: z.string().min(1, "Enter years in business."),
});

export const businessRepSchema = z.object({
  fullName: z.string().min(3, "Full name is required."),
  dateOfBirth: z.string().min(1, "Date of birth is required."),
  position: z.string().min(1, "Select the representative's position."),
  phone: z.string().refine(isValidPhone, "Enter a valid Nigerian phone number."),
  email: z.string().refine(isValidEmail, "Enter a valid email address."),
  residentialAddress: z.string().min(10, "Enter the residential address."),
});

export const businessFinancialSchema = z.object({
  averageMonthlyRevenue: z.string().min(1, "Average monthly revenue is required."),
  averageMonthlyExpenses: z.string().min(1, "Average monthly expenses are required."),
  existingLoanObligations: z.string().optional().default(""),
  expectedRepaymentSource: z.string().min(3, "Tell us how the business intends to repay this loan."),
});

export const kycSchema = z.object({
  bvn: z.string().refine(isValidBvn, "BVN must be exactly 11 digits."),
  nin: z.string().refine(isValidNin, "NIN must be exactly 11 digits."),
  identificationType: z.string().min(1, "Select an identification type."),
  identificationNumber: z.string().min(3, "Identification number is required."),
});

export function loanRequestSchemaFor(limits = config.loanLimits, tenures = config.tenures) {
  return z.object({
    amount: z.number().min(limits.min, `Loan amount must be at least ₦${limits.min.toLocaleString()}.`).max(limits.max, `Loan amount cannot exceed ₦${limits.max.toLocaleString()}.`),
    tenure: z.number().refine((v) => tenures.some((t) => t.value === v), `Select a valid tenure (${tenures.map((t) => `${t.value} days`).join(", ")}).`),
    purpose: z.string().min(10, "Tell us what the loan is for (at least 10 characters)."),
  });
}

export const loanRequestSchema = loanRequestSchemaFor();

export type PersonalInfoForm    = z.infer<typeof personalInfoSchema>;
export type DisbursementAccountForm = z.infer<typeof disbursementAccountSchema>;
export type PersonalFinancialForm = z.infer<typeof personalFinancialSchema>;
export type BusinessInfoForm    = z.infer<typeof businessInfoSchema>;
export type BusinessRepForm     = z.infer<typeof businessRepSchema>;
export type BusinessFinancialForm = z.infer<typeof businessFinancialSchema>;
export type KycForm              = z.infer<typeof kycSchema>;
export type LoanRequestForm     = z.infer<typeof loanRequestSchema>;
