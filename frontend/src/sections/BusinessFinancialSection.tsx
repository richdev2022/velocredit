// ============================================================================
// src/sections/BusinessFinancialSection.tsx
// Section 4 for Business Loan applicants — short & focused.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { businessFinancialSchema, type BusinessFinancialForm } from "../utils/validation";

export default function BusinessFinancialSection() {
  const { application, patchBusinessFinancial, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<BusinessFinancialForm>({
    resolver: zodResolver(businessFinancialSchema),
    mode: "onChange",
    defaultValues: {
      averageMonthlyRevenue: application.businessFinancial.averageMonthlyRevenue,
      averageMonthlyExpenses: application.businessFinancial.averageMonthlyExpenses,
      existingLoanObligations: application.businessFinancial.existingLoanObligations,
      expectedRepaymentSource: application.businessFinancial.expectedRepaymentSource,
    },
  });

  function sync<K extends keyof BusinessFinancialForm>(key: K, value: BusinessFinancialForm[K]) {
    patchBusinessFinancial({ [key]: value } as any);
  }

  function onSubmit(data: BusinessFinancialForm) {
    patchBusinessFinancial(data);
    markSectionStatus("financial", "completed");
    next();
  }

  return (
    <SectionShell
      title="Business Financial Information"
      description="Tell us about your business's monthly revenue and expenses."
      canContinue={isValid}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Average Monthly Business Revenue"
            required
            type="text"
            inputMode="numeric"
            prefix="₦"
            placeholder="e.g. 1,500,000"
            error={errors.averageMonthlyRevenue?.message}
            {...register("averageMonthlyRevenue")}
            onChange={(e) => { register("averageMonthlyRevenue").onChange(e); sync("averageMonthlyRevenue", e.target.value); }}
          />
          <FormInput
            label="Average Monthly Business Expenses"
            required
            type="text"
            inputMode="numeric"
            prefix="₦"
            placeholder="e.g. 700,000"
            error={errors.averageMonthlyExpenses?.message}
            {...register("averageMonthlyExpenses")}
            onChange={(e) => { register("averageMonthlyExpenses").onChange(e); sync("averageMonthlyExpenses", e.target.value); }}
          />
        </div>

        <FormInput
          label="Existing Business Loan Obligations"
          helper="Optional — total monthly repayments on other loans, if any."
          type="text"
          inputMode="numeric"
          prefix="₦"
          placeholder="e.g. 150,000"
          {...register("existingLoanObligations")}
          onChange={(e) => { register("existingLoanObligations").onChange(e); sync("existingLoanObligations", e.target.value); }}
        />

        <FormInput
          label="Expected Repayment Source"
          required
          placeholder="e.g. Business revenue, invoices, contracts"
          error={errors.expectedRepaymentSource?.message}
          {...register("expectedRepaymentSource")}
          onChange={(e) => { register("expectedRepaymentSource").onChange(e); sync("expectedRepaymentSource", e.target.value); }}
        />
      </form>
    </SectionShell>
  );
}
