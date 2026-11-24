-- Scheduled campaigns keep their action buttons until they are sent.
-- Additive only: no data is changed or removed.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS buttons JSONB;
