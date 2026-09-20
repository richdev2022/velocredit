// ============================================================================
// src/components/ApplicantTypeSelector.tsx
// Two large cards: Personal Loan vs Business Loan.
// Used on the very first screen of the application.
// ============================================================================

import type { ApplicantType } from "../types/application";

interface ApplicantTypeSelectorProps {
  value: ApplicantType | null;
  onChange: (t: ApplicantType) => void;
}

export default function ApplicantTypeSelector({ value, onChange }: ApplicantTypeSelectorProps) {
  const cards: {
    type: ApplicantType;
    title: string;
    description: string;
    features: string[];
    icon: React.ReactNode;
    accent: string;
  }[] = [
    {
      type: "PERSONAL",
      title: "Personal Loan",
      description: "For personal financial needs — school fees, rent, medical, emergencies, and more.",
      features: ["Up to ₦30M", "30–180 day tenures", "Minimal documentation", "Fast disbursement"],
      icon: <PersonalIcon />,
      accent: "velo",
    },
    {
      type: "BUSINESS",
      title: "Business Loan",
      description: "For working capital, inventory, equipment, expansion, and other business needs.",
      features: ["Up to ₦30M", "30–180 day tenures", "Business registration required", "Dedicated rep signatory"],
      icon: <BusinessIcon />,
      accent: "emerald",
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-5">
      {cards.map((card) => {
        const selected = value === card.type;
        const accent = card.accent;
        return (
          <button
            key={card.type}
            type="button"
            onClick={() => onChange(card.type)}
            className={`group relative text-left rounded-2xl p-5 sm:p-6 border-2 transition-all duration-200 shadow-sm hover:shadow-lg
              ${selected
                ? accent === "velo"
                  ? "border-velo-500 bg-velo-50/50 dark:bg-velo-900/20 ring-2 ring-velo-200 dark:ring-velo-800"
                  : "border-emerald-500 bg-emerald-50/50 dark:bg-emerald-900/20 ring-2 ring-emerald-200 dark:ring-emerald-800"
                : "border-slate-200 bg-white dark:bg-slate-900 dark:border-slate-700 hover:border-velo-300 dark:hover:border-velo-700"
              }`}
          >
            <div className="flex items-start justify-between mb-4">
              <span
                className={`inline-flex h-12 w-12 items-center justify-center rounded-xl transition
                  ${selected
                    ? accent === "velo"
                      ? "bg-velo-500 text-white shadow-md shadow-velo-500/30"
                      : "bg-emerald-500 text-white shadow-md shadow-emerald-500/30"
                    : "bg-slate-100 text-slate-600 group-hover:bg-velo-100 group-hover:text-velo-700 dark:bg-slate-800 dark:text-slate-300 dark:group-hover:bg-velo-900/40 dark:group-hover:text-velo-300"
                  }`}
              >
                {card.icon}
              </span>
              <span
                className={`inline-flex h-6 w-6 items-center justify-center rounded-full border-2 transition
                  ${selected
                    ? accent === "velo"
                      ? "border-velo-500 bg-velo-500 text-white"
                      : "border-emerald-500 bg-emerald-500 text-white"
                    : "border-slate-300 bg-white text-transparent dark:bg-slate-900 dark:border-slate-600"
                  }`}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </div>
            <div className="text-base font-bold text-velo-900 dark:text-white">{card.title}</div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{card.description}</p>
            <ul className="mt-4 space-y-1.5">
              {card.features.map((feature) => (
                <li key={feature} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={selected ? (accent === "velo" ? "text-velo-500" : "text-emerald-500") : "text-slate-400 dark:text-slate-500"}>
                    <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {feature}
                </li>
              ))}
            </ul>
          </button>
        );
      })}
    </div>
  );
}

function PersonalIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2"/>
      <path d="M4 20c0-3 3.5-5 8-5s8 2 8 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

function BusinessIcon() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M3 21V9l9-5 9 5v12" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
      <path d="M7 21v-6h4v6M14 21v-6h3v6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/>
    </svg>
  );
}
