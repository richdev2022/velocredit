-- 007_disbursement_idempotency.sql
-- Restore a unique constraint on disbursements.loan_id and add an
-- idempotency_key column with a partial unique index, mirroring the
-- investor_withdrawals pattern from 006_withdrawal_idempotency.sql.
--
-- Background: migration 003 dropped the UNIQUE constraint on
-- disbursements.loan_id to allow retry rows. That opened a race condition
-- where two concurrent admin "Disburse" clicks could create two
-- disbursement rows and call Flutterwave twice for the same loan.
-- We now use a partial unique index that only enforces uniqueness for
-- rows that are NOT in a FAILED state — retries remain allowed once the
-- previous attempt has failed, but two concurrent PROCESSING/PENDING/
-- SUCCESSFUL rows for the same loan are rejected at the DB level.

ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE disbursements ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;

-- One active (non-failed) disbursement per loan.
CREATE UNIQUE INDEX IF NOT EXISTS disbursements_loan_id_active_idx
  ON disbursements (loan_id)
  WHERE status NOT IN ('FAILED', 'CANCELLED');

-- Optional client-provided idempotency key (for partner integrations).
CREATE UNIQUE INDEX IF NOT EXISTS disbursements_idempotency_key_idx
  ON disbursements (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
