// ============================================================================
// src/components/FormInput.tsx
// Reusable text input — wraps react-hook-form's register().
// Supports label, helper text, error message, prefix, and suffix.
// ============================================================================

import { forwardRef, useRef } from "react";
import type { InputHTMLAttributes, ReactNode } from "react";

interface FormInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "prefix"> {
  label?: string;
  helper?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  required?: boolean;
}

const FormInput = forwardRef<HTMLInputElement, FormInputProps>(function FormInput(
  { label, helper, error, prefix, suffix, required, className = "", id, ...rest },
  ref
) {
  const autoIdRef = useRef<string | null>(null);
  if (autoIdRef.current === null) {
    autoIdRef.current = `fi_${Math.random().toString(36).slice(2, 9)}`;
  }
  const inputId = id || rest.name || autoIdRef.current;
  const describedBy = error ? `${inputId}-error` : helper ? `${inputId}-helper` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="velo-label">
          {label}{required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        {prefix && (
          <span className="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500 text-sm pointer-events-none">
            {prefix}
          </span>
        )}
        <input
          id={inputId}
          ref={ref}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className={`velo-input ${error ? "velo-input-error" : ""} ${prefix ? "pl-10" : ""} ${suffix ? "pr-12" : ""} ${className}`}
          {...rest}
        />
        {suffix && (
          <span className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 text-sm pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="velo-error-text">{error}</p>
      ) : helper ? (
        <p id={`${inputId}-helper`} className="velo-helper">{helper}</p>
      ) : null}
    </div>
  );
});

export default FormInput;
