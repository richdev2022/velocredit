// ============================================================================
// src/context/ApplicationContext.tsx
// Central application state. Owns the full ApplicationData object, persists
// to localStorage, debounces saves to the Apps Script backend, and exposes
// section-status derivation + navigation helpers.
// ============================================================================

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  ApplicationData,
  ApplicationStatus,
  SectionKey,
  SectionState,
  SectionStatus,
} from "../types/application";
import type { LoanCalculation } from "../types/loan";
import { calculateLoan } from "../utils/loanCalculator";
import { config, getLoanProgram } from "../utils/config";
import { generateDraftId } from "../utils/applicationId";
import {
  loadApplication,
  saveApplication,
  deleteApplication,
  findDraftsByEmailOrPhone,
  getSavedSectionIndex,
} from "../utils/storage";
import { deleteApplicationDraft, getAccessToken, submitBorrowerApplication } from "../services/apiClient";
import { useAuth } from "./AuthContext";
import type {
  LookupDraftResponse,
  SaveDraftResponse,
  SubmitResponse,
} from "../types/application";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function compactApplicationData(application: ApplicationData): Record<string, unknown> {
  const documents = Object.fromEntries(
    Object.entries(application.documents ?? {}).map(([slot, document]) => {
      if (!document) return [slot, document];
      const { data: _data, previewUrl: _previewUrl, ...metadata } = document as unknown as Record<string, unknown>;
      return [slot, metadata];
    }),
  );
  const { verifiedDetails: _verifiedDetails, selfieImageData: _selfieImageData, identityPhotoUrl: _identityPhotoUrl, ...kyc } = application.kyc ?? {};
  return {
    ...application,
    kyc,
    documents,
    agreement: application.agreement ? { ...application.agreement, generatedHtml: null } : application.agreement,
  };
}

// ---------------------------------------------------------------------------
// Section metadata
// ---------------------------------------------------------------------------

interface SectionMeta {
  key: SectionKey;
  label: string;
  required: boolean;
  skippable: boolean;
}

const PERSONAL_SECTIONS: SectionMeta[] = [
  { key: "applicantType", label: "Applicant Type",          required: true,  skippable: false },
  { key: "kyc",           label: "Identification & KYC",     required: true,  skippable: false },
  { key: "info",          label: "Personal Information",    required: true,  skippable: false },
  { key: "financial",     label: "Financial Information",   required: true,  skippable: false },
  { key: "loanRequest",   label: "Loan Request",            required: true,  skippable: false },
  { key: "collateral",    label: "Collateral",              required: true,  skippable: false },
  { key: "agreement",     label: "Loan Agreement",          required: true,  skippable: false },
  { key: "review",        label: "Review & Submit",         required: true,  skippable: false },
];

const BUSINESS_SECTIONS: SectionMeta[] = [
  { key: "applicantType", label: "Applicant Type",          required: true,  skippable: false },
  { key: "info",          label: "Business Information",    required: true,  skippable: false },
  { key: "kyc",           label: "Representative KYC",       required: true,  skippable: false },
  { key: "businessRep",   label: "Business Representative", required: true,  skippable: false },
  { key: "financial",     label: "Business Financial",      required: true,  skippable: false },
  { key: "loanRequest",   label: "Loan Request",            required: true,  skippable: false },
  { key: "collateral",    label: "Collateral",              required: true,  skippable: false },
  { key: "agreement",     label: "Loan Agreement",          required: true,  skippable: false },
  { key: "review",        label: "Review & Submit",         required: true,  skippable: false },
];

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export type SaveState = "idle" | "saving" | "saved" | "error";

interface ApplicationContextValue {
  application: ApplicationData | null;
  calculation: LoanCalculation | null;
  sections: SectionState[];
  currentIndex: number;

  saveState: SaveState;
  lastSavedAt: string | null;
  backendConfigured: boolean;

  // lifecycle
  startNewApplication: (type: "PERSONAL" | "BUSINESS") => ApplicationData;
  resumeApplication: (email: string, phone: string) => Promise<LookupDraftResponse>;
  loadExisting: (id: string, data?: ApplicationData, sectionIndex?: number | null) => void;
  resetApplication: () => void;

  // navigation
  navigate: (index: number) => void;
  next: () => void;
  prev: () => void;
  goToSection: (key: SectionKey) => void;

  // mutations
  update: <K extends keyof ApplicationData>(key: K, value: ApplicationData[K]) => void;
  patchPersonalInfo: (patch: Record<string, any>) => void;
  patchDisbursementAccount: (patch: Record<string, any>) => void;
  patchPersonalFinancial: (patch: Record<string, any>) => void;
  patchBusinessInfo: (patch: Record<string, any>) => void;
  patchBusinessRep: (patch: Record<string, any>) => void;
  patchBusinessFinancial: (patch: Record<string, any>) => void;
  patchKyc: (patch: Record<string, any>) => void;
  patchLoanRequest: (patch: Partial<ApplicationData["loanRequest"]>) => void;
  patchAgreement: (patch: Partial<ApplicationData["agreement"]>) => void;
  patchDocuments: (patch: Record<string, any>) => void;

  markSectionStatus: (key: SectionKey, status: SectionStatus) => void;

  // save / submit
  saveNow: () => Promise<SaveDraftResponse | null>;
  submit: () => Promise<SubmitResponse | null>;
  isSubmitting: boolean;
  submitError: string | null;
}

const ApplicationContext = createContext<ApplicationContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function ApplicationProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [application, setApplication] = useState<ApplicationData | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sectionStatusOverrides, setSectionStatusOverrides] = useState<Partial<Record<SectionKey, SectionStatus>>>({});

  const applicationRef = useRef<ApplicationData | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutoSave = useRef(false);
  const currentIndexRef = useRef(0);
  const restoredUserIdRef = useRef<string | null>(null);

  // Restore the complete local draft after login. KYC is fetched separately,
  // but the application wizard data and pending section live in local storage.
  useEffect(() => {
    if (!user) {
      restoredUserIdRef.current = null;
      return;
    }
    if (restoredUserIdRef.current === user.id) return;
    restoredUserIdRef.current = user.id;
    let cancelled = false;
    void (async () => {
      let resumed: ApplicationData | null = null;
      let savedIndex = 0;
      const match = findDraftsByEmailOrPhone(user.email || "", user.phone || "").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      const local = match ? loadApplication(match.applicationId) : null;
      if (!resumed && local) {
        resumed = normalizeApplicationData(local, applicationRef.current);
        savedIndex = getSavedSectionIndex(resumed);
      }
      if (!cancelled && resumed) {
        setApplication((current) => {
          if (current) return current;
          setCurrentIndex(savedIndex);
          currentIndexRef.current = savedIndex;
          setSectionStatusOverrides({});
          skipNextAutoSave.current = true;
          return resumed;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    applicationRef.current = application;
  }, [application]);

  // ----- derived: calculation -----
  const calculation = useMemo<LoanCalculation | null>(() => {
    if (!application?.loanRequest?.amount) return null;
    return calculateLoan(application.loanRequest.amount, application.loanRequest.tenure, { loanType: application.applicantType || "PERSONAL" });
  }, [application?.loanRequest?.amount, application?.loanRequest?.tenure]);

  // ----- derived: section metadata -----
  const sectionMeta: SectionMeta[] = useMemo(() => {
    if (!application || !application.applicantType) return PERSONAL_SECTIONS;
    return application.applicantType === "PERSONAL" ? PERSONAL_SECTIONS : BUSINESS_SECTIONS;
  }, [application?.applicantType]);

  // ----- derived: section states (with derived statuses) -----
  const sections: SectionState[] = useMemo(() => {
    if (!application) return [];
    return sectionMeta.map((meta) => {
      const override = sectionStatusOverrides[meta.key];
      const derived = deriveSectionStatus(application, meta.key);
      const status = override || derived;
      return { ...meta, status };
    });
  }, [application, sectionMeta, sectionStatusOverrides]);

  // ----- persistence: localStorage on every change -----
  useEffect(() => {
    if (!application) return;
    saveApplication(application, currentIndexRef.current);

    skipNextAutoSave.current = false;
  }, [application]);

  useEffect(() => {
    if (application) saveApplication(application, currentIndex);
  }, [application, currentIndex]);

  // ----- lifecycle: start new -----
  const startNewApplication = useCallback((type: "PERSONAL" | "BUSINESS"): ApplicationData => {
    const id = generateDraftId();
    const now = new Date().toISOString();
    const fresh: ApplicationData = {
      applicationId: id,
      applicantType: type,
      status: "DRAFT",
      personalInfo: { fullName: "", phone: "", email: "", dateOfBirth: "", residentialAddress: "", state: "", lga: "" },
      disbursementAccount: { accountName: "", bankName: "", accountNumber: "" },
      personalFinancial: { employmentStatus: "", employerBusinessName: "", monthlyIncome: "", monthlyExpenses: "", existingLoanObligations: "", expectedRepaymentSource: "" },
      businessInfo: { businessName: "", businessRegistrationNumber: "", businessType: "", businessAddress: "", businessIndustry: "", yearsInBusiness: "" },
      businessRep: { fullName: "", dateOfBirth: "", position: "", phone: "", email: "", residentialAddress: "" },
      businessFinancial: { averageMonthlyRevenue: "", averageMonthlyExpenses: "", existingLoanObligations: "", expectedRepaymentSource: "" },
      kyc: { bvn: "", nin: "", identificationType: "", identificationNumber: "" },
      loanRequest: { amount: getLoanProgram(type).loanLimits.defaultAmount, tenure: getLoanProgram(type).tenures[0]?.value || 30, purpose: "" },
      collateral: { provided: false, type: "", description: "", estimatedValue: "", ownership: "", location: "", documentReference: "" },
      calculation: null,
      documents: {},
      witness: { fullName: "", phone: "" },
      agreement: { generatedAt: null, executionDate: null, generatedHtml: null, signedAgreementAccepted: false },
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
    };
    fresh.calculation = calculateLoan(fresh.loanRequest.amount, fresh.loanRequest.tenure, { loanType: type });
    applicationRef.current = fresh;
    setApplication(fresh);
    saveApplication(fresh);
    setCurrentIndex(0);
    currentIndexRef.current = 0;
    setSectionStatusOverrides({});
    return fresh;
  }, []);

  // ----- lifecycle: resume -----
  const resumeApplication = useCallback(async (email: string, phone: string): Promise<LookupDraftResponse> => {
    // Cross-device resume is handled by the verified OTP flow on /resume.
    // This method only supports drafts already present in this browser.
    // Local lookup
    const matches = findDraftsByEmailOrPhone(email, phone);
    if (matches.length === 0) {
      return { ok: true, found: false, message: "No draft application found." };
    }
    // Use the most recently updated match
    const match = matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    const app = loadApplication(match.applicationId);
    if (!app) {
      return { ok: true, found: false, message: "Draft was not found in local storage." };
    }
    const resumed = normalizeApplicationData(app, applicationRef.current);
    applicationRef.current = resumed;
    setApplication(resumed);
    const resumeIndex = getSavedSectionIndex(resumed);
    setCurrentIndex(resumeIndex);
    currentIndexRef.current = resumeIndex;
    setSectionStatusOverrides({});
    skipNextAutoSave.current = true;
    return { ok: true, found: true, application: resumed };
  }, []);

  // ----- lifecycle: load existing -----
  const loadExisting = useCallback((id: string, supplied?: ApplicationData, suppliedSectionIndex?: number | null) => {
    const app = supplied || loadApplication(id);
    if (app) {
      const resumed = normalizeApplicationData(app, applicationRef.current);
      applicationRef.current = resumed;
      setApplication(resumed);
      const backendIdx = suppliedSectionIndex != null ? Number(suppliedSectionIndex) : Number(resumed.lastSectionIndex);
      const resumeIndex =
        Number.isFinite(backendIdx) && backendIdx >= 0
          ? backendIdx
          : getSavedSectionIndex(resumed);
      setCurrentIndex(resumeIndex);
      currentIndexRef.current = resumeIndex;
      setSectionStatusOverrides({});
      skipNextAutoSave.current = true;
    }
  }, []);

  // ----- lifecycle: reset -----
  const resetApplication = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (application) {
      deleteApplication(application.applicationId);
      if (getAccessToken()) void deleteApplicationDraft(application.applicationId).catch(() => {});
    }
    applicationRef.current = null;
    setApplication(null);
    setCurrentIndex(0);
    setSaveState("idle");
    setLastSavedAt(null);
    setSectionStatusOverrides({});
  }, [application]);

  // ----- navigation -----
  const setSectionIndex = useCallback((index: number) => {
    currentIndexRef.current = index;
    setCurrentIndex(index);
    replaceApplication((current) => touch({ ...current, lastSectionIndex: index }));
  }, []);

  const navigate = useCallback((index: number) => {
    const nextIndex = Math.max(0, Math.min(index, Math.max(sectionMeta.length - 1, 0)));
    setSectionIndex(nextIndex);
  }, [sectionMeta.length, setSectionIndex]);

  const next = useCallback(() => {
    setSectionIndex(Math.min(currentIndexRef.current + 1, sectionMeta.length - 1));
  }, [sectionMeta.length, setSectionIndex]);

  const prev = useCallback(() => {
    setSectionIndex(Math.max(currentIndexRef.current - 1, 0));
  }, [setSectionIndex]);

  const goToSection = useCallback((key: SectionKey) => {
    const idx = sectionMeta.findIndex((s) => s.key === key);
    if (idx >= 0) setSectionIndex(idx);
  }, [sectionMeta, setSectionIndex]);

  // ----- mutations -----
  function touch(prev: ApplicationData): ApplicationData {
    return { ...prev, updatedAt: new Date().toISOString() };
  }

  function replaceApplication(transform: (current: ApplicationData) => ApplicationData): void {
    const current = applicationRef.current;
    if (!current) return;
    const next = transform(current);
    applicationRef.current = next;
    setApplication(next);
  }

  const update = useCallback<ApplicationContextValue["update"]>((key, value) => {
    replaceApplication((current) => touch({ ...current, [key]: value }));
  }, []);

  const patchPersonalInfo: ApplicationContextValue["patchPersonalInfo"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, personalInfo: { ...current.personalInfo, ...patch } }));
  }, []);

  const patchDisbursementAccount: ApplicationContextValue["patchDisbursementAccount"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, disbursementAccount: { ...current.disbursementAccount, ...patch } }));
  }, []);

  const patchPersonalFinancial: ApplicationContextValue["patchPersonalFinancial"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, personalFinancial: { ...current.personalFinancial, ...patch } }));
  }, []);

  const patchBusinessInfo: ApplicationContextValue["patchBusinessInfo"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, businessInfo: { ...current.businessInfo, ...patch } }));
  }, []);

  const patchBusinessRep: ApplicationContextValue["patchBusinessRep"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, businessRep: { ...current.businessRep, ...patch } }));
  }, []);

  const patchBusinessFinancial: ApplicationContextValue["patchBusinessFinancial"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, businessFinancial: { ...current.businessFinancial, ...patch } }));
  }, []);

  const patchKyc: ApplicationContextValue["patchKyc"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, kyc: { ...current.kyc, ...patch } }));
  }, []);

  const patchLoanRequest: ApplicationContextValue["patchLoanRequest"] = useCallback((patch) => {
    replaceApplication((current) => {
      const nextLoan = { ...current.loanRequest, ...patch };
      const nextCalc = calculateLoan(nextLoan.amount, nextLoan.tenure, { loanType: current.applicantType || "PERSONAL" });
      return touch({ ...current, loanRequest: nextLoan, calculation: nextCalc });
    });
  }, []);

  const patchAgreement: ApplicationContextValue["patchAgreement"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, agreement: { ...current.agreement, ...patch } }));
  }, []);

  const patchDocuments: ApplicationContextValue["patchDocuments"] = useCallback((patch) => {
    replaceApplication((current) => touch({ ...current, documents: { ...current.documents, ...patch } }));
  }, []);

  const markSectionStatus = useCallback((key: SectionKey, status: SectionStatus) => {
    setSectionStatusOverrides((prev) => ({ ...prev, [key]: status }));
  }, []);

  // ----- save now (explicit) -----
  const saveNow = useCallback(async (): Promise<SaveDraftResponse | null> => {
    const current = applicationRef.current ?? application;
    if (!current) return null;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const draft = { ...current, lastSectionIndex: currentIndexRef.current, updatedAt: new Date().toISOString() };
    applicationRef.current = draft;
    setApplication((existing) => existing?.applicationId === draft.applicationId ? draft : existing);
    saveApplication(draft, currentIndexRef.current);
    setSaveState("saved");
    setLastSavedAt(new Date().toISOString());
    return { ok: true, applicationId: draft.applicationId, status: draft.status };
  }, [application]);

  // ----- submit -----
  const submit = useCallback(async (): Promise<SubmitResponse | null> => {
    if (!application) return null;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = getAccessToken()
        ? await (async () => {
            const response = await submitBorrowerApplication(compactApplicationData(application));
            return { ok: response.ok, applicationId: String(response.loan?.applicationId ?? response.loan?.id ?? application.applicationId), status: "SUBMITTED" as const, error: response.error };
          })()
        : { ok: false, applicationId: application.applicationId, status: application.status, error: "Please sign in before submitting your loan application." };
      if (res.ok) {
        // Promote the application to submitted state
        setApplication((prev) => prev ? touch({
          ...prev,
          status: "SUBMITTED",
          applicationId: res.applicationId || prev.applicationId,
          submittedAt: new Date().toISOString(),
        }) : prev);
      }
      return res;
    } catch (e: any) {
      const msg = e?.message || "Unable to submit your application at the moment. Please try again.";
      setSubmitError(msg);
      return { ok: false, applicationId: application.applicationId, status: application.status, error: msg };
    } finally {
      setIsSubmitting(false);
    }
  }, [application]);

  // ----- update application status to IN_PROGRESS once started -----
  useEffect(() => {
    if (application && application.status === "DRAFT" && Object.keys(sectionStatusOverrides).length > 0) {
      setApplication((prev) => prev ? touch({ ...prev, status: "IN_PROGRESS" }) : prev);
    }
  }, [sectionStatusOverrides, application]);

  const value: ApplicationContextValue = {
    application,
    calculation,
    sections,
    currentIndex,
    saveState,
    lastSavedAt,
    backendConfigured: Boolean(getAccessToken()),
    startNewApplication,
    resumeApplication,
    loadExisting,
    resetApplication,
    navigate,
    next,
    prev,
    goToSection,
    update,
    patchPersonalInfo,
    patchDisbursementAccount,
    patchPersonalFinancial,
    patchBusinessInfo,
    patchBusinessRep,
    patchBusinessFinancial,
    patchKyc,
    patchLoanRequest,
    patchAgreement,
    patchDocuments,
    markSectionStatus,
    saveNow,
    submit,
    isSubmitting,
    submitError,
  };

  return <ApplicationContext.Provider value={value}>{children}</ApplicationContext.Provider>;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useApplication(): ApplicationContextValue {
  const ctx = useContext(ApplicationContext);
  if (!ctx) throw new Error("useApplication must be used inside <ApplicationProvider>");
  return ctx;
}

// ---------------------------------------------------------------------------
// Section status derivation
// ---------------------------------------------------------------------------

function nonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

function pickString(prior: unknown, data: unknown, fallback: string): string {
  if (nonEmptyStr(prior)) return prior;
  if (nonEmptyStr(data)) return data;
  return fallback;
}

function pickOptionalString(prior: unknown, data: unknown, fallback: string | null): string | null {
  if (nonEmptyStr(prior)) return prior;
  if (nonEmptyStr(data)) return data;
  return fallback;
}

function normalizeApplicationData(
  data: ApplicationData,
  priorState?: ApplicationData | null | undefined
): ApplicationData {
  const now = new Date().toISOString();
  const program = getLoanProgram(data.applicantType || "PERSONAL");
  const rawLoanRequest = Object.assign(
    {
      amount: program.loanLimits.defaultAmount,
      tenure: program.tenures[0]?.value || 30,
      purpose: "",
    },
    data.loanRequest || {}
  );
  const prevInfo = priorState?.personalInfo ?? (null as null);
  const prevKyc = priorState?.kyc ?? (null as null);
  const prevDisb = priorState?.disbursementAccount ?? (null as null);
  const prevPF = priorState?.personalFinancial ?? (null as null);
  const prevBI = priorState?.businessInfo ?? (null as null);
  const prevBR = priorState?.businessRep ?? (null as null);
  const prevBF = priorState?.businessFinancial ?? (null as null);
  const prevWitness = priorState?.witness ?? (null as null);
  const prevCollateral = priorState?.collateral ?? (null as null);
  const prevLR = priorState?.loanRequest ?? (null as null);
  const dataInfo = data.personalInfo || {};
  const dataKyc = data.kyc || {};
  const dataDisb = data.disbursementAccount || {};
  const dataPF = data.personalFinancial || {};
  const dataBI = data.businessInfo || {};
  const dataBR = data.businessRep || {};
  const dataBF = data.businessFinancial || {};
  const dataWitness = data.witness || {};
  const dataCollateral = data.collateral || {};
  const dataLR = data.loanRequest || {};
  const loanRequest = {
    amount: typeof prevLR?.amount === "number" && Number.isFinite(prevLR.amount)
      ? prevLR.amount
      : typeof dataLR.amount === "number" && Number.isFinite(dataLR.amount)
        ? dataLR.amount
        : rawLoanRequest.amount,
    tenure: typeof prevLR?.tenure === "number" && Number.isFinite(prevLR.tenure)
      ? prevLR.tenure
      : typeof dataLR.tenure === "number" && Number.isFinite(dataLR.tenure)
        ? dataLR.tenure
        : rawLoanRequest.tenure,
    purpose: pickString(prevLR?.purpose, dataLR.purpose, rawLoanRequest.purpose),
  };

  return {
    ...data,
    applicationId: data.applicationId || priorState?.applicationId || generateDraftId(),
    applicantType: data.applicantType || priorState?.applicantType || null,
    status: data.status || priorState?.status || "DRAFT",
    personalInfo: {
      fullName: pickString(prevInfo?.fullName, dataInfo.fullName, ""),
      phone: pickString(prevInfo?.phone, dataInfo.phone, ""),
      email: pickString(prevInfo?.email, dataInfo.email, ""),
      dateOfBirth: pickString(prevInfo?.dateOfBirth, dataInfo.dateOfBirth, ""),
      residentialAddress: pickString(prevInfo?.residentialAddress, dataInfo.residentialAddress, ""),
      state: pickString(prevInfo?.state, dataInfo.state, ""),
      lga: pickString(prevInfo?.lga, dataInfo.lga, ""),
    },
    disbursementAccount: {
      accountName: pickString(prevDisb?.accountName, dataDisb.accountName, ""),
      bankName: pickString(prevDisb?.bankName, dataDisb.bankName, ""),
      accountNumber: pickString(prevDisb?.accountNumber, dataDisb.accountNumber, ""),
    },
    personalFinancial: {
      employmentStatus: pickString(prevPF?.employmentStatus, dataPF.employmentStatus, ""),
      employerBusinessName: pickString(prevPF?.employerBusinessName, dataPF.employerBusinessName, ""),
      monthlyIncome: pickString(prevPF?.monthlyIncome, dataPF.monthlyIncome, ""),
      monthlyExpenses: pickString(prevPF?.monthlyExpenses, dataPF.monthlyExpenses, ""),
      existingLoanObligations: pickString(prevPF?.existingLoanObligations, dataPF.existingLoanObligations, ""),
      expectedRepaymentSource: pickString(prevPF?.expectedRepaymentSource, dataPF.expectedRepaymentSource, ""),
    },
    businessInfo: {
      businessName: pickString(prevBI?.businessName, dataBI.businessName, ""),
      businessRegistrationNumber: pickString(prevBI?.businessRegistrationNumber, dataBI.businessRegistrationNumber, ""),
      businessType: pickString(prevBI?.businessType, dataBI.businessType, ""),
      businessAddress: pickString(prevBI?.businessAddress, dataBI.businessAddress, ""),
      businessIndustry: pickString(prevBI?.businessIndustry, dataBI.businessIndustry, ""),
      yearsInBusiness: pickString(prevBI?.yearsInBusiness, dataBI.yearsInBusiness, ""),
    },
    businessRep: {
      fullName: pickString(prevBR?.fullName, dataBR.fullName, ""),
      dateOfBirth: pickString(prevBR?.dateOfBirth, dataBR.dateOfBirth, ""),
      position: pickString(prevBR?.position, dataBR.position, "") as BusinessRepresentative["position"],
      phone: pickString(prevBR?.phone, dataBR.phone, ""),
      email: pickString(prevBR?.email, dataBR.email, ""),
      residentialAddress: pickString(prevBR?.residentialAddress, dataBR.residentialAddress, ""),
    },
    businessFinancial: {
      averageMonthlyRevenue: pickString(prevBF?.averageMonthlyRevenue, dataBF.averageMonthlyRevenue, ""),
      averageMonthlyExpenses: pickString(prevBF?.averageMonthlyExpenses, dataBF.averageMonthlyExpenses, ""),
      existingLoanObligations: pickString(prevBF?.existingLoanObligations, dataBF.existingLoanObligations, ""),
      expectedRepaymentSource: pickString(prevBF?.expectedRepaymentSource, dataBF.expectedRepaymentSource, ""),
    },
    kyc: {
      bvn: pickString(prevKyc?.bvn, dataKyc.bvn, ""),
      nin: pickString(prevKyc?.nin, dataKyc.nin, ""),
      identificationType: pickString(prevKyc?.identificationType, dataKyc.identificationType, "") as any,
      identificationNumber: pickString(prevKyc?.identificationNumber, dataKyc.identificationNumber, ""),
      bvnVerified: prevKyc?.bvnVerified ?? dataKyc.bvnVerified,
      ninVerified: prevKyc?.ninVerified ?? dataKyc.ninVerified,
      livenessVerified: prevKyc?.livenessVerified ?? dataKyc.livenessVerified,
      verifiedDetails: prevKyc?.verifiedDetails ?? dataKyc.verifiedDetails,
      livenessStatus: prevKyc?.livenessStatus ?? dataKyc.livenessStatus,
      identityPhotoUrl: prevKyc?.identityPhotoUrl ?? dataKyc.identityPhotoUrl,
      selfieImageData: prevKyc?.selfieImageData ?? dataKyc.selfieImageData,
    },
    loanRequest,
    collateral: {
      provided: typeof prevCollateral?.provided === "boolean" ? prevCollateral.provided : typeof dataCollateral.provided === "boolean" ? dataCollateral.provided : false,
      type: pickString(prevCollateral?.type, dataCollateral.type, ""),
      description: pickString(prevCollateral?.description, dataCollateral.description, ""),
      estimatedValue: pickString(prevCollateral?.estimatedValue, dataCollateral.estimatedValue, ""),
      ownership: pickString(prevCollateral?.ownership, dataCollateral.ownership, ""),
      location: pickString(prevCollateral?.location, dataCollateral.location, ""),
      documentReference: pickString(prevCollateral?.documentReference, dataCollateral.documentReference, ""),
    },
    calculation: data.calculation || priorState?.calculation || calculateLoan(loanRequest.amount, loanRequest.tenure, { loanType: data.applicantType || "PERSONAL" }),
    documents: Object.fromEntries(Object.entries(data.documents || priorState?.documents || {}).filter(([slot]) => slot !== "signedAgreement")),
    witness: {
      fullName: pickString(prevWitness?.fullName, dataWitness.fullName, ""),
      phone: pickString(prevWitness?.phone, dataWitness.phone, ""),
    },
    agreement: Object.assign(
      {
        generatedAt: null,
        generatedHtml: null,
        signedAgreementAccepted: false,
      },
      data.agreement || {},
      priorState?.agreement || {}
    ),
    createdAt: data.createdAt || priorState?.createdAt || now,
    updatedAt: data.updatedAt || priorState?.updatedAt || now,
    submittedAt: data.submittedAt ?? priorState?.submittedAt ?? null,
  };
}

function deriveSectionStatus(app: ApplicationData, key: SectionKey): SectionStatus {
  switch (key) {
    case "applicantType": {
      return app.applicantType ? "completed" : "not_started";
    }
    case "info": {
      if (!app.applicantType) return "locked";
      if (app.applicantType === "PERSONAL") {
        const p = app.personalInfo;
        const account = app.disbursementAccount;
        const ok = Boolean(p.fullName && p.phone && p.email && p.dateOfBirth && p.residentialAddress && p.state && p.lga && account.accountName && account.bankName && account.accountNumber);
        return ok ? "completed" : "not_started";
      }
      const b = app.businessInfo;
      const ok = Boolean(b.businessName && b.businessType && b.businessAddress && b.businessIndustry && b.yearsInBusiness);
      return ok ? "completed" : "not_started";
    }
    case "businessRep": {
      if (app.applicantType !== "BUSINESS") return "locked";
      const r = app.businessRep;
      const account = app.disbursementAccount;
      const ok = Boolean(r.fullName && r.position && r.phone && r.email && r.residentialAddress && account.accountName && account.bankName && account.accountNumber);
      return ok ? "completed" : "not_started";
    }
    case "kyc": {
      if (!app.applicantType) return "locked";
      if (app.applicantType === "BUSINESS" && !app.businessRep?.fullName) return "locked";
      const k = app.kyc || { bvn: "", nin: "", identificationType: "", identificationNumber: "" };
      const ok = Boolean(k.bvn && k.nin && k.identificationType && k.identificationNumber);
      return ok ? "completed" : "not_started";
    }
    case "financial": {
      if (!app.applicantType) return "locked";
      if (app.applicantType === "PERSONAL") {
        const f = app.personalFinancial;
        const ok = Boolean(f.employmentStatus && f.monthlyIncome && f.monthlyExpenses && f.expectedRepaymentSource);
        return ok ? "completed" : "not_started";
      }
      const bf = app.businessFinancial;
      const ok = Boolean(bf.averageMonthlyRevenue && bf.averageMonthlyExpenses && bf.expectedRepaymentSource);
      return ok ? "completed" : "not_started";
    }
    case "loanRequest": {
      if (!app.applicantType) return "locked";
      const req = app.loanRequest;
      const ok = Boolean(req.amount && req.tenure && req.purpose && req.purpose.length >= 10);
      return ok ? "completed" : "not_started";
    }
    case "collateral": {
      if (!app.applicantType) return "locked";
      const rules = getLoanProgram(app.applicantType).collateral;
      if (!rules.enabled) return "skipped";
      const c = app.collateral;
      const detailsComplete = Boolean(c?.type && c.description && c.estimatedValue && c.ownership && c.location);
      return rules.required ? (detailsComplete && Boolean(app.documents?.collateralMedia) ? "completed" : "not_started") : (c?.provided ? (detailsComplete && Boolean(app.documents?.collateralMedia) ? "completed" : "not_started") : "completed");
    }
    case "agreement": {
      if (!app.loanRequest?.purpose) return "locked";
      const ok = Boolean(app.agreement?.signedAgreementAccepted);
      return ok ? "completed" : "not_started";
    }
    case "review": {
      // always reachable once loan request is done
      if (!app.loanRequest?.purpose) return "locked";
      return "not_started";
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function canSubmitApplication(app: ApplicationData, sections: SectionState[]): boolean {
  return sections.every((s) => s.key === "review" || !s.required || s.status === "completed");
}

export function deriveApplicationStatus(app: ApplicationData): ApplicationStatus {
  if (app.status === "SUBMITTED" || app.status === "UNDER_REVIEW" || app.status === "APPROVED" || app.status === "REJECTED" || app.status === "DISBURSED" || app.status === "REPAID") {
    return app.status;
  }
  return app.status === "DRAFT" && app.updatedAt !== app.createdAt ? "IN_PROGRESS" : "DRAFT";
}
