// ============================================================================
// src/sections/PersonalInfoSection.tsx
// Section 1 for Personal Loan applicants.
// ============================================================================

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import FormInput from "../components/FormInput";
import SelectInput from "../components/SelectInput";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import { disbursementAccountSchema, personalInfoSchema, type DisbursementAccountForm, type PersonalInfoForm } from "../utils/validation";
import { NIGERIAN_STATES, lgasForState, STATE_NAMES } from "../utils/nigerianStates";
import { getAccessToken } from "../services/apiClient";
import { config } from "../utils/config";

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
  const identityVerified = application.kyc.bvnVerified === true || application.kyc.ninVerified === true;

  const [banks, setBanks] = useState<Array<{ id: number; name: string; code: string }>>([]);
  const [selectedBank, setSelectedBank] = useState(application.disbursementAccount?.bankCode ?? "");
  const [resolvedName, setResolvedName] = useState<string | null>(application.disbursementAccount?.accountName ?? null);
  const [resolveError, setResolveError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    if (selectedBank) {
      const bank = banks.find((b) => b.code === selectedBank);
      if (bank) {
        accountForm.setValue("bankCode", selectedBank, { shouldValidate: true });
        accountForm.setValue("bankName", bank.name, { shouldValidate: true });
      }
    }
  }, [selectedBank, banks]);

  useEffect(() => {
    void loadBanks();
  }, []);

  async function loadBanks() {
    if (banks.length) return;
    setBusy("banks");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/providers/flutterwave/banks`, {
        headers: { Authorization: `Bearer ${getAccessToken()}` },
      }).then((r) => r.json());
      if (res.ok) setBanks(res.banks || []);
    } catch (_e) {
      /* ignore */
    } finally {
      setBusy("");
    }
  }

  async function resolveAccount() {
    if (!selectedBank) return;
    const accountNumber = accountForm.watch("accountNumber") || "";
    if (accountNumber.length < 10) return;
    setResolveError("");
    setResolvedName(null);
    setBusy("resolve");
    try {
      const res = await fetch(`${config.apiUrl}/api/v1/borrower/disbursement-account/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken()}`,
        },
        body: JSON.stringify({ bankCode: selectedBank, accountNumber }),
      }).then((r) => r.json());
      if (res.ok) {
        setResolvedName(res.accountName);
        accountForm.setValue("accountName", res.accountName, { shouldValidate: true });
        patchDisbursementAccount({ accountName: res.accountName });
      } else {
        setResolveError(res.error || "Could not resolve account");
      }
    } catch (_e) {
      setResolveError("Resolution failed");
    } finally {
      setBusy("");
    }
  }

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
            readOnly={identityVerified}
            {...register("fullName")}
            onChange={(e) => { register("fullName").onChange(e); sync("fullName", e.target.value); }}
          />
          <FormInput
            label="Phone Number"
            required
            type="tel"
            placeholder="e.g. 0801 234 5678"
            error={errors.phone?.message}
            readOnly={identityVerified}
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
            readOnly={identityVerified}
            {...register("dateOfBirth")}
            onChange={(e) => { register("dateOfBirth").onChange(e); sync("dateOfBirth", e.target.value); }}
          />
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-900/30 p-4 text-sm text-amber-800 dark:text-amber-300">
          <div className="font-semibold">💡 Highly recommended</div>
          <p className="mt-1 leading-6">
            Use your Velo account details for loan disbursement for the fastest loan processing.
            You can add or change your disbursement bank to any Nigerian bank later from your borrower dashboard.
          </p>
        </div>

        <div className="rounded-2xl border border-velo-100 bg-velo-50/50 p-4 sm:p-5 space-y-5">
          <div>
            <h3 className="text-sm font-bold text-velo-900">Disbursement Account Information</h3>
            <p className="mt-1 text-xs text-slate-500">Your approved loan will be disbursed into this account.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <FormInput label="Account Name" required placeholder="Name on the account" error={accountForm.formState.errors.accountName?.message} readOnly={!!resolvedName} {...accountForm.register("accountName")} onChange={(e) => { accountForm.register("accountName").onChange(e); patchDisbursementAccount({ accountName: e.target.value }); }} />
            <label className="flex flex-col">
              <span className="mb-1 text-sm font-semibold text-velo-900">
                Bank <span className="text-red-500">*</span>
              </span>
              <select
                className="mt-1 w-full rounded-xl border border-velo-200 bg-white px-3 py-2.5 text-sm text-velo-900 shadow-sm focus:border-velo-500 focus:outline-none focus:ring-2 focus:ring-velo-500/20 dark:border-slate-700 dark:bg-slate-900 dark:text-white"
                value={selectedBank}
                onChange={(e) => {
                  const code = e.target.value;
                  setSelectedBank(code);
                  setResolvedName(null);
                  setResolveError("");
                  const bank = banks.find((b) => b.code === code);
                  if (bank) {
                    accountForm.setValue("bankName", bank.name, { shouldValidate: true });
                    patchDisbursementAccount({ bankCode: code, bankName: bank.name });
                  }
                }}
                required
                disabled={busy === "banks"}
              >
                <option value="">
                  {busy === "banks" ? "Loading banks…" : "Select your bank"}
                </option>
                {banks.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.name}
                  </option>
                ))}
              </select>
              {accountForm.formState.errors.bankName?.message && (
                <span className="mt-1 text-xs text-red-600">{accountForm.formState.errors.bankName.message}</span>
              )}
            </label>
          </div>
          <FormInput
            label="Account Number"
            required
            inputMode="numeric"
            maxLength={10}
            placeholder="10-digit account number"
            error={accountForm.formState.errors.accountNumber?.message}
            {...accountForm.register("accountNumber")}
            onChange={(e) => {
              const accountNumber = e.target.value.replace(/\D/g, "");
              accountForm.setValue("accountNumber", accountNumber, { shouldValidate: true });
              patchDisbursementAccount({ accountNumber });
              setResolvedName(null);
              setResolveError("");
            }}
            onBlur={() => {
              const accNo = accountForm.watch("accountNumber") || "";
              if (selectedBank && accNo.length === 10) void resolveAccount();
            }}
          />
          {busy === "resolve" && (
            <div className="text-xs text-slate-500">Resolving account name…</div>
          )}
          {resolvedName && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-900/30 p-3 text-sm text-emerald-700 dark:text-emerald-400">
              <span className="font-semibold">Verified account name:</span> {resolvedName}
            </div>
          )}
          {resolveError && (
            <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-900/20 dark:border-red-900/30 p-3 text-sm text-red-700 dark:text-red-400">
              {resolveError}
            </div>
          )}
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
