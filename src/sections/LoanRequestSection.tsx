// ============================================================================
// src/sections/LoanRequestSection.tsx
// Loan amount + tenure selector + live fee breakdown. Shared by both flows.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import LoanAmountSelector from "../components/LoanAmountSelector";
import LoanSummary from "../components/LoanSummary";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { type LoanRequestForm } from "../utils/validation";
import { getLoanProgram } from "../utils/config";
import { loanRequestSchemaFor } from "../utils/validation";

export default function LoanRequestSection() {
  const { application, calculation, patchLoanRequest, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const program = getLoanProgram(application.applicantType || "PERSONAL");
  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, isValid },
  } = useForm<LoanRequestForm>({
    resolver: zodResolver(loanRequestSchemaFor(program.loanLimits, program.tenures)),
    mode: "onChange",
    defaultValues: {
      amount: application.loanRequest.amount,
      tenure: application.loanRequest.tenure,
      purpose: application.loanRequest.purpose,
    },
  });

  const amountWatch = watch("amount");
  const tenureWatch = watch("tenure");

  function handleAmountChange(v: number) {
    setValue("amount", v, { shouldValidate: true, shouldDirty: true });
    patchLoanRequest({ amount: v });
  }

  function handleTenureChange(v: number) {
    setValue("tenure", v, { shouldValidate: true, shouldDirty: true });
    patchLoanRequest({ tenure: v });
  }

  function onSubmit(data: LoanRequestForm) {
    patchLoanRequest(data);
    markSectionStatus("loanRequest", "completed");
    next();
  }

  return (
    <SectionShell
      title="Loan Request"
      description="Select your loan amount and preferred tenure. Fees recalculate automatically."
      canContinue={isValid && !!calculation}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left — selectors */}
          <div className="lg:col-span-3 space-y-5">
            <LoanAmountSelector
              value={amountWatch}
              onChange={handleAmountChange}
              error={errors.amount?.message}
              min={program.loanLimits.min}
              max={program.loanLimits.max}
            />

            <div>
              <label className="velo-label">Repayment Tenure <span className="text-red-500">*</span></label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {program.tenures.map((t) => {
                  const active = tenureWatch === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => handleTenureChange(t.value)}
                      className={`px-3 py-3 rounded-xl border-2 text-sm font-semibold transition
                        ${active ? "border-velo-500 bg-velo-50 text-velo-700" : "border-slate-200 bg-white text-slate-600 hover:border-velo-300"}`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
              {errors.tenure && <p className="velo-error-text">{errors.tenure.message}</p>}
              <p className="velo-helper">Choose how long you need to repay the loan.</p>
            </div>

            <div>
              <label className="velo-label" htmlFor="loan-purpose">
                Loan Purpose <span className="text-red-500">*</span>
              </label>
              <textarea
                id="loan-purpose"
                rows={3}
                placeholder="Tell us what the loan will be used for (e.g. school fees, working capital, equipment purchase)…"
                className={`velo-input resize-none ${errors.purpose?.message ? "velo-input-error" : ""}`}
                {...register("purpose")}
                onChange={(e) => { register("purpose").onChange(e); patchLoanRequest({ purpose: e.target.value }); }}
              />
              {errors.purpose?.message && <p className="velo-error-text">{errors.purpose.message}</p>}
            </div>
          </div>

          {/* Right — live summary */}
          <div className="lg:col-span-2">
            {calculation && <LoanSummary calculation={calculation} />}
          </div>
        </div>
      </form>
    </SectionShell>
  );
}
