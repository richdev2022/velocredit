// ============================================================================
// src/components/SelectInput.tsx
// Reusable select dropdown — wraps react-hook-form's register().
// ============================================================================

import { forwardRef } from "react";
import type { SelectHTMLAttributes } from "react";

interface Option {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectInputProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helper?: string;
  error?: string;
  options: Option[];
  placeholder?: string;
  required?: boolean;
}

const SelectInput = forwardRef<HTMLSelectElement, SelectInputProps>(function SelectInput(
  { label, helper, error, options, placeholder, required, className = "", id, ...rest },
  ref
) {
  const inputId = id || rest.name || Math.random().toString(36).slice(2, 9);
  const describedBy = error ? `${inputId}-error` : helper ? `${inputId}-helper` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="velo-label">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <select
          id={inputId}
          ref={ref}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`velo-input appearance-none pr-10 ${error ? "velo-input-error" : ""} ${className}`}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M6 8l4 4 4-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </span>
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="velo-error-text">{error}</p>
      ) : helper ? (
        <p id={`${inputId}-helper`} className="velo-helper">{helper}</p>
      ) : null}
    </div>
  );
});

export default SelectInput;
