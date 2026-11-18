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
        getPool().query('UPDATE campaigns SET clicks = COALESCE(clicks, 0) + 1 WHERE id = $1', [parseInt(c, 10)])
            .catch((e) => console.error('Click tracking error:', e.message));
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

app.get('/api/vapid-public-key', (req, res) => {
    res.json({ publicKey: process.env.PUBLIC_KEY || null });
});

// Store Admin Dashboard HTML (SSO Enabled)
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

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Retner Dashboard</title>
    <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {
            --primary: #2563EB;
            --primary-hover: #1E40AF;
            --bg: #f6f6f7;
            --sidebar-width: 240px;
            --text-dark: #202223;
            --text-sub: #6d7175;
            --border: #e1e3e5;
        }
        body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text-dark); display: flex; height: 100vh; overflow: hidden; }
        
        /* LAYOUT */
        .sidebar { width: var(--sidebar-width); background: white; border-right: 1px solid var(--border); display: flex; flex-direction: column; padding: 16px; flex-shrink: 0; }
        .main-content { flex: 1; display: flex; flex-direction: column; overflow-y: auto; }
        .top-bar { height: 60px; background: white; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; padding: 0 32px; flex-shrink: 0; }
        .content-area { padding: 32px; max-width: 1200px; margin: 0 auto; width: 100%; box-sizing: border-box; }

        /* SIDEBAR COMPONENTS */
        .logo { font-size: 20px; font-weight: 700; margin-bottom: 24px; color: var(--text-dark); display: flex; align-items: center; gap: 8px; }
        .logo i { color: var(--primary); }
        .new-campaign-btn { background: var(--primary); color: white; border: none; padding: 10px; border-radius: 4px; font-weight: 600; cursor: pointer; width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 20px; transition: 0.2s; }
        .new-campaign-btn:hover { background: var(--primary-hover); }
        .menu-item { padding: 10px 12px; color: var(--text-dark); text-decoration: none; display: flex; align-items: center; gap: 12px; border-radius: 4px; margin-bottom: 4px; cursor: pointer; font-size: 14px; font-weight: 500; }
        .menu-item:hover, .menu-item.active { background: #EBF5FF; color: var(--primary); }
        .menu-item.active { background: #EFF6FF; }

        /* DASHBOARD WIDGETS */
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 24px; }
        .card { background: white; border: 1px solid var(--border); border-radius: 8px; padding: 24px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); }
        .card h3 { margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: var(--text-dark); }
        
        .stat-row { display: flex; align-items: baseline; gap: 8px; margin-top: 12px; }
        .stat-val { font-size: 28px; font-weight: 700; }
        .stat-label { color: var(--text-sub); font-size: 13px; }

        .welcome-box { background: #edfffa; border: 1px solid #cce5dd; display: flex; justify-content: space-between; align-items: center; }
        .welcome-text h2 { margin: 0 0 8px 0; font-size: 18px; }
        .welcome-text p { margin: 0; font-size: 14px; color: var(--text-sub); }

        /* AUTH FORMS */
        .auth-container { display: flex; justify-content: center; align-items: center; height: 100vh; width: 100vw; position: fixed; top: 0; left: 0; background: var(--bg); z-index: 1000; }
        .auth-box { background: white; padding: 40px; border-radius: 12px; width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        
        /* FORM INPUTS */
        .form-group { margin-bottom: 16px; }
        .form-group label { display: block; margin-bottom: 6px; font-size: 14px; font-weight: 500; }
        input, textarea, select { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px; box-sizing: border-box; }
        input:focus, textarea:focus { border-color: var(--primary); outline: none; box-shadow: 0 0 0 1px var(--primary); }
        
        .hidden { display: none !important; }

        /* CAMPAIGN CREATOR */
        .campaign-preview { background: #f1f2f3; padding: 20px; border-radius: 8px; display: flex; justify-content: center; margin-top: 20px; }
        .preview-box { background: white; padding: 15px; border-radius: 8px; width: 300px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
        .preview-hero { width: 100%; height: 150px; background: #eee; border-radius: 4px; margin-bottom: 10px; object-fit: cover; }

        /* WIZARD STYLES */
        .stepper-container { border-bottom: 1px solid #e1e3e5; margin-bottom: 24px; padding-bottom: 24px; }
        .stepper { display: flex; gap: 40px; }
        .step-item { display: flex; align-items: center; gap: 8px; color: #6d7175; font-size: 14px; font-weight: 500; }
        .step-item.active { color: var(--primary); font-weight: 600; }
        .step-circle { width: 24px; height: 24px; border-radius: 50%; background: #eee; color: #666; display: flex; justify-content: center; align-items: center; font-size: 12px; font-weight: bold; }
        .step-item.active .step-circle { background: var(--primary); color: white; }

        .wizard-layout { display: grid; grid-template-columns: 2fr 1fr; gap: 32px; align-items: start; }
        .wizard-card { background: white; border: 1px solid #e1e3e5; border-radius: 8px; padding: 24px; margin-bottom: 20px; }
        
        .selection-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
        .selection-card { border: 1px solid #e1e3e5; border-radius: 8px; padding: 16px; cursor: pointer; transition: 0.2s; display: flex; flex-direction: column; gap: 8px; }
        .selection-card:hover { border-color: var(--primary); background: #edfffa; }
        .selection-card.selected { border-color: var(--primary); background: #edfffa; box-shadow: 0 0 0 1px var(--primary); }
        .selection-title { font-weight: 600; font-size: 14px; color: var(--text-dark); }
        .selection-desc { font-size: 12px; color: var(--text-sub); }

        .wizard-footer { margin-top: 24px; display: flex; justify-content: space-between; border-top: 1px solid #e1e3e5; padding-top: 20px; }
        .btn { padding: 10px 24px; border-radius: 4px; border: none; font-weight: 600; cursor: pointer; font-size: 14px; transition: 0.2s; }
        .btn-primary { background: var(--primary); color: white; }
        .btn-primary:hover { background: var(--primary-hover); }
        .btn-secondary { background: white; border: 1px solid #dcdcdc; color: #333; }
        .btn-secondary:hover { background: #f6f6f7; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        /* PREMIUM DASHBOARD */
        .stats-grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 24px; }
        .stat-card-premium { background: white; padding: 20px; border-radius: 12px; border: 1px solid #e1e3e5; box-shadow: 0 2px 4px rgba(0,0,0,0.02); display: flex; flex-direction: column; justify-content: space-between; height: 120px; }
        .stat-header { display: flex; justify-content: space-between; align-items: start; margin-bottom: 10px; }
        .stat-title { color: #6d7175; font-size: 13px; font-weight: 500; }
        .stat-icon { width: 32px; height: 32px; background: #f1f8f5; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--primary); font-size: 14px; }
        .stat-value { font-size: 24px; font-weight: 600; color: #303030; margin-bottom: 4px; }
        .stat-trend { font-size: 12px; color: #2563EB; display: flex; align-items: center; gap: 4px; background: #DBEAFE; padding: 2px 8px; border-radius: 12px; width: fit-content; }
        
        .charts-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 24px; }
        .chart-card { background: white; padding: 20px; border-radius: 12px; border: 1px solid #e1e3e5; height: 350px; }
        .chart-header { display: flex; justify-content: space-between; margin-bottom: 20px; align-items: center; }

        @media (max-width: 1000px) { .stats-grid-4, .charts-grid-2 { grid-template-columns: 1fr; } }
        
        /* TOGGLE SWITCH */
        .switch { position: relative; display: inline-block; width: 50px; height: 24px; }
        .switch input { opacity: 0; width: 0; height: 0; }
        .slider { position: absolute; cursor: pointer; top: 0; left: 0; right: 0; bottom: 0; background-color: #ccc; transition: .4s; border-radius: 24px; }
        .slider:before { position: absolute; content: ""; height: 16px; width: 16px; left: 4px; bottom: 4px; background-color: white; transition: .4s; border-radius: 50%; }
        input:checked + .slider { background-color: #008060; }
        input:focus + .slider { box-shadow: 0 0 1px #008060; }
        input:checked + .slider:before { transform: translateX(26px); }

        /* AUTOMATION GRID */
        .automations-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 20px; }
        .auto-card { background: white; border: 1px solid #e1e3e5; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; min-height: 200px; }
        .auto-card-header { padding: 20px; display: flex; gap: 16px; align-items: start; }
        .auto-icon { width: 40px; height: 40px; background: #f1f8f5; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #008060; font-size: 18px; flex-shrink: 0; }
        .auto-card h4 { margin: 0 0 4px 0; font-size: 16px; font-weight: 600; }
        .auto-desc { margin: 0; font-size: 14px; color: #666; line-height: 1.5; }
        .auto-stats { padding: 0 20px 20px 20px; display: flex; gap: 24px; }
        .stat-num { display: block; font-weight: 600; font-size: 18px; }
        .stat-lbl { font-size: 12px; color: #666; }
        .auto-card-footer { background: #fafbfb; padding: 16px 20px; border-top: 1px solid #e1e3e5; display: flex; justify-content: space-between; align-items: center; border-radius: 0 0 8px 8px; }
        .badge { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
        .badge-active { background: #c4fce1; color: #008060; }
        .badge-inactive { background: #e4e5e7; color: #666; }
        .badge-grey { background: #f1f2f3; color: #666; border: 1px solid #ddd; }
        .btn-action { background: white; border: 1px solid #dcdcdc; padding: 6px 12px; border-radius: 4px; font-weight: 600; font-size: 13px; cursor: pointer; transition: 0.2s; }
        .btn-action:hover { background: #f6f6f7; border-color: #ccc; }
        .btn-link { background: none; border: none; color: #008060; text-decoration: underline; cursor: pointer; font-size: 13px; }
        .input-sm { width: 100%; margin-bottom: 8px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 13px; }
        .btn-sm { font-size: 12px; padding: 4px 8px; }

    </style>
    <link rel="stylesheet" href="/css/automations.css?v=2">
    <script src="/js/automations.js?v=2" defer></script>
</head>
<body>

    <!-- AUTH SCREEN -->
    <div id="authScreen" class="auth-container">
        <div class="auth-box" id="loginBox">
<div style="text-align: center; margin-bottom: 30px;"><img src="/full-logo.png" style="max-width: 250px; height: auto;"></div>
            <div class="form-group">
                <label>Store ID</label>
                <input type="text" id="storeId" placeholder="e.g. zyrajewel">
            </div>
            <div class="form-group">
                <label>Password</label>
                <input type="password" id="password" placeholder="••••••••">
            </div>
            <button class="new-campaign-btn" onclick="login()">Login</button>
            <div id="authNotice" style="margin-top: 16px; font-size: 13px; color: var(--text-sub); line-height: 1.5; text-align: center;">
                New here or forgot your password? Open the dashboard from your <strong>Shopify admin → Apps → Retner SmartPush → Open Dashboard</strong>. You can set a password in Settings.
            </div>
        </div>
    </div>

    <!-- MAIN APP -->
    <div id="mainApp" class="hidden" style="display: flex; width: 100%;">
        
        <!-- SIDEBAR -->
        <div class="sidebar">
            <div class="logo" style="justify-content: center;"><img src="/full-logo.png" alt="Retner" style="max-height: 50px; max-width: 100%;"></div>
            
            <button class="new-campaign-btn" onclick="switchView('campaign')">
                <i class="fas fa-plus"></i> New Campaign
            </button>

            <div class="menu-item active" onclick="switchView('dashboard')" id="menu-dash">
                <i class="fas fa-home"></i> Home
            </div>
            <div class="menu-item" onclick="switchView('campaign')" id="menu-camp">
                <i class="fas fa-bullhorn"></i> Campaigns
            </div>
            <div class="menu-item" onclick="switchView('history')" id="menu-hist">
                <i class="fas fa-history"></i> History
            </div>
            <div class="menu-item" onclick="switchView('subscribers')" id="menu-subs">
                <i class="fas fa-users"></i> Subscribers
            </div>
            <div class="menu-item" onclick="switchView('automations')" id="menu-auto">
                <i class="fas fa-magic"></i> Automations
            </div>
            
            <div style="margin-top: auto;">
                <div class="menu-item" onclick="switchView('settings')" id="menu-set">
                    <i class="fas fa-cog"></i> Settings
                </div>
                <div class="menu-item" onclick="logout()">
                    <i class="fas fa-sign-out-alt"></i> Logout
                </div>
            </div>
        </div>

        <!-- MAIN AREA -->
        <div class="main-content">
            <!-- TOP BAR -->
            <div class="top-bar">
                <h2 id="pageTitle" style="font-size: 18px; margin: 0;">Dashboard</h2>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <div style="width: 32px; height: 32px; background: #e1e3e5; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: bold; color: var(--primary);" id="userInitials">S</div>
                    <span id="storeNameDisplay" style="font-size: 14px; font-weight: 500;">Store</span>
                </div>
            </div>

            <!-- DASHBOARD VIEW -->
            <div id="view-dashboard" class="content-area">
                
                <!-- STATS GRID -->
                <div class="stats-grid-4">
                    <div class="stat-card-premium">
                        <div class="stat-header">
                            <span class="stat-title">Campaigns Sent</span>
                            <div class="stat-icon" style="background:#eaf4ff; color:#2c6ecb;"><i class="fas fa-paper-plane"></i></div>
                        </div>
                        <div>
                            <div class="stat-value" id="stat-total-sent">0</div>
                            <div class="stat-trend">Last 30 days</div>
                        </div>
                    </div>

                    <div class="stat-card-premium">
                        <div class="stat-header">
                            <span class="stat-title">Total Subscribers</span>
                            <div class="stat-icon"><i class="fas fa-users"></i></div>
                        </div>
                        <div>
                            <div class="stat-value" id="stat-total-sub">0</div>
                            <div class="stat-trend">+12% vs last month</div>
                        </div>
                    </div>

                    <div class="stat-card-premium">
                        <div class="stat-header">
                            <span class="stat-title">Total Clicks (CTR)</span>
                            <div class="stat-icon" style="background:#fff4e5; color:#d97008;"><i class="fas fa-mouse-pointer"></i></div>
                        </div>
                        <div>
                            <div class="stat-value" id="stat-clicks">0 (0.00%)</div>
                            <div class="stat-trend">Real-time Data</div>
                        </div>
                    </div>

                     <div class="stat-card-premium">
                        <div class="stat-header">
                            <span class="stat-title">Impressions Consumed</span>
                            <div class="stat-icon" style="background:#f4f1ff; color:#9563ff;"><i class="fas fa-eye"></i></div>
                        </div>
                        <div>
                            <div class="stat-value" id="stat-impressions">0 / 500</div>
                            <div class="stat-trend" style="background:#eee; color:#666;">Limit Rests in 12d</div>
                        </div>
                    </div>
                </div>

                <!-- CHARTS GRID -->
                <div class="charts-grid-2">
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3>Subscribers Overview</h3>
                            <button class="btn-secondary" style="padding: 4px 12px; font-size: 12px;">Last 30 Days</button>
                        </div>
                        <div style="height: 250px;">
                            <canvas id="subChart"></canvas>
                        </div>
                    </div>
                    <div class="chart-card">
                        <div class="chart-header">
                            <h3>Clicks Overview</h3>
                            <button class="btn-secondary" style="padding: 4px 12px; font-size: 12px;">Last 30 Days</button>
                        </div>
                         <div style="height: 250px;">
                            <canvas id="revChart"></canvas>
                        </div>
                    </div>
                </div>

                 <div class="card">
                     <div class="chart-header">
                        <h3>Recent Campaigns</h3>
                        <a href="javascript:void(0)" onclick="switchView('history')" style="color: var(--primary); text-decoration: none; font-size: 14px;">View All</a>
                     </div>
                     <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
                        <thead>
                            <tr style="text-align: left; border-bottom: 1px solid #eee;">
                                <th style="padding: 10px; color: #666; font-size: 13px;">Date</th>
                                <th style="padding: 10px; color: #666; font-size: 13px;">Title</th>
                                <th style="padding: 10px; color: #666; font-size: 13px;">Sent To</th>
                            </tr>
                        </thead>
                        <tbody id="recentCampaignsBody">
                            <tr><td colspan="3" style="padding: 20px; text-align: center; color: #999;">Loading...</td></tr>
                        </tbody>
                     </table>
                </div>
            </div>

            <!-- CREATE CAMPAIGN WIZARD -->
            <div id="view-campaign" class="content-area hidden">
                <div style="margin-bottom: 24px;">
                    <h2 style="margin: 0;">Create New Campaign</h2>
                    <p style="color: #6d7175; margin: 4px 0 0 0;">Follow the steps to send a push notification.</p>
                </div>

                <!-- STEPPER -->
                <div class="stepper-container">
                    <div class="stepper">
                        <div class="step-item active" id="stepper-1"><div class="step-circle">1</div> Details</div>
                        <div class="step-item" id="stepper-2"><div class="step-circle">2</div> Content</div>
                        <div class="step-item" id="stepper-3"><div class="step-circle">3</div> Audience</div>
                        <div class="step-item" id="stepper-4"><div class="step-circle">4</div> Review</div>
                    </div>
                </div>

                <div class="wizard-layout">
                    <!-- LEFT COLUMN (FORMS) -->
                    <div>
                        
                        <!-- STEP 1: DETAILS -->
                        <div id="step-1" class="wizard-step">
                            <div class="wizard-card">
                                <h3>Campaign Type</h3>
                                <div class="selection-grid">
                                    <div class="selection-card selected" onclick="selectCampaignType(this, 'regular')">
                                        <div class="selection-title">Regular Broadcast</div>
                                        <div class="selection-desc">Standard push notification to all subscribers.</div>
                                    </div>
                                    <div class="selection-card" onclick="selectCampaignType(this, 'flash')">
                                        <div class="selection-title">Flash Sale ⚡️</div>
                                        <div class="selection-desc">Time-sensitive promotion with high urgency.</div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- STEP 2: CONTENT -->
                        <div id="step-2" class="wizard-step hidden">
                            <div class="wizard-card">
                                <h3>Notification Content</h3>
                                <div class="form-group">
                                    <label>Title *</label>
                                    <input type="text" id="campTitle" placeholder="e.g. Flash Sale! ⚡️" oninput="updatePreview()">
                                </div>
                                <div class="form-group">
                                    <label>Message *</label>
                                    <textarea id="campMsg" rows="3" placeholder="Describe your offer..." oninput="updatePreview()"></textarea>
                                </div>
                                <div class="form-group">
                                    <label>Primary Link</label>
                                    <input type="text" id="campUrl" placeholder="https://yourstore.com/products...">
                                </div>
                            </div>

                            <div class="wizard-card">
                                <h3>Media & Actions</h3>
                                <div class="form-group">
                                    <label>Hero Image URL</label>
                                    <input type="text" id="campImg" placeholder="https://..." oninput="updatePreview()">
                                </div>

                                <div class="form-group">
                                    <label>Notification Icon (Logo)</label>
                                    <input type="text" id="campIcon" placeholder="https://..." oninput="updatePreview()">
                                    <p class="stat-label">Rec: 100x100px (1:1 Ratio)</p>
                                </div>
                                
                                <h4 style="margin: 16px 0 12px 0;">Action Buttons (Optional)</h4>
                                <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
                                    <div class="form-group">
                                        <label>Button 1 Text</label>
                                        <input type="text" id="btn1Txt" placeholder="e.g. SHOP NOW">
                                    </div>
                                    <div class="form-group">
                                        <label>Button 1 URL</label>
                                        <input type="text" id="btn1Link" placeholder="https://...">
                                    </div>
                                </div>
                                <div class="grid" style="grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 0;">
                                    <div class="form-group">
                                        <label>Button 2 Text</label>
                                        <input type="text" id="btn2Txt" placeholder="e.g. CLAIM OFFER">
                                    </div>
                                    <div class="form-group">
                                        <label>Button 2 URL</label>
                                        <input type="text" id="btn2Link" placeholder="https://...">
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div id="step-3" class="wizard-step hidden">
                            <div class="wizard-card">
                                <h3>Target Audience</h3>
                                <div class="selection-card selected" style="margin-top: 10px;">
                                    <div class="selection-title">All Subscribers</div>
                                    <div class="selection-desc">Target all opt-in users from your store.</div>
                                </div>
                                <p style="font-size: 13px; color: #666; margin-top: 10px;">Estimated Reach: <b id="estReach">Loading...</b> users</p>
                            </div>

                            <div class="wizard-card">
                                <h3>Schedule</h3>
                                <div class="selection-grid">
                                    <div class="selection-card selected" id="sel-now" onclick="toggleSchedule('now')">
                                        <div class="selection-title">Send Now</div>
                                        <div class="selection-desc">Campaign will be sent immediately.</div>
                                    </div>
                                    <div class="selection-card" id="sel-later" style="opacity: 0.6; cursor: not-allowed; border: 1px solid #eee;">
                                        <div class="selection-title">Schedule for Later (Coming Soon 🚀)</div>
                                        <div class="selection-desc">Pick a future date and time.</div>
                                    </div>
                                </div>
                                <div id="scheduleTimeWrapper" class="hidden" style="margin-top: 15px;">
                                    <label>Send Date & Time</label>
                                    <input type="datetime-local" id="scheduleTime" class="form-control">
                                </div>
                            </div>

                             <!-- FLASH SALE ONLY -->
                             <div class="wizard-card hidden" id="expiryCard" style="border: 1px solid #fcd34d; background: #fffbeb;">
                                <h3 style="color: #b45309; display: flex; align-items: center; gap: 8px;"><i class="fas fa-bolt"></i> Flash Sale Expiry</h3>
                                <p style="font-size: 13px; color: #92400e; margin-bottom: 10px;">Set an expiry time for this limited offer (TTL).</p>
                                <label style="color: #92400e;">Offer Expires At</label>
                                <input type="datetime-local" id="expiryTime" class="form-control">
                            </div>
                        </div>

                         <!-- STEP 4: REVIEW -->
                         <div id="step-4" class="wizard-step hidden">
                            <div class="wizard-card">
                                <h3>Review Campaign</h3>
                                <table style="width: 100%; font-size: 14px;">
                                    <tr><td style="color:#666; padding:8px 0;">Campaign Name:</td><td style="font-weight:600;" id="revTitle">-</td></tr>
                                    <tr><td style="color:#666; padding:8px 0;">Message:</td><td style="font-weight:500;" id="revMsg">-</td></tr>
                                    <tr><td style="color:#666; padding:8px 0;">Audience:</td><td style="font-weight:500;">All Subscribers</td></tr>
                                    <tr><td style="color:#666; padding:8px 0;">Schedule:</td><td style="font-weight:500;" id="revSchedule">Immediately</td></tr>
                                </table>
                            </div>
                        </div>

                        <!-- NAVIGATION FOOTER -->
                        <div class="wizard-footer">
                            <button class="btn btn-secondary" id="btnBack" onclick="changeStep(-1)" style="min-width: 100px;">Back</button>
                            <button class="btn btn-primary" id="btnNext" onclick="changeStep(1)" style="min-width: 120px;">Continue</button>
                            <button class="btn btn-primary hidden" id="btnSend" onclick="sendBroadcastFinal()" style="min-width: 180px; background: #008060; display: flex; align-items: center; justify-content: center; gap: 8px;">
                                <i class="fas fa-paper-plane"></i> Send Campaign
                            </button>
                        </div>

                    </div>

                    <!-- PREVIEW IS STICKY -->
                    <div>
                        <div class="card" style="position: sticky; top: 20px;">
                            <h3>Preview (Android/Windows)</h3>
                            <div class="preview-box">
                                <div style="display: flex; gap: 10px; margin-bottom: 10px;">
                                    <div style="width: 40px; height: 40px; background: #ddd; border-radius: 50%; overflow: hidden; display: flex; align-items: center; justify-content: center;">
                                        <img id="prevIcon" src="" style="width: 100%; height: 100%; object-fit: cover; display: none;">
                                        <i id="prevIconPlaceholder" class="fas fa-bell" style="color: #999;"></i>
                                    </div>
                                    <div>
                                        <div style="font-weight: bold; font-size: 14px;" id="prevTitle">Campaign Title</div>
                                        <div style="font-size: 12px; color: #666;" id="prevMsg">Message body goes here...</div>
                                    </div>
                                </div>
                                <img id="prevImg" src="" style="display: none;" class="preview-hero">
                            </div>
                        </div>
                    </div>
                </div>
            </div>


            <!-- HISTORY VIEW -->
            <div id="view-history" class="content-area hidden">
                <!-- ANALYTICS CARDS -->
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px;">
                    <div class="card" style="display: flex; align-items: center; gap: 15px; padding: 20px;">
                        <div style="width: 45px; height: 45px; background: #eef2ff; color: #4338ca; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 20px;">
                            <i class="fas fa-paper-plane"></i>
                        </div>
                        <div>
                            <h3 style="margin: 0; font-size: 24px;" id="histTotalCamp">0</h3>
                            <p style="margin: 0; color: #666; font-size: 13px;">Total Campaigns</p>
                        </div>
                    </div>
                    <div class="card" style="display: flex; align-items: center; gap: 15px; padding: 20px;">
                        <div style="width: 45px; height: 45px; background: #f0f9ff; color: #0284c7; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 20px;">
                            <i class="fas fa-eye"></i>
                        </div>
                        <div>
                            <h3 style="margin: 0; font-size: 24px;" id="histTotalImp">0</h3>
                            <p style="margin: 0; color: #666; font-size: 13px;">Total Impressions</p>
                        </div>
                    </div>
                    <div class="card" style="display: flex; align-items: center; gap: 15px; padding: 20px;">
                        <div style="width: 45px; height: 45px; background: #ecfdf5; color: #059669; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 20px;">
                            <i class="fas fa-mouse-pointer"></i>
                        </div>
                        <div>
                            <h3 style="margin: 0; font-size: 24px;" id="histAvgCtr">0%</h3>
                            <p style="margin: 0; color: #666; font-size: 13px;">Avg. Click Rate</p>
                        </div>
                    </div>
                    <div class="card" style="display: flex; align-items: center; gap: 15px; padding: 20px;">
                        <div style="width: 45px; height: 45px; background: #fdf4ff; color: #c026d3; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 20px;">
                            <i class="fas fa-chart-line"></i>
                        </div>
                        <div>
                            <h3 style="margin: 0; font-size: 24px;" id="histRevenue">₹0</h3>
                            <p style="margin: 0; color: #666; font-size: 13px;">Revenue</p>
                        </div>
                    </div>
                </div>

                <!-- FILTERS -->
                <div class="card">
                     <div style="display: flex; gap: 20px; margin-bottom: 15px; border-bottom: 1px solid #eee;">
                        <button id="tab-all" class="filter-tab active" onclick="filterTable('all')">All</button>
                        <button id="tab-sent" class="filter-tab" onclick="filterTable('sent')">Sent (<span id="count-sent">0</span>)</button>
                        <button id="tab-scheduled" class="filter-tab" onclick="filterTable('scheduled')">Scheduled (<span id="count-scheduled">0</span>)</button>
                        <button id="tab-draft" class="filter-tab" onclick="void(0)" style="opacity: 0.5; cursor: default;">Draft (0)</button>
                    </div>
                    <style>
                        .filter-tab { background: none; border: none; padding: 10px 5px; cursor: pointer; color: #666; font-weight: 500; font-size: 14px; border-bottom: 2px solid transparent; margin-bottom: -1px; }
                        .filter-tab.active { color: #008060; border-bottom-color: #008060; font-weight: 600; }
                        .filter-tab:hover { color: #333; }
                    </style>

                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px;">
                        <h3 style="margin:0;">Campaign History</h3>
                        <button class="btn-secondary" onclick="triggerScheduler()" style="padding: 6px 12px; font-size: 13px; cursor: pointer;">
                            <i class="fas fa-sync"></i> Process Pending
                        </button>
                    </div>
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #f1f2f3; text-align: left;">
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Date</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Type</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Title</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Message</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Status</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Sent To</th>
                            </tr>
                        </thead>
                        <tbody id="historyTableBody">
                            <!-- Rows loaded via JS -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- SUBSCRIBERS VIEW -->
            <div id="view-subscribers" class="content-area hidden">
                <div class="card">
                    <h3>Subscribers List</h3>
                    <table style="width: 100%; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #f1f2f3; text-align: left;">
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Date</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Subscriber ID</th>
                                <th style="padding: 10px; border-bottom: 2px solid #ddd;">Status</th>
                            </tr>
                        </thead>
                        <tbody id="subscribersTableBody">
                            <!-- Rows loaded via JS -->
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- SETTINGS VIEW -->
            <div id="view-settings" class="content-area hidden">
                <div class="card" style="max-width: 600px; margin: 0 auto;">
                    <h3>Store Settings</h3>
                    <div class="form-group">
                        <label>Store Name</label>
                        <input type="text" id="setStoreName" placeholder="My Store">
                    </div>
                    <div class="form-group">
                        <label>Default Logo URL</label>
                        <input type="text" id="setLogoUrl" placeholder="https://example.com/logo.png">
                        <p style="font-size: 12px; color: #666; margin-top: 4px;">This logo will be used as the default notification icon.</p>
                    </div>
                    <div class="form-group">
                        <label>Contact Email</label>
                        <input type="email" id="setStoreEmail" placeholder="you@yourstore.com">
                        <p style="font-size: 12px; color: #666; margin-top: 4px;">Used as the sender contact for push services.</p>
                    </div>
                    <div class="form-group" style="display: flex; align-items: center; justify-content: space-between; background: #f9fafb; padding: 15px; border-radius: 8px; border: 1px solid #eee; margin-top: 20px;">
                        <div>
                            <div style="font-weight: 600; font-size: 14px;">Bypass Custom Popup</div>
                            <div style="font-size: 12px; color: #666; margin-top: 2px;">Directly show the browser's native notification prompt.</div>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="setDirectPrompt">
                            <span class="slider"></span>
                        </label>
                    </div>

                    <button class="new-campaign-btn" style="margin-top: 24px;" onclick="saveSettings()">Save Changes</button>
                    <div id="saveMsg" style="margin-top: 10px; font-weight: bold; color: green; display: none;">Saved Successfully!</div>
                </div>

                <div class="card" style="max-width: 600px; margin: 24px auto 0;">
                    <h3>Dashboard Password</h3>
                    <p style="font-size: 13px; color: #666; margin-top: 0;">Optional. Lets you log in at push-retner.vercel.app/store-admin without opening Shopify. Use at least 10 characters.</p>
                    <div class="form-group">
                        <label>New Password</label>
                        <input type="password" id="setNewPassword" autocomplete="new-password" placeholder="At least 10 characters">
                    </div>
                    <button class="btn-action" onclick="savePassword()">Set Password</button>
                    <div id="pwMsg" style="margin-top: 10px; font-size: 13px; display: none;"></div>
                </div>
            </div>

            <!-- AUTOMATIONS VIEW (rendered by /js/automations.js) -->
            <div id="view-automations" class="content-area hidden">
                <div id="automations-root"></div>
            </div>
        </div>
    </div>

    <script>
        // STATE
        let injectedStore = ${injectedStore ? JSON.stringify(injectedStore).replace(/</g, '\\u003c') : 'null'};
        let store = null;
        const initialView = new URLSearchParams(window.location.search).get('view');

        if (injectedStore) {
            store = injectedStore;
            try {
                localStorage.setItem('store', JSON.stringify(store));
            } catch(e) {
                console.error("Storage Error", e);
            }
            // Clear SSO token from URL
            if (window.history.replaceState) {
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        } else {
            try { store = JSON.parse(localStorage.getItem('store') || 'null'); } catch(e) { store = null; }
            // Sessions from before the security update have no token: log in again.
            if (store && !store.token) { localStorage.removeItem('store'); store = null; }
        }

        // Every /my-store/* call carries the session token; a 401 means the
        // session expired, so we go back to the login screen.
        function sessionExpired() {
            localStorage.removeItem('store');
            store = null;
            document.getElementById('mainApp').classList.add('hidden');
            document.getElementById('mainApp').style.display = 'none';
            document.getElementById('authScreen').classList.remove('hidden');
        }
        const _nativeFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.indexOf('/my-store/') === 0 && store && store.token) {
                init = Object.assign({}, init || {});
                init.headers = Object.assign({}, init.headers || {}, { 'Authorization': 'Bearer ' + store.token });
                return _nativeFetch(input, init).then(function (r) {
                    if (r.status === 401) sessionExpired();
                    return r;
                });
            }
            return _nativeFetch(input, init);
        };
        async function apiFetch(path, options) {
            const opts = Object.assign({}, options || {});
            if (opts.body && typeof opts.body !== 'string') {
                opts.body = JSON.stringify(opts.body);
                opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
            }
            const res = await window.fetch(path, opts);
            let data = null;
            try { data = await res.json(); } catch (e) { data = null; }
            return { ok: res.ok, status: res.status, data: data || {} };
        }
        
        // INIT
        if(store) {
            initApp();
        } else {
            document.getElementById('authScreen').classList.remove('hidden');
        }

        function initApp() {
            document.getElementById('authScreen').classList.add('hidden');
            document.getElementById('mainApp').classList.remove('hidden');
            document.getElementById('mainApp').style.display = 'flex'; // Ensure flex
            
            document.getElementById('storeNameDisplay').innerText = store.name;
            document.getElementById('userInitials').innerText = store.name.charAt(0).toUpperCase();

            loadStats();
            // Deep link from the Shopify app, e.g. ?view=automations
            if (initialView && ['automations', 'campaign', 'history', 'subscribers', 'settings'].indexOf(initialView) !== -1) {
                switchView(initialView);
            }
        }

        // NAVIGATION
        function switchView(viewName) {
            // Update Menu Active State
            document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('active'));
            if(viewName === 'dashboard') document.getElementById('menu-dash').classList.add('active');
            if(viewName === 'campaign') document.getElementById('menu-camp').classList.add('active');
            if(viewName === 'history') {
                document.getElementById('menu-hist').classList.add('active');
                loadCampaignHistory();
            }
            if(viewName === 'subscribers') {
                document.getElementById('menu-subs').classList.add('active');
                loadSubscribers();
            }
            if(viewName === 'settings') {
                document.getElementById('menu-set').classList.add('active');
                loadSettings();
            }
            if(viewName === 'automations') {
                document.getElementById('menu-auto').classList.add('active');
                loadAutomations();
            }

            // Hide all content areas
            document.querySelectorAll('.content-area').forEach(v => v.classList.add('hidden'));
            
            // Show Selected
            document.getElementById('view-'+viewName).classList.remove('hidden');
            let titles = {
                dashboard: 'Dashboard', 
                campaign: 'Create Campaign', 
                history: 'Campaign History', 
                subscribers: 'Subscribers List', 
                settings: 'Settings', 
                automations: 'Automations',
                'automation-editor': 'Automation Editor'
            };
            document.getElementById('pageTitle').innerText = titles[viewName] || 'SmartPush';

            // Reset wizard state if switching to campaign view
            if(viewName === 'campaign') {
                resetWizard();
            }
        }

        function resetWizard() {
            currentStep = 1;
            document.querySelectorAll('.wizard-step').forEach(s => s.classList.add('hidden'));
            document.getElementById('step-1').classList.remove('hidden');
            document.querySelectorAll('.step-item').forEach(i => i.classList.remove('active'));
            document.getElementById('stepper-1').classList.add('active');
            updateButtons();
        }

        // PREVIEW LOGIC
        function updatePreview() {
            const title = document.getElementById('campTitle').value || 'Campaign Title';
            const msg = document.getElementById('campMsg').value || 'Message body...';
            const img = document.getElementById('campImg').value;
            const icon = document.getElementById('campIcon').value;
            
            document.getElementById('prevTitle').innerText = title;
            document.getElementById('prevMsg').innerText = msg;
            
            const imgEl = document.getElementById('prevImg');
            if(img) {
                imgEl.src = img;
                imgEl.style.display = 'block';
            } else {
                imgEl.style.display = 'none';
            }

            const iconEl = document.getElementById('prevIcon');
            const iconPlaceholder = document.getElementById('prevIconPlaceholder');
            if(icon) {
                iconEl.src = icon;
                iconEl.style.display = 'block';
                iconPlaceholder.style.display = 'none';
            } else {
                iconEl.style.display = 'none';
                iconPlaceholder.style.display = 'block';
            }
        }

        // API ACTIONS
        async function login() {
            const storeId = document.getElementById('storeId').value;
            const password = document.getElementById('password').value;
            
            const res = await fetch('/store-login', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ storeId, password })
            });
            const data = await res.json();
            if(data.success) {
                store = data.store;
                localStorage.setItem('store', JSON.stringify(store));
                initApp();
            } else {
                alert(data.error);
            }
        }

        async function loadStats() {
            const res = await fetch('/my-store/stats?storeId=' + store.id);
            const data = await res.json();
            
            // POPULATE CARDS with REALISTIC DATA
            const subCount = data.subscribers || 0;
            const campCount = data.campaigns || 0;
            const impressions = data.totalImpressions || 0;
            const revenue = data.totalRevenue || 0;
            const clicks = data.totalClicks || 0;
            const ctr = impressions > 0 ? ((clicks / impressions) * 100).toFixed(2) : '0.00';

            document.getElementById('stat-total-sub').innerText = subCount;
            document.getElementById('stat-total-sent').innerText = campCount;
            if(document.getElementById('stat-clicks')) {
                 document.getElementById('stat-clicks').innerText = clicks + " (" + ctr + "%)";
            }
            if(document.getElementById('stat-revenue')) {
                 document.getElementById('stat-revenue').innerText = '₹' + revenue.toFixed(2);
            }
            document.getElementById('stat-impressions').innerText = impressions + ' / 5000'; // Higher limit for demo

            // Render Sub Chart
            const ctx = document.getElementById('subChart').getContext('2d');
            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
                    datasets: [{
                        label: 'New Subscribers',
                        data: [0, Math.floor(subCount * 0.2), Math.floor(subCount * 0.5), subCount],
                        borderColor: '#2563EB',
                        tension: 0.4,
                        fill: true,
                        backgroundColor: 'rgba(37, 99, 235, 0.1)'
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { display: false } } }
            });

            // Render Rev Chart (Mocked relative to revenue)
            const ctx2 = document.getElementById('revChart').getContext('2d');
            new Chart(ctx2, {
                type: 'bar',
                data: {
                    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
                    datasets: [{
                        label: 'Clicks',
                        data: [Math.floor(clicks * 0.1), Math.floor(clicks * 0.15), Math.floor(clicks * 0.2), Math.floor(clicks * 0.25), Math.floor(clicks * 0.1), Math.floor(clicks * 0.15), Math.floor(clicks * 0.05)], 
                        backgroundColor: '#3B82F6',
                        borderRadius: 4
                    }]
                },
                options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false } }, y: { display: false } } }
            });

            // POPULATE RECENT CAMPAIGNS
            const tbodyRecent = document.getElementById('recentCampaignsBody');
            tbodyRecent.innerHTML = '';
            if(data.recentCampaigns && data.recentCampaigns.length > 0) {
                data.recentCampaigns.forEach(camp => {
                    const date = new Date(camp.created_at).toLocaleDateString();
                    tbodyRecent.innerHTML += '<tr style="border-bottom: 1px solid #f9f9f9;">' +
                        '<td style="padding: 12px 10px; font-size: 13px; color: #555;">' + date + '</td>' +
                        '<td style="padding: 12px 10px; font-weight: 500; font-size: 14px;">' + camp.title + '</td>' +
                        '<td style="padding: 12px 10px;"><span style="background: #DBEAFE; color: #1E40AF; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;">' + camp.sent_count + ' Sent</span></td>' +
                    '</tr>';
                });
            } else {
                tbodyRecent.innerHTML = '<tr><td colspan="3" style="padding: 20px; text-align: center; color: #999;">No recent campaigns found.</td></tr>';
            }
        }

        async function triggerScheduler() {
            const btn = document.querySelector('button[onclick="triggerScheduler()"]');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            btn.disabled = true;
            try {
                const res = await fetch('/my-store/run-automations', { method: 'POST' });
                const data = await res.json();
                if (data.success) {
                    alert('✅ Done. Scheduled campaigns sent: ' + (data.summary.scheduledCampaigns || 0) +
                          '\\nAutomation notifications sent: ' + ((data.summary.abandoned || 0) + (data.summary.browse || 0) + (data.summary.winback || 0)) +
                          '\\n(This also runs automatically every 5 minutes.)');
                } else {
                    alert('Could not run now: ' + (data.error || 'unknown error'));
                }
                loadCampaignHistory();
            } catch(e) { alert('Error: ' + e.message); }
            btn.innerHTML = originalText;
            btn.disabled = false;
        }

        async function loadCampaignHistory() {
            const res = await fetch('/my-store/campaigns?storeId=' + store.id);
            const data = await res.json();
            const tbody = document.getElementById('historyTableBody');
            tbody.innerHTML = ''; // Clear for analytics loop, but rendering is moved to filterTable

            
            // ANALYTICS CALCULATION
            let totalSent = 0;
            let totalImpressions = 0;
            let totalClicks = 0;
            let totalRevenue = 0;

            // STORE GLOBAL
            window.allCampaigns = data.campaigns;

            data.campaigns.forEach(camp => {
                if(camp.status !== 'scheduled') {
                    totalSent++;
                    totalImpressions += (camp.sent_count || 0);
                    totalClicks += (camp.clicks || 0);
                    totalRevenue += parseFloat(camp.revenue || 0);
                }
            });
            
            // INIT FILTER
            filterTable('all');

            // UPDATE ANALYTICS UI
            
            // UPDATE ANALYTICS UI
            const elTotalCamp = document.getElementById('histTotalCamp');
            const elTotalImp = document.getElementById('histTotalImp');
            const elAvgCtr = document.getElementById('histAvgCtr');
            const elRevenue = document.getElementById('histRevenue');

            if(elTotalCamp) elTotalCamp.innerText = totalSent;
            if(elTotalImp) elTotalImp.innerText = totalImpressions;
            
            let ctrVal = '0%';
            if(totalImpressions > 0) {
                 ctrVal = ((totalClicks / totalImpressions) * 100).toFixed(2) + '%';
            }
            if(elAvgCtr) elAvgCtr.innerText = ctrVal;

            if(elRevenue) elRevenue.innerText = '₹' + totalRevenue.toFixed(2);

            if(data.campaigns.length === 0) {
                tbody.innerHTML = '<tr><td colspan="4" style="padding: 20px; text-align: center;">No campaigns sent yet.</td></tr>';
            }
        }

        function filterTable(type) {
             const tabs = ['all', 'sent', 'scheduled', 'draft'];
             tabs.forEach(t => { 
                const el = document.getElementById('tab-'+t);
                if(el) {
                    if(t === type) el.classList.add('active');
                    else el.classList.remove('active'); 
                }
             });

             const tbody = document.getElementById('historyTableBody');
             tbody.innerHTML = '';
             
             let filtered = [];
             if(!window.allCampaigns) window.allCampaigns = [];
             
             if(type === 'all') filtered = window.allCampaigns;
             else if(type === 'sent') filtered = window.allCampaigns.filter(c => c.status !== 'scheduled');
             else if(type === 'scheduled') filtered = window.allCampaigns.filter(c => c.status === 'scheduled');
             
             // Update Counts
             const sentCount = window.allCampaigns.filter(c => c.status !== 'scheduled').length;
             const schCount = window.allCampaigns.filter(c => c.status === 'scheduled').length;
             if(document.getElementById('count-sent')) document.getElementById('count-sent').innerText = sentCount;
             if(document.getElementById('count-scheduled')) document.getElementById('count-scheduled').innerText = schCount;

             if(filtered.length === 0) {
                  tbody.innerHTML = '<tr><td colspan="6" style="padding: 20px; text-align: center; color: #999;">No campaigns found.</td></tr>';
                  return;
             }

             filtered.forEach(camp => {
                const date = new Date(camp.created_at).toLocaleDateString() + ' ' + new Date(camp.created_at).toLocaleTimeString();
                let statusBadge = '<span style="background: #e4e5e7; padding: 2px 8px; border-radius: 10px;">Sent</span>';
                if(camp.status === 'scheduled') statusBadge = '<span style="background: #fff4e5; color: #b45309; padding: 2px 8px; border-radius: 10px; font-weight:600;">⏳ Scheduled</span>';
                
                let typeStr = 'Regular';
                if(camp.type === 'flash') typeStr = '⚡ Flash Sale';
                
                tbody.innerHTML += '<tr style="border-bottom: 1px solid #eee;">' +
                    '<td style="padding: 10px; color: #666; font-size: 13px;">' + date + '</td>' +
                    '<td style="padding: 10px; font-weight: 500; font-size: 13px;">' + typeStr + '</td>' +
                    '<td style="padding: 10px; font-weight: 500;">' + camp.title + '</td>' +
                    '<td style="padding: 10px; color: #555;">' + camp.message.substring(0, 50) + '...</td>' +
                    '<td style="padding: 10px;">' + statusBadge + '</td>' +
                    '<td style="padding: 10px;"><span style="background: #e4e5e7; padding: 2px 8px; border-radius: 10px; font-size: 12px;">' + camp.sent_count + '</span></td>' +
                '</tr>';
             });
        }

        async function loadSubscribers() {
            const res = await fetch('/my-store/subscribers?storeId=' + store.id);
            const data = await res.json();
            const tbody = document.getElementById('subscribersTableBody');
            tbody.innerHTML = '';
            const rows = [];

            data.subscribers.forEach((sub, index) => {
                const date = sub.createdAt ? new Date(sub.createdAt).toLocaleDateString() : 'N/A';
                const idShort = 'User-' + (index + 1);
                const expired = sub.status === 'expired';
                rows.push('<tr style="border-bottom: 1px solid #eee;">' +
                    '<td style="padding: 10px; color: #666;">' + date + '</td>' +
                    '<td style="padding: 10px; font-weight: 500;">' + idShort + '</td>' +
                    '<td style="padding: 10px;"><span style="background: ' + (expired ? '#f1f1f1' : '#cbf4c9') + '; color: ' + (expired ? '#6d7175' : '#007f5f') + '; padding: 2px 8px; border-radius: 10px; font-size: 12px;">' + (expired ? 'Unsubscribed' : 'Active') + '</span></td>' +
                '</tr>');
            });
            tbody.innerHTML = rows.join('');
            if (data.total && data.total > data.subscribers.length) {
                tbody.innerHTML += '<tr><td colspan="3" style="padding: 12px; text-align: center; color: #666; font-size: 13px;">Showing the latest ' + data.subscribers.length + ' of ' + data.total + ' subscribers.</td></tr>';
            }
             if(data.subscribers.length === 0) {
                 tbody.innerHTML = '<tr><td colspan="3" style="padding: 20px; text-align: center;">No subscribers yet.</td></tr>';
             }
        }

        // WIZARD LOGIC
        let currentStep = 1;
        
        let campaignType = 'regular'; // Default

        function selectCampaignType(el, type) {
            document.querySelectorAll('.selector-card, .selection-card').forEach(c => c.classList.remove('selected'));
            el.classList.add('selected');
            campaignType = type;
        }

        let scheduleMode = 'now';
        function toggleSchedule(mode) {
             scheduleMode = mode;
             document.getElementById('sel-now').classList.remove('selected');
             document.getElementById('sel-later').classList.remove('selected');
             document.getElementById('sel-' + mode).classList.add('selected');
             
             if(mode === 'later') document.getElementById('scheduleTimeWrapper').classList.remove('hidden');
             else document.getElementById('scheduleTimeWrapper').classList.add('hidden');
        }

        function changeStep(dir) {
            const newStep = parseInt(currentStep) + dir;
            if(newStep < 1 || newStep > 4) return;

            // Entering Step 2 (Content)
            if(newStep === 2 && dir === 1) {
                if(campaignType === 'flash') {
                     const t = document.getElementById('campTitle');
                     const m = document.getElementById('campMsg');
                     if(!t.value) t.value = "⚡ Flash Sale! 50% Off";
                     if(!m.value) m.value = "Hurry! Limited time offer ending soon. Shop now!";
                     updatePreview();
                }
            }

            if(currentStep === 2 && dir === 1) {
                if(!document.getElementById('campTitle').value || !document.getElementById('campMsg').value) {
                    alert('Please fill in Title and Message');
                    return;
                }
            }
            if(newStep === 3) {
                fetch('/my-store/stats?storeId=' + store.id)
                    .then(r => r.json())
                    .then(d => { document.getElementById('estReach').innerText = d.subscribers || 0; });
                
                // Show Expiry for Flash
                 const exCard = document.getElementById('expiryCard');
                 if(campaignType === 'flash') exCard.classList.remove('hidden');
                 else exCard.classList.add('hidden');
            }
            if(newStep === 4) {
                renderReview();
            }

            document.getElementById('step-' + currentStep).classList.add('hidden');
            document.getElementById('step-' + newStep).classList.remove('hidden');
            
            document.getElementById('stepper-' + currentStep).classList.remove('active');
            document.getElementById('stepper-' + newStep).classList.add('active');
            
            currentStep = newStep;
            updateButtons();
        }

        function updateButtons() {
            const backBtn = document.getElementById('btnBack');
            const nextBtn = document.getElementById('btnNext');
            const sendBtn = document.getElementById('btnSend');

            backBtn.disabled = (currentStep === 1);
            
            if(currentStep === 4) {
                nextBtn.classList.add('hidden');
                sendBtn.classList.remove('hidden');
            } else {
                nextBtn.classList.remove('hidden');
                sendBtn.classList.add('hidden');
            }
        }

        function renderReview() {
            document.getElementById('revTitle').innerText = document.getElementById('campTitle').value;
            document.getElementById('revMsg').innerText = document.getElementById('campMsg').value;
            
            const timeVal = document.getElementById('scheduleTime').value;
            let scheduleText = 'Immediately';
            if(scheduleMode === 'later' && timeVal) {
                scheduleText = new Date(timeVal).toLocaleString();
            }
            const revSch = document.getElementById('revSchedule');
            if(revSch) revSch.innerText = scheduleText;
        }

        async function sendBroadcastFinal() {
            const btn = document.getElementById('btnSend');
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
            btn.disabled = true;

            await sendBroadcast(); // Reuse existing logic

            btn.innerHTML = '🚀 Send Campaign';
            btn.disabled = false;
        }

        async function sendBroadcast() {
            const title = document.getElementById('campTitle').value;
            const message = document.getElementById('campMsg').value;
            const image = document.getElementById('campImg').value;
            const rawUrl = document.getElementById('campUrl').value;
            
            // UTM Tracking Helper
            const appendUTM = (url, campId) => {
                if(!url) return url;
                const sep = url.indexOf('?') !== -1 ? '&' : '?';
                const campaign = encodeURIComponent(title.replace(/\s+/g, '-').toLowerCase());
                return url + sep + 'utm_source=push-retner&utm_medium=push&utm_campaign=push_camp_' + campId;
            };

            // URL will be updated after campaign ID is known
            let urlForPayload = rawUrl; 
            const icon = document.getElementById('campIcon').value;
            const btn1Text = document.getElementById('btn1Txt').value;
            const btn1UrlRaw = document.getElementById('btn1Link').value;
            let btn1UrlForPayload = btn1UrlRaw || rawUrl;

            const btn2Text = document.getElementById('btn2Txt').value;
            const btn2UrlRaw = document.getElementById('btn2Link').value;
            let btn2UrlForPayload = btn2UrlRaw || rawUrl;

            let scheduledAt = null;
            if(scheduleMode === 'later') {
                 const val = document.getElementById('scheduleTime').value;
                 if(val) scheduledAt = new Date(val).toISOString();
            }
            let expiryAt = null;
            if(campaignType === 'flash') {
                 const val = document.getElementById('expiryTime').value;
                 if(val) expiryAt = new Date(val).toISOString();
            }

            const actions = [];
            // Actions will be populated after campId is known

            // Original fetch call logic
            const res = await fetch('/my-store/broadcast', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ storeId: store.id, title, message, url: rawUrl, image, icon, actions, type: campaignType, scheduledAt, expiryAt, btn1Text, btn1UrlRaw, btn2Text, btn2UrlRaw })
            });
            const data = await res.json();
            
            if(data.success) {
                if(data.status === 'scheduled') {
                    alert('📅 Campaign Scheduled Successfully!');
                } else {
                    if(data.sent === 0 && data.lastError) {
                        alert('⚠️ Sent to 0. Reason: ' + data.lastError);
                    } else {
                        alert('✅ Sent to ' + data.sent + ' subscribers!');
                    }
                }
                switchView('dashboard'); // Go back to dash
                // Reset Wizard
                currentStep = 1;
                // Ideally reset inputs here too
            } else {
                alert('❌ Failed: ' + data.error);
            }
        }

        function logout() {
            localStorage.removeItem('store');
            location.reload();
        }

        async function savePassword() {
            const input = document.getElementById('setNewPassword');
            const msg = document.getElementById('pwMsg');
            const res = await apiFetch('/my-store/set-password', { method: 'POST', body: { password: input.value } });
            msg.style.display = 'block';
            msg.style.color = res.data.success ? 'green' : '#b91c1c';
            msg.innerText = res.data.success ? 'Password saved. You can now log in with your store ID and this password.' : (res.data.error || 'Could not save password');
            if (res.data.success) input.value = '';
        }

        async function loadSettings() {
             const res = await fetch('/my-store/details?storeId=' + store.id);
             const data = await res.json();
             if(data.success) {
                 document.getElementById('setStoreName').value = data.store.store_name;
                 document.getElementById('setLogoUrl').value = data.store.logo_url || '';
                 document.getElementById('setStoreEmail').value = data.store.store_email || '';
                 document.getElementById('setDirectPrompt').checked = data.store.direct_prompt_enabled || false;
             }
        }

        async function saveSettings() {
            const storeName = document.getElementById('setStoreName').value;
            const logoUrl = document.getElementById('setLogoUrl').value;
            const storeEmail = document.getElementById('setStoreEmail').value;
            const directPromptEnabled = document.getElementById('setDirectPrompt').checked;

            const btn = document.querySelector('#view-settings button');
            const originalText = btn.innerHTML;
            btn.innerHTML = 'Saving...';
            btn.disabled = true;
            
            const res = await fetch('/my-store/update-settings', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ storeId: store.id, storeName, logoUrl, storeEmail, directPromptEnabled })
            });
            const data = await res.json();
            btn.innerHTML = originalText;
            btn.disabled = false;
            
            if(data.success) {
                // Update Local Store Object
                store.name = storeName;
                localStorage.setItem('store', JSON.stringify(store));
                document.getElementById('storeNameDisplay').innerText = storeName;
                document.getElementById('userInitials').innerText = storeName.charAt(0).toUpperCase();

                const msg = document.getElementById('saveMsg');
                if(msg) {
                    msg.style.display = 'block';
                    setTimeout(() => msg.style.display = 'none', 3000);
                }
            } else {
                alert('Error: ' + data.error);
            }
        }
        /* Automations UI lives in /js/automations.js */
        function loadAutomations() {
            if (window.RetnerAutomations) {
                window.RetnerAutomations.mount(document.getElementById("automations-root"), { store: store, api: apiFetch });
            }
        }
    </script>
</body>
</html>`);
});

// Every /my-store/* route requires a valid store session; the store id is
// taken from the session token (see auth.requireStore).
app.use('/my-store', auth.requireStore);

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

        res.json({
            subscribers: parseInt(subRes.rows[0].count),
            campaigns: parseInt(campRes.rows[0].total_campaigns || 0),
            totalImpressions: parseInt(campRes.rows[0].total_impressions || 0),
            totalRevenue: parseFloat(campRes.rows[0].total_revenue || 0),
            totalClicks: parseInt(campRes.rows[0].total_clicks || 0),
            recentCampaigns: recentRes.rows
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
        const [list, total] = await Promise.all([
            db.query(`SELECT created_at AS "createdAt", COALESCE(status, 'active') AS status FROM subscriptions WHERE store_id = $1 ORDER BY created_at DESC NULLS LAST LIMIT 500`, [req.storeId]),
            db.query(`SELECT COUNT(*)::int AS n FROM subscriptions WHERE store_id = $1`, [req.storeId]),
        ]);
        res.json({ subscribers: list.rows, total: total.rows[0].n });
    } catch (e) { res.status(500).json({ subscribers: [] }); }
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

// Broadcast API
app.post('/my-store/broadcast', async (req, res) => {
    const storeId = req.storeId;
    const { title, message, url, image, type, scheduledAt, expiryAt, btn1Text, btn1UrlRaw, btn2Text, btn2UrlRaw } = req.body || {};
    try {
        if (!title || !message) return res.status(400).json({ success: false, error: 'Title and message are required.' });
        const db = getPool();

        // Insert the campaign first: its id is used for click/revenue tracking.
        const insertResult = await db.query(
            `INSERT INTO campaigns (store_id, title, message, url, image, status, type, scheduled_at, expiry_at, sent_count, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, NOW()) RETURNING *`,
            [storeId, String(title).slice(0, 120), String(message).slice(0, 500), url || null,
             (image && !String(image).startsWith('data:')) ? image : null,
             scheduledAt ? 'scheduled' : 'sending', type || 'regular', scheduledAt || null, expiryAt || null]
        );
        const camp = insertResult.rows[0];

        if (scheduledAt && new Date(scheduledAt) > new Date()) {
            return res.json({ success: true, sent: 0, status: 'scheduled' });
        }

        const store = (await automations.loadStore(db, storeId)) || { store_id: storeId };
        const result = await automations.sendCampaign(
            { db, webPush },
            store,
            camp,
            { btn1Text, btn1Url: btn1UrlRaw, btn2Text, btn2Url: btn2UrlRaw }
        );
        res.json({ success: true, sent: result.sent, total: result.total, status: 'sent', lastError: result.lastError });
    } catch (e) {
        console.error('Broadcast error:', e.message);
        res.status(500).json({ success: false, error: 'Could not send the campaign. Please try again.' });
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

        const sub = subRes.rows[0];
        const domain = /^[a-z0-9.-]+$/i.test(sub.store_domain || '') ? sub.store_domain : `${storeId}.myshopify.com`;
        const result = await automations.sendAutomated({ db, webPush }, {
            store,
            automation: 'welcome',
            step: 1,
            sub: { endpoint: sub.endpoint, keys: sub.keys },
            refId: null,
            title: automations.renderTemplate(store.welcome_title || 'Welcome!', { store_name: store.store_name || storeId }),
            body: automations.renderTemplate(store.welcome_body || 'Thanks for subscribing.', { store_name: store.store_name || storeId }),
            image: null,
            targetUrl: `https://${domain}/?utm_source=retner-push&utm_medium=push&utm_campaign=welcome`,
            button: 'Visit store',
            tag: 'retner-welcome',
        });
        if (result.ok) await db.query('UPDATE stores SET welcome_sent_count = COALESCE(welcome_sent_count, 0) + 1 WHERE store_id = $1', [storeId]);
        res.json({ success: !!result.ok });
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