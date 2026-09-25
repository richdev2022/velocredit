// ============================================================================
// src/sections/LoanRequestSection.tsx
// Loan amount + tenure selector + live fee breakdown. Shared by both flows.
//
// PRODUCT BINDING CONTRACT (2026-09 incident fix):
//   This screen fetches the catalog with `?type=<applicantType>` so the
//   backend returns the SINGLE authoritative product for the flow the
//   customer selected. Every piece of loan information below — product name,
//   description, amount range, interest (with its type semantics), processing
//   fee, late fee and grace period — renders from THAT product only. No other
//   catalog entry may influence this screen, and no stale env defaults are
//   shown while the admin has configured a product.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import LoanAmountSelector from "../components/LoanAmountSelector";
import LoanSummary from "../components/LoanSummary";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { type LoanRequestForm } from "../utils/validation";
import { getLoanProgram, applyLoanProduct, applyLoanProducts } from "../utils/config";
import { loanRequestSchemaFor } from "../utils/validation";
import { clampTenure } from "../utils/loanCalculator";
import { getLoanProducts, type LoanProduct } from "../services/apiClient";
import type { LoanProgramKey } from "../types/loan";

/** Human labels for the product's interest semantics (matches admin catalog). */
const INTEREST_TYPE_LABELS: Record<string, string> = {
  ANNUALIZED: "p.a. (prorated over tenure)",
  SIMPLE_FLAT: "per month",
  REDUCING_BALANCE: "per month, reducing balance",
};

const LATE_FEE_TYPE_LABELS: Record<string, string> = {
  ONE_TIME: "one-time",
  COMPOUNDING_DAILY: "daily compounding",
  COMPOUNDING_MONTHLY: "monthly compounding",
};

export default function LoanRequestSection() {
  const { application, calculation, patchLoanRequest, markSectionStatus, next } = useApplication();
  const applicantType: LoanProgramKey = application?.applicantType || "PERSONAL";

  // Type-scoped product fetch: the backend resolves THE product for this
  // application flow (?type=PERSONAL|BUSINESS) and its terms are applied
  // strictly to this flow's program config. Re-runs if the applicant type
  // changes so the two flows can never cross-contaminate.
  const [appliedProduct, setAppliedProduct] = useState<LoanProduct | null>(null);
  const [configVersion, setConfigVersion] = useState(0);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getLoanProducts({ type: applicantType }).then((response) => {
      if (cancelled) return;
      const product = response.products[0] ?? null;
      if (product) {
        // Strict per-flow application — the backend already picked THE product
        // for this applicant type. Works even when the backend serves the
        // all-inactive fallback (catalogNotice), so the admin's configured
        // terms always beat stale env defaults.
        applyLoanProduct(product, applicantType);
        setAppliedProduct(product);
      } else {
        // Defensive: an empty catalog response keeps whatever config is
        // already in memory rather than wiping the screen.
        applyLoanProducts(response.products, {
          includeInactive: response.catalogNotice === "ALL_PRODUCTS_INACTIVE_FALLBACK",
        });
      }
      setConfigVersion((v) => v + 1);
    }).catch(() => {
      // If the fetch fails, fall back to whatever config is already in memory.
    });
    return () => { cancelled = true; };
  }, [applicantType]);

  // Re-read the program after the re-fetch completes (configVersion forces the
  // useMemo below to re-run, so the freshly applied product terms are used).
  void configVersion;
  const program = useMemo(
    () => getLoanProgram(applicantType),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applicantType, configVersion],
  );

  // Preselect the product's default tenure for fresh applications (the saved
  // value always wins once the customer has picked one).
  useEffect(() => {
    const defaultTenure = appliedProduct?.defaultTenureDays;
    if (!defaultTenure) return;
    if (application?.loanRequest.tenure) return;
    const resolved = clampTenure(defaultTenure, program.tenures);
    setValue("tenure", resolved, { shouldDirty: false, shouldValidate: false });
    patchLoanRequest({ tenure: resolved });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedProduct, program.tenures, application?.loanRequest.tenure]);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm<LoanRequestForm>({
    resolver: zodResolver(loanRequestSchemaFor(program.loanLimits, program.tenures)),
    // FREE TYPING CONTRACT: the amount input accepts ANY number the user types
    // ("200", "45,000", clearing to retype…). Nothing is rejected mid-keystroke.
    // Validation runs on submit — a value below the product minimum or above
    // its maximum is REJECTED there with a clear message, and after that first
    // rejection the form re-validates on change so fixing the amount clears
    // the error immediately.
    mode: "onSubmit",
    reValidateMode: "onChange",
    defaultValues: {
      amount: application?.loanRequest.amount,
      tenure: application?.loanRequest.tenure,
      purpose: application?.loanRequest.purpose,
    } as LoanRequestForm,
  });

  const amountWatch = watch("amount");
  const tenureWatch = watch("tenure");

  function handleAmountChange(v: number) {
    // Before the first submit attempt the value is NOT validated on change —
    // the customer may freely type/retype any amount. After a rejected submit
    // the error must clear as soon as the amount becomes valid.
    setValue("amount", v, { shouldValidate: submitAttempted, shouldDirty: true });
    patchLoanRequest({ amount: v });
  }

  function handleTenureChange(v: number) {
    setValue("tenure", v, { shouldValidate: submitAttempted, shouldDirty: true });
    patchLoanRequest({ tenure: v });
  }

  function onSubmit(data: LoanRequestForm) {
    patchLoanRequest(data);
    markSectionStatus("loanRequest", "completed");
    next();
  }

  // NOTE: Hooks above must run unconditionally (Rules of Hooks). Only AFTER
  // all hooks is it safe to bail out of rendering when there is no application.
  if (!application) return null;

  // The Continue button must NOT be gated on form validity: an out-of-range
  // amount has to reach handleSubmit so it can be REJECTED with a visible
  // message (never silently disabled). calculation===null only happens when no
  // amount exists at all yet.
  const canContinue = !!calculation;

  // ---------------------------------------------------------------------------
  // Product banner — bound STRICTLY to the returned product. The range,
  // interest (with its semantics), fees and grace period below come from THIS
  // product only; the program config is the fallback when the fetch failed.
  // ---------------------------------------------------------------------------
  const typeLabel = applicantType === "BUSINESS" ? "Business" : "Personal";
  const bannerProduct = appliedProduct ?? program.product ?? null;
  const bannerName = bannerProduct?.name
    ?? program.productName
    ?? (applicantType === "BUSINESS" ? "Business Loan" : "Personal Loan");
  const bannerMin = bannerProduct ? bannerProduct.minAmountNaira : program.loanLimits.min;
  const bannerMax = bannerProduct ? bannerProduct.maxAmountNaira : program.loanLimits.max;
  const bannerRate = bannerProduct ? bannerProduct.interestRatePercent : program.fees.interest.value;
  const bannerRateType = bannerProduct
    ? bannerProduct.interestType
    : (program.fees.interest.interestType ?? "SIMPLE_FLAT");
  const bannerProcessingFee = bannerProduct ? bannerProduct.processingFeePercent : program.fees.processingFee.value;
  const bannerLateFee = bannerProduct ? bannerProduct.lateFeePercent : program.fees.lateFee.value;
  const bannerLateFeeType = bannerProduct?.lateFeeType;
  const bannerGraceDays = bannerProduct?.gracePeriodDays;

  return (
    <SectionShell
      title="Loan Request"
      description="Type any amount — it must fall within this product's range to continue."
      canContinue={canContinue}
      onContinue={handleSubmit(onSubmit, () => setSubmitAttempted(true))}
    >
      <form onSubmit={handleSubmit(onSubmit, () => setSubmitAttempted(true))} className="space-y-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Product terms — from THE product the backend resolved for this
              application type only. */}
          <div className="lg:col-span-5 rounded-2xl border border-velo-100 bg-velo-50/60 p-4 dark:border-velo-800 dark:bg-velo-900/20">
            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-velo-600 dark:text-velo-300">
                  {typeLabel} loan product
                </p>
                <p className="text-base font-bold text-slate-900 dark:text-white">
                  {bannerName}
                </p>
                {bannerProduct?.description && (
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400 max-w-prose">
                    {bannerProduct.description}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Amount range: </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    ₦{Number(bannerMin).toLocaleString()} – ₦{Number(bannerMax).toLocaleString()}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Interest: </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {bannerRate}% {INTEREST_TYPE_LABELS[bannerRateType] ?? "per month"}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Processing fee: </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {bannerProcessingFee}%
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-slate-400">Late fee: </span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">
                    {bannerLateFee}%{bannerLateFeeType ? ` (${LATE_FEE_TYPE_LABELS[bannerLateFeeType] ?? bannerLateFeeType})` : ""}
                  </span>
                </div>
                {typeof bannerGraceDays === "number" && (
                  <div>
                    <span className="text-slate-500 dark:text-slate-400">Grace period: </span>
                    <span className="font-semibold text-slate-800 dark:text-slate-100">
                      {bannerGraceDays} {bannerGraceDays === 1 ? "day" : "days"}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>

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
                        ${active ? "border-velo-500 bg-velo-50 text-velo-700 dark:border-velo-500 dark:bg-velo-900/30 dark:text-velo-300" : "border-slate-200 bg-white text-slate-600 hover:border-velo-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-velo-700"}`}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
              {errors.tenure && <p className="velo-error-text">{errors.tenure.message}</p>}
              {/* Per-tenor pricing (easimoney style): when the admin pinned a
                  dedicated monthly rate to the selected tenor, say so — the
                  live summary below already shows the naira impact. */}
              {(() => {
                const tenorRate = tenureWatch
                  ? program.tenureFees?.[Number(tenureWatch)]?.interest?.value
                  : undefined;
                if (tenorRate === undefined || tenureWatch === undefined) return null;
                return (
                  <p className="velo-helper">
                    This tenor is priced at <span className="font-semibold text-velo-700 dark:text-velo-300">{tenorRate}% per month</span> ({tenorRate}% × {(Number(tenureWatch) / 30).toString()} month{(Number(tenureWatch) / 30) === 1 ? "" : "s"}).
                  </p>
                );
              })()}
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
