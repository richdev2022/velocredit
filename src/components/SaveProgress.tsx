// ============================================================================
// src/components/SaveProgress.tsx
// Small status pill that shows the current save state:
//   "Saving…" → "Saved" → "Saved 2 mins ago"
// Used at the top of every section.
// ============================================================================

import { useEffect, useState } from "react";

export type SaveState = "idle" | "saving" | "saved" | "error";

interface SaveProgressProps {
  state: SaveState;
  lastSavedAt?: string | null;
}

export default function SaveProgress({ state, lastSavedAt }: SaveProgressProps) {
  const [relativeTime, setRelativeTime] = useState<string>("");

  useEffect(() => {
    if (!lastSavedAt) return;
    const update = () => {
      const diff = Date.now() - new Date(lastSavedAt).getTime();
      const mins = Math.floor(diff / 60000);
      if (mins < 1) setRelativeTime("just now");
      else if (mins < 60) setRelativeTime(`${mins} min${mins === 1 ? "" : "s"} ago`);
      else setRelativeTime(new Date(lastSavedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }));
    };
    update();
    const id = setInterval(update, 30000);
    return () => clearInterval(id);
  }, [lastSavedAt]);

  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-velo-600 font-medium">
        <Spinner /> Saving…
      </span>
    );
  }

  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-600 font-medium">
        <CheckIcon /> Saved{relativeTime ? ` • ${relativeTime}` : ""}
      </span>
    );
  }

  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-600 font-medium">
        <WarnIcon /> Save failed — retrying…
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-slate-400 font-medium">
      <DotIcon /> Auto-save on
    </span>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25"/>
      <path d="M22 12a10 10 0 01-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function WarnIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M12 9v4m0 4h.01M10.3 3.86l-8.4 14.55A2 2 0 003.5 22h17a2 2 0 001.6-3.59L13.7 3.86a2 2 0 00-3.4 0z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
function DotIcon() {
  return <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-400" />;
}
