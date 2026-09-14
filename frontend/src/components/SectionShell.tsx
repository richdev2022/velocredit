// ============================================================================
// src/components/SectionShell.tsx
// Wrapper that gives every section the same heading + button row.
// Buttons: Save & Continue (primary), Save & Exit (secondary), Skip for Now
// (ghost, when skippable).
// ============================================================================

import type { ReactNode } from "react";
import { useState } from "react";
import ProgressSteps from "./ProgressSteps";
import { useApplication } from "../context/ApplicationContext";

interface SectionShellProps {
  title: string;
  description?: string;
  children: ReactNode;
  skippable?: boolean;
  /** Disable Save & Continue until the form is valid */
  canContinue: boolean;
  /** Commit section values. Return a section index to navigate there, or false to stay on the current section. */
  onContinue?: () => void | number | false | Promise<void | number | false>;
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
  const { sections, currentIndex, markSectionStatus, navigate: navigateSection, next, prev } = useApplication();
  const [continueBusy, setContinueBusy] = useState(false);

  async function handleSaveAndContinue() {
    if (continueBusy) return;
    setContinueBusy(true);
    try {
      const destination = onContinue ? await onContinue() : undefined;
      if (destination === false) return;
      if (typeof destination === "number") {
        navigateSection(destination);
        return;
      }
      next();
    } finally {
      setContinueBusy(false);
    }
  }

  function handleSkip() {
    const current = sections[currentIndex];
    if (current) markSectionStatus(current.key, "skipped");
    next();
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
            <button type="button" onClick={() => void handleSaveAndContinue()} disabled={continueBusy} className="btn-primary w-full sm:w-auto">
              {continueBusy ? "Loading…" : (continueLabel || "Continue")}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
          <div className="sm:order-1 flex items-center gap-1">
            {currentIndex > 0 && (
              <button type="button" onClick={prev} className="btn-secondary text-xs">Back</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
