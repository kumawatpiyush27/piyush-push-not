'use strict';
// Storefront subscribe popup: ready-made designs the merchant applies in one
// click and then tweaks (brand colour, logo, text, timing). Saved in
// stores.popup_settings (jsonb) and served to the storefront embed through
// the Shopify app's /apps/push/config, so the theme editor settings are only
// a fallback for stores that never saved a design.

const LAYOUTS = ['corner', 'center', 'topbar', 'sheet'];
const POSITIONS = ['right', 'left'];

const DEFAULTS = {
    preset: 'clean', layout: 'corner', position: 'right',
    accent: '#008060', bg: '#ffffff', text: '#1a1a1a', header: 'band', radius: 16,
    title: 'Stay updated! 🔔', message: 'Subscribe for exclusive deals, restocks and flash sales.',
    allow_text: 'Allow notifications', later_text: 'Later', badge_text: 'Subscribers get early access to sales!',
    show_bell: true, show_brand: true, delay: 5, later_days: 1, logo_url: '',
    // sheet / center extras
    ribbon_text: '', fine_print: '', success_title: "You're in! 🎉", success_message: 'Watch for our next offer on this device.', success_button: 'Continue',
    // lead capture (phone / email before the browser prompt)
    collect: 'none', collect_required: true, consent_text: 'Keep me posted about sales and offers', country: 'IN', reward_code: '',
};

// Each preset is a full look; the merchant's brand colour/logo/text can
// override any field afterwards. Keep names short: they are the gallery.
const PRESETS = [
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
    { key: 'unlock', name: 'Unlock offers', blurb: 'Full-screen sheet on phones: ribbon, big logo, one button, then a code. The lead-capture look.', tags: ['sheet', 'offer', 'mobile'],
      values: { layout: 'sheet', accent: '#111827', bg: '#ffffff', text: '#111827', header: 'none', radius: 24, show_bell: false, title: 'Unlock exclusive offers 👇', message: '', badge_text: '', allow_text: 'Get mystery offer', later_text: 'No thanks', ribbon_text: 'Get up to 60% off', fine_print: '', collect: 'phone', collect_required: true, consent_text: 'Keep me posted about sales and offers', reward_code: 'WELCOME5', success_title: 'Join the tribe', success_message: 'Use WELCOME5 for 5% off your first order', success_button: 'Continue' } },
    { key: 'fresh', name: 'Fresh', blurb: 'Mint and white, bottom-left. Food, wellness, kids.', tags: ['corner', 'light'],
      values: { layout: 'corner', position: 'left', accent: '#10b981', bg: '#f0fdf4', text: '#064e3b', header: 'band', radius: 20, show_bell: true, title: 'Fresh drops and restocks 🌱', message: 'One tap and you never miss a restock again.' } },
];

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function presetByKey(key) { return PRESETS.find((p) => p.key === key) || null; }

// Validates and fills a settings object. Unknown keys are dropped.
function normalize(input, base) {
    const i = input && typeof input === 'object' ? input : {};
    const b = Object.assign({}, DEFAULTS, base || {});
    const color = (v, d) => (HEX.test(String(v || '')) ? String(v).toLowerCase() : d);
    const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
    const bool = (v, d) => (v === undefined ? d : !!v && v !== 'false');
    const out = {
        preset: presetByKey(i.preset) ? i.preset : (presetByKey(b.preset) ? b.preset : 'clean'),
        layout: LAYOUTS.indexOf(i.layout) !== -1 ? i.layout : b.layout,
        position: POSITIONS.indexOf(i.position) !== -1 ? i.position : b.position,
        accent: color(i.accent, b.accent), bg: color(i.bg, b.bg), text: color(i.text, b.text),
        header: ['band', 'gradient', 'none'].indexOf(i.header) !== -1 ? i.header : b.header,
        radius: num(i.radius, b.radius, 0, 32),
        title: i.title !== undefined ? clamp(i.title, 60) : b.title,
        message: i.message !== undefined ? clamp(i.message, 160) : b.message,
        allow_text: i.allow_text !== undefined ? (clamp(i.allow_text, 30) || DEFAULTS.allow_text) : b.allow_text,
        later_text: i.later_text !== undefined ? (clamp(i.later_text, 20) || DEFAULTS.later_text) : b.later_text,
        badge_text: i.badge_text !== undefined ? clamp(i.badge_text, 60) : b.badge_text,
        show_bell: bool(i.show_bell, b.show_bell), show_brand: bool(i.show_brand, b.show_brand),
        delay: num(i.delay, b.delay, 0, 60), later_days: num(i.later_days, b.later_days, 0, 30),
        logo_url: i.logo_url !== undefined ? (/^https:\/\/.{3,490}$/.test(String(i.logo_url || '')) ? String(i.logo_url) : '') : b.logo_url,
        ribbon_text: i.ribbon_text !== undefined ? clamp(i.ribbon_text, 40) : b.ribbon_text,
        fine_print: i.fine_print !== undefined ? clamp(i.fine_print, 90) : b.fine_print,
        success_title: i.success_title !== undefined ? clamp(i.success_title, 50) : b.success_title,
        success_message: i.success_message !== undefined ? clamp(i.success_message, 120) : b.success_message,
        success_button: i.success_button !== undefined ? (clamp(i.success_button, 24) || DEFAULTS.success_button) : b.success_button,
        collect: ['none', 'phone', 'email', 'either'].indexOf(i.collect) !== -1 ? i.collect : b.collect,
        collect_required: bool(i.collect_required, b.collect_required),
        consent_text: i.consent_text !== undefined ? clamp(i.consent_text, 120) : b.consent_text,
        country: /^[A-Za-z]{2}$/.test(String(i.country || '')) ? String(i.country).toUpperCase() : b.country,
        reward_code: i.reward_code !== undefined ? clamp(i.reward_code, 40).toUpperCase() : b.reward_code,
    };
    if (!out.title) out.title = DEFAULTS.title;
    return out;
}

// Applying a preset: preset values on top of defaults, keeping the
// merchant's own logo, delay and later_days.
function applyPreset(key, current) {
    const p = presetByKey(key);
    if (!p) throw Object.assign(new Error('Unknown design'), { status: 400 });
    const keep = current ? { logo_url: current.logo_url, delay: current.delay, later_days: current.later_days, show_brand: current.show_brand } : {};
    return normalize(Object.assign({}, DEFAULTS, p.values, { preset: p.key }, keep));
}

let columnReady = null;
function ensureColumn(db) {
    if (!columnReady) columnReady = db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS popup_settings JSONB`).catch((e) => { columnReady = null; throw e; });
    return columnReady;
}

async function get(db, storeId) {
    await ensureColumn(db);
    const { rows } = await db.query('SELECT popup_settings, logo_url FROM stores WHERE store_id = $1', [storeId]);
    const row = rows[0] || {};
    let saved = row.popup_settings;
    if (typeof saved === 'string') { try { saved = JSON.parse(saved); } catch { saved = null; } }
    const settings = saved ? normalize(saved) : null;
    return { settings, saved: !!saved, effective: settings || normalize({ logo_url: row.logo_url || '' }), store_logo: row.logo_url || '' };
}

async function save(db, storeId, input) {
    await ensureColumn(db);
    const cur = await get(db, storeId);
    const base = cur.settings || cur.effective;
    const next = input && input.apply_preset ? applyPreset(String(input.apply_preset), base) : normalize(input, base);
    await db.query('UPDATE stores SET popup_settings = $2::jsonb WHERE store_id = $1', [storeId, JSON.stringify(next)]);
    return next;
}

function publicPresets() { return PRESETS.map((p) => ({ key: p.key, name: p.name, blurb: p.blurb, tags: p.tags, settings: normalize(Object.assign({}, DEFAULTS, p.values, { preset: p.key })) })); }

module.exports = { DEFAULTS, PRESETS, LAYOUTS, normalize, applyPreset, get, save, publicPresets, ensureColumn };
