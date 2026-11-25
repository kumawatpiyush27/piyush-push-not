'use strict';
// Push data now lives in Retner (app.retner.ai, MongoDB). When RETNER_BACKEND_URL
// is set, this dashboard's /my-store/* API is forwarded there with the same
// app token the Shopify app uses (a short JWT signed with SHOPIFY_API_SECRET,
// which Retner knows as PUSH_APP_SECRET). Store login, passwords, the plan
// page and the super admin stay in this backend's Postgres.
//
// Unset RETNER_BACKEND_URL and everything falls back to the local Postgres
// handlers below it in server.js.

const jwt = require('jsonwebtoken');

const RETNER_BACKEND_URL = () => (process.env.RETNER_BACKEND_URL || '').replace(/\/$/, '');
const enabled = () => !!RETNER_BACKEND_URL();

function appToken(shop) {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) throw new Error('SHOPIFY_API_SECRET is not configured');
    return jwt.sign({ shop, role: 'app' }, secret, { algorithm: 'HS256', expiresIn: '2m' });
}

// /my-store/<x> -> /api/push/app/<x>; a few paths differ in Retner.
const PATH_MAP = {
    'broadcast': 'campaigns',
    'campaign-test': 'campaigns/test',
    'automation-test': 'automations/test',
    'run-automations': 'automations/run',
};
// Everything the dashboard needs from Retner. Not listed (plan, usage,
// upgrade-request, set-password) stays local.
const PROXIED = new Set([
    'media', 'analytics', 'carts', 'events', 'stats', 'campaigns', 'subscribers', 'segments', 'campaign-test',
    'broadcast', 'details', 'update-settings', 'automations', 'automation-test', 'run-automations',
]);

function targetPath(rest) {
    // rest = "campaigns/123/cancel" | "broadcast" | ...
    const [head, ...tail] = rest.split('/');
    if (!PROXIED.has(head)) return null;
    const mapped = PATH_MAP[head] || head;
    return [mapped, ...tail].join('/');
}

async function forward({ method, shop, path, query, body, contentType }) {
    const url = new URL(`${RETNER_BACKEND_URL()}/api/push/app/${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    const headers = { Authorization: `Bearer ${appToken(shop)}` };
    let payload;
    if (body !== undefined && body !== null && method !== 'GET') {
        if (Buffer.isBuffer(body)) {
            headers['Content-Type'] = contentType || 'application/octet-stream';
            payload = body;
        } else {
            headers['Content-Type'] = 'application/json';
            payload = JSON.stringify(body);
        }
    }
    const res = await fetch(url, { method, headers, body: payload });
    let data;
    try { data = await res.json(); } catch { data = { success: res.ok }; }
    return { status: res.status, data };
}

// Express middleware for app.all('/my-store/*'): forwards proxied paths,
// passes the rest on to the local handlers.
function myStoreProxy(req, res, next) {
    if (!enabled()) return next();
    const rest = req.params[0] || '';
    const path = targetPath(rest);
    if (!path) return next();
    const shop = `${req.storeId}.myshopify.com`;
    const query = Object.assign({}, req.query);
    delete query.storeId;
    let body = req.body;
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) { body = Object.assign({}, body); delete body.storeId; }
    forward({ method: req.method, shop, path, query, body, contentType: req.get('Content-Type') })
        .then(({ status, data }) => res.status(status).json(data))
        .catch((e) => {
            console.error('Retner proxy error:', e.message);
            res.status(502).json({ success: false, error: 'Retner is not reachable right now. Please try again.' });
        });
}

// Storefront helpers that used to write Postgres directly.
async function publicForward(method, shop, path, query, body) {
    return forward({ method, shop, path, query, body });
}

async function vapidPublicKey() {
    const res = await fetch(`${RETNER_BACKEND_URL()}/api/push/vapid-public-key`);
    const data = await res.json();
    return data.publicKey || null;
}

module.exports = { enabled, myStoreProxy, publicForward, vapidPublicKey, appToken, targetPath, PROXIED };
