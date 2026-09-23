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
import { applyLoanProducts, config, getLoanProgram } from "../utils/config";
import { generateDraftId } from "../utils/applicationId";
import {
  loadApplication,
  saveApplication,
  deleteApplication,
  findDraftsByEmailOrPhone,
  getSavedSectionIndex,
} from "../utils/storage";
import {
  deleteApplicationDraft,
  getAccessToken,
  getApplicationDraft,
  getBorrowerDashboard,
  getReapplyPrefill,
  saveApplicationDraft,
  submitBorrowerApplication,
  getLoanProducts,
} from "../services/apiClient";
import { useAuth } from "./AuthContext";
import type {
  LookupDraftResponse,
  SaveDraftResponse,
  SubmitResponse,
  BusinessRepresentative,
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
  prefillFromPrevious: () => Promise<ApplicationData | null>;
  resumeApplication: (email: string, phone: string) => Promise<LookupDraftResponse>;
  loadExisting: (id: string, data?: ApplicationData, sectionIndex?: number | null) => void;
  resetApplication: () => void;
  /** Source application ID when the current draft was auto-prefilled from a previous application. */
  prefilledFrom: string | null;
  dismissPrefillNotice: () => void;

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
  const [loanConfigVersion, setLoanConfigVersion] = useState(0);
  const [prefilledFrom, setPrefilledFrom] = useState<string | null>(null);

  const applicationRef = useRef<ApplicationData | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutoSave = useRef(false);
  const currentIndexRef = useRef(0);
  const restoredUserIdRef = useRef<string | null>(null);
  // Reapply-prefill bookkeeping: one in-flight request per application ID
  // (concurrent callers share the promise) + a completed set so the safety-net
  // effect never re-fetches for an application that was already prefilled.
  const prefillInFlightRef = useRef<Map<string, Promise<ApplicationData | null>>>(new Map());
  const prefilledApplicationIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;
    void getLoanProducts().then((response) => {
      // When EVERY product is inactive the backend still serves the catalog
      // (catalogNotice ALL_PRODUCTS_INACTIVE_FALLBACK) so the funnel is not
      // bricked — apply those rows instead of dropping them, otherwise the
      // borrower sees stale env defaults instead of the admin's terms.
      applyLoanProducts(response.products, {
        includeInactive: response.catalogNotice === "ALL_PRODUCTS_INACTIVE_FALLBACK",
      });
      setLoanConfigVersion((version) => version + 1);
    }).catch(() => {
      // The deployed frontend defaults remain usable when products are unavailable.
    });
  }, [user]);

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
      if (local) {
        resumed = normalizeApplicationData(local, applicationRef.current);
        savedIndex = getSavedSectionIndex(resumed);
      }
      try {
        const remote = await getApplicationDraft();
        if (remote.draft) {
          const remoteApplication = normalizeApplicationData(remote.draft.data as unknown as ApplicationData, applicationRef.current);
          if (!resumed || new Date(remote.draft.updatedAt).getTime() >= new Date(resumed.updatedAt).getTime()) {
            resumed = remoteApplication;
            savedIndex = remote.draft.lastSectionIndex;
          }
        }
      } catch {
        // Local drafts remain available when the database is temporarily unavailable.
      }

      // ----- server status sync: rejected / more-info applications are re-openable -----
      // A submitted application that was later REJECTED (or flagged
      // MORE_INFORMATION_REQUIRED) must be RE-OPENABLE: the customer has to
      // re-access the loan, fill the failed information and resubmit. The
      // stale SUBMITTED draft would otherwise trap them on the success page.
      // When no draft exists at all (new device / cleared storage) we hydrate
      // the most recent rejected application from its stored snapshot.
      if (getAccessToken()) {
        try {
          const dashboard = await getBorrowerDashboard();
          const apps = Array.isArray((dashboard as { applications?: unknown[] }).applications)
            ? ((dashboard as { applications: unknown[] }).applications as Array<Record<string, unknown>>)
            : [];
          const reOpenableStatuses = ["REJECTED", "MORE_INFORMATION_REQUIRED"];
          const serverNote = (row: Record<string, unknown>): string | null => {
            const note = typeof row.manualNote === "string" ? row.manualNote.trim() : "";
            return note ? note : null;
          };
          if (resumed) {
            const serverApp = apps.find(
              (row) => String(row.applicationId ?? "") === resumed!.applicationId || String(row.id ?? "") === resumed!.applicationId
            );
            const serverStatus = String(serverApp?.status ?? "");
            if (serverApp && reOpenableStatuses.includes(serverStatus)) {
              resumed = {
                ...resumed,
                status: String(serverApp.status) as ApplicationData["status"],
                rejectionNote: serverNote(serverApp),
                updatedAt: String(serverApp.updatedAt ?? resumed.updatedAt),
              };
              savedIndex = getSavedSectionIndex(resumed);
              // Persist the re-opened state so a refresh keeps the wizard editable.
              saveApplication(resumed, savedIndex);
            } else if (serverApp && ["REPAID", "CANCELLED", "WRITTEN_OFF"].includes(serverStatus)) {
              // The application behind this draft already reached a terminal
              // state. Resuming it would reuse the OLD application ID on the
              // customer's NEXT loan request — purge the stale draft from the
              // browser and the server so /apply starts genuinely fresh.
              deleteApplication(resumed.applicationId);
              void deleteApplicationDraft(resumed.applicationId).catch(() => {});
              resumed = null;
              savedIndex = 0;
            }
          } else {
            const rejected = apps
              .filter((row) => String(row.status ?? "") === "REJECTED")
              .sort((a, b) =>
                String(b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.updatedAt ?? a.createdAt ?? ""))
              )[0];
            if (rejected) {
              const hydrated = buildEditableApplicationFromServerRow(rejected);
              if (hydrated) {
                resumed = hydrated;
                savedIndex = getSavedSectionIndex(resumed);
              }
            }
          }
        } catch {
          // Dashboard unavailable — keep whatever draft we restored locally.
        }
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
  }, [application?.loanRequest?.amount, application?.loanRequest?.tenure, application?.applicantType, loanConfigVersion]);

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

  // ----- persistence: localStorage and the authenticated database draft -----
  useEffect(() => {
    if (!application) return;
    saveApplication(application, currentIndexRef.current);
    skipNextAutoSave.current = false;

    if (!getAccessToken() || !application.applicantType || application.status === "SUBMITTED") return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const draft = applicationRef.current;
      if (!draft || !draft.applicantType) return;
      setSaveState("saving");
      void saveApplicationDraft({
        applicationId: draft.applicationId,
        applicantType: draft.applicantType,
        data: compactApplicationData(draft),
        lastSectionIndex: currentIndexRef.current,
        updatedAt: draft.updatedAt,
      }).then(() => {
        setSaveState("saved");
        setLastSavedAt(new Date().toISOString());
      }).catch(() => {
        setSaveState("error");
      });
    }, 600);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
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
    setPrefilledFrom(null);
    return fresh;
  }, []);

  // ----- lifecycle: prefill from previous application -----
  // Returning borrowers must NOT re-enter information they already provided.
  // Preferred source: the server-side reapply-prefill endpoint, which merges
  // EVERY previous application snapshot (newest wins) with the account
  // profile, the verified KYC case and the saved disbursement account — so
  // even a customer whose latest snapshot is incomplete still gets every
  // section filled. Fallback: the most recent snapshot from the borrower
  // dashboard. Identity verifications carry over too (same person, already
  // verified). Documents and the signed agreement are intentionally NOT
  // carried over — those must be re-uploaded / re-signed for the new loan.
  const prefillFromPrevious = useCallback(async (): Promise<ApplicationData | null> => {
    const current = applicationRef.current;
    if (!current || current.status === "SUBMITTED") return null;
    if (!getAccessToken()) return null;
    const appKey = current.applicationId;
    // Already prefilled for this application (or a fetch is running for it) —
    // concurrent callers share the same promise; completed ones short-circuit.
    if (prefilledApplicationIdsRef.current.has(appKey)) return null;
    const running = prefillInFlightRef.current.get(appKey);
    if (running) return running;
    const promise = (async (): Promise<ApplicationData | null> => {
      try {
        // 1) Server-merged prefill (richest source).
        try {
          const response = await getReapplyPrefill();
          const prefill = response?.prefill;
          if (response?.ok && prefill && response.meta?.hasPreviousApplication) {
            const { application: merged, changed } = mergePrefillIntoDraft(current, prefill);
            if (applicationRef.current?.applicationId !== current.applicationId) return null;
            if (!changed) return current; // everything already filled — no churn
            applicationRef.current = merged;
            setApplication(merged);
            setPrefilledFrom(response.meta?.sourceApplicationId || "previous-application");
            return merged;
          }
          if (response?.ok && response.meta && response.meta.hasPreviousApplication === false) {
            return null; // genuinely a first-time borrower
          }
        } catch {
          // Endpoint unavailable (older backend deployment) — fall through.
        }

        // 2) Fallback: most recent dashboard application snapshot.
        const dashboard = await getBorrowerDashboard();
        const applications = Array.isArray((dashboard as { applications?: unknown[] }).applications)
          ? ((dashboard as { applications: unknown[] }).applications as Array<Record<string, unknown>>)
          : [];
        const relevantStatuses = ["SUBMITTED", "KYC_PENDING", "UNDER_REVIEW", "MORE_INFORMATION_REQUIRED", "APPROVED", "DISBURSED", "ACTIVE", "PAST_DUE", "DEFAULTED", "REPAID", "REJECTED", "CANCELLED", "WRITTEN_OFF"];
        const previous = applications
          .filter((app) => relevantStatuses.includes(String(app.status ?? "")))
          .filter((app) => String(app.id ?? "") !== current.applicationId && String(app.applicationId ?? "") !== current.applicationId)
          .sort((a, b) =>
            String(b.submittedAt ?? b.updatedAt ?? b.createdAt ?? "").localeCompare(String(a.submittedAt ?? a.updatedAt ?? a.createdAt ?? ""))
          )[0];
        if (!previous) return null;
        const snapshot = (previous.customerSnapshot ?? {}) as Record<string, unknown>;
        const { application: merged, changed } = mergePrefillIntoDraft(current, {
          personalInfo: snapshot.personalInfo as Record<string, unknown> | undefined,
          disbursementAccount: snapshot.disbursementAccount as Record<string, unknown> | undefined,
          personalFinancial: snapshot.personalFinancial as Record<string, unknown> | undefined,
          businessInfo: snapshot.businessInfo as Record<string, unknown> | undefined,
          businessRep: snapshot.businessRep as Record<string, unknown> | undefined,
          businessFinancial: snapshot.businessFinancial as Record<string, unknown> | undefined,
          kyc: snapshot.kyc as Record<string, unknown> | undefined,
          collateral: snapshot.collateral as Record<string, unknown> | undefined,
          witness: snapshot.witness as Record<string, unknown> | undefined,
          loanRequest: snapshot.loanRequest as Record<string, unknown> | undefined,
        });
        // Commit the prefill ONLY if the fresh draft we started from is still
        // the active application — if the dashboard call raced with another
        // start/resume, silently dropping the prefill would leave the wizard
        // empty and the returning borrower would have to re-type everything.
        if (applicationRef.current?.applicationId !== current.applicationId) return null;
        if (!changed) return current;
        applicationRef.current = merged;
        setApplication(merged);
        setPrefilledFrom(String(previous.applicationId ?? previous.id ?? "previous-application"));
        return merged;
      } catch (_e) {
        return null;
      } finally {
        prefillInFlightRef.current.delete(appKey);
        prefilledApplicationIdsRef.current.add(appKey);
      }
    })();
    prefillInFlightRef.current.set(appKey, promise);
    return promise;
  }, []);

  // ----- SAFETY NET: prefill EVERY active application -----
  // Whatever navigation path produced the active draft — the dashboard
  // "Apply Again" CTA, a draft restored from this browser or the server, a
  // direct /apply?type=… link, or the wizard's type selection — a returning
  // customer must land in a pre-filled wizard. This effect fires the prefill
  // for any active non-submitted application; prefillFromPrevious dedups
  // concurrent + repeat calls per application ID, and only fills EMPTY
  // fields, so it can never overwrite what the customer typed.
  useEffect(() => {
    if (!user) return;
    const app = applicationRef.current;
    if (!app || app.status === "SUBMITTED") return;
    void prefillFromPrevious();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, application?.applicationId]);

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
    setPrefilledFrom(null);
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
    if (!getAccessToken() || !draft.applicantType || draft.status === "SUBMITTED") {
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      return { ok: true, applicationId: draft.applicationId, status: draft.status };
    }
    setSaveState("saving");
    try {
      await saveApplicationDraft({
        applicationId: draft.applicationId,
        applicantType: draft.applicantType,
        data: compactApplicationData(draft),
        lastSectionIndex: currentIndexRef.current,
        updatedAt: draft.updatedAt,
      });
      setSaveState("saved");
      setLastSavedAt(new Date().toISOString());
      return { ok: true, applicationId: draft.applicationId, status: draft.status };
    } catch (error) {
      setSaveState("error");
      return { ok: false, applicationId: draft.applicationId, status: draft.status, error: error instanceof Error ? error.message : "Unable to save your progress." };
    }
  }, [application]);

  // ----- submit -----
  const submit = useCallback(async (): Promise<SubmitResponse | null> => {
    if (!application) return null;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      // Hard gate: a loan application can NEVER be submitted without a
      // complete disbursement account (name, bank, code and 10-digit NUBAN).
      // Previously an incomplete account sailed through and later bricked
      // admin disbursement with "No disbursement account found".
      const acct = application.disbursementAccount ?? ({} as typeof application.disbursementAccount);
      const missingAcct: string[] = [];
      if (!acct.accountName?.trim()) missingAcct.push("verified account name");
      if (!acct.bankName?.trim() || !acct.bankCode?.trim()) missingAcct.push("bank");
      if (!/^\d{10}$/.test(String(acct.accountNumber ?? "").trim())) missingAcct.push("10-digit account number");
      if (missingAcct.length) {
        const msg = `Your disbursement account is incomplete (missing ${missingAcct.join(", ")}). Please complete the Disbursement Account Information in your details section before submitting — this is where your loan will be paid.`;
        setSubmitError(msg);
        return { ok: false, applicationId: application.applicationId, status: application.status, error: msg };
      }
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
    prefillFromPrevious,
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
    prefilledFrom,
    dismissPrefillNotice: () => setPrefilledFrom(null),
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

/**
 * Merge a server-provided prefill payload (from the reapply-prefill endpoint
 * or a dashboard application snapshot) into a fresh draft. Every still-empty
 * field is filled; values the customer has already typed in this draft are
 * never overwritten (except the loan request, which restores the previous
 * amount/tenure clamped to the CURRENT product limits). Used by BOTH prefill
 * sources so the behaviour is identical whichever one serves the data.
 * Returns `changed: false` (and the ORIGINAL draft) when the merge would not
 * alter anything, so callers can skip needless state updates and only show
 * the prefill banner when something was actually filled.
 */
function mergePrefillIntoDraft(
  current: ApplicationData,
  prefill: {
    personalInfo?: Record<string, unknown> | null;
    disbursementAccount?: Record<string, unknown> | null;
    personalFinancial?: Record<string, unknown> | null;
    businessInfo?: Record<string, unknown> | null;
    businessRep?: Record<string, unknown> | null;
    businessFinancial?: Record<string, unknown> | null;
    kyc?: Record<string, unknown> | null;
    collateral?: Record<string, unknown> | null;
    witness?: Record<string, unknown> | null;
    loanRequest?: Record<string, unknown> | null;
  }
): { application: ApplicationData; changed: boolean } {
  const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const fillStrings = <T extends object>(base: T, incoming: Record<string, unknown> | undefined | null, fields: Array<keyof T & string>): T => {
    const next = { ...base } as Record<string, unknown>;
    for (const field of fields) {
      if (String(next[field] ?? "").trim() !== "") continue;
      const value = str(incoming?.[field]);
      if (value) next[field] = value;
    }
    return next as unknown as T;
  };

  const prevDisb = (prefill.disbursementAccount ?? {}) as Record<string, unknown>;
  const prevKyc = (prefill.kyc ?? {}) as Record<string, unknown>;
  const prevLoan = (prefill.loanRequest ?? {}) as Record<string, unknown>;
  const program = getLoanProgram(current.applicantType || "PERSONAL");

  // Loan request: restore the previous amount/tenure — clamped to the
  // CURRENT product limits, which may have changed since the last loan.
  const prevAmount = Number(prevLoan.amount);
  const amount = Number.isFinite(prevAmount) && prevAmount > 0
    ? Math.min(program.loanLimits.max, Math.max(program.loanLimits.min, prevAmount))
    : current.loanRequest.amount;
  const tenureValues = program.tenures.map((t) => t.value);
  const prevTenure = Number(prevLoan.tenure);
  const tenure = tenureValues.includes(prevTenure) ? prevTenure : current.loanRequest.tenure;
  const purpose = current.loanRequest.purpose || str(prevLoan.purpose);

  // KYC: carry the identifiers AND their verification status — the same
  // person already passed BVN/NIN/liveness in a previous application.
  // Masked display leftovers ("***-***-1234") are rejected: only a FULL
  // 11-digit identifier may be pooled into the draft. BVN is mandatory and
  // is what the credit bureau pipeline passes to Prembly.
  const fullId = (value: unknown): string => {
    const s = str(value);
    return /^\d{11}$/.test(s) ? s : "";
  };
  const kyc: ApplicationData["kyc"] = { ...current.kyc };
  if (String(kyc.bvn ?? "").trim() === "" && fullId(prevKyc.bvn)) kyc.bvn = fullId(prevKyc.bvn);
  if (String(kyc.nin ?? "").trim() === "" && fullId(prevKyc.nin)) kyc.nin = fullId(prevKyc.nin);
  for (const field of ["identificationType", "identificationNumber"] as const) {
    if (String(kyc[field] ?? "").trim() === "" && str(prevKyc[field])) {
      (kyc as unknown as Record<string, unknown>)[field] = str(prevKyc[field]);
    }
  }
  if (prevKyc.bvnVerified === true) kyc.bvnVerified = true;
  if (prevKyc.ninVerified === true) kyc.ninVerified = true;
  if (prevKyc.livenessVerified === true) kyc.livenessVerified = true;
  if (prevKyc.verifiedDetails && typeof prevKyc.verifiedDetails === "object") {
    kyc.verifiedDetails = { ...(kyc.verifiedDetails ?? {}), ...(prevKyc.verifiedDetails as Record<string, unknown>) };
  }
  if (str(prevKyc.identityPhotoUrl)) kyc.identityPhotoUrl = str(prevKyc.identityPhotoUrl);

  const merged: ApplicationData = {
    ...current,
    updatedAt: new Date().toISOString(),
    personalInfo: fillStrings(current.personalInfo, prefill.personalInfo, ["fullName", "phone", "email", "dateOfBirth", "residentialAddress", "state", "lga"]),
    disbursementAccount: fillStrings(
      { ...current.disbursementAccount, bankCode: current.disbursementAccount.bankCode ?? "" },
      prevDisb,
      ["accountName", "bankName", "bankCode", "accountNumber"],
    ),
    personalFinancial: fillStrings(current.personalFinancial, prefill.personalFinancial, ["employmentStatus", "employerBusinessName", "monthlyIncome", "monthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"]),
    businessInfo: fillStrings(current.businessInfo, prefill.businessInfo, ["businessName", "businessRegistrationNumber", "businessType", "businessAddress", "businessIndustry", "yearsInBusiness"]),
    businessRep: fillStrings(current.businessRep, prefill.businessRep, ["fullName", "dateOfBirth", "position", "phone", "email", "residentialAddress"]),
    businessFinancial: fillStrings(current.businessFinancial, prefill.businessFinancial, ["averageMonthlyRevenue", "averageMonthlyExpenses", "existingLoanObligations", "expectedRepaymentSource"]),
    kyc,
    collateral: (() => {
      const prev = (prefill.collateral ?? {}) as Record<string, unknown>;
      const merged = { ...current.collateral };
      for (const field of ["type", "description", "estimatedValue", "ownership", "location", "documentReference"] as const) {
        if (String(merged[field] ?? "").trim() === "" && str(prev[field])) merged[field] = str(prev[field]);
      }
      if (merged.provided !== true && typeof prev.provided === "boolean") merged.provided = prev.provided;
      return merged;
    })(),
    witness: (() => {
      const prev = (prefill.witness ?? {}) as Record<string, unknown>;
      return {
        fullName: current.witness.fullName || str(prev.fullName),
        phone: current.witness.phone || str(prev.phone),
      };
    })(),
    loanRequest: { amount, tenure, purpose },
    calculation: calculateLoan(amount, tenure, { loanType: current.applicantType || "PERSONAL" }),
  };

  // `changed` detection: compare every prefill-affected slice (excluding
  // updatedAt, which always changes) between the incoming draft and the
  // merged one.
  const fingerprint = (a: ApplicationData): string =>
    JSON.stringify({
      personalInfo: a.personalInfo,
      disbursementAccount: a.disbursementAccount,
      personalFinancial: a.personalFinancial,
      businessInfo: a.businessInfo,
      businessRep: a.businessRep,
      businessFinancial: a.businessFinancial,
      kyc: a.kyc,
      collateral: a.collateral,
      witness: a.witness,
      loanRequest: a.loanRequest,
      calculation: a.calculation,
    });
  return { application: merged, changed: fingerprint(current) !== fingerprint(merged) };
}

/**
 * Build an EDITABLE ApplicationData from a backend loan-application row whose
 * status is REJECTED. Used when the customer has no local/remote draft (new
 * device or cleared storage) but must still be able to re-access their
 * rejected loan, fix the failed information and resubmit. Every section is
 * restored from the immutable customerSnapshot captured at submission.
 */
function buildEditableApplicationFromServerRow(row: Record<string, unknown>): ApplicationData | null {
  const applicantType = row.applicantType === "BUSINESS" ? "BUSINESS" : row.applicantType === "PERSONAL" ? "PERSONAL" : null;
  const applicationId = String(row.applicationId ?? row.id ?? "").trim();
  if (!applicantType || !applicationId) return null;
  const snapshot = (row.customerSnapshot ?? {}) as Record<string, Record<string, unknown>>;
  const now = new Date().toISOString();
  const note = typeof row.manualNote === "string" && row.manualNote.trim() ? row.manualNote.trim() : null;
  const base: ApplicationData = normalizeApplicationData(
    {
      applicationId,
      applicantType,
      status: "REJECTED",
      personalInfo: (snapshot.personalInfo ?? {}) as unknown as ApplicationData["personalInfo"],
      disbursementAccount: (snapshot.disbursementAccount ?? {}) as unknown as ApplicationData["disbursementAccount"],
      personalFinancial: (snapshot.personalFinancial ?? {}) as unknown as ApplicationData["personalFinancial"],
      businessInfo: (snapshot.businessInfo ?? {}) as unknown as ApplicationData["businessInfo"],
      businessRep: (snapshot.businessRep ?? {}) as unknown as ApplicationData["businessRep"],
      businessFinancial: (snapshot.businessFinancial ?? {}) as unknown as ApplicationData["businessFinancial"],
      kyc: (snapshot.kyc ?? {}) as unknown as ApplicationData["kyc"],
      loanRequest: (snapshot.loanRequest ?? {}) as unknown as ApplicationData["loanRequest"],
      collateral: (snapshot.collateral ?? {}) as unknown as ApplicationData["collateral"],
      calculation: (snapshot.calculation as unknown as ApplicationData["calculation"]) ?? null,
      documents: (snapshot.documents ?? {}) as unknown as ApplicationData["documents"],
      witness: (snapshot.witness ?? {}) as unknown as ApplicationData["witness"],
      agreement: { generatedAt: null, executionDate: null, generatedHtml: null, signedAgreementAccepted: false },
      createdAt: String(row.createdAt ?? now),
      updatedAt: String(row.updatedAt ?? now),
      submittedAt: row.submittedAt ? String(row.submittedAt) : null,
      rejectionNote: note,
      rejectedAt: row.updatedAt ? String(row.updatedAt) : null,
    },
    null
  );
  // The agreement must be re-signed for a new review round; documents keep
  // their metadata so completed uploads still render, but the customer can
  // re-upload any slot the reviewer flagged.
  base.agreement = { generatedAt: null, executionDate: null, generatedHtml: null, signedAgreementAccepted: false };
  return base;
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
      // bankCode MUST survive normalization — the admin disbursement route
      // requires accountNumber + bankCode to send the transfer. Dropping it
      // here silently bricked every disbursement for resumed drafts.
      bankCode: pickOptionalString(prevDisb?.bankCode, dataDisb.bankCode, null) ?? undefined,
      accountNumber: pickString(prevDisb?.accountNumber, dataDisb.accountNumber, ""),
    },
    personalFinancial: {
      employmentStatus: pickString(prevPF?.employmentStatus, dataPF.employmentStatus, "") as ApplicationData["personalFinancial"]["employmentStatus"],
      employerBusinessName: pickString(prevPF?.employerBusinessName, dataPF.employerBusinessName, ""),
      monthlyIncome: pickString(prevPF?.monthlyIncome, dataPF.monthlyIncome, ""),
      monthlyExpenses: pickString(prevPF?.monthlyExpenses, dataPF.monthlyExpenses, ""),
      existingLoanObligations: pickString(prevPF?.existingLoanObligations, dataPF.existingLoanObligations, ""),
      expectedRepaymentSource: pickString(prevPF?.expectedRepaymentSource, dataPF.expectedRepaymentSource, ""),
    },
    businessInfo: {
      businessName: pickString(prevBI?.businessName, dataBI.businessName, ""),
      businessRegistrationNumber: pickString(prevBI?.businessRegistrationNumber, dataBI.businessRegistrationNumber, ""),
      businessType: pickString(prevBI?.businessType, dataBI.businessType, "") as ApplicationData["businessInfo"]["businessType"],
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
        // bankCode is required — the backend cannot disburse without it.
        const ok = Boolean(p.fullName && p.phone && p.email && p.dateOfBirth && p.residentialAddress && p.state && p.lga && account.accountName && account.bankName && account.bankCode && account.accountNumber);
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
      // bankCode is required — the backend cannot disburse without it.
      const ok = Boolean(r.fullName && r.position && r.phone && r.email && r.residentialAddress && account.accountName && account.bankName && account.bankCode && account.accountNumber);
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
