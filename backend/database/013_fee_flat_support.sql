-- 013_fee_flat_support.sql
-- Every configurable fee / rate now supports BOTH a percentage basis and a
-- flat (fixed naira) basis. Existing rows keep their legacy percent values —
-- the new *_basis columns default to PERCENTAGE semantics when NULL.

ALTER TABLE loan_products ADD COLUMN interest_basis TEXT;
ALTER TABLE loan_products ADD COLUMN interest_flat_naira NUMERIC;
ALTER TABLE loan_products ADD COLUMN processing_fee_basis TEXT;
ALTER TABLE loan_products ADD COLUMN processing_fee_flat_naira NUMERIC;
ALTER TABLE loan_products ADD COLUMN service_fee_basis TEXT;
ALTER TABLE loan_products ADD COLUMN service_fee_flat_naira NUMERIC;
ALTER TABLE loan_products ADD COLUMN late_fee_basis TEXT;
ALTER TABLE loan_products ADD COLUMN late_fee_flat_naira NUMERIC;

ALTER TABLE investment_plans ADD COLUMN earnings_basis TEXT;
ALTER TABLE investment_plans ADD COLUMN earnings_flat_naira NUMERIC;
ALTER TABLE investment_plans ADD COLUMN early_liquidity_fee_basis TEXT;
ALTER TABLE investment_plans ADD COLUMN early_liquidity_fee_flat_naira NUMERIC;
ALTER TABLE investment_plans ADD COLUMN gateway_fee_basis TEXT;
ALTER TABLE investment_plans ADD COLUMN gateway_fee_flat_naira NUMERIC;
