// ============================================================================
// src/sections/BusinessRepSection.tsx
// Section 2 for Business Loan applicants.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { businessRepSchema, disbursementAccountSchema, type BusinessRepForm, type DisbursementAccountForm } from "../utils/validation";

const POSITIONS = [
  { value: "Owner",              label: "Owner" },
  { value: "Director",           label: "Director" },
  { value: "Managing Director", label: "Managing Director" },
  { value: "Partner",            label: "Partner" },
  { value: "Manager",            label: "Manager" },
  { value: "Other",              label: "Other" },
];

export default function BusinessRepSection() {
  const { application, patchBusinessRep, patchDisbursementAccount, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<BusinessRepForm>({
    resolver: zodResolver(businessRepSchema),
    mode: "onChange",
    defaultValues: {
      fullName: application.businessRep.fullName,
      dateOfBirth: application.businessRep.dateOfBirth,
      position: application.businessRep.position,
      phone: application.businessRep.phone,
      email: application.businessRep.email,
      residentialAddress: application.businessRep.residentialAddress,
    },
  });

  const accountForm = useForm<DisbursementAccountForm>({
    resolver: zodResolver(disbursementAccountSchema),
    mode: "onChange",
    defaultValues: application.disbursementAccount,
  });

  function sync<K extends keyof BusinessRepForm>(key: K, value: BusinessRepForm[K]) {
    patchBusinessRep({ [key]: value } as any);
  }

  function onSubmit(data: BusinessRepForm) {
    accountForm.handleSubmit((account) => {
      patchBusinessRep(data);
      patchDisbursementAccount(account);
      markSectionStatus("businessRep", "completed");
      next();
    })();
  }

  return (
    <SectionShell
      title="Business Representative"
      description="Provide the details of the authorised representative of the business."
      canContinue={isValid && accountForm.formState.isValid}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Full Name"
            required
            placeholder="e.g. Jane Doe"
            error={errors.fullName?.message}
            {...register("fullName")}
            onChange={(e) => { register("fullName").onChange(e); sync("fullName", e.target.value); }}
          />
          <FormInput
            label="Date of Birth"
            required
            type="date"
            error={errors.dateOfBirth?.message}
            {...register("dateOfBirth")}
            onChange={(e) => { register("dateOfBirth").onChange(e); sync("dateOfBirth", e.target.value); }}
          />
          <SelectInput
            label="Position / Role"
            required
            placeholder="Select position"
            options={POSITIONS}
            error={errors.position?.message}
            {...register("position")}
            onChange={(e) => { register("position").onChange(e); sync("position", e.target.value as any); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Phone Number"
            required
            type="tel"
            placeholder="e.g. 0801 234 5678"
            error={errors.phone?.message}
            {...register("phone")}
            onChange={(e) => { register("phone").onChange(e); sync("phone", e.target.value); }}
          />
          <FormInput
            label="Email Address"
            required
            type="email"
            placeholder="rep@business.com"
            error={errors.email?.message}
            {...register("email")}
            onChange={(e) => { register("email").onChange(e); sync("email", e.target.value); }}
          />
        </div>

        <div className="rounded-2xl border border-velo-100 bg-velo-50/50 p-4 sm:p-5 space-y-5">
          <div>
            <h3 className="text-sm font-bold text-velo-900">Velo Account Information</h3>
            <p className="mt-1 text-xs text-slate-500">Your approved loan will be disbursed into this account.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <FormInput label="Account Name" required placeholder="Name on the account" error={accountForm.formState.errors.accountName?.message} {...accountForm.register("accountName")} onChange={(e) => { accountForm.register("accountName").onChange(e); patchDisbursementAccount({ accountName: e.target.value }); }} />
            <FormInput label="Bank Name" required placeholder="e.g. Access Bank" error={accountForm.formState.errors.bankName?.message} {...accountForm.register("bankName")} onChange={(e) => { accountForm.register("bankName").onChange(e); patchDisbursementAccount({ bankName: e.target.value }); }} />
          </div>
          <FormInput label="Account Number" required inputMode="numeric" maxLength={10} placeholder="10-digit account number" error={accountForm.formState.errors.accountNumber?.message} {...accountForm.register("accountNumber")} onChange={(e) => { const accountNumber = e.target.value.replace(/\D/g, ""); accountForm.setValue("accountNumber", accountNumber, { shouldValidate: true }); patchDisbursementAccount({ accountNumber }); }} />
        </div>

        <FormInput
          label="Residential Address"
          required
          placeholder="House number, street name, town/city"
          error={errors.residentialAddress?.message}
          {...register("residentialAddress")}
          onChange={(e) => { register("residentialAddress").onChange(e); sync("residentialAddress", e.target.value); }}
        />
      </form>
    </SectionShell>
  );
}
