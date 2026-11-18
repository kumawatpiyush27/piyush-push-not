-- Phase 1 automation engine: additive schema only.
--
-- Safe to run more than once (IF NOT EXISTS everywhere). Adds tables and
-- nullable columns; never drops, renames or deletes anything, and is
-- compatible with the code that is currently deployed.
--
-- Apply with (from shopify-public-app/retner-smart-push, which has Prisma):
--   npx prisma db execute --file ../../backend/sql/20261119_automations.sql --schema prisma/schema.prisma

-- Carts seen on the storefront, one row per (push subscription, cart token).
CREATE TABLE IF NOT EXISTS push_carts (
    id            BIGSERIAL PRIMARY KEY,
    store_id      TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    cart_token    TEXT NOT NULL,
    store_domain  TEXT,
    item_count    INTEGER NOT NULL DEFAULT 0,
    total_price   NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency      TEXT,
    items         JSONB,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- last cart activity
    status        TEXT NOT NULL DEFAULT 'active',      -- active | empty | superseded | purchased | expired
    steps_sent    INTEGER NOT NULL DEFAULT 0,
    last_sent_at  TIMESTAMPTZ,
    clicked_at    TIMESTAMPTZ,
    CONSTRAINT push_carts_endpoint_token_key UNIQUE (endpoint, cart_token)
);
CREATE INDEX IF NOT EXISTS idx_push_carts_due ON push_carts (store_id, status, updated_at);
CREATE INDEX IF NOT EXISTS idx_push_carts_token ON push_carts (cart_token);

-- Products a subscriber looked at (browse abandonment).
CREATE TABLE IF NOT EXISTS push_product_views (
    id            BIGSERIAL PRIMARY KEY,
    store_id      TEXT NOT NULL,
    endpoint      TEXT NOT NULL,
    product_id    TEXT NOT NULL,
    store_domain  TEXT,
    product       JSONB,
    viewed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    view_count    INTEGER NOT NULL DEFAULT 1,
    notified_at   TIMESTAMPTZ,
    CONSTRAINT push_product_views_endpoint_product_key UNIQUE (endpoint, product_id)
);
CREATE INDEX IF NOT EXISTS idx_push_views_due ON push_product_views (store_id, notified_at, viewed_at);

-- Every automated push we send: drives stats, click tracking and frequency caps.
CREATE TABLE IF NOT EXISTS push_automation_log (
    id          BIGSERIAL PRIMARY KEY,
    store_id    TEXT NOT NULL,
    automation  TEXT NOT NULL,   -- welcome | abandoned_cart | browse_abandonment | winback | test
    step        INTEGER,
    endpoint    TEXT,
    ref_id      TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | expired
    error       TEXT,
    sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    clicked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_push_log_store ON push_automation_log (store_id, automation, sent_at);
CREATE INDEX IF NOT EXISTS idx_push_log_endpoint ON push_automation_log (endpoint, sent_at);

-- Small key/value store (e.g. when the automation cron last ran).
CREATE TABLE IF NOT EXISTS push_system_state (
    key         TEXT PRIMARY KEY,
    value       JSONB,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subscriber activity and lifecycle (status NULL = active, 'expired' = browser
-- revoked the subscription; rows are kept, just skipped when sending).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS winback_sent_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_subscriptions_store_seen ON subscriptions (store_id, last_seen_at);

-- Per-store automation settings (abandoned cart, browse abandonment, win-back).
ALTER TABLE stores ADD COLUMN IF NOT EXISTS automation_settings JSONB;
