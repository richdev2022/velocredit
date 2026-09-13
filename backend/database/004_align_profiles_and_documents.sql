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
