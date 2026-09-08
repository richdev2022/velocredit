// ============================================================================
// src/sections/PersonalFinancialSection.tsx
// Section 3 for Personal Loan applicants.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { personalFinancialSchema, type PersonalFinancialForm } from "../utils/validation";

const EMPLOYMENT_OPTIONS = [
  { value: "Employed",       label: "Employed" },
  { value: "Self-employed",  label: "Self-employed" },
  { value: "Business Owner", label: "Business Owner" },
  { value: "Other",          label: "Other" },
];

export default function PersonalFinancialSection() {
  const { application, patchPersonalFinancial, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid },
  } = useForm<PersonalFinancialForm>({
    resolver: zodResolver(personalFinancialSchema),
    mode: "onChange",
    defaultValues: {
      employmentStatus: application.personalFinancial.employmentStatus,
      employerBusinessName: application.personalFinancial.employerBusinessName,
      monthlyIncome: application.personalFinancial.monthlyIncome,
      monthlyExpenses: application.personalFinancial.monthlyExpenses,
      existingLoanObligations: application.personalFinancial.existingLoanObligations,
      expectedRepaymentSource: application.personalFinancial.expectedRepaymentSource,
    },
  });

  const employment = watch("employmentStatus");
  const employerLabel = employment === "Business Owner" ? "Business Name" : employment === "Employed" ? "Employer Name" : "Employer / Business Name";

  function sync<K extends keyof PersonalFinancialForm>(key: K, value: PersonalFinancialForm[K]) {
    patchPersonalFinancial({ [key]: value } as any);
  }

  function onSubmit(data: PersonalFinancialForm) {
    patchPersonalFinancial(data);
    markSectionStatus("financial", "completed");
    next();
  }

  return (
    <SectionShell
      title="Financial Information"
      description="Tell us about your income and monthly financial obligations."
      canContinue={isValid}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SelectInput
            label="Employment Status"
            required
            placeholder="Select employment status"
            options={EMPLOYMENT_OPTIONS}
            error={errors.employmentStatus?.message}
            {...register("employmentStatus")}
            onChange={(e) => { register("employmentStatus").onChange(e); sync("employmentStatus", e.target.value as any); }}
          />
          <FormInput
            label={employerLabel}
            placeholder={employment === "Business Owner" ? "Your business name" : "Employer / business name"}
            helper="Optional"
            {...register("employerBusinessName")}
            onChange={(e) => { register("employerBusinessName").onChange(e); sync("employerBusinessName", e.target.value); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Monthly Income"
            required
            type="text"
            inputMode="numeric"
            prefix="₦"
            placeholder="e.g. 250,000"
            error={errors.monthlyIncome?.message}
            {...register("monthlyIncome")}
            onChange={(e) => { register("monthlyIncome").onChange(e); sync("monthlyIncome", e.target.value); }}
          />
          <FormInput
            label="Monthly Expenses"
            required
            type="text"
            inputMode="numeric"
            prefix="₦"
            placeholder="e.g. 120,000"
            error={errors.monthlyExpenses?.message}
            {...register("monthlyExpenses")}
            onChange={(e) => { register("monthlyExpenses").onChange(e); sync("monthlyExpenses", e.target.value); }}
          />
        </div>

        <FormInput
          label="Existing Loan Obligations"
          helper="Optional — total monthly repayments on other loans, if any."
          type="text"
          inputMode="numeric"
          prefix="₦"
          placeholder="e.g. 50,000"
          {...register("existingLoanObligations")}
          onChange={(e) => { register("existingLoanObligations").onChange(e); sync("existingLoanObligations", e.target.value); }}
        />

        <FormInput
          label="Expected Repayment Source"
          required
          placeholder="e.g. Salary, business profits"
          error={errors.expectedRepaymentSource?.message}
          {...register("expectedRepaymentSource")}
          onChange={(e) => { register("expectedRepaymentSource").onChange(e); sync("expectedRepaymentSource", e.target.value); }}
        />
      </form>
    </SectionShell>
  );
}
