'use strict';
// Retner SmartPush automation engine.
//
// Storefront events (carts, product views, visits) are written by the Shopify
// app's app-proxy routes into push_carts / push_product_views /
// subscriptions.last_seen_at. A cron (every 5 minutes) calls runAutomations(),
// which sends the pushes that are due and records each one in
// push_automation_log (stats, click tracking, frequency caps).
//
// Nothing here deletes rows: dead subscriptions are marked status='expired',
// finished carts get a status, sent reminders are counted.

const crypto = require('crypto');

const DEFAULT_ICON = 'https://cdn-icons-png.flaticon.com/512/733/733585.png';
const DEFAULT_SUBJECT = 'mailto:Koregrowtech@gmail.com';
const APP_BASE_URL = () => (process.env.APP_URL || 'https://push-retner.vercel.app').replace(/\/$/, '');

const CART_WINDOW_MIN = 7 * 24 * 60;          // reminders only for carts active in the last 7 days
const BROWSE_WINDOW_MIN = 72 * 60;            // product views older than 72h are ignored
const DAILY_CAP_PER_SUBSCRIBER = 3;           // max automated pushes per subscriber per 24h
const SEND_CONCURRENCY = 25;

const LIMITS = { title: 80, body: 220, button: 24, image: 500, discount: 40 };

// --------------------------------------------------------------------------
// Catalog + recommended defaults (what the dashboard shows)
// --------------------------------------------------------------------------
const DEFAULT_SETTINGS = {
    abandoned_cart: {
        enabled: false,
        steps: [
            { enabled: true, delay_minutes: 60, title: 'You left something behind 🛒', body: '{product_name} is still in your cart. Complete your order before it sells out!', button: 'Complete order', image: '', discount_code: '' },
            { enabled: true, delay_minutes: 1440, title: 'Still thinking it over?', body: 'Your cart with {item_count} item(s) worth {cart_total} is saved. Tap to pick up where you left off.', button: 'View my cart', image: '', discount_code: '' },
            { enabled: false, delay_minutes: 4320, title: 'Last reminder ⏰', body: 'Your cart is about to expire. Complete your order now!', button: 'Complete order', image: '', discount_code: '' },
        ],
    },
    browse_abandonment: {
        enabled: false,
        delay_minutes: 120,
        title: 'Still interested in {product_name}?',
        body: 'Take another look before it sells out.',
        button: 'View product',
        image: '',
    },
    winback: {
        enabled: false,
        inactive_days: 30,
        title: 'We miss you at {store_name} 💙',
        body: 'New arrivals are waiting for you. Come take a look!',
        button: 'Shop now',
        discount_code: '',
    },
};

const DELAY_BOUNDS = {
    abandoned_cart: [15, CART_WINDOW_MIN],
    browse_abandonment: [30, 48 * 60],
    winback_days: [7, 180],
};

// --------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));

function clampStr(v, max) {
    if (v === undefined || v === null) return '';
    return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function isHttpsUrl(v, max = LIMITS.image) {
    if (!v || typeof v !== 'string' || v.length > max) return false;
    try { return new URL(v).protocol === 'https:'; } catch { return false; }
}

function isHostname(h) {
    return typeof h === 'string' && h.length <= 253 && /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(h);
}

function sanitizeDiscount(code) {
    const c = clampStr(code, LIMITS.discount);
    return /^[A-Za-z0-9_-]*$/.test(c) ? c : '';
}

// Known Web Push services. Prevents the server from being used to POST to
// arbitrary URLs through a forged "subscription".
const PUSH_HOST_PATTERNS = [
    /(^|\.)fcm\.googleapis\.com$/i,
    /(^|\.)android\.googleapis\.com$/i,
    /(^|\.)push\.services\.mozilla\.com$/i,
    /(^|\.)notify\.windows\.com$/i,
    /(^|\.)push\.apple\.com$/i,
];
function isValidPushEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'string' || endpoint.length > 1000) return false;
    try {
        const u = new URL(endpoint);
        return u.protocol === 'https:' && PUSH_HOST_PATTERNS.some((re) => re.test(u.hostname));
    } catch { return false; }
}

function normalizeCartToken(t) {
    if (!t || typeof t !== 'string') return null;
    const s = t.split('?')[0].trim();
    return /^[A-Za-z0-9_\-:.]{6,200}$/.test(s) ? s : null;
}

function formatMoney(amount, currency) {
    const n = Number(amount) || 0;
    try {
        return new Intl.NumberFormat('en-IN', {
            style: 'currency',
            currency: currency || 'INR',
            maximumFractionDigits: Number.isInteger(n) ? 0 : 2,
        }).format(n);
    } catch {
        return `${currency || ''} ${n.toFixed(2)}`.trim();
    }
}

function renderTemplate(str, vars) {
    return String(str || '')
        .replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''))
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function withParams(url, params) {
    try {
        const u = new URL(url);
        for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
        return u.toString();
    } catch { return url; }
}

function utm(campaign) {
    return { utm_source: 'retner-push', utm_medium: 'push', utm_campaign: campaign };
}

function storeDomainFor(storeId, ...candidates) {
    for (const c of candidates) if (isHostname(c)) return c.toLowerCase();
    return `${storeId}.myshopify.com`;
}

// Cart permalink: rebuilds the exact cart on any device and goes to checkout.
function buildRestoreUrl(domain, items, discountCode, campaign) {
    const lines = (Array.isArray(items) ? items : [])
        .map((i) => ({ v: Number(i.variant_id), q: Math.max(1, Math.min(999, Number(i.quantity) || 1)) }))
        .filter((l) => Number.isSafeInteger(l.v) && l.v > 0)
        .slice(0, 25);
    const base = lines.length
        ? `https://${domain}/cart/${lines.map((l) => `${l.v}:${l.q}`).join(',')}`
        : `https://${domain}/cart`;
    return withParams(base, { discount: discountCode || undefined, ...utm(campaign) });
}

function storeHomeUrl(domain, discountCode, campaign) {
    if (discountCode) {
        return withParams(`https://${domain}/discount/${encodeURIComponent(discountCode)}`, { redirect: '/', ...utm(campaign) });
    }
    return withParams(`https://${domain}/`, utm(campaign));
}

// --------------------------------------------------------------------------
// Signed links (click tracking without an open redirect)
// --------------------------------------------------------------------------
function linkSecret() {
    return process.env.LINK_SIGNING_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET || '';
}

function sign(parts) {
    const secret = linkSecret();
    if (!secret) return '';
    return crypto.createHmac('sha256', secret).update(parts.join('|')).digest('base64url').slice(0, 24);
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || ''));
    const y = Buffer.from(String(b || ''));
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function automationClickUrl(logId, url) {
    const s = sign(['n', String(logId), url]);
    if (!s) return url;
    return `${APP_BASE_URL()}/n/c?l=${encodeURIComponent(logId)}&u=${encodeURIComponent(url)}&s=${s}`;
}

function verifyAutomationClick(logId, url, s) {
    return safeEqual(sign(['n', String(logId), url]), s);
}

function campaignClickUrl(campaignId, url) {
    const s = sign(['c', String(campaignId), url]);
    const base = `${APP_BASE_URL()}/track-click?url=${encodeURIComponent(url)}&c=${encodeURIComponent(campaignId)}`;
    return s ? `${base}&s=${s}` : base;
}

function verifyCampaignClick(campaignId, url, s) {
    return safeEqual(sign(['c', String(campaignId), url]), s);
}

// --------------------------------------------------------------------------
// Settings: normalize / validate / import legacy
// --------------------------------------------------------------------------
function legacyStepToNew(step) {
    const delay = Number(step && step.delay) || 20;
    const unit = (step && step.unit) || 'minutes';
    const minutes = unit === 'days' ? delay * 1440 : unit === 'hours' ? delay * 60 : delay;
    return {
        enabled: !!(step && step.enabled),
        delay_minutes: minutes,
        title: clampStr(step && step.title, LIMITS.title),
        body: clampStr(step && step.body, LIMITS.body),
        button: clampStr((step && step.btn1) || 'Complete order', LIMITS.button),
        image: isHttpsUrl(step && step.image) ? step.image : '',
        discount_code: '',
    };
}

// Merge stored settings with defaults. Legacy abandoned-cart config (from the
// old editor) is imported as a draft that the merchant must review before it
// sends anything — old configs contain test text that must not reach shoppers.
function normalizeSettings(row) {
    const out = clone(DEFAULT_SETTINGS);
    let stored = row && row.automation_settings;
    if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch { stored = null; } }

    if (stored && typeof stored === 'object') {
        for (const key of Object.keys(out)) {
            if (stored[key] && typeof stored[key] === 'object') out[key] = { ...out[key], ...stored[key] };
        }
    } else if (row && row.abandoned_config) {
        try {
            const legacy = JSON.parse(row.abandoned_config);
            if (Array.isArray(legacy) && legacy.length) {
                out.abandoned_cart = {
                    enabled: false,
                    needs_review: true,
                    imported_from_legacy: true,
                    steps: legacy.slice(0, 3).map(legacyStepToNew),
                };
            }
        } catch { /* ignore broken legacy config */ }
    }
    return out;
}

function validateStep(step, bounds) {
    const errors = [];
    const delay = Math.round(Number(step && step.delay_minutes));
    if (!Number.isFinite(delay) || delay < bounds[0] || delay > bounds[1]) {
        errors.push(`Wait time must be between ${bounds[0]} minutes and ${Math.round(bounds[1] / 1440)} days.`);
    }
    const title = clampStr(step && step.title, LIMITS.title);
    const body = clampStr(step && step.body, LIMITS.body);
    if (step && step.enabled && !title) errors.push('Title is required.');
    if (step && step.enabled && !body) errors.push('Message is required.');
    const image = clampStr(step && step.image, LIMITS.image);
    if (image && !isHttpsUrl(image)) errors.push('Image must be an https:// link.');
    const discountRaw = clampStr(step && step.discount_code, LIMITS.discount);
    if (discountRaw && !/^[A-Za-z0-9_-]+$/.test(discountRaw)) errors.push('Discount code can only contain letters, numbers, - and _.');
    return {
        errors,
        value: {
            enabled: !!(step && step.enabled),
            delay_minutes: Number.isFinite(delay) ? delay : bounds[0],
            title,
            body,
            button: clampStr(step && step.button, LIMITS.button) || 'Open',
            image: isHttpsUrl(image) ? image : '',
            discount_code: sanitizeDiscount(discountRaw),
        },
    };
}

function validateAutomationConfig(automation, input) {
    const errors = [];
    const enabled = !!(input && input.enabled);

    if (automation === 'abandoned_cart') {
        const rawSteps = Array.isArray(input && input.steps) ? input.steps.slice(0, 3) : [];
        if (!rawSteps.length) errors.push('At least one reminder is required.');
        const steps = rawSteps.map((s, i) => {
            const r = validateStep(s, DELAY_BOUNDS.abandoned_cart);
            r.errors.forEach((e) => errors.push(`Reminder ${i + 1}: ${e}`));
            return r.value;
        });
        steps.sort((a, b) => a.delay_minutes - b.delay_minutes);
        for (let i = 1; i < steps.length; i++) {
            if (steps[i].delay_minutes === steps[i - 1].delay_minutes) errors.push('Each reminder needs a different wait time.');
        }
        if (enabled && !steps.some((s) => s.enabled)) errors.push('Turn on at least one reminder.');
        return { errors, value: { enabled, steps } };
    }

    if (automation === 'browse_abandonment') {
        const r = validateStep({ ...input, enabled: true }, DELAY_BOUNDS.browse_abandonment);
        delete r.value.discount_code;
        return { errors: r.errors, value: { ...r.value, enabled } };
    }

    if (automation === 'winback') {
        const days = Math.round(Number(input && input.inactive_days));
        const [lo, hi] = DELAY_BOUNDS.winback_days;
        if (!Number.isFinite(days) || days < lo || days > hi) errors.push(`Inactive days must be between ${lo} and ${hi}.`);
        const r = validateStep({ ...input, enabled: true, delay_minutes: 60 }, [1, 1e9]);
        errors.push(...r.errors);
        const v = r.value;
        return {
            errors,
            value: { enabled, inactive_days: Number.isFinite(days) ? days : 30, title: v.title, body: v.body, button: v.button, discount_code: v.discount_code },
        };
    }

    if (automation === 'welcome') {
        const title = clampStr(input && input.title, LIMITS.title);
        const body = clampStr(input && input.body, LIMITS.body);
        if (enabled && (!title || !body)) errors.push('Title and message are required.');
        return { errors, value: { enabled, title, body } };
    }

    return { errors: ['Unknown automation.'], value: null };
}

// --------------------------------------------------------------------------
// Schema check (idempotent; only runs DDL when something is missing)
// --------------------------------------------------------------------------
let schemaChecked = false;
async function ensureSchema(db) {
    if (schemaChecked) return;
    const { rows } = await db.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND (
           table_name IN ('push_carts','push_product_views','push_automation_log','push_system_state')
           OR (table_name = 'subscriptions' AND column_name IN ('last_seen_at','winback_sent_at','status','expired_at'))
           OR (table_name = 'stores' AND column_name = 'automation_settings'))`
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const tablesOk = ['push_carts.id', 'push_product_views.id', 'push_automation_log.id', 'push_system_state.key'].every((k) => have.has(k));
    const colsOk = ['subscriptions.last_seen_at', 'subscriptions.winback_sent_at', 'subscriptions.status', 'subscriptions.expired_at', 'stores.automation_settings'].every((k) => have.has(k));
    if (!tablesOk || !colsOk) {
        const fs = require('fs');
        const path = require('path');
        const sql = fs.readFileSync(path.join(__dirname, 'sql', '20261119_automations.sql'), 'utf8');
        await db.query(sql);
    }
    schemaChecked = true;
}

// --------------------------------------------------------------------------
// Sending
// --------------------------------------------------------------------------
function vapidOptions(store, extra = {}) {
    const email = store && typeof store.store_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(store.store_email)
        ? `mailto:${store.store_email}` : DEFAULT_SUBJECT;
    return {
        vapidDetails: { subject: email, publicKey: process.env.PUBLIC_KEY, privateKey: process.env.PRIVATE_KEY },
        TTL: 24 * 60 * 60,
        ...extra,
    };
}

function storeIcon(store) {
    const logo = store && store.logo_url;
    return isHttpsUrl(logo) ? logo : DEFAULT_ICON;
}

// Builds a push payload the service worker understands (top-level url for old
// workers, data.url + action URLs for the new one).
function buildPayload({ title, body, icon, image, url, button, tag, automation, logId }) {
    const payload = {
        title: clampStr(title, LIMITS.title) || 'Notification',
        body: clampStr(body, LIMITS.body),
        icon: icon || DEFAULT_ICON,
        url,
        data: { url, automation, log: logId },
        actions: button ? [{ action: 'open', title: clampStr(button, LIMITS.button), url }] : [],
    };
    if (isHttpsUrl(image)) payload.image = image;
    if (tag) payload.tag = tag;
    return payload;
}

async function markExpired(db, endpoint) {
    await db.query(`UPDATE subscriptions SET status = 'expired', expired_at = NOW() WHERE endpoint = $1 AND status IS DISTINCT FROM 'expired'`, [endpoint]);
}

// Returns { ok, expired, error }.
async function sendPush(db, webPush, sub, payload, options) {
    try {
        await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(payload), options);
        return { ok: true };
    } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
            await markExpired(db, sub.endpoint);
            return { ok: false, expired: true, error: `expired (${e.statusCode})` };
        }
        return { ok: false, error: (e && (e.body || e.message)) ? String(e.body || e.message).slice(0, 300) : 'send failed' };
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return results;
}

async function logStart(db, { storeId, automation, step, endpoint, refId }) {
    const { rows } = await db.query(
        `INSERT INTO push_automation_log (store_id, automation, step, endpoint, ref_id, status) VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
        [storeId, automation, step ?? null, endpoint, refId ?? null]
    );
    return rows[0].id;
}

async function logFinish(db, logId, result) {
    const status = result.ok ? 'sent' : result.expired ? 'expired' : 'failed';
    await db.query(`UPDATE push_automation_log SET status = $2, error = $3 WHERE id = $1`, [logId, status, result.ok ? null : result.error || null]);
}

// One automated push: log -> send -> finish log.
async function sendAutomated(ctx, { store, automation, step, sub, refId, title, body, image, targetUrl, button, tag }) {
    const logId = await logStart(ctx.db, { storeId: store.store_id, automation, step, endpoint: sub.endpoint, refId });
    const url = automationClickUrl(logId, targetUrl);
    const payload = buildPayload({ title, body, icon: storeIcon(store), image, url, button, tag, automation, logId });
    const result = await sendPush(ctx.db, ctx.webPush, sub, payload, vapidOptions(store));
    await logFinish(ctx.db, logId, result);
    return { ...result, logId };
}

// Subscribers that already got DAILY_CAP_PER_SUBSCRIBER automated pushes in 24h.
async function cappedEndpoints(db, endpoints, now) {
    if (!endpoints.length) return new Set();
    const { rows } = await db.query(
        `SELECT endpoint FROM push_automation_log
         WHERE endpoint = ANY($1) AND status = 'sent' AND automation <> 'test' AND sent_at >= $2
         GROUP BY endpoint HAVING COUNT(*) >= $3`,
        [endpoints, new Date(now.getTime() - 24 * 3600e3), DAILY_CAP_PER_SUBSCRIBER]
    );
    return new Set(rows.map((r) => r.endpoint));
}

function cartVars(store, cart) {
    const items = Array.isArray(cart.items) ? cart.items : [];
    const first = items[0] || {};
    return {
        product_name: first.product_title || first.title || 'Your item',
        item_count: cart.item_count,
        cart_total: formatMoney(cart.total_price, cart.currency),
        store_name: store.store_name || store.store_id,
    };
}

// --------------------------------------------------------------------------
// Automations
// --------------------------------------------------------------------------
async function runAbandonedCart(ctx, store, config, summary) {
    const steps = (config.steps || []).map((s, i) => ({ ...s, index: i }));
    const enabledSteps = steps.filter((s) => s.enabled);
    if (!enabledSteps.length) return;

    const now = ctx.now;
    const minDelay = Math.min(...enabledSteps.map((s) => s.delay_minutes));
    const { rows: carts } = await ctx.db.query(
        `SELECT c.id, c.endpoint, c.cart_token, c.store_domain, c.item_count, c.total_price, c.currency, c.items,
                c.updated_at, c.steps_sent, s.keys, s.store_domain AS sub_domain
         FROM push_carts c
         JOIN subscriptions s ON s.endpoint = c.endpoint
         WHERE c.store_id = $1 AND c.status = 'active' AND c.item_count > 0
           AND c.steps_sent < $2
           AND c.updated_at <= $3 AND c.updated_at >= $4
           AND s.status IS DISTINCT FROM 'expired'
         ORDER BY c.updated_at ASC
         LIMIT $5`,
        [store.store_id, steps.length, new Date(now - minDelay * 60e3), new Date(now - CART_WINDOW_MIN * 60e3), ctx.perStoreLimit]
    );
    if (!carts.length) return;

    const capped = await cappedEndpoints(ctx.db, carts.map((c) => c.endpoint), now);
    const seen = new Set();
    const due = [];
    for (const cart of carts) {
        if (capped.has(cart.endpoint) || seen.has(cart.endpoint)) continue;
        const ageMin = (now - new Date(cart.updated_at)) / 60e3;
        // Latest enabled step that is due and not yet sent (never fire several at once).
        const candidates = enabledSteps.filter((s) => s.index >= cart.steps_sent && ageMin >= s.delay_minutes);
        if (!candidates.length) continue;
        seen.add(cart.endpoint);
        due.push({ cart, step: candidates[candidates.length - 1] });
    }

    await mapLimit(due.slice(0, ctx.budget.left()), SEND_CONCURRENCY, async ({ cart, step }) => {
        // Claim the cart first so overlapping runs cannot double-send.
        const claim = await ctx.db.query(
            `UPDATE push_carts SET steps_sent = $2, last_sent_at = $3 WHERE id = $1 AND steps_sent = $4 AND status = 'active' RETURNING id`,
            [cart.id, step.index + 1, now, cart.steps_sent]
        );
        if (!claim.rowCount || !ctx.budget.take()) return;
        const domain = storeDomainFor(store.store_id, cart.store_domain, cart.sub_domain);
        const vars = { ...cartVars(store, cart), discount_code: step.discount_code };
        const firstImage = Array.isArray(cart.items) && cart.items[0] && cart.items[0].image;
        const result = await sendAutomated(ctx, {
            store,
            automation: 'abandoned_cart',
            step: step.index + 1,
            sub: { endpoint: cart.endpoint, keys: cart.keys },
            refId: String(cart.id),
            title: renderTemplate(step.title, vars),
            body: renderTemplate(step.body, vars),
            image: step.image || firstImage,
            targetUrl: buildRestoreUrl(domain, cart.items, step.discount_code, `abandoned_cart_${step.index + 1}`),
            button: step.button,
            tag: `retner-cart-${cart.id}`,
        });
        if (result.ok) summary.abandoned++;
        else if (!result.expired) {
            // Transient failure: give the step back so the next run retries.
            await ctx.db.query(`UPDATE push_carts SET steps_sent = $2 WHERE id = $1 AND steps_sent = $3`, [cart.id, cart.steps_sent, step.index + 1]);
            summary.errors.push(`cart ${cart.id}: ${result.error}`);
        }
    });
}

async function runBrowseAbandonment(ctx, store, config, summary) {
    const now = ctx.now;
    const { rows: views } = await ctx.db.query(
        `SELECT v.id, v.endpoint, v.product_id, v.product, v.store_domain, v.viewed_at, s.keys, s.store_domain AS sub_domain
         FROM push_product_views v
         JOIN subscriptions s ON s.endpoint = v.endpoint
         WHERE v.store_id = $1 AND v.notified_at IS NULL
           AND v.viewed_at <= $2 AND v.viewed_at >= $3
           AND s.status IS DISTINCT FROM 'expired'
           AND NOT EXISTS (SELECT 1 FROM push_carts c WHERE c.endpoint = v.endpoint AND c.status = 'active' AND c.item_count > 0 AND c.updated_at >= $3)
           AND NOT EXISTS (SELECT 1 FROM push_automation_log l WHERE l.endpoint = v.endpoint AND l.automation = 'browse_abandonment' AND l.status = 'sent' AND l.sent_at >= $4)
         ORDER BY v.viewed_at DESC
         LIMIT $5`,
        [store.store_id, new Date(now - config.delay_minutes * 60e3), new Date(now - BROWSE_WINDOW_MIN * 60e3), new Date(now - 24 * 3600e3), ctx.perStoreLimit]
    );
    if (!views.length) return;

    const capped = await cappedEndpoints(ctx.db, views.map((v) => v.endpoint), now);
    const seen = new Set();
    const due = views.filter((v) => !capped.has(v.endpoint) && !seen.has(v.endpoint) && seen.add(v.endpoint));

    await mapLimit(due.slice(0, ctx.budget.left()), SEND_CONCURRENCY, async (view) => {
        // One browse push per browsing session: claim every pending view of this subscriber.
        const claim = await ctx.db.query(
            `UPDATE push_product_views SET notified_at = $2 WHERE endpoint = $1 AND store_id = $3 AND notified_at IS NULL AND viewed_at <= $2 RETURNING id`,
            [view.endpoint, now, store.store_id]
        );
        if (!claim.rowCount || !ctx.budget.take()) return;
        const product = view.product || {};
        const domain = storeDomainFor(store.store_id, view.store_domain, view.sub_domain);
        const path = typeof product.url === 'string' && product.url.startsWith('/') ? product.url : '/';
        const vars = { product_name: product.title || 'this product', store_name: store.store_name || store.store_id };
        const result = await sendAutomated(ctx, {
            store,
            automation: 'browse_abandonment',
            step: 1,
            sub: { endpoint: view.endpoint, keys: view.keys },
            refId: String(view.product_id),
            title: renderTemplate(config.title, vars),
            body: renderTemplate(config.body, vars),
            image: config.image || product.image,
            targetUrl: withParams(`https://${domain}${path}`, utm('browse_abandonment')),
            button: config.button,
            tag: `retner-browse-${view.product_id}`,
        });
        if (result.ok) summary.browse++;
        else if (!result.expired) summary.errors.push(`browse ${view.id}: ${result.error}`);
    });
}

async function runWinback(ctx, store, config, summary) {
    const now = ctx.now;
    const days = config.inactive_days;
    const { rows: subs } = await ctx.db.query(
        `SELECT s.endpoint, s.keys, s.store_domain, s.last_seen_at
         FROM subscriptions s
         WHERE s.store_id = $1 AND s.status IS DISTINCT FROM 'expired'
           AND s.last_seen_at IS NOT NULL AND s.last_seen_at <= $2 AND s.last_seen_at >= $3
           AND (s.winback_sent_at IS NULL OR s.winback_sent_at < s.last_seen_at)
         ORDER BY s.last_seen_at DESC
         LIMIT $4`,
        [store.store_id, new Date(now - days * 864e5), new Date(now - (days + 30) * 864e5), ctx.perStoreLimit]
    );
    if (!subs.length) return;
    const capped = await cappedEndpoints(ctx.db, subs.map((s) => s.endpoint), now);

    await mapLimit(subs.filter((s) => !capped.has(s.endpoint)).slice(0, ctx.budget.left()), SEND_CONCURRENCY, async (sub) => {
        const claim = await ctx.db.query(
            `UPDATE subscriptions SET winback_sent_at = $2 WHERE endpoint = $1 AND (winback_sent_at IS NULL OR winback_sent_at < last_seen_at) RETURNING endpoint`,
            [sub.endpoint, now]
        );
        if (!claim.rowCount || !ctx.budget.take()) return;
        const domain = storeDomainFor(store.store_id, sub.store_domain);
        const vars = { store_name: store.store_name || store.store_id, discount_code: config.discount_code };
        const result = await sendAutomated(ctx, {
            store,
            automation: 'winback',
            step: 1,
            sub,
            refId: null,
            title: renderTemplate(config.title, vars),
            body: renderTemplate(config.body, vars),
            image: null,
            targetUrl: storeHomeUrl(domain, config.discount_code, 'winback'),
            button: config.button,
            tag: 'retner-winback',
        });
        if (result.ok) summary.winback++;
        else if (!result.expired) summary.errors.push(`winback: ${result.error}`);
    });
}

// --------------------------------------------------------------------------
// Campaigns (broadcasts) — shared by "send now" and the scheduler
// --------------------------------------------------------------------------
async function activeSubscriptions(db, storeId) {
    const { rows } = await db.query(
        `SELECT endpoint, keys FROM subscriptions WHERE store_id = $1 AND status IS DISTINCT FROM 'expired'`,
        [storeId]
    );
    return rows;
}

function appendCampaignUtm(url, campaignId) {
    if (!url) return url;
    return withParams(url, { utm_source: 'push-retner', utm_medium: 'push', utm_campaign: `push_camp_${campaignId}` });
}

async function sendCampaign(ctx, store, camp, { btn1Text, btn1Url, btn2Text, btn2Url } = {}) {
    const subs = await activeSubscriptions(ctx.db, camp.store_id);
    const mainUrl = campaignClickUrl(camp.id, appendCampaignUtm(camp.url, camp.id) || `https://${camp.store_id}.myshopify.com/`);
    const actions = [];
    if (btn1Text) actions.push({ action: 'b1', title: clampStr(btn1Text, LIMITS.button), url: campaignClickUrl(camp.id, appendCampaignUtm(btn1Url || camp.url, camp.id)) });
    if (btn2Text) actions.push({ action: 'b2', title: clampStr(btn2Text, LIMITS.button), url: campaignClickUrl(camp.id, appendCampaignUtm(btn2Url || camp.url, camp.id)) });

    const payload = {
        title: camp.title,
        body: camp.message,
        icon: storeIcon(store),
        url: mainUrl,
        data: { id: camp.id, url: mainUrl, type: camp.type || 'regular', expiryAt: camp.expiry_at || null },
        actions,
    };
    if (camp.image && isHttpsUrl(camp.image)) payload.image = camp.image;

    const extra = {};
    if (camp.expiry_at) {
        const ttl = Math.floor((new Date(camp.expiry_at).getTime() - Date.now()) / 1000);
        if (ttl > 0) extra.TTL = ttl;
    }
    const options = vapidOptions(store, extra);

    let sent = 0;
    let lastError = null;
    await mapLimit(subs, SEND_CONCURRENCY, async (sub) => {
        const r = await sendPush(ctx.db, ctx.webPush, sub, payload, options);
        if (r.ok) sent++;
        else if (!r.expired) lastError = r.error;
    });
    await ctx.db.query(`UPDATE campaigns SET sent_count = $1, status = 'sent' WHERE id = $2`, [sent, camp.id]);
    return { sent, total: subs.length, lastError };
}

async function runScheduledCampaigns(ctx, summary, onlyStore) {
    const params = onlyStore ? [onlyStore] : [];
    // Never blast a campaign that is more than 24h overdue (e.g. after an
    // outage): mark it 'missed' so the merchant can resend it on purpose.
    const missed = await ctx.db.query(
        `UPDATE campaigns SET status = 'missed'
         WHERE status = 'scheduled' AND scheduled_at < NOW() - INTERVAL '24 hours' ${onlyStore ? 'AND store_id = $1' : ''}`,
        params
    );
    summary.missedCampaigns = missed.rowCount;
    const { rows } = await ctx.db.query(
        `UPDATE campaigns SET status = 'sending'
         WHERE id IN (
           SELECT id FROM campaigns
           WHERE status = 'scheduled' AND scheduled_at <= NOW() ${onlyStore ? 'AND store_id = $1' : ''}
           ORDER BY scheduled_at ASC LIMIT 5 FOR UPDATE SKIP LOCKED)
         RETURNING *`,
        params
    );
    for (const camp of rows) {
        const store = await loadStore(ctx.db, camp.store_id);
        const r = await sendCampaign(ctx, store || { store_id: camp.store_id }, camp);
        summary.scheduledCampaigns++;
        summary.campaignPushes += r.sent;
    }
}

// --------------------------------------------------------------------------
// Entry points
// --------------------------------------------------------------------------
async function loadStore(db, storeId) {
    const { rows } = await db.query(
        `SELECT store_id, store_name, logo_url, store_email, automation_settings, abandoned_enabled, abandoned_config,
                welcome_enabled, welcome_title, welcome_body
         FROM stores WHERE store_id = $1`,
        [storeId]
    );
    return rows[0] || null;
}

function makeBudget(total) {
    let left = total;
    return { left: () => Math.max(0, left), take: () => (left > 0 ? (left--, true) : false) };
}

async function runAutomations({ db, webPush, now = new Date(), onlyStore = null, budget = 1500, perStoreLimit = 300 } = {}) {
    await ensureSchema(db);
    const ctx = { db, webPush, now, budget: makeBudget(budget), perStoreLimit };
    const summary = { scheduledCampaigns: 0, campaignPushes: 0, abandoned: 0, browse: 0, winback: 0, expiredCarts: 0, stores: 0, errors: [] };

    await runScheduledCampaigns(ctx, summary, onlyStore);

    const { rows: stores } = await db.query(
        `SELECT store_id, store_name, logo_url, store_email, automation_settings, abandoned_config
         FROM stores WHERE automation_settings IS NOT NULL ${onlyStore ? 'AND store_id = $1' : ''}`,
        onlyStore ? [onlyStore] : []
    );
    for (const store of stores) {
        const settings = normalizeSettings(store);
        const tasks = [];
        if (settings.abandoned_cart.enabled && !settings.abandoned_cart.needs_review) tasks.push(() => runAbandonedCart(ctx, store, settings.abandoned_cart, summary));
        if (settings.browse_abandonment.enabled) tasks.push(() => runBrowseAbandonment(ctx, store, settings.browse_abandonment, summary));
        if (settings.winback.enabled) tasks.push(() => runWinback(ctx, store, settings.winback, summary));
        if (!tasks.length) continue;
        summary.stores++;
        for (const task of tasks) {
            try { await task(); } catch (e) { summary.errors.push(`${store.store_id}: ${e.message}`); }
        }
    }

    const expired = await db.query(
        `UPDATE push_carts SET status = 'expired' WHERE status = 'active' AND updated_at < $1 ${onlyStore ? 'AND store_id = $2' : ''}`,
        onlyStore ? [new Date(now - CART_WINDOW_MIN * 60e3), onlyStore] : [new Date(now - CART_WINDOW_MIN * 60e3)]
    );
    summary.expiredCarts = expired.rowCount;
    summary.errors = summary.errors.slice(0, 20);

    await db.query(
        `INSERT INTO push_system_state (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [onlyStore ? `last_run:${onlyStore}` : 'last_cron_run', JSON.stringify({ at: now.toISOString(), ...summary })]
    );
    return summary;
}

// Dashboard data: settings + stats + setup checklist.
async function getDashboard(db, storeId) {
    await ensureSchema(db);
    const store = await loadStore(db, storeId);
    if (!store) return null;
    const settings = normalizeSettings(store);

    const since = new Date(Date.now() - 30 * 864e5);
    const [statsRes, subsRes, trackRes, cronRes, legacyRes] = await Promise.all([
        db.query(
            `SELECT automation, COUNT(*) FILTER (WHERE status = 'sent') AS sent, COUNT(clicked_at) AS clicks
             FROM push_automation_log WHERE store_id = $1 AND sent_at >= $2 AND automation <> 'test' GROUP BY automation`,
            [storeId, since]
        ),
        db.query(
            `SELECT COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired') AS active,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_7d,
                    COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '24 hours') AS seen_24h
             FROM subscriptions WHERE store_id = $1`,
            [storeId]
        ),
        db.query(
            `SELECT (SELECT COUNT(*) FROM push_carts WHERE store_id = $1 AND updated_at >= NOW() - INTERVAL '7 days') AS carts_7d,
                    (SELECT COUNT(*) FROM push_carts WHERE store_id = $1 AND status = 'active' AND item_count > 0 AND updated_at >= NOW() - INTERVAL '7 days') AS open_carts,
                    (SELECT COUNT(*) FROM push_product_views WHERE store_id = $1 AND viewed_at >= NOW() - INTERVAL '7 days') AS views_7d`,
            [storeId]
        ),
        db.query(`SELECT value, updated_at FROM push_system_state WHERE key = 'last_cron_run'`),
        db.query(`SELECT welcome_sent_count, welcome_click_count FROM stores WHERE store_id = $1`, [storeId]),
    ]);

    const stats = {};
    for (const r of statsRes.rows) stats[r.automation] = { sent: Number(r.sent), clicks: Number(r.clicks) };
    const legacy = legacyRes.rows[0] || {};
    stats.welcome = {
        sent: (stats.welcome ? stats.welcome.sent : 0),
        clicks: (stats.welcome ? stats.welcome.clicks : 0),
        sent_all_time: Number(legacy.welcome_sent_count || 0),
    };

    const subs = subsRes.rows[0] || {};
    const track = trackRes.rows[0] || {};
    const cron = cronRes.rows[0];
    const cronAgeMin = cron ? (Date.now() - new Date(cron.updated_at).getTime()) / 60e3 : null;

    return {
        automations: {
            welcome: { enabled: !!store.welcome_enabled, title: store.welcome_title || '', body: store.welcome_body || '' },
            ...settings,
        },
        stats,
        health: {
            subscribers: Number(subs.active || 0),
            new_subscribers_7d: Number(subs.new_7d || 0),
            visitors_seen_24h: Number(subs.seen_24h || 0),
            carts_tracked_7d: Number(track.carts_7d || 0),
            open_carts: Number(track.open_carts || 0),
            product_views_7d: Number(track.views_7d || 0),
            engine_last_run: cron ? cron.updated_at : null,
            engine_ok: cronAgeMin !== null && cronAgeMin <= 15,
        },
    };
}

async function saveAutomation(db, storeId, automation, input) {
    await ensureSchema(db);
    const { errors, value } = validateAutomationConfig(automation, input);
    if (errors.length) return { ok: false, errors };

    if (automation === 'welcome') {
        await db.query(
            `UPDATE stores SET welcome_enabled = $2, welcome_title = $3, welcome_body = $4 WHERE store_id = $1`,
            [storeId, value.enabled, value.title, value.body]
        );
        return { ok: true, value };
    }

    const store = await loadStore(db, storeId);
    if (!store) return { ok: false, errors: ['Store not found.'] };
    const settings = normalizeSettings(store);
    settings[automation] = value; // drops needs_review once the merchant saves
    await db.query(`UPDATE stores SET automation_settings = $2 WHERE store_id = $1`, [storeId, JSON.stringify(settings)]);
    if (automation === 'abandoned_cart') {
        // Keep the legacy flag in sync for anything still reading it.
        await db.query(`UPDATE stores SET abandoned_enabled = $2 WHERE store_id = $1`, [storeId, value.enabled]);
    }
    return { ok: true, value };
}

// Sample data used for previews and "send test".
const SAMPLE_CART = {
    item_count: 2,
    total_price: 1299,
    currency: 'INR',
    items: [{ product_title: 'Classic Cotton T-Shirt', title: 'Classic Cotton T-Shirt', image: '' }],
};

// Sends a sample of an automation to the merchant's own browser. When
// `override` is given (unsaved editor content) it is validated and used
// instead of the stored settings.
async function sendTest(ctx, store, automation, stepIndex, subscription, override) {
    if (!subscription || !isValidPushEndpoint(subscription.endpoint) || !subscription.keys) {
        return { ok: false, error: 'This browser could not be subscribed for test notifications.' };
    }
    let source;
    if (override) {
        const { errors, value } = validateAutomationConfig(automation, { ...override, enabled: false });
        if (!value) return { ok: false, error: 'Unknown automation.' };
        if (errors.length) return { ok: false, error: errors[0] };
        source = value;
    } else if (automation === 'welcome') {
        source = { title: store.welcome_title || 'Welcome!', body: store.welcome_body || 'Thanks for subscribing.' };
    } else {
        source = normalizeSettings(store)[automation];
    }
    let cfg;
    if (automation === 'welcome') cfg = { ...source, button: 'Visit store' };
    else if (automation === 'abandoned_cart') cfg = ((source && source.steps) || [])[Number(stepIndex) || 0];
    else cfg = source;
    if (!cfg) return { ok: false, error: 'Unknown automation.' };

    const vars = {
        ...cartVars(store, SAMPLE_CART),
        product_name: 'Classic Cotton T-Shirt',
        discount_code: cfg.discount_code || '',
    };
    const domain = storeDomainFor(store.store_id);
    return sendAutomated(ctx, {
        store,
        automation: 'test',
        step: Number(stepIndex) || 0,
        sub: { endpoint: subscription.endpoint, keys: subscription.keys },
        refId: automation,
        title: `[Test] ${renderTemplate(cfg.title, vars)}`,
        body: renderTemplate(cfg.body, vars),
        image: cfg.image || null,
        targetUrl: `https://${domain}/`,
        button: cfg.button,
        tag: 'retner-test',
    });
}

async function recordClick(db, logId) {
    const { rows } = await db.query(
        `UPDATE push_automation_log SET clicked_at = COALESCE(clicked_at, NOW()) WHERE id = $1 RETURNING automation, ref_id`,
        [logId]
    );
    const row = rows[0];
    if (row && row.automation === 'abandoned_cart' && row.ref_id) {
        await db.query(`UPDATE push_carts SET clicked_at = COALESCE(clicked_at, NOW()) WHERE id = $1`, [row.ref_id]);
    }
    return row || null;
}

module.exports = {
    DEFAULT_SETTINGS,
    LIMITS,
    ensureSchema,
    normalizeSettings,
    validateAutomationConfig,
    renderTemplate,
    formatMoney,
    buildRestoreUrl,
    storeHomeUrl,
    normalizeCartToken,
    isValidPushEndpoint,
    automationClickUrl,
    verifyAutomationClick,
    campaignClickUrl,
    verifyCampaignClick,
    appendCampaignUtm,
    buildPayload,
    sendPush,
    sendCampaign,
    sendAutomated,
    sendTest,
    runAutomations,
    getDashboard,
    saveAutomation,
    recordClick,
    loadStore,
    activeSubscriptions,
    vapidOptions,
    storeIcon,
};
