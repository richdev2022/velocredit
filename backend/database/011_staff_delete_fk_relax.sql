-- 011_staff_delete_fk_relax.sql
--
-- Staff DELETE used to fail with a foreign-key violation (23503) whenever the
-- staff member had ever been recorded as an ACTOR in audit/review tables:
--   admin_actions.admin_user_id, audit_logs.user_id, kyc_cases.reviewed_by,
--   documents.reviewed_by, reconciliation_items.resolved_by,
--   system_settings.updated_by, account_change_requests.reviewed_by.
-- Those columns are historical attribution, not ownership, so they must not
-- block account deletion. Relax them to ON DELETE SET NULL: the audit rows are
-- preserved untouched, only the actor link is cleared when the account goes.
-- Financial tables (ledger_entries, wallet_transactions, payment_intents,
-- repayments, payouts, disbursements) intentionally KEEP their strict FKs —
-- an account holding money movement must not be hard-deleted.

ALTER TABLE admin_actions DROP CONSTRAINT IF EXISTS admin_actions_admin_user_id_fkey;
ALTER TABLE admin_actions ALTER COLUMN admin_user_id DROP NOT NULL;
ALTER TABLE admin_actions ADD CONSTRAINT admin_actions_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_user_id_fkey;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE kyc_cases DROP CONSTRAINT IF EXISTS kyc_cases_reviewed_by_fkey;
ALTER TABLE kyc_cases ADD CONSTRAINT kyc_cases_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_reviewed_by_fkey;
ALTER TABLE documents ADD CONSTRAINT documents_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE reconciliation_items DROP CONSTRAINT IF EXISTS reconciliation_items_resolved_by_fkey;
ALTER TABLE reconciliation_items ADD CONSTRAINT reconciliation_items_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_updated_by_fkey;
ALTER TABLE system_settings ADD CONSTRAINT system_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE account_change_requests DROP CONSTRAINT IF EXISTS account_change_requests_reviewed_by_fkey;
ALTER TABLE account_change_requests ADD CONSTRAINT account_change_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
