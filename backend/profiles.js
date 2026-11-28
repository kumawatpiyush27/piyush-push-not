'use strict';
// Contacts: one profile per person per store, filled from push subscriptions
// (devices), the popup's phone/email field, storefront logins (customer id)
// and Shopify orders. Matching order: customer_id → phone (E.164) → email →
// device endpoint. Profiles are never deleted here except by the Shopify
// customer-redact webhook. Tables are created on first use (additive).

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

let ready = null;
function ensureTables(db) {
    if (!ready) {
        ready = (async () => {
            await db.query(`CREATE TABLE IF NOT EXISTS push_profiles (
                id SERIAL PRIMARY KEY,
                store_id TEXT NOT NULL,
                customer_id TEXT,
                email TEXT,
                phone TEXT,
                first_name TEXT,
                last_name TEXT,
                push_consent BOOLEAN NOT NULL DEFAULT FALSE,
                sms_consent BOOLEAN NOT NULL DEFAULT FALSE,
                whatsapp_consent BOOLEAN NOT NULL DEFAULT FALSE,
                email_consent BOOLEAN NOT NULL DEFAULT FALSE,
                consent_source JSONB NOT NULL DEFAULT '{}'::jsonb,
                unsubscribed JSONB NOT NULL DEFAULT '{}'::jsonb,
                source TEXT,
                orders_count INTEGER NOT NULL DEFAULT 0,
                total_spent NUMERIC(12,2) NOT NULL DEFAULT 0,
                currency TEXT,
                last_order_at TIMESTAMPTZ,
                first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                attributes JSONB NOT NULL DEFAULT '{}'::jsonb,
                tags TEXT[] NOT NULL DEFAULT '{}',
                merged_into INTEGER,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await db.query('CREATE INDEX IF NOT EXISTS push_profiles_store_idx ON push_profiles (store_id, last_seen_at DESC)');
            await db.query('CREATE UNIQUE INDEX IF NOT EXISTS push_profiles_customer_uq ON push_profiles (store_id, customer_id) WHERE customer_id IS NOT NULL AND merged_into IS NULL');
            await db.query('CREATE UNIQUE INDEX IF NOT EXISTS push_profiles_phone_uq ON push_profiles (store_id, phone) WHERE phone IS NOT NULL AND merged_into IS NULL');
            await db.query('CREATE UNIQUE INDEX IF NOT EXISTS push_profiles_email_uq ON push_profiles (store_id, email) WHERE email IS NOT NULL AND merged_into IS NULL');
            await db.query(`CREATE TABLE IF NOT EXISTS push_profile_events (
                id SERIAL PRIMARY KEY, store_id TEXT NOT NULL, profile_id INTEGER NOT NULL, kind TEXT NOT NULL,
                data JSONB NOT NULL DEFAULT '{}'::jsonb, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await db.query('CREATE INDEX IF NOT EXISTS push_profile_events_idx ON push_profile_events (profile_id, at DESC)');
            await db.query('ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS profile_id INTEGER');
            await db.query('CREATE INDEX IF NOT EXISTS subscriptions_profile_idx ON subscriptions (profile_id)');
            await db.query('ALTER TABLE push_orders ADD COLUMN IF NOT EXISTS profile_id INTEGER, ADD COLUMN IF NOT EXISTS email TEXT, ADD COLUMN IF NOT EXISTS phone TEXT, ADD COLUMN IF NOT EXISTS customer_id TEXT');
        })().catch((e) => { ready = null; throw e; });
    }
    return ready;
}

// ------------------------------------------------------------ normalising
function normPhone(v, defaultCountry) {
    if (!v) return null;
    let d = String(v).replace(/[^\d+]/g, '');
    if (!d) return null;
    if (d.startsWith('00')) d = '+' + d.slice(2);
    if (!d.startsWith('+')) {
        const digits = d.replace(/\D/g, '').replace(/^0+/, '');   // trunk prefix (0 98765…)
        const cc = (defaultCountry || 'IN').toUpperCase();
        if (cc === 'IN' && digits.length === 10) d = '+91' + digits;
        else if (cc === 'IN' && digits.length === 12 && digits.startsWith('91')) d = '+' + digits;
        else if (cc === 'US' && digits.length === 10) d = '+1' + digits;
        else if (digits.length >= 10 && digits.length <= 15) d = '+' + digits;
        else return null;
    }
    const digits = d.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    return '+' + digits;
}
function normEmail(v) {
    if (!v) return null;
    const e = String(v).trim().toLowerCase().slice(0, 200);
    return RE_EMAIL.test(e) ? e : null;
}
const clampStr = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) || null);

async function event(db, storeId, profileId, kind, data) {
    await db.query('INSERT INTO push_profile_events (store_id, profile_id, kind, data) VALUES ($1, $2, $3, $4)', [storeId, profileId, kind, JSON.stringify(data || {})]);
}

// Follows merged_into chains to the surviving profile.
async function canonical(db, id) {
    let cur = id;
    for (let i = 0; i < 5 && cur; i++) {
        const { rows } = await db.query('SELECT id, merged_into FROM push_profiles WHERE id = $1', [cur]);
        if (!rows[0] || !rows[0].merged_into) return rows[0] ? rows[0].id : null;
        cur = rows[0].merged_into;
    }
    return cur;
}

async function findBy(db, storeId, field, value) {
    if (!value) return null;
    const { rows } = await db.query(`SELECT id FROM push_profiles WHERE store_id = $1 AND ${field} = $2 AND merged_into IS NULL LIMIT 1`, [storeId, value]);
    return rows[0] ? rows[0].id : null;
}

async function profileOfEndpoint(db, storeId, endpoint) {
    if (!endpoint) return null;
    const { rows } = await db.query('SELECT profile_id FROM subscriptions WHERE store_id = $1 AND endpoint = $2 AND profile_id IS NOT NULL LIMIT 1', [storeId, endpoint]);
    return rows[0] ? canonical(db, rows[0].profile_id) : null;
}

// Moves everything from `loser` into `winner` (older id wins) and records it.
async function merge(db, storeId, a, b) {
    if (!a || !b || a === b) return a || b;
    const winner = Math.min(a, b), loser = Math.max(a, b);
    const { rows } = await db.query('SELECT * FROM push_profiles WHERE id IN ($1, $2)', [winner, loser]);
    const W = rows.find((r) => r.id === winner), L = rows.find((r) => r.id === loser);
    if (!W || !L) return winner;
    const pick = (k) => (W[k] !== null && W[k] !== undefined && W[k] !== '' ? W[k] : L[k]);
    const cs = Object.assign({}, L.consent_source || {}, W.consent_source || {});
    const un = Object.assign({}, L.unsubscribed || {}, W.unsubscribed || {});
    await db.query(`UPDATE push_profiles SET customer_id = NULL, email = NULL, phone = NULL, merged_into = $2, updated_at = NOW() WHERE id = $1`, [loser, winner]);
    await db.query(
        `UPDATE push_profiles SET customer_id = $2, email = $3, phone = $4, first_name = $5, last_name = $6,
            push_consent = push_consent OR $7, sms_consent = sms_consent OR $8, whatsapp_consent = whatsapp_consent OR $9, email_consent = email_consent OR $10,
            consent_source = $11::jsonb, unsubscribed = $12::jsonb, orders_count = GREATEST(orders_count, $13), total_spent = GREATEST(total_spent, $14),
            last_order_at = GREATEST(COALESCE(last_order_at, '1970-01-01'), COALESCE($15, '1970-01-01')), first_seen_at = LEAST(first_seen_at, $16), last_seen_at = GREATEST(last_seen_at, $17),
            tags = ARRAY(SELECT DISTINCT unnest(tags || $18::text[])), updated_at = NOW()
         WHERE id = $1`,
        [winner, pick('customer_id'), pick('email'), pick('phone'), pick('first_name'), pick('last_name'), !!L.push_consent, !!L.sms_consent, !!L.whatsapp_consent, !!L.email_consent,
         JSON.stringify(cs), JSON.stringify(un), L.orders_count || 0, L.total_spent || 0, L.last_order_at, L.first_seen_at, L.last_seen_at, L.tags || []]);
    await db.query('UPDATE subscriptions SET profile_id = $2 WHERE profile_id = $1', [loser, winner]);
    await db.query('UPDATE push_orders SET profile_id = $2 WHERE profile_id = $1', [loser, winner]);
    await db.query('UPDATE push_profile_events SET profile_id = $2 WHERE profile_id = $1', [loser, winner]);
    await event(db, storeId, winner, 'merged', { from: loser });
    return winner;
}

// Core: given whatever identity we have, return the profile id (creating or
// merging as needed) and update its fields. `ident` may contain endpoint,
// customerId, phone, email, firstName, lastName, consent {sms,whatsapp,email,push},
// consentText, source, country.
async function resolve(db, storeId, ident) {
    await ensureTables(db);
    const customerId = clampStr(ident.customerId, 40);
    const phone = normPhone(ident.phone, ident.country);
    const email = normEmail(ident.email);
    const candidates = [];
    if (customerId) candidates.push(await findBy(db, storeId, 'customer_id', customerId));
    if (phone) candidates.push(await findBy(db, storeId, 'phone', phone));
    if (email) candidates.push(await findBy(db, storeId, 'email', email));
    if (ident.endpoint) candidates.push(await profileOfEndpoint(db, storeId, ident.endpoint));
    const ids = [...new Set(candidates.filter(Boolean))].sort((a, b) => a - b);
    let id = ids[0] || null;
    for (let i = 1; i < ids.length; i++) id = await merge(db, storeId, id, ids[i]);
    if (!id) {
        const { rows } = await db.query(
            `INSERT INTO push_profiles (store_id, customer_id, email, phone, first_name, last_name, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [storeId, customerId, email, phone, clampStr(ident.firstName, 80), clampStr(ident.lastName, 80), clampStr(ident.source, 30) || 'push']);
        id = rows[0].id;
        await event(db, storeId, id, 'created', { source: ident.source || 'push' });
    } else {
        // Fill blanks; a conflicting value that belongs to another profile was merged above.
        await db.query(
            `UPDATE push_profiles SET customer_id = COALESCE(customer_id, $2), email = COALESCE(email, $3), phone = COALESCE(phone, $4),
                first_name = COALESCE(first_name, $5), last_name = COALESCE(last_name, $6), last_seen_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [id, customerId, email, phone, clampStr(ident.firstName, 80), clampStr(ident.lastName, 80)]);
    }
    if (ident.endpoint) await db.query('UPDATE subscriptions SET profile_id = $3 WHERE store_id = $1 AND endpoint = $2', [storeId, ident.endpoint, id]);
    const consent = ident.consent || {};
    const keys = ['push', 'sms', 'whatsapp', 'email'].filter((k) => consent[k]);
    if (keys.length) {
        const src = {}; keys.forEach((k) => { src[k] = { at: new Date().toISOString(), source: ident.source || 'popup', text: clampStr(ident.consentText, 200) }; });
        await db.query(
            `UPDATE push_profiles SET push_consent = push_consent OR $2, sms_consent = sms_consent OR $3, whatsapp_consent = whatsapp_consent OR $4, email_consent = email_consent OR $5,
                consent_source = consent_source || $6::jsonb, updated_at = NOW() WHERE id = $1`,
            [id, !!consent.push, !!consent.sms, !!consent.whatsapp, !!consent.email, JSON.stringify(src)]);
    }
    return { id, phone, email, customerId };
}

// Popup lead (storefront → app proxy → here).
async function fromLead(db, storeId, input) {
    const phone = normPhone(input.phone, input.country), email = normEmail(input.email);
    if (!phone && !email) throw Object.assign(new Error('Enter a valid phone number or email.'), { status: 400 });
    const consent = { sms: !!input.consent, whatsapp: !!input.consent, email: !!input.consent && !!email, push: false };
    const r = await resolve(db, storeId, { endpoint: input.endpoint, customerId: input.customerId, phone, email, firstName: input.name, consent, consentText: input.consentText, source: 'popup', country: input.country });
    await event(db, storeId, r.id, 'lead', { phone: !!phone, email: !!email, consent: !!input.consent, page: clampStr(input.page, 200) });
    return r;
}

// Logged-in shopper seen on a device.
async function identify(db, storeId, { endpoint, customerId }) {
    if (!endpoint || !customerId) return null;
    return resolve(db, storeId, { endpoint, customerId, source: 'login' });
}

// Shopify orders/create payload.
async function fromOrder(db, storeId, order, endpointHint) {
    await ensureTables(db);
    const c = order.customer || {};
    const ident = {
        endpoint: endpointHint || null, customerId: c.id ? String(c.id) : (order.customer_id ? String(order.customer_id) : null),
        email: order.email || order.contact_email || c.email, phone: order.phone || (order.billing_address && order.billing_address.phone) || (order.shipping_address && order.shipping_address.phone) || c.phone,
        firstName: c.first_name || (order.billing_address && order.billing_address.first_name), lastName: c.last_name || (order.billing_address && order.billing_address.last_name),
        source: 'order', country: (order.billing_address && order.billing_address.country_code) || 'IN',
    };
    if (!ident.customerId && !normPhone(ident.phone, ident.country) && !normEmail(ident.email) && !ident.endpoint) return null;
    const r = await resolve(db, storeId, ident);
    await db.query(
        `UPDATE push_profiles SET orders_count = orders_count + 1, total_spent = total_spent + $2, currency = COALESCE($3, currency), last_order_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [r.id, parseFloat(order.total_price || 0) || 0, order.currency || null]);
    await event(db, storeId, r.id, 'order', { order_id: order.id, total: order.total_price, currency: order.currency });
    await db.query('UPDATE push_orders SET profile_id = $3, email = COALESCE(email, $4), phone = COALESCE(phone, $5), customer_id = COALESCE(customer_id, $6) WHERE store_id = $1 AND order_id = $2',
        [storeId, String(order.id), r.id, r.email, r.phone, r.customerId]).catch(() => {});
    return r;
}

// Gives every subscriber a profile (idempotent). Runs on the first Contacts
// open and from the cron, in batches.
async function backfill(db, storeId, limit) {
    await ensureTables(db);
    const { rows } = await db.query(
        `SELECT endpoint, customer_id FROM subscriptions WHERE store_id = $1 AND profile_id IS NULL ORDER BY created_at LIMIT $2`, [storeId, Math.min(2000, limit || 500)]);
    let n = 0;
    for (const s of rows) { await resolve(db, storeId, { endpoint: s.endpoint, customerId: s.customer_id, source: 'push' }); n++; }
    return { linked: n, remaining: rows.length >= (limit || 500) };
}

// ---------------------------------------------------------------- reading
async function list(db, storeId, { q, filter, limit, offset } = {}) {
    await ensureTables(db);
    const params = [storeId];
    let where = 'p.store_id = $1 AND p.merged_into IS NULL';
    if (q) { params.push('%' + String(q).trim().toLowerCase() + '%'); where += ` AND (LOWER(COALESCE(p.email,'')) LIKE $${params.length} OR COALESCE(p.phone,'') LIKE $${params.length} OR LOWER(COALESCE(p.first_name,'') || ' ' || COALESCE(p.last_name,'')) LIKE $${params.length} OR COALESCE(p.customer_id,'') LIKE $${params.length})`; }
    if (filter === 'phone') where += ' AND p.phone IS NOT NULL';
    else if (filter === 'email') where += ' AND p.email IS NOT NULL';
    else if (filter === 'contact') where += ' AND (p.phone IS NOT NULL OR p.email IS NOT NULL)';
    else if (filter === 'buyers') where += ' AND p.orders_count > 0';
    else if (filter === 'whatsapp') where += ' AND p.whatsapp_consent = TRUE';
    const lim = Math.min(200, Math.max(1, Number(limit) || 50)), off = Math.max(0, Number(offset) || 0);
    params.push(lim, off);
    const { rows } = await db.query(
        `SELECT p.id, p.customer_id, p.email, p.phone, p.first_name, p.last_name, p.push_consent, p.sms_consent, p.whatsapp_consent, p.email_consent, p.source,
                p.orders_count, p.total_spent, p.currency, p.last_order_at, p.first_seen_at, p.last_seen_at, p.tags,
                (SELECT COUNT(*)::int FROM subscriptions s WHERE s.profile_id = p.id AND (s.status IS NULL OR s.status = 'active')) AS devices,
                (SELECT MIN(s.id) FROM subscriptions s WHERE s.profile_id = p.id) AS subscriber_id
         FROM push_profiles p WHERE ${where} ORDER BY p.last_seen_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const counts = await db.query(
        `SELECT COUNT(*)::int AS total, COUNT(phone)::int AS with_phone, COUNT(email)::int AS with_email, COUNT(*) FILTER (WHERE orders_count > 0)::int AS buyers,
                COUNT(*) FILTER (WHERE whatsapp_consent)::int AS whatsapp, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days' AND (phone IS NOT NULL OR email IS NOT NULL))::int AS leads_7d
         FROM push_profiles WHERE store_id = $1 AND merged_into IS NULL`, [storeId]);
    return { contacts: rows, counts: counts.rows[0], limit: lim, offset: off };
}

async function get(db, storeId, id) {
    await ensureTables(db);
    const pid = await canonical(db, parseInt(id, 10) || 0);
    const { rows } = await db.query('SELECT * FROM push_profiles WHERE id = $1 AND store_id = $2', [pid, storeId]);
    if (!rows[0]) throw Object.assign(new Error('Contact not found'), { status: 404 });
    const devices = await db.query(`SELECT id, endpoint, status, created_at, last_seen_at, customer_id FROM subscriptions WHERE profile_id = $1 ORDER BY created_at`, [pid]);
    const events = await db.query('SELECT kind, data, at FROM push_profile_events WHERE profile_id = $1 ORDER BY at DESC LIMIT 50', [pid]);
    const orders = await db.query('SELECT order_id, total_price, currency, created_at FROM push_orders WHERE profile_id = $1 ORDER BY created_at DESC LIMIT 20', [pid]);
    return { contact: rows[0], devices: devices.rows.map((d) => ({ id: d.id, status: d.status || 'active', created_at: d.created_at, last_seen_at: d.last_seen_at, browser: browserOf(d.endpoint) })), events: events.rows, orders: orders.rows };
}

function browserOf(endpoint) {
    const e = String(endpoint || '');
    if (e.includes('fcm.googleapis') || e.includes('android.googleapis')) return 'Chrome / Android';
    if (e.includes('push.apple.com')) return 'Safari / iPhone';
    if (e.includes('mozilla.com')) return 'Firefox';
    if (e.includes('notify.windows.com')) return 'Edge / Windows';
    return 'Browser';
}

function csv(rows) {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ['contact_id', 'subscriber_id', 'first_name', 'last_name', 'phone', 'email', 'customer_id', 'devices', 'push', 'whatsapp', 'sms', 'email_consent', 'orders', 'total_spent', 'currency', 'source', 'first_seen', 'last_seen'];
    const lines = rows.map((r) => [r.id, r.subscriber_id, r.first_name, r.last_name, r.phone, r.email, r.customer_id, r.devices, r.push_consent, r.whatsapp_consent, r.sms_consent, r.email_consent, r.orders_count, r.total_spent, r.currency, r.source, r.first_seen_at && new Date(r.first_seen_at).toISOString(), r.last_seen_at && new Date(r.last_seen_at).toISOString()].map(esc).join(','));
    return [head.join(',')].concat(lines).join('\n');
}

async function redact(db, storeId, { customerId, email, phone }) {
    await ensureTables(db);
    const ids = [];
    for (const [f, v] of [['customer_id', clampStr(customerId, 40)], ['email', normEmail(email)], ['phone', normPhone(phone)]]) { const id = v ? await findBy(db, storeId, f, v) : null; if (id) ids.push(id); }
    for (const id of [...new Set(ids)]) {
        await db.query('UPDATE subscriptions SET profile_id = NULL WHERE profile_id = $1', [id]);
        await db.query('DELETE FROM push_profile_events WHERE profile_id = $1', [id]);
        await db.query('DELETE FROM push_profiles WHERE id = $1', [id]);
    }
    return ids.length;
}

module.exports = { ensureTables, normPhone, normEmail, resolve, fromLead, identify, fromOrder, backfill, list, get, csv, redact };
