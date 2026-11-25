'use strict';
// Plans shown on the "Plan" pages (dashboard + Shopify app). A store's plan is
// derived from stores.monthly_limit, which the super admin sets; there is no
// automatic billing. "Upgrade" records a request (plan_requests) and points the
// merchant to the contact email.

const PLANS = [
    {
        key: 'starter', name: 'Starter', limit: 1000, price: 0,
        blurb: 'Everything you need to start with push.',
        features: ['1,000 notifications a month', 'All automations', 'Campaigns, scheduling and segments', 'Analytics'],
    },
    {
        key: 'growth', name: 'Growth', limit: 10000, price: 999,
        blurb: 'For stores sending to thousands of subscribers.',
        features: ['10,000 notifications a month', 'Everything in Starter', 'Priority email support'],
    },
    {
        key: 'pro', name: 'Pro', limit: 50000, price: 2499,
        blurb: 'For high-volume stores and big launches.',
        features: ['50,000 notifications a month', 'Everything in Growth', 'Higher limits on request'],
    },
];

function contactEmail() {
    return process.env.UPGRADE_CONTACT_EMAIL || 'hello@retner.ai';
}

function byKey(key) {
    return PLANS.find((p) => p.key === key) || null;
}

// The plan a monthly limit corresponds to. An exact match is that plan; a
// limit above Pro is a custom plan; anything else is the nearest lower plan
// with `custom_limit` set so the UI can say "custom allowance".
function planForLimit(limit) {
    const n = Number(limit);
    const exact = PLANS.find((p) => p.limit === n);
    if (exact) return { key: exact.key, name: exact.name, price: exact.price, limit: exact.limit, custom_limit: false };
    const top = PLANS[PLANS.length - 1];
    if (n > top.limit) return { key: 'custom', name: 'Custom', price: null, limit: n, custom_limit: true };
    let base = PLANS[0];
    for (const p of PLANS) if (p.limit <= n) base = p;
    return { key: base.key, name: base.name, price: base.price, limit: n, custom_limit: true };
}

function mailto(plan, storeId) {
    const subject = `SmartPush ${plan.name} plan for ${storeId}`;
    const body = `Hi Retner,\n\nI would like to move ${storeId} to the ${plan.name} plan (${plan.limit.toLocaleString('en-IN')} notifications a month).\n\nThanks`;
    return `mailto:${contactEmail()}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

module.exports = { PLANS, byKey, planForLimit, contactEmail, mailto };
