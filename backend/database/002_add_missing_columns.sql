-- Additive schema migration: columns/tables already present in store.ts TypeScript interfaces
-- but missing from 001_initial_schema.sql. All statements are idempotent (IF NOT EXISTS / IF NOT EXISTS on ADD COLUMN).
-- Do NOT drop or rename anything. Do NOT change column types. Only add.

-- ============================================================
-- 1. users table: add fields that exist on the TS User interface
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_otp_channel TEXT DEFAULT 'EMAIL';
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_login_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS otp_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS residential_address JSONB;
ALTER TABLE users ADD COLUMN IF NOT EXISTS occupation TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS source_of_funds TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- 2. kyc_cases table: add checklist / category results / liveness / verified details columns
-- ============================================================
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS category_results JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS liveness_verified_at TIMESTAMPTZ;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS verified_details JSONB;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS identity_photo TEXT;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS selfie_image_data TEXT;
ALTER TABLE kyc_cases ADD COLUMN IF NOT EXISTS checklist JSONB NOT NULL DEFAULT '{"bvn":false,"nin":false,"proofOfAddress":false,"passport":false,"signature":false,"liveness":false}'::jsonb;

-- ============================================================
-- 3. loan_applications table: add stage statuses (per TS LoanApplication.stageStatuses / stageRejectionNotes)
-- ============================================================
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS stage_statuses JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS stage_rejection_notes JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS documents JSONB;

-- ============================================================
-- 4. investments table: relax plan_id NOT NULL because TS Investment.planId is optional
-- ============================================================
ALTER TABLE investments ALTER COLUMN plan_id DROP NOT NULL;

-- ============================================================
-- 5. wallet_transactions: add verified_at (present in TS WalletTransaction.verifiedAt)
--    plus provider_transaction_id even though we'll also accept it in metadata
-- ============================================================
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS provider_transaction_id TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS mimetype TEXT;
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

-- ============================================================
-- 6. documents: add note / additional meta that may come from uploads
-- ============================================================
ALTER TABLE documents ADD COLUMN IF NOT EXISTS note TEXT;

-- ============================================================
-- 7. investor_profiles / borrower_profiles already have date_of_birth;
--    add extra JSON metadata column for seed provenance
-- ============================================================
ALTER TABLE investor_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE borrower_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE admin_profiles ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- 8. Missing tables for TS StoreKeys that don't yet have DDL
--    All use CREATE TABLE IF NOT EXISTS with minimal correct schema.
-- ============================================================

-- 8a. investor_withdrawals (matches TS InvestorWithdrawal)
CREATE TABLE IF NOT EXISTS investor_withdrawals (
  id TEXT PRIMARY KEY,
  investor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_naira NUMERIC NOT NULL,
  fee_naira NUMERIC NOT NULL DEFAULT 0,
  net_naira NUMERIC NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  bank_code TEXT NOT NULL,
  bank_name TEXT,
  account_number TEXT NOT NULL,
  account_name TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  narration TEXT,
  provider_transfer JSONB,
  provider_reference TEXT,
  error TEXT,
  processed_at TIMESTAMPTZ,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8b. account_change_requests (matches TS AccountChangeRequest)
CREATE TABLE IF NOT EXISTS account_change_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  existing_snapshot JSONB,
  new_snapshot JSONB NOT NULL,
  reason TEXT,
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8c. disbursement_accounts (separate from payout_accounts because TS has two distinct types)
CREATE TABLE IF NOT EXISTS disbursement_accounts (
  id TEXT PRIMARY KEY,
  borrower_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  bank_name TEXT,
  bank_code TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT,
  account_name_enquiry_result TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  verified_at TIMESTAMPTZ,
  verification_reference TEXT,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8d. application_drafts (matches TS ApplicationDraft for the /api/v1/borrower/application-draft endpoint)
CREATE TABLE IF NOT EXISTS application_drafts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL UNIQUE,
  applicant_type TEXT NOT NULL DEFAULT 'PERSONAL',
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_section_index INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8e. admin_ledger_entries (matches TS AdminLedgerEntry — currently adminLedger array is in memory only)
CREATE TABLE IF NOT EXISTS admin_ledger_entries (
  id TEXT PRIMARY KEY,
  entry_type TEXT NOT NULL,
  reference_id TEXT,
  investor_id TEXT REFERENCES users(id),
  borrower_id TEXT REFERENCES users(id),
  loan_id TEXT,
  amount_minor BIGINT NOT NULL,
  direction TEXT NOT NULL,
  balance_after_minor BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'NGN',
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8f. sessions — TS sessions exist; ensure sessions table has all required (already does — just check/add revoked_at was there)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
