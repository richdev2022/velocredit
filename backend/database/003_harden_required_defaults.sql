-- Keep database constraints and application normalization aligned for legacy and newly-created rows.

UPDATE users SET otp_login_enabled = FALSE WHERE otp_login_enabled IS NULL;
ALTER TABLE users ALTER COLUMN otp_login_enabled SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN otp_login_enabled SET NOT NULL;

UPDATE kyc_cases SET category_results = '{}'::jsonb WHERE category_results IS NULL;
ALTER TABLE kyc_cases ALTER COLUMN category_results SET DEFAULT '{}'::jsonb;
ALTER TABLE kyc_cases ALTER COLUMN category_results SET NOT NULL;

UPDATE loan_applications SET stage_statuses = '{}'::jsonb WHERE stage_statuses IS NULL;
UPDATE loan_applications SET stage_rejection_notes = '{}'::jsonb WHERE stage_rejection_notes IS NULL;
ALTER TABLE loan_applications ALTER COLUMN stage_statuses SET DEFAULT '{}'::jsonb;
ALTER TABLE loan_applications ALTER COLUMN stage_statuses SET NOT NULL;
ALTER TABLE loan_applications ALTER COLUMN stage_rejection_notes SET DEFAULT '{}'::jsonb;
ALTER TABLE loan_applications ALTER COLUMN stage_rejection_notes SET NOT NULL;

UPDATE investments SET plan_version = 1 WHERE plan_version IS NULL;
ALTER TABLE investments ALTER COLUMN plan_version SET DEFAULT 1;
ALTER TABLE investments ALTER COLUMN plan_version SET NOT NULL;

UPDATE investor_withdrawals SET retry_count = 0 WHERE retry_count IS NULL;
ALTER TABLE investor_withdrawals ALTER COLUMN retry_count SET DEFAULT 0;
ALTER TABLE investor_withdrawals ALTER COLUMN retry_count SET NOT NULL;

ALTER TABLE payout_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS provider_reference TEXT;

ALTER TABLE disbursements DROP CONSTRAINT IF EXISTS disbursements_loan_id_key;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS application_id TEXT;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS narration TEXT;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS retry_of_id TEXT REFERENCES disbursements(id);
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS disbursements_loan_id_idx ON disbursements (loan_id);

ALTER TABLE admin_ledger_entries ADD CONSTRAINT admin_ledger_entries_loan_id_fkey
  FOREIGN KEY (loan_id) REFERENCES loans(id) NOT VALID;
