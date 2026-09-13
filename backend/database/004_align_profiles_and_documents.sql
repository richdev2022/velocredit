ALTER TABLE addresses ADD COLUMN IF NOT EXISTS address_type TEXT;

ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_name TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_registration_number TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_type TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_industry TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS years_in_business INTEGER;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS employment_status TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS employer_name TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS monthly_income_naira NUMERIC;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS monthly_expenses_naira NUMERIC;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_revenue_naira NUMERIC;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS business_expenses_naira NUMERIC;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS existing_loan_obligations TEXT;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS expected_repayment_source TEXT;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_slot TEXT;
CREATE INDEX IF NOT EXISTS documents_application_id_idx ON documents (application_id);
CREATE UNIQUE INDEX IF NOT EXISTS application_drafts_user_application_idx ON application_drafts (user_id, application_id);

CREATE TABLE IF NOT EXISTS env (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE admin_profiles ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS outstanding_principal_naira NUMERIC;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS outstanding_interest_naira NUMERIC;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS admin_note TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS document_slot TEXT;
ALTER TABLE payout_accounts DROP CONSTRAINT IF EXISTS payout_accounts_user_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS payout_accounts_one_default_idx ON payout_accounts (user_id) WHERE is_default = TRUE;
