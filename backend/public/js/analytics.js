/* Retner analytics: Overview, Cart recovery and Live events.
 * RetnerAnalytics.mount(el, { api, store, tab })
 * All numbers come from /my-store/analytics, /my-store/carts, /my-store/events.
 */
(function () {
  'use strict';

  var S = { el: null, api: null, tab: 'overview', days: 30, data: null, carts: [], cartFilter: 'all', cartsDone: false,
            events: [], eventType: 'all', eventsDone: false, live: true, timer: null, charts: [] };
  var TZ = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } })();

  var EVENT_META = {
    subscribed: { icon: 'fa-user-plus', color: 'green', label: 'New subscriber' },
    visit: { icon: 'fa-store', color: 'gray', label: 'Visited the store' },
    product_view: { icon: 'fa-eye', color: 'blue', label: 'Viewed a product' },
    cart: { icon: 'fa-cart-shopping', color: 'amber', label: 'Cart updated' },
    order: { icon: 'fa-bag-shopping', color: 'green', label: 'Placed an order' },
    push_sent: { icon: 'fa-paper-plane', color: 'blue', label: 'Notification sent' },
    push_clicked: { icon: 'fa-hand-pointer', color: 'purple', label: 'Clicked a notification' },
    campaign_sent: { icon: 'fa-bullhorn', color: 'blue', label: 'Campaign sent' },
    campaign_clicked: { icon: 'fa-hand-pointer', color: 'purple', label: 'Campaign clicked' },
  };
  var OUTCOMES = {
    recovered: ['Recovered', 'ok'], purchased: ['Purchased', 'ok'], reminded: ['Reminder sent', 'info'],
    waiting: ['Waiting', 'muted'], empty: ['Emptied', 'muted'], superseded: ['Replaced', 'muted'], expired: ['Expired', 'muted'],
  };

  // ------------------------------------------------------------- helpers
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function money(n, cur) {
    try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0); }
    catch (e) { return num(Math.round(Number(n) || 0)); }
  }
  function ago(iso) {
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  function fullTime(iso) { return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }); }
  function change(t) {
    if (!t || (!t.value && !t.previous)) return '';
    if (t.change === null) return t.value ? '<span class="ra2-chg ra2-new">New</span>' : '';
    if (!t.change) return '<span class="ra2-chg">No change</span>';
    var up = t.change > 0;
    return '<span class="ra2-chg ' + (up ? 'ra2-up' : 'ra2-down') + '"><i class="fas fa-arrow-' + (up ? 'up' : 'down') + '"></i> ' + Math.abs(t.change) + '%</span>';
  }
  function empty(icon, title, text) {
    return '<div class="ra2-empty"><i class="fas ' + icon + '"></i><h4>' + esc(title) + '</h4><p>' + text + '</p></div>';
  }
  function loading(text) { return '<div class="ra2-loading"><i class="fas fa-spinner fa-spin"></i> ' + esc(text || 'Loading…') + '</div>'; }
  function errorBox(text) { return '<div class="ra2-error"><i class="fas fa-circle-exclamation"></i> ' + esc(text) + ' <button class="ra2-btn" data-act="retry">Try again</button></div>'; }
  function who(e) {
    var parts = [];
    if (e.subscriber) parts.push('Subscriber #' + e.subscriber);
    if (e.browser) parts.push(e.browser);
    return parts.join(' · ');
  }
  function destroyCharts() { S.charts.forEach(function (c) { try { c.destroy(); } catch (e) {} }); S.charts = []; }
  function stopLive() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }

  // ------------------------------------------------------------- shell
  function shell(body) {
    var tabs = [['overview', 'fa-chart-line', 'Overview'], ['carts', 'fa-cart-shopping', 'Cart recovery'], ['events', 'fa-wave-square', 'Live events']];
    return '<div class="ra2">' +
      '<div class="ra2-head"><div><h2>Analytics</h2><p>Real results from your subscribers. Times shown in ' + esc(TZ) + '.</p></div>' +
      (S.tab === 'overview' ? '<div class="ra2-seg" role="group" aria-label="Period">' + [7, 30, 90].map(function (d) {
        return '<button data-act="days" data-days="' + d + '" class="' + (S.days === d ? 'on' : '') + '">' + d + ' days</button>';
      }).join('') + '</div>' : '') + '</div>' +
      '<div class="ra2-tabs" role="tablist">' + tabs.map(function (t) {
        return '<button role="tab" aria-selected="' + (S.tab === t[0]) + '" data-act="tab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '"><i class="fas ' + t[1] + '"></i> ' + t[2] + '</button>';
      }).join('') + '</div>' + body + '</div>';
  }

  // ------------------------------------------------------------- overview
  function kpi(label, value, sub, t, icon) {
    return '<div class="ra2-kpi"><div class="ra2-kpi-top"><span>' + esc(label) + '</span><i class="fas ' + icon + '"></i></div>' +
      '<div class="ra2-kpi-val">' + value + '</div><div class="ra2-kpi-sub">' + change(t) + ' <span>' + sub + '</span></div></div>';
  }

  function renderOverview() {
    var d = S.data;
    if (!d) { S.el.innerHTML = shell(loading('Loading analytics…')); return; }
    if (d.error) { S.el.innerHTML = shell(errorBox(d.error)); return; }
    var t = d.totals;
    var period = 'vs previous ' + d.days + ' days';
    var autoRows = d.automations.length ? d.automations.map(function (a) {
      return '<tr><td>' + esc(a.name) + '</td><td>' + num(a.sent) + '</td><td>' + num(a.clicks) + '</td><td>' + a.ctr + '%</td><td>' + num(a.orders) + '</td><td>' + money(a.revenue) + '</td></tr>';
    }).join('') : '';
    var campRows = d.campaigns.length ? d.campaigns.map(function (c) {
      return '<tr><td><div class="ra2-strong">' + esc(c.title) + '</div><div class="ra2-muted">' + esc(fullTime(c.created_at)) + '</div></td><td>' + num(c.sent) + '</td><td>' + num(c.clicks) + '</td><td>' + c.ctr + '%</td><td>' + money(c.revenue) + '</td></tr>';
    }).join('') : '';
    var hasActivity = t.sent.value || t.subscribers.value || t.clicks.value;
    var body =
      '<div class="ra2-kpis">' +
      kpi('New subscribers', num(t.subscribers.value), period, t.subscribers, 'fa-user-plus') +
      kpi('Notifications sent', num(t.sent.value), period, t.sent, 'fa-paper-plane') +
      kpi('Clicks', num(t.clicks.value) + ' <small>' + t.ctr.value + '% CTR</small>', period, t.clicks, 'fa-hand-pointer') +
      kpi('Revenue from notifications', money(t.revenue.value), num(t.orders.value) + ' orders', t.revenue, 'fa-indian-rupee-sign') +
      '</div>' +
      '<div class="ra2-note"><i class="fas fa-users"></i> ' + num(d.subscribers.active) + ' active subscribers (' + num(d.subscribers.all_time) + ' all-time).</div>' +
      (hasActivity
        ? '<div class="ra2-grid2"><div class="ra2-card"><h3>Notifications & clicks</h3><div class="ra2-chart"><canvas id="ra2-c1"></canvas></div></div>' +
          '<div class="ra2-card"><h3>New subscribers</h3><div class="ra2-chart"><canvas id="ra2-c2"></canvas></div></div></div>'
        : '<div class="ra2-card">' + empty('fa-chart-line', 'No activity in this period yet', 'Charts appear as soon as subscribers join or notifications are sent.') + '</div>') +
      '<div class="ra2-card"><h3>Automations</h3>' + (autoRows
        ? '<div class="ra2-table-wrap"><table class="ra2-table"><thead><tr><th>Automation</th><th>Sent</th><th>Clicks</th><th>CTR</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>' + autoRows + '</tbody></table></div>'
        : empty('fa-wand-magic-sparkles', 'No automated notifications in this period', 'Turn on automations to see their results here.')) + '</div>' +
      '<div class="ra2-card"><h3>Campaigns</h3>' + (campRows
        ? '<div class="ra2-table-wrap"><table class="ra2-table"><thead><tr><th>Campaign</th><th>Sent</th><th>Clicks</th><th>CTR</th><th>Revenue</th></tr></thead><tbody>' + campRows + '</tbody></table></div>'
        : empty('fa-bullhorn', 'No campaigns in this period', 'Campaigns you send will be listed here with their results.')) + '</div>';
    S.el.innerHTML = shell(body);
    if (hasActivity) drawCharts(d);
  }

  function drawCharts(d) {
    destroyCharts();
    if (typeof window.Chart === 'undefined') return;
    var labels = d.series.map(function (r) { return new Date(r.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); });
    var common = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, usePointStyle: true } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f1f1f1' } } },
    };
    var c1 = document.getElementById('ra2-c1');
    var c2 = document.getElementById('ra2-c2');
    if (c1) S.charts.push(new window.Chart(c1, { type: 'bar', options: common, data: { labels: labels, datasets: [
      { type: 'bar', label: 'Sent', data: d.series.map(function (r) { return r.sent; }), backgroundColor: '#bfdbfe', borderRadius: 4 },
      { type: 'line', label: 'Clicks', data: d.series.map(function (r) { return r.clicks; }), borderColor: '#7c3aed', backgroundColor: '#7c3aed', tension: 0.35, pointRadius: 0 },
    ] } }));
    if (c2) S.charts.push(new window.Chart(c2, { type: 'line', options: common, data: { labels: labels, datasets: [
      { label: 'New subscribers', data: d.series.map(function (r) { return r.subscribers; }), borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.08)', fill: true, tension: 0.35, pointRadius: 0 },
    ] } }));
  }

  function loadOverview() {
    S.data = null; renderOverview();
    S.api('/my-store/analytics?days=' + S.days + '&tz=' + encodeURIComponent(TZ)).then(function (r) {
      S.data = r.ok && r.data.success ? r.data : { error: 'Could not load analytics.' };
      if (S.tab === 'overview') renderOverview();
    });
  }

  // ------------------------------------------------------------- carts
  function renderCarts() {
    var f = S.data && S.data.cartFunnel;
    var funnel = f ? '<div class="ra2-funnel">' +
      [['Carts tracked', f.tracked], ['Reminded', f.reminded], ['Clicked', f.clicked], ['Recovered', f.recovered]].map(function (s, i, arr) {
        var pct = arr[0][1] ? Math.round((s[1] / arr[0][1]) * 100) : 0;
        return '<div class="ra2-step"><div class="ra2-step-val">' + num(s[1]) + '</div><div class="ra2-step-lbl">' + s[0] + '</div>' +
          (i ? '<div class="ra2-step-pct">' + pct + '%</div>' : '') + '</div>';
      }).join('<i class="fas fa-chevron-right ra2-arrow"></i>') +
      '<div class="ra2-step ra2-step-money"><div class="ra2-step-val">' + money(f.recovered_revenue) + '</div><div class="ra2-step-lbl">Recovered revenue</div></div></div>' +
      '<div class="ra2-note"><i class="fas fa-clock"></i> ' + num(f.open_now) + ' open carts right now worth ' + money(f.open_value) + '. Last ' + S.data.days + ' days.</div>' : '';
    var filters = [['all', 'All'], ['open', 'Open'], ['reminded', 'Reminded'], ['recovered', 'Recovered']].map(function (x) {
      return '<button data-act="cartfilter" data-f="' + x[0] + '" class="' + (S.cartFilter === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
    }).join('');
    var list;
    if (S.carts === null) list = loading('Loading carts…');
    else if (S.carts.error) list = errorBox(S.carts.error);
    else if (!S.carts.length) {
      list = S.cartFilter === 'all'
        ? empty('fa-cart-shopping', 'No abandoned carts yet', 'Your recovered carts will appear here. Carts are tracked when a subscriber adds something to their cart on your store.')
        : empty('fa-filter', 'Nothing here', 'No carts match this filter yet.');
    } else {
      list = '<div class="ra2-table-wrap"><table class="ra2-table ra2-carts"><thead><tr><th>Cart</th><th>Value</th><th>Reminders</th><th>Last activity</th><th>Status</th></tr></thead><tbody>' +
        S.carts.map(function (c) {
          var o = OUTCOMES[c.outcome] || [c.outcome, 'muted'];
          var thumbs = c.items.map(function (i) { return i.image ? '<img src="' + esc(i.image) + '" alt="" loading="lazy">' : '<span class="ra2-thumb-ph"><i class="fas fa-box"></i></span>'; }).join('');
          var title = c.items[0] ? esc(c.items[0].title || 'Item') + (c.item_count > 1 ? ' <span class="ra2-muted">+' + (c.item_count - 1) + ' more</span>' : '') : esc(c.item_count + ' items');
          return '<tr><td><div class="ra2-cartcell"><div class="ra2-thumbs">' + thumbs + '</div><div><div class="ra2-strong">' + title + '</div><div class="ra2-muted">Subscriber #' + esc(c.subscriber || '—') + ' · ' + esc(c.browser) + '</div></div></div></td>' +
            '<td>' + money(c.total, c.currency) + '</td><td>' + num(c.reminders_sent) + (c.clicked_at ? ' <span class="ra2-pill info">clicked</span>' : '') + '</td>' +
            '<td title="' + esc(fullTime(c.updated_at)) + '">' + esc(ago(c.updated_at)) + '</td>' +
            '<td><span class="ra2-pill ' + o[1] + '">' + o[0] + '</span></td></tr>';
        }).join('') + '</tbody></table></div>' +
        (S.cartsDone ? '' : '<div class="ra2-more"><button class="ra2-btn" data-act="morecarts">Load more</button></div>');
    }
    S.el.innerHTML = shell(funnel + '<div class="ra2-card"><div class="ra2-card-head"><h3>Carts</h3><div class="ra2-seg">' + filters + '</div></div>' + list + '</div>');
  }

  function loadCarts(more) {
    var before = more && S.carts && S.carts.length ? '&before=' + encodeURIComponent(S.carts[S.carts.length - 1].updated_at) : '';
    if (!more) { S.carts = null; renderCarts(); }
    var p1 = S.data ? Promise.resolve() : S.api('/my-store/analytics?days=30&tz=' + encodeURIComponent(TZ)).then(function (r) { if (r.ok && r.data.success) S.data = r.data; });
    var p2 = S.api('/my-store/carts?limit=25&status=' + S.cartFilter + before).then(function (r) {
      if (!r.ok || !r.data.success) { S.carts = { error: 'Could not load carts.' }; return; }
      S.cartsDone = r.data.carts.length < 25;
      S.carts = more ? S.carts.concat(r.data.carts) : r.data.carts;
    });
    Promise.all([p1, p2]).then(function () { if (S.tab === 'carts') renderCarts(); });
  }

  // ------------------------------------------------------------- events
  function eventText(e) {
    var d = e.detail || {};
    switch (e.type) {
      case 'cart': return (e.title ? esc(e.title) + ' · ' : '') + num(d.items) + ' item(s) · ' + money(d.total, d.currency);
      case 'order': return money(d.total, d.currency) + ' · ' + num(d.items) + ' item(s)' + (d.attributed ? ' · <span class="ra2-pill ok">from ' + esc(d.attributed.replace(/_/g, ' ')) + '</span>' : '');
      case 'product_view': return esc(e.title || 'Product') + (d.views > 1 ? ' · viewed ' + num(d.views) + '×' : '');
      case 'push_sent': return esc(e.title) + (d.status && d.status !== 'sent' ? ' · <span class="ra2-pill muted">' + esc(d.status) + '</span>' : '');
      case 'push_clicked': return esc(e.title);
      case 'campaign_sent': return esc(e.title) + ' · ' + num(d.sent) + ' sent';
      case 'campaign_clicked': return esc(e.title || 'Campaign');
      default: return '';
    }
  }

  function renderEvents() {
    var types = [['all', 'All events'], ['subscribed', 'New subscribers'], ['visit', 'Visits'], ['product_view', 'Product views'], ['cart', 'Carts'], ['order', 'Orders'],
      ['push_sent', 'Notifications sent'], ['push_clicked', 'Notification clicks'], ['campaign_sent', 'Campaigns'], ['campaign_clicked', 'Campaign clicks']];
    var controls = '<div class="ra2-card-head"><h3>Live events</h3><div class="ra2-row">' +
      '<select data-act="etype" aria-label="Event type">' + types.map(function (x) { return '<option value="' + x[0] + '"' + (S.eventType === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>' +
      '<label class="ra2-live"><input type="checkbox" data-act="live"' + (S.live ? ' checked' : '') + '> <span class="ra2-dot' + (S.live ? ' on' : '') + '"></span> Live</label></div></div>';
    var list;
    if (S.events === null) list = loading('Loading events…');
    else if (S.events.error) list = errorBox(S.events.error);
    else if (!S.events.length) list = empty('fa-wave-square', 'No events yet', 'Subscriber activity — visits, product views, carts, orders and notification clicks — shows up here in real time.');
    else {
      list = '<ul class="ra2-feed">' + S.events.map(function (e) {
        var m = EVENT_META[e.type] || { icon: 'fa-circle', color: 'gray', label: e.type };
        return '<li><span class="ra2-ev-ic ' + m.color + '"><i class="fas ' + m.icon + '"></i></span><div class="ra2-ev-main"><div><b>' + m.label + '</b> ' +
          (eventText(e) ? '<span class="ra2-ev-txt">' + eventText(e) + '</span>' : '') + '</div><div class="ra2-muted">' + esc(who(e)) + '</div></div>' +
          '<time title="' + esc(fullTime(e.at)) + '">' + esc(ago(e.at)) + '</time></li>';
      }).join('') + '</ul>' + (S.eventsDone ? '' : '<div class="ra2-more"><button class="ra2-btn" data-act="moreevents">Load older</button></div>');
    }
    S.el.innerHTML = shell('<div class="ra2-card">' + controls + list + '</div>');
  }

  function loadEvents(mode) {
    var before = mode === 'more' && S.events && S.events.length ? '&before=' + encodeURIComponent(S.events[S.events.length - 1].at) : '';
    if (!mode) { S.events = null; renderEvents(); }
    S.api('/my-store/events?limit=50&type=' + S.eventType + before).then(function (r) {
      if (!r.ok || !r.data.success) { if (mode !== 'poll') { S.events = { error: 'Could not load events.' }; } return; }
      if (mode === 'more') { S.events = S.events.concat(r.data.events); S.eventsDone = r.data.events.length < 50; }
      else if (mode === 'poll') {
        if (!Array.isArray(S.events)) S.events = [];
        var seen = {}; S.events.forEach(function (e) { seen[e.type + e.at + e.subscriber] = 1; });
        var fresh = r.data.events.filter(function (e) { return !seen[e.type + e.at + e.subscriber]; });
        if (!fresh.length) return;
        S.events = fresh.concat(S.events).slice(0, 300);
      } else { S.events = r.data.events; S.eventsDone = r.data.events.length < 50; }
    }).then(function () { if (S.tab === 'events') renderEvents(); });
  }

  function startLive() {
    stopLive();
    if (!S.live || S.tab !== 'events') return;
    S.timer = setInterval(function () {
      if (!document.hidden && S.el && document.body.contains(S.el) && S.tab === 'events') loadEvents('poll');
      else if (!S.el || !document.body.contains(S.el) || S.el.closest('.hidden')) stopLive();
    }, 15000);
  }

  // ------------------------------------------------------------- routing
  function show(tab) {
    S.tab = tab;
    destroyCharts();
    stopLive();
    if (tab === 'overview') { if (S.data && !S.data.error && S.data.days === S.days) renderOverview(); else loadOverview(); }
    else if (tab === 'carts') loadCarts(false);
    else { loadEvents(); startLive(); }
  }

  function onClick(ev) {
    var t = ev.target.closest('[data-act]');
    if (!t || !S.el.contains(t)) return;
    var act = t.getAttribute('data-act');
    if (act === 'tab') show(t.getAttribute('data-tab'));
    else if (act === 'days') { S.days = Number(t.getAttribute('data-days')); S.data = null; loadOverview(); }
    else if (act === 'cartfilter') { S.cartFilter = t.getAttribute('data-f'); loadCarts(false); }
    else if (act === 'morecarts') loadCarts(true);
    else if (act === 'moreevents') loadEvents('more');
    else if (act === 'retry') show(S.tab);
  }
  function onChange(ev) {
    var t = ev.target;
    var act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'etype') { S.eventType = t.value; loadEvents(); }
    if (act === 'live') { S.live = t.checked; renderEvents(); startLive(); if (S.live) loadEvents('poll'); }
  }

  window.RetnerAnalytics = {
    mount: function (el, opts) {
      if (!el) return;
      if (S.el !== el) { S.el = el; el.addEventListener('click', onClick); el.addEventListener('change', onChange); }
      S.api = opts.api;
      S.data = null;
      show(opts.tab || S.tab || 'overview');
    },
    stop: function () { stopLive(); destroyCharts(); },
  };
})();
