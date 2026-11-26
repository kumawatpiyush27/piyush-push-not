'use strict';
// Ideas feed: short tips, ready campaign templates, feature ideas, seasonal
// campaigns and "coming soon" items shown in the dashboard and the Shopify
// app. Content lives in Postgres (merchant_tips) and is edited from the master
// admin; a seed fills it on first use. Rotation is deterministic per store per
// day and skips the last ten items a store has seen.
//
// Conditions (jsonb on each item; every key must hold for the item to show):
//   no_campaign:true          store has not sent a campaign yet
//   has_campaign:true         store sent at least one
//   automation_off:"key"      that automation is off (welcome, abandoned_cart, …)
//   automation_on:"key"
//   segments_locked:true      Free plan (not trial)
//   embed_off:true            storefront not seen
//   no_logo:true / no_email:true
//   subscribers_lt:N / subscribers_gte:N
//   on_trial:true / plan:["free","growth"]
const plans = require('./plans');
const entitlements = require('./entitlements');

const KINDS = ['onboarding', 'template', 'tip', 'feature', 'idea', 'season', 'coming_soon'];
const VIEWS = ['home', 'creator', 'automations', 'subscribers', 'segments', 'analytics', 'plan', 'settings', 'theme'];
const RECENT_WINDOW = 10;

let ready = null;
function ensureTables(db) {
    if (!ready) {
        ready = (async () => {
            await db.query(`CREATE TABLE IF NOT EXISTS merchant_tips (
                id SERIAL PRIMARY KEY,
                seed_key TEXT UNIQUE,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL DEFAULT '',
                cta_label TEXT,
                cta_view TEXT,
                cta_params JSONB NOT NULL DEFAULT '{}'::jsonb,
                day_min INTEGER,
                day_max INTEGER,
                conditions JSONB NOT NULL DEFAULT '{}'::jsonb,
                season_from DATE,
                season_to DATE,
                priority INTEGER NOT NULL DEFAULT 5,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await db.query(`CREATE TABLE IF NOT EXISTS tip_events (
                id SERIAL PRIMARY KEY,
                store_id TEXT NOT NULL,
                tip_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                surface TEXT,
                at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
            await db.query('CREATE INDEX IF NOT EXISTS tip_events_store_idx ON tip_events (store_id, at DESC)');
            await db.query('CREATE INDEX IF NOT EXISTS tip_events_tip_idx ON tip_events (tip_id, kind)');
            await seed(db);
        })().catch((e) => { ready = null; throw e; });
    }
    return ready;
}

// ------------------------------------------------------------------ seed
// seed_key keeps re-seeding idempotent: new items can be added to this list
// later and only the missing ones are inserted. Edits made in the admin win.
const T = (key, name, title, msg, btn, extra) => Object.assign({
    seed_key: 'tpl_' + key, kind: 'template', title: name, body: title + ' · ' + msg,
    cta_label: 'Use this template', cta_view: 'creator', cta_params: Object.assign({ title, msg, btn, type: 'regular' }, extra && extra.params), priority: 5,
}, extra && extra.row);
const SEED = [
    // ---- onboarding track (first 3 days; each disappears once done)
    { seed_key: 'ob_embed', kind: 'onboarding', title: 'Turn Retner on in your theme', body: 'Shoppers only see the subscribe prompt once the app embed is on. Theme editor → App embeds → Retner SmartPush → Save.', cta_label: 'Open theme editor', cta_view: 'theme', day_min: 0, day_max: 30, conditions: { embed_off: true }, priority: 10 },
    { seed_key: 'ob_brand', kind: 'onboarding', title: 'Add your logo and store name', body: 'They appear on every notification. A square logo works best.', cta_label: 'Open settings', cta_view: 'settings', day_min: 0, day_max: 14, conditions: { no_logo: true }, priority: 9 },
    { seed_key: 'ob_test', kind: 'onboarding', title: 'Send a test to yourself', body: 'Write a title and a message, press "Send test to me", and see it on your own phone or laptop before any shopper does.', cta_label: 'Open the creator', cta_view: 'creator', day_min: 0, day_max: 7, conditions: { no_campaign: true }, priority: 8 },
    { seed_key: 'ob_welcome', kind: 'onboarding', title: 'Greet every new subscriber automatically', body: 'The Welcome automation sends one friendly notification the moment someone subscribes. One switch, runs forever.', cta_label: 'Turn on Welcome', cta_view: 'automations', cta_params: { automation: 'welcome' }, day_min: 0, day_max: 30, conditions: { automation_off: 'welcome' }, priority: 9 },
    { seed_key: 'ob_cart', kind: 'onboarding', title: 'Bring back abandoned carts', body: 'Cart recovery reminds shoppers about the cart they left, with the product photo, an hour later. Stores see 5–12% of carts come back.', cta_label: 'Turn on cart recovery', cta_view: 'automations', cta_params: { automation: 'abandoned_cart' }, day_min: 1, day_max: 45, conditions: { automation_off: 'abandoned_cart' }, priority: 8 },
    { seed_key: 'ob_first', kind: 'onboarding', title: 'Send your first campaign', body: 'Pick a template, add your link, send now or schedule for the evening. Your subscribers are waiting.', cta_label: 'Start from a template', cta_view: 'creator', day_min: 1, day_max: 30, conditions: { no_campaign: true, subscribers_gte: 1 }, priority: 8 },
    { seed_key: 'ob_segments', kind: 'onboarding', title: 'Target an audience, not everyone', body: 'Segments like "added to cart" or "inactive 30+ days" are counted live. Send the right offer to the right group.', cta_label: 'See segments', cta_view: 'segments', day_min: 2, day_max: 30, priority: 6 },
    { seed_key: 'ob_analytics', kind: 'onboarding', title: 'Check results after 24 hours', body: 'Analytics shows delivered, clicks, click rate and revenue from orders placed after a click.', cta_label: 'Open analytics', cta_view: 'analytics', day_min: 2, day_max: 14, conditions: { has_campaign: true }, priority: 5 },
    // ---- templates
    T('weekend', '🎉 Weekend sale', 'Weekend sale is live 🎉', '20% off everything till Sunday midnight. Tap to shop.', 'Shop now', { params: { type: 'flash' } }),
    T('backinstock', '📦 Back in stock', 'Back in stock: your favourite 📦', 'It sold out in 2 days last time. Grab yours before it goes again.', 'Get it now'),
    T('newarrival', '🆕 New arrival', 'Just dropped 🆕', 'First look for subscribers only. See the new collection.', 'See collection'),
    T('cart', '🛒 Cart reminder', 'Your cart misses you 🛒', 'Your items are still waiting. Checkout takes 30 seconds.', 'Finish checkout'),
    T('last3h', '⏰ Last hours', 'Last 3 hours ⏰', 'The sale ends tonight. Use code SAVE15 at checkout.', 'Use SAVE15', { params: { type: 'flash' } }),
    T('thanks', '🙏 Order thank-you', 'Thanks for your order 🙏', 'We are packing it now. Here is 10% off your next one: THANKS10.', 'Shop again'),
    T('pricedrop', '🏷️ Price drop', 'Price drop on a product you viewed 🏷️', 'It is cheaper today. Tap to see the new price.', 'See price'),
    T('freeship', '🚚 Free shipping', 'Free shipping today only 🚚', 'No minimum order. Ends at midnight.', 'Shop now', { params: { type: 'flash' } }),
    T('restock', '🔁 Reorder reminder', 'Running low? 🔁', 'Reorder your usual in one tap and never run out.', 'Reorder'),
    T('missyou', '💙 We miss you', 'We miss you 💙', 'It has been a while. Here is what is new, plus 15% off to come back: HELLO15.', 'Come back'),
    T('payday', '💸 Payday treat', 'Payday treat 💸', 'Something nice for you this weekend. Shop the picks.', 'Shop picks'),
    T('review', '⭐ Review request', 'How was your order? ⭐', 'A quick rating helps other shoppers choose. It takes 10 seconds.', 'Rate it'),
    T('bundle', '🎁 Bundle offer', 'Buy 2, get 1 free 🎁', 'Mix and match your favourites. This week only.', 'Build my bundle'),
    T('vip', '✨ VIP early access', 'VIP early access ✨', 'You see it 24 hours before everyone else. Shop the preview.', 'Shop early'),
    T('lowstock', '👀 Low stock', 'Only a few left 👀', 'The item you looked at is almost gone. Tap before it sells out.', 'View item'),
    // ---- seasonal (dates are yearly; the admin can move them)
    T('diwali', '🪔 Diwali sale', 'Diwali lights sale 🪔', 'Up to 40% off gifts and décor. Festive delivery guaranteed.', 'Shop Diwali', { row: { kind: 'season', season_from: '2026-10-15', season_to: '2026-11-10', priority: 8 } }),
    T('bfcm', '🖤 Black Friday', 'Black Friday early access 🖤', 'Our biggest prices of the year, 24 hours early for you.', 'Shop deals', { row: { kind: 'season', season_from: '2026-11-15', season_to: '2026-12-02', priority: 9 }, params: { type: 'flash' } }),
    T('xmas', '🎄 Christmas gifts', 'Christmas gift guide 🎄', 'Gifts for everyone on your list, delivered before the 24th.', 'See gift guide', { row: { kind: 'season', season_from: '2026-12-01', season_to: '2026-12-24', priority: 7 } }),
    T('newyear', '🥳 New Year', 'New year, new favourites 🥳', 'Start the year with 20% off. Code NEW20 till 5 Jan.', 'Use NEW20', { row: { kind: 'season', season_from: '2026-12-26', season_to: '2027-01-05', priority: 7 } }),
    T('valentine', '❤️ Valentine', 'Valentine gifts they will love ❤️', 'Order by 10 Feb for delivery in time.', 'Shop gifts', { row: { kind: 'season', season_from: '2027-01-25', season_to: '2027-02-14', priority: 7 } }),
    T('holi', '🎨 Holi', 'Holi colours sale 🎨', 'Bright deals for the festival of colours. Ends Holi night.', 'Shop Holi', { row: { kind: 'season', season_from: '2027-02-20', season_to: '2027-03-15', priority: 6 } }),
    T('eid', '🌙 Eid', 'Eid collection is here 🌙', 'Celebrate in style. Festive favourites with free delivery.', 'Shop Eid', { row: { kind: 'season', season_from: '2027-02-25', season_to: '2027-03-25', priority: 6 } }),
    T('monsoon', '🌧️ Monsoon sale', 'Monsoon sale ☔', 'Rainy-day prices on everything you need this season.', 'Shop sale', { row: { kind: 'season', season_from: '2027-06-15', season_to: '2027-07-31', priority: 5 } }),
    T('independence', '🇮🇳 Independence Day', 'Freedom sale 🇮🇳', 'Flat 15% off this Independence Day weekend.', 'Shop now', { row: { kind: 'season', season_from: '2027-08-08', season_to: '2027-08-16', priority: 6 } }),
    T('rakhi', '🎀 Raksha Bandhan', 'Rakhi gifts, sorted 🎀', 'Gifts for every sibling, delivered before Rakhi.', 'Shop gifts', { row: { kind: 'season', season_from: '2027-08-01', season_to: '2027-08-20', priority: 6 } }),
    // ---- writing tips
    { seed_key: 'tip_len', kind: 'tip', title: 'Title under 50, message under 120', body: 'Phones cut the rest. Put the offer first and the brand last.', cta_label: 'Write one', cta_view: 'creator', priority: 6 },
    { seed_key: 'tip_emoji', kind: 'tip', title: 'One emoji at the start lifts clicks', body: 'Three emojis lower them. Pick one that matches the offer.', cta_label: 'Try it', cta_view: 'creator', priority: 4 },
    { seed_key: 'tip_deadline', kind: 'tip', title: 'Say when it ends', body: '"Till midnight" beats "limited time". Flash sales can carry a real end time so late shoppers do not see an expired offer.', cta_label: 'Make a flash sale', cta_view: 'creator', cta_params: { type: 'flash' }, priority: 5 },
    { seed_key: 'tip_image', kind: 'tip', title: 'Use the hero image for the product', body: 'A 2:1 product photo gets more taps than a banner with text. Android and Windows show it large.', cta_label: 'Add an image', cta_view: 'creator', priority: 4 },
    { seed_key: 'tip_timing', kind: 'tip', title: 'Send between 6 and 9 pm', body: 'Evening sends get the most shopping clicks; 10 am works for restocks and reorders. Schedule instead of sending now.', cta_label: 'Schedule a campaign', cta_view: 'creator', priority: 5 },
    { seed_key: 'tip_repeat', kind: 'tip', title: 'Do not repeat a campaign within a week', body: 'The same offer twice to the same people drives unsubscribes. Rotate segments instead.', cta_label: 'See segments', cta_view: 'segments', priority: 3 },
    { seed_key: 'tip_test', kind: 'tip', title: 'A test send catches cut-off text', body: 'Before you send, press "Send test to me" and check the title, the image and the link on your phone.', cta_label: 'Open the creator', cta_view: 'creator', priority: 4 },
    { seed_key: 'tip_code', kind: 'tip', title: 'Put the discount code in the message', body: 'Shoppers copy it from the notification. "Use code WELCOME10" is added for you when you fill the code field.', cta_label: 'Add a code', cta_view: 'creator', priority: 3 },
    // ---- features and ideas
    { seed_key: 'feat_cart', kind: 'feature', title: 'Cart recovery pays for the app', body: 'One reminder with the product photo, sent an hour after a cart is left. Add a code for a second nudge the next day.', cta_label: 'Set up cart recovery', cta_view: 'automations', cta_params: { automation: 'abandoned_cart' }, conditions: { automation_off: 'abandoned_cart' }, priority: 8 },
    { seed_key: 'feat_browse', kind: 'feature', title: 'Browse abandonment for high-ticket items', body: 'Shoppers who viewed a product twice but never added it get one reminder. Works best on items above ₹1,500.', cta_label: 'Turn it on', cta_view: 'automations', cta_params: { automation: 'browse_abandonment' }, conditions: { automation_off: 'browse_abandonment' }, priority: 6 },
    { seed_key: 'feat_winback', kind: 'feature', title: 'Win back the quiet ones', body: 'Subscribers who have not visited for 30 days get one "we miss you" with a code. Cheap, and they already said yes to you once.', cta_label: 'Set up win-back', cta_view: 'automations', cta_params: { automation: 'winback' }, conditions: { automation_off: 'winback', subscribers_gte: 50 }, priority: 6 },
    { seed_key: 'feat_backstock', kind: 'feature', title: 'Back-in-stock alerts', body: 'A sold-out page becomes a waiting list: everyone who viewed it gets told the moment it is back.', cta_label: 'Turn it on', cta_view: 'automations', cta_params: { automation: 'back_in_stock' }, conditions: { automation_off: 'back_in_stock' }, priority: 5 },
    { seed_key: 'feat_pricedrop', kind: 'feature', title: 'Price drop alerts sell themselves', body: 'When a viewed product gets cheaper, the viewer hears about it first.', cta_label: 'Turn it on', cta_view: 'automations', cta_params: { automation: 'price_drop' }, conditions: { automation_off: 'price_drop' }, priority: 5 },
    { seed_key: 'feat_thankyou', kind: 'feature', title: 'Thank buyers right after checkout', body: 'A thank-you with a code for the next order turns one purchase into two. Needs instant order detection.', cta_label: 'Set it up', cta_view: 'automations', cta_params: { automation: 'order_thank_you' }, conditions: { automation_off: 'order_thank_you' }, priority: 5 },
    { seed_key: 'idea_flash_active', kind: 'idea', title: 'Flash sales only to "active this week"', body: 'They are already browsing; a 3-hour offer converts best with them and keeps the rest of the list fresh.', cta_label: 'Pick the segment', cta_view: 'segments', conditions: { subscribers_gte: 100 }, priority: 5 },
    { seed_key: 'idea_browser', kind: 'idea', title: 'Images look different on Safari', body: 'macOS and iPhone show only the icon. For an image-led campaign, target the Chrome segment.', cta_label: 'See browser segments', cta_view: 'segments', priority: 3 },
    { seed_key: 'idea_revenue', kind: 'idea', title: 'Revenue follows the click', body: 'Analytics attributes an order to the last notification clicked. Add UTM-free links; tracking is added for you.', cta_label: 'Open analytics', cta_view: 'analytics', conditions: { has_campaign: true }, priority: 4 },
    { seed_key: 'idea_password', kind: 'idea', title: 'Log in without Shopify', body: 'Set a dashboard password in Settings and open the dashboard from any device.', cta_label: 'Set a password', cta_view: 'settings', priority: 2 },
    { seed_key: 'idea_plan', kind: 'idea', title: 'Pick your plan before the trial ends', body: 'Free keeps 10,000 impressions a month; Growth and Unlimited keep segments. Your data stays either way.', cta_label: 'See plans', cta_view: 'plan', conditions: { on_trial: true }, day_min: 4, priority: 7 },
    // ---- coming soon (collects interest)
    { seed_key: 'soon_ab', kind: 'coming_soon', title: 'Coming soon: A/B test two titles', body: 'Send two titles to 10% of subscribers, the winner goes to the rest. Tell us if you want it.', cta_label: 'I want this', cta_view: 'home', priority: 3 },
    { seed_key: 'soon_product_segments', kind: 'coming_soon', title: 'Coming soon: segments by product', body: '"Viewed sneakers in the last 30 days" as an audience. Tell us if you want it.', cta_label: 'I want this', cta_view: 'home', priority: 3 },
    { seed_key: 'soon_recurring', kind: 'coming_soon', title: 'Coming soon: recurring campaigns', body: 'A weekly "new this week" that sends itself every Friday. Tell us if you want it.', cta_label: 'I want this', cta_view: 'home', priority: 3 },
];

async function seed(db) {
    for (const t of SEED) {
        await db.query(
            `INSERT INTO merchant_tips (seed_key, kind, title, body, cta_label, cta_view, cta_params, day_min, day_max, conditions, season_from, season_to, priority)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (seed_key) DO NOTHING`,
            [t.seed_key, t.kind, t.title, t.body, t.cta_label || null, t.cta_view || null, JSON.stringify(t.cta_params || {}), t.day_min ?? null, t.day_max ?? null, JSON.stringify(t.conditions || {}), t.season_from || null, t.season_to || null, t.priority || 5]
        );
    }
}

// ------------------------------------------------------------ store context
function parseSettings(v) {
    if (!v) return {};
    if (typeof v === 'string') { try { return JSON.parse(v) || {}; } catch { return {}; } }
    return typeof v === 'object' ? v : {};
}

async function storeContext(db, storeId) {
    const { rows } = await db.query(
        `SELECT s.created_at, s.welcome_enabled, s.abandoned_enabled, s.automation_settings, s.logo_url, s.store_email, s.is_onboarded,
                (SELECT COUNT(*)::int FROM campaigns c WHERE c.store_id = s.store_id AND c.status = 'sent') AS campaigns_sent,
                (SELECT COUNT(*)::int FROM subscriptions u WHERE u.store_id = s.store_id AND (u.status IS NULL OR u.status = 'active')) AS subscribers,
                (SELECT updated_at FROM push_system_state WHERE key = 'storefront:' || s.store_id) AS storefront_seen_at
         FROM stores s WHERE s.store_id = $1`, [storeId]);
    const r = rows[0];
    if (!r) return null;
    const ent = await entitlements.get(db, storeId);
    const settings = parseSettings(r.automation_settings);
    const on = (key) => {
        if (key === 'welcome') return !!r.welcome_enabled || !!(settings.welcome && settings.welcome.enabled);
        if (key === 'abandoned_cart') return !!r.abandoned_enabled || !!(settings.abandoned_cart && settings.abandoned_cart.enabled);
        return !!(settings[key] && settings[key].enabled);
    };
    const installed = r.created_at ? new Date(r.created_at) : new Date();
    const day = Math.max(0, Math.floor((Date.now() - installed.getTime()) / 86400000));
    const seen = r.storefront_seen_at ? Date.now() - new Date(r.storefront_seen_at).getTime() < 3 * 86400000 : false;
    return {
        day, campaigns_sent: r.campaigns_sent, subscribers: r.subscribers,
        embed_on: seen || r.subscribers > 0, logo: !!r.logo_url, email: !!r.store_email,
        automation_on: on, plan: ent.plan.key, on_trial: !!ent.trial.active, segments_unlocked: ent.segments_unlocked,
    };
}

function eligible(t, ctx, today) {
    if (!t.active) return false;
    if (t.day_min !== null && t.day_min !== undefined && ctx.day < t.day_min) return false;
    if (t.day_max !== null && t.day_max !== undefined && ctx.day > t.day_max) return false;
    if (t.season_from && today < String(t.season_from).slice(0, 10)) return false;
    if (t.season_to && today > String(t.season_to).slice(0, 10)) return false;
    const c = t.conditions || {};
    if (c.no_campaign && ctx.campaigns_sent > 0) return false;
    if (c.has_campaign && ctx.campaigns_sent === 0) return false;
    if (c.automation_off && ctx.automation_on(c.automation_off)) return false;
    if (c.automation_on && !ctx.automation_on(c.automation_on)) return false;
    if (c.segments_locked && ctx.segments_unlocked) return false;
    if (c.embed_off && ctx.embed_on) return false;
    if (c.no_logo && ctx.logo) return false;
    if (c.no_email && ctx.email) return false;
    if (c.subscribers_lt !== undefined && !(ctx.subscribers < Number(c.subscribers_lt))) return false;
    if (c.subscribers_gte !== undefined && !(ctx.subscribers >= Number(c.subscribers_gte))) return false;
    if (c.on_trial && !ctx.on_trial) return false;
    if (Array.isArray(c.plan) && c.plan.length && c.plan.indexOf(ctx.plan) === -1) return false;
    return true;
}

// Seeded PRNG so a reload shows the same picks until the day changes.
function seededRandom(seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function publicItem(t) {
    return { id: t.id, kind: t.kind, title: t.title, body: t.body, cta_label: t.cta_label, cta_view: t.cta_view, cta_params: t.cta_params || {}, priority: t.priority, season_from: t.season_from, season_to: t.season_to };
}

// surface: home (3 rotated, onboarding first in the first days), loading (1
// short tip), creator (every eligible template, seasonal first), app (= home).
async function pick(db, storeId, surface, n) {
    await ensureTables(db);
    const ctx = await storeContext(db, storeId);
    if (!ctx) return { items: [], context: null };
    const today = new Date().toISOString().slice(0, 10);
    const { rows } = await db.query('SELECT * FROM merchant_tips WHERE active = TRUE ORDER BY priority DESC, id');
    const all = rows.filter((t) => eligible(t, ctx, today));
    if (surface === 'creator') {
        const tpl = all.filter((t) => t.kind === 'template' || t.kind === 'season');
        tpl.sort((a, b) => (a.kind === 'season' ? 0 : 1) - (b.kind === 'season' ? 0 : 1) || b.priority - a.priority);
        return { items: tpl.map(publicItem), context: ctx };
    }
    const recent = await db.query(
        `SELECT DISTINCT ON (tip_id) tip_id, at FROM tip_events WHERE store_id = $1 AND kind = 'shown' AND at > NOW() - INTERVAL '30 days' ORDER BY tip_id, at DESC`, [storeId]);
    const recentIds = recent.rows.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, RECENT_WINDOW).map((r) => r.tip_id);
    const rand = seededRandom(storeId + ':' + today + ':' + surface);
    const want = Math.max(1, Math.min(6, Number(n) || (surface === 'loading' ? 1 : 3)));
    let pool = surface === 'loading' ? all.filter((t) => ['tip', 'feature', 'idea'].indexOf(t.kind) !== -1) : all.filter((t) => t.kind !== 'template' || ctx.campaigns_sent === 0 || rand() < 0.5);
    if (!pool.length) pool = all;
    // Weighted sample without replacement (priority = weight), skipping the last ten shown when there is enough else.
    const fresh = pool.filter((t) => recentIds.indexOf(t.id) === -1);
    const candidates = fresh.length >= want ? fresh : pool;
    const keyed = candidates.map((t) => ({ t, key: Math.pow(rand(), 1 / Math.max(1, t.priority)) }));
    keyed.sort((a, b) => b.key - a.key);
    let picked = keyed.map((k) => k.t);
    if (surface !== 'loading' && ctx.day <= 3) {
        // Onboarding items first, in priority order, then the rest.
        const ob = picked.filter((t) => t.kind === 'onboarding').sort((a, b) => b.priority - a.priority);
        picked = ob.concat(picked.filter((t) => t.kind !== 'onboarding'));
    }
    picked = picked.slice(0, want);
    return { items: picked.map(publicItem), context: ctx };
}

async function recordEvent(db, storeId, tipId, kind, surface) {
    await ensureTables(db);
    if (['shown', 'clicked', 'used', 'wanted', 'dismissed'].indexOf(kind) === -1) throw Object.assign(new Error('Unknown event'), { status: 400 });
    const id = parseInt(tipId, 10);
    if (!id) throw Object.assign(new Error('Unknown tip'), { status: 400 });
    if (kind === 'shown') {
        // One "shown" per store/tip/day keeps the recent window meaningful.
        const { rows } = await db.query(`SELECT 1 FROM tip_events WHERE store_id = $1 AND tip_id = $2 AND kind = 'shown' AND at > NOW() - INTERVAL '1 day' LIMIT 1`, [storeId, id]);
        if (rows.length) return;
    }
    await db.query('INSERT INTO tip_events (store_id, tip_id, kind, surface) VALUES ($1, $2, $3, $4)', [storeId, id, kind, surface ? String(surface).slice(0, 20) : null]);
}

// ----------------------------------------------------------------- admin
async function adminList(db) {
    await ensureTables(db);
    const { rows } = await db.query(
        `SELECT t.*,
                (SELECT COUNT(*)::int FROM tip_events e WHERE e.tip_id = t.id AND e.kind = 'shown') AS shown,
                (SELECT COUNT(*)::int FROM tip_events e WHERE e.tip_id = t.id AND e.kind IN ('clicked','used')) AS clicked,
                (SELECT COUNT(*)::int FROM tip_events e WHERE e.tip_id = t.id AND e.kind = 'wanted') AS wanted
         FROM merchant_tips t ORDER BY active DESC, kind, priority DESC, id`);
    return rows;
}

function cleanItem(input) {
    const i = input || {};
    const kind = KINDS.indexOf(i.kind) !== -1 ? i.kind : 'tip';
    const title = String(i.title || '').trim().slice(0, 120);
    if (!title) throw Object.assign(new Error('Title is required.'), { status: 400 });
    const view = VIEWS.indexOf(i.cta_view) !== -1 ? i.cta_view : null;
    let params = i.cta_params;
    if (typeof params === 'string') { try { params = JSON.parse(params || '{}'); } catch { throw Object.assign(new Error('Button params must be JSON.'), { status: 400 }); } }
    let cond = i.conditions;
    if (typeof cond === 'string') { try { cond = JSON.parse(cond || '{}'); } catch { throw Object.assign(new Error('Conditions must be JSON.'), { status: 400 }); } }
    const num = (v) => (v === '' || v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? parseInt(v, 10) : null));
    const date = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(String(v).slice(0, 10)) ? String(v).slice(0, 10) : null);
    return {
        kind, title, body: String(i.body || '').trim().slice(0, 600), cta_label: String(i.cta_label || '').trim().slice(0, 60) || null, cta_view: view,
        cta_params: params && typeof params === 'object' ? params : {}, day_min: num(i.day_min), day_max: num(i.day_max),
        conditions: cond && typeof cond === 'object' ? cond : {}, season_from: date(i.season_from), season_to: date(i.season_to),
        priority: Math.min(10, Math.max(1, num(i.priority) || 5)), active: i.active === undefined ? true : !!i.active && i.active !== 'false',
    };
}

async function adminSave(db, input) {
    await ensureTables(db);
    const c = cleanItem(input);
    const id = parseInt(input && input.id, 10) || null;
    const vals = [c.kind, c.title, c.body, c.cta_label, c.cta_view, JSON.stringify(c.cta_params), c.day_min, c.day_max, JSON.stringify(c.conditions), c.season_from, c.season_to, c.priority, c.active];
    if (id) {
        const { rows } = await db.query(
            `UPDATE merchant_tips SET kind=$1, title=$2, body=$3, cta_label=$4, cta_view=$5, cta_params=$6, day_min=$7, day_max=$8, conditions=$9, season_from=$10, season_to=$11, priority=$12, active=$13, updated_at=NOW()
             WHERE id = $14 RETURNING *`, vals.concat([id]));
        if (!rows.length) throw Object.assign(new Error('Tip not found'), { status: 404 });
        return rows[0];
    }
    const { rows } = await db.query(
        `INSERT INTO merchant_tips (kind, title, body, cta_label, cta_view, cta_params, day_min, day_max, conditions, season_from, season_to, priority, active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, vals);
    return rows[0];
}

async function adminSetActive(db, id, active) {
    await ensureTables(db);
    const { rows } = await db.query('UPDATE merchant_tips SET active = $2, updated_at = NOW() WHERE id = $1 RETURNING id, active', [parseInt(id, 10) || 0, !!active]);
    if (!rows.length) throw Object.assign(new Error('Tip not found'), { status: 404 });
    return rows[0];
}

module.exports = { KINDS, VIEWS, ensureTables, pick, recordEvent, adminList, adminSave, adminSetActive, storeContext };
