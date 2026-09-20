// ============================================================================
// src/components/ApplicationDashboard.tsx
// Section-based dashboard. Each section shows status, Continue / Edit / Skip.
// This is the "hub" of the wizard — the user can return here at any time.
// ============================================================================

import type { ApplicationData, SectionState } from "../types/application";
import ProgressSteps from "./ProgressSteps";
import SaveProgress, { type SaveState } from "./SaveProgress";
import Icon from "./Icon";

interface ApplicationDashboardProps {
  application: ApplicationData;
  sections: SectionState[];
  currentIndex: number;
  saveState: SaveState;
  lastSavedAt?: string | null;
  onNavigate: (index: number) => void;
  onSubmit: () => void;
  canSubmit: boolean;
}

export default function ApplicationDashboard({
  application,
  sections,
  currentIndex,
  saveState,
  lastSavedAt,
  onNavigate,
  onSubmit,
  canSubmit,
}: ApplicationDashboardProps) {
  const completed = sections.filter((s) => s.status === "completed").length;
  const total = sections.length;
  const pct = Math.round((completed / total) * 100);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="velo-card p-5 sm:p-6 dark:bg-slate-900 dark:border-slate-800">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-velo-600 dark:text-velo-400">
              {application.applicantType === "PERSONAL" ? "Personal Loan" : "Business Loan"} Application
            </p>
            <h1 className="text-xl sm:text-2xl font-bold text-velo-900 dark:text-white mt-1">Your Loan Application</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Application ID: <span className="font-mono font-semibold text-velo-700 dark:text-velo-300">{application.applicationId}</span>
            </p>
          </div>
          <div className="flex flex-col sm:items-end gap-1">
            <SaveProgress state={saveState} lastSavedAt={lastSavedAt} />
            <span className="badge badge-pending">{application.status}</span>
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1.5">
            <span>{completed} of {total} sections completed</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-velo-500 to-velo-400 transition-all duration-500"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {/* Mini step indicator */}
        <div className="mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
          <ProgressSteps sections={sections} currentIndex={currentIndex} />
        </div>
      </div>

      {/* Section list */}
      <div className="velo-card divide-y divide-slate-100 dark:divide-slate-800 dark:bg-slate-900 dark:border-slate-800">
        {sections.map((s, i) => (
          <SectionRow
            key={s.key}
            section={s}
            index={i + 1}
            isCurrent={i === currentIndex}
            onNavigate={() => onNavigate(i)}
          />
        ))}
      </div>

      {/* Submit */}
      <div className="velo-card p-5 sm:p-6 bg-gradient-to-br from-velo-50 to-white dark:from-slate-800 dark:to-slate-900 dark:border-slate-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-velo-900 dark:text-white">Ready to submit?</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              {canSubmit
                ? "All required sections are complete. Submit your application for review."
                : "Complete all required sections to enable submission."}
            </p>
          </div>
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            className="btn-primary shrink-0"
          >
            Submit Loan Application
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M5 12h14M13 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionRow({
  section,
  index,
  isCurrent,
  onNavigate,
}: {
  section: SectionState;
  index: number;
  isCurrent: boolean;
  onNavigate: () => void;
}) {
  const isLocked = section.status === "locked";
  const isCompleted = section.status === "completed";
  const isSkipped = section.status === "skipped";

  const statusBadge = isLocked ? (
    <span className="badge badge-locked">Locked</span>
  ) : isCompleted ? (
    <span className="badge badge-completed">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
        <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
      Completed
    </span>
  ) : isSkipped ? (
    <span className="badge badge-skipped">Skipped</span>
  ) : section.status === "in_progress" ? (
    <span className="badge badge-pending">In Progress</span>
  ) : (
    <span className="badge badge-skipped">Not Started</span>
  );

  return (
    <div
      className={`flex items-center justify-between gap-3 p-4 sm:p-5 transition
        ${isCurrent ? "bg-velo-50/40 dark:bg-velo-900/20" : "hover:bg-slate-50 dark:hover:bg-slate-800/40"}
      `}
    >
      <div className="flex items-start gap-3 sm:gap-4">
        <span
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold shrink-0
            ${isLocked ? "bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600" :
              isCompleted ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300" :
              isSkipped ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" :
              "bg-velo-100 text-velo-700 dark:bg-velo-900/40 dark:text-velo-300"
            }`}
        >
          {isCompleted ? <Icon name="check" size={17} strokeWidth={2.5} /> : index}
        </span>
        <div className="min-w-0">
          <div className="font-medium text-velo-900 dark:text-white text-sm sm:text-base">{section.label}</div>
          {section.required ? (
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Required</div>
          ) : (
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Optional — can be skipped</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {statusBadge}
        <button
          type="button"
          onClick={onNavigate}
          disabled={isLocked}
          className={isCompleted ? "btn-ghost" : "btn-primary !px-3 !py-1.5 text-sm"}
        >
          {isCompleted ? "Edit" : isLocked ? "—" : isSkipped ? "Resume" : "Continue"}
        </button>
      </div>
    </div>
  );
}
