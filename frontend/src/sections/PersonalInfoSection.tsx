// ============================================================================
// src/sections/PersonalInfoSection.tsx
// Section 1 for Personal Loan applicants.
// ============================================================================

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { disbursementAccountSchema, personalInfoSchema, type DisbursementAccountForm, type PersonalInfoForm } from "../utils/validation";
import { NIGERIAN_STATES, lgasForState, STATE_NAMES } from "../utils/nigerianStates";

export default function PersonalInfoSection() {
  const { application, patchPersonalInfo, patchDisbursementAccount, markSectionStatus, next } = useApplication();
  if (!application) return null;

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isValid },
    setValue,
  } = useForm<PersonalInfoForm>({
    resolver: zodResolver(personalInfoSchema),
    mode: "onChange",
    defaultValues: {
      fullName: application.personalInfo.fullName,
      phone: application.personalInfo.phone,
      email: application.personalInfo.email,
      dateOfBirth: application.personalInfo.dateOfBirth,
      residentialAddress: application.personalInfo.residentialAddress,
      state: application.personalInfo.state,
      lga: application.personalInfo.lga,
    },
  });

  const accountForm = useForm<DisbursementAccountForm>({
    resolver: zodResolver(disbursementAccountSchema),
    mode: "onChange",
    defaultValues: application.disbursementAccount,
  });

  const stateValue = watch("state");
  const lgaOptions = stateValue ? lgasForState(stateValue) : ["Other"];

  // Sync every change back to the global application state (autosave source)
  function sync<K extends keyof PersonalInfoForm>(key: K, value: PersonalInfoForm[K]) {
    patchPersonalInfo({ [key]: value } as any);
  }

  function onSubmit(data: PersonalInfoForm) {
    accountForm.handleSubmit((account) => {
      patchPersonalInfo(data);
      patchDisbursementAccount(account);
      markSectionStatus("info", "completed");
      next();
    })();
  }

  return (
    <SectionShell
      title="Personal Information"
      description="Tell us about yourself so we can verify your identity."
      canContinue={isValid && accountForm.formState.isValid}
      onContinue={handleSubmit(onSubmit)}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Full Name"
            required
            placeholder="e.g. John Doe"
            error={errors.fullName?.message}
            {...register("fullName")}
            onChange={(e) => { register("fullName").onChange(e); sync("fullName", e.target.value); }}
          />
          <FormInput
            label="Phone Number"
            required
            type="tel"
            placeholder="e.g. 0801 234 5678"
            error={errors.phone?.message}
            {...register("phone")}
            onChange={(e) => { register("phone").onChange(e); sync("phone", e.target.value); }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <FormInput
            label="Email Address"
            required
            type="email"
            placeholder="you@example.com"
            error={errors.email?.message}
            {...register("email")}
            onChange={(e) => { register("email").onChange(e); sync("email", e.target.value); }}
          />
          <FormInput
            label="Date of Birth"
            required
            type="date"
            error={errors.dateOfBirth?.message}
            {...register("dateOfBirth")}
            onChange={(e) => { register("dateOfBirth").onChange(e); sync("dateOfBirth", e.target.value); }}
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

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <SelectInput
            label="State"
            required
            placeholder="Select state"
            options={STATE_NAMES.map((n) => ({ value: n, label: n }))}
            error={errors.state?.message}
            {...register("state")}
            onChange={(e) => {
              register("state").onChange(e);
              sync("state", e.target.value);
              setValue("lga", "");
              patchPersonalInfo({ lga: "" });
            }}
          />
          <SelectInput
            label="LGA"
            required
            placeholder={stateValue ? "Select LGA" : "Select state first"}
            options={lgaOptions.map((l) => ({ value: l, label: l }))}
            error={errors.lga?.message}
            disabled={!stateValue}
            {...register("lga")}
            onChange={(e) => { register("lga").onChange(e); sync("lga", e.target.value); }}
          />
        </div>
      </form>
    </SectionShell>
  );
}
