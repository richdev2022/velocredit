// ============================================================================
// src/components/ProgressSteps.tsx
// Horizontal step indicator shown at the top of the wizard.
// Shows the stages and highlights the active one. Supports dark mode.
// ============================================================================

import type { SectionState } from "../types/application";
import Icon from "./Icon";

interface ProgressStepsProps {
  sections: SectionState[];
  currentIndex: number;
}

export default function ProgressSteps({ sections, currentIndex }: ProgressStepsProps) {
  const total = sections.length;
  const completedCount = sections.filter((s) => s.status === "completed" || s.status === "skipped").length;
  const progressPercent = total > 0 ? Math.round(((completedCount) / total) * 100) : 0;

  return (
    <div className="w-full">
      {/* Top: progress bar + percentage */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          Step {currentIndex + 1} of {total}
        </div>
        <div className="text-xs font-bold text-velo-600 dark:text-velo-400">{progressPercent}% complete</div>
      </div>
      <div className="mb-4 h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
        <div
          className="h-1.5 rounded-full bg-gradient-to-r from-velo-500 to-emerald-500 transition-all duration-500"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Steps */}
      <div className="w-full overflow-x-auto -mx-2 px-2">
        <ol className="flex items-center min-w-max gap-1.5 py-1">
          {sections.map((s, i) => {
            const isCurrent = i === currentIndex;
            const isDone = s.status === "completed" || s.status === "skipped";
            const isLocked = s.status === "locked";

            return (
              <li key={s.key} className="flex items-center gap-1.5">
                <div
                  className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition
                    ${isCurrent
                      ? "bg-velo-500 text-white shadow-sm shadow-velo-500/30"
                      : isDone
                        ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                        : isLocked
                          ? "bg-slate-50 text-slate-400 dark:bg-slate-900 dark:text-slate-600"
                          : "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                    }`}
                >
                  <span
                    className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold
                      ${isCurrent
                        ? "bg-white/20 text-white"
                        : isDone
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-800 dark:text-emerald-200"
                          : isLocked
                            ? "bg-slate-200 text-slate-400 dark:bg-slate-800 dark:text-slate-600"
                            : "bg-white text-slate-600 dark:bg-slate-700 dark:text-slate-200"
                      }`}
                  >
                    {isDone ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}
                  </span>
                  <span className="hidden sm:inline">{shorten(s.label)}</span>
                </div>
                {i < sections.length - 1 && (
                  <div className={`h-px w-4 ${isDone ? "bg-emerald-300 dark:bg-emerald-700" : "bg-slate-200 dark:bg-slate-700"}`} />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function shorten(label: string): string {
  return label.length > 18 ? label.slice(0, 18) + "…" : label;
}
