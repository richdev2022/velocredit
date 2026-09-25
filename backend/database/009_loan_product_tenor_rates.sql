-- ============================================================================
-- 009_loan_product_tenor_rates.sql
-- Per-tenor MONTHLY interest rates (easimoney style).
--
-- A loan product can now pin a dedicated monthly interest rate for EACH tenor
-- in its tenor list. Borrowers picking tenor T are charged
--     interest = principal × monthlyRatePercent/100 × (T / 30)
-- instead of the product-wide base rate math, so e.g. 30/60/90-day tenors can
-- carry 5%/5%/6% monthly rates independently — exactly how easimoney
-- configures loan products.
--
-- The column is additive and backwards compatible:
--   tenor_interest_rates NULL -> the product's base interestRatePercent +
--   interestType math applies for every tenor (previous behaviour, unchanged).
-- ============================================================================

ALTER TABLE loan_products ADD COLUMN IF NOT EXISTS tenor_interest_rates JSONB;
