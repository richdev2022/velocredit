// ============================================================================
// src/components/SectionShell.tsx
// Wrapper that gives every section the same heading + button row.
// Buttons: Save & Continue (primary), Save & Exit (secondary), Skip for Now
// (ghost, when skippable).
// ============================================================================

import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import SaveProgress from "./SaveProgress";
import ProgressSteps from "./ProgressSteps";
import { useApplication } from "../context/ApplicationContext";

interface SectionShellProps {
  title: string;
  description?: string;
  children: ReactNode;
  skippable?: boolean;
  /** Disable Save & Continue until the form is valid */
  canContinue: boolean;
  /** Override what Save & Continue does. Defaults to: mark completed, navigate next. */
  onContinue?: () => void;
  /** Override the Continue button label. Defaults to "Save & Continue". Use "Submit Application" for the final review step. */
  continueLabel?: string;
  /** If true, hide the secondary "Save & Exit" button row (used on final review screen). */
  hideSaveExit?: boolean;
}

export default function SectionShell({
  title,
  description,
  children,
  skippable = false,
  canContinue,
  onContinue,
  continueLabel,
  hideSaveExit = false,
}: SectionShellProps) {
  const navigate = useNavigate();
  const { sections, currentIndex, saveState, lastSavedAt, markSectionStatus, saveNow, next, goToSection } = useApplication();

  function handleSaveAndContinue() {
    const current = sections[currentIndex];
    if (current) markSectionStatus(current.key, "completed");
    void saveNow();
    if (onContinue) {
      onContinue();
    } else {
      next();
    }
  }

  function handleSaveAndExit() {
    void saveNow();
    navigate("/apply/dashboard");
  }

  function handleSkip() {
    const current = sections[currentIndex];
    if (current) markSectionStatus(current.key, "skipped");
    next();
  }

  function handleSaveProgress() {
    const current = sections[currentIndex];
    if (current && current.status === "not_started") {
      markSectionStatus(current.key, "in_progress");
    }
    void saveNow();
    navigate("/apply/dashboard");
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <ProgressSteps sections={sections} currentIndex={currentIndex} />

      <div className="velo-card p-5 sm:p-7">
        <div className="flex min-w-0 flex-col gap-2 mb-1 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="section-heading">{title}</h1>
            {description && <p className="section-subheading">{description}</p>}
          </div>
          <div className="shrink-0 self-start"><SaveProgress state={saveState} lastSavedAt={lastSavedAt} /></div>
        </div>

        <div className="mt-5">
          {children}
        </div>

        <div className="mt-7 pt-5 border-t border-slate-100 flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-between">
          <div className="flex w-full flex-col gap-2 sm:order-2 sm:w-auto sm:flex-row">
            {skippable && (
              <button type="button" onClick={handleSkip} className="btn-ghost">
                Skip for Now
              </button>
            )}
            {!hideSaveExit && (
              <button type="button" onClick={handleSaveAndExit} className="btn-secondary">
                Save & Exit
              </button>
            )}
            <button type="button" onClick={handleSaveAndContinue} disabled={!canContinue} className="btn-primary w-full sm:w-auto">
              {continueLabel || "Save & Continue"}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div className="sm:order-1">
            {!hideSaveExit && (
              <button type="button" onClick={handleSaveProgress} className="btn-ghost text-xs">
                Save Progress
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
