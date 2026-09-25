-- ============================================================================
-- 008_loan_product_full_config.sql
-- Loan products become the COMPLETE, single-source-of-truth configuration.
--
-- Before this migration a loan product carried only pricing primitives
-- (amount range, interest, processing/late fee, grace period) while the rest
-- of the terms lived in scattered places:
--   - allowed tenures          -> frontend .env / per-browser localStorage
--   - service fee              -> frontend .env / per-browser localStorage
--   - default application sum  -> frontend .env / per-browser localStorage
--   - collateral rules         -> per-browser localStorage "Loan programs"
--   - Personal/Business flow   -> GUESSED from the product NAME keywords
--
-- Every column here is additive and backwards compatible:
--   program_type NULL  -> legacy keyword classification still applies
--   tenure_days  NULL  -> frontend falls back to its configured tenor list
--   service_fee_percent DEFAULT 0, collateral_enabled DEFAULT TRUE,
--   collateral_required DEFAULT FALSE match the previous env defaults.
-- ============================================================================

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS program_type TEXT;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS tenure_days JSONB;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS service_fee_percent NUMERIC NOT NULL DEFAULT 0;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS default_amount_naira NUMERIC;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS collateral_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS collateral_required BOOLEAN NOT NULL DEFAULT FALSE;
