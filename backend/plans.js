'use strict';
// Plans shown on the "Plan" pages (dashboard + Shopify app), priced in USD.
// An "impression" is one notification delivered to a push service
// (campaigns + automations, test sends excluded).
//
// - Every store gets a 7-day free trial of the Unlimited plan.
// - After the trial the merchant picks a plan (stores.plan_key, applied at
//   once); until they do, the store is on Free (10,000 impressions a month,
//   segments locked). stores.monthly_limit still works as a custom allowance
//   on top of a plan. Paid plans also record a plan_request so the team can
//   follow up on billing; there is no automatic billing.

const TRIAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Growth allowance: the brief fixed only the price; change here or via env.
const GROWTH_LIMIT = parseInt(process.env.GROWTH_IMPRESSIONS || '50000', 10) || 50000;
const UNLIMITED_SENTINEL = 1000000; // monthly_limit stored for Unlimited stores (legacy readers)

const PLANS = [
    {
        key: 'free', name: 'Free', limit: 10000, price: 0, currency: 'USD', segments: false,
        blurb: 'Start with push at no cost.',
        features: ['10,000 impressions a month', 'Campaigns and all automations', 'Analytics and subscriber growth', 'Segments locked'],
    },
    {
        key: 'growth', name: 'Growth', limit: GROWTH_LIMIT, price: 30, currency: 'USD', segments: true,
        blurb: 'For stores sending to thousands of subscribers.',
        features: [GROWTH_LIMIT.toLocaleString('en-US') + ' impressions a month', 'Segments unlocked', 'Everything in Free', 'Priority email support'],
    },
    {
        key: 'unlimited', name: 'Unlimited', limit: null, price: 50, currency: 'USD', segments: true,
        blurb: 'No impression cap. For high-volume stores and big launches.',
        features: ['Unlimited impressions', 'Segments unlocked', 'Everything in Growth', 'Custom allowances on request'],
    },
];

function contactEmail() {
    return process.env.UPGRADE_CONTACT_EMAIL || 'hello@retner.ai';
}

// App Store listing where the merchant can leave a review.
function reviewUrl() {
    return process.env.APP_REVIEW_URL || 'https://apps.shopify.com/retner-smartpush-live/reviews';
}

function byKey(key) {
    return PLANS.find((p) => p.key === key) || null;
}

// The plan a store is on. stores.plan_key wins; stores without one (created
// before plans had keys) are derived from the allowance the super admin set.
function planForStore(row) {
    const r = row || {};
    const keyed = byKey(r.plan_key);
    if (keyed) return keyed;
    const n = Number(r.monthly_limit);
    if (n >= UNLIMITED_SENTINEL) return byKey('unlimited');
    if (n >= GROWTH_LIMIT) return byKey('growth');
    return byKey('free');
}

// Kept for older callers: the plan a monthly limit corresponds to.
function planForLimit(limit) {
    const p = planForStore({ monthly_limit: limit });
    const n = Number(limit);
    const custom = p.limit !== null && Number.isFinite(n) && n > p.limit;
    return { key: p.key, name: p.name, price: p.price, currency: p.currency, limit: custom ? n : p.limit, custom_limit: custom };
}

// Trial window of a store. trial_started_at is set by entitlements.js the
// first time a store is seen; until then the trial counts from "now".
// (Trial extensions were removed on 2026-11-27; the fields stay for old rows.)
function trialState(row, now) {
    const t = now ? new Date(now) : new Date();
    const r = row || {};
    const started = r.trial_started_at ? new Date(r.trial_started_at) : t;
    const ends = r.trial_ends_at ? new Date(r.trial_ends_at) : new Date(started.getTime() + TRIAL_DAYS * DAY_MS);
    const extended = !!r.trial_extended_at;
    const active = t < ends;
    const daysLeft = active ? Math.max(1, Math.ceil((ends - t) / DAY_MS)) : 0;
    return {
        active,
        started_at: started.toISOString(),
        ends_at: ends.toISOString(),
        days_left: daysLeft,
        extended,
        extended_at: r.trial_extended_at ? new Date(r.trial_extended_at).toISOString() : null,
        can_extend: false,
        trial_days: TRIAL_DAYS,
    };
}

// Monthly allowance in force: null = unlimited.
function effectiveLimit(row, plan, trial) {
    if (trial.active) return null;
    if (plan.limit === null) return null;
    const custom = Number((row || {}).monthly_limit);
    return Number.isFinite(custom) && custom > plan.limit ? custom : plan.limit;
}

// What the store can do right now, plus which popups to show. `usage` comes
// from usage.getUsage(db, storeId, effectiveLimit).
function entitlements(row, usage, now) {
    const t = now ? new Date(now) : new Date();
    const plan = planForStore(row);
    const trial = trialState(row, t);
    const limit = effectiveLimit(row, plan, trial);
    const prompts = (row && row.plan_prompts && typeof row.plan_prompts === 'object') ? row.plan_prompts : {};
    const u = usage || { used: 0, campaigns: 0, automations: 0 };
    const used = Number(u.used || 0);
    const exhausted = limit !== null && used >= limit;
    const periodKey = u.period_start ? new Date(u.period_start).toISOString().slice(0, 10) : null;
    const selected = !!(row && byKey(row.plan_key));
    return {
        plan: { key: plan.key, name: plan.name, price: plan.price, currency: plan.currency, limit: plan.limit, unlimited: plan.limit === null, segments: plan.segments, custom_limit: limit !== null && limit !== plan.limit, selected },
        plan_selected: selected,
        trial,
        segments_unlocked: trial.active || !!plan.segments,
        usage: {
            limit,
            unlimited: limit === null,
            used,
            campaigns: Number(u.campaigns || 0),
            automations: Number(u.automations || 0),
            remaining: limit === null ? null : Math.max(0, limit - used),
            percent: limit === null ? 0 : (limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 100),
            exhausted,
            period_start: u.period_start || null,
            resets_on: u.resets_on || null,
        },
        prompts: {
            // Once after the trial, until the merchant picks a plan.
            trial_ended: !trial.active && !selected && !prompts.trial_ended_seen_at,
            limit_reached: exhausted && !trial.active && prompts.limit_seen_period !== periodKey,
            tour_done: !!prompts.tour_done_at,
        },
        review_url: reviewUrl(),
        contact_email: contactEmail(),
    };
}

function mailto(plan, storeId) {
    const allowance = plan.limit === null ? 'unlimited impressions' : plan.limit.toLocaleString('en-US') + ' impressions a month';
    const subject = `SmartPush ${plan.name} plan for ${storeId}`;
    const body = `Hi Retner,\n\nI would like to move ${storeId} to the ${plan.name} plan (${allowance}${plan.price ? ', $' + plan.price + '/month' : ''}).\n\nThanks`;
    return `mailto:${contactEmail()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

module.exports = { PLANS, TRIAL_DAYS, UNLIMITED_SENTINEL, byKey, planForStore, planForLimit, trialState, effectiveLimit, entitlements, contactEmail, reviewUrl, mailto };
