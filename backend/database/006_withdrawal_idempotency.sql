ALTER TABLE investor_withdrawals ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS investor_withdrawals_idempotency_key_idx
  ON investor_withdrawals (investor_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
