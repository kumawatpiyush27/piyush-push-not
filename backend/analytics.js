'use strict';
// Real analytics for the dashboard: daily series, period totals with the
// previous period for comparison, per-automation and per-campaign results,
// cart recovery funnel + cart list, and a live event feed.
// Every number comes from the database — nothing is estimated or simulated.

const { normalizeSettings, CART_WINDOW_MIN } = require('./automations');

const PERIODS = new Set([7, 30, 90]);
const AUTOMATION_NAMES = {
    welcome: 'Welcome',
    abandoned_cart: 'Abandoned cart',
    browse_abandonment: 'Browse abandonment',
    price_drop: 'Price drop',
    back_in_stock: 'Back in stock',
    order_thank_you: 'Order thank-you',
    winback: 'Win-back',
    test: 'Test notification',
};

function browserFromEndpoint(endpoint) {
    try {
        const h = new URL(endpoint).hostname;
        if (/mozilla\.com$/.test(h)) return 'Firefox';
        if (/notify\.windows\.com$/.test(h)) return 'Edge';
        if (/push\.apple\.com$/.test(h)) return 'Safari';
        if (/googleapis\.com$/.test(h)) return 'Chrome';
    } catch { /* ignore */ }
    return 'Browser';
}

async function resolveTz(db, tz) {
    if (typeof tz !== 'string' || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 64) return 'UTC';
    try {
        const { rows } = await db.query('SELECT 1 FROM pg_timezone_names WHERE name = $1', [tz]);
        return rows.length ? tz : 'UTC';
    } catch { return 'UTC'; }
}

function pctChange(cur, prev) {
    if (!prev) return cur ? null : 0;   // null = "new" (no previous data)
    return Math.round(((cur - prev) / prev) * 1000) / 10;
}

async function getAnalytics(db, storeId, { days = 30, tz = 'UTC' } = {}) {
    days = PERIODS.has(Number(days)) ? Number(days) : 30;
    tz = await resolveTz(db, tz);
    const span = days * 2; // current + previous period for comparison

    const seriesSql = `
      WITH d AS (
        SELECT g::date AS day FROM generate_series((NOW() AT TIME ZONE $2)::date - ($3::int - 1), (NOW() AT TIME ZONE $2)::date, INTERVAL '1 day') g
      ),
      since AS (SELECT ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2 AS t)
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        COALESCE(subs.n, 0)::int AS subscribers,
        COALESCE(cs.n, 0)::int + COALESCE(asent.n, 0)::int AS sent,
        COALESCE(cc.n, 0)::int + COALESCE(aclk.n, 0)::int AS clicks,
        COALESCE(o.n, 0)::int AS orders,
        COALESCE(o.revenue, 0)::float AS revenue
      FROM d
      LEFT JOIN (SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE $2)::date AS day, COUNT(*) n FROM subscriptions
                 WHERE store_id = $1 AND (created_at AT TIME ZONE 'UTC') >= (SELECT t FROM since) GROUP BY 1) subs ON subs.day = d.day
      LEFT JOIN (SELECT ((created_at AT TIME ZONE 'UTC') AT TIME ZONE $2)::date AS day, SUM(COALESCE(sent_count, 0)) n FROM campaigns
                 WHERE store_id = $1 AND status = 'sent' AND (created_at AT TIME ZONE 'UTC') >= (SELECT t FROM since) GROUP BY 1) cs ON cs.day = d.day
      LEFT JOIN (SELECT (sent_at AT TIME ZONE $2)::date AS day, COUNT(*) n FROM push_automation_log
                 WHERE store_id = $1 AND status = 'sent' AND automation <> 'test' AND sent_at >= (SELECT t FROM since) GROUP BY 1) asent ON asent.day = d.day
      LEFT JOIN (SELECT (clicked_at AT TIME ZONE $2)::date AS day, COUNT(*) n FROM push_campaign_clicks
                 WHERE store_id = $1 AND clicked_at >= (SELECT t FROM since) GROUP BY 1) cc ON cc.day = d.day
      LEFT JOIN (SELECT (clicked_at AT TIME ZONE $2)::date AS day, COUNT(*) n FROM push_automation_log
                 WHERE store_id = $1 AND automation <> 'test' AND clicked_at >= (SELECT t FROM since) GROUP BY 1) aclk ON aclk.day = d.day
      LEFT JOIN (SELECT (created_at AT TIME ZONE $2)::date AS day, COUNT(*) n, SUM(total_price) revenue FROM push_orders
                 WHERE store_id = $1 AND attributed_automation IS NOT NULL AND created_at >= (SELECT t FROM since) GROUP BY 1) o ON o.day = d.day
      ORDER BY d.day`;

    const sinceParam = [storeId, tz, days];
    const [seriesRes, subsRes, autoRes, autoRevRes, campRes, funnelRes, recoveredRes, campRevRes] = await Promise.all([
        db.query(seriesSql, [storeId, tz, span]),
        db.query(`SELECT COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired')::int AS active, COUNT(*)::int AS all_time
                  FROM subscriptions WHERE store_id = $1`, [storeId]),
        db.query(`SELECT automation, COUNT(*) FILTER (WHERE status = 'sent')::int AS sent, COUNT(clicked_at)::int AS clicks
                  FROM push_automation_log
                  WHERE store_id = $1 AND automation <> 'test' AND sent_at >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2
                  GROUP BY automation`, sinceParam),
        db.query(`SELECT attributed_automation AS automation, COUNT(*)::int AS orders, COALESCE(SUM(total_price), 0)::float AS revenue
                  FROM push_orders
                  WHERE store_id = $1 AND attributed_automation IS NOT NULL AND created_at >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2
                  GROUP BY attributed_automation`, sinceParam),
        db.query(`SELECT id, title, created_at, COALESCE(sent_count, 0)::int AS sent, COALESCE(clicks, 0)::int AS clicks,
                         COALESCE(revenue, 0)::float AS revenue, status, type
                  FROM campaigns
                  WHERE store_id = $1 AND (created_at AT TIME ZONE 'UTC') >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2
                  ORDER BY created_at DESC LIMIT 10`, sinceParam),
        db.query(`SELECT COUNT(*)::int AS tracked,
                         COUNT(*) FILTER (WHERE COALESCE(r.sent, 0) > 0)::int AS reminded,
                         COUNT(*) FILTER (WHERE c.clicked_at IS NOT NULL)::int AS clicked,
                         COUNT(*) FILTER (WHERE c.status = 'purchased')::int AS purchased,
                         COUNT(*) FILTER (WHERE c.status = 'purchased' AND COALESCE(r.sent, 0) > 0)::int AS recovered,
                         COUNT(*) FILTER (WHERE c.status = 'active' AND c.item_count > 0)::int AS open_now,
                         COALESCE(SUM(c.total_price) FILTER (WHERE c.status = 'active' AND c.item_count > 0), 0)::float AS open_value
                  FROM push_carts c ${CART_SENT_JOIN}
                  WHERE c.store_id = $1 AND c.created_at >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2`, sinceParam),
        db.query(`SELECT COALESCE(SUM(total_price), 0)::float AS revenue, COUNT(*)::int AS orders FROM push_orders
                  WHERE store_id = $1 AND attributed_automation = 'abandoned_cart'
                    AND created_at >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2`, sinceParam),
        db.query(`SELECT COALESCE(SUM(revenue), 0)::float AS revenue FROM campaigns
                  WHERE store_id = $1 AND (created_at AT TIME ZONE 'UTC') >= ((NOW() AT TIME ZONE $2)::date - ($3::int - 1))::timestamp AT TIME ZONE $2`, sinceParam),
    ]);

    const all = seriesRes.rows;
    const prevRows = all.slice(0, all.length - days);
    const curRows = all.slice(all.length - days);
    const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k] || 0), 0);
    const totals = {};
    for (const k of ['subscribers', 'sent', 'clicks', 'orders', 'revenue']) {
        const cur = sum(curRows, k);
        const prev = sum(prevRows, k);
        totals[k] = { value: Math.round(cur * 100) / 100, previous: Math.round(prev * 100) / 100, change: pctChange(cur, prev) };
    }
    totals.revenue.value += campRevRes.rows[0].revenue; // campaign revenue from order webhooks (no daily split)
    totals.ctr = { value: totals.sent.value ? Math.round((totals.clicks.value / totals.sent.value) * 1000) / 10 : 0 };

    const revByAuto = Object.fromEntries(autoRevRes.rows.map((r) => [r.automation, r]));
    const automations = autoRes.rows.map((r) => ({
        key: r.automation,
        name: AUTOMATION_NAMES[r.automation] || r.automation,
        sent: r.sent,
        clicks: r.clicks,
        ctr: r.sent ? Math.round((r.clicks / r.sent) * 1000) / 10 : 0,
        orders: revByAuto[r.automation] ? revByAuto[r.automation].orders : 0,
        revenue: revByAuto[r.automation] ? revByAuto[r.automation].revenue : 0,
    })).sort((a, b) => b.sent - a.sent);

    const f = funnelRes.rows[0];
    return {
        days,
        tz,
        series: curRows,
        totals,
        subscribers: subsRes.rows[0],
        automations,
        campaigns: campRes.rows.map((c) => ({ ...c, ctr: c.sent ? Math.round((c.clicks / c.sent) * 1000) / 10 : 0 })),
        cartFunnel: { ...f, recovered_revenue: recoveredRes.rows[0].revenue, recovered_orders: recoveredRes.rows[0].orders },
    };
}

// Status of one cart in the dashboard list, using the same rules as the
// cart-recovery engine (automations.js runAbandonedCart):
//   waiting       a reminder is still due (next_reminder_at says when)
//   reminded      every reminder has been sent
//   unsubscribed  the shopper turned notifications off, nothing more can be sent
//   not_reminded  older than the 7-day reminder window, nothing was sent
//   off           cart recovery is off, so nothing will be sent
//   not_reminded  no reminder reached the shopper and none is left to send
// c.steps_sent is the engine's step pointer (an old cart jumps straight to
// step 2), so it decides the next step; c.reminders_sent is what was
// actually delivered.
function cartOutcome(c, cartConfig, now = Date.now()) {
    const pointer = Number(c.steps_sent) || 0;
    const delivered = c.reminders_sent === undefined ? pointer : Number(c.reminders_sent) || 0;
    if (c.status === 'purchased') return { outcome: delivered > 0 ? 'recovered' : 'purchased' };
    if (c.status !== 'active') return { outcome: c.status }; // empty | superseded | expired
    if (!(Number(c.item_count) > 0)) return { outcome: 'empty' };
    if (!c.subscriber || c.sub_status === 'expired') return { outcome: 'unsubscribed' };

    const cfg = cartConfig || {};
    const on = !!cfg.enabled && !cfg.needs_review;
    if (!on) return { outcome: delivered > 0 ? 'reminded' : 'off' };
    const steps = (Array.isArray(cfg.steps) ? cfg.steps : []).map((s, index) => ({ ...s, index }));
    const next = steps.find((s) => s.enabled && s.index >= pointer);
    const updated = new Date(c.updated_at).getTime();
    if (!next || now - updated > CART_WINDOW_MIN * 60e3) return { outcome: delivered > 0 ? 'reminded' : 'not_reminded' };
    return { outcome: 'waiting', next_reminder_at: new Date(updated + Number(next.delay_minutes) * 60e3).toISOString() };
}

// Reminders that actually reached the push service, per cart ($1 = store_id).
const CART_SENT_JOIN = `LEFT JOIN (SELECT ref_id, COUNT(*)::int AS sent FROM push_automation_log
                                   WHERE store_id = $1 AND automation = 'abandoned_cart' AND status = 'sent'
                                   GROUP BY ref_id) r ON r.ref_id = c.id::text`;

async function getCarts(db, storeId, { status = 'all', limit = 25, before = null } = {}) {
    limit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    const filters = {
        all: '',
        open: `AND c.status = 'active' AND c.item_count > 0`,
        recovered: `AND c.status = 'purchased' AND COALESCE(r.sent, 0) > 0`,
        reminded: `AND COALESCE(r.sent, 0) > 0`,
    };
    const where = filters[status] !== undefined ? filters[status] : '';
    const params = [storeId, limit];
    let cursor = '';
    if (before && !Number.isNaN(Date.parse(before))) { params.push(new Date(before)); cursor = `AND c.updated_at < $3`; }
    const [{ rows }, storeRes] = await Promise.all([
        db.query(
            `SELECT c.id, c.created_at, c.updated_at, c.item_count, c.total_price::float AS total, c.currency, c.items,
                    c.steps_sent, COALESCE(r.sent, 0) AS reminders_sent, c.last_sent_at, c.clicked_at, c.status, c.endpoint,
                    s.id AS subscriber, s.status AS sub_status
             FROM push_carts c LEFT JOIN subscriptions s ON s.endpoint = c.endpoint
             ${CART_SENT_JOIN}
             WHERE c.store_id = $1 ${where} ${cursor}
             ORDER BY c.updated_at DESC LIMIT $2`,
            params
        ),
        db.query(`SELECT automation_settings, abandoned_config FROM stores WHERE store_id = $1`, [storeId]),
    ]);
    const cartConfig = normalizeSettings(storeRes.rows[0] || null).abandoned_cart;
    const now = Date.now();
    return rows.map((c) => ({
        id: c.id,
        created_at: c.created_at,
        updated_at: c.updated_at,
        item_count: c.item_count,
        total: c.total,
        currency: c.currency,
        items: (Array.isArray(c.items) ? c.items : []).slice(0, 3).map((i) => ({ title: i.product_title || i.title, image: i.image, quantity: i.quantity })),
        reminders_sent: c.reminders_sent,
        last_reminder_at: c.last_sent_at,
        clicked_at: c.clicked_at,
        ...cartOutcome(c, cartConfig, now),
        subscriber: c.subscriber,
        browser: browserFromEndpoint(c.endpoint),
    }));
}

const EVENT_TYPES = ['subscribed', 'visit', 'product_view', 'cart', 'order', 'push_sent', 'push_clicked', 'campaign_sent', 'campaign_clicked'];

function eventQueries(types) {
    const q = {
        subscribed: `SELECT 'subscribed' AS type, (s.created_at AT TIME ZONE 'UTC') AS at, s.id AS subscriber, s.endpoint, NULL::text AS title, NULL::jsonb AS detail
                     FROM subscriptions s WHERE s.store_id = $1 AND (s.created_at AT TIME ZONE 'UTC') < $2 ORDER BY s.created_at DESC LIMIT $3`,
        visit: `SELECT 'visit', s.last_seen_at, s.id, s.endpoint, NULL, NULL::jsonb
                FROM subscriptions s WHERE s.store_id = $1 AND s.last_seen_at < $2 ORDER BY s.last_seen_at DESC NULLS LAST LIMIT $3`,
        product_view: `SELECT 'product_view', v.viewed_at, s.id, v.endpoint, v.product->>'title', jsonb_build_object('views', v.view_count, 'image', v.product->>'image')
                       FROM push_product_views v LEFT JOIN subscriptions s ON s.endpoint = v.endpoint
                       WHERE v.store_id = $1 AND v.viewed_at < $2 ORDER BY v.viewed_at DESC LIMIT $3`,
        cart: `SELECT 'cart', c.updated_at, s.id, c.endpoint, c.items->0->>'product_title',
                      jsonb_build_object('items', c.item_count, 'total', c.total_price, 'currency', c.currency, 'status', c.status)
               FROM push_carts c LEFT JOIN subscriptions s ON s.endpoint = c.endpoint
               WHERE c.store_id = $1 AND c.updated_at < $2 ORDER BY c.updated_at DESC LIMIT $3`,
        order: `SELECT 'order', o.created_at, s.id, o.endpoint, NULL,
                       jsonb_build_object('total', o.total_price, 'currency', o.currency, 'attributed', o.attributed_automation, 'items', jsonb_array_length(COALESCE(o.items, '[]'::jsonb)))
                FROM push_orders o LEFT JOIN subscriptions s ON s.endpoint = o.endpoint
                WHERE o.store_id = $1 AND o.created_at < $2 ORDER BY o.created_at DESC LIMIT $3`,
        push_sent: `SELECT 'push_sent', l.sent_at, s.id, l.endpoint, l.automation, jsonb_build_object('status', l.status, 'step', l.step)
                    FROM push_automation_log l LEFT JOIN subscriptions s ON s.endpoint = l.endpoint
                    WHERE l.store_id = $1 AND l.sent_at < $2 ORDER BY l.sent_at DESC LIMIT $3`,
        push_clicked: `SELECT 'push_clicked', l.clicked_at, s.id, l.endpoint, l.automation, NULL::jsonb
                       FROM push_automation_log l LEFT JOIN subscriptions s ON s.endpoint = l.endpoint
                       WHERE l.store_id = $1 AND l.clicked_at < $2 ORDER BY l.clicked_at DESC NULLS LAST LIMIT $3`,
        campaign_sent: `SELECT 'campaign_sent', (c.created_at AT TIME ZONE 'UTC'), NULL::int, NULL::text, c.title, jsonb_build_object('sent', c.sent_count, 'status', c.status)
                        FROM campaigns c WHERE c.store_id = $1 AND (c.created_at AT TIME ZONE 'UTC') < $2 ORDER BY c.created_at DESC LIMIT $3`,
        campaign_clicked: `SELECT 'campaign_clicked', k.clicked_at, NULL::int, NULL::text, c.title, NULL::jsonb
                           FROM push_campaign_clicks k LEFT JOIN campaigns c ON c.id = k.campaign_id
                           WHERE k.store_id = $1 AND k.clicked_at < $2 ORDER BY k.clicked_at DESC LIMIT $3`,
    };
    return types.map((t) => `(${q[t]})`);
}

async function getEvents(db, storeId, { type = 'all', limit = 50, before = null } = {}) {
    limit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const types = type === 'all' ? EVENT_TYPES : EVENT_TYPES.filter((t) => t === type);
    if (!types.length) return [];
    const beforeDate = before && !Number.isNaN(Date.parse(before)) ? new Date(before) : new Date(Date.now() + 60e3);
    const sql = `SELECT * FROM (${eventQueries(types).join(' UNION ALL ')}) AS e(type, at, subscriber, endpoint, title, detail)
                 WHERE at IS NOT NULL ORDER BY at DESC LIMIT $3`;
    const { rows } = await db.query(sql, [storeId, beforeDate, limit]);
    return rows.map((r) => ({
        type: r.type,
        at: r.at,
        subscriber: r.subscriber,
        browser: r.endpoint ? browserFromEndpoint(r.endpoint) : null,
        title: r.type === 'push_sent' || r.type === 'push_clicked' ? (AUTOMATION_NAMES[r.title] || r.title) : r.title,
        detail: r.detail || null,
    }));
}

module.exports = { getAnalytics, getCarts, getEvents, browserFromEndpoint, cartOutcome, EVENT_TYPES, AUTOMATION_NAMES };
