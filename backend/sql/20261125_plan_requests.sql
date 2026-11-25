-- Plan upgrade requests from the merchant dashboard and the Shopify app
-- (backend/plans.js). The super admin resolves them by setting
-- stores.monthly_limit. Additive only: no data is changed or removed.
CREATE TABLE IF NOT EXISTS plan_requests (
    id SERIAL PRIMARY KEY,
    store_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS plan_requests_store_idx ON plan_requests (store_id, created_at DESC);
