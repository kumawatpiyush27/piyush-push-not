// Push Notification Backend - CLEANED & FIXED - Vercel Force Update

require('dotenv').config();
const express = require('express');
const webPush = require('web-push');
const path = require('path');
const crypto = require('crypto'); // Restored for HMAC
const jwt = require('jsonwebtoken'); // Added for SSO
const SubscriptionModel = require('./subscriptionModel');
const cors = require('cors');
const { Pool } = require('pg');
const automations = require('./automations');
const auth = require('./auth');
const { SERVICE_WORKER_SOURCE } = require('./sw-source');
const media = require('./media');
const analytics = require('./analytics');
const usage = require('./usage');
const plans = require('./plans');
const entitlements = require('./entitlements');
const tips = require('./tips');
const popups = require('./popups');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
// Browsers ask for /favicon.ico on every dashboard page; use the Retner logo.
app.get('/favicon.ico', (req, res) => res.redirect(301, '/logo.png'));

// Database Pool
// Database Pool (Lazy Init)
let pool;
const getPool = () => {
    if (!pool) {
        if (!process.env.DATABASE_URL) {
            console.error("❌ DATABASE_URL is missing!");
            throw new Error("DATABASE_URL is missing");
        }
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false }
        });
    }
    return pool;
};

// Init Campaign Table
const initCampaignTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS campaigns (
            id SERIAL PRIMARY KEY,
            store_id TEXT,
            title TEXT,
            message TEXT,
            url TEXT,
            image TEXT,
            sent_count INTEGER,
            clicks INTEGER DEFAULT 0,
            revenue DECIMAL(10,2) DEFAULT 0.00
        );
    `;
    try {
        await getPool().query(query);

        // Migration for existing tables
        try {
            await getPool().query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS clicks INTEGER DEFAULT 0');
            await getPool().query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS revenue DECIMAL(10,2) DEFAULT 0.00');
            await getPool().query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS buttons JSONB');
            await getPool().query('ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS segment TEXT');
            console.log('✅ Campaigns table migrated');
        } catch (e) { console.log('Migration note:', e.message); }

    } catch (e) { console.error('❌ Campaign table error:', e); }
};
// Init Stores Table
const initStoresTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS stores (
            id SERIAL PRIMARY KEY,
            store_id TEXT UNIQUE,
            password TEXT,
            store_name TEXT,
            created_at TIMESTAMP DEFAULT NOW()
        );
    `;
    try { 
        await getPool().query(query); 
        console.log('✅ Stores table ready'); 
        // Migration: Add direct_prompt_enabled
        try {
            await getPool().query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS direct_prompt_enabled BOOLEAN DEFAULT FALSE');
            console.log('✅ Stores table migrated: direct_prompt_enabled added');
        } catch(e) { console.log('Migration note (stores):', e.message); }
    }
    catch (e) { console.error('❌ Stores table error:', e); }
};

// Init Checkouts Table for 3-Step Automations
const initCheckoutsTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS abandoned_checkouts (
            id SERIAL PRIMARY KEY,
            store_id TEXT,
            checkout_id TEXT UNIQUE,
            token TEXT,
            cart_url TEXT,
            email TEXT,
            updated_at TIMESTAMP,
            reminder_1_sent BOOLEAN DEFAULT FALSE,
            reminder_2_sent BOOLEAN DEFAULT FALSE,
            reminder_3_sent BOOLEAN DEFAULT FALSE
        );
    `;
    try { await getPool().query(query); console.log('✅ Checkouts table ready'); }
    catch (e) { console.error('❌ Checkouts table error:', e); }
};

// Service Worker - Serve Directly
app.get('/sw.js', (req, res) => {
    res.set('Service-Worker-Allowed', '/');
    res.set('Content-Type', 'application/javascript');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'); // Force no cache
    res.status(200).send(SERVICE_WORKER_SOURCE);
});

// --- ANALYTICS TRACKING ROUTES ---

// Legacy click counter (old service workers). Clicks are now counted by the
// signed /track-click redirect, so this only accepts real campaign ids.
app.get('/api/track/click', async (req, res) => {
    const id = parseInt(req.query.id, 10);
    if (!Number.isSafeInteger(id)) return res.status(400).send('Missing ID');
    res.status(200).send('OK');
});

// --- SHOPIFY WEBHOOK HELPERS & GDPR ---
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    if (!hmac) return res.status(400).send('Missing HMAC header');
    try {
        const generatedHash = crypto
            .createHmac('sha256', process.env.SHOPIFY_API_SECRET || '')
            .update(req.rawBody)
            .digest('base64');
        if (generatedHash !== hmac) {
            return res.status(400).send('HMAC validation failed');
        }
        next();
    } catch (e) {
        console.error("HMAC Error:", e);
        return res.status(500).send("Server Error Verification");
    }
};

// MANDATORY GDPR WEBHOOKS
app.post('/webhooks/shopify/redact/customer', verifyShopifyWebhook, (req, res) => res.status(200).send());
app.post('/webhooks/shopify/redact/shop', verifyShopifyWebhook, (req, res) => res.status(200).send());
app.post('/webhooks/shopify/data/customer', verifyShopifyWebhook, (req, res) => res.status(200).send());

// 2. Track Revenue (Shopify Webhook)
app.post('/webhooks/shopify/order', verifyShopifyWebhook, async (req, res) => {
    console.log('Webhook Received: Order Create (Verified)');
    try {
        const { id, total_price, landing_site, landing_site_ref, checkout_id, checkout_token, cart_token } = req.body;

        const db = getPool();
        
        // 0. Stop cart reminders for carts that turned into an order
        try {
            const token = automations.normalizeCartToken(cart_token);
            if (token) {
                await db.query(`UPDATE push_carts SET status = 'purchased' WHERE cart_token = $1 AND status = 'active'`, [token]);
            }
        } catch(err) { console.error('Failed to mark cart purchased:', err.message); }

        // 1. Identify Campaign
        let campaignId = null;
        const urlToCheck = landing_site || landing_site_ref || '';
        const match = urlToCheck.match(/push_camp_(\d+)/);

        if (match && match[1]) {
            campaignId = parseInt(match[1]);
            console.log(`💰 Attributing Order ${id} to Campaign ${campaignId}. Value: ${total_price}`);

            const db = getPool();
            // Update Revenue (Add to existing)
            await db.query('UPDATE campaigns SET revenue = revenue + $1 WHERE id = $2', [parseFloat(total_price || 0), campaignId]);

            // 2. TAG ORDER on Shopify (Via Remix App)
            const shopDomain = req.headers['x-shopify-shop-domain'];

            if (shopDomain) {
                // Call Remix App Internal API to Tag
                fetch('https://retner-smart-push.vercel.app/api/mark-push-order', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ shop: shopDomain, orderId: id })
                }).catch(err => console.error('Tagging Call Failed:', err.message));
            }
        } else {
            console.log('No Push Attribution found for Order', id);
        }
        res.status(200).send('OK');
    } catch (e) {
        console.error('Webhook Error', e);
        res.status(500).send('Error');
    }
});

// Root
app.get('/', (req, res) => {
    res.json({ status: 'running', service: 'Push Notification API' });
});

// Admin Redirect
app.get('/admin', (req, res) => {
    res.redirect('/store-admin');
});

// Legacy direct subscribe endpoints (the Shopify app proxy handles real
// storefront traffic). Only real Web Push endpoints are accepted.
async function legacySubscribe(req, res) {
    try {
        if (!automations.isValidPushEndpoint(req.body && req.body.endpoint) || !req.body.keys) {
            return res.status(400).json({ success: false, error: 'Invalid subscription' });
        }
        await SubscriptionModel.create({ ...req.body, cartToken: automations.normalizeCartToken(req.body.cartToken) });
        res.json({ success: true });
    } catch (err) {
        console.error('Subscribe error:', err.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
}
app.post('/subscribe', legacySubscribe);
app.post('/apps/push/subscribe', legacySubscribe);

app.post('/apps/push/link-cart', async (req, res) => {
    try {
        const { endpoint, cartToken, customerId } = req.body || {};
        const token = automations.normalizeCartToken(cartToken);
        if (!automations.isValidPushEndpoint(endpoint) || !token) return res.status(400).json({ error: 'Missing endpoint or cartToken' });
        await getPool().query(
            'UPDATE subscriptions SET cart_token = $1, customer_id = COALESCE($2, customer_id), last_seen_at = NOW() WHERE endpoint = $3',
            [token, customerId ? String(customerId).slice(0, 40) : null, endpoint]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('Link cart error:', error.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /apps/push/config (For Extension)
app.get('/apps/push/config', async (req, res) => {
    try {
        const { shop } = req.query;
        if (!shop) return res.json({ success: false, error: 'No shop provided' });

        const shopHandle = shop.split('.')[0];
        const db = getPool();
        const result = await db.query('SELECT direct_prompt_enabled FROM stores WHERE store_id = $1', [shopHandle]);
        
        if (result.rows.length > 0) {
            res.json({ 
                success: true, 
                direct_prompt_enabled: result.rows[0].direct_prompt_enabled 
            });
        } else {
            res.json({ success: true, direct_prompt_enabled: false });
        }
    } catch (error) {
        console.error('Config fetch error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =====================================================
// 🔐 STORE AUTHENTICATION
// =====================================================

const OPEN_FROM_SHOPIFY = 'Open the dashboard from your Shopify admin: Apps → Retner SmartPush → Open Dashboard.';

function storeSessionPayload(storeId, storeName) {
    return {
        id: storeId,
        name: storeName || storeId,
        domain: `${storeId}.myshopify.com`,
        token: auth.issueStoreToken(storeId),
    };
}

// Login with a dashboard password (set from Settings after opening the
// dashboard from Shopify). There is no master password.
app.post('/store-login', async (req, res) => {
    const storeId = String((req.body && req.body.storeId) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');
    try {
        await initStoresTable();
        const db = getPool();
        const result = await db.query('SELECT store_id, store_name, password FROM stores WHERE store_id = $1', [storeId]);
        const store = result.rows[0];
        const check = store ? auth.verifyPassword(store.password, password) : { ok: false };
        if (!check.ok) {
            return res.status(401).json({ success: false, error: `Invalid store ID or password. ${OPEN_FROM_SHOPIFY}` });
        }
        if (check.needsUpgrade) {
            await db.query('UPDATE stores SET password = $2 WHERE store_id = $1', [storeId, auth.hashPassword(password)]);
        }
        res.json({ success: true, store: storeSessionPayload(storeId, store.store_name) });
    } catch (err) {
        console.error('Login Server Error:', err.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// Self-registration is disabled: anyone could have registered (or
// re-registered) any store id. Accounts are created by opening the dashboard
// from the Shopify app.
app.post('/store-register', (req, res) => {
    res.status(403).json({ success: false, error: `New accounts are created automatically. ${OPEN_FROM_SHOPIFY}` });
});

// Passwords are never revealed.
app.post('/store-forgot', (req, res) => {
    res.json({ success: false, error: `For security, passwords can't be shown. ${OPEN_FROM_SHOPIFY} Then set a new password in Settings.` });
});

// Campaign click tracking. Links are signed so this cannot be abused as an
// open redirect; unsigned (old) links show a confirmation page instead.
app.get('/track-click', async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';
    const c = req.query.c;
    let target;
    try { target = new URL(url); } catch { return res.status(400).send('Invalid link'); }
    if (!/^https?:$/.test(target.protocol)) return res.status(400).send('Invalid link');

    if (c && automations.verifyCampaignClick(c, url, req.query.s)) {
        const cid = parseInt(c, 10);
        const db = getPool();
        Promise.all([
            db.query('UPDATE campaigns SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1', [cid]),
            db.query('INSERT INTO push_campaign_clicks (campaign_id, store_id) SELECT id, store_id FROM campaigns WHERE id = $1', [cid]),
        ]).catch((e) => console.error('Click tracking error:', e.message));
        return res.redirect(302, url);
    }
    const safe = target.toString().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    res.status(200).send(`<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Continue</title>
<div style="font-family:sans-serif;max-width:480px;margin:60px auto;padding:0 16px;text-align:center">
<p>You are leaving Retner SmartPush.</p><p style="word-break:break-all;color:#555">${safe}</p>
<a href="${safe}" rel="noopener noreferrer" style="display:inline-block;margin-top:12px;padding:10px 18px;background:#2563EB;color:#fff;border-radius:6px;text-decoration:none">Continue</a></div>`);
});

// Automation click tracking (signed links from automated pushes).
app.get('/n/c', async (req, res) => {
    const logId = parseInt(req.query.l, 10);
    const url = typeof req.query.u === 'string' ? req.query.u : '';
    if (!Number.isSafeInteger(logId) || !automations.verifyAutomationClick(logId, url, req.query.s)) {
        return res.status(400).send('Invalid link');
    }
    try { await automations.recordClick(getPool(), logId); } catch (e) { console.error('Automation click error:', e.message); }
    res.redirect(302, url);
});

// Uploaded images (campaign images, icons, logos). Public on purpose: push
// services and shoppers' browsers download them. Ids are unguessable hashes.
app.get('/m/:file', async (req, res) => {
    const m = String(req.params.file).match(/^([a-f0-9]{32})[.](jpg|png|webp)$/);
    if (!m) return res.status(404).send('Not found');
    try {
        const img = await media.loadImage(getPool(), m[1]);
        if (!img) return res.status(404).send('Not found');
        res.set('Content-Type', img.mime);
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
        res.set('CDN-Cache-Control', 'public, max-age=31536000, immutable');
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(img.bytes);
    } catch (e) {
        console.error('Image serve error:', e.message);
        res.status(500).send('Error');
    }
});

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: automations.primaryVapidPublicKey() });
});

// The dashboard is a static app (backend/public/app). The store session from
// an SSO link is injected into it; otherwise it uses the saved session or
// shows the login screen.
const DASHBOARD_FILE = path.join(__dirname, 'public', 'app', 'index.html');
let dashboardCache = null;
function dashboardHtml(injectedStore) {
    if (!dashboardCache || process.env.NODE_ENV !== 'production') dashboardCache = require('fs').readFileSync(DASHBOARD_FILE, 'utf8');
    const payload = injectedStore ? JSON.stringify(injectedStore).replace(/</g, '\\u003c') : 'null';
    return dashboardCache.replace('"__RETNER_STORE_JSON__"', payload);
}

// Store Admin Dashboard (SSO enabled)
app.get('/store-admin', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    // SSO Handling: Check for Token from Shopify App
    let injectedStore = null;
    if (req.query.sso_token) {
        try {
            const decoded = auth.verifySsoToken(String(req.query.sso_token));
            const shopId = decoded.shop.split('.')[0].toLowerCase(); // 'example' from 'example.myshopify.com'
            let storeName = shopId;

            // Create the account on first open; keep an existing name/password.
            try {
                const db = getPool();
                const r = await db.query(`
                    INSERT INTO stores (store_id, store_name, password)
                    VALUES ($1, $1, $2)
                    ON CONFLICT (store_id) DO UPDATE SET store_id = EXCLUDED.store_id
                    RETURNING store_name
                 `, [shopId, auth.SSO_MANAGED]);
                if (r.rows[0] && r.rows[0].store_name) storeName = r.rows[0].store_name;
            } catch (dbErr) {
                console.error("⚠️ SSO DB Upsert Error:", dbErr.message);
            }
            injectedStore = storeSessionPayload(shopId, storeName);
        } catch (e) {
            console.error("❌ SSO Verification Failed:", e.message);
            return res.status(401).send(`<div style="padding:50px; text-align:center; font-family:sans-serif;">
                <h1>Your login link has expired</h1>
                <p>Please open the dashboard again from your Shopify admin (Apps → Retner SmartPush).</p>
                <a href="/store-admin">Go to Login</a>
            </div>`);
        }
    }

    res.send(dashboardHtml(injectedStore));
});

// Every /my-store/* route requires a valid store session; the store id is
// taken from the session token (see auth.requireStore).
app.use('/my-store', auth.requireStore);

// Image upload: raw JPG/PNG/WebP body (the dashboard resizes it first).
// Images this store uploaded before (campaign heroes, icons, logos), newest first.
app.get('/my-store/media', async (req, res) => {
    try {
        res.json({ success: true, images: await media.listImages(getPool(), req.storeId, req.query.limit) });
    } catch (e) {
        console.error('Media list error:', e.message);
        res.status(500).json({ success: false, images: [], error: 'Could not load your images.' });
    }
});

app.post('/my-store/media', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2560kb' }), async (req, res) => {
    try {
        if (!Buffer.isBuffer(req.body) || !req.body.length) {
            return res.status(400).json({ success: false, error: 'Only JPG, PNG and WebP images are supported.' });
        }
        const result = await media.saveImage(getPool(), req.storeId, req.body, String(req.query.purpose || ''));
        if (!result.ok) return res.status(400).json({ success: false, error: result.error });
        res.json({ success: true, url: result.url, width: result.width, height: result.height, size: result.size });
    } catch (e) {
        console.error('Upload error:', e.message);
        res.status(500).json({ success: false, error: 'Upload failed. Please try again.' });
    }
});

// Analytics, cart recovery list and live event feed (all scoped to the session store).
app.get('/my-store/analytics', async (req, res) => {
    try {
        res.json({ success: true, ...(await analytics.getAnalytics(getPool(), req.storeId, { days: req.query.days, tz: req.query.tz })) });
    } catch (e) {
        console.error('Analytics error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load analytics.' });
    }
});
app.get('/my-store/carts', async (req, res) => {
    try {
        res.json({ success: true, carts: await analytics.getCarts(getPool(), req.storeId, { status: req.query.status, before: req.query.before, limit: req.query.limit }) });
    } catch (e) {
        console.error('Carts error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load carts.' });
    }
});
app.get('/my-store/events', async (req, res) => {
    try {
        res.json({ success: true, events: await analytics.getEvents(getPool(), req.storeId, { type: req.query.type, before: req.query.before, limit: req.query.limit }) });
    } catch (e) {
        console.error('Events error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load events.' });
    }
});

// Stats API
app.get('/my-store/stats', async (req, res) => {
    const storeId = req.storeId; // from the session token
    try {
        await initCampaignTable(); // Ensure columns exist (Migration)
        const db = getPool();
        const subRes = await db.query('SELECT COUNT(*) FROM subscriptions WHERE store_id = $1', [storeId]);
        let campRes;
        try {
            // Try Full Query (Requires revenue/clicks columns)
            campRes = await db.query('SELECT COUNT(*) AS total_campaigns, SUM(sent_count) AS total_impressions, SUM(revenue) AS total_revenue, SUM(clicks) AS total_clicks FROM campaigns WHERE store_id = $1', [storeId]);
        } catch (sqlErr) {
            console.error('Full Stats Query Failed (using fallback):', sqlErr.message);
            // Fallback: Count Only (Ignore revenue)
            campRes = await db.query('SELECT COUNT(*) AS total_campaigns, SUM(sent_count) AS total_impressions FROM campaigns WHERE store_id = $1', [storeId]);
        }

        const recentRes = await db.query('SELECT * FROM campaigns WHERE store_id = $1 ORDER BY created_at DESC LIMIT 5', [storeId]);
        let monthly = null, ent = null;
        try { ent = await entitlements.get(db, storeId); monthly = Object.assign({}, ent.usage, { plan: ent.plan, trial: ent.trial }); } catch (uErr) { console.error('Usage error:', uErr.message); }

        res.json({
            subscribers: parseInt(subRes.rows[0].count),
            campaigns: parseInt(campRes.rows[0].total_campaigns || 0),
            totalImpressions: parseInt(campRes.rows[0].total_impressions || 0),
            totalRevenue: parseFloat(campRes.rows[0].total_revenue || 0),
            totalClicks: parseInt(campRes.rows[0].total_clicks || 0),
            recentCampaigns: recentRes.rows,
            usage: monthly,
            entitlements: ent
        });
    } catch (e) {
        console.error('Stats Error:', e);
        res.status(500).json({ error: e.message, subscribers: 0, campaigns: 0, totalImpressions: 0, totalRevenue: 0, recentCampaigns: [] });
    }
});

// Campaign History API
app.get('/my-store/campaigns', async (req, res) => {
    const storeId = req.storeId; // from the session token
    try {
        await initCampaignTable(); // Ensure table exists
        const db = getPool();
        const result = await db.query('SELECT * FROM campaigns WHERE store_id = $1 ORDER BY created_at DESC LIMIT 50', [storeId]);
        res.json({ campaigns: result.rows });
    } catch (e) { res.status(500).json({ campaigns: [] }); }
});

app.get('/my-store/subscribers', async (req, res) => {
    try {
        const db = getPool();
        const browserSql = `CASE WHEN endpoint ILIKE '%fcm.googleapis%' OR endpoint ILIKE '%android.googleapis%' THEN 'Chrome'
                              WHEN endpoint ILIKE '%mozilla%' THEN 'Firefox' WHEN endpoint ILIKE '%apple%' THEN 'Safari'
                              WHEN endpoint ILIKE '%windows.com%' THEN 'Edge' ELSE 'Other' END`;
        const [list, breakdown] = await Promise.all([
            db.query(`SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeen", COALESCE(status, 'active') AS status, ${browserSql} AS browser
                      FROM subscriptions WHERE store_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 500`, [req.storeId]),
            db.query(`SELECT COUNT(*)::int AS all_time,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired')::int AS active,
                             COUNT(*) FILTER (WHERE status = 'expired')::int AS expired,
                             COUNT(*) FILTER (WHERE created_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS gain_7d,
                             COUNT(*) FILTER (WHERE created_at >= (NOW() AT TIME ZONE 'UTC') - INTERVAL '14 days' AND created_at < (NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days')::int AS gain_prev_7d,
                             COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '7 days' AND status IS DISTINCT FROM 'expired')::int AS active_7d,
                             COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '30 days' AND status IS DISTINCT FROM 'expired')::int AS active_30d,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired' AND ${browserSql} = 'Chrome')::int AS chrome,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired' AND ${browserSql} = 'Firefox')::int AS firefox,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired' AND ${browserSql} = 'Safari')::int AS apple,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired' AND ${browserSql} = 'Edge')::int AS edge,
                             COUNT(*) FILTER (WHERE status IS DISTINCT FROM 'expired' AND ${browserSql} = 'Other')::int AS other,
                             (SELECT COUNT(DISTINCT endpoint) FROM push_carts WHERE store_id = $1 AND updated_at >= NOW() - INTERVAL '30 days')::int AS carts_30d,
                             (SELECT COUNT(DISTINCT endpoint) FROM push_orders WHERE store_id = $1 AND created_at >= NOW() - INTERVAL '30 days')::int AS buyers_30d
                      FROM subscriptions WHERE store_id = $1`, [req.storeId]),
        ]);
        res.json({ subscribers: list.rows, total: breakdown.rows[0].all_time, breakdown: breakdown.rows[0] });
    } catch (e) {
        console.error('Subscribers error:', e.message);
        res.status(500).json({ subscribers: [], error: 'Could not load subscribers' });
    }
});

// Monthly notifications used vs the limit set by the super admin.
// Subscriber counts per audience segment (campaign creator).
app.get('/my-store/segments', async (req, res) => {
    try {
        res.json({ success: true, segments: await automations.countSegments(getPool(), req.storeId) });
    } catch (e) {
        console.error('Segments error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load audiences' });
    }
});

app.get('/my-store/usage', async (req, res) => {
    try {
        const ent = await entitlements.get(getPool(), req.storeId);
        res.json({ success: true, usage: Object.assign({}, ent.usage, { plan: ent.plan, trial: ent.trial }), entitlements: ent });
    } catch (e) {
        console.error('Usage error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load usage' });
    }
});

// Plan pages (dashboard "Plan" view and the Shopify app's /app/plan).
// plan_requests is created on first use (additive; see sql/20261125_plan_requests.sql).
let planRequestsReady = null;
function ensurePlanRequests(db) {
    if (!planRequestsReady) {
        planRequestsReady = db.query(`CREATE TABLE IF NOT EXISTS plan_requests (
            id SERIAL PRIMARY KEY, store_id TEXT NOT NULL, plan TEXT NOT NULL, note TEXT,
            status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ)`)
            .then(() => db.query('CREATE INDEX IF NOT EXISTS plan_requests_store_idx ON plan_requests (store_id, created_at DESC)'))
            .catch((e) => { planRequestsReady = null; throw e; });
    }
    return planRequestsReady;
}
async function pendingPlanRequest(db, storeId) {
    const { rows } = await db.query(`SELECT id, plan, note, created_at FROM plan_requests WHERE store_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [storeId]);
    const r = rows[0];
    if (!r) return null;
    const p = plans.byKey(r.plan);
    return { id: r.id, plan: r.plan, plan_name: p ? p.name : r.plan, note: r.note, created_at: r.created_at, mailto: p ? plans.mailto(p, storeId) : null };
}

app.get('/my-store/plan', async (req, res) => {
    try {
        const db = getPool();
        await ensurePlanRequests(db);
        const ent = await entitlements.get(db, req.storeId);
        res.json({
            success: true,
            usage: ent.usage,
            plan: ent.plan,
            trial: ent.trial,
            segments_unlocked: ent.segments_unlocked,
            prompts: ent.prompts,
            review_url: ent.review_url,
            plans: plans.PLANS,
            contact_email: plans.contactEmail(),
            pending_request: await pendingPlanRequest(db, req.storeId),
        });
    } catch (e) {
        console.error('Plan error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load your plan' });
    }
});

app.post('/my-store/upgrade-request', async (req, res) => {
    const plan = plans.byKey(String((req.body && req.body.plan) || ''));
    if (!plan) return res.status(400).json({ success: false, error: 'Pick a plan to request.' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 500);
    try {
        const db = getPool();
        await ensurePlanRequests(db);
        const current = (await entitlements.get(db, req.storeId)).plan;
        if (current.key === plan.key && !current.custom_limit) return res.status(400).json({ success: false, error: 'You are already on the ' + plan.name + ' plan.' });
        // One open request per store: a new choice replaces the pending one.
        const pending = await pendingPlanRequest(db, req.storeId);
        if (pending) await db.query('UPDATE plan_requests SET plan = $1, note = $2, created_at = NOW() WHERE id = $3', [plan.key, note || null, pending.id]);
        else await db.query('INSERT INTO plan_requests (store_id, plan, note) VALUES ($1, $2, $3)', [req.storeId, plan.key, note || null]);
        res.json({ success: true, request: await pendingPlanRequest(db, req.storeId), contact_email: plans.contactEmail() });
    } catch (e) {
        console.error('Upgrade request error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send your request. Please try again.' });
    }
});

// Storefront popup design (see popups.js): current settings + the design gallery.
app.get('/my-store/popup', async (req, res) => {
    try {
        const r = await popups.get(getPool(), req.storeId);
        res.json({ success: true, settings: r.effective, saved: r.saved, store_logo: r.store_logo, presets: popups.publicPresets(), defaults: popups.DEFAULTS });
    } catch (e) { console.error('Popup get error:', e.message); res.status(500).json({ success: false, error: 'Could not load the popup design' }); }
});
// Body: full settings, or { apply_preset: "<key>" } to switch design in one click.
app.post('/my-store/popup', async (req, res) => {
    try {
        const settings = await popups.save(getPool(), req.storeId, req.body || {});
        res.json({ success: true, settings });
    } catch (e) { console.error('Popup save error:', e.message); res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not save the popup design' }); }
});

// Ideas feed (see tips.js): ?surface=home|loading|creator|app, ?n=1..6
app.get('/my-store/tips', async (req, res) => {
    try {
        const r = await tips.pick(getPool(), req.storeId, String(req.query.surface || 'home'), req.query.n);
        const clientId = process.env.SHOPIFY_API_KEY || process.env.SHOPIFY_CLIENT_ID || 'd5c35985fb2e26a210f931c4b6a92c87';
        res.json({ success: true, items: r.items, day: r.context ? r.context.day : null, theme_url: `https://${req.storeId}.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=${clientId}/popup` });
    } catch (e) { console.error('Tips error:', e.message); res.status(500).json({ success: false, items: [], error: 'Could not load ideas' }); }
});
// Bulk "shown" for a surface that rendered several items at once (the app home).
app.post('/my-store/tips/shown', async (req, res) => {
    try {
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.slice(0, 10) : [];
        for (const id of ids) await tips.recordEvent(getPool(), req.storeId, id, 'shown', req.body && req.body.surface);
        res.json({ success: true, count: ids.length });
    } catch (e) { res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not save' }); }
});
app.post('/my-store/tips/:id/event', async (req, res) => {
    try {
        await tips.recordEvent(getPool(), req.storeId, req.params.id, String((req.body && req.body.kind) || ''), req.body && req.body.surface);
        res.json({ success: true });
    } catch (e) { res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not save' }); }
});

// Trial, plan and popup state for the dashboards (see entitlements.js).
app.get('/my-store/entitlements', async (req, res) => {
    try { res.json({ success: true, entitlements: await entitlements.get(getPool(), req.storeId) }); }
    catch (e) { console.error('Entitlements error:', e.message); res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not load your plan' }); }
});
// The merchant picks their plan (after, or during, the trial). It applies at
// once; a paid choice also leaves a plan request so the team follows up on
// billing (no automatic charge).
app.post('/my-store/select-plan', async (req, res) => {
    const plan = plans.byKey(String((req.body && req.body.plan) || ''));
    if (!plan) return res.status(400).json({ success: false, error: 'Pick a plan first.' });
    try {
        const db = getPool();
        await ensurePlanRequests(db);
        await entitlements.setPlan(db, req.storeId, plan.key);
        if (plan.price > 0) {
            const pending = await pendingPlanRequest(db, req.storeId);
            if (pending) await db.query('UPDATE plan_requests SET plan = $1, note = $2, created_at = NOW() WHERE id = $3', [plan.key, 'selected by merchant', pending.id]);
            else await db.query('INSERT INTO plan_requests (store_id, plan, note) VALUES ($1, $2, $3)', [req.storeId, plan.key, 'selected by merchant']);
        } else {
            await db.query(`UPDATE plan_requests SET status = 'dismissed', resolved_at = NOW() WHERE store_id = $1 AND status = 'pending'`, [req.storeId]);
        }
        const ent = await entitlements.get(db, req.storeId);
        res.json({ success: true, plan: ent.plan, entitlements: ent, pending_request: await pendingPlanRequest(db, req.storeId), contact_email: plans.contactEmail() });
    } catch (e) {
        console.error('Select plan error:', e.message);
        res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not change your plan. Please try again.' });
    }
});
// Popup dismissed: trial_ended (once), limit_reached (per month), tour (once).
app.post('/my-store/prompts/dismiss', async (req, res) => {
    try { res.json({ success: true, entitlements: await entitlements.dismissPrompt(getPool(), req.storeId, String((req.body && req.body.key) || '')) }); }
    catch (e) { console.error('Prompt dismiss error:', e.message); res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not save' }); }
});

// Sends a campaign draft to the merchant's own browser (marked [Test]).
app.post('/my-store/campaign-test', async (req, res) => {
    const { subscription, title, message, url, image, icon, btn1Text, btn1UrlRaw, btn2Text, btn2UrlRaw } = req.body || {};
    try {
        if (!subscription || !automations.isValidPushEndpoint(subscription.endpoint) || !subscription.keys) {
            return res.status(400).json({ success: false, error: 'This browser could not be subscribed for test notifications.' });
        }
        if (!title || !message) return res.status(400).json({ success: false, error: 'Add a title and a message first.' });
        const link = normalizeLink(url) || `https://${req.storeId}.myshopify.com/`;
        const b1 = normalizeLink(btn1UrlRaw), b2 = normalizeLink(btn2UrlRaw);
        if (link === undefined || b1 === undefined || b2 === undefined) return res.status(400).json({ success: false, error: 'Links must be web addresses like https://yourstore.com/...' });
        const db = getPool();
        const store = (await automations.loadStore(db, req.storeId)) || { store_id: req.storeId };
        const actions = [];
        if (btn1Text) actions.push({ action: 'b1', title: String(btn1Text).slice(0, 24), url: b1 || link });
        if (btn2Text) actions.push({ action: 'b2', title: String(btn2Text).slice(0, 24), url: b2 || link });
        const payload = {
            title: '[Test] ' + String(title).slice(0, 120),
            body: String(message).slice(0, 500),
            icon: (icon && String(icon).startsWith('https://')) ? icon : automations.storeIcon(store),
            url: link,
            data: { url: link, type: 'test' },
            actions,
        };
        if (image && String(image).startsWith('https://')) payload.image = image;
        const result = await automations.sendPush(db, webPush, { endpoint: subscription.endpoint, keys: subscription.keys }, payload, automations.vapidOptions(store, { TTL: 300 }));
        res.json({ success: !!result.ok, error: result.ok ? undefined : (result.error || 'Could not send the test') });
    } catch (e) {
        console.error('Campaign test error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send the test' });
    }
});



/* -------------------------------------------------------------------------- */
/*                     ABANDONED CART WEBHOOK (New)                           */
/* -------------------------------------------------------------------------- */
app.post('/webhooks/shopify/checkouts', verifyShopifyWebhook, async (req, res) => {
    // console.log('Checkout Hook Recieved'); // Debug
    const shopDomain = req.headers['x-shopify-shop-domain'];
    if (!shopDomain) return res.status(200).send('No Shop Header');

    const { id, updated_at, abandoned_checkout_url, customer, email, cart_token, token } = req.body;
    await initCheckoutsTable();

    try {
        const db = getPool();
        // Resolve Store ID from Subscriptions (assuming domain matches)
        // Note: This relies on at least one subscriber having visited from this domain.
        // A better way is to query the 'stores' table if it has domains, but currently it seems sparse.
        // We fallback to subscriptions lookup.
        const subRes = await db.query('SELECT store_id FROM subscriptions WHERE store_domain = $1 LIMIT 1', [shopDomain]);

        if (subRes.rows.length === 0) {
            // Try to fuzzy match from stores table just in case
            // console.log('No subscription found for domain', shopDomain);
            return res.status(200).send('No Store Found');
        }

        const storeId = subRes.rows[0].store_id;

        // Upsert Checkout
        const activeToken = cart_token || token;
        await db.query(`
            INSERT INTO abandoned_checkouts 
            (store_id, checkout_id, token, cart_url, email, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (checkout_id) DO UPDATE SET 
            updated_at = EXCLUDED.updated_at,
            cart_url = EXCLUDED.cart_url,
            email = EXCLUDED.email,
            token = COALESCE(EXCLUDED.token, abandoned_checkouts.token)
        `, [storeId, id.toString(), activeToken, abandoned_checkout_url, email || (customer ? customer.email : null), updated_at]);

    } catch (e) { console.error('Checkout Hook Error', e); }
    res.status(200).send('OK');
});

// Links shoppers open must be absolute web addresses: "mystore.com/x" becomes
// "https://mystore.com/x". Returns null when empty, undefined when invalid.
function normalizeLink(value) {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    let v = String(value).trim();
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^[/]+/, '');
    try {
        const u = new URL(v);
        if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname.includes('.')) return undefined;
        return u.toString().slice(0, 1000);
    } catch (e) { return undefined; }
}

const SCHEDULE_MIN_MS = 4 * 60e3;          // UI asks for 5 minutes; allow clock skew
const SCHEDULE_MAX_MS = 60 * 24 * 3600e3;  // up to 60 days ahead
const EXPIRY_MIN_MS = 5 * 60e3;            // offer must last at least 5 minutes after sending

// Broadcast API: send now, or schedule (the cron sends it within 5 minutes of
// scheduled_at). Times are stored as UTC.
app.post('/my-store/broadcast', async (req, res) => {
    const storeId = req.storeId;
    const { title, message, url, image, icon, type, schedule, scheduledAt, expiryAt, btn1Text, btn1UrlRaw, btn2Text, btn2UrlRaw, segment } = req.body || {};
    const bad = (error) => res.status(400).json({ success: false, error });
    try {
        if (!title || !message) return bad('Title and message are required.');
        const audience = segment ? String(segment) : 'all';
        if (!automations.SEGMENTS[audience]) return bad('Pick a valid audience.');
        const now = Date.now();

        let sendAt = null;
        if (schedule === 'later' || scheduledAt) {
            const t = Date.parse(scheduledAt);
            if (!Number.isFinite(t)) return bad('Pick the date and time to send this campaign.');
            if (t < now + SCHEDULE_MIN_MS) return bad('Pick a time at least 5 minutes from now.');
            if (t > now + SCHEDULE_MAX_MS) return bad('You can schedule up to 60 days ahead.');
            sendAt = new Date(t);
        }
        let endsAt = null;
        if (expiryAt) {
            const t = Date.parse(expiryAt);
            if (!Number.isFinite(t)) return bad('The offer end time is not valid.');
            if (t < (sendAt ? sendAt.getTime() : now) + EXPIRY_MIN_MS) return bad('The offer must end at least 5 minutes after the campaign is sent.');
            endsAt = new Date(t);
        }

        const link = normalizeLink(url);
        const b1 = normalizeLink(btn1UrlRaw);
        const b2 = normalizeLink(btn2UrlRaw);
        if (link === undefined || b1 === undefined || b2 === undefined) return bad('Links must be web addresses like https://yourstore.com/products/...');
        const clampText = (v) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');
        const buttons = (clampText(btn1Text) || clampText(btn2Text))
            ? { btn1Text: clampText(btn1Text), btn1Url: b1 || null, btn2Text: clampText(btn2Text), btn2Url: b2 || null }
            : null;

        const db = getPool();
        // Insert the campaign first: its id is used for click/revenue tracking.
        const insertResult = await db.query(
            `INSERT INTO campaigns (store_id, title, message, url, image, icon, status, type, scheduled_at, expiry_at, buttons, segment, sent_count, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, NOW()) RETURNING *`,
            [storeId, String(title).slice(0, 120), String(message).slice(0, 500), link,
             (image && String(image).startsWith('https://') && String(image).length < 500) ? image : null,
             (icon && String(icon).startsWith('https://') && String(icon).length < 500) ? icon : null,
             sendAt ? 'scheduled' : 'sending', type === 'flash' ? 'flash' : 'regular',
             sendAt ? sendAt.toISOString() : null, endsAt ? endsAt.toISOString() : null,
             buttons ? JSON.stringify(buttons) : null, audience]
        );
        const camp = insertResult.rows[0];
        if (sendAt) return res.json({ success: true, sent: 0, status: 'scheduled', id: camp.id, scheduled_at: sendAt.toISOString() });

        const store = (await automations.loadStore(db, storeId)) || { store_id: storeId };
        const result = await automations.sendCampaign({ db, webPush }, store, camp);
        res.json({ success: true, id: camp.id, sent: result.sent, total: result.total, status: 'sent', lastError: result.lastError });
    } catch (e) {
        console.error('Broadcast error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send the campaign. Please try again.' });
    }
});

// Cancel a scheduled campaign before it goes out (the row is kept).
app.post('/my-store/campaigns/:id/cancel', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ success: false, error: 'Invalid campaign.' });
    try {
        const r = await getPool().query(
            `UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND store_id = $2 AND status = 'scheduled' RETURNING id`,
            [id, req.storeId]
        );
        if (!r.rowCount) return res.status(409).json({ success: false, error: 'This campaign is no longer scheduled. It may have been sent already.' });
        res.json({ success: true });
    } catch (e) {
        console.error('Cancel campaign error:', e.message);
        res.status(500).json({ success: false, error: 'Could not cancel. Please try again.' });
    }
});

/* Settings API */
app.get('/my-store/details', async (req, res) => {
    try {
        const db = getPool();
        const result = await db.query('SELECT store_name, logo_url, store_email, direct_prompt_enabled FROM stores WHERE store_id = $1', [req.storeId]);
        if (result.rows.length > 0) {
            res.json({ success: true, store: result.rows[0] });
        } else {
            res.json({ success: false, error: 'Store not found' });
        }
    } catch (e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

app.post('/my-store/update-settings', async (req, res) => {
    const { storeName, logoUrl, storeEmail, directPromptEnabled } = req.body || {};
    try {
        if (logoUrl && !/^https:\/\/.{3,490}$/.test(String(logoUrl))) {
            return res.status(400).json({ success: false, error: 'Logo URL must start with https://' });
        }
        if (storeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(storeEmail))) {
            return res.status(400).json({ success: false, error: 'Please enter a valid email.' });
        }
        await getPool().query(
            'UPDATE stores SET store_name = $1, logo_url = $2, store_email = $3, direct_prompt_enabled = $4 WHERE store_id = $5',
            [String(storeName || req.storeId).slice(0, 100), logoUrl || null, storeEmail || null, !!directPromptEnabled, req.storeId]
        );
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

app.post('/my-store/set-password', async (req, res) => {
    const password = req.body && req.body.password;
    const problem = auth.validateNewPassword(password);
    if (problem) return res.status(400).json({ success: false, error: problem });
    try {
        await getPool().query('UPDATE stores SET password = $2 WHERE store_id = $1', [req.storeId, auth.hashPassword(password)]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: 'Server error' }); }
});

/* Automation API */
app.get('/my-store/automations', async (req, res) => {
    try {
        const data = await automations.getDashboard(getPool(), req.storeId);
        if (!data) return res.status(404).json({ success: false, error: 'Store not found' });
        res.json({ success: true, ...data });
    } catch (e) {
        console.error('Automations load error:', e.message);
        res.status(500).json({ success: false, error: 'Could not load automations' });
    }
});

app.post('/my-store/automations', async (req, res) => {
    const { automation, config } = req.body || {};
    try {
        const result = await automations.saveAutomation(getPool(), req.storeId, automation, config);
        if (!result.ok) return res.status(400).json({ success: false, errors: result.errors });
        res.json({ success: true, config: result.value });
    } catch (e) {
        console.error('Automation save error:', e.message);
        res.status(500).json({ success: false, errors: ['Could not save. Please try again.'] });
    }
});

app.post('/my-store/automation-test', async (req, res) => {
    const { automation, step, subscription, config } = req.body || {};
    try {
        const db = getPool();
        const store = await automations.loadStore(db, req.storeId);
        if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
        const result = await automations.sendTest({ db, webPush }, store, automation, step, subscription, config || null);
        res.json({ success: !!result.ok, error: result.ok ? undefined : (result.error || 'Could not send the test') });
    } catch (e) {
        console.error('Automation test error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send the test' });
    }
});

app.post('/my-store/run-automations', async (req, res) => {
    try {
        const summary = await automations.runAutomations({ db: getPool(), webPush, onlyStore: req.storeId, budget: 500 });
        res.json({ success: true, summary });
    } catch (e) {
        console.error('Manual automation run error:', e.message);
        res.status(500).json({ success: false, error: 'Could not run automations' });
    }
});

/* Welcome notification (called by the Shopify app right after a new subscription) */
app.post('/api/trigger-welcome', async (req, res) => {
    const { storeId, subscription } = req.body || {};
    try {
        if (!subscription || !automations.isValidPushEndpoint(subscription.endpoint) || !subscription.keys) {
            return res.status(400).json({ success: false, error: 'Invalid subscription' });
        }
        const db = getPool();
        // Only real, stored subscribers of this store can receive its welcome push.
        const subRes = await db.query('SELECT endpoint, keys, store_domain FROM subscriptions WHERE endpoint = $1 AND store_id = $2', [subscription.endpoint, storeId]);
        if (!subRes.rows.length) return res.status(404).json({ success: false, error: 'Unknown subscription' });

        const store = await automations.loadStore(db, storeId);
        if (!store || !store.welcome_enabled) return res.json({ success: true, skipped: true });

        // fresh: the subscription was created a moment ago, so a 410 from the
        // push service is retried and never treated as an unsubscribe.
        const result = await automations.sendWelcome({ db, webPush }, store, subRes.rows[0], { fresh: true });
        res.json({ success: !!result.ok, pending: !!result.gone });
    } catch (e) {
        console.error('Welcome Trigger Failed', e.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

/* Legacy welcome click counter (old service workers) */
app.post('/api/track-event', async (req, res) => {
    const { type, storeId, event } = req.body || {};
    try {
        if (type === 'welcome' && event === 'click' && typeof storeId === 'string') {
            await getPool().query('UPDATE stores SET welcome_click_count = COALESCE(welcome_click_count, 0) + 1 WHERE store_id = $1', [storeId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false }); }
});

/* Automation engine: called every 5 minutes by Vercel Cron (Authorization: Bearer CRON_SECRET) */
async function cronHandler(req, res) {
    if (!auth.isCronRequest(req)) return res.status(401).json({ success: false, error: 'unauthorized' });
    try {
        const summary = await automations.runAutomations({ db: getPool(), webPush });
        res.json({ success: true, summary });
    } catch (e) {
        console.error('Cron Error', e);
        res.status(500).json({ success: false, error: e.message });
    }
}
app.get('/api/cron/automations', cronHandler);
app.get('/api/run-scheduler', cronHandler);

/* =========================================
   SUPER ADMIN PANEL (Hidden Route)
   ========================================= */

app.get('/master-admin', (req, res) => {
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Retner Super Admin</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>body{font-family: system-ui;} .container{max-width:1000px;}</style>
      </head>
      <body class="bg-light">
      <div class="container mt-5">
        <h2 class="mb-4">Retner Super Admin</h2>
        
        <div id="loginSection" class="card p-4 shadow-sm">
            <form id="loginForm">
                <label>Admin Password</label>
                <input type="password" id="adminPass" class="form-control mb-3" placeholder="Enter Password">
                <button type="submit" class="btn btn-primary w-100">Login</button>
            </form>
        </div>

        <div id="dashboardSection" style="display:none;" class="mt-4">
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h3>Plan upgrade requests <span class="badge bg-warning text-dark" id="requestCount">0</span></h3>
            </div>
            <div class="card shadow-sm mb-5">
                <table class="table table-hover mb-0">
                    <thead class="table-dark">
                        <tr>
                            <th>Store</th>
                            <th>Current limit</th>
                            <th>Requested plan</th>
                            <th>Note</th>
                            <th>Requested</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="requestTable"><tr><td colspan="6" class="text-muted">Loading…</td></tr></tbody>
                </table>
            </div>
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h3>Tips &amp; ideas <span class="badge bg-info text-dark" id="tipCount">0</span></h3>
                <button class="btn btn-primary btn-sm" onclick="editTip(null)">+ New item</button>
            </div>
            <p class="text-muted small">Shown in the dashboard and the Shopify app ("Ideas for you", loading line, campaign templates). Changes apply at once, no deploy. Conditions and button params are JSON (see placeholders).</p>
            <div class="card shadow-sm mb-3" id="tipEditor" style="display:none;">
                <div class="card-body">
                    <h5 id="tipEditorTitle">New item</h5>
                    <input type="hidden" id="tip_id">
                    <div class="row g-2">
                        <div class="col-md-3"><label class="form-label small">Kind</label><select class="form-select form-select-sm" id="tip_kind"></select></div>
                        <div class="col-md-7"><label class="form-label small">Title</label><input class="form-control form-control-sm" id="tip_title" maxlength="120"></div>
                        <div class="col-md-2"><label class="form-label small">Priority 1–10</label><input type="number" class="form-control form-control-sm" id="tip_priority" min="1" max="10" value="5"></div>
                        <div class="col-12"><label class="form-label small">Body (for templates: "Title · Message" preview text)</label><textarea class="form-control form-control-sm" id="tip_body" rows="2" maxlength="600"></textarea></div>
                        <div class="col-md-3"><label class="form-label small">Button label</label><input class="form-control form-control-sm" id="tip_cta_label" maxlength="60"></div>
                        <div class="col-md-3"><label class="form-label small">Button opens</label><select class="form-select form-select-sm" id="tip_cta_view"><option value="">(none)</option></select></div>
                        <div class="col-md-6"><label class="form-label small">Button params JSON</label><input class="form-control form-control-sm" id="tip_cta_params" placeholder='{"title":"Weekend sale 🎉","msg":"20% off till Sunday","btn":"Shop now","type":"flash"} or {"automation":"abandoned_cart"}'></div>
                        <div class="col-md-2"><label class="form-label small">Day from</label><input type="number" class="form-control form-control-sm" id="tip_day_min" placeholder="0"></div>
                        <div class="col-md-2"><label class="form-label small">Day to</label><input type="number" class="form-control form-control-sm" id="tip_day_max" placeholder="blank = always"></div>
                        <div class="col-md-2"><label class="form-label small">Season from</label><input type="date" class="form-control form-control-sm" id="tip_season_from"></div>
                        <div class="col-md-2"><label class="form-label small">Season to</label><input type="date" class="form-control form-control-sm" id="tip_season_to"></div>
                        <div class="col-md-4"><label class="form-label small">Conditions JSON</label><input class="form-control form-control-sm" id="tip_conditions" placeholder='{"no_campaign":true,"automation_off":"welcome","subscribers_gte":50}'></div>
                        <div class="col-12 d-flex gap-2 mt-2">
                            <button class="btn btn-success btn-sm" onclick="saveTip()">Save</button>
                            <button class="btn btn-outline-secondary btn-sm" onclick="document.getElementById('tipEditor').style.display='none'">Cancel</button>
                            <span class="text-danger small align-self-center" id="tipError"></span>
                        </div>
                    </div>
                </div>
            </div>
            <div class="card shadow-sm mb-5">
                <table class="table table-hover table-sm mb-0">
                    <thead class="table-dark"><tr><th>Kind</th><th>Title</th><th>Shows when</th><th>Shown</th><th>Clicked</th><th>Wanted</th><th>Actions</th></tr></thead>
                    <tbody id="tipTable"><tr><td colspan="7" class="text-muted">Loading…</td></tr></tbody>
                </table>
            </div>
            <div class="d-flex justify-content-between align-items-center mb-3">
                <h3>All Stores</h3>
                <button class="btn btn-secondary btn-sm" onclick="location.reload()">Refresh</button>
            </div>
            <div class="card shadow-sm">
                <table class="table table-hover mb-0">
                    <thead class="table-dark">
                        <tr>
                            <th>Store ID (Name)</th>
                            <th>Email</th>
                            <th>Monthly Limit</th>
                            <th>Joined</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="storeTable"></tbody>
                </table>
            </div>
        </div>
      </div>

      <script>
        const API_URL = '/api/super';
        let adminToken = localStorage.getItem('super_token');

        if(adminToken) { showDashboard(); }

        document.getElementById('loginForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const pass = document.getElementById('adminPass').value;
            const res = await fetch(API_URL + '/login', { 
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({pass}) 
            });
            const data = await res.json();
            if(data.success) {
                adminToken = data.token;
                localStorage.setItem('super_token', adminToken);
                showDashboard();
            } else { alert('Wrong Password'); }
        });

        function showDashboard() {
            document.getElementById('loginSection').style.display = 'none';
            document.getElementById('dashboardSection').style.display = 'block';
            loadStores();
            loadRequests();
            loadTips();
        }

        // ---- Tips & ideas
        let tipsData = [], tipKinds = [], tipViews = [];
        async function loadTips() {
            const res = await fetch(API_URL + '/tips?token=' + adminToken);
            const data = await res.json();
            tipsData = data.tips || []; tipKinds = data.kinds || []; tipViews = data.views || [];
            document.getElementById('tipCount').innerText = tipsData.filter(t => t.active).length + ' active';
            document.getElementById('tip_kind').innerHTML = tipKinds.map(k => '<option value="' + k + '">' + k + '</option>').join('');
            document.getElementById('tip_cta_view').innerHTML = '<option value="">(none)</option>' + tipViews.map(v => '<option value="' + v + '">' + v + '</option>').join('');
            const when = (t) => {
                const parts = [];
                if (t.day_min !== null || t.day_max !== null) parts.push('day ' + (t.day_min ?? 0) + '–' + (t.day_max ?? '∞'));
                if (t.season_from || t.season_to) parts.push((t.season_from || '').slice(0, 10) + ' → ' + (t.season_to || '').slice(0, 10));
                const c = t.conditions && Object.keys(t.conditions).length ? Object.entries(t.conditions).map(([k, v]) => k + (v === true ? '' : ':' + v)).join(', ') : '';
                if (c) parts.push(c);
                return parts.join(' · ') || 'always';
            };
            document.getElementById('tipTable').innerHTML = tipsData.length ? tipsData.map(t => \`
                <tr class="\${t.active ? '' : 'table-secondary text-muted'}">
                    <td><span class="badge bg-light text-dark">\${escapeHtml(t.kind)}</span></td>
                    <td><strong>\${escapeHtml(t.title)}</strong><br><small class="text-muted">\${escapeHtml((t.body || '').slice(0, 110))}</small></td>
                    <td><small>\${escapeHtml(when(t))}</small></td>
                    <td>\${t.shown}</td><td>\${t.clicked}</td><td>\${t.wanted}</td>
                    <td class="text-nowrap">
                        <button class="btn btn-sm btn-outline-primary" onclick="editTip(\${t.id})">Edit</button>
                        <button class="btn btn-sm \${t.active ? 'btn-outline-warning' : 'btn-outline-success'}" onclick="toggleTip(\${t.id}, \${!t.active})">\${t.active ? 'Pause' : 'Resume'}</button>
                    </td>
                </tr>\`).join('') : '<tr><td colspan="7" class="text-muted">No items yet.</td></tr>';
        }
        function editTip(id) {
            const t = tipsData.find(x => x.id === id) || { kind: 'tip', priority: 5, cta_params: {}, conditions: {} };
            document.getElementById('tipEditorTitle').innerText = id ? 'Edit item #' + id : 'New item';
            document.getElementById('tip_id').value = id || '';
            document.getElementById('tip_kind').value = t.kind || 'tip';
            document.getElementById('tip_title').value = t.title || '';
            document.getElementById('tip_priority').value = t.priority || 5;
            document.getElementById('tip_body').value = t.body || '';
            document.getElementById('tip_cta_label').value = t.cta_label || '';
            document.getElementById('tip_cta_view').value = t.cta_view || '';
            document.getElementById('tip_cta_params').value = JSON.stringify(t.cta_params || {});
            document.getElementById('tip_day_min').value = t.day_min ?? '';
            document.getElementById('tip_day_max').value = t.day_max ?? '';
            document.getElementById('tip_season_from').value = (t.season_from || '').slice(0, 10);
            document.getElementById('tip_season_to').value = (t.season_to || '').slice(0, 10);
            document.getElementById('tip_conditions').value = JSON.stringify(t.conditions || {});
            document.getElementById('tipError').innerText = '';
            document.getElementById('tipEditor').style.display = 'block';
            document.getElementById('tipEditor').scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        async function saveTip() {
            const g = (id) => document.getElementById(id).value;
            const tip = { id: g('tip_id') || null, kind: g('tip_kind'), title: g('tip_title'), priority: g('tip_priority'), body: g('tip_body'), cta_label: g('tip_cta_label'), cta_view: g('tip_cta_view'), cta_params: g('tip_cta_params') || '{}', day_min: g('tip_day_min'), day_max: g('tip_day_max'), season_from: g('tip_season_from'), season_to: g('tip_season_to'), conditions: g('tip_conditions') || '{}', active: true };
            const cur = tipsData.find(x => String(x.id) === String(tip.id)); if (cur) tip.active = cur.active;
            const res = await fetch(API_URL + '/tips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken, tip }) });
            const data = await res.json();
            if (!data.success) { document.getElementById('tipError').innerText = data.error || 'Could not save'; return; }
            document.getElementById('tipEditor').style.display = 'none';
            loadTips();
        }
        async function toggleTip(id, active) {
            await fetch(API_URL + '/tips/' + id + '/active', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken, active }) });
            loadTips();
        }

        function escapeHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

        async function loadRequests() {
            const res = await fetch(API_URL + '/plan-requests?token=' + adminToken);
            if(res.status === 403) { localStorage.removeItem('super_token'); location.reload(); return; }
            const data = await res.json();
            const rows = data.requests || [];
            document.getElementById('requestCount').textContent = rows.length;
            document.getElementById('requestTable').innerHTML = rows.length ? rows.map(r => \`
                <tr>
                    <td><strong>\${escapeHtml(r.store_name || r.store_id)}</strong><br><small class="text-muted">\${escapeHtml(r.store_id)}\${r.store_email ? ' · ' + escapeHtml(r.store_email) : ''}</small></td>
                    <td>\${Number(r.monthly_limit || 1000).toLocaleString('en-IN')}</td>
                    <td><strong>\${escapeHtml(r.plan_name)}</strong><br><small class="text-muted">\${Number(r.plan_limit || 0).toLocaleString('en-IN')} / month\${r.plan_price ? ' · $' + r.plan_price : ''}</small></td>
                    <td><small>\${escapeHtml(r.note || '-')}</small></td>
                    <td>\${new Date(r.created_at).toLocaleString()}</td>
                    <td class="text-nowrap">
                        <button class="btn btn-sm btn-success" onclick="resolveRequest(\${r.id}, \${Number(r.plan_limit || 0)})">Set \${Number(r.plan_limit || 0).toLocaleString('en-IN')} &amp; done</button>
                        <button class="btn btn-sm btn-outline-secondary" onclick="resolveRequest(\${r.id}, null)">Dismiss</button>
                    </td>
                </tr>
            \`).join('') : '<tr><td colspan="6" class="text-muted">No pending requests.</td></tr>';
        }

        async function resolveRequest(id, limit) {
            if(limit === null && !confirm('Dismiss this request without changing the limit?')) return;
            const res = await fetch(API_URL + '/plan-requests/' + id + '/resolve', {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({token:adminToken, limit})
            });
            if(res.ok) { loadRequests(); loadStores(); } else { alert('Could not update the request.'); }
        }

        async function loadStores() {
            const res = await fetch(API_URL + '/stores?token=' + adminToken);
            if(res.status === 403) { localStorage.removeItem('super_token'); location.reload(); return; }
            const data = await res.json();
            const tbody = document.getElementById('storeTable');
            tbody.innerHTML = data.stores.map(s => \`
                <tr>
                    <td>
                        <strong>\${s.store_name || s.store_id}</strong><br>
                        <small class="text-muted">\${s.store_id}</small>
                    </td>
                    <td>\${s.store_email || '-'}</td>
                    <td>
                        <div class="input-group input-group-sm" style="width:150px">
                            <input type="number" class="form-control" value="\${s.monthly_limit || 1000}" id="limit-\${s.store_id}">
                            <button class="btn btn-outline-success" onclick="updateLimit('\${s.store_id}')">Set</button>
                        </div>
                    </td>
                    <td>\${new Date(s.created_at).toLocaleDateString()}</td>
                    <td>
                        <button class="btn btn-sm btn-outline-danger" onclick="deleteStore('\${s.store_id}')">Delete</button>
                    </td>
                </tr>
            \`).join('');
        }

        async function updateLimit(id) {
            const limit = document.getElementById('limit-'+id).value;
            await fetch(API_URL + '/update-limit', { 
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({token:adminToken, store_id:id, limit}) 
            });
            alert('Limit Updated!');
        }

        async function deleteStore(id) {
            if(!confirm('Are you sure you want to DELETE ' + id + '? This cannot be undone.')) return;
            const res = await fetch(API_URL + '/delete-store', { 
                method:'POST', 
                headers:{'Content-Type':'application/json'}, 
                body:JSON.stringify({token:adminToken, store_id:id}) 
            });
            if(res.ok) { loadStores(); }
        }
      </script>
      </body>
      </html>
    `);
});

// Super admin: password comes from SUPER_ADMIN_PASSWORD (disabled when unset),
// tokens are signed and expire after 12 hours.
app.post('/api/super/login', (req, res) => {
    if (auth.superPasswordOk(req.body && req.body.pass)) res.json({ success: true, token: auth.issueSuperToken() });
    else res.json({ success: false });
});

app.get('/api/super/stores', auth.requireSuper, async (req, res) => {
    const db = getPool();
    try { await db.query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS monthly_limit INTEGER DEFAULT 1000'); } catch (e) { }
    // Never return password hashes.
    const result = await db.query(`SELECT id, store_id, store_name, created_at, logo_url, store_email, monthly_limit, welcome_enabled, abandoned_enabled, direct_prompt_enabled FROM stores ORDER BY created_at DESC`);
    res.json({ stores: result.rows });
});

app.post('/api/super/update-limit', auth.requireSuper, async (req, res) => {
    const db = getPool();
    await db.query('UPDATE stores SET monthly_limit = $1 WHERE store_id = $2', [parseInt(req.body.limit, 10) || 0, req.body.store_id]);
    res.json({ success: true });
});

// Pending plan upgrade requests (see /my-store/upgrade-request).
app.get('/api/super/plan-requests', auth.requireSuper, async (req, res) => {
    try {
        const db = getPool();
        await ensurePlanRequests(db);
        const { rows } = await db.query(`
            SELECT r.id, r.store_id, r.plan, r.note, r.created_at, s.store_name, s.store_email, s.monthly_limit
            FROM plan_requests r LEFT JOIN stores s ON s.store_id = r.store_id
            WHERE r.status = 'pending' ORDER BY r.created_at DESC LIMIT 200`);
        res.json({ requests: rows.map((r) => { const p = plans.byKey(r.plan); return Object.assign({}, r, { plan_name: p ? p.name : r.plan, plan_limit: p ? (p.limit === null ? plans.UNLIMITED_SENTINEL : p.limit) : null, plan_price: p ? p.price : null }); }) });
    } catch (e) {
        console.error('Plan requests error:', e.message);
        res.status(500).json({ requests: [], error: 'Could not load requests' });
    }
});

// Resolves a request: with a limit it also updates the store (status "done"),
// without one it is just closed (status "dismissed"). Nothing is deleted.
app.post('/api/super/plan-requests/:id/resolve', auth.requireSuper, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const limit = req.body && req.body.limit !== null && req.body.limit !== undefined ? parseInt(req.body.limit, 10) : null;
    if (!id) return res.status(400).json({ success: false, error: 'Bad request id' });
    try {
        const db = getPool();
        await ensurePlanRequests(db);
        const { rows } = await db.query(`SELECT store_id, plan FROM plan_requests WHERE id = $1 AND status = 'pending'`, [id]);
        if (!rows.length) return res.status(404).json({ success: false, error: 'Request not found or already resolved' });
        if (limit && limit > 0) {
            // The requested plan becomes the store's plan; the limit is kept for older readers.
            if (plans.byKey(rows[0].plan)) await entitlements.setPlan(db, rows[0].store_id, rows[0].plan);
            await db.query('UPDATE stores SET monthly_limit = $1 WHERE store_id = $2', [limit, rows[0].store_id]);
        }
        await db.query(`UPDATE plan_requests SET status = $2, resolved_at = NOW() WHERE id = $1`, [id, limit && limit > 0 ? 'done' : 'dismissed']);
        res.json({ success: true });
    } catch (e) {
        console.error('Resolve request error:', e.message);
        res.status(500).json({ success: false, error: 'Could not update the request' });
    }
});

// Ideas feed editor (master admin): list with stats, add/edit, pause/resume.
app.get('/api/super/tips', auth.requireSuper, async (req, res) => {
    try { res.json({ success: true, tips: await tips.adminList(getPool()), kinds: tips.KINDS, views: tips.VIEWS }); }
    catch (e) { console.error('Admin tips error:', e.message); res.status(500).json({ success: false, error: 'Could not load tips' }); }
});
app.post('/api/super/tips', auth.requireSuper, async (req, res) => {
    try { res.json({ success: true, tip: await tips.adminSave(getPool(), req.body && req.body.tip) }); }
    catch (e) { res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not save the tip' }); }
});
app.post('/api/super/tips/:id/active', auth.requireSuper, async (req, res) => {
    try { res.json({ success: true, tip: await tips.adminSetActive(getPool(), req.params.id, req.body && req.body.active) }); }
    catch (e) { res.status(e.status || 500).json({ success: false, error: e.status ? e.message : 'Could not update' }); }
});

app.post('/api/super/delete-store', auth.requireSuper, async (req, res) => {
    const db = getPool();
    const storeId = req.body.store_id;

    try {
        console.log(`Deleting Store & Data for: ${storeId}`);
        await db.query('DELETE FROM campaigns WHERE store_id = $1', [storeId]);
        await db.query('DELETE FROM subscriptions WHERE store_id = $1', [storeId]);
        await db.query('DELETE FROM stores WHERE store_id = $1', [storeId]);
        res.json({ success: true });
    } catch (e) {
        console.error("Delete Store Error:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/debug-data', auth.requireSuper, async (req, res) => {
    try {
        const db = getPool();
        const state = await db.query(`SELECT key, value, updated_at FROM push_system_state ORDER BY updated_at DESC LIMIT 20`);
        const carts = await db.query(`SELECT store_id, status, COUNT(*)::int AS n FROM push_carts GROUP BY store_id, status ORDER BY store_id`);
        res.json({ state: state.rows, carts: carts.rows, serverTime: new Date().toISOString() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Privacy Policy Page
app.get('/privacy', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Privacy Policy - Retner Smart Push</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; }
                h1 { border-bottom: 2px solid #eee; padding-bottom: 10px; }
                h2 { margin-top: 30px; color: #444; }
                .update-date { color: #666; font-style: italic; }
            </style>
        </head>
        <body>
            <h1>Privacy Policy</h1>
            <p class="update-date">Last updated: November 19, 2026</p>

            <p>Retner Smart Push ("we", "us", or "our") provides a web push notification service for Shopify merchants. This Privacy Policy describes how we collect, use, and handle your personal information when you use our app.</p>

            <h2>1. Information We Collect</h2>
            <p><strong>From Merchants:</strong> We collect your shop domain and basic store information provided by Shopify to identify your account.</p>
            <p><strong>From End Users (Store Visitors):</strong> We do NOT collect personal emails or phone numbers. We collect:</p>
            <ul>
                <li>Anonymous Push Subscription Tokens</li>
                <li>Device type (Desktop/Mobile)</li>
                <li>Browser language settings</li>
                <li>Shopping activity on the merchant's store linked only to the anonymous push subscription: products viewed, cart contents and last visit time</li>
                <li>If the merchant turns on order detection: completed-order events from Shopify's checkout pixel (order ID, order total and purchased products), linked only to the anonymous push subscription. No names, emails, phone numbers or addresses are collected.</li>
            </ul>

            <h2>2. How We Use Your Information</h2>
            <p>We use the collected information solely to:</p>
            <ul>
                <li>Send web push notifications explicitly requested by the user.</li>
                <li>Provide analytics to the merchant (e.g., number of subscribers).</li>
                <li>Send the merchant's automated reminders that the subscriber opted into notifications for (e.g., items left in the cart, a product they viewed, new arrivals after a long absence). Shopping activity is used only for these reminders on that same store and is never sold or shared.</li>
                <li>Authenticate the merchant via Shopify's secure API.</li>
            </ul>

            <h2>3. Data Sharing</h2>
            <p>We do not sell, trade, or otherwise transfer your personally identifiable information to outside parties.</p>

            <h2>4. Your Rights</h2>
            <p>Merchants and end-users have the right to access, correct, or delete their data. End-users can unsubscribe from notifications at any time via their browser settings.</p>

            <h2>5. Contact Us</h2>
            <p>If you have questions about this Privacy Policy, please contact us at: <strong>Koregrowtech@gmail.com</strong></p>
        </body>
        </html>
    `);
});

module.exports = app;