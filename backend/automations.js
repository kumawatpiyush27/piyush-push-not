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
const SHOPIFY_CLIENT_ID = () => process.env.SHOPIFY_API_KEY || 'd5c35985fb2e26a210f931c4b6a92c87';
const APP_BASE_URL = () => (process.env.APP_URL || 'https://push-retner.vercel.app').replace(/\/$/, '');

const CART_WINDOW_MIN = 7 * 24 * 60;          // reminders only for carts active in the last 7 days
const BROWSE_WINDOW_MIN = 72 * 60;            // product views older than 72h are ignored
// Welcome text used when the merchant has not written their own. The editor
// shows it, so what the merchant sees is what shoppers get.
const WELCOME_DEFAULT = {
    title: 'Welcome to {store_name}! 🎉',
    body: 'Thanks for subscribing. You will be the first to know about new arrivals and offers.',
};
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
    order_thank_you: {
        enabled: false,
        delay_minutes: 5,
        title: 'Thank you for your order! 💙',
        body: 'We have received your order of {order_total} and are getting it ready.',
        button: 'Shop again',
        discount_code: '',
    },
    price_drop: {
        enabled: false,
        min_drop_percent: 5,
        lookback_days: 14,
        title: 'Price drop on {product_name} 🔥',
        body: 'Now {new_price} (was {old_price}) — {drop_percent}% off. Grab it before the price goes back up!',
        button: 'Shop now',
    },
    back_in_stock: {
        enabled: false,
        lookback_days: 30,
        title: '{product_name} is back in stock! 🎉',
        body: 'It sold out fast last time. Get yours before it is gone again.',
        button: 'Buy now',
    },
};

const DELAY_BOUNDS = {
    abandoned_cart: [15, CART_WINDOW_MIN],
    browse_abandonment: [30, 48 * 60],
    winback_days: [7, 180],
    order_thank_you: [0, 24 * 60],
    price_drop_percent: [1, 90],
    price_drop_days: [1, 60],
    back_in_stock_days: [1, 90],
};

// Product checker (price drop / back in stock).
const PRODUCT_CHECK_INTERVAL_MIN = 60;
const PRODUCT_CHECKS_PER_RUN = 40;
const PRODUCT_CHECK_CONCURRENCY = 6;
const PRODUCT_CHECK_TIMEOUT_MS = 6000;
const PRODUCT_TRACK_DAYS = 30;          // products viewed in the last 30 days are watched
const ATTRIBUTION_DAYS = 7;             // orders within 7 days of a push click count as recovered revenue

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

    if (automation === 'order_thank_you') {
        const r = validateStep({ ...input, enabled: true }, DELAY_BOUNDS.order_thank_you);
        const v = r.value;
        return {
            errors: r.errors,
            value: { enabled, delay_minutes: v.delay_minutes, title: v.title, body: v.body, button: v.button, discount_code: v.discount_code },
        };
    }

    if (automation === 'price_drop' || automation === 'back_in_stock') {
        const r = validateStep({ ...input, enabled: true, delay_minutes: 60 }, [1, 1e9]);
        errors.push(...r.errors);
        const days = Math.round(Number(input && input.lookback_days));
        const [dlo, dhi] = automation === 'price_drop' ? DELAY_BOUNDS.price_drop_days : DELAY_BOUNDS.back_in_stock_days;
        if (!Number.isFinite(days) || days < dlo || days > dhi) errors.push(`"Viewed in the last" must be between ${dlo} and ${dhi} days.`);
        const value = {
            enabled,
            lookback_days: Number.isFinite(days) ? days : dlo,
            title: r.value.title,
            body: r.value.body,
            button: r.value.button,
        };
        if (automation === 'price_drop') {
            const pct = Math.round(Number(input && input.min_drop_percent));
            const [plo, phi] = DELAY_BOUNDS.price_drop_percent;
            if (!Number.isFinite(pct) || pct < plo || pct > phi) errors.push(`Minimum price drop must be between ${plo}% and ${phi}%.`);
            value.min_drop_percent = Number.isFinite(pct) ? pct : 5;
        }
        return { errors, value };
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
           table_name IN ('push_carts','push_product_views','push_automation_log','push_system_state','push_orders','push_products','push_product_events')
           OR (table_name = 'subscriptions' AND column_name IN ('last_seen_at','winback_sent_at','status','expired_at'))
           OR (table_name = 'stores' AND column_name = 'automation_settings'))`
    );
    const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const tablesOk = ['push_carts.id', 'push_product_views.id', 'push_automation_log.id', 'push_system_state.key'].every((k) => have.has(k));
    const colsOk = ['subscriptions.last_seen_at', 'subscriptions.winback_sent_at', 'subscriptions.status', 'subscriptions.expired_at', 'stores.automation_settings'].every((k) => have.has(k));
    const phase2Ok = ['push_orders.id', 'push_products.product_id', 'push_product_events.id'].every((k) => have.has(k));
    if (!tablesOk || !colsOk || !phase2Ok) {
        const fs = require('fs');
        const path = require('path');
        for (const file of ['20261119_automations.sql', '20261119_phase2.sql']) {
            await db.query(fs.readFileSync(path.join(__dirname, 'sql', file), 'utf8'));
        }
    }
    schemaChecked = true;
}

// --------------------------------------------------------------------------
// Sending
// --------------------------------------------------------------------------
// Two VAPID key pairs are in use. The storefront script subscribes browsers
// with the store pair (STORE_VAPID_*); older and dashboard subscriptions were
// made with PUBLIC_KEY/PRIVATE_KEY. A push service rejects a push signed with
// a pair other than the one the subscription was made with, so sendPush tries
// each pair in this order.
function vapidKeyPairs() {
    const pairs = [];
    const add = (publicKey, privateKey) => {
        if (publicKey && privateKey && !pairs.some((p) => p.publicKey === publicKey)) pairs.push({ publicKey, privateKey });
    };
    add(process.env.STORE_VAPID_PUBLIC_KEY, process.env.STORE_VAPID_PRIVATE_KEY);
    add(process.env.PUBLIC_KEY, process.env.PRIVATE_KEY);
    return pairs;
}

// The key new subscriptions should use.
function primaryVapidPublicKey() {
    const first = vapidKeyPairs()[0];
    return first ? first.publicKey : (process.env.PUBLIC_KEY || null);
}

function vapidOptions(store, extra = {}) {
    const email = store && typeof store.store_email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(store.store_email)
        ? `mailto:${store.store_email}` : DEFAULT_SUBJECT;
    const first = vapidKeyPairs()[0] || { publicKey: process.env.PUBLIC_KEY, privateKey: process.env.PRIVATE_KEY };
    return {
        vapidDetails: { subject: email, publicKey: first.publicKey, privateKey: first.privateKey },
        TTL: 24 * 60 * 60,
        ...extra,
    };
}

// 400/401/403 = the push service refused our credentials (FCM: "VAPID
// credentials ... do not correspond", Apple: VapidPkHashMismatch, Mozilla: 401).
function isCredentialRejection(e) {
    return !!e && (e.statusCode === 400 || e.statusCode === 401 || e.statusCode === 403);
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

// Returns { ok, expired, gone, error }. Tries every VAPID pair (see
// vapidKeyPairs) until the push service accepts one.
// `keepOnGone`: a 404/410 is reported as { gone: true } and the subscription
// is NOT marked expired. FCM answers 410 for a subscription created a moment
// ago, so the welcome push must not treat that as an unsubscribe.
async function sendPush(db, webPush, sub, payload, options, { keepOnGone = false } = {}) {
    const base = (options && options.vapidDetails) || {};
    const pairs = vapidKeyPairs();
    const first = pairs.findIndex((p) => p.publicKey === base.publicKey);
    // The pair already in options goes first, then the others.
    const ordered = first > 0 ? [pairs[first], ...pairs.filter((_, i) => i !== first)] : pairs;
    const attempts = ordered.length ? ordered.map((p) => ({ ...options, vapidDetails: { ...base, ...p } })) : [options];
    const body = JSON.stringify(payload);
    let lastError = null;
    for (let i = 0; i < attempts.length; i++) {
        try {
            await webPush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, body, attempts[i]);
            return { ok: true };
        } catch (e) {
            if (e && (e.statusCode === 404 || e.statusCode === 410)) {
                if (keepOnGone) return { ok: false, gone: true, error: `push service not ready (${e.statusCode})` };
                await markExpired(db, sub.endpoint);
                return { ok: false, expired: true, error: `expired (${e.statusCode})` };
            }
            lastError = e;
            if (!isCredentialRejection(e)) break;
        }
    }
    const e = lastError;
    return { ok: false, error: (e && (e.body || e.message)) ? String(e.body || e.message).slice(0, 300) : 'send failed' };
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
async function sendAutomated(ctx, { store, automation, step, sub, refId, title, body, image, targetUrl, button, tag, keepOnGone = false }) {
    const logId = await logStart(ctx.db, { storeId: store.store_id, automation, step, endpoint: sub.endpoint, refId });
    const url = automationClickUrl(logId, targetUrl);
    const payload = buildPayload({ title, body, icon: storeIcon(store), image, url, button, tag, automation, logId });
    const result = await sendPush(ctx.db, ctx.webPush, sub, payload, vapidOptions(store), { keepOnGone });
    await logFinish(ctx.db, logId, result);
    return { ...result, logId };
}

// --------------------------------------------------------------------------
// Welcome notification
// --------------------------------------------------------------------------
const WELCOME_RETRY_MS = [1500, 4000];

// Sends the welcome push to one subscriber. `fresh: true` (right after the
// subscribe call) retries a 404/410 a couple of times and never marks the
// subscription expired: the cron's catch-up (runWelcomeCatchup) sends it a few
// minutes later if the push service still was not ready.
async function sendWelcome(ctx, store, sub, { fresh = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const vars = { store_name: store.store_name || store.store_id };
    const domain = /^[a-z0-9.-]+$/i.test(sub.store_domain || '') ? sub.store_domain : `${store.store_id}.myshopify.com`;
    const message = {
        store,
        automation: 'welcome',
        step: 1,
        sub: { endpoint: sub.endpoint, keys: sub.keys },
        refId: null,
        title: renderTemplate(store.welcome_title || WELCOME_DEFAULT.title, vars),
        body: renderTemplate(store.welcome_body || WELCOME_DEFAULT.body, vars),
        image: null,
        targetUrl: `https://${domain}/?utm_source=retner-push&utm_medium=push&utm_campaign=welcome`,
        button: 'Visit store',
        tag: 'retner-welcome',
        keepOnGone: fresh,
    };
    let result = await sendAutomated(ctx, message);
    for (let i = 0; fresh && result.gone && i < WELCOME_RETRY_MS.length; i++) {
        await sleep(WELCOME_RETRY_MS[i]);
        result = await sendAutomated(ctx, message);
    }
    if (result.ok) await ctx.db.query('UPDATE stores SET welcome_sent_count = COALESCE(welcome_sent_count, 0) + 1 WHERE store_id = $1', [store.store_id]);
    return result;
}

// Welcomes that did not get through right after subscribing (push service not
// ready, server outage): subscribers from the last 24 hours with no delivered
// welcome. A subscription that was marked expired by a 410 within 2 minutes of
// being created is restored first; a 410 now is a real unsubscribe.
async function runWelcomeCatchup(ctx, summary, onlyStore) {
    const { rows: stores } = await ctx.db.query(
        `SELECT store_id, store_name, logo_url, store_email, welcome_enabled, welcome_title, welcome_body
         FROM stores WHERE welcome_enabled = TRUE ${onlyStore ? 'AND store_id = $1' : ''}`,
        onlyStore ? [onlyStore] : []
    );
    for (const store of stores) {
        const { rows: subs } = await ctx.db.query(
            `SELECT s.endpoint, s.keys, s.store_domain, s.status
             FROM subscriptions s
             WHERE s.store_id = $1
               AND s.created_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '24 hours'
               AND s.created_at <= (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 minutes'
               AND NOT EXISTS (SELECT 1 FROM push_automation_log l WHERE l.endpoint = s.endpoint AND l.automation = 'welcome' AND l.status = 'sent')
               AND (SELECT COUNT(*) FROM push_automation_log l WHERE l.endpoint = s.endpoint AND l.automation = 'welcome' AND l.sent_at > (s.created_at AT TIME ZONE 'UTC') + INTERVAL '2 minutes') < 2
               AND (s.status IS DISTINCT FROM 'expired'
                    OR EXISTS (SELECT 1 FROM push_automation_log l WHERE l.endpoint = s.endpoint AND l.automation = 'welcome' AND l.status = 'expired'
                               AND l.sent_at < (s.created_at AT TIME ZONE 'UTC') + INTERVAL '2 minutes'))
             ORDER BY s.created_at ASC
             LIMIT $2`,
            [store.store_id, ctx.perStoreLimit]
        );
        for (const sub of subs) {
            if (!ctx.budget.take()) return;
            if (sub.status === 'expired') {
                await ctx.db.query(`UPDATE subscriptions SET status = NULL, expired_at = NULL WHERE endpoint = $1 AND status = 'expired'`, [sub.endpoint]);
            }
            const r = await sendWelcome(ctx, store, sub);
            if (r.ok) summary.welcome++;
        }
    }
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
// Order thank-you (orders reported by the Retner web pixel)
// --------------------------------------------------------------------------
async function storeCurrency(db, storeId) {
    const { rows } = await db.query(
        `SELECT currency FROM (
           SELECT currency, updated_at AS at FROM push_carts WHERE store_id = $1 AND currency IS NOT NULL
           UNION ALL
           SELECT currency, created_at AS at FROM push_orders WHERE store_id = $1 AND currency IS NOT NULL
         ) c ORDER BY at DESC LIMIT 1`,
        [storeId]
    );
    return (rows[0] && rows[0].currency) || 'INR';
}

async function runOrderThankYou(ctx, store, config, summary) {
    const now = ctx.now;
    const { rows: orders } = await ctx.db.query(
        `SELECT o.id, o.endpoint, o.total_price, o.currency, s.keys, s.store_domain
         FROM push_orders o
         JOIN subscriptions s ON s.endpoint = o.endpoint
         WHERE o.store_id = $1 AND o.thanked_at IS NULL AND o.endpoint IS NOT NULL
           AND o.created_at <= $2 AND o.created_at >= $3
           AND s.status IS DISTINCT FROM 'expired'
         ORDER BY o.created_at ASC
         LIMIT $4`,
        [store.store_id, new Date(now - config.delay_minutes * 60e3), new Date(now - 48 * 3600e3), ctx.perStoreLimit]
    );
    await mapLimit(orders.slice(0, ctx.budget.left()), SEND_CONCURRENCY, async (order) => {
        const claim = await ctx.db.query(`UPDATE push_orders SET thanked_at = $2 WHERE id = $1 AND thanked_at IS NULL RETURNING id`, [order.id, now]);
        if (!claim.rowCount || !ctx.budget.take()) return;
        const domain = storeDomainFor(store.store_id, order.store_domain);
        const vars = {
            store_name: store.store_name || store.store_id,
            order_total: formatMoney(order.total_price, order.currency),
            discount_code: config.discount_code,
        };
        const result = await sendAutomated(ctx, {
            store,
            automation: 'order_thank_you',
            step: 1,
            sub: { endpoint: order.endpoint, keys: order.keys },
            refId: String(order.id),
            title: renderTemplate(config.title, vars),
            body: renderTemplate(config.body, vars),
            image: null,
            targetUrl: storeHomeUrl(domain, config.discount_code, 'order_thank_you'),
            button: config.button,
            tag: `retner-order-${order.id}`,
        });
        if (result.ok) summary.thankYou++;
        else if (!result.expired) summary.errors.push(`order ${order.id}: ${result.error}`);
    });
}

// --------------------------------------------------------------------------
// Product checker: price drop / back in stock
// Uses the store's public /products/<handle>.js (no extra Shopify permissions).
// --------------------------------------------------------------------------
function productHandle(url) {
    const m = typeof url === 'string' && url.match(/\/products\/([^/?#]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]).slice(0, 255); } catch { return null; }
}

function httpsImage(v) {
    if (typeof v !== 'string' || !v) return '';
    const url = v.startsWith('//') ? `https:${v}` : v;
    return isHttpsUrl(url) ? url : '';
}

async function fetchProductJson(fetchImpl, domain, handle) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PRODUCT_CHECK_TIMEOUT_MS);
    try {
        const res = await fetchImpl(`https://${domain}/products/${encodeURIComponent(handle)}.js`, {
            headers: { Accept: 'application/json', 'User-Agent': 'RetnerSmartPush/1.0 (price-drop and back-in-stock alerts)' },
            redirect: 'follow',
            signal: controller.signal,
        });
        if (res.status === 404) return { notFound: true };
        if (res.status === 429) return { rateLimited: true };
        if (!res.ok) return { error: `HTTP ${res.status}` };
        let j;
        try { j = await res.json(); } catch { return { error: 'not JSON (password page?)' }; }
        if (!j || !Number.isSafeInteger(Number(j.id)) || !Number.isFinite(Number(j.price))) return { error: 'not a product' };
        return { product: j };
    } catch (e) {
        return { error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'fetch failed' };
    } finally {
        clearTimeout(timer);
    }
}

// Watches products viewed in the last 30 days for stores that use price drop
// or back in stock, records changes in push_product_events.
async function runProductChecks(ctx, storeSettings, summary) {
    const storeIds = Object.keys(storeSettings);
    if (!storeIds.length) return;
    const now = ctx.now;
    const since = new Date(now - PRODUCT_TRACK_DAYS * 864e5);

    await ctx.db.query(
        `INSERT INTO push_products (store_id, product_id, store_domain, title, image, url, next_check_at)
         SELECT DISTINCT ON (v.store_id, v.product_id)
                v.store_id, v.product_id, v.store_domain, v.product->>'title', v.product->>'image', v.product->>'url', $3
         FROM push_product_views v
         WHERE v.store_id = ANY($1) AND v.viewed_at >= $2
         ORDER BY v.store_id, v.product_id, v.viewed_at DESC
         ON CONFLICT (store_id, product_id) DO NOTHING`,
        [storeIds, since, now]
    );

    const { rows: due } = await ctx.db.query(
        `SELECT p.* FROM push_products p
         WHERE p.store_id = ANY($1) AND p.next_check_at <= $2
           AND EXISTS (SELECT 1 FROM push_product_views v WHERE v.store_id = p.store_id AND v.product_id = p.product_id AND v.viewed_at >= $3)
         ORDER BY p.next_check_at ASC
         LIMIT $4`,
        [storeIds, now, since, PRODUCT_CHECKS_PER_RUN]
    );

    const nextIn = (minutes) => new Date(now.getTime() + minutes * 60e3);
    await mapLimit(due, PRODUCT_CHECK_CONCURRENCY, async (p) => {
        const handle = p.handle || productHandle(p.url);
        const fail = async (error, minutes) => {
            await ctx.db.query(
                `UPDATE push_products SET check_failures = check_failures + 1, last_error = $3, next_check_at = $4 WHERE store_id = $1 AND product_id = $2`,
                [p.store_id, p.product_id, String(error).slice(0, 200), nextIn(minutes)]
            );
            summary.productCheckErrors++;
        };
        if (!handle) return fail('no product handle', 7 * 1440);

        const domain = storeDomainFor(p.store_id, p.store_domain);
        const r = await fetchProductJson(ctx.fetch, domain, handle);
        summary.productChecks++;
        if (r.notFound) return fail('product not found', 1440);
        if (r.rateLimited) return fail('rate limited', 120);
        if (r.error) return fail(r.error, Math.min(1440, PRODUCT_CHECK_INTERVAL_MIN * 2 ** Math.min(5, p.check_failures + 1)));

        const j = r.product;
        if (String(j.id) !== String(p.product_id)) return fail('handle now points to another product', 1440);

        const price = Math.round(Number(j.price));
        const available = !!j.available;
        const cfg = storeSettings[p.store_id];
        const hasBaseline = p.last_checked_at !== null && p.price !== null;

        if (hasBaseline && cfg.price_drop.enabled) {
            const old = Number(p.price);
            if (old > 0 && price > 0 && price <= old * (1 - cfg.price_drop.min_drop_percent / 100)) {
                await ctx.db.query(
                    `INSERT INTO push_product_events (store_id, product_id, type, old_price, new_price) VALUES ($1, $2, 'price_drop', $3, $4)`,
                    [p.store_id, p.product_id, old, price]
                );
                summary.priceDrops++;
            }
        }
        if (hasBaseline && cfg.back_in_stock.enabled && p.available === false && available) {
            await ctx.db.query(
                `INSERT INTO push_product_events (store_id, product_id, type, new_price, out_of_stock_since) VALUES ($1, $2, 'back_in_stock', $3, $4)`,
                [p.store_id, p.product_id, price, p.out_of_stock_since]
            );
            summary.restocks++;
        }

        await ctx.db.query(
            `UPDATE push_products SET
               handle = $3, title = $4, image = $5, url = $6, price = $7, compare_at_price = $8, available = $9,
               out_of_stock_since = CASE WHEN $9 THEN NULL ELSE COALESCE(out_of_stock_since, $10) END,
               first_checked_at = COALESCE(first_checked_at, $10), last_checked_at = $10,
               next_check_at = $11, check_failures = 0, last_error = NULL
             WHERE store_id = $1 AND product_id = $2`,
            [p.store_id, p.product_id, handle, clampStr(j.title, 150) || p.title, httpsImage(j.featured_image) || p.image,
             typeof j.url === 'string' && j.url.startsWith('/') ? j.url.split('?')[0] : `/products/${handle}`,
             price, Number.isFinite(Number(j.compare_at_price)) && j.compare_at_price !== null ? Math.round(Number(j.compare_at_price)) : null,
             available, now, nextIn(PRODUCT_CHECK_INTERVAL_MIN)]
        );
    });
}

// Sends notifications for detected price drops / restocks of one store.
async function runProductEvents(ctx, store, settings, summary) {
    const now = ctx.now;
    const { rows: events } = await ctx.db.query(
        `SELECT e.*, p.title, p.image, p.url, p.store_domain
         FROM push_product_events e
         JOIN push_products p ON p.store_id = e.store_id AND p.product_id = e.product_id
         WHERE e.store_id = $1 AND e.processed_at IS NULL
         ORDER BY e.created_at ASC
         LIMIT 20`,
        [store.store_id]
    );
    if (!events.length) return;
    const currency = await storeCurrency(ctx.db, store.store_id);

    for (const ev of events) {
        const claim = await ctx.db.query(`UPDATE push_product_events SET processed_at = $2 WHERE id = $1 AND processed_at IS NULL RETURNING id`, [ev.id, now]);
        if (!claim.rowCount) continue;
        const cfg = settings[ev.type];
        if (!cfg || !cfg.enabled) {
            await ctx.db.query(`UPDATE push_product_events SET recipients = 0 WHERE id = $1`, [ev.id]);
            continue;
        }
        let viewedAfter = new Date(now - cfg.lookback_days * 864e5);
        if (ev.type === 'back_in_stock' && ev.out_of_stock_since) {
            // Only people who looked at it while it was sold out (1h tolerance).
            const oos = new Date(new Date(ev.out_of_stock_since).getTime() - 3600e3);
            if (oos > viewedAfter) viewedAfter = oos;
        }
        const { rows: recipients } = await ctx.db.query(
            `SELECT DISTINCT ON (v.endpoint) v.endpoint, s.keys, s.store_domain
             FROM push_product_views v
             JOIN subscriptions s ON s.endpoint = v.endpoint
             WHERE v.store_id = $1 AND v.product_id = $2 AND v.viewed_at >= $3 AND v.viewed_at <= $4
               AND s.status IS DISTINCT FROM 'expired'
               AND NOT EXISTS (
                 SELECT 1 FROM push_automation_log l
                 WHERE l.endpoint = v.endpoint AND l.automation = $5 AND l.ref_id = $2 AND l.status = 'sent' AND l.sent_at >= $6)
               AND NOT EXISTS (
                 SELECT 1 FROM push_orders o
                 WHERE o.endpoint = v.endpoint AND o.store_id = v.store_id AND o.created_at >= v.viewed_at
                   AND o.items @> jsonb_build_array(jsonb_build_object('product_id', $2::text)))
             ORDER BY v.endpoint, v.viewed_at DESC
             LIMIT $7`,
            [store.store_id, ev.product_id, viewedAfter, ev.created_at, ev.type, new Date(now - 7 * 864e5), ctx.perStoreLimit]
        );
        const capped = await cappedEndpoints(ctx.db, recipients.map((r) => r.endpoint), now);
        const send = recipients.filter((r) => !capped.has(r.endpoint)).slice(0, ctx.budget.left());

        const domainBase = storeDomainFor(store.store_id, ev.store_domain);
        const path = typeof ev.url === 'string' && ev.url.startsWith('/') ? ev.url : '/';
        const oldP = Number(ev.old_price) / 100;
        const newP = Number(ev.new_price) / 100;
        const vars = {
            product_name: ev.title || 'Your product',
            store_name: store.store_name || store.store_id,
            old_price: ev.old_price !== null ? formatMoney(oldP, currency) : '',
            new_price: ev.new_price !== null ? formatMoney(newP, currency) : '',
            drop_percent: ev.old_price ? Math.round((1 - Number(ev.new_price) / Number(ev.old_price)) * 100) : '',
        };
        let sent = 0;
        await mapLimit(send, SEND_CONCURRENCY, async (r) => {
            if (!ctx.budget.take()) return;
            const domain = storeDomainFor(store.store_id, r.store_domain, domainBase);
            const result = await sendAutomated(ctx, {
                store,
                automation: ev.type,
                step: 1,
                sub: { endpoint: r.endpoint, keys: r.keys },
                refId: String(ev.product_id),
                title: renderTemplate(cfg.title, vars),
                body: renderTemplate(cfg.body, vars),
                image: ev.image,
                targetUrl: withParams(`https://${domain}${path}`, utm(ev.type)),
                button: cfg.button,
                tag: `retner-${ev.type}-${ev.product_id}`,
            });
            if (result.ok) sent++;
            else if (!result.expired) summary.errors.push(`${ev.type} ${ev.product_id}: ${result.error}`);
        });
        await ctx.db.query(`UPDATE push_product_events SET recipients = $2 WHERE id = $1`, [ev.id, sent]);
        if (ev.type === 'price_drop') summary.priceDropPushes += sent;
        else summary.restockPushes += sent;
    }
}

// --------------------------------------------------------------------------
// Campaigns (broadcasts) — shared by "send now" and the scheduler
// --------------------------------------------------------------------------
// Audience segments for campaigns. `where` is appended to a query over
// subscriptions aliased as `s` (store + not expired already applied).
const BROWSER_SQL = `CASE WHEN s.endpoint ILIKE '%fcm.googleapis%' OR s.endpoint ILIKE '%android.googleapis%' THEN 'chrome'
                          WHEN s.endpoint ILIKE '%mozilla%' THEN 'firefox' WHEN s.endpoint ILIKE '%apple%' THEN 'safari'
                          WHEN s.endpoint ILIKE '%windows.com%' THEN 'edge' ELSE 'other' END`;
const SEGMENTS = {
    all: { name: 'All subscribers', desc: 'Everyone with notifications on.', where: '' },
    active_7d: { name: 'Active in the last 7 days', desc: 'Visited your store this week.', where: `AND s.last_seen_at >= NOW() - INTERVAL '7 days'` },
    active_30d: { name: 'Active in the last 30 days', desc: 'Visited your store this month.', where: `AND s.last_seen_at >= NOW() - INTERVAL '30 days'` },
    new_7d: { name: 'New this week', desc: 'Subscribed in the last 7 days.', where: `AND s.created_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days'` },
    inactive_30d: { name: 'Inactive for 30+ days', desc: 'Have not visited for a month. Good for win-back offers.', where: `AND (s.last_seen_at IS NULL OR s.last_seen_at < NOW() - INTERVAL '30 days')` },
    cart_30d: { name: 'Added to cart recently', desc: 'Put something in their cart in the last 30 days.', where: `AND EXISTS (SELECT 1 FROM push_carts c WHERE c.endpoint = s.endpoint AND c.updated_at >= NOW() - INTERVAL '30 days')` },
    buyers_30d: { name: 'Bought recently', desc: 'Placed an order in the last 30 days.', where: `AND EXISTS (SELECT 1 FROM push_orders o WHERE o.endpoint = s.endpoint AND o.created_at >= NOW() - INTERVAL '30 days')` },
    chrome: { name: 'Chrome users', desc: 'Android and desktop Chrome.', where: `AND ${BROWSER_SQL} = 'chrome'` },
    safari: { name: 'Safari / iPhone users', desc: 'Apple devices.', where: `AND ${BROWSER_SQL} = 'safari'` },
    firefox: { name: 'Firefox users', desc: '', where: `AND ${BROWSER_SQL} = 'firefox'` },
    edge: { name: 'Edge users', desc: '', where: `AND ${BROWSER_SQL} = 'edge'` },
};
function segmentWhere(key) {
    const seg = SEGMENTS[key || 'all'];
    return seg ? seg.where : null;
}

async function activeSubscriptions(db, storeId, segment = 'all') {
    const where = segmentWhere(segment);
    if (where === null) throw new Error(`Unknown segment: ${segment}`);
    const { rows } = await db.query(
        `SELECT s.endpoint, s.keys FROM subscriptions s WHERE s.store_id = $1 AND s.status IS DISTINCT FROM 'expired' ${where}`,
        [storeId]
    );
    return rows;
}

// Subscriber count per segment, for the audience picker.
async function countSegments(db, storeId) {
    const keys = Object.keys(SEGMENTS);
    const cols = keys.map((k, i) => `COUNT(*) FILTER (WHERE TRUE ${SEGMENTS[k].where})::int AS c${i}`).join(', ');
    const { rows } = await db.query(`SELECT ${cols} FROM subscriptions s WHERE s.store_id = $1 AND s.status IS DISTINCT FROM 'expired'`, [storeId]);
    return keys.map((k, i) => ({ key: k, name: SEGMENTS[k].name, desc: SEGMENTS[k].desc, count: rows[0] ? rows[0][`c${i}`] : 0 }));
}

function appendCampaignUtm(url, campaignId) {
    if (!url) return url;
    return withParams(url, { utm_source: 'push-retner', utm_medium: 'push', utm_campaign: `push_camp_${campaignId}` });
}

// Buttons come from the caller or, for scheduled campaigns, from the
// campaign row (campaigns.buttons), so they are not lost while waiting.
function campaignButtons(camp, given) {
    if (given && (given.btn1Text || given.btn2Text)) return given;
    let b = camp && camp.buttons;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
    return b && typeof b === 'object' ? b : {};
}

async function sendCampaign(ctx, store, camp, buttons) {
    const { btn1Text, btn1Url, btn2Text, btn2Url } = campaignButtons(camp, buttons);
    const subs = await activeSubscriptions(ctx.db, camp.store_id, SEGMENTS[camp.segment] ? camp.segment : 'all');
    const mainUrl = campaignClickUrl(camp.id, appendCampaignUtm(camp.url, camp.id) || `https://${camp.store_id}.myshopify.com/`);
    const actions = [];
    if (btn1Text) actions.push({ action: 'b1', title: clampStr(btn1Text, LIMITS.button), url: campaignClickUrl(camp.id, appendCampaignUtm(btn1Url || camp.url, camp.id)) });
    if (btn2Text) actions.push({ action: 'b2', title: clampStr(btn2Text, LIMITS.button), url: campaignClickUrl(camp.id, appendCampaignUtm(btn2Url || camp.url, camp.id)) });

    const payload = {
        title: camp.title,
        body: camp.message,
        icon: isHttpsUrl(camp.icon) ? camp.icon : storeIcon(store),
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
    // A flash sale whose offer has already ended is not sent at all.
    const ended = await ctx.db.query(
        `UPDATE campaigns SET status = 'expired'
         WHERE status = 'scheduled' AND expiry_at IS NOT NULL AND expiry_at <= NOW() ${onlyStore ? 'AND store_id = $1' : ''}`,
        params
    );
    summary.expiredCampaigns = ended.rowCount;
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

async function runAutomations({ db, webPush, now = new Date(), onlyStore = null, budget = 1500, perStoreLimit = 300, fetch: fetchImpl = globalThis.fetch } = {}) {
    await ensureSchema(db);
    const ctx = { db, webPush, now, budget: makeBudget(budget), perStoreLimit, fetch: fetchImpl };
    const summary = {
        scheduledCampaigns: 0, expiredCampaigns: 0, campaignPushes: 0, welcome: 0, abandoned: 0, browse: 0, winback: 0, thankYou: 0,
        productChecks: 0, productCheckErrors: 0, priceDrops: 0, restocks: 0, priceDropPushes: 0, restockPushes: 0,
        expiredCarts: 0, stores: 0, errors: [],
    };

    await runScheduledCampaigns(ctx, summary, onlyStore);
    try { await runWelcomeCatchup(ctx, summary, onlyStore); } catch (e) { summary.errors.push(`welcome catch-up: ${e.message}`); }

    const { rows: stores } = await db.query(
        `SELECT store_id, store_name, logo_url, store_email, automation_settings, abandoned_config
         FROM stores WHERE automation_settings IS NOT NULL ${onlyStore ? 'AND store_id = $1' : ''}`,
        onlyStore ? [onlyStore] : []
    );
    const settingsByStore = new Map(stores.map((s) => [s.store_id, normalizeSettings(s)]));

    // Check watched products first so drops/restocks found now are sent in this run.
    const productStores = {};
    for (const [id, st] of settingsByStore) if (st.price_drop.enabled || st.back_in_stock.enabled) productStores[id] = st;
    try { await runProductChecks(ctx, productStores, summary); } catch (e) { summary.errors.push(`product checks: ${e.message}`); }

    for (const store of stores) {
        const settings = settingsByStore.get(store.store_id);
        const tasks = [];
        if (settings.abandoned_cart.enabled && !settings.abandoned_cart.needs_review) tasks.push(() => runAbandonedCart(ctx, store, settings.abandoned_cart, summary));
        if (settings.browse_abandonment.enabled) tasks.push(() => runBrowseAbandonment(ctx, store, settings.browse_abandonment, summary));
        if (settings.winback.enabled) tasks.push(() => runWinback(ctx, store, settings.winback, summary));
        if (settings.order_thank_you.enabled) tasks.push(() => runOrderThankYou(ctx, store, settings.order_thank_you, summary));
        if (productStores[store.store_id]) tasks.push(() => runProductEvents(ctx, store, settings, summary));
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
    const [statsRes, subsRes, trackRes, cronRes, legacyRes, revenueRes, ordersRes, pixelRes, productsRes, currency] = await Promise.all([
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
        db.query(
            `SELECT attributed_automation AS automation, COUNT(*) AS orders, COALESCE(SUM(total_price), 0) AS revenue
             FROM push_orders WHERE store_id = $1 AND created_at >= $2 AND attributed_automation IS NOT NULL GROUP BY attributed_automation`,
            [storeId, since]
        ),
        db.query(`SELECT COUNT(*) AS n FROM push_orders WHERE store_id = $1 AND created_at >= NOW() - INTERVAL '7 days'`, [storeId]),
        db.query(`SELECT value, updated_at FROM push_system_state WHERE key = $1`, [`pixel:${storeId}`]),
        db.query(
            `SELECT COUNT(*) FILTER (WHERE last_checked_at >= NOW() - INTERVAL '2 days') AS watched,
                    COUNT(*) FILTER (WHERE available = FALSE) AS sold_out
             FROM push_products WHERE store_id = $1`,
            [storeId]
        ),
        storeCurrency(db, storeId),
    ]);

    const stats = {};
    for (const r of statsRes.rows) stats[r.automation] = { sent: Number(r.sent), clicks: Number(r.clicks) };
    for (const r of revenueRes.rows) {
        stats[r.automation] = { sent: 0, clicks: 0, ...(stats[r.automation] || {}), orders: Number(r.orders), revenue: Number(r.revenue) };
    }
    const legacy = legacyRes.rows[0] || {};
    stats.welcome = {
        sent: (stats.welcome ? stats.welcome.sent : 0),
        clicks: (stats.welcome ? stats.welcome.clicks : 0),
        sent_all_time: Number(legacy.welcome_sent_count || 0),
        orders: stats.welcome ? stats.welcome.orders || 0 : 0,
        revenue: stats.welcome ? stats.welcome.revenue || 0 : 0,
    };
    const pixel = pixelRes.rows[0];
    const pixelValue = pixel && pixel.value ? pixel.value : {};
    const products = productsRes.rows[0] || {};

    const subs = subsRes.rows[0] || {};
    const track = trackRes.rows[0] || {};
    const cron = cronRes.rows[0];
    const cronAgeMin = cron ? (Date.now() - new Date(cron.updated_at).getTime()) / 60e3 : null;

    return {
        automations: {
            welcome: { enabled: !!store.welcome_enabled, title: store.welcome_title || WELCOME_DEFAULT.title, body: store.welcome_body || WELCOME_DEFAULT.body },
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
            order_detection: !!pixelValue.active,
            order_detection_checked_at: pixel ? pixel.updated_at : null,
            orders_tracked_7d: Number((ordersRes.rows[0] || {}).n || 0),
            products_watched: Number(products.watched || 0),
            products_sold_out: Number(products.sold_out || 0),
            order_detection_setup_url: `https://${storeId}.myshopify.com/admin/apps/${SHOPIFY_CLIENT_ID()}/app/additional`,
        },
        currency,
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
        source = { title: store.welcome_title || WELCOME_DEFAULT.title, body: store.welcome_body || WELCOME_DEFAULT.body };
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
        order_total: formatMoney(1299, 'INR'),
        old_price: formatMoney(1499, 'INR'),
        new_price: formatMoney(1199, 'INR'),
        drop_percent: 20,
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
    CART_WINDOW_MIN,
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
    campaignButtons,
    SEGMENTS,
    segmentWhere,
    countSegments,
    sendWelcome,
    runWelcomeCatchup,
    WELCOME_DEFAULT,
    vapidKeyPairs,
    primaryVapidPublicKey,
    storeIcon,
};
