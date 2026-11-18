-- Phase 2 automations (order detection, price drop, back in stock): additive schema only.
-- Safe to run more than once; adds tables only, never drops or deletes anything.
--
-- Apply with (from shopify-public-app/retner-smart-push, which has Prisma):
--   npx prisma db execute --file ../../backend/sql/20261119_phase2.sql --schema prisma/schema.prisma

-- Orders reported by the Retner web pixel (checkout_completed).
CREATE TABLE IF NOT EXISTS push_orders (
    id                    BIGSERIAL PRIMARY KEY,
    store_id              TEXT NOT NULL,
    order_id              TEXT NOT NULL,
    endpoint              TEXT,
    checkout_token        TEXT,
    cart_token            TEXT,
    total_price           NUMERIC(12,2) NOT NULL DEFAULT 0,
    currency              TEXT,
    items                 JSONB,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    attributed_automation TEXT,
    attributed_log_id     BIGINT,
    thanked_at            TIMESTAMPTZ,
    CONSTRAINT push_orders_store_order_key UNIQUE (store_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_push_orders_endpoint ON push_orders (endpoint, created_at);
CREATE INDEX IF NOT EXISTS idx_push_orders_store ON push_orders (store_id, created_at);

-- Last known public price/availability of products that subscribers viewed.
CREATE TABLE IF NOT EXISTS push_products (
    store_id            TEXT NOT NULL,
    product_id          TEXT NOT NULL,
    handle              TEXT,
    store_domain        TEXT,
    title               TEXT,
    image               TEXT,
    url                 TEXT,
    price               BIGINT,       -- minor units (e.g. paise), as returned by /products/<handle>.js
    compare_at_price    BIGINT,
    available           BOOLEAN,
    out_of_stock_since  TIMESTAMPTZ,
    first_checked_at    TIMESTAMPTZ,
    last_checked_at     TIMESTAMPTZ,
    next_check_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    check_failures      INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT,
    PRIMARY KEY (store_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_push_products_due ON push_products (next_check_at);

-- Price drops / restocks detected by the product checker, waiting to be notified.
CREATE TABLE IF NOT EXISTS push_product_events (
    id                  BIGSERIAL PRIMARY KEY,
    store_id            TEXT NOT NULL,
    product_id          TEXT NOT NULL,
    type                TEXT NOT NULL,      -- price_drop | back_in_stock
    old_price           BIGINT,
    new_price           BIGINT,
    out_of_stock_since  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at        TIMESTAMPTZ,
    recipients          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_push_product_events_pending ON push_product_events (store_id, processed_at);
