-- Image uploads + analytics: additive schema only (no drops, no deletes).
-- Apply with (from shopify-public-app/retner-smart-push):
--   npx prisma db execute --file ../../backend/sql/20261119_media_analytics.sql --schema prisma/schema.prisma

-- Images uploaded from the dashboard / Shopify app (campaign images, icons,
-- automation images, store logo). Served publicly at /m/<id>.<ext> because
-- push services and browsers must be able to download them.
CREATE TABLE IF NOT EXISTS push_media (
    id          TEXT PRIMARY KEY,            -- 32 hex chars of sha256(store_id + bytes)
    store_id    TEXT NOT NULL,
    mime        TEXT NOT NULL,               -- image/jpeg | image/png | image/webp
    bytes       BYTEA NOT NULL,
    size        INTEGER NOT NULL,
    width       INTEGER,
    height      INTEGER,
    purpose     TEXT,                        -- hero | icon | logo | automation
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_media_store ON push_media (store_id, created_at);

-- One row per campaign click (campaigns.clicks only has a total), so
-- analytics can chart clicks per day and the event monitor can show them.
CREATE TABLE IF NOT EXISTS push_campaign_clicks (
    id           BIGSERIAL PRIMARY KEY,
    campaign_id  INTEGER NOT NULL,
    store_id     TEXT NOT NULL,
    clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_push_campaign_clicks_store ON push_campaign_clicks (store_id, clicked_at);

-- Per-campaign notification icon (was ignored before).
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS icon TEXT;

-- Order source (shopify_checkout | gokwik) and when a cart was bought.
ALTER TABLE push_orders ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE push_carts ADD COLUMN IF NOT EXISTS purchased_at TIMESTAMPTZ;
