'use strict';
// Monthly impressions (notifications delivered) vs the allowance in force.
// `limit`: number, or null for unlimited; when omitted the legacy
// stores.monthly_limit is used. Calendar month in India time.
// Counts every push actually delivered to a push service: campaigns
// (sent_count) + automations (push_automation_log, test sends excluded).

const TZ = 'Asia/Kolkata';
const DEFAULT_LIMIT = 1000;

async function getUsage(db, storeId, limitArg) {
    const { rows } = await db.query(
        `WITH period AS (
           SELECT date_trunc('month', NOW() AT TIME ZONE $2) AT TIME ZONE $2 AS start,
                  (date_trunc('month', NOW() AT TIME ZONE $2) + INTERVAL '1 month') AT TIME ZONE $2 AS next
         )
         SELECT
           (SELECT monthly_limit FROM stores WHERE store_id = $1) AS monthly_limit,
           (SELECT COALESCE(SUM(sent_count), 0) FROM campaigns
              WHERE store_id = $1 AND status = 'sent' AND (created_at AT TIME ZONE 'UTC') >= (SELECT start FROM period))::bigint AS campaigns,
           (SELECT COUNT(*) FROM push_automation_log
              WHERE store_id = $1 AND status = 'sent' AND automation <> 'test' AND sent_at >= (SELECT start FROM period))::bigint AS automations,
           (SELECT start FROM period) AS period_start,
           (SELECT next FROM period) AS period_end`,
        [storeId, TZ]
    );
    const r = rows[0] || {};
    const legacy = Number.isFinite(Number(r.monthly_limit)) && r.monthly_limit !== null ? Number(r.monthly_limit) : DEFAULT_LIMIT;
    const limit = limitArg === undefined ? legacy : (limitArg === null ? null : Number(limitArg));
    const used = Number(r.campaigns || 0) + Number(r.automations || 0);
    return {
        limit,
        unlimited: limit === null,
        used,
        campaigns: Number(r.campaigns || 0),
        automations: Number(r.automations || 0),
        remaining: limit === null ? null : Math.max(0, limit - used),
        percent: limit === null ? 0 : (limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 100),
        period_start: r.period_start,
        resets_on: r.period_end,
    };
}

module.exports = { getUsage, DEFAULT_LIMIT };
