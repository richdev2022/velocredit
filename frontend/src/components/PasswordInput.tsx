import { forwardRef, useState } from "react";
import type { InputHTMLAttributes } from "react";

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "suffix"> {
  label?: string;
  helper?: string;
  error?: string;
  required?: boolean;
}

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { label, helper, error, required, className = "", id, placeholder = "••••••••", ...rest },
  ref
) {
  const [show, setShow] = useState(false);
  const inputId = id || rest.name || Math.random().toString(36).slice(2, 9);
  const describedBy = error ? `${inputId}-error` : helper ? `${inputId}-helper` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="velo-label">
          {label}
          {required && <span className="text-red-500 ml-0.5">*</span>}
        </label>
      )}
      <div className="relative">
        <input
          id={inputId}
          ref={ref}
          type={show ? "text" : "password"}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          placeholder={placeholder}
          className={`velo-input pr-12 ${error ? "velo-input-error" : ""} ${className}`}
          {...rest}
        />
        <button
          type="button"
          aria-label={show ? "Hide password" : "Show password"}
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-400 hover:text-velo-600 dark:hover:text-velo-400 transition-colors focus:outline-none"
          tabIndex={-1}
        >
          {show ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M17.94 17.94A10.94 10.94 0 0112 19.5c-6.63 0-10.5-7.5-10.5-7.5a18.5 18.5 0 015.06-5.94M9.9 4.24A10.94 10.94 0 0112 4.5c6.63 0 10.5 7.5 10.5 7.5a18.47 18.47 0 01-3.17 4.19m-2.69-1.41a3 3 0 11-4.24-4.24M1 1l22 22"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M1 12s4.5-7.5 11-7.5S23 12 23 12s-4.5 7.5-11 7.5S1 12 1 12z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          )}
        </button>
      </div>
      {error ? (
        <p id={`${inputId}-error`} className="velo-error-text">
          {error}
        </p>
      ) : helper ? (
        <p id={`${inputId}-helper`} className="velo-helper">
          {helper}
        </p>
      ) : null}
    </div>
  );
});

export default PasswordInput;
