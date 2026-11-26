'use strict';
// Per-store plan state: trial window, plan, monthly usage against the
// allowance in force, and which popups the dashboards should show.
// Columns are added on first use (additive; see sql/20261127_trial_plans.sql).
const plans = require('./plans');
const usage = require('./usage');

let columnsReady = null;
function ensureColumns(db) {
    if (!columnsReady) {
        columnsReady = db.query(`ALTER TABLE stores
            ADD COLUMN IF NOT EXISTS plan_key TEXT,
            ADD COLUMN IF NOT EXISTS trial_started_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS trial_extended_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS plan_prompts JSONB NOT NULL DEFAULT '{}'::jsonb`)
            .catch((e) => { columnsReady = null; throw e; });
    }
    return columnsReady;
}

const ROW_COLS = 'store_id, monthly_limit, plan_key, trial_started_at, trial_ends_at, trial_extended_at, plan_prompts, created_at';

// The store row with its trial started: the first read after this feature
// shipped starts the 7-day trial, so every store (old or new) gets it once.
async function loadRow(db, storeId) {
    await ensureColumns(db);
    const { rows } = await db.query(`SELECT ${ROW_COLS} FROM stores WHERE store_id = $1`, [storeId]);
    let row = rows[0];
    if (!row) return null;
    if (!row.trial_started_at) {
        const r = await db.query(
            `UPDATE stores SET trial_started_at = NOW(), trial_ends_at = NOW() + ($2 || ' days')::interval
             WHERE store_id = $1 AND trial_started_at IS NULL RETURNING ${ROW_COLS}`,
            [storeId, String(plans.TRIAL_DAYS)]
        );
        row = r.rows[0] || row;
    }
    return row;
}

async function get(db, storeId) {
    const row = await loadRow(db, storeId);
    if (!row) throw Object.assign(new Error('Store not found'), { status: 404 });
    const plan = plans.planForStore(row);
    const trial = plans.trialState(row);
    const limit = plans.effectiveLimit(row, plan, trial);
    const u = await usage.getUsage(db, storeId, limit);
    return plans.entitlements(row, u);
}

// One extension per store: +7 days from the later of now and the trial end.
async function extendTrial(db, storeId) {
    const row = await loadRow(db, storeId);
    if (!row) throw Object.assign(new Error('Store not found'), { status: 404 });
    if (row.trial_extended_at) throw Object.assign(new Error('Your trial was already extended once.'), { status: 400 });
    await db.query(
        `UPDATE stores SET trial_extended_at = NOW(),
            trial_ends_at = GREATEST(NOW(), COALESCE(trial_ends_at, NOW())) + ($2 || ' days')::interval,
            plan_prompts = COALESCE(plan_prompts, '{}'::jsonb) - 'trial_ended_seen_at'
         WHERE store_id = $1 AND trial_extended_at IS NULL`,
        [storeId, String(plans.EXTENSION_DAYS)]
    );
    return get(db, storeId);
}

// Remember that a popup was shown/dismissed. limit_reached is per billing
// month, trial_ended and tour once.
async function dismissPrompt(db, storeId, key) {
    const row = await loadRow(db, storeId);
    if (!row) throw Object.assign(new Error('Store not found'), { status: 404 });
    let patch;
    if (key === 'trial_ended') patch = { trial_ended_seen_at: new Date().toISOString() };
    else if (key === 'tour') patch = { tour_done_at: new Date().toISOString() };
    else if (key === 'limit_reached') {
        const u = await usage.getUsage(db, storeId, 1);
        patch = { limit_seen_period: u.period_start ? new Date(u.period_start).toISOString().slice(0, 10) : 'unknown' };
    } else throw Object.assign(new Error('Unknown prompt'), { status: 400 });
    await db.query(`UPDATE stores SET plan_prompts = COALESCE(plan_prompts, '{}'::jsonb) || $2::jsonb WHERE store_id = $1`, [storeId, JSON.stringify(patch)]);
    return get(db, storeId);
}

// Super admin: put a store on a plan (and keep monthly_limit readable for old code).
async function setPlan(db, storeId, planKey) {
    const p = plans.byKey(planKey);
    if (!p) throw Object.assign(new Error('Unknown plan'), { status: 400 });
    await ensureColumns(db);
    await db.query('UPDATE stores SET plan_key = $2, monthly_limit = $3 WHERE store_id = $1', [storeId, p.key, p.limit === null ? plans.UNLIMITED_SENTINEL : p.limit]);
    return p;
}

module.exports = { ensureColumns, loadRow, get, extendTrial, dismissPrompt, setPlan };
