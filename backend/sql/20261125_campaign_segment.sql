-- Campaign audience segment (key from automations.js SEGMENTS; NULL = all).
-- Additive only: no data is changed or removed.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS segment TEXT;
