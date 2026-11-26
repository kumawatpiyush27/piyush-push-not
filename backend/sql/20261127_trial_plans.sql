-- Free trial + USD plans (2026-11-27). Additive; also applied at runtime by
-- entitlements.js (ALTER ... IF NOT EXISTS).
--   plan_key          'free' | 'growth' | 'unlimited' (NULL = derived from monthly_limit)
--   trial_*           7-day trial window, one 7-day extension
--   plan_prompts      {"trial_ended_seen_at","limit_seen_period","tour_done_at"}
ALTER TABLE stores
    ADD COLUMN IF NOT EXISTS plan_key TEXT,
    ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS trial_extended_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS plan_prompts JSONB NOT NULL DEFAULT '{}'::jsonb;
