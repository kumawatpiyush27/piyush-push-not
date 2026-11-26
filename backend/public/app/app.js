/* Retner SmartPush dashboard (served at /store-admin).
 * Views: home, campaigns, creator, subscribers, analytics, automations,
 * settings. Reuses RetnerAnalytics, RetnerAutomations, RetnerMedia,
 * RetnerPreview and RetnerCampaigns from /js. */
(function () {
  'use strict';

  // ------------------------------------------------------------ helpers
  var $ = function (id) { return document.getElementById(id); };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function money(n, cur) {
    try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: cur || 'INR', maximumFractionDigits: 0 }).format(Number(n) || 0); }
    catch (e) { return '₹' + num(Math.round(Number(n) || 0)); }
  }
  function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function ago(iso) {
    if (!iso) return '—';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  }
  function dateShort(iso) { return iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
  function tz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; } }
  var toastTimer;
  function toast(text, kind) {
    var old = document.querySelector('.toast'); if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.innerHTML = '<i class="fas ' + (kind === 'err' ? 'fa-circle-exclamation' : kind === 'ok' ? 'fa-circle-check' : 'fa-circle-info') + '"></i><span></span>';
    el.querySelector('span').textContent = text;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, kind === 'err' ? 7000 : 4000);
  }

  // ------------------------------------------------------------ session
  window.store = null;
  var injected = window.__RETNER_STORE__ || null;
  if (injected) {
    window.store = injected;
    try { localStorage.setItem('store', JSON.stringify(injected)); } catch (e) { /* private mode */ }
    if (window.history.replaceState) window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
  } else {
    try { window.store = JSON.parse(localStorage.getItem('store') || 'null'); } catch (e) { window.store = null; }
    if (window.store && !window.store.token) window.store = null;
  }

  function sessionExpired() {
    try { localStorage.removeItem('store'); } catch (e) { /* ignore */ }
    window.store = null;
    $('app').classList.remove('on');
    $('login').classList.remove('hidden');
  }
  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('/my-store/') === 0 && window.store && window.store.token) {
      init = Object.assign({}, init || {});
      init.headers = Object.assign({}, init.headers || {}, { Authorization: 'Bearer ' + window.store.token });
      return nativeFetch(input, init).then(function (r) { if (r.status === 401) sessionExpired(); return r; });
    }
    return nativeFetch(input, init);
  };
  function api(path, options) {
    var opts = Object.assign({}, options || {});
    if (opts.body && typeof opts.body !== 'string') {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    }
    return window.fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) { return { ok: res.ok, status: res.status, data: data || {} }; });
    }).catch(function () { return { ok: false, status: 0, data: { error: 'Could not reach the server. Check your connection.' } }; });
  }

  // ------------------------------------------------------------ router
  var VIEWS = ['home', 'campaigns', 'creator', 'subscribers', 'segments', 'analytics', 'automations', 'plan', 'settings'];
  var ALIAS = { dashboard: 'home', campaign: 'creator', history: 'campaigns', 'automation-editor': 'automations', audiences: 'segments', upgrade: 'plan', billing: 'plan', usage: 'plan' };
  var current = null;
  var loaders = {};
  function showView(name, opts) {
    name = ALIAS[name] || name;
    if (VIEWS.indexOf(name) === -1) name = 'home';
    if (current === 'analytics' && name !== 'analytics' && window.RetnerAnalytics) window.RetnerAnalytics.stop();
    VIEWS.forEach(function (v) { $('view-' + v).classList.toggle('on', v === name); });
    document.querySelectorAll('[data-view]').forEach(function (b) {
      var v = b.getAttribute('data-view');
      b.classList.toggle('active', v === name || (name === 'creator' && v === 'campaigns' && b.closest('.nav, .rail')));
    });
    current = name;
    if (!(opts && opts.silent) && window.location.hash !== '#' + name) window.history.pushState({ view: name }, '', '#' + name);
    var mainEl = document.querySelector(".main"); if (mainEl) mainEl.scrollTop = 0; window.scrollTo({ top: 0 });
    if (loaders[name]) loaders[name]();
  }
  window.addEventListener('popstate', function () { var h = window.location.hash.replace('#', ''); if (h) showView(h, { silent: true }); });
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-view]') : null;
    if (b && !b.closest('#rpPreview')) { e.preventDefault(); showView(b.getAttribute('data-view')); }
  });

  // ------------------------------------------------------------ login
  $('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var btn = $('loginBtn'); btn.disabled = true; btn.textContent = 'Signing in…';
    $('loginError').classList.add('hidden');
    api('/store-login', { method: 'POST', body: { storeId: $('storeId').value.trim(), password: $('password').value } }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Sign in';
      if (r.ok && r.data.success) {
        window.store = r.data.store;
        try { localStorage.setItem('store', JSON.stringify(window.store)); } catch (err) { /* ignore */ }
        initApp();
      } else {
        $('loginError').textContent = r.data.error || 'Could not sign in. Check your store ID and password.';
        $('loginError').classList.remove('hidden');
      }
    });
  });
  $('logoutBtn').addEventListener('click', function () { sessionExpired(); window.location.hash = ''; });
  $('helpBtn').addEventListener('click', function () { openGuide(); });
  $('guideBtn').addEventListener('click', function () { openGuide(); });
  $('bellBtn').addEventListener('click', function () { toast(bellText || 'No new alerts. Campaigns, automations and subscriber updates will show here.'); });
  var bellText = '';

  // ------------------------------------------------------------ init
  function greeting() {
    var h = new Date().getHours();
    var part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    $('greeting').textContent = part + ', ' + (window.store.name || window.store.id);
  }
  function initApp() {
    $('login').classList.add('hidden');
    $('app').classList.add('on');
    greeting();
    $('avatar').textContent = String(window.store.name || window.store.id || 'R').charAt(0).toUpperCase();
    $('avatar').title = window.store.name || window.store.id;
    if (window.RetnerMedia) window.RetnerMedia.attachAll(document);
    initCreator();
    // The saved session may carry an old store name; use the current one.
    api('/my-store/details').then(function (r) {
      var n = r.ok && r.data.success && r.data.store && r.data.store.store_name;
      if (n && n !== window.store.name) {
        window.store.name = n;
        try { localStorage.setItem('store', JSON.stringify(window.store)); } catch (e) { /* ignore */ }
        greeting(); $('avatar').textContent = n.charAt(0).toUpperCase(); $('avatar').title = n;
      }
    });
    loadEntitlements().then(function () { if (current === 'segments') applySegmentLock(); if (current === 'creator') renderSegments(); showPrompts(); });
    var params = new URLSearchParams(window.location.search);
    var q = params.get('view');
    // ?segment=key (from the Shopify app's Segments page) preselects the audience.
    if (params.get('segment')) pendingSegment = params.get('segment');
    var h = window.location.hash.replace('#', '');
    showView(q || h || 'home', { silent: !!h });
  }

  // ------------------------------------------------------------ home
  var homeDays = 30, homeMetric = 'sent', homeData = null, homeChart = null;
  function trend(id, t, fallback) {
    var el = $(id); if (!el) return;
    el.className = 'k-trend';
    if (!t || t.change === null || t.change === undefined || (!t.value && !t.previous)) { el.textContent = fallback || ''; return; }
    if (!t.change) { el.textContent = '0%'; return; }
    el.classList.add(t.change > 0 ? 'up' : 'down');
    el.textContent = (t.change > 0 ? '+' : '') + t.change + '%';
  }
  loaders.home = function () { loadHome(); };
  function loadHome() {
    Promise.all([api('/my-store/stats'), api('/my-store/analytics?days=' + homeDays + '&tz=' + encodeURIComponent(tz())), api('/my-store/usage')]).then(function (rs) {
      document.querySelectorAll('#view-home .skel').forEach(function (el) { el.classList.remove('skel'); });
      var stats = rs[0].ok ? rs[0].data : {};
      var a = rs[1].ok && rs[1].data.success ? rs[1].data : null;
      homeData = a;
      var vs = 'vs previous ' + homeDays + ' days';
      if (a) {
        var t = a.totals;
        $('k-subs').textContent = num(a.subscribers.active); trend('k-subs-t', null, ''); $('k-subs-f').textContent = t.subscribers.value ? '+' + num(t.subscribers.value) + ' new in ' + homeDays + ' days' : 'No new subscribers in ' + homeDays + ' days';
        $('k-sent').textContent = num(t.sent.value); trend('k-sent-t', t.sent, ''); $('k-sent-f').textContent = vs;
        $('k-clicks').textContent = num(t.clicks.value); trend('k-clicks-t', t.clicks, ''); $('k-clicks-f').textContent = t.ctr.value + '% click rate · ' + vs;
        $('k-rev').textContent = money(t.revenue.value); trend('k-rev-t', t.revenue, ''); $('k-rev-f').textContent = num(t.orders.value) + ' orders · ' + vs;
      } else {
        ['k-subs', 'k-sent', 'k-clicks', 'k-rev'].forEach(function (id) { $(id).textContent = '—'; });
        $('k-subs-f').textContent = 'Could not load. Refresh to try again.';
      }
      drawHomeChart();
      var u = rs[2].ok ? (rs[2].data.usage || rs[2].data) : null;
      if (rs[2].ok && rs[2].data.entitlements) ent = rs[2].data.entitlements;
      if (u && u.limit !== undefined) {
        var pct = Math.min(100, Number(u.percent) || 0);
        var tr = u.trial || (ent && ent.trial);
        var onTrial = !!(tr && tr.active);
        $('planTrialChip').classList.toggle('hidden', !onTrial);
        if (onTrial) $('planTrialChip').textContent = 'Free trial · ' + tr.days_left + ' day' + (tr.days_left === 1 ? '' : 's') + ' left';
        $('planName').textContent = onTrial ? 'Unlimited (trial)' : (u.plan && u.plan.name ? u.plan.name : 'Free') + ' plan';
        if (onTrial) $('planText').textContent = num(u.used) + ' impressions this month · unlimited until ' + dateShort(tr.ends_at);
        else if (u.unlimited || u.limit === null) $('planText').textContent = num(u.used) + ' impressions this month · no cap';
        else $('planText').textContent = num(u.used) + ' of ' + num(u.limit) + ' impressions used this month';
        $('planBar').className = 'bar' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
        $('planBar').firstElementChild.style.width = pct + '%';
        $('planFoot').textContent = (u.limit === null || onTrial) ? (onTrial ? 'Segments and every feature unlocked during the trial' : 'Unlimited impressions') : ((u.resets_on ? 'Resets on ' + new Date(u.resets_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' : '') + num(u.remaining) + ' left');
        $('planBtn').innerHTML = onTrial ? '<i class="fas fa-bolt"></i> See plans' : '<i class="fas fa-bolt"></i> Upgrade plan';
        bellText = pct >= 80 && !onTrial && u.limit !== null ? 'You have used ' + pct + '% of this month\'s impressions.' : '';
        $('bellDot').classList.toggle('hidden', !bellText);
      } else {
        $('planText').textContent = 'Your monthly notification allowance appears here.';
        $('planFoot').textContent = '';
      }
      var recent = (stats && stats.recentCampaigns) || [];
      $('recentList').innerHTML = recent.length ? recent.slice(0, 5).map(function (c) {
        var badge = (c.status && c.status !== 'sent' && window.RetnerCampaigns) ? window.RetnerCampaigns.statusBadge(c) : '<span class="chip info">' + num(c.sent_count) + ' sent</span>';
        return '<li><span class="k-ic" style="width:34px;height:34px;border-radius:10px;background:var(--primary-soft);color:var(--primary);display:inline-flex;align-items:center;justify-content:center;"><i class="fas ' + (c.type === 'flash' ? 'fa-bolt' : 'fa-bullhorn') + '"></i></span>' +
          '<div class="t"><b>' + esc(c.title) + '</b><span>' + esc(dateShort(c.created_at)) + '</span></div>' + badge + '</li>';
      }).join('') : '<li><div class="empty" style="width:100%"><i class="fas fa-bullhorn"></i><b>No campaigns yet</b>Send your first notification in a few clicks.</div></li>';
    });
  }
  function drawHomeChart() {
    if (homeChart) { try { homeChart.destroy(); } catch (e) { /* ignore */ } homeChart = null; }
    if (!homeData || typeof Chart === 'undefined') { $('chartTotal').textContent = '—'; return; }
    var rows = homeData.series;
    var vals = rows.map(function (r) { return Number(r[homeMetric]) || 0; });
    var total = vals.reduce(function (s, v) { return s + v; }, 0);
    var max = Math.max.apply(null, vals.concat([0]));
    $('chartTotal').textContent = num(total) + ' ' + { sent: 'sent', clicks: 'clicks', subscribers: 'new subscribers' }[homeMetric];
    var labels = rows.map(function (r) { return new Date(r.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); });
    homeChart = new Chart($('homeChart'), {
      type: 'bar',
      data: { labels: labels, datasets: [{ data: vals, backgroundColor: vals.map(function (v) { return v === max && max > 0 ? '#2563eb' : '#e8ecf3'; }), hoverBackgroundColor: '#2563eb', borderRadius: 8, borderSkipped: false, maxBarThickness: 26 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#111827', padding: 10, displayColors: false, callbacks: { label: function (c) { return num(c.raw); } } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: homeDays > 30 ? 8 : 12, color: '#6b7280' } }, y: { beginAtZero: true, grid: { color: '#f1f3f6' }, ticks: { precision: 0, color: '#6b7280' }, border: { display: false } } } }
    });
  }
  $('homeRange').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    homeDays = Number(b.getAttribute('data-days'));
    $('homeRange').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    loadHome();
  });
  $('chartMetric').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    homeMetric = b.getAttribute('data-m');
    $('chartMetric').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    drawHomeChart();
  });
  $('planBtn').addEventListener('click', function () { showView('plan'); });

  // ------------------------------------------------------------ campaigns (history)
  var histFilter = 'all';
  loaders.campaigns = function () { loadCampaignHistory(); };
  function loadCampaignHistory() {
    api('/my-store/campaigns').then(function (r) {
      var list = (r.ok && r.data.campaigns) || [];
      window.allCampaigns = list;
      var delivered = list.filter(function (c) { return !window.RetnerCampaigns || window.RetnerCampaigns.isDelivered(c); });
      var imp = 0, clicks = 0, rev = 0;
      delivered.forEach(function (c) { imp += Number(c.sent_count) || 0; clicks += Number(c.clicks) || 0; rev += Number(c.revenue) || 0; });
      $('h-camp').textContent = num(delivered.length);
      $('h-imp').textContent = num(imp);
      $('h-ctr').textContent = (imp ? Math.round((clicks / imp) * 1000) / 10 : 0) + '%';
      $('h-rev').textContent = money(rev);
      $('count-sent').textContent = delivered.length;
      $('count-scheduled').textContent = list.filter(function (c) { return c.status === 'scheduled'; }).length;
      renderHistory();
    });
  }
  window.loadCampaignHistory = loadCampaignHistory;
  function renderHistory() {
    var list = window.allCampaigns || [];
    var rows = histFilter === 'all' ? list : histFilter === 'scheduled' ? list.filter(function (c) { return c.status === 'scheduled'; }) : list.filter(function (c) { return !window.RetnerCampaigns || window.RetnerCampaigns.isDelivered(c); });
    $('historyTableBody').innerHTML = rows.length
      ? rows.map(function (c) { return window.RetnerCampaigns ? window.RetnerCampaigns.historyRow(c) : '<tr><td colspan="6">' + esc(c.title) + '</td></tr>'; }).join('')
      : '<tr><td colspan="6"><div class="empty"><i class="fas fa-bullhorn"></i><b>Nothing here yet</b>' + (histFilter === 'all' ? 'Create your first campaign to reach every subscriber.' : 'No campaigns match this filter.') + '</div></td></tr>';
  }
  $('histTabs').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    histFilter = b.getAttribute('data-f');
    $('histTabs').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderHistory();
  });
  $('processBtn').addEventListener('click', function () {
    var b = $('processBtn'); b.disabled = true;
    api('/my-store/run-automations', { method: 'POST' }).then(function (r) {
      b.disabled = false;
      if (!r.ok || !r.data.success) return toast(r.data.error || 'Could not run now.', 'err');
      var s = r.data.summary || {};
      toast('Done: ' + num(s.scheduledCampaigns) + ' scheduled campaigns and ' + num((s.abandoned || 0) + (s.browse || 0) + (s.winback || 0) + (s.welcome || 0)) + ' automation notifications sent. This also runs every 5 minutes.', 'ok');
      loadCampaignHistory();
    });
  });

  // ------------------------------------------------------------ creator
  var TEMPLATES = [
    { name: '⚡ Flash sale', type: 'flash', title: '⚡ Flash sale: 30% off today only', msg: 'Our biggest prices of the season end tonight. Grab your favourites before they are gone!', btn: 'Shop the sale' },
    { name: '🆕 New arrival', type: 'regular', title: 'Just landed: new arrivals 🆕', msg: 'Fresh styles are in. Be the first to see what is new this week.', btn: 'See new arrivals' },
    { name: '📦 Back in stock', type: 'regular', title: 'It is back in stock 📦', msg: 'The product you were waiting for is available again. It sold out fast last time.', btn: 'Buy now' },
    { name: '🚚 Free shipping', type: 'regular', title: 'Free shipping this weekend 🚚', msg: 'No minimum order. Add what you love and we cover the delivery.', btn: 'Start shopping' },
    { name: '🎉 Weekend offer', type: 'regular', title: 'Weekend treat inside 🎉', msg: 'Use the code below for an extra discount on your next order. Valid till Sunday.', btn: 'Claim offer' },
    { name: '💙 Thank you', type: 'regular', title: 'Thank you for being with us 💙', msg: 'A small gift for our community: an exclusive code for your next purchase.', btn: 'Redeem gift' },
  ];
  var EMOJIS = ['🎉', '🔥', '⚡', '🆕', '🎁', '💥', '🛍️', '🛒', '💙', '❤️', '✨', '⭐', '🚚', '📦', '⏰', '🏷️', '💸', '🤑', '👀', '👉', '✅', '🙌', '😍', '🥳', '🎊', '🍫', '☕', '💪', '🏃', '👗', '👟', '💄', '🎧', '📱', '🏠', '🌟', '🙏', '😊', '🤩', '💯'];
  var cType = 'regular', scheduleMode = 'now', btnCount = 0, creatorReady = false;

  function initCreator() {
    if (creatorReady) return; creatorReady = true;
    $('tplRow').innerHTML = TEMPLATES.map(function (t, i) { return '<button type="button" class="tpl" data-tpl="' + i + '">' + esc(t.name) + '</button>'; }).join('');
    $('tplRow').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tpl]'); if (!b) return;
      var t = TEMPLATES[Number(b.getAttribute('data-tpl'))];
      $('campTitle').value = t.title; $('campMsg').value = t.msg;
      setType(t.type);
      if (!btnCount) addBtnRow(); $('btn1Txt').value = t.btn;
      counters(); preview();
      toast('Template applied. Edit the text and add your link.');
    });
    document.querySelectorAll('#view-creator .cr-type .pick[data-type]').forEach(function (p) { p.addEventListener('click', function () { setType(p.getAttribute('data-type')); }); });
    $('sel-now').addEventListener('click', function () { setSchedule('now'); });
    $('sel-later').addEventListener('click', function () { setSchedule('later'); });
    ['campTitle', 'campMsg'].forEach(function (id) { $(id).addEventListener('input', function () { counters(); preview(); }); });
    ['campImg', 'campIcon'].forEach(function (id) { $(id).addEventListener('input', preview); $(id).addEventListener('change', preview); });
    $('addBtnRow').addEventListener('click', function () { addBtnRow(); });
    $('btnRows').addEventListener('click', function (e) { var x = e.target.closest('[data-remove]'); if (x) removeBtnRow(Number(x.getAttribute('data-remove'))); });
    document.querySelectorAll('[data-emoji-for]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); openEmoji(b, b.getAttribute('data-emoji-for')); }); });
    document.addEventListener('click', function (e) { var pop = document.querySelector('.emoji-pop'); if (pop && !pop.contains(e.target)) pop.remove(); });
    $('discountLink').href = 'https://admin.shopify.com/store/' + encodeURIComponent(window.store.id) + '/discounts';
    $('segGrid').addEventListener('click', function (e) {
      var c = e.target.closest('[data-seg]'); if (!c) return;
      if (c.classList.contains('locked')) { showUpgradeModal('segments'); return; }
      segment = c.getAttribute('data-seg'); renderSegments();
    });
    $('segGrid').addEventListener('keydown', function (e) {
      var c = e.target.closest ? e.target.closest('[data-seg]') : null;
      if (c && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); segment = c.getAttribute('data-seg'); renderSegments(); }
    });
    $('btnSend').addEventListener('click', sendCampaign);
    $('testBtn').addEventListener('click', sendTest);
    counters();
  }
  // pendingSegment: audience chosen on the Segments page (or ?segment=) that the
  // creator should preselect the next time it opens.
  var segments = [], segment = 'all', pendingSegment = null;
  loaders.creator = function () {
    if (pendingSegment) { segment = pendingSegment; pendingSegment = null; }
    loadSegments();
    if (window.RetnerCampaigns) window.RetnerCampaigns.onScheduleMode(scheduleMode);
    preview();
  };
  function loadSegments() {
    api('/my-store/segments').then(function (r) {
      if (!r.ok || !r.data.success) { $('segGrid').innerHTML = '<div class="muted">Could not load audiences. Everyone will receive this campaign.</div>'; return; }
      segments = r.data.segments;
      if (!segments.some(function (s) { return s.key === segment; })) segment = 'all';
      renderSegments();
    });
  }
  var SEG_ICONS = { all: 'fa-users', active_7d: 'fa-bolt', active_30d: 'fa-calendar', new_7d: 'fa-user-plus', inactive_30d: 'fa-moon', cart_30d: 'fa-cart-shopping', buyers_30d: 'fa-bag-shopping', chrome: 'fab fa-chrome', safari: 'fab fa-safari', firefox: 'fab fa-firefox-browser', edge: 'fab fa-edge' };
  function segIcon(key) { var ic = SEG_ICONS[key] || 'fa-users'; return ic.indexOf('fab') === 0 ? ic : 'fas ' + ic; }
  function renderSegments() {
    var locked = segmentsLocked();
    if (locked && segment !== 'all') segment = 'all';
    $('segGrid').innerHTML = segments.map(function (s) {
      var isLocked = locked && s.key !== 'all';
      return '<div class="seg-card' + (s.key === segment ? ' active' : '') + (s.count ? '' : ' empty') + (isLocked ? ' locked' : '') + '" data-seg="' + esc(s.key) + '" role="radio" aria-checked="' + (s.key === segment) + '" tabindex="0"' + (isLocked ? ' title="Upgrade to target this segment"' : '') + '>' +
        '<span class="ic"><i class="' + (isLocked ? 'fas fa-lock' : segIcon(s.key)) + '"></i></span><div><b>' + esc(s.name) + '</b>' + (s.desc ? '<span>' + esc(s.desc) + '</span>' : '') + '</div><em>' + num(s.count) + '</em></div>';
    }).join('') + (locked ? '<div class="seg-lock-note"><span><i class="fas fa-lock"></i> Targeted audiences are part of the Growth and Unlimited plans. Free sends to all subscribers.</span><button class="btn sm primary" type="button" data-unlock-plan><i class="fas fa-bolt"></i> Unlock your plan</button></div>' : '');
    updateReach();
  }
  function updateReach() {
    var s = segments.filter(function (x) { return x.key === segment; })[0];
    $('estReach').textContent = s ? num(s.count) : '…';
    $('segName').textContent = s ? s.name : 'All subscribers';
  }
  function preview() { if (window.RetnerPreview) window.RetnerPreview.render(); }
  function counters() {
    var t = $('campTitle').value.length, m = $('campMsg').value.length;
    $('titleCount').textContent = t + ' / 50' + (t > 50 ? ' · may be cut off on some devices' : '');
    $('titleCount').classList.toggle('over', t > 50);
    $('msgCount').textContent = m + ' / 120' + (m > 120 ? ' · ' + (m - 120) + ' characters over, some text may not be visible' : '');
    $('msgCount').classList.toggle('over', m > 120);
  }
  function setType(type) {
    cType = type === 'flash' ? 'flash' : 'regular';
    document.querySelectorAll('#view-creator .pick[data-type]').forEach(function (p) { p.classList.toggle('active', p.getAttribute('data-type') === cType); });
    $('expiryCard').classList.toggle('hidden', cType !== 'flash');
    if (window.RetnerCampaigns) window.RetnerCampaigns.showError('');
  }
  function setSchedule(mode) {
    scheduleMode = mode;
    $('sel-now').classList.toggle('active', mode === 'now');
    $('sel-later').classList.toggle('active', mode === 'later');
    $('scheduleTimeWrapper').classList.toggle('hidden', mode !== 'later');
    if (window.RetnerCampaigns) { window.RetnerCampaigns.onScheduleMode(mode); window.RetnerCampaigns.updateSendLabel(mode); }
  }
  function addBtnRow() {
    if (btnCount >= 2) return toast('Notifications can have at most 2 buttons.');
    btnCount++;
    var n = btnCount;
    var row = document.createElement('div');
    row.className = 'btn-row'; row.setAttribute('data-row', n);
    row.innerHTML = '<input class="input" id="btn' + n + 'Txt" maxlength="24" placeholder="Button text, e.g. Shop now">' +
      '<input class="input" id="btn' + n + 'Link" placeholder="Link (optional, uses the primary link)">' +
      '<button type="button" class="x" data-remove="' + n + '" aria-label="Remove button"><i class="fas fa-xmark"></i></button>';
    $('btnRows').appendChild(row);
    $('addBtnRow').classList.toggle('hidden', btnCount >= 2);
    $('btn' + n + 'Txt').focus();
  }
  function removeBtnRow(n) {
    var rows = Array.prototype.slice.call($('btnRows').querySelectorAll('.btn-row'));
    var vals = rows.map(function (r) { return { t: r.querySelector('input').value, l: r.querySelectorAll('input')[1].value, n: Number(r.getAttribute('data-row')) }; }).filter(function (v) { return v.n !== n; });
    $('btnRows').innerHTML = ''; btnCount = 0;
    vals.forEach(function (v) { addBtnRow(); $('btn' + btnCount + 'Txt').value = v.t; $('btn' + btnCount + 'Link').value = v.l; });
    $('addBtnRow').classList.toggle('hidden', btnCount >= 2);
    preview();
  }
  function openEmoji(anchor, targetId) {
    var old = document.querySelector('.emoji-pop'); if (old) old.remove();
    var pop = document.createElement('div');
    pop.className = 'emoji-pop';
    pop.innerHTML = EMOJIS.map(function (e) { return '<button type="button">' + e + '</button>'; }).join('');
    anchor.parentNode.parentNode.appendChild(pop);
    pop.style.right = '0'; pop.style.top = (anchor.offsetTop + anchor.offsetHeight + 6) + 'px';
    pop.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var input = $(targetId), s = input.selectionStart || input.value.length, v = input.value;
      input.value = v.slice(0, s) + b.textContent + v.slice(input.selectionEnd || s);
      input.focus(); input.setSelectionRange(s + b.textContent.length, s + b.textContent.length);
      counters(); preview(); pop.remove();
    });
  }
  function val(id) { var el = $(id); return el ? el.value.trim() : ''; }
  function messageWithCode(msg, code) {
    if (!code) return msg;
    return msg.toLowerCase().indexOf(code.toLowerCase()) !== -1 ? msg : (msg + ' Use code ' + code).trim();
  }
  function validateContent() {
    if (!val('campTitle')) return 'Add a title.';
    if (!val('campMsg')) return 'Add a message.';
    if (!val('campUrl')) return 'Add the primary link shoppers should open.';
    if (val('btn1Txt') === '' && val('btn1Link')) return 'Button 1 needs a text.';
    if (val('btn2Txt') === '' && val('btn2Link')) return 'Button 2 needs a text.';
    return '';
  }
  function campaignBody() {
    var code = val('campDiscount').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
    return {
      title: val('campTitle'), message: messageWithCode(val('campMsg'), code), url: val('campUrl'),
      image: val('campImg'), icon: val('campIcon'), type: cType, schedule: scheduleMode, segment: segment,
      scheduledAt: scheduleMode === 'later' && val('scheduleTime') ? new Date(val('scheduleTime')).toISOString() : null,
      expiryAt: cType === 'flash' && val('expiryTime') ? new Date(val('expiryTime')).toISOString() : null,
      btn1Text: val('btn1Txt'), btn1UrlRaw: val('btn1Link'), btn2Text: val('btn2Txt'), btn2UrlRaw: val('btn2Link'),
    };
  }
  function sendCampaign() {
    var err = validateContent();
    if (err) { toast(err, 'err'); return; }
    if (window.RetnerCampaigns && window.RetnerCampaigns.validateStep3(scheduleMode, cType)) return;
    var reach = $('estReach').textContent;
    var when = scheduleMode === 'later' && window.RetnerCampaigns ? window.RetnerCampaigns.describeSchedule(scheduleMode) : 'now';
    if (reach === '0') { toast('This audience has no subscribers right now. Pick another audience.', 'err'); return; }
    if (!window.confirm((scheduleMode === 'later' ? 'Schedule this campaign for ' + when : 'Send this campaign now') + ' to ' + reach + ' subscribers (' + $('segName').textContent + ')?')) return;
    var btn = $('btnSend'); btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> ' + (scheduleMode === 'later' ? 'Scheduling…' : 'Sending…');
    api('/my-store/broadcast', { method: 'POST', body: campaignBody() }).then(function (r) {
      btn.disabled = false;
      if (window.RetnerCampaigns) window.RetnerCampaigns.updateSendLabel(scheduleMode);
      if (!r.ok || !r.data.success) return toast('Could not ' + (scheduleMode === 'later' ? 'schedule' : 'send') + ': ' + (r.data.error || 'unknown error'), 'err');
      toast(window.RetnerCampaigns ? window.RetnerCampaigns.resultMessage(r.data) : 'Done.', 'ok');
      resetCreator();
      showView('campaigns');
    });
  }
  function sendTest() {
    var err = validateContent();
    if (err) { toast(err, 'err'); return; }
    if (!window.RetnerAutomations || !window.RetnerAutomations.testSubscription) return toast('Test sending is not available in this browser.', 'err');
    var btn = $('testBtn'); btn.disabled = true;
    window.RetnerAutomations.testSubscription().then(function (sub) {
      return api('/my-store/campaign-test', { method: 'POST', body: Object.assign(campaignBody(), { subscription: sub }) });
    }).then(function (r) {
      btn.disabled = false;
      if (!r.ok || !r.data.success) return toast(r.data.error || 'Could not send the test.', 'err');
      toast('Test sent to this browser. It appears in a moment (check the notification centre if it does not pop up).', 'ok');
    }).catch(function (e) { btn.disabled = false; toast(e.message || 'Could not send the test.', 'err'); });
  }
  function resetCreator() {
    ['campTitle', 'campMsg', 'campUrl', 'campDiscount', 'scheduleTime', 'expiryTime'].forEach(function (id) { $(id).value = ''; });
    ['campImg', 'campIcon'].forEach(function (id) { var el = $(id); el.value = ''; if (el.__rm) el.__rm.setValue(''); });
    $('btnRows').innerHTML = ''; btnCount = 0; $('addBtnRow').classList.remove('hidden');
    segment = 'all'; renderSegments();
    setType('regular'); setSchedule('now'); counters(); preview();
  }

  // ------------------------------------------------------------ subscribers
  var subDays = 30, subChart = null;
  loaders.subscribers = function () { loadSubscribers(); };
  function loadSubscribers() {
    Promise.all([api('/my-store/subscribers'), api('/my-store/analytics?days=' + subDays + '&tz=' + encodeURIComponent(tz()))]).then(function (rs) {
      document.querySelectorAll('#view-subscribers .skel').forEach(function (el) { el.classList.remove('skel'); });
      var d = rs[0].ok ? rs[0].data : { subscribers: [] };
      var b = d.breakdown || {};
      var a = rs[1].ok && rs[1].data.success ? rs[1].data : null;
      $('s-total').textContent = num(b.active !== undefined ? b.active : d.total);
      $('s-total-f').textContent = b.all_time ? num(b.all_time) + ' all time' : '';
      $('s-gain').textContent = '+' + num(b.gain_7d);
      var g = $('s-gain-t'); g.className = 'k-trend';
      if (b.gain_prev_7d) { var ch = Math.round(((b.gain_7d - b.gain_prev_7d) / b.gain_prev_7d) * 100); g.classList.add(ch >= 0 ? 'up' : 'down'); g.textContent = (ch > 0 ? '+' : '') + ch + '%'; }
      $('s-gain-f').textContent = 'vs ' + num(b.gain_prev_7d) + ' the week before';
      $('s-active').textContent = num(b.active_7d);
      $('s-lost').textContent = num(b.expired);
      var segs = [
        ['fab fa-chrome', 'Chrome', b.chrome], ['fab fa-firefox-browser', 'Firefox', b.firefox], ['fab fa-safari', 'Safari / iPhone', b.apple], ['fab fa-edge', 'Edge', b.edge], ['fas fa-globe', 'Other browsers', b.other],
        ['fas fa-bolt', 'Active in the last 7 days', b.active_7d], ['fas fa-calendar', 'Active in the last 30 days', b.active_30d], ['fas fa-cart-shopping', 'Added to cart in 30 days', b.carts_30d], ['fas fa-bag-shopping', 'Bought in the last 30 days', b.buyers_30d],
      ];
      var total = Math.max(1, Number(b.active) || Number(d.total) || 1);
      $('segList').innerHTML = segs.map(function (s) {
        var n = Number(s[2]) || 0;
        return '<li><span class="ic"><i class="' + s[0] + '"></i></span><div><div>' + esc(s[1]) + '</div><div class="bar"><span style="width:' + Math.min(100, Math.round((n / total) * 100)) + '%"></span></div></div><b>' + num(n) + '</b></li>';
      }).join('');
      var rows = d.subscribers || [];
      $('subscribersTableBody').innerHTML = rows.length ? rows.map(function (s, i) {
        var exp = s.status === 'expired';
        return '<tr><td>' + esc(dateShort(s.createdAt)) + '</td><td class="strong">Subscriber #' + esc(s.id || (i + 1)) + '</td><td>' + esc(s.browser || '—') + '</td><td>' + esc(ago(s.lastSeen)) + '</td><td><span class="chip ' + (exp ? '' : 'ok') + '">' + (exp ? 'Unsubscribed' : 'Active') + '</span></td></tr>';
      }).join('') : '<tr><td colspan="5"><div class="empty"><i class="fas fa-users"></i><b>No subscribers yet</b>They appear here as soon as shoppers allow notifications on your store.</div></td></tr>';
      $('subListNote').textContent = d.total > rows.length ? 'Latest ' + num(rows.length) + ' of ' + num(d.total) : num(rows.length) + ' total';
      $('subRangeText').textContent = 'Last ' + subDays + ' days' + (a ? ' · +' + num(a.totals.subscribers.value) + ' new' : '');
      if (subChart) { try { subChart.destroy(); } catch (e) { /* ignore */ } subChart = null; }
      if (a && typeof Chart !== 'undefined') {
        var labels = a.series.map(function (r) { return new Date(r.day + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); });
        var daily = a.series.map(function (r) { return Number(r.subscribers) || 0; });
        var cum = []; daily.reduce(function (s, v) { cum.push(s + v); return s + v; }, 0);
        subChart = new Chart($('subChart'), { data: { labels: labels, datasets: [
          { type: 'bar', label: 'New subscribers', data: daily, backgroundColor: '#bfdbfe', borderRadius: 6, maxBarThickness: 22, yAxisID: 'y' },
          { type: 'line', label: 'Growth in period', data: cum, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,.08)', fill: true, tension: .35, pointRadius: 0, yAxisID: 'y1' } ] },
          options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } } },
            scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10, color: '#6b7280' } }, y: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: '#f1f3f6' } }, y1: { position: 'right', beginAtZero: true, ticks: { precision: 0 }, grid: { display: false } } } } });
      }
    });
  }
  $('subRange').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    subDays = Number(b.getAttribute('data-days'));
    $('subRange').querySelectorAll('button').forEach(function (x) { x.classList.toggle('active', x === b); });
    loadSubscribers();
  });

  // ------------------------------------------------------------ segments page
  var BROWSER_SEGS = { chrome: 1, safari: 1, firefox: 1, edge: 1 };
  loaders.segments = function () { loadSegmentsPage(); };
  function loadSegmentsPage() {
    api('/my-store/segments').then(function (r) {
      document.querySelectorAll('#view-segments .skel').forEach(function (el) { el.classList.remove('skel'); });
      if (!r.ok || !r.data.success) {
        $('segBehaviour').innerHTML = '<div class="muted">Could not load segments. Refresh to try again.</div>'; $('segBrowser').innerHTML = '';
        ['sg-all', 'sg-active', 'sg-cart', 'sg-inactive'].forEach(function (id) { $(id).textContent = '—'; });
        return;
      }
      var list = r.data.segments || [];
      var by = {}; list.forEach(function (s) { by[s.key] = s; });
      var total = by.all ? Number(by.all.count) || 0 : 0;
      function cnt(k) { return by[k] ? Number(by[k].count) || 0 : 0; }
      $('sg-all').textContent = num(total);
      $('sg-active').textContent = num(cnt('active_7d'));
      $('sg-active-f').textContent = total ? Math.round((cnt('active_7d') / total) * 100) + '% of your subscribers' : 'Visited with notifications on';
      $('sg-cart').textContent = num(cnt('cart_30d'));
      $('sg-inactive').textContent = num(cnt('inactive_30d'));
      $('segUpdated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
      function tile(s) {
        var n = Number(s.count) || 0, pct = total ? Math.round((n / total) * 100) : 0;
        return '<div class="seg-tile' + (n ? '' : ' empty') + '">' +
          '<div class="top"><span class="ic"><i class="' + segIcon(s.key) + '"></i></span><div><b>' + esc(s.name) + '</b><span>' + esc(s.desc || '') + '</span></div></div>' +
          '<div class="count">' + num(n) + '<small>' + (s.key === 'all' ? 'subscribers' : pct + '% of all') + '</small></div>' +
          '<div class="bar"><span style="width:' + Math.min(100, pct) + '%"></span></div>' +
          '<button class="btn sm' + (n ? ' primary' : '') + '" data-send-seg="' + esc(s.key) + '"' + (n ? '' : ' disabled title="No subscribers in this segment yet"') + '><i class="fas fa-paper-plane"></i> Send campaign</button></div>';
      }
      var behaviour = list.filter(function (s) { return !BROWSER_SEGS[s.key]; });
      var browser = list.filter(function (s) { return BROWSER_SEGS[s.key]; });
      $('segBehaviour').innerHTML = behaviour.length ? behaviour.map(tile).join('') : '<div class="muted">No segments yet.</div>';
      $('segBrowser').innerHTML = browser.length ? browser.map(tile).join('') : '<div class="muted">No browser segments yet.</div>';
      applySegmentLock();
    });
  }
  // Free plan: counts stay visible, the segment tiles are blurred behind an
  // "Unlock your plan" card. Growth, Unlimited and the trial unlock them.
  function applySegmentLock() {
    var locked = segmentsLocked();
    [['segLockA', true], ['segLockB', false]].forEach(function (pair) {
      var wrap = $(pair[0]); if (!wrap) return;
      wrap.classList.toggle('locked', locked);
      var old = wrap.querySelector('.lock-overlay'); if (old) old.remove();
      if (locked && pair[1]) {
        var o = document.createElement('div'); o.className = 'lock-overlay';
        o.innerHTML = '<div class="lock-card"><span class="ic"><i class="fas fa-lock"></i></span><b>Unlock your plan to use segments</b><p>Segments are included in the Growth ($30/month) and Unlimited ($50/month) plans. Your counts keep updating meanwhile.</p><button class="btn primary" type="button" data-unlock-plan><i class="fas fa-bolt"></i> Unlock your plan</button></div>';
        wrap.appendChild(o);
      }
    });
  }
  $('segRefresh').addEventListener('click', function () { loadSegmentsPage(); toast('Segment counts refreshed.'); });
  document.addEventListener('click', function (e) {
    var u = e.target && e.target.closest ? e.target.closest('[data-unlock-plan]') : null;
    if (u) { e.preventDefault(); closeModal(); showView('plan'); }
  });
  $('view-segments').addEventListener('click', function (e) {
    var b = e.target.closest('[data-send-seg]'); if (!b || b.disabled) return;
    if (segmentsLocked()) { showUpgradeModal('segments'); return; }
    pendingSegment = b.getAttribute('data-send-seg');
    showView('creator');
  });

  // ------------------------------------------------------------ plan & usage
  var planData = null;
  loaders.plan = function () { loadPlan(); };
  function loadPlan() {
    api('/my-store/plan').then(function (r) {
      if (!r.ok || !r.data.success) {
        $('planHeroName').textContent = 'Could not load your plan'; $('planHeroText').textContent = r.data.error || 'Refresh to try again.';
        $('tiers').innerHTML = '<div class="muted">Plans could not be loaded.</div>';
        return;
      }
      planData = r.data;
      if (r.data.trial) ent = Object.assign({}, ent || {}, { plan: r.data.plan, trial: r.data.trial, usage: r.data.usage, segments_unlocked: r.data.segments_unlocked, prompts: r.data.prompts || (ent && ent.prompts) || {}, review_url: r.data.review_url });
      var u = r.data.usage, p = r.data.plan, tr = r.data.trial || {};
      var onTrial = !!tr.active;
      var pct = Math.min(100, Number(u.percent) || 0);
      $('planHeroChip').textContent = onTrial ? 'Free trial' : 'Current plan';
      $('planHeroChip').className = 'plan-chip' + (onTrial ? ' trial' : '');
      $('planHeroName').textContent = onTrial ? 'Unlimited (trial)' : p.name + ' plan';
      $('planHeroPrice').textContent = onTrial ? tr.days_left + ' day' + (tr.days_left === 1 ? '' : 's') + ' left' : p.price === null ? 'Custom pricing' : p.price === 0 ? 'Free' : usd(p.price) + ' / month';
      if (onTrial) $('planHeroText').textContent = num(u.used) + ' impressions this month. Everything is unlocked until ' + dateShort(tr.ends_at) + ', then your store moves to the ' + p.name + ' plan.';
      else if (u.limit === null) $('planHeroText').textContent = num(u.used) + ' impressions this month. No monthly cap on this plan.';
      else $('planHeroText').textContent = num(u.used) + ' of ' + num(u.limit) + ' impressions used this month' + (p.custom_limit ? ' (custom allowance)' : '');
      $('planHeroBar').className = 'bar' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
      $('planHeroBar').firstElementChild.style.width = (onTrial || u.limit === null ? 0 : pct) + '%';
      $('planHeroFoot').textContent = (onTrial || u.limit === null) ? 'Unlimited impressions' : pct + '% used' + (u.resets_on ? ' · resets on ' + dateShort(u.resets_on) : '');
      $('pu-camp').textContent = num(u.campaigns); $('pu-auto').textContent = num(u.automations);
      $('pu-used').textContent = num(u.used); $('pu-left').textContent = u.limit === null ? 'Unlimited' : num(u.remaining); $('pu-reset').textContent = dateShort(u.resets_on);
      renderTrialBox(tr, p);
      $('planContact').href = 'mailto:' + r.data.contact_email + '?subject=' + encodeURIComponent('SmartPush custom plan for ' + window.store.id);
      renderPending(r.data.pending_request);
      renderTiers();
    });
  }
  function renderTrialBox(tr, p) {
    var box = $('planTrial');
    if (!tr || !tr.ends_at) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.className = 'trial-box' + (tr.active ? '' : ' ended');
    if (tr.active) {
      box.innerHTML = '<span><i class="fas fa-gift"></i> <b>Free trial:</b> ' + tr.days_left + ' day' + (tr.days_left === 1 ? '' : 's') + ' left, ends ' + esc(dateShort(tr.ends_at)) + '. ' + (tr.extended ? 'This trial was extended once.' : 'Unlimited impressions and segments until then.') + '</span>' +
        (tr.can_extend ? '<button class="btn sm" type="button" id="extendBtn"><i class="fas fa-star"></i> Leave a review, get +' + tr.extension_days + ' days</button>' : '');
    } else {
      box.innerHTML = '<span><i class="fas fa-hourglass-end"></i> <b>Your free trial ended</b> on ' + esc(dateShort(tr.ends_at)) + '. ' + (tr.extended ? 'It was already extended once; upgrade to keep segments and higher limits.' : 'Leave a review on our app and get ' + tr.extension_days + ' more days free.') + '</span>' +
        (tr.can_extend ? '<button class="btn sm primary" type="button" id="extendBtn"><i class="fas fa-star"></i> Leave a review &amp; extend</button>' : '');
    }
    var b = $('extendBtn'); if (b) b.addEventListener('click', function () { extendTrial(b); });
  }
  function renderPending(req) {
    var box = $('planPending');
    if (!req) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<i class="fas fa-circle-check"></i> <b>' + esc(req.plan_name) + ' plan requested</b> on ' + esc(dateShort(req.created_at)) + '. We will switch your store over and email you' +
      (req.mailto ? ' — or <a href="' + esc(req.mailto) + '" target="_blank" rel="noopener">email us now</a> to speed it up.' : '.');
  }
  function renderTiers() {
    var cur = planData.plan, pending = planData.pending_request;
    var curIdx = planData.plans.findIndex(function (p) { return p.key === cur.key; });
    $('tiers').innerHTML = planData.plans.map(function (p, i) {
      var isCur = p.key === cur.key && !cur.custom_limit;
      var tag = isCur ? 'Current plan' : (p.key === 'growth' && curIdx < 1 ? 'Most popular' : (p.key === 'unlimited' && planData.trial && planData.trial.active ? 'Your trial plan' : ''));
      var btn;
      if (isCur) btn = '<button class="btn block" disabled><i class="fas fa-check"></i> Your current plan</button>';
      else if (pending && pending.plan === p.key) btn = '<button class="btn block soft" disabled><i class="far fa-clock"></i> Requested</button>';
      else btn = '<button class="btn block' + (i > curIdx ? ' primary' : '') + '" data-req-plan="' + esc(p.key) + '"><i class="fas fa-bolt"></i> ' + (i > curIdx ? 'Request upgrade' : 'Switch to this plan') + '</button>';
      return '<div class="tier' + (isCur ? ' current' : '') + (tag === 'Most popular' ? ' recommended' : '') + '">' + (tag ? '<span class="tag">' + tag + '</span>' : '') +
        '<h3>' + esc(p.name) + '</h3><div class="price">' + (p.price ? usd(p.price) + '<small> / month</small>' : 'Free') + '</div>' +
        '<div class="limit"><i class="fas fa-' + (p.limit === null ? 'infinity' : 'paper-plane') + '"></i> ' + (p.limit === null ? 'Unlimited impressions' : num(p.limit) + ' impressions / month') + '</div>' +
        '<p class="blurb">' + esc(p.blurb) + '</p><ul>' + p.features.map(function (f) { return '<li><i class="fas fa-check"></i>' + esc(f) + '</li>'; }).join('') + '</ul>' + btn + '</div>';
    }).join('');
  }
  $('tiers').addEventListener('click', function (e) {
    var b = e.target.closest('[data-req-plan]'); if (!b || !planData) return;
    var key = b.getAttribute('data-req-plan');
    var p = planData.plans.filter(function (x) { return x.key === key; })[0]; if (!p) return;
    if (!window.confirm('Request the ' + p.name + ' plan (' + (p.limit === null ? 'unlimited impressions' : num(p.limit) + ' impressions a month') + (p.price ? ', ' + usd(p.price) + '/month' : '') + ')? We will confirm by email before anything is charged.')) return;
    b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending…';
    api('/my-store/upgrade-request', { method: 'POST', body: { plan: key } }).then(function (r) {
      if (!r.ok || !r.data.success) { b.disabled = false; b.innerHTML = '<i class="fas fa-bolt"></i> Request upgrade'; return toast(r.data.error || 'Could not send the request.', 'err'); }
      toast('Request sent. We will email you when ' + p.name + ' is active.', 'ok');
      planData.pending_request = r.data.request;
      renderPending(r.data.request); renderTiers();
      if (r.data.request && r.data.request.mailto) window.open(r.data.request.mailto, '_blank');
    });
  });

  // ------------------------------------------------------------ analytics / automations
  loaders.analytics = function () { if (window.RetnerAnalytics) window.RetnerAnalytics.mount($('analytics-root'), { api: api, store: window.store }); };
  loaders.automations = function () { if (window.RetnerAutomations) window.RetnerAutomations.mount($('automations-root'), { store: window.store, api: api }); };

  // ------------------------------------------------------------ settings
  loaders.settings = function () {
    api('/my-store/details').then(function (r) {
      if (!r.ok || !r.data.success) return;
      var s = r.data.store;
      $('setStoreName').value = s.store_name || '';
      $('setLogoUrl').value = s.logo_url || '';
      if ($('setLogoUrl').__rm) $('setLogoUrl').__rm.setValue(s.logo_url || '');
      $('setStoreEmail').value = s.store_email || '';
      $('setDirectPrompt').checked = !!s.direct_prompt_enabled;
    });
  };
  $('saveSettingsBtn').addEventListener('click', function () {
    var b = $('saveSettingsBtn'); b.disabled = true;
    api('/my-store/update-settings', { method: 'POST', body: { storeName: val('setStoreName'), logoUrl: val('setLogoUrl'), storeEmail: val('setStoreEmail'), directPromptEnabled: $('setDirectPrompt').checked } }).then(function (r) {
      b.disabled = false;
      if (!r.ok || !r.data.success) return toast(r.data.error || 'Could not save.', 'err');
      window.store.name = val('setStoreName') || window.store.name;
      try { localStorage.setItem('store', JSON.stringify(window.store)); } catch (e) { /* ignore */ }
      greeting(); $('avatar').textContent = String(window.store.name).charAt(0).toUpperCase();
      $('saveMsg').classList.remove('hidden'); setTimeout(function () { $('saveMsg').classList.add('hidden'); }, 3000);
    });
  });
  $('savePasswordBtn').addEventListener('click', function () {
    api('/my-store/set-password', { method: 'POST', body: { password: $('setNewPassword').value } }).then(function (r) {
      $('pwMsg').style.color = r.data.success ? 'var(--ok)' : 'var(--err)';
      $('pwMsg').textContent = r.data.success ? 'Password saved. You can now sign in with your store ID and this password.' : (r.data.error || 'Could not save the password.');
      if (r.data.success) $('setNewPassword').value = '';
    });
  });

  // ------------------------------------------------------------ plan state (trial, limits, popups)
  var ent = null;
  function loadEntitlements() {
    return api('/my-store/entitlements').then(function (r) {
      if (r.ok && r.data.success) ent = r.data.entitlements;
      return ent;
    });
  }
  function segmentsLocked() { return !!(ent && ent.segments_unlocked === false); }
  function dismissPrompt(key) {
    if (ent && ent.prompts) ent.prompts[key] = false;
    return api('/my-store/prompts/dismiss', { method: 'POST', body: { key: key } }).then(function (r) { if (r.ok && r.data.success) ent = r.data.entitlements; });
  }
  function extendTrial(btn) {
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Extending…'; }
    var review = (ent && ent.review_url) || 'https://apps.shopify.com/retner-smartpush-live/reviews';
    window.open(review, '_blank', 'noopener');
    return api('/my-store/trial/extend', { method: 'POST' }).then(function (r) {
      if (!r.ok || !r.data.success) { if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-star"></i> Leave a review &amp; extend'; } return toast(r.data.error || 'Could not extend the trial.', 'err'); }
      ent = r.data.entitlements;
      closeModal();
      toast('Thank you! Your trial now runs until ' + dateShort(ent.trial.ends_at) + '.', 'ok');
      if (current === 'plan') loadPlan();
      if (current === 'home') loadHome();
      if (current === 'segments') applySegmentLock();
      if (current === 'creator') renderSegments();
    });
  }

  // Generic popup: { icon, tone, title, html, actions: [{ label, primary, onClick }] }
  function showModal(o) {
    $('modalIcon').innerHTML = '<i class="fas ' + (o.icon || 'fa-gift') + '"></i>';
    $('modalIcon').className = 'modal-ic' + (o.tone ? ' ' + o.tone : '');
    $('modalTitle').textContent = o.title || '';
    $('modalBody').innerHTML = o.html || '';
    var acts = $('modalActions'); acts.innerHTML = '';
    (o.actions || []).forEach(function (a) {
      var b = document.createElement('button'); b.type = 'button';
      b.className = 'btn block' + (a.primary ? ' primary lg' : '');
      b.innerHTML = a.html || esc(a.label);
      b.addEventListener('click', function () { a.onClick ? a.onClick(b) : closeModal(); });
      acts.appendChild(b);
    });
    $('modal').classList.remove('hidden');
  }
  function closeModal() { $('modal').classList.add('hidden'); }
  $('modal').addEventListener('click', function (e) { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeGuide(); } });

  function showTrialEndedModal() {
    var tr = ent.trial || {};
    showModal({
      icon: 'fa-gift', title: 'Want to extend the trial by 7 more days?',
      html: '<p>Your 7-day free trial has ended. Leave a review on our app and get <b>7 more days of free trial</b> (extended version): unlimited impressions and segments, no card needed.</p><span class="pill"><i class="fas fa-star"></i> One review = +' + (tr.extension_days || 7) + ' days</span>',
      actions: [
        { html: '<i class="fas fa-star"></i> Leave a review &amp; extend my trial', primary: true, onClick: function (b) { extendTrial(b); } },
        { label: 'Maybe later', onClick: function () { closeModal(); dismissPrompt('trial_ended'); } },
      ],
    });
  }
  function showUpgradeModal(reason) {
    var u = (ent && ent.usage) || {};
    var why = reason === 'segments'
      ? '<p>Targeted segments are part of the <b>Growth</b> ($30/month) and <b>Unlimited</b> ($50/month) plans. Upgrade to send campaigns to shoppers who added to cart, went quiet, or just joined.</p>'
      : '<p>You have used all <b>' + num(u.limit) + ' free impressions</b> for this month' + (u.resets_on ? ' (resets ' + esc(dateShort(u.resets_on)) + ')' : '') + '. Upgrade to keep your campaigns and automations going.</p>';
    showModal({
      icon: reason === 'segments' ? 'fa-lock' : 'fa-bolt', tone: reason === 'segments' ? '' : 'warn',
      title: reason === 'segments' ? 'Unlock your plan' : 'Free impressions used up',
      html: why + '<span class="pill">Growth $30 · ' + num((planData && planData.plans && planData.plans[1] && planData.plans[1].limit) || 50000) + ' impressions</span> <span class="pill">Unlimited $50 · no cap</span>',
      actions: [
        { html: '<i class="fas fa-bolt"></i> Upgrade now', primary: true, onClick: function () { closeModal(); if (reason !== 'segments') dismissPrompt('limit_reached'); showView('plan'); } },
        { label: 'Not now', onClick: function () { closeModal(); if (reason !== 'segments') dismissPrompt('limit_reached'); } },
      ],
    });
  }
  // On load: the trial-ended popup wins, then the limit popup, else the guide on a first visit.
  function showPrompts() {
    if (!ent) return;
    if (ent.prompts && ent.prompts.trial_ended) return showTrialEndedModal();
    if (ent.prompts && ent.prompts.limit_reached) return showUpgradeModal('limit');
    var seen = false; try { seen = !!localStorage.getItem('guide_seen_' + window.store.id); } catch (e) { /* ignore */ }
    if (!seen && !(ent.prompts && ent.prompts.tour_done)) openGuide();
  }

  // ------------------------------------------------------------ step guide (side drawer)
  var GUIDE = [
    { view: 'settings', title: 'Turn Retner on in your theme', desc: 'One switch in the theme editor.', body: 'Shoppers only see the subscribe prompt once the app embed is on. Open <b>Shopify admin → Online Store → Themes → Customize → App embeds</b> and switch on <b>Retner SmartPush</b>. Then set your store name, logo and contact email here in Settings: they appear on every notification.' },
    { view: 'home', title: 'Read the Home page', desc: 'Subscribers, sends, clicks and revenue at a glance.', body: 'The four tiles compare the last 7, 30 or 90 days with the period before. The Activity chart switches between sent, clicks and subscribers. The plan card shows your trial or monthly impressions, and Quick actions jump to the pages you use most.' },
    { view: 'creator', title: 'Send your first campaign', desc: 'Title, message, link, images, buttons, audience, schedule.', body: 'Start from a template or write your own. Keep the title under 50 and the message under 120 characters. Add a hero image (2:1) and up to two buttons, pick an audience, then <b>Send test to me</b> to see it on your own device before you send or schedule it.<ul><li>Flash sales can have an end time.</li><li>Click tracking and UTM tags are added for you, so revenue shows up in Analytics.</li></ul>' },
    { view: 'campaigns', title: 'Track campaigns', desc: 'Sent and scheduled, with delivery and click counts.', body: 'Every campaign you sent or scheduled is listed here with delivered counts, click rate and revenue. Scheduled campaigns can be cancelled until they go out; <b>Process pending</b> sends anything due right now.' },
    { view: 'automations', title: 'Switch on automations', desc: 'Welcome, abandoned cart, browse abandonment, win-back and more.', body: 'Automations send themselves. Turn on <b>Welcome</b> first (it greets every new subscriber), then <b>Abandoned cart</b> with a delay and an optional discount. Browse abandonment, win-back, order thank-you, price drop and back-in-stock each have their own copy, timing and test button.' },
    { view: 'subscribers', title: 'Watch your subscribers grow', desc: 'Growth chart, latest subscribers, device mix.', body: 'See who subscribed, from which browser, and when they were last seen. The growth chart shows daily sign-ups; the Segments card on the right previews the audiences you can target.' },
    { view: 'segments', title: 'Target with segments', desc: 'Ready-made audiences from live behaviour.', body: 'Segments are counted live from visits, carts and orders: active this week, added to cart, bought recently, inactive 30+ days, and by browser. Pick one and click <b>Send campaign</b> to open the creator with that audience selected. Segments are included in the Growth and Unlimited plans and during your trial.' },
    { view: 'analytics', title: 'Measure results', desc: 'Delivery, clicks, revenue, best campaigns.', body: 'Analytics shows sends, clicks, click rate and attributed revenue over time, plus your best-performing campaigns and automations. Revenue comes from orders placed after a notification click.' },
    { view: 'plan', title: 'Know your plan', desc: 'Free trial, impressions and upgrades.', body: 'Every store starts with a <b>7-day free trial</b> of Unlimited. After that the <b>Free</b> plan includes 10,000 impressions a month; <b>Growth</b> ($30) and <b>Unlimited</b> ($50) add more impressions and unlock segments. Leave a review on our app to extend the trial once by 7 days.' },
  ];
  var guideStep = 0;
  function renderGuide() {
    var done = {}; try { done = JSON.parse(localStorage.getItem('guide_done_' + window.store.id) || '{}'); } catch (e) { done = {}; }
    $('guideSteps').innerHTML = GUIDE.map(function (g, i) {
      return '<li class="guide-step' + (i === guideStep ? ' on' : '') + (done[i] ? ' done' : '') + '" data-step="' + i + '"><span class="n">' + (done[i] ? '<i class="fas fa-check"></i>' : (i + 1)) + '</span><div><b>Step ' + (i + 1) + ': ' + esc(g.title) + '</b><span>' + esc(g.desc) + '</span>' +
        '<div class="body">' + g.body + '<button class="btn sm primary" type="button" data-guide-open="' + esc(g.view) + '"><i class="fas fa-arrow-up-right-from-square"></i> Open this page</button></div></div></li>';
    }).join('');
    var n = Object.keys(done).length;
    $('guideBar').style.width = Math.round((n / GUIDE.length) * 100) + '%';
    $('guideCount').textContent = n + ' of ' + GUIDE.length + ' steps done · step ' + (guideStep + 1) + ' of ' + GUIDE.length;
    $('guidePrev').disabled = guideStep === 0;
    $('guideNext').innerHTML = guideStep === GUIDE.length - 1 ? '<i class="fas fa-check"></i> Finish' : 'Next <i class="fas fa-arrow-right"></i>';
    var on = $('guideSteps').querySelector('.on'); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function markGuideDone(i) {
    var done = {}; try { done = JSON.parse(localStorage.getItem('guide_done_' + window.store.id) || '{}'); } catch (e) { done = {}; }
    done[i] = true;
    try { localStorage.setItem('guide_done_' + window.store.id, JSON.stringify(done)); } catch (e) { /* ignore */ }
    if (Object.keys(done).length >= GUIDE.length && !(ent && ent.prompts && ent.prompts.tour_done)) dismissPrompt('tour');
  }
  function openGuide() {
    try { localStorage.setItem('guide_seen_' + window.store.id, '1'); } catch (e) { /* ignore */ }
    var idx = GUIDE.findIndex(function (g) { return g.view === current; });
    if (idx >= 0) guideStep = idx;
    renderGuide();
    $('guideWrap').classList.remove('hidden');
  }
  function closeGuide() { $('guideWrap').classList.add('hidden'); }
  $('guideClose').addEventListener('click', closeGuide);
  $('guideBackdrop').addEventListener('click', closeGuide);
  $('guidePrev').addEventListener('click', function () { if (guideStep > 0) { guideStep--; renderGuide(); } });
  $('guideNext').addEventListener('click', function () {
    markGuideDone(guideStep);
    if (guideStep < GUIDE.length - 1) { guideStep++; renderGuide(); }
    else { closeGuide(); toast('You have seen every feature. Open the guide any time from the top bar.', 'ok'); }
  });
  $('guideSteps').addEventListener('click', function (e) {
    var o = e.target.closest('[data-guide-open]');
    if (o) { markGuideDone(guideStep); showView(o.getAttribute('data-guide-open')); if (window.innerWidth < 900) closeGuide(); renderGuide(); return; }
    var li = e.target.closest('[data-step]');
    if (li) { guideStep = parseInt(li.getAttribute('data-step'), 10) || 0; renderGuide(); }
  });

  // ------------------------------------------------------------ boot
  if (window.store) initApp(); else $('login').classList.remove('hidden');
})();
