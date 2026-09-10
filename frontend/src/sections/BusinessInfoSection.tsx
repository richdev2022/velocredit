// ============================================================================
// src/sections/BusinessInfoSection.tsx
// Section 1 for Business Loan applicants.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { businessInfoSchema, type BusinessInfoForm } from "../utils/validation";

const BUSINESS_TYPES = [
  { value: "Sole Proprietorship",         label: "Sole Proprietorship" },
  { value: "Limited Liability Company",   label: "Limited Liability Company" },
  { value: "Partnership",                 label: "Partnership" },
  { value: "Other",                       label: "Other" },
];

const INDUSTRIES = [
  "Agriculture","Banking & Finance","Construction","Education","Energy & Power",
  "Entertainment & Media","FMCG","Healthcare","Hospitality & Tourism",
  "ICT & Telecommunications","Manufacturing","Mining","Real Estate","Retail",
  "Transportation & Logistics","Wholesale & Distribution","Other",
].map((v) => ({ value: v, label: v }));

export default function BusinessInfoSection() {
  const { application, patchBusinessInfo, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<BusinessInfoForm>({
    resolver: zodResolver(businessInfoSchema),
    mode: "onChange",
    defaultValues: {
      businessName: application.businessInfo.businessName,
      businessRegistrationNumber: application.businessInfo.businessRegistrationNumber,
      businessType: application.businessInfo.businessType,
      businessAddress: application.businessInfo.businessAddress,
      businessIndustry: application.businessInfo.businessIndustry,
      yearsInBusiness: application.businessInfo.yearsInBusiness,
    },
  });

  function sync<K extends keyof BusinessInfoForm>(key: K, value: BusinessInfoForm[K]) {
    patchBusinessInfo({ [key]: value } as any);
  }

  function onSubmit(data: BusinessInfoForm) {
    patchBusinessInfo(data);
    markSectionStatus("info", "completed");
    next();
  }

  return (
    <SectionShell
      title="Business Information"
      description="Tell us about your business so we can verify it."
      canContinue={isValid}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Business Name"
            required
            placeholder="e.g. ABC Trading Ltd"
            error={errors.businessName?.message}
            {...register("businessName")}
            onChange={(e) => { register("businessName").onChange(e); sync("businessName", e.target.value); }}
          />
          <FormInput
            label="Business Registration Number"
            helper="Optional — CAC number, if registered."
            placeholder="e.g. BN 1234567"
            {...register("businessRegistrationNumber")}
            onChange={(e) => { register("businessRegistrationNumber").onChange(e); sync("businessRegistrationNumber", e.target.value); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SelectInput
            label="Business Type"
            required
            placeholder="Select business type"
            options={BUSINESS_TYPES}
            error={errors.businessType?.message}
            {...register("businessType")}
            onChange={(e) => { register("businessType").onChange(e); sync("businessType", e.target.value as any); }}
          />
          <SelectInput
            label="Business Industry / Sector"
            required
            placeholder="Select industry"
            options={INDUSTRIES}
            error={errors.businessIndustry?.message}
            {...register("businessIndustry")}
            onChange={(e) => { register("businessIndustry").onChange(e); sync("businessIndustry", e.target.value); }}
          />
        </div>

        <FormInput
          label="Business Address"
          required
          placeholder="Full business address"
          error={errors.businessAddress?.message}
          {...register("businessAddress")}
          onChange={(e) => { register("businessAddress").onChange(e); sync("businessAddress", e.target.value); }}
        />

        <FormInput
          label="Years in Business"
          required
          type="number"
          min={0}
          placeholder="e.g. 3"
          error={errors.yearsInBusiness?.message}
          {...register("yearsInBusiness")}
          onChange={(e) => { register("yearsInBusiness").onChange(e); sync("yearsInBusiness", e.target.value); }}
        />
      </form>
    </SectionShell>
  );
}
