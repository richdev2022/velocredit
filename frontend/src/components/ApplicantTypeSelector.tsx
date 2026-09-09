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
    icon: React.ReactNode;
  }[] = [
    {
      type: "PERSONAL",
      title: "Personal Loan",
      description: "For personal financial needs.",
      icon: <PersonalIcon />,
    },
    {
      type: "BUSINESS",
      title: "Business Loan",
      description: "For working capital, business growth and other business needs.",
      icon: <BusinessIcon />,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {cards.map((card) => {
        const selected = value === card.type;
        return (
          <button
            key={card.type}
            type="button"
            onClick={() => onChange(card.type)}
            className={`group relative text-left rounded-2xl p-5 sm:p-6 border-2 transition shadow-sm hover:shadow-md
              ${selected
                ? "border-velo-500 bg-velo-50/50 ring-2 ring-velo-200"
                : "border-slate-200 bg-white hover:border-velo-300"
              }`}
          >
            <div className="flex items-start justify-between mb-4">
              <span
                className={`inline-flex h-12 w-12 items-center justify-center rounded-xl transition
                  ${selected ? "bg-velo-500 text-white" : "bg-slate-100 text-slate-600 group-hover:bg-velo-100 group-hover:text-velo-700"}
                `}
              >
                {card.icon}
              </span>
              <span
                className={`inline-flex h-5 w-5 items-center justify-center rounded-full border-2 transition
                  ${selected ? "border-velo-500 bg-velo-500 text-white" : "border-slate-300 bg-white text-transparent"}
                `}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                  <path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </span>
            </div>
            <div className="text-base font-semibold text-velo-900">{card.title}</div>
            <p className="text-sm text-slate-500 mt-1 leading-relaxed">{card.description}</p>
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
