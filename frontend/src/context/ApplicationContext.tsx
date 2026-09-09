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
  findDraftsByEmailOrPhone,
  getSavedSectionIndex,
} from "../utils/storage";
import { getAccessToken, submitBorrowerApplication } from "../services/apiClient";
import type {
  LookupDraftResponse,
  SaveDraftResponse,
  SubmitResponse,
} from "../types/application";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTOSAVE_DEBOUNCE_MS = 1500;

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
  { key: "info",          label: "Personal Information",    required: true,  skippable: false },
  { key: "kyc",           label: "Identification & KYC",     required: true,  skippable: false },
  { key: "financial",     label: "Financial Information",   required: true,  skippable: false },
  { key: "loanRequest",   label: "Loan Request",            required: true,  skippable: false },
  { key: "collateral",    label: "Collateral",              required: true,  skippable: false },
  { key: "agreement",     label: "Loan Agreement",          required: true,  skippable: false },
  { key: "review",        label: "Review & Submit",         required: true,  skippable: false },
];

const BUSINESS_SECTIONS: SectionMeta[] = [
  { key: "applicantType", label: "Applicant Type",          required: true,  skippable: false },
  { key: "info",          label: "Business Information",    required: true,  skippable: false },
  { key: "businessRep",   label: "Business Representative", required: true,  skippable: false },
  { key: "kyc",           label: "Representative KYC",       required: true,  skippable: false },
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
  const [application, setApplication] = useState<ApplicationData | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sectionStatusOverrides, setSectionStatusOverrides] = useState<Partial<Record<SectionKey, SectionStatus>>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutoSave = useRef(false);
  const currentIndexRef = useRef(0);

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

    // Debounced autosave to backend
    if (skipNextAutoSave.current) {
      skipNextAutoSave.current = false;
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void triggerBackendSave();
    }, AUTOSAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [application]);

  useEffect(() => {
    if (application) saveApplication(application, currentIndex);
  }, [application, currentIndex]);

  async function triggerBackendSave(): Promise<void> {
    if (!application) return;
    if (application.status === "SUBMITTED") return;
    saveApplication(application, currentIndexRef.current);
    setSaveState("saved");
    setLastSavedAt(new Date().toISOString());
  }

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
      agreement: { generatedAt: null, generatedHtml: null, signedAgreementAccepted: false },
      createdAt: now,
      updatedAt: now,
      submittedAt: null,
    };
    fresh.calculation = calculateLoan(fresh.loanRequest.amount, fresh.loanRequest.tenure, { loanType: type });
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
    const resumed = normalizeApplicationData(app);
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
      const resumed = normalizeApplicationData(app);
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
    setApplication(null);
    setCurrentIndex(0);
    setSaveState("idle");
    setLastSavedAt(null);
    setSectionStatusOverrides({});
  }, []);

  // ----- navigation -----
  const setSectionIndex = useCallback((index: number) => {
    currentIndexRef.current = index;
    setCurrentIndex(index);
    setApplication((prev) => (prev ? { ...prev, lastSectionIndex: index } : prev));
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

  const update = useCallback<ApplicationContextValue["update"]>((key, value) => {
    setApplication((prev) => (prev ? touch({ ...prev, [key]: value }) : prev));
  }, []);

  const patchPersonalInfo: ApplicationContextValue["patchPersonalInfo"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, personalInfo: { ...prev.personalInfo, ...patch } }) : prev);
  }, []);

  const patchDisbursementAccount: ApplicationContextValue["patchDisbursementAccount"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, disbursementAccount: { ...prev.disbursementAccount, ...patch } }) : prev);
  }, []);

  const patchPersonalFinancial: ApplicationContextValue["patchPersonalFinancial"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, personalFinancial: { ...prev.personalFinancial, ...patch } }) : prev);
  }, []);

  const patchBusinessInfo: ApplicationContextValue["patchBusinessInfo"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, businessInfo: { ...prev.businessInfo, ...patch } }) : prev);
  }, []);

  const patchBusinessRep: ApplicationContextValue["patchBusinessRep"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, businessRep: { ...prev.businessRep, ...patch } }) : prev);
  }, []);

  const patchBusinessFinancial: ApplicationContextValue["patchBusinessFinancial"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, businessFinancial: { ...prev.businessFinancial, ...patch } }) : prev);
  }, []);

  const patchKyc: ApplicationContextValue["patchKyc"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, kyc: { ...prev.kyc, ...patch } }) : prev);
  }, []);

  const patchLoanRequest: ApplicationContextValue["patchLoanRequest"] = useCallback((patch) => {
    setApplication((prev) => {
      if (!prev) return prev;
      const nextLoan = { ...prev.loanRequest, ...patch };
      const nextCalc = calculateLoan(nextLoan.amount, nextLoan.tenure, { loanType: prev.applicantType || "PERSONAL" });
      return touch({ ...prev, loanRequest: nextLoan, calculation: nextCalc });
    });
  }, []);

  const patchAgreement: ApplicationContextValue["patchAgreement"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, agreement: { ...prev.agreement, ...patch } }) : prev);
  }, []);

  const patchDocuments: ApplicationContextValue["patchDocuments"] = useCallback((patch) => {
    setApplication((prev) => prev ? touch({ ...prev, documents: { ...prev.documents, ...patch } }) : prev);
  }, []);

  const markSectionStatus = useCallback((key: SectionKey, status: SectionStatus) => {
    setSectionStatusOverrides((prev) => ({ ...prev, [key]: status }));
  }, []);

  // ----- save now (explicit) -----
  const saveNow = useCallback(async (): Promise<SaveDraftResponse | null> => {
    if (!application) return null;
    setSaveState("saving");
    try {
      saveApplication(application, currentIndexRef.current);
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      return { ok: true, applicationId: application.applicationId, status: application.status };
    } catch (e: any) {
      setSaveState("error");
      return { ok: false, applicationId: application.applicationId, status: application.status, error: e?.message || "Save failed" };
    }
  }, [application]);

  // ----- submit -----
  const submit = useCallback(async (): Promise<SubmitResponse | null> => {
    if (!application) return null;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const res = getAccessToken()
        ? await (async () => {
            const response = await submitBorrowerApplication(application as unknown as Record<string, unknown>);
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

function normalizeApplicationData(data: ApplicationData): ApplicationData {
  const now = new Date().toISOString();
  const program = getLoanProgram(data.applicantType || "PERSONAL");
  const loanRequest = Object.assign({
    amount: program.loanLimits.defaultAmount,
    tenure: program.tenures[0]?.value || 30,
    purpose: "",
  }, data.loanRequest || {});

  return {
    ...data,
    applicationId: data.applicationId || generateDraftId(),
    applicantType: data.applicantType || null,
    status: data.status || "DRAFT",
    personalInfo: Object.assign({
      fullName: "",
      phone: "",
      email: "",
      dateOfBirth: "",
      residentialAddress: "",
      state: "",
      lga: "",
    }, data.personalInfo || {}),
    disbursementAccount: Object.assign({
      accountName: "",
      bankName: "",
      accountNumber: "",
    }, data.disbursementAccount || {}),
    personalFinancial: Object.assign({
      employmentStatus: "",
      employerBusinessName: "",
      monthlyIncome: "",
      monthlyExpenses: "",
      existingLoanObligations: "",
      expectedRepaymentSource: "",
    }, data.personalFinancial || {}),
    businessInfo: Object.assign({
      businessName: "",
      businessRegistrationNumber: "",
      businessType: "",
      businessAddress: "",
      businessIndustry: "",
      yearsInBusiness: "",
    }, data.businessInfo || {}),
    businessRep: Object.assign({
      fullName: "",
      dateOfBirth: "",
      position: "",
      phone: "","replace_all":false},{
      email: "",
      residentialAddress: "",
    }, data.businessRep || {}),
    businessFinancial: Object.assign({
      averageMonthlyRevenue: "",
      averageMonthlyExpenses: "",
      existingLoanObligations: "",
      expectedRepaymentSource: "",
    }, data.businessFinancial || {}),
    kyc: Object.assign({
      bvn: "",
      nin: "",
      identificationType: "",
      identificationNumber: "",
    }, data.kyc || {}),
    loanRequest,
    collateral: Object.assign({ provided: false, type: "", description: "", estimatedValue: "", ownership: "", location: "", documentReference: "" }, data.collateral || {}),
    calculation: data.calculation || calculateLoan(loanRequest.amount, loanRequest.tenure, { loanType: data.applicantType || "PERSONAL" }),
    documents: data.documents || {},
    agreement: Object.assign({
      generatedAt: null,
      generatedHtml: null,
      signedAgreementAccepted: false,
    }, data.agreement || {}),
    createdAt: data.createdAt || now,
    updatedAt: data.updatedAt || now,
    submittedAt: data.submittedAt || null,
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
