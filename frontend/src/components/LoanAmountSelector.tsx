import { useEffect, useState } from "react";
import { formatNaira, getSuggestedLoanAmounts } from "../utils/loanCalculator";

interface Props {
  value: number;
  onChange: (v: number) => void;
  error?: string;
  min: number;
  max: number;
}

/**
 * Loan amount input — FREE TYPING CONTRACT.
 *
 * The user can type ANY amount (or clear the field and retype) without the
 * input fighting back: no clamping, no live min/max errors mid-keystroke, no
 * disabled Continue button. The backend-provided minimum/maximum are shown as
 * helper text and enforced at SUBMIT time by the form's zod schema, which
 * rejects an out-of-range amount with a clear message.
 *
 * A soft, non-blocking notice appears on blur when the typed amount falls
 * outside the product range so the user is never surprised by the rejection.
 */
export default function LoanAmountSelector({ value, onChange, error, min, max }: Props) {
  const step = (max - min) <= 1_000_000 ? 5_000 : 10_000;
  const [input, setInput] = useState(value ? String(value) : "");
  const [blurred, setBlurred] = useState(false);

  useEffect(() => {
    const next = value ? String(value) : "";
    setInput((current) => (current.replace(/[^0-9]/g, "") === next ? current : next));
  }, [value]);

  const quickAmounts = getSuggestedLoanAmounts(min, max);
  const numeric = input.replace(/[^0-9]/g, "");
  const typed = numeric ? Number(numeric) : null;
  const outOfRange = typed !== null && (typed < min || typed > max);
  // Soft hint AFTER blur only — informational, never blocks typing or Continue.
  const softHint = blurred && outOfRange && !error
    ? typed! < min
      ? `Heads up: the minimum for this product is ${formatNaira(min)}.`
      : `Heads up: the maximum for this product is ${formatNaira(max)}.`
    : "";

  function inputChanged(raw: string) {
    const cleaned = raw.replace(/[^0-9]/g, "");
    setInput(cleaned);
    // Propagate the raw typed value (even if out of range) so the summary and
    // validation always reflect exactly what the customer typed.
    onChange(cleaned ? Number(cleaned) : 0);
  }

  function pick(n: number) {
    setInput(String(n));
    setBlurred(false);
    onChange(n);
  }

  return (
    <div className="space-y-4">
      <div>
        <label className="velo-label text-velo-900 dark:text-white" htmlFor="loan-amount-input">
          Loan Amount <span className="text-red-500">*</span>
        </label>
        <div className="relative">
          <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500 dark:text-slate-400 font-medium pointer-events-none">₦</span>
          <input
            id="loan-amount-input"
            type="text"
            inputMode="numeric"
            value={input ? Number(input).toLocaleString("en-NG") : ""}
            onChange={(e) => inputChanged(e.target.value)}
            onBlur={() => setBlurred(true)}
            className={`velo-input !pl-12 text-lg font-semibold ${error ? "velo-input-error" : ""}`}
            placeholder="Enter amount"
            autoComplete="off"
          />
        </div>
        {error ? (
          <p className="velo-error-text">{error}</p>
        ) : softHint ? (
          <p className="mt-1 text-xs font-medium text-amber-600 dark:text-amber-400">{softHint}</p>
        ) : (
          <p className="velo-helper">Type any amount — it must be between {formatNaira(min)} and {formatNaira(max)}.</p>
        )}
      </div>
      <div>
        <input
          type="range"
          className="velo-range w-full"
          min={min}
          max={max}
          step={step}
          value={Math.min(max, Math.max(min, value || min))}
          onChange={(e) => pick(Number(e.target.value))}
          aria-label="Loan amount slider"
        />
        <div className="mt-2 flex justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{formatNaira(min)}</span>
          <span>{formatNaira(max)}</span>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pt-1">
        {quickAmounts.map((amt) => (
          <button
            key={amt}
            type="button"
            onClick={() => pick(amt)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200
              ${value === amt
                ? "bg-velo-500 text-white border-velo-500 shadow-sm shadow-velo-500/30"
                : "bg-white text-velo-700 border-slate-200 hover:bg-velo-50 hover:border-velo-300 dark:bg-slate-800 dark:text-velo-300 dark:border-slate-700 dark:hover:bg-slate-700 dark:hover:border-velo-700"
              }`}
          >
            {formatNaira(amt)}
          </button>
        ))}
      </div>
    </div>
  );
}
