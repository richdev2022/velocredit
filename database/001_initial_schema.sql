-- Velo Finance Platform — Initial PostgreSQL Schema
-- Nigeria-only fintech: Investor, Borrower, Admin
-- Currency: NGN (kobo minor units for integer math where appropriate)

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS permissions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id TEXT NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  kyc_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  user_agent TEXT,
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS otp_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  challenge_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivery_channel TEXT NOT NULL DEFAULT 'SMS'
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investor_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE,
  occupation TEXT,
  source_of_funds TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS borrower_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  date_of_birth DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admin_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  staff_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  state TEXT,
  lga TEXT,
  country TEXT NOT NULL DEFAULT 'NG',
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS kyc_cases (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  bvn TEXT,
  nin TEXT,
  bvn_verified_at TIMESTAMPTZ,
  nin_verified_at TIMESTAMPTZ,
  provider_request_id TEXT,
  provider_raw JSONB,
  submitted_at TIMESTAMPTZ,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS identity_verification_events (
  id TEXT PRIMARY KEY,
  kyc_case_id TEXT NOT NULL REFERENCES kyc_cases(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  provider_reference TEXT,
  status TEXT NOT NULL,
  match_score NUMERIC,
  raw_response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_file_id TEXT NOT NULL,
  file_name TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payout_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  bank_name TEXT,
  bank_code TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT,
  account_name_enquiry_result TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_VERIFICATION',
  verified_at TIMESTAMPTZ,
  verification_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS loan_products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  min_amount_naira NUMERIC NOT NULL,
  max_amount_naira NUMERIC NOT NULL,
  default_tenure_days INTEGER,
  interest_rate_percent NUMERIC NOT NULL,
  interest_type TEXT NOT NULL DEFAULT 'SIMPLE_FLAT',
  processing_fee_percent NUMERIC NOT NULL DEFAULT 0,
  late_fee_percent NUMERIC NOT NULL DEFAULT 0,
  late_fee_type TEXT NOT NULL DEFAULT 'ONE_TIME',
  grace_period_days INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loan_applications (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE,
  borrower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  applicant_type TEXT NOT NULL DEFAULT 'PERSONAL',
  customer_snapshot JSONB,
  credit_report_snapshot JSONB,
  amount_naira NUMERIC,
  tenure_days INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  system_decision JSONB,
  manual_decision TEXT,
  manual_note TEXT,
  disbursement_institution TEXT NOT NULL DEFAULT 'VELO',
  disbursement_account JSONB,
  signed_agreement_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES loan_applications(id) ON DELETE CASCADE,
  borrower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal_naira NUMERIC NOT NULL,
  total_interest_naira NUMERIC NOT NULL,
  total_fees_naira NUMERIC NOT NULL DEFAULT 0,
  total_repayment_naira NUMERIC NOT NULL,
  outstanding_naira NUMERIC NOT NULL,
  tenure_days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'DISBURSEMENT_PENDING',
  disbursed_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  provider_transfer JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loan_schedules (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  installment_number INTEGER NOT NULL,
  due_date DATE NOT NULL,
  principal_naira NUMERIC NOT NULL,
  interest_naira NUMERIC NOT NULL,
  fees_naira NUMERIC NOT NULL DEFAULT 0,
  total_due_naira NUMERIC NOT NULL,
  total_paid_naira NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investment_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
  min_amount_naira NUMERIC NOT NULL,
  max_amount_naira NUMERIC NOT NULL,
  tenure_days INTEGER NOT NULL,
  annual_rate_percent NUMERIC NOT NULL,
  rate_type TEXT NOT NULL DEFAULT 'ANNUALIZED',
  early_liquidity_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  early_liquidity_fee_percent NUMERIC NOT NULL DEFAULT 0,
  gateway_fee_percent NUMERIC NOT NULL DEFAULT 0,
  forfeit_interest_on_early_exit BOOLEAN NOT NULL DEFAULT FALSE,
  capacity_naira NUMERIC,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  allow_new_investments_after_close BOOLEAN NOT NULL DEFAULT FALSE,
  version INTEGER NOT NULL DEFAULT 1,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS investments (
  id TEXT PRIMARY KEY,
  investor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES investment_plans(id),
  plan_version INTEGER NOT NULL DEFAULT 1,
  plan_snapshot JSONB,
  amount_naira NUMERIC NOT NULL,
  expected_earnings_naira NUMERIC NOT NULL,
  tenure_days INTEGER NOT NULL,
  annual_rate_percent NUMERIC NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  matures_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  liquidity_requested_at TIMESTAMPTZ,
  liquidity_approved_at TIMESTAMPTZ,
  liquidity_fee_naira NUMERIC,
  net_payout_naira NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  available_minor BIGINT NOT NULL DEFAULT 0,
  held_minor BIGINT NOT NULL DEFAULT 0,
  pending_deposit_minor BIGINT NOT NULL DEFAULT 0,
  pending_payout_minor BIGINT NOT NULL DEFAULT 0,
  total_credited_minor BIGINT NOT NULL DEFAULT 0,
  total_debited_minor BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  entry_type TEXT NOT NULL,
  reference_id TEXT,
  amount_minor BIGINT NOT NULL,
  direction TEXT NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  held_after_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  wallet_id TEXT REFERENCES wallets(id),
  type TEXT NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  provider TEXT,
  provider_reference TEXT,
  tx_ref TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  wallet_id TEXT REFERENCES wallets(id),
  intent_type TEXT NOT NULL,
  amount_naira NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  provider TEXT,
  tx_ref TEXT,
  provider_reference TEXT,
  redirect_url TEXT,
  checkout_link TEXT,
  raw_response JSONB,
  verified_at TIMESTAMPTZ,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repayments (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  borrower_id TEXT NOT NULL REFERENCES users(id),
  amount_naira NUMERIC NOT NULL,
  principal_naira NUMERIC,
  interest_naira NUMERIC,
  late_fee_naira NUMERIC DEFAULT 0,
  other_fees_naira NUMERIC DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  provider TEXT,
  tx_ref TEXT,
  provider_reference TEXT,
  channel TEXT,
  on_time BOOLEAN,
  raw_response JSONB,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS repayment_allocations (
  id TEXT PRIMARY KEY,
  repayment_id TEXT NOT NULL REFERENCES repayments(id) ON DELETE CASCADE,
  schedule_id TEXT REFERENCES loan_schedules(id),
  principal_naira NUMERIC NOT NULL DEFAULT 0,
  interest_naira NUMERIC NOT NULL DEFAULT 0,
  fees_naira NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payouts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  investment_id TEXT REFERENCES investments(id),
  payout_type TEXT NOT NULL DEFAULT 'INVESTMENT_MATURITY',
  principal_naira NUMERIC,
  earnings_naira NUMERIC,
  fees_naira NUMERIC DEFAULT 0,
  amount_naira NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  payout_account_snapshot JSONB,
  provider_transfer JSONB,
  provider_reference TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  error TEXT,
  idempotency_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disbursements (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL UNIQUE REFERENCES loans(id) ON DELETE CASCADE,
  borrower_id TEXT NOT NULL REFERENCES users(id),
  amount_naira NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  status TEXT NOT NULL,
  disbursement_account_snapshot JSONB,
  provider_transfer JSONB,
  provider_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_history_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  loan_id TEXT REFERENCES loans(id),
  repayment_id TEXT REFERENCES repayments(id),
  event_type TEXT NOT NULL,
  detail TEXT,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  factors JSONB,
  rules_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  consent_granted_at TIMESTAMPTZ,
  requested_at TIMESTAMPTZ,
  report_reference TEXT,
  status TEXT NOT NULL,
  score NUMERIC,
  normalized_fields JSONB,
  redacted_raw JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  withdrawn_at TIMESTAMPTZ,
  metadata JSONB
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  template TEXT,
  template_version TEXT,
  kind TEXT,
  subject TEXT,
  content TEXT,
  recipient_masked TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  provider_message_id TEXT,
  provider_status TEXT,
  idempotency_key TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS provider_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event JSONB,
  processed BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ,
  UNIQUE (provider, event_key)
);

CREATE TABLE IF NOT EXISTS admin_actions (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  action_type TEXT NOT NULL,
  target_entity_type TEXT,
  target_entity_id TEXT,
  before_state JSONB,
  after_state JSONB,
  note TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  metadata JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  item_type TEXT NOT NULL,
  internal_reference TEXT,
  provider_reference TEXT,
  expected_amount_naira NUMERIC,
  provider_amount_naira NUMERIC,
  status TEXT NOT NULL DEFAULT 'OPEN',
  note TEXT,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS system_settings (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  value JSONB,
  updated_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fee_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  config JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  effective_to TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  records_processed INTEGER DEFAULT 0,
  error TEXT,
  metadata JSONB
);

-- Seed roles
INSERT INTO roles (id, name, description) VALUES
  ('INVESTOR', 'INVESTOR', 'Investor — funds wallet and locks investments'),
  ('BORROWER', 'BORROWER', 'Borrower — applies for and repays loans'),
  ('ADMIN', 'ADMIN', 'Administrator — full operational access')
ON CONFLICT (name) DO NOTHING;

INSERT INTO permissions (id, name, description) VALUES
  ('users.read', 'users.read', 'View user records'),
  ('kyc.review', 'kyc.review', 'Review and decide KYC cases'),
  ('loans.review', 'loans.review', 'Review and decide loan applications'),
  ('loans.disburse', 'loans.disburse', 'Initiate loan disbursements'),
  ('investments.manage', 'investments.manage', 'Create and manage investment plans'),
  ('payments.reconcile', 'payments.reconcile', 'View and resolve reconciliation items'),
  ('payouts.approve', 'payouts.approve', 'Approve and retry payouts'),
  ('reports.export', 'reports.export', 'Export operational reports'),
  ('settings.manage', 'settings.manage', 'Manage system settings and configuration')
ON CONFLICT (name) DO NOTHING;

-- Give ADMIN all permissions
INSERT INTO role_permissions (role_id, permission_id)
SELECT 'ADMIN', id FROM permissions
ON CONFLICT DO NOTHING;
