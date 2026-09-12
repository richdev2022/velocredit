/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_BRAND_LOGO_URL?: string;
  readonly VITE_LOAN_MIN_AMOUNT: string;
  readonly VITE_LOAN_MAX_AMOUNT: string;
  readonly VITE_LOAN_DEFAULT_AMOUNT: string;
  readonly VITE_LOAN_TENURES: string;
  readonly VITE_INTEREST_TYPE: string;
  readonly VITE_INTEREST_VALUE: string;
  readonly VITE_PERSONAL_INTEREST_TYPE?: string;
  readonly VITE_PERSONAL_INTEREST_VALUE?: string;
  readonly VITE_BUSINESS_INTEREST_TYPE?: string;
  readonly VITE_BUSINESS_INTEREST_VALUE?: string;
  readonly VITE_SERVICE_FEE_TYPE: string;
  readonly VITE_SERVICE_FEE_VALUE: string;
  readonly VITE_PROCESSING_FEE_TYPE: string;
  readonly VITE_PROCESSING_FEE_VALUE: string;
  readonly VITE_LATE_FEE_TYPE: string;
  readonly VITE_LATE_FEE_VALUE: string;
  readonly VITE_INCLUDE_LATE_FEE_UPFRONT: string;
  readonly VITE_COMPANY_NAME: string;
  readonly VITE_COMPANY_WEBSITE: string;
  readonly VITE_PREMBLY_WIDGET_ID?: string;
  readonly VITE_PREMBLY_WIDGET_KEY?: string;
  readonly VITE_PREMBLY_WIDGET_IS_TEST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
