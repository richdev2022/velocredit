-- ============================================================================
-- 010_staff_rbac.sql
-- Durable Role-Based Access Control (RBAC) for back-office staff.
--
-- Two long-standing bugs are rooted in state that only lived in memory:
--   1. admin/loan-manager accounts created in one serverless instance could
--      404 ("Administrator not found") on DELETE/PATCH served by another
--      instance, because the snapshot persistence is best-effort and the row
--      never reached Postgres.
--   2. A staff member's adminPermissions array was NEVER persisted, so every
--      cold start silently stripped loan managers of their permissions
--      ("No permissions" in the UI, access broken) until they were re-edited.
--
-- This migration makes staff permissions and staff-role assignments first-
-- class, durable columns on users, and registers the 16 back-office
-- permission keys in the existing permissions table so staff roles can
-- reference them through role_permissions.
--
-- Columns are additive and backwards compatible:
--   admin_permissions NULL -> no direct permission override (legacy staff keep
--   working: ADMIN role implies every permission; loan managers fall back to
--   their staff role, else an empty set).
--   staff_role_id NULL -> no staff-role assignment (direct permissions apply).
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_permissions JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role_id TEXT;

-- Register the 16 back-office permission keys. The roles table doubles as the
-- staff-role store: platform roles keep their fixed ids (ADMIN, LOAN_MANAGER,
-- BORROWER, INVESTOR) and staff roles are written with "staff-" prefixed ids,
-- so one table serves both without a second join surface.
INSERT INTO permissions (id, name, description) VALUES
  ('overview', 'Portfolio overview', 'View the executive summary and platform KPIs'),
  ('users', 'User management', 'View and manage borrower and investor accounts'),
  ('investors', 'Investor management', 'View and manage investor portfolios'),
  ('kyc', 'KYC review', 'Review and decide identity verification cases'),
  ('payouts', 'Payout operations', 'Approve, retry and monitor payouts'),
  ('loan_applications', 'Loan applications', 'View and process loan applications'),
  ('loan_decisions', 'Loan decisions', 'Approve, counter-offer or reject loans'),
  ('loan_disbursements', 'Loan disbursements', 'Disburse approved loans and retry failures'),
  ('loan_repayments', 'Loan repayments', 'Monitor and reconcile loan repayments'),
  ('loan_notifications', 'Loan notifications', 'Receive and manage loan alert notifications'),
  ('reconciliation', 'Reconciliation', 'Investigate and resolve payment mismatches'),
  ('audit', 'Audit log', 'Read the back-office audit trail'),
  ('staff', 'Team management', 'Invite and manage back-office staff accounts'),
  ('settings', 'Platform settings', 'Change platform-wide configuration'),
  ('reports', 'Reports', 'Generate and export operational reports'),
  ('investments', 'Investment plans', 'Create and manage investment plans')
ON CONFLICT (id) DO NOTHING;
