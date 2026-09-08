// ============================================================================
// src/sections/ApplicantTypeSection.tsx
// First step of the wizard — pick Personal or Business loan.
// ============================================================================

import { useState } from "react";
import ApplicantTypeSelector from "../components/ApplicantTypeSelector";
import SectionShell from "../components/SectionShell";
import { useApplication } from "../context/ApplicationContext";
import type { ApplicantType } from "../types/application";

export default function ApplicantTypeSection() {
  const { application, update, markSectionStatus, next, saveNow, startNewApplication } = useApplication();
  const [selected, setSelected] = useState<ApplicantType | null>(application?.applicantType || null);

  function handleSelect(t: ApplicantType) {
    setSelected(t);
    if (!application) {
      startNewApplication(t);
    } else {
      update("applicantType", t);
    }
  }

  function handleContinue() {
    if (!selected) return;
    if (!application) {
      startNewApplication(selected);
    } else {
      update("applicantType", selected);
    }
    markSectionStatus("applicantType", "completed");
    void saveNow();
    next();
  }

  return (
    <SectionShell
      title="What type of loan are you applying for?"
      description="Choose the option that best describes your need."
      canContinue={!!selected}
      onContinue={handleContinue}
    >
      <ApplicantTypeSelector value={selected} onChange={handleSelect} />

      <div className="mt-5 rounded-xl bg-slate-50 border border-slate-100 p-4 flex items-start gap-3">
        <svg className="text-slate-400 shrink-0 mt-0.5" width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8"/>
          <path d="M12 8v4M12 16h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        <p className="text-xs text-slate-600 leading-relaxed">
          Your selection determines which sections of the form you'll need to complete. You can save and resume at any time.
        </p>
      </div>
    </SectionShell>
  );
}
