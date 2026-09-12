// ============================================================================
// src/components/ProgressSteps.tsx
// Horizontal step indicator shown at the top of the wizard.
// Shows the 7 stages (1-7) and highlights the active one.
// ============================================================================

import type { SectionState } from "../types/application";
import Icon from "./Icon";

interface ProgressStepsProps {
  sections: SectionState[];
  currentIndex: number;
}

export default function ProgressSteps({ sections, currentIndex }: ProgressStepsProps) {
  return (
    <div className="w-full overflow-x-auto -mx-2 px-2">
      <ol className="flex items-center min-w-max gap-1.5 py-2">
        {sections.map((s, i) => {
          const isCurrent = i === currentIndex;
          const isDone = s.status === "completed" || s.status === "skipped";
          const isLocked = s.status === "locked";

          return (
            <li key={s.key} className="flex items-center gap-1.5">
              <div
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition
                  ${isCurrent
                    ? "bg-velo-500 text-white shadow-sm"
                    : isDone
                      ? "bg-emerald-50 text-emerald-700"
                      : isLocked
                        ? "bg-slate-50 text-slate-400"
                        : "bg-slate-100 text-slate-600"
                  }`}
              >
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold
                    ${isCurrent
                      ? "bg-white/20 text-white"
                      : isDone
                        ? "bg-emerald-100 text-emerald-700"
                        : isLocked
                          ? "bg-slate-200 text-slate-400"
                          : "bg-white text-slate-600"
                    }`}
                >
                  {isDone ? <Icon name="check" size={13} strokeWidth={2.5} /> : i + 1}
                </span>
                <span className="hidden sm:inline">{shorten(s.label)}</span>
              </div>
              {i < sections.length - 1 && (
                <div className={`h-px w-4 ${isDone ? "bg-emerald-300" : "bg-slate-200"}`} />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function shorten(label: string): string {
  return label.length > 18 ? label.slice(0, 18) + "…" : label;
}
