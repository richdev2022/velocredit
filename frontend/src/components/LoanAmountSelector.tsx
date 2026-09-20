import { useEffect, useState } from "react";
import { formatNaira, getSuggestedLoanAmounts } from "../utils/loanCalculator";

interface Props {
  value: number;
  onChange: (v: number) => void;
  error?: string;
  min: number;
  max: number;
}

export default function LoanAmountSelector({ value, onChange, error, min, max }: Props) {
  const step = (max - min) <= 1_000_000 ? 5_000 : 10_000;
  const [input, setInput] = useState(value ? String(value) : "");
  const [localError, setLocalError] = useState("");

  useEffect(() => {
    const next = value ? String(value) : "";
    setInput((current) => (current.replace(/[^0-9]/g, "") === next ? current : next));
  }, [value]);

  const quickAmounts = getSuggestedLoanAmounts(min, max);

  function inputChanged(raw: string) {
    const numeric = raw.replace(/[^0-9]/g, "");
    setInput(numeric);
    if (!numeric) {
      setLocalError("Enter a loan amount.");
      return;
    }
    const n = Number(numeric);
    if (n < min) setLocalError(`Minimum loan amount is ${formatNaira(min)}.`);
    else if (n > max) setLocalError(`Maximum loan amount is ${formatNaira(max)}.`);
    else setLocalError("");
    onChange(n);
  }

  function pick(n: number) {
    setInput(String(n));
    setLocalError("");
    onChange(n);
  }

  const shownError = localError || error;

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
            className={`velo-input !pl-12 text-lg font-semibold ${shownError ? "velo-input-error" : ""}`}
            placeholder="Enter amount"
            autoComplete="off"
          />
        </div>
        {shownError ? (
          <p className="velo-error-text">{shownError}</p>
        ) : (
          <p className="velo-helper">Minimum: {formatNaira(min)} • Maximum: {formatNaira(max)}</p>
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
