'use strict';
// Dashboard authentication for Retner SmartPush.
//
// - Store sessions: short JWTs signed with JWT_SECRET, sent as
//   "Authorization: Bearer <token>" on every /my-store/* request. The store id
//   always comes from the token, never from the request.
// - SSO from the Shopify app: JWT signed with the Shopify app's client secret
//   (SHOPIFY_API_SECRET), which only Shopify and our servers know.
// - Super admin: password from SUPER_ADMIN_PASSWORD (disabled when unset).
// - Store passwords are stored as scrypt hashes; legacy plain-text passwords
//   are upgraded on the next successful login.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const ISSUER = 'retner-push';
const SSO_MANAGED = 'sso-managed';

function jwtSecret() {
    const s = process.env.SESSION_SECRET || process.env.JWT_SECRET;
    if (!s || s.length < 16) throw new Error('SESSION_SECRET is not configured');
    return s;
}

// ---------------------------------------------------------------- passwords
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('base64url');
    const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
    return `scrypt$${salt}$${hash}`;
}

function safeEqualStr(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Returns { ok, needsUpgrade }.
function verifyPassword(stored, password) {
    if (!stored || !password || stored === SSO_MANAGED) return { ok: false };
    if (stored.startsWith('scrypt$')) {
        const [, salt, hash] = stored.split('$');
        if (!salt || !hash) return { ok: false };
        const candidate = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url');
        return { ok: safeEqualStr(candidate, hash) };
    }
    return { ok: safeEqualStr(stored, password), needsUpgrade: true };
}

function validateNewPassword(password) {
    if (typeof password !== 'string' || password.length < 10) return 'Password must be at least 10 characters.';
    if (password.length > 200) return 'Password is too long.';
    return null;
}

// ------------------------------------------------------------ store session
function issueStoreToken(storeId) {
    return jwt.sign({ typ: 'store' }, jwtSecret(), { subject: String(storeId), issuer: ISSUER, expiresIn: '7d' });
}

function bearer(req) {
    const h = req.get('Authorization') || '';
    return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

// Store id from a dashboard session token, or — for server-to-server calls
// from the Shopify app — from a short-lived token signed with the app secret.
function storeIdFromToken(token) {
    try {
        const decoded = jwt.verify(token, jwtSecret(), { issuer: ISSUER });
        if (decoded.typ === 'store' && decoded.sub) return decoded.sub;
    } catch { /* not a session token */ }
    try {
        const sso = verifySsoToken(token);
        return sso.shop.split('.')[0].toLowerCase();
    } catch { return null; }
}

function requireStore(req, res, next) {
    try {
        const token = bearer(req);
        if (!token) return res.status(401).json({ success: false, error: 'login_required' });
        const storeId = storeIdFromToken(token);
        if (!storeId) return res.status(401).json({ success: false, error: 'login_required' });
        const asked = (req.query && req.query.storeId) || (req.body && req.body.storeId);
        if (asked && asked !== storeId) return res.status(403).json({ success: false, error: 'forbidden' });
        req.storeId = storeId;
        if (req.query) req.query.storeId = storeId;
        if (req.body && typeof req.body === 'object') req.body.storeId = storeId;
        next();
    } catch (e) {
        return res.status(401).json({ success: false, error: 'login_required' });
    }
}

// ---------------------------------------------------------------- super admin
function superPasswordOk(pass) {
    const expected = process.env.SUPER_ADMIN_PASSWORD;
    if (!expected || expected.length < 12 || !pass) return false;
    return safeEqualStr(crypto.createHash('sha256').update(String(pass)).digest('hex'), crypto.createHash('sha256').update(expected).digest('hex'));
}

function issueSuperToken() {
    return jwt.sign({ typ: 'super' }, jwtSecret(), { issuer: ISSUER, expiresIn: '12h' });
}

function isSuperToken(token) {
    if (!token) return false;
    try {
        const d = jwt.verify(token, jwtSecret(), { issuer: ISSUER });
        return d.typ === 'super';
    } catch { return false; }
}

function requireSuper(req, res, next) {
    const token = bearer(req) || (req.query && req.query.token) || (req.body && req.body.token);
    if (!isSuperToken(token)) return res.status(403).json({ success: false, error: 'forbidden' });
    next();
}

// ------------------------------------------------------------------ cron
function isCronRequest(req) {
    const secret = process.env.CRON_SECRET;
    const token = bearer(req);
    if (secret && token && safeEqualStr(token, secret)) return true;
    return isSuperToken(token);
}

// ------------------------------------------------------------------- SSO
// Token minted by the Shopify app (Remix) when the merchant opens the dashboard.
function verifySsoToken(token) {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret) throw new Error('SSO is not configured on the server');
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (!decoded || typeof decoded.shop !== 'string' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(decoded.shop)) {
        throw new Error('Invalid SSO token');
    }
    return decoded;
}

module.exports = {
    SSO_MANAGED,
    hashPassword,
    verifyPassword,
    validateNewPassword,
    issueStoreToken,
    requireStore,
    superPasswordOk,
    issueSuperToken,
    isSuperToken,
    requireSuper,
    isCronRequest,
    verifySsoToken,
};
