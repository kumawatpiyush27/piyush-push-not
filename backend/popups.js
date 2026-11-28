'use strict';
// Storefront popups. Two independent popups, each with its own designs,
// copy, timing and memory:
//   push  – the subscribe popup (or bypass straight to the browser prompt)
//   lead  – a separate phone/email popup shown after the subscribe step
// Saved in stores.popup_settings as { v: 2, push: {...}, lead: {...} } and
// served to the storefront through the Shopify app's /apps/push/config.
// Older rows (one flat object, optionally with "collect") are migrated on read.

const LAYOUTS = ['corner', 'center', 'topbar', 'sheet'];
const POSITIONS = ['right', 'left'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

const PUSH_DEFAULTS = {
    enabled: true, preset: 'clean', layout: 'corner', position: 'right',
    accent: '#008060', bg: '#ffffff', text: '#1a1a1a', header: 'band', radius: 16,
    title: 'Stay updated! 🔔', message: 'Subscribe for exclusive deals, restocks and flash sales.',
    allow_text: 'Allow notifications', later_text: 'Later', badge_text: 'Subscribers get early access to sales!',
    show_bell: true, show_brand: true, delay: 5, later_days: 1, logo_url: '',
    ribbon_text: '', fine_print: '', success_title: "You're in! 🎉", success_message: 'Watch for our next offer on this device.', success_button: 'Continue',
};
const LEAD_DEFAULTS = {
    enabled: false, preset: 'unlock', layout: 'sheet', position: 'right',
    accent: '#111827', bg: '#ffffff', text: '#111827', radius: 24, logo_url: '', ribbon_text: 'Get up to 60% off',
    title: 'Unlock exclusive offers 👇', message: '', button_text: 'Get mystery offer', skip_text: 'No thanks',
    collect: 'phone', required: true, consent_text: 'Keep me posted about sales and offers', country: 'IN', reward_code: 'WELCOME5',
    success_title: 'Join the tribe', success_message: 'Use WELCOME5 for 5% off your first order', success_button: 'Continue',
    trigger: 'after_push', delay: 10, later_days: 3, max_shows: 3, pages: 'all', show_brand: true,
};

const PUSH_PRESETS = [
    { key: 'clean', name: 'Clean corner', blurb: 'White card with a brand-colour header. Works on every store.', tags: ['corner', 'default'],
      values: { layout: 'corner', accent: '#008060', bg: '#ffffff', text: '#1a1a1a', header: 'band', radius: 16, show_bell: true } },
    { key: 'midnight', name: 'Midnight', blurb: 'Dark card, warm accent. For fashion, tech and premium brands.', tags: ['corner', 'dark'],
      values: { layout: 'corner', accent: '#f59e0b', bg: '#111827', text: '#f9fafb', header: 'none', radius: 18, show_bell: false } },
    { key: 'soft', name: 'Soft center', blurb: 'Centered, rounded, lots of air. Logo first, one clear button.', tags: ['center', 'light'],
      values: { layout: 'center', accent: '#4f46e5', bg: '#ffffff', text: '#111827', header: 'none', radius: 24, show_bell: false } },
    { key: 'bold', name: 'Bold offer', blurb: 'Centered on your brand colour. The offer badge is the hero.', tags: ['center', 'offer'],
      values: { layout: 'center', accent: '#ffffff', bg: '#e11d48', text: '#ffffff', header: 'none', radius: 20, show_bell: true, title: 'Get 10% off your first order 🎁', message: 'Turn on notifications and we send the code straight to your screen.', badge_text: 'Plus early access to every sale', allow_text: 'Yes, send my code' } },
    { key: 'bar', name: 'Minimal bar', blurb: 'A slim strip at the top. The least intrusive option.', tags: ['topbar', 'minimal'],
      values: { layout: 'topbar', accent: '#111827', bg: '#111827', text: '#ffffff', header: 'none', radius: 0, show_bell: true, badge_text: '', message: 'Get restock and sale alerts on this device.', allow_text: 'Turn on' } },
    { key: 'festive', name: 'Festive', blurb: 'Gradient header, celebration copy. Diwali, BFCM, launches.', tags: ['corner', 'seasonal'],
      values: { layout: 'corner', accent: '#ec4899', bg: '#fff7fb', text: '#3b0a2a', header: 'gradient', radius: 18, show_bell: true, title: 'Festive deals are coming 🎉', message: 'Be first to know about the biggest offers of the season.', badge_text: 'Subscribers get the best prices first' } },
    { key: 'luxe', name: 'Luxe', blurb: 'Black and gold, quiet typography. Jewellery, beauty, decor.', tags: ['center', 'dark'],
      values: { layout: 'center', accent: '#d4af37', bg: '#0b0b0b', text: '#f5f1e6', header: 'none', radius: 8, show_bell: false, title: 'Private previews', message: 'New collections and members-only prices, before anyone else.', badge_text: '', allow_text: 'Join the list', later_text: 'Not now' } },
    { key: 'fresh', name: 'Fresh', blurb: 'Mint and white, bottom-left. Food, wellness, kids.', tags: ['corner', 'light'],
      values: { layout: 'corner', position: 'left', accent: '#10b981', bg: '#f0fdf4', text: '#064e3b', header: 'band', radius: 20, show_bell: true, title: 'Fresh drops and restocks 🌱', message: 'One tap and you never miss a restock again.' } },
];
const LEAD_PRESETS = [
    { key: 'unlock', name: 'Unlock offers sheet', blurb: 'Full-screen sheet on phones: ribbon, big logo, one field, one button. The lead-capture look.', tags: ['sheet', 'mobile'],
      values: { layout: 'sheet', accent: '#111827', bg: '#ffffff', text: '#111827', radius: 24, ribbon_text: 'Get up to 60% off', title: 'Unlock exclusive offers 👇', message: '', button_text: 'Get mystery offer' } },
    { key: 'offer_center', name: 'Centered offer', blurb: 'Dimmed page, logo, "Get 10% off", field and button.', tags: ['center'],
      values: { layout: 'center', accent: '#4f46e5', bg: '#ffffff', text: '#111827', radius: 20, ribbon_text: '', title: 'Get 10% off your first order 🎁', message: 'Enter your number and we send the code right away.', button_text: 'Send my code' } },
    { key: 'offer_corner', name: 'Corner card', blurb: 'Small bottom-right card with the field. The least intrusive.', tags: ['corner'],
      values: { layout: 'corner', accent: '#008060', bg: '#ffffff', text: '#1a1a1a', radius: 16, ribbon_text: '', title: 'Want 10% off?', message: 'Drop your number for the code and early access to sales.', button_text: 'Get my code' } },
    { key: 'offer_bar', name: 'Top bar', blurb: 'One line at the top: offer, field, button.', tags: ['topbar'],
      values: { layout: 'topbar', accent: '#111827', bg: '#111827', text: '#ffffff', radius: 0, ribbon_text: '', title: 'Get 10% off', message: '', button_text: 'Get code' } },
];

const byKey = (list, key) => list.find((p) => p.key === key) || null;
const color = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
const bool = (v, d) => (v === undefined ? d : !!v && v !== 'false');
const str = (i, k, b, n, fallback) => (i[k] !== undefined ? (clamp(i[k], n) || fallback || '') : b[k]);
const url = (i, k, b) => (i[k] !== undefined ? (/^https:\/\/.{3,490}$/.test(String(i[k] || '')) ? String(i[k]) : '') : b[k]);

function normalizePush(input, base) {
    const i = input && typeof input === 'object' ? input : {};
    const b = Object.assign({}, PUSH_DEFAULTS, base || {});
    const out = {
        enabled: bool(i.enabled, b.enabled),
        preset: byKey(PUSH_PRESETS, i.preset) ? i.preset : (byKey(PUSH_PRESETS, b.preset) ? b.preset : 'clean'),
        layout: ['corner', 'center', 'topbar'].indexOf(i.layout) !== -1 ? i.layout : (['corner', 'center', 'topbar'].indexOf(b.layout) !== -1 ? b.layout : 'corner'),
        position: POSITIONS.indexOf(i.position) !== -1 ? i.position : b.position,
        accent: color(i.accent, b.accent), bg: color(i.bg, b.bg), text: color(i.text, b.text),
        header: ['band', 'gradient', 'none'].indexOf(i.header) !== -1 ? i.header : b.header, radius: num(i.radius, b.radius, 0, 32),
        title: str(i, 'title', b, 60, PUSH_DEFAULTS.title), message: str(i, 'message', b, 160), allow_text: str(i, 'allow_text', b, 30, PUSH_DEFAULTS.allow_text), later_text: str(i, 'later_text', b, 20, PUSH_DEFAULTS.later_text), badge_text: str(i, 'badge_text', b, 60),
        show_bell: bool(i.show_bell, b.show_bell), show_brand: bool(i.show_brand, b.show_brand), delay: num(i.delay, b.delay, 0, 60), later_days: num(i.later_days, b.later_days, 0, 30), logo_url: url(i, 'logo_url', b),
        ribbon_text: str(i, 'ribbon_text', b, 40), fine_print: str(i, 'fine_print', b, 90), success_title: str(i, 'success_title', b, 50), success_message: str(i, 'success_message', b, 120), success_button: str(i, 'success_button', b, 24, PUSH_DEFAULTS.success_button),
    };
    return out;
}

function normalizeLead(input, base) {
    const i = input && typeof input === 'object' ? input : {};
    const b = Object.assign({}, LEAD_DEFAULTS, base || {});
    return {
        enabled: bool(i.enabled, b.enabled),
        preset: byKey(LEAD_PRESETS, i.preset) ? i.preset : (byKey(LEAD_PRESETS, b.preset) ? b.preset : 'unlock'),
        layout: LAYOUTS.indexOf(i.layout) !== -1 ? i.layout : b.layout, position: POSITIONS.indexOf(i.position) !== -1 ? i.position : b.position,
        accent: color(i.accent, b.accent), bg: color(i.bg, b.bg), text: color(i.text, b.text), radius: num(i.radius, b.radius, 0, 32), logo_url: url(i, 'logo_url', b),
        ribbon_text: str(i, 'ribbon_text', b, 40), title: str(i, 'title', b, 60, LEAD_DEFAULTS.title), message: str(i, 'message', b, 160),
        button_text: str(i, 'button_text', b, 30, LEAD_DEFAULTS.button_text), skip_text: str(i, 'skip_text', b, 20, LEAD_DEFAULTS.skip_text),
        collect: ['phone', 'email', 'either'].indexOf(i.collect) !== -1 ? i.collect : b.collect, required: bool(i.required, b.required),
        consent_text: str(i, 'consent_text', b, 120), country: /^[A-Za-z]{2}$/.test(String(i.country || '')) ? String(i.country).toUpperCase() : b.country,
        reward_code: i.reward_code !== undefined ? clamp(i.reward_code, 40).toUpperCase() : b.reward_code,
        success_title: str(i, 'success_title', b, 50), success_message: str(i, 'success_message', b, 120), success_button: str(i, 'success_button', b, 24, LEAD_DEFAULTS.success_button),
        trigger: ['after_push', 'timer', 'second_page'].indexOf(i.trigger) !== -1 ? i.trigger : b.trigger, delay: num(i.delay, b.delay, 0, 120),
        later_days: num(i.later_days, b.later_days, 0, 30), max_shows: num(i.max_shows, b.max_shows, 1, 20), pages: ['all', 'product', 'cart', 'product_cart'].indexOf(i.pages) !== -1 ? i.pages : b.pages,
        show_brand: bool(i.show_brand, b.show_brand),
    };
}

// Older rows: one flat object (v1). "collect" on it becomes a lead popup.
function migrate(saved) {
    if (!saved || typeof saved !== 'object') return null;
    if (saved.v === 2 && saved.push) return { push: normalizePush(saved.push), lead: normalizeLead(saved.lead || {}) };
    const push = normalizePush(saved);
    if (saved.layout === 'sheet') { push.layout = 'center'; push.preset = 'soft'; }
    let lead = normalizeLead({});
    if (saved.collect && saved.collect !== 'none') {
        lead = normalizeLead({ enabled: true, collect: saved.collect, required: saved.collect_required, consent_text: saved.consent_text, country: saved.country, reward_code: saved.reward_code,
            layout: saved.layout === 'sheet' ? 'sheet' : (saved.layout === 'topbar' ? 'topbar' : 'center'), accent: saved.accent, bg: saved.bg, text: saved.text, radius: saved.radius, logo_url: saved.logo_url,
            ribbon_text: saved.ribbon_text, title: saved.title, message: saved.message, button_text: saved.allow_text, success_title: saved.success_title, success_message: saved.success_message, success_button: saved.success_button });
    }
    return { push, lead };
}

function applyPreset(kind, key, current) {
    const list = kind === 'lead' ? LEAD_PRESETS : PUSH_PRESETS;
    const p = byKey(list, key);
    if (!p) throw Object.assign(new Error('Unknown design'), { status: 400 });
    const keep = {};
    if (current) { ['logo_url', 'delay', 'later_days', 'show_brand', 'enabled'].forEach((k) => { if (current[k] !== undefined) keep[k] = current[k]; }); if (kind === 'lead') ['collect', 'required', 'consent_text', 'country', 'reward_code', 'trigger', 'max_shows', 'pages', 'success_title', 'success_message', 'success_button'].forEach((k) => { keep[k] = current[k]; }); }
    const defaults = kind === 'lead' ? LEAD_DEFAULTS : PUSH_DEFAULTS;
    return (kind === 'lead' ? normalizeLead : normalizePush)(Object.assign({}, defaults, p.values, { preset: p.key }, keep));
}

let columnReady = null;
function ensureColumn(db) {
    if (!columnReady) columnReady = db.query('ALTER TABLE stores ADD COLUMN IF NOT EXISTS popup_settings JSONB').catch((e) => { columnReady = null; throw e; });
    return columnReady;
}

async function get(db, storeId) {
    await ensureColumn(db);
    const { rows } = await db.query('SELECT popup_settings, logo_url FROM stores WHERE store_id = $1', [storeId]);
    const row = rows[0] || {};
    let saved = row.popup_settings;
    if (typeof saved === 'string') { try { saved = JSON.parse(saved); } catch { saved = null; } }
    const m = migrate(saved);
    const push = m ? m.push : normalizePush({ logo_url: row.logo_url || '' });
    const lead = m ? m.lead : normalizeLead({});
    return { push, lead, saved: !!m, store_logo: row.logo_url || '' };
}

// input: { push: {...} } and/or { lead: {...} } and/or { apply_preset: { kind, key } } (or legacy flat push fields).
async function save(db, storeId, input) {
    await ensureColumn(db);
    const cur = await get(db, storeId);
    const i = input && typeof input === 'object' ? input : {};
    let push = cur.push, lead = cur.lead;
    if (i.apply_preset) {
        const ap = typeof i.apply_preset === 'string' ? { kind: 'push', key: i.apply_preset } : i.apply_preset;
        if (ap.kind === 'lead') lead = applyPreset('lead', String(ap.key), lead); else push = applyPreset('push', String(ap.key), push);
    }
    if (i.push) push = normalizePush(i.push, push);
    if (i.lead) lead = normalizeLead(i.lead, lead);
    if (!i.push && !i.lead && !i.apply_preset && (i.title !== undefined || i.layout !== undefined)) push = normalizePush(i, push); // legacy flat body
    const next = { v: 2, push, lead };
    await db.query('UPDATE stores SET popup_settings = $2::jsonb WHERE store_id = $1', [storeId, JSON.stringify(next)]);
    return next;
}

function publicPresets() {
    return {
        push: PUSH_PRESETS.map((p) => ({ key: p.key, name: p.name, blurb: p.blurb, tags: p.tags, settings: normalizePush(Object.assign({}, PUSH_DEFAULTS, p.values, { preset: p.key })) })),
        lead: LEAD_PRESETS.map((p) => ({ key: p.key, name: p.name, blurb: p.blurb, tags: p.tags, settings: normalizeLead(Object.assign({}, LEAD_DEFAULTS, p.values, { preset: p.key })) })),
    };
}

module.exports = { PUSH_DEFAULTS, LEAD_DEFAULTS, PUSH_PRESETS, LEAD_PRESETS, LAYOUTS, normalizePush, normalizeLead, migrate, applyPreset, get, save, publicPresets, ensureColumn };
