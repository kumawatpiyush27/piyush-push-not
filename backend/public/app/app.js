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
  var VIEWS = ['home', 'campaigns', 'creator', 'subscribers', 'segments', 'contacts', 'popups', 'analytics', 'automations', 'plan', 'settings'];
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
    // ?tour=1 (from the Shopify app) replays the guided tour.
    if (params.get('tour')) window.__startTour = true;
    // ?tip=<id> (from the Shopify app's ideas card) opens the creator with that template.
    if (params.get('tip')) { pendingTemplate = { id: Number(params.get('tip')), params: null }; }
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
  loaders.home = function () { loadHome(); loadIdeas(); loadTipLine(); };
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
        $('planBtn').innerHTML = onTrial || !(u.plan && u.plan.selected) ? '<i class="fas fa-bolt"></i> Choose your plan' : '<i class="fas fa-bolt"></i> Change plan';
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

  // Template library: items from /my-store/tips?surface=creator (editable in the
  // master admin); the built-in list is the fallback while it loads or if it fails.
  var libraryTemplates = null, pendingTemplate = null;
  function applyTemplate(t) {
    $('campTitle').value = t.title || ''; $('campMsg').value = t.msg || '';
    setType(t.type === 'flash' ? 'flash' : 'regular');
    if (t.btn) { if (!btnCount) addBtnRow(); var bt = $('btn1Txt'); if (bt) bt.value = t.btn; }
    if (t.url) $('campUrl').value = t.url;
    if (t.discount) $('campDiscount').value = t.discount;
    counters(); preview();
    toast('Template applied. Edit the text and add your link.');
  }
  function renderTemplateRow() {
    var items = libraryTemplates && libraryTemplates.length ? libraryTemplates : null;
    if (items) {
      $('tplRow').innerHTML = items.map(function (t) {
        return '<button type="button" class="tpl' + (t.kind === 'season' ? ' season' : '') + '" data-tip-id="' + t.id + '" title="' + esc(t.body || '') + '">' + esc(t.title) + '</button>';
      }).join('');
    } else {
      $('tplRow').innerHTML = TEMPLATES.map(function (t, i) { return '<button type="button" class="tpl" data-tpl="' + i + '">' + esc(t.name) + '</button>'; }).join('');
    }
  }
  function loadTemplateLibrary() {
    api('/my-store/tips?surface=creator').then(function (r) {
      if (r.ok && r.data.success) { libraryTemplates = r.data.items || []; renderTemplateRow(); }
      if (pendingTemplate) { var pt = pendingTemplate; pendingTemplate = null; applyTemplate(pt.params); if (pt.id) tipEvent(pt.id, 'used', 'creator'); }
    });
  }
  function initCreator() {
    if (creatorReady) return; creatorReady = true;
    renderTemplateRow();
    $('tplRow').addEventListener('click', function (e) {
      var b = e.target.closest('[data-tpl], [data-tip-id]'); if (!b) return;
      if (b.hasAttribute('data-tip-id')) {
        var id = Number(b.getAttribute('data-tip-id'));
        var it = (libraryTemplates || []).filter(function (x) { return x.id === id; })[0]; if (!it) return;
        applyTemplate(it.cta_params || {}); tipEvent(id, 'used', 'creator');
        return;
      }
      applyTemplate(TEMPLATES[Number(b.getAttribute('data-tpl'))]);
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
    loadTemplateLibrary();
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
    var review = (ent && ent.review_url) || (planData && planData.review_url) || 'https://apps.shopify.com/retner-smartpush-live/reviews';
    if (tr.active) {
      box.innerHTML = '<span><i class="fas fa-gift"></i> <b>Free trial:</b> ' + tr.days_left + ' day' + (tr.days_left === 1 ? '' : 's') + ' left, ends ' + esc(dateShort(tr.ends_at)) + '. Unlimited impressions and segments until then; pick the plan you want afterwards below.</span>' +
        '<a class="btn sm" href="' + esc(review) + '" target="_blank" rel="noopener"><i class="fas fa-star"></i> Leave a review</a>';
    } else {
      box.innerHTML = '<span><i class="fas fa-hourglass-end"></i> <b>Your free trial ended</b> on ' + esc(dateShort(tr.ends_at)) + '. ' + (p && p.selected ? 'You are on the ' + esc(p.name) + ' plan.' : 'Choose a plan below to keep going.') + '</span>' +
        '<a class="btn sm" href="' + esc(review) + '" target="_blank" rel="noopener"><i class="fas fa-star"></i> Leave a review</a>';
    }
  }
  function renderPending(req) {
    var box = $('planPending');
    if (!req) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    box.classList.remove('hidden');
    box.innerHTML = '<i class="fas fa-circle-check"></i> <b>' + esc(req.plan_name) + ' plan selected</b> on ' + esc(dateShort(req.created_at)) + '. It is active now; we will email you about billing' +
      (req.mailto ? ' — or <a href="' + esc(req.mailto) + '" target="_blank" rel="noopener">email us</a> if you have questions.' : '.');
  }
  function renderTiers() {
    var cur = planData.plan, pending = planData.pending_request;
    var curIdx = planData.plans.findIndex(function (p) { return p.key === cur.key; });
    $('tiers').innerHTML = planData.plans.map(function (p, i) {
      var onTrial = !!(planData.trial && planData.trial.active);
      var isCur = p.key === cur.key && !cur.custom_limit;
      var tag = isCur ? (cur.selected ? 'Your plan' : (onTrial ? 'After the trial' : 'Current plan')) : (p.key === 'growth' && curIdx < 1 ? 'Most popular' : (p.key === 'unlimited' && onTrial ? 'Your trial plan' : ''));
      var btn;
      if (isCur && cur.selected) btn = '<button class="btn block" disabled><i class="fas fa-check"></i> Selected</button>';
      else btn = '<button class="btn block' + (i > curIdx || !cur.selected ? ' primary' : '') + '" data-req-plan="' + esc(p.key) + '"><i class="fas fa-check"></i> Select ' + esc(p.name) + '</button>';
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
    if (!window.confirm('Select the ' + p.name + ' plan (' + (p.limit === null ? 'unlimited impressions' : num(p.limit) + ' impressions a month') + (p.price ? ', ' + usd(p.price) + '/month' : ', free') + ')?' + (p.price ? ' It applies right away; we will email you about billing, nothing is charged automatically.' : ''))) return;
    b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
    api('/my-store/select-plan', { method: 'POST', body: { plan: key } }).then(function (r) {
      if (!r.ok || !r.data.success) { b.disabled = false; b.innerHTML = '<i class="fas fa-check"></i> Select ' + esc(p.name); return toast(r.data.error || 'Could not change the plan.', 'err'); }
      toast(p.name + ' plan selected.', 'ok');
      ent = r.data.entitlements || ent;
      loadPlan();
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

  // ------------------------------------------------------------ contacts
  var cState = { q: '', filter: 'all', offset: 0, limit: 50, rows: [] };
  loaders.contacts = function () { loadContacts(); };
  function consentBadges(c) {
    return '<span class="consent-badges">' + [['push', c.push_consent || c.devices > 0], ['wa', c.whatsapp_consent], ['sms', c.sms_consent], ['email', c.email_consent]].map(function (x) { return '<span class="' + (x[1] ? 'on' : '') + '">' + x[0].toUpperCase() + '</span>'; }).join('') + '</span>';
  }
  function loadContacts() {
    var qs = '?limit=' + cState.limit + '&offset=' + cState.offset + '&filter=' + encodeURIComponent(cState.filter) + (cState.q ? '&q=' + encodeURIComponent(cState.q) : '');
    api('/my-store/contacts' + qs).then(function (r) {
      document.querySelectorAll('#view-contacts .skel').forEach(function (el) { el.classList.remove('skel'); });
      if (!r.ok || !r.data.success) { $('contactsBody').innerHTML = '<tr><td colspan="8" class="muted">Could not load contacts.</td></tr>'; return; }
      var k = r.data.counts || {};
      $('c-total').textContent = num(k.total); $('c-phone').textContent = num(k.with_phone); $('c-email').textContent = num(k.with_email); $('c-buyers').textContent = num(k.buyers);
      $('c-phone-f').textContent = num(k.whatsapp) + ' with WhatsApp opt-in'; $('c-leads-f').textContent = num(k.leads_7d) + ' new leads in 7 days';
      cState.rows = r.data.contacts || [];
      $('contactsBody').innerHTML = cState.rows.length ? cState.rows.map(function (c) {
        var name = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.customer_id ? 'Customer ' + c.customer_id : 'Anonymous subscriber');
        return '<tr data-contact="' + c.id + '" style="cursor:pointer">' +
          '<td class="contact-name"><b>' + esc(name) + '</b><small>#' + c.id + (c.source ? ' · ' + esc(c.source) : '') + '</small></td>' +
          '<td>' + (c.phone ? esc(c.phone) : '<span class="muted">—</span>') + '</td><td>' + (c.email ? esc(c.email) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + (c.subscriber_id ? '<span class="chip">S-' + c.subscriber_id + '</span>' : '<span class="muted">—</span>') + '</td>' +
          '<td>' + num(c.devices) + '</td><td>' + consentBadges(c) + '</td>' +
          '<td>' + (c.orders_count ? num(c.orders_count) + ' · ' + money(c.total_spent, c.currency || 'INR') : '<span class="muted">0</span>') + '</td>' +
          '<td>' + esc(ago(c.last_seen_at)) + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="muted">No contacts match. Turn on "Collect phone & email" in Popups to start capturing leads.</td></tr>';
      $('contactsNote').textContent = 'Showing ' + (cState.rows.length ? cState.offset + 1 : 0) + '–' + (cState.offset + cState.rows.length) + ' of ' + num(k.total) + (r.data.backfill && r.data.backfill.remaining ? ' · linking older subscribers, refresh for more' : '');
      $('contactsPrev').disabled = cState.offset === 0; $('contactsNext').disabled = cState.rows.length < cState.limit;
    });
  }
  $('contactTabs').addEventListener('click', function (e) { var b = e.target.closest('[data-f]'); if (!b) return; document.querySelectorAll('#contactTabs button').forEach(function (x) { x.classList.toggle('active', x === b); }); cState.filter = b.getAttribute('data-f'); cState.offset = 0; loadContacts(); });
  var cSearchTimer; $('contactSearch').addEventListener('input', function () { clearTimeout(cSearchTimer); cSearchTimer = setTimeout(function () { cState.q = $('contactSearch').value.trim(); cState.offset = 0; loadContacts(); }, 300); });
  $('contactsPrev').addEventListener('click', function () { cState.offset = Math.max(0, cState.offset - cState.limit); loadContacts(); });
  $('contactsNext').addEventListener('click', function () { cState.offset += cState.limit; loadContacts(); });
  $('contactsCsv').addEventListener('click', function (e) {
    e.preventDefault();
    window.fetch('/my-store/contacts.csv?filter=' + encodeURIComponent(cState.filter) + (cState.q ? '&q=' + encodeURIComponent(cState.q) : '')).then(function (r) { return r.blob(); }).then(function (b) {
      var a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = 'contacts-' + window.store.id + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    });
  });
  $('contactsBody').addEventListener('click', function (e) {
    var tr = e.target.closest('[data-contact]'); if (!tr) return;
    api('/my-store/contacts/' + tr.getAttribute('data-contact')).then(function (r) {
      if (!r.ok || !r.data.success) return toast('Could not load the contact.', 'err');
      var c = r.data.contact, name = [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Contact #' + c.id;
      var box = $('contactDetail'); box.classList.remove('hidden');
      box.innerHTML = '<div class="card-head"><div><h3>' + esc(name) + '</h3><div class="muted" style="font-size:12.5px">Contact #' + c.id + (c.customer_id ? ' · Shopify customer ' + esc(c.customer_id) : '') + ' · since ' + esc(dateShort(c.first_seen_at)) + '</div></div><button class="btn sm" id="contactClose">Close</button></div>' +
        '<div class="cd-grid">' +
        '<div><h4>Identity</h4><ul class="cd-list"><li><span>Phone</span><b>' + esc(c.phone || '—') + '</b></li><li><span>Email</span><b>' + esc(c.email || '—') + '</b></li><li><span>Consent</span>' + consentBadges(c) + '</li><li><span>Source</span><b>' + esc(c.source || 'push') + '</b></li><li><span>Orders</span><b>' + num(c.orders_count) + ' · ' + money(c.total_spent, c.currency || 'INR') + '</b></li></ul></div>' +
        '<div><h4>Devices (' + r.data.devices.length + ')</h4><ul class="cd-list">' + (r.data.devices.map(function (d) { return '<li><span>S-' + d.id + ' · ' + esc(d.browser) + '</span><b>' + esc(d.status) + ' · ' + esc(ago(d.last_seen_at || d.created_at)) + '</b></li>'; }).join('') || '<li class="muted">No push devices</li>') + '</ul></div>' +
        '<div><h4>Timeline</h4><ul class="cd-list">' + (r.data.events.map(function (ev) { return '<li><span>' + esc(ev.kind) + '</span><b>' + esc(ago(ev.at)) + '</b></li>'; }).join('') || '<li class="muted">No events yet</li>') + '</ul></div>' +
        '</div>';
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('contactClose').addEventListener('click', function () { box.classList.add('hidden'); });
    });
  });

  // ------------------------------------------------------------ popups designer
  // CSS mirrors extensions/push-notification-popup/blocks/popup.liquid (.ppv-*) so the preview is the real popup.
  var RP_CSS = '.ppv-scope .rp{position:absolute;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--ppv-text);background:var(--ppv-bg);border-radius:var(--ppv-radius);box-shadow:0 20px 60px rgba(0,0,0,.18),0 4px 16px rgba(0,0,0,.12);overflow:hidden;width:320px;max-width:calc(100% - 24px);z-index:5}' +
    '.ppv-scope .rp.ppv-corner{bottom:16px;right:16px}.ppv-scope .rp.ppv-corner.ppv-left{right:auto;left:16px}.ppv-scope .rp.ppv-center{left:50%;top:50%;transform:translate(-50%,-50%);width:360px}' +
    '.ppv-scope .rp.ppv-topbar{top:0;left:0;right:0;width:auto;max-width:none;border-radius:0;box-shadow:0 6px 24px rgba(0,0,0,.15)}.ppv-scope .ppv-shade{position:absolute;inset:0;background:rgba(17,24,39,.45);z-index:4}' +
    '.ppv-scope .ppv-head{display:flex;align-items:center;gap:10px;padding:12px 14px;color:#fff;background:var(--ppv-accent);position:relative}.ppv-scope .ppv-head.ppv-gradient{background:linear-gradient(120deg,var(--ppv-accent),#f97316)}.ppv-scope .ppv-head.ppv-none{background:transparent;color:var(--ppv-text);padding-bottom:0}' +
    '.ppv-scope .ppv-logo{width:36px;height:36px;border-radius:9px;object-fit:cover;background:rgba(255,255,255,.25);flex-shrink:0}.ppv-scope .ppv-store{font-weight:700;font-size:14px;flex:1}.ppv-scope .ppv-x{width:26px;height:26px;border-radius:50%;background:rgba(127,127,127,.25);display:inline-flex;align-items:center;justify-content:center;font-size:13px;line-height:1;flex-shrink:0}' +
    '.ppv-scope .ppv-body{padding:16px 16px 12px}.ppv-scope .ppv-center .ppv-body{padding:18px 20px 16px;text-align:center}.ppv-scope .ppv-center .ppv-head{justify-content:center}.ppv-scope .ppv-center .ppv-head .ppv-x{position:absolute;top:10px;right:10px}.ppv-scope .ppv-center .ppv-logo{width:56px;height:56px;border-radius:14px}.ppv-scope .ppv-center .ppv-store{display:none}' +
    '.ppv-scope .ppv-title{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:700;line-height:1.3;margin:0}.ppv-scope .ppv-center .ppv-title{justify-content:center;font-size:18px}.ppv-scope .ppv-bell{font-size:24px;display:inline-block}' +
    '.ppv-scope .ppv-msg{font-size:13px;margin:6px 0 0;opacity:.78;line-height:1.5}.ppv-scope .ppv-badge{display:inline-flex;align-items:center;gap:6px;background:linear-gradient(135deg,#fff3cd,#ffe08a);border:1px solid #f0c040;border-radius:8px;padding:7px 12px;margin:12px 0 0;font-size:12px;font-weight:700;color:#7c5200}' +
    '.ppv-scope .ppv-field{display:flex;align-items:center;gap:6px;margin-top:14px;border:1px solid rgba(127,127,127,.35);border-radius:10px;padding:10px 12px;font-size:14px;background:rgba(255,255,255,.6);color:inherit;text-align:left}.ppv-scope .ppv-field small{opacity:.6}' +
    '.ppv-scope .ppv-actions{display:flex;gap:8px;margin-top:14px}.ppv-scope .ppv-center .ppv-actions{flex-direction:column}.ppv-scope .ppv-allow{background:var(--ppv-accent);color:var(--ppv-on-accent);border:0;padding:11px 16px;border-radius:calc(var(--ppv-radius) * .6 + 4px);font-weight:700;font-size:13px;flex:1;text-align:center}' +
    '.ppv-scope .ppv-later{background:transparent;border:1px solid rgba(127,127,127,.35);padding:11px 14px;border-radius:calc(var(--ppv-radius) * .6 + 4px);font-size:12px;opacity:.7;text-align:center}.ppv-scope .ppv-brand{text-align:center;margin-top:12px;font-size:10px;opacity:.6;letter-spacing:.3px}' +
    '.ppv-scope .ppv-topbar .ppv-head{display:none}.ppv-scope .ppv-topbar .ppv-body{display:flex;align-items:center;gap:14px;padding:10px 16px}.ppv-scope .ppv-topbar .ppv-msg{margin:0;flex:1}.ppv-scope .ppv-topbar .ppv-title{font-size:14px;white-space:nowrap}.ppv-scope .ppv-topbar .ppv-badge,.ppv-scope .ppv-topbar .ppv-brand,.ppv-scope .ppv-topbar .ppv-field,.ppv-scope .ppv-topbar .ppv-fine{display:none}.ppv-scope .ppv-topbar .ppv-actions{margin:0}.ppv-scope .ppv-topbar .ppv-allow{padding:8px 14px;flex:none}.ppv-scope .ppv-topbar .ppv-later{padding:8px 10px}' +
    '.ppv-scope .rp.ppv-sheet{left:50%;top:50%;transform:translate(-50%,-50%);width:380px;text-align:center}.ppv-scope .ppv-sheet .ppv-ribbon{background:#111827;color:#fff;font-size:12px;font-weight:600;text-align:center;padding:7px 12px}.ppv-scope .ppv-sheet .ppv-head{justify-content:center;padding:22px 16px 6px;background:transparent;color:var(--ppv-text)}.ppv-scope .ppv-sheet .ppv-head .ppv-x{position:absolute;top:10px;right:10px}.ppv-scope .ppv-sheet .ppv-logo{width:96px;height:56px;border-radius:0;object-fit:contain;background:transparent}.ppv-scope .ppv-sheet .ppv-store{display:none}' +
    '.ppv-scope .ppv-sheet .ppv-body{padding:8px 22px 18px}.ppv-scope .ppv-sheet .ppv-title{justify-content:center;font-size:20px;font-weight:600}.ppv-scope .ppv-sheet .ppv-actions{flex-direction:column;margin-top:16px}.ppv-scope .ppv-sheet .ppv-allow{padding:15px 16px;font-size:15px;border-radius:12px}.ppv-scope .ppv-sheet .ppv-later{border:0;opacity:.55;padding:6px}' +
    '.ppv-scope .ppv-fine{display:none;font-size:11.5px;opacity:.7;margin-top:10px}.ppv-scope .ppv-sheet .ppv-fine,.ppv-scope .ppv-center .ppv-fine{display:block}.ppv-scope .ppv-fine::before{content:"☑ "}' +
    '.ppv-scope.phone .rp,.ppv-scope.phone .rp.ppv-corner,.ppv-scope.phone .rp.ppv-center,.ppv-scope.phone .rp.ppv-sheet{left:0;right:0;bottom:0;top:auto;transform:none;width:auto;max-width:none;border-radius:var(--ppv-radius) var(--ppv-radius) 0 0}.ppv-scope.phone .rp.ppv-topbar{top:0;bottom:auto;border-radius:0}';
  var ppData = null, ppKind = 'push', ppDirty = false, ppMobile = false;
  function pp() { return ppData ? ppData[ppKind] : null; }
  function onAccent(hex) { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || ''); if (!m) return '#fff'; var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255; return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 0.6 ? '#111827' : '#ffffff'; }
  // One renderer for both popups: `kind` decides the body (Allow/Later vs field + button).
  function popupMarkup(d, kind, storeLogo) {
    var logo = d.logo_url || storeLogo || 'https://push-retner.vercel.app/logo.png';
    var style = '--ppv-accent:' + d.accent + ';--ppv-bg:' + d.bg + ';--ppv-text:' + d.text + ';--ppv-radius:' + d.radius + 'px;--ppv-on-accent:' + onAccent(d.accent);
    var header = kind === 'lead' ? 'none' : (d.header || 'band');
    var body;
    if (kind === 'lead') {
      var cc = { IN: '+91', US: '+1', GB: '+44', AE: '+971', SG: '+65', AU: '+61' }[d.country || 'IN'] || '+91';
      body = '<p class="ppv-title"><span>' + esc(d.title) + '</span></p>' + (d.message ? '<p class="ppv-msg">' + esc(d.message) + '</p>' : '') +
        '<div class="ppv-field">' + (d.collect === 'email' ? '✉️ <small>you@email.com</small>' : (d.collect === 'either' ? '📱 <small>Phone number or email</small>' : esc(cc) + ' <small>98765 43210</small>')) + '</div>' +
        (d.consent_text ? '<div class="ppv-fine">' + esc(d.consent_text) + '</div>' : '') +
        '<div class="ppv-actions"><span class="ppv-allow">' + esc(d.button_text) + '</span><span class="ppv-later">' + esc(d.skip_text) + '</span></div>' +
        (d.show_brand ? '<div class="ppv-brand">Powered by Retner.ai</div>' : '');
    } else {
      body = '<p class="ppv-title">' + (d.show_bell ? '<span class="ppv-bell">🔔</span>' : '') + '<span>' + esc(d.title) + '</span></p>' +
        (d.message ? '<p class="ppv-msg">' + esc(d.message) + '</p>' : '') + (d.badge_text ? '<div class="ppv-badge"><span>🎁</span>' + esc(d.badge_text) + '</div>' : '') +
        '<div class="ppv-actions"><span class="ppv-allow">' + (d.show_bell ? '🔔 ' : '') + esc(d.allow_text) + '</span><span class="ppv-later">' + esc(d.later_text) + '</span></div>' +
        (d.fine_print ? '<div class="ppv-fine">' + esc(d.fine_print) + '</div>' : '') + (d.show_brand ? '<div class="ppv-brand">Powered by Retner.ai</div>' : '');
    }
    return ((d.layout === 'center' || d.layout === 'sheet') ? '<div class="ppv-shade"></div>' : '') +
      '<div class="ppv ppv-' + esc(d.layout) + (d.position === 'left' ? ' ppv-left' : '') + '" style="' + style + '">' +
      (d.layout === 'sheet' && d.ribbon_text ? '<div class="ppv-ribbon">' + esc(d.ribbon_text) + '</div>' : '') +
      '<div class="ppv-head ppv-' + header + '"><img class="ppv-logo" src="' + esc(logo) + '" alt=""><span class="ppv-store">' + esc(window.store.name || window.store.id) + '</span><span class="ppv-x">✕</span></div>' +
      '<div class="ppv-body">' + body + '</div></div>';
  }
  function previewHtml(d, kind, storeLogo, mobile) {
    return '<div class="ppv-scope ' + (mobile ? 'phone' : 'frame') + '">' + (mobile ? '' : '<div class="ppv-bar"><i style="background:#f87171"></i><i style="background:#fbbf24"></i><i style="background:#34d399"></i><span class="url">🔒 ' + esc(window.store.id) + '.myshopify.com</span></div>') +
      '<div class="ppv-stage" style="height:' + (mobile ? 520 : 360) + 'px"><div class="ppv-skel"><i></i><div><b></b><b></b><b></b></div></div>' + popupMarkup(d, kind, storeLogo) + '</div></div>';
  }
  loaders.popups = function () { if (!document.getElementById('rpCss')) { var st = document.createElement('style'); st.id = 'rpCss'; st.textContent = RP_CSS; document.head.appendChild(st); } loadPopups(); };
  function loadPopups() {
    api('/my-store/popup').then(function (r) {
      if (!r.ok || !r.data.success) { $('popupGallery').innerHTML = '<div class="muted">Could not load designs.</div>'; return; }
      ppData = r.data; ppDirty = false;
      renderFlow(); renderGallery(); renderEditor(); setSaved(true);
      var nb = $('popupNotice'); nb.classList.toggle('hidden', !!r.data.saved);
      nb.innerHTML = '<i class="fas fa-circle-info"></i> No design chosen yet: your storefront shows the theme-editor popup. Pick any design below and it goes live within 5 minutes.';
    });
  }
  function renderFlow() {
    var p = ppData.push, l = ppData.lead;
    var st1 = '<span class="st ' + (p.enabled ? 'on' : 'off') + '"><i class="fas fa-bell"></i> Subscribe popup · ' + (p.enabled ? p.delay + 's after page load' : 'off') + '</span>';
    var st2 = '<span class="st ' + (l.enabled ? 'on' : 'off') + '"><i class="fas fa-address-card"></i> Lead popup · ' + (l.enabled ? (l.trigger === 'timer' ? l.delay + 's after page load' : l.trigger === 'second_page' ? 'on the 2nd page, +' + l.delay + 's' : l.delay + 's after the subscribe step') : 'off') + '</span>';
    var hint = !p.enabled && !l.enabled ? 'Both popups are off: shoppers see nothing.' : (l.enabled && l.delay === 0 && l.trigger === 'after_push' ? 'Lead delay is 0: it opens the moment the subscribe popup closes.' : 'Never both at once. Each remembers its own answer.');
    $('popupFlow').innerHTML = st1 + '<span class="arrow"><i class="fas fa-arrow-right"></i></span>' + st2 + '<span class="hint">' + hint + '</span>';
  }
  function setSaved(saved) { var b = $('popupSave'); b.disabled = saved; b.innerHTML = saved ? '<i class="fas fa-check"></i> Saved' : '<i class="fas fa-check"></i> Save changes'; var b2 = $('popupSave2'); if (b2) { b2.disabled = saved; } }
  function markDirty() { ppDirty = true; setSaved(false); }
  function renderGallery() {
    var cur = pp(), list = ppData.presets[ppKind] || [];
    $('popupGalleryTitle').textContent = ppKind === 'lead' ? 'Lead popup designs' : 'Subscribe popup designs';
    $('popupGallery').innerHTML = list.map(function (p) {
      var isCur = cur.preset === p.key;
      return '<div class="pp-card' + (isCur ? ' current' : '') + '"><div class="pp-thumb"><div class="ppv-scope">' + popupMarkup(p.settings, ppKind, ppData.store_logo) + '</div></div>' +
        '<div class="row-between"><b>' + esc(p.name) + '</b>' + (isCur ? '<span class="chip ok">In use</span>' : '<span class="chip">' + esc(p.settings.layout) + '</span>') + '</div>' +
        '<span class="blurb">' + esc(p.blurb) + '</span><button class="btn sm' + (isCur ? '' : ' primary') + '" data-preset="' + esc(p.key) + '"' + (isCur ? ' disabled' : '') + '>' + (isCur ? 'Current design' : 'Use this design') + '</button></div>';
    }).join('');
  }
  function fld(label, key, type, extra) {
    extra = extra || {};
    var v = pp()[key] == null ? '' : pp()[key];
    if (type === 'select') return '<div class="field"><label>' + label + '</label><select class="input" data-pp="' + key + '">' + extra.options.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(v) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>' + (extra.help ? '<div class="help">' + extra.help + '</div>' : '') + '</div>';
    if (type === 'check') return '<label class="row-between" style="margin-bottom:10px;"><span>' + label + '</span><input type="checkbox" data-pp="' + key + '"' + (v ? ' checked' : '') + '></label>';
    if (type === 'range') return '<div class="field"><label>' + label + ' · <b data-pp-val="' + key + '">' + esc(v) + '</b></label><input type="range" data-pp="' + key + '" min="' + extra.min + '" max="' + extra.max + '" value="' + esc(v) + '" style="width:100%"></div>';
    if (type === 'textarea') return '<div class="field"><label>' + label + '</label><textarea class="input" data-pp="' + key + '" maxlength="' + (extra.max || 160) + '" rows="2">' + esc(v) + '</textarea></div>';
    return '<div class="field"><label>' + label + '</label><input class="input" data-pp="' + key + '" maxlength="' + (extra.max || 60) + '" value="' + esc(v) + '" placeholder="' + esc(extra.ph || '') + '"></div>';
  }
  var COLORS = '<div class="field"><label>Colours</label><div class="pp-colors"><div><input type="color" data-pp="accent" value="__A__"><div class="help">Brand</div></div><div><input type="color" data-pp="bg" value="__B__"><div class="help">Background</div></div><div><input type="color" data-pp="text" value="__T__"><div class="help">Text</div></div></div></div>';
  function renderEditor() {
    var d = pp(), html;
    var colors = COLORS.replace('__A__', esc(d.accent)).replace('__B__', esc(d.bg)).replace('__T__', esc(d.text));
    if (ppKind === 'push') {
      html = '<div class="card"><h3>Subscribe popup</h3>' + fld('Show the subscribe popup', 'enabled', 'check') +
        fld('Layout', 'layout', 'select', { options: [['corner', 'Corner card'], ['center', 'Centered'], ['topbar', 'Top bar']] }) +
        (d.layout === 'corner' ? fld('Corner', 'position', 'select', { options: [['right', 'Bottom right'], ['left', 'Bottom left']] }) : '') + colors +
        (d.layout !== 'topbar' ? fld('Header', 'header', 'select', { options: [['band', 'Brand colour band'], ['gradient', 'Gradient band'], ['none', 'No band']] }) : '') +
        fld('Corner roundness (px)', 'radius', 'range', { min: 0, max: 32 }) +
        '<h3 style="margin-top:18px">Text</h3>' + fld('Title', 'title', 'text') + fld('Message', 'message', 'textarea') +
        '<div class="pp-colors" style="grid-template-columns:1fr 1fr">' + fld('Allow button', 'allow_text', 'text', { max: 30 }) + fld('Later button', 'later_text', 'text', { max: 20 }) + '</div>' +
        fld('Offer badge (optional)', 'badge_text', 'text') + (d.layout === 'center' ? fld('Fine print under the button', 'fine_print', 'text', { max: 90 }) : '') +
        '<h3 style="margin-top:18px">Logo &amp; timing</h3><div class="field"><label>Logo in the popup</label><input type="hidden" id="ppLogo" value="' + esc(d.logo_url || '') + '"><div data-media-for="ppLogo" data-purpose="logo" data-max-side="512" data-hint="empty = your store logo"></div></div>' +
        fld('Show after (seconds on the page)', 'delay', 'range', { min: 0, max: 60 }) + fld('"Later" hides it for (days)', 'later_days', 'range', { min: 0, max: 30 }) +
        fld('Animated bell', 'show_bell', 'check') + fld('Show "Powered by Retner.ai"', 'show_brand', 'check') +
        '<p class="sub">To skip this popup and show the browser prompt directly, turn on "Skip the custom popup" in Settings.</p>';
    } else {
      html = '<div class="card"><h3>Lead popup</h3>' + fld('Show the lead popup', 'enabled', 'check') +
        '<p class="sub">Asks for a phone number or email, separately from the subscribe popup. The lead is saved in Contacts even when notifications are blocked.</p>' +
        '<h3 style="margin-top:14px">When</h3>' + fld('Trigger', 'trigger', 'select', { options: [['after_push', 'After the subscribe step'], ['timer', 'On its own timer (after page load)'], ['second_page', 'On the 2nd page of the visit']], help: 'After the subscribe step = when the visitor answered, closed or skipped the subscribe popup (also works with the browser prompt).' }) +
        fld('Delay (seconds)', 'delay', 'range', { min: 0, max: 120 }) + fld('Pages', 'pages', 'select', { options: [['all', 'All pages'], ['product', 'Product pages'], ['cart', 'Cart page'], ['product_cart', 'Product + cart pages']] }) +
        fld('"No thanks" hides it for (days)', 'later_days', 'range', { min: 0, max: 30 }) + fld('Maximum times per visitor', 'max_shows', 'range', { min: 1, max: 20 }) +
        '<h3 style="margin-top:18px">What to collect</h3>' + fld('Ask for', 'collect', 'select', { options: [['phone', 'Phone number'], ['email', 'Email'], ['either', 'Phone or email']] }) +
        fld('Required before continuing', 'required', 'check') + fld('Consent text (with a tick)', 'consent_text', 'text', { max: 120 }) +
        fld('Default country', 'country', 'select', { options: [['IN', 'India (+91)'], ['US', 'United States (+1)'], ['GB', 'United Kingdom (+44)'], ['AE', 'UAE (+971)'], ['SG', 'Singapore (+65)'], ['AU', 'Australia (+61)']] }) +
        fld('Reward code shown after', 'reward_code', 'text', { max: 40, ph: 'WELCOME5' }) +
        '<h3 style="margin-top:18px">Look</h3>' + fld('Layout', 'layout', 'select', { options: [['sheet', 'Offer sheet (full-screen on phones)'], ['center', 'Centered'], ['corner', 'Corner card'], ['topbar', 'Top bar']] }) +
        (d.layout === 'corner' ? fld('Corner', 'position', 'select', { options: [['right', 'Bottom right'], ['left', 'Bottom left']] }) : '') + colors + fld('Corner roundness (px)', 'radius', 'range', { min: 0, max: 32 }) +
        (d.layout === 'sheet' ? fld('Top ribbon (optional)', 'ribbon_text', 'text', { max: 40, ph: 'Get up to 60% off' }) : '') +
        '<div class="field"><label>Logo in the popup</label><input type="hidden" id="ppLogo" value="' + esc(d.logo_url || '') + '"><div data-media-for="ppLogo" data-purpose="logo" data-max-side="512" data-hint="empty = your store logo"></div></div>' +
        '<h3 style="margin-top:18px">Text</h3>' + fld('Title', 'title', 'text') + fld('Message (optional)', 'message', 'textarea') +
        '<div class="pp-colors" style="grid-template-columns:1fr 1fr">' + fld('Button', 'button_text', 'text', { max: 30 }) + fld('Skip link', 'skip_text', 'text', { max: 20 }) + '</div>' +
        '<h3 style="margin-top:18px">After they submit</h3>' + fld('Success title', 'success_title', 'text', { max: 50 }) + fld('Success message', 'success_message', 'text', { max: 120 }) + fld('Success button', 'success_button', 'text', { max: 24 }) +
        fld('Show "Powered by Retner.ai"', 'show_brand', 'check');
    }
    html += '<button class="btn primary block" id="popupSave2"' + (ppDirty ? '' : ' disabled') + '><i class="fas fa-check"></i> Save changes</button></div>' +
      '<div class="pp-preview-wrap"><div class="card"><div class="card-head"><h3>Live preview</h3><div class="seg pp-device"><button data-dev="desktop"' + (ppMobile ? '' : ' class="active"') + '>Desktop</button><button data-dev="phone"' + (ppMobile ? ' class="active"' : '') + '>Phone</button></div></div><div id="ppPreview">' + previewHtml(d, ppKind, ppData.store_logo, ppMobile) + '</div><p class="sub" style="margin-top:10px">' + (ppKind === 'lead' ? 'Shown after the subscribe step. On phones it opens as a sheet from the bottom; the number is saved before anything else happens.' : 'On phones every layout opens as a sheet from the bottom. Allow opens the browser\'s own permission prompt.') + '</p></div></div>';
    $('popupEditor').innerHTML = html;
    if (window.RetnerMedia) window.RetnerMedia.attachAll($('popupEditor'));
    $('ppLogo').addEventListener('change', function () { pp().logo_url = $('ppLogo').value; markDirty(); refreshPreview(); });
  }
  function refreshPreview() { var el = $('ppPreview'); if (el) el.innerHTML = previewHtml(pp(), ppKind, ppData.store_logo, ppMobile); }
  var RERENDER = { layout: 1, collect: 1, enabled: 1, trigger: 1 };
  $('popupKind').addEventListener('click', function (e) {
    var b = e.target.closest('[data-kind]'); if (!b) return;
    if (ppDirty && !window.confirm('You have unsaved changes on this popup. Switch anyway?')) return;
    ppKind = b.getAttribute('data-kind'); ppDirty = false;
    document.querySelectorAll('#popupKind button').forEach(function (x) { x.classList.toggle('active', x === b); });
    renderGallery(); renderEditor(); setSaved(true);
  });
  $('popupEditor').addEventListener('input', function (e) {
    var el = e.target.closest('[data-pp]'); if (!el) return;
    var key = el.getAttribute('data-pp');
    pp()[key] = el.type === 'checkbox' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
    var lab = $('popupEditor').querySelector('[data-pp-val="' + key + '"]'); if (lab) lab.textContent = el.value;
    markDirty(); renderFlow();
    if (RERENDER[key]) renderEditor(); else refreshPreview();
  });
  $('popupEditor').addEventListener('click', function (e) {
    var d = e.target.closest('[data-dev]'); if (d) { ppMobile = d.getAttribute('data-dev') === 'phone'; document.querySelectorAll('.pp-device button').forEach(function (b) { b.classList.toggle('active', b === d); }); refreshPreview(); return; }
    if (e.target.closest('#popupSave2')) savePopup();
  });
  $('popupSave').addEventListener('click', savePopup);
  function savePopup() {
    var b = $('popupSave'); b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving…';
    var body = {}; body[ppKind] = pp();
    api('/my-store/popup', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok || !r.data.success) { setSaved(false); return toast(r.data.error || 'Could not save.', 'err'); }
      ppData.push = r.data.push; ppData.lead = r.data.lead; ppDirty = false; ppData.saved = true; $('popupNotice').classList.add('hidden');
      renderFlow(); renderGallery(); renderEditor(); setSaved(true);
      toast('Saved. Shoppers see the change within 5 minutes.', 'ok');
    });
  }
  $('popupGallery').addEventListener('click', function (e) {
    var b = e.target.closest('[data-preset]'); if (!b) return;
    b.disabled = true; b.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Applying…';
    var body = { apply_preset: { kind: ppKind, key: b.getAttribute('data-preset') } };
    if (ppKind === 'lead' && !pp().enabled) body.lead = { enabled: true };
    api('/my-store/popup', { method: 'POST', body: body }).then(function (r) {
      if (!r.ok || !r.data.success) { b.disabled = false; b.textContent = 'Use this design'; return toast(r.data.error || 'Could not apply.', 'err'); }
      ppData.push = r.data.push; ppData.lead = r.data.lead; ppDirty = false; ppData.saved = true; $('popupNotice').classList.add('hidden');
      renderFlow(); renderGallery(); renderEditor(); setSaved(true); toast('Design applied' + (ppKind === 'lead' ? ' and the lead popup is on' : '') + '. Live within 5 minutes.', 'ok');
    });
  });

  // ------------------------------------------------------------ ideas feed
  var ideasItems = [], ideasThemeUrl = '';
  function tipEvent(id, kind, surface) { api('/my-store/tips/' + id + '/event', { method: 'POST', body: { kind: kind, surface: surface || current } }); }
  function loadTipLine() {
    api('/my-store/tips?surface=loading').then(function (r) {
      var t = r.ok && r.data.success && r.data.items && r.data.items[0];
      if (!t) return;
      $('homeTipLine').innerHTML = '<b>Did you know?</b> ' + esc(t.title) + ' <span class="muted">' + esc(t.body) + '</span>';
      tipEvent(t.id, 'shown', 'loading');
    });
  }
  var KIND_LABEL = { onboarding: 'Set-up step', template: 'Ready template', tip: 'Writing tip', feature: 'Feature', idea: 'Idea', season: 'Seasonal', coming_soon: 'Coming soon' };
  function loadIdeas(more) {
    api('/my-store/tips?surface=home&n=' + (more ? 6 : 3)).then(function (r) {
      if (!r.ok || !r.data.success) { $('ideasList').innerHTML = '<div class="muted">Ideas could not be loaded.</div>'; return; }
      ideasItems = r.data.items || []; ideasThemeUrl = r.data.theme_url || '';
      $('ideasSub').textContent = r.data.day !== null && r.data.day <= 3 ? 'Your first days: do these in order.' : 'Fresh every day. Tap one to try it.';
      $('ideasList').innerHTML = ideasItems.length ? ideasItems.map(function (t) {
        return '<div class="idea ' + esc(t.kind) + '" data-idea="' + t.id + '"><span class="kind">' + esc(KIND_LABEL[t.kind] || t.kind) + '</span><b>' + esc(t.title) + '</b><span>' + esc(t.body) + '</span>' +
          (t.cta_label ? '<button class="btn sm' + (t.kind === 'onboarding' ? ' primary' : '') + '" data-idea-go="' + t.id + '">' + esc(t.cta_label) + '</button>' : '') + '</div>';
      }).join('') : '<div class="muted">You have seen every idea for today. Come back tomorrow.</div>';
      ideasItems.forEach(function (t) { tipEvent(t.id, 'shown', 'home'); });
    });
  }
  $('ideasRefresh').addEventListener('click', function () { loadIdeas(true); });
  $('ideasList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-idea-go]'); if (!b) return;
    var id = Number(b.getAttribute('data-idea-go'));
    var t = ideasItems.filter(function (x) { return x.id === id; })[0]; if (!t) return;
    var p = t.cta_params || {};
    if (t.kind === 'coming_soon') { tipEvent(id, 'wanted', 'home'); b.disabled = true; b.innerHTML = '<i class="fas fa-check"></i> Noted, thanks'; toast('Thanks! We count every vote when we pick what to build next.', 'ok'); return; }
    tipEvent(id, 'clicked', 'home');
    if (t.cta_view === 'theme') { window.open(ideasThemeUrl || ('https://' + window.store.id + '.myshopify.com/admin/themes/current/editor?context=apps'), '_blank', 'noopener'); return; }
    if (t.cta_view === 'creator' && (p.title || p.msg || p.type)) { pendingTemplate = { id: id, params: p }; showView('creator'); return; }
    if (t.cta_view === 'automations' && p.automation) { window.__openAutomation = p.automation; showView('automations'); return; }
    showView(t.cta_view || 'home');
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
    var review = (ent && ent.review_url) || 'https://apps.shopify.com/retner-smartpush-live/reviews';
    showModal({
      icon: 'fa-hourglass-end', title: 'Your 7-day free trial has ended',
      html: '<p>Pick the plan you want to continue with: <b>Free</b> (10,000 impressions a month), <b>Growth</b> ($30) or <b>Unlimited</b> ($50). Your subscribers, campaigns and automations are all kept.</p><p>Enjoying Retner? A review on the App Store helps us a lot.</p>',
      actions: [
        { html: '<i class="fas fa-check"></i> Choose a plan', primary: true, onClick: function () { closeModal(); dismissPrompt('trial_ended'); showView('plan'); } },
        { html: '<i class="fas fa-star"></i> Leave a review', onClick: function () { window.open(review, '_blank', 'noopener'); } },
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
    var seen = false; try { seen = !!localStorage.getItem(tourKey()); } catch (e) { /* ignore */ }
    if (window.__startTour || (!seen && !(ent.prompts && ent.prompts.tour_done))) { window.__startTour = false; startTour(0); }
  }

  // ------------------------------------------------------------ guided tour (spotlight, next → next)
  // Each step opens the right view, waits for its target, highlights it and
  // explains it. Progress is per store in localStorage; finishing (or
  // skipping) tells the server so it does not auto-start again.
  var TOUR = [
    { view: 'home', target: '#topnav', place: 'below', title: 'Welcome to Retner SmartPush', text: 'This short tour shows every feature, one step at a time. These tabs are the whole product: <b>Home, Campaigns, Automations, Subscribers, Segments, Analytics</b> and <b>Plan</b>. Click Next to continue.' },
    { view: 'home', target: '#view-home .kpis', place: 'below', title: 'Your numbers at a glance', text: 'Subscribers, notifications sent, clicks and revenue for the last 7, 30 or 90 days, compared with the period before. Revenue comes from orders placed after a notification click.' },
    { view: 'home', target: '#planCard', place: 'left', title: 'Your plan and free trial', text: 'Every store starts with a <b>7-day free trial</b> of Unlimited. Here you see days left, impressions used this month and the upgrade button when the Free plan limit is near.' },
    { view: 'creator', target: '#campTitle', place: 'right', title: 'Step 1 of a campaign: write it', text: 'Pick a template or write your own. Keep the <b>title under 50</b> and the <b>message under 120 characters</b> so nothing is cut off on phones. The preview on the right updates as you type.' },
    { view: 'creator', target: '[data-media-for="campImg"]', place: 'right', title: 'Add images three ways', text: '<b>Upload</b> a file, paste an <b>image link</b>, or <b>choose from your library</b> of images uploaded before. A 2:1 hero image shows on Android and Windows; the icon shows everywhere.' },
    { view: 'creator', target: '#segGrid', place: 'right', title: 'Choose who gets it', text: 'Send to everyone or to a segment such as <b>added to cart</b> or <b>inactive 30+ days</b>. Counts are live. Segments are included in Growth, Unlimited and your trial.' },
    { view: 'creator', target: '#testBtn', place: 'above', title: 'Test it on your own device', text: 'Sends the draft to this browser only, marked [Test], so you see exactly what shoppers will see before anything goes out. Test sends never count against your plan.' },
    { view: 'creator', target: '#btnSend', place: 'above', title: 'Send now or schedule', text: 'Send immediately or pick a date and time. Flash sales can have an end time so late shoppers are not notified about an offer that is over.' },
    { view: 'automations', target: '#automations-root .ra-grid .ra-auto', place: 'right', title: 'Automations run on their own', text: 'Turn on <b>Welcome</b> first (greets every new subscriber), then <b>Cart recovery</b> with a delay and discount. Browse abandonment, win-back, order thank-you, price drop and back-in-stock each have their own text, timing and test button.' },
    { view: 'subscribers', target: '#view-subscribers .kpis', place: 'below', title: 'Watch your audience grow', text: 'Who subscribed, from which browser, when they were last seen, and how sign-ups grow day by day. The Segments card previews the audiences you can target.' },
    { view: 'popups', target: '#popupGallery .pp-card', place: 'right', title: 'Design your subscribe popup', text: 'Nine ready designs, one click to apply. Turn on <b>Collect phone &amp; email</b> and the popup asks for a number before the browser prompt, so you capture a lead even when notifications are blocked.' },
    { view: 'contacts', target: '#view-contacts .kpis', place: 'below', title: 'Every person in one place', text: 'Contacts joins all of a shopper\'s devices with the phone, email and orders we learn from the popup, logins and checkouts. Export to CSV or use it in Retner for WhatsApp and SMS.' },
    { view: 'segments', target: '#segBehaviour .seg-tile', place: 'right', title: 'Ready-made segments', text: 'Counted live from visits, carts and orders. Click <b>Send campaign</b> on any segment to open the creator with that audience selected. On the Free plan the counts stay visible and the cards unlock with an upgrade.' },
    { view: 'analytics', target: '#analytics-root .ra2-kpis', place: 'below', title: 'Measure what worked', text: 'Sends, clicks, click rate and attributed revenue over time, plus your best campaigns and automations. Switch tabs for campaigns, automations and the live event feed.' },
    { view: 'plan', target: '#tiers .tier.recommended, #tiers .tier', place: 'left', title: 'Plans in one place', text: '<b>Free</b> includes 10,000 impressions a month. <b>Growth ($30)</b> adds more and unlocks segments; <b>Unlimited ($50)</b> has no cap. Pick your plan when the trial ends; it applies right away.' },
    { view: 'settings', target: '#view-settings .settings-grid .card', place: 'right', title: 'Last step: your branding', text: 'Store name, logo and contact email appear on every notification. Set a dashboard password to sign in here without Shopify. That is the whole product. You can replay this tour any time from <b>Take a tour</b> in the top bar.' },
  ];
  var tourStep = -1, tourTarget = null, tourTimer = null;
  function tourKey() { return 'tour_done_' + (window.store && window.store.id); }
  function tourActive() { return tourStep >= 0; }
  function startTour(from) {
    tourStep = typeof from === 'number' ? from : 0;
    $('tour').classList.remove('hidden');
    tourShow();
  }
  function endTour(finished) {
    clearTimeout(tourTimer);
    tourTarget = null; tourStep = -1;
    $('tour').classList.add('hidden');
    try { localStorage.setItem(tourKey(), '1'); } catch (e) { /* ignore */ }
    if (!(ent && ent.prompts && ent.prompts.tour_done)) dismissPrompt('tour');
    if (finished) toast('Tour finished. Replay it any time from "Take a tour".', 'ok');
  }
  // Waits until the step's target exists (views load their content asynchronously).
  function waitFor(selector, tries, cb) {
    var el = document.querySelector(selector);
    if (el || tries <= 0) return cb(el);
    tourTimer = setTimeout(function () { waitFor(selector, tries - 1, cb); }, 120);
  }
  function tourShow() {
    var st = TOUR[tourStep]; if (!st) return endTour(true);
    clearTimeout(tourTimer);
    tourTarget = null;
    if (current !== st.view) showView(st.view);
    $('tourCount').textContent = 'Step ' + (tourStep + 1) + ' of ' + TOUR.length;
    $('tourTitle').textContent = st.title;
    $('tourText').innerHTML = st.text;
    $('tourDots').innerHTML = TOUR.map(function (_, i) { return '<span class="' + (i < tourStep ? 'done' : i === tourStep ? 'on' : '') + '"></span>'; }).join('');
    $('tourPrev').disabled = tourStep === 0;
    $('tourNext').innerHTML = tourStep === TOUR.length - 1 ? '<i class="fas fa-check"></i> Finish' : 'Next <i class="fas fa-arrow-right"></i>';
    waitFor(st.target, 15, function (el) {
      tourTarget = el;
      if (el) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); } }
      tourTimer = setTimeout(tourPlace, el ? 320 : 0);
    });
  }
  function tourPlace() {
    if (!tourActive()) return;
    var st = TOUR[tourStep], ring = $('tourRing'), card = $('tourCard');
    var vw = window.innerWidth, vh = window.innerHeight, pad = 8;
    var r = tourTarget ? tourTarget.getBoundingClientRect() : null;
    if (!r || (!r.width && !r.height)) {
      ring.className = 'tour-ring center'; ring.style.cssText = 'top:50%;left:50%;width:0;height:0;';
      card.className = 'tour-card center';
      card.style.left = Math.max(16, (vw - card.offsetWidth) / 2) + 'px';
      card.style.top = Math.max(16, (vh - card.offsetHeight) / 2) + 'px';
      return;
    }
    var top = Math.max(0, r.top - pad), left = Math.max(0, r.left - pad);
    var w = Math.min(vw, r.width + pad * 2), h = Math.min(vh, r.height + pad * 2);
    ring.className = 'tour-ring'; ring.style.cssText = 'top:' + top + 'px;left:' + left + 'px;width:' + w + 'px;height:' + h + 'px;';
    var cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, place = st.place || 'below';
    // A placement "fits" when the whole card stays on screen beside the ring.
    var fits = { below: top + h + gap + ch < vh - 16, above: top - gap - ch > 16, right: left + w + gap + cw < vw - 16, left: left - gap - cw > 16 };
    if (!fits[place]) place = fits.right ? 'right' : fits.left ? 'left' : fits.below ? 'below' : fits.above ? 'above' : 'center';
    var x, y;
    if (place === 'below') { x = left; y = top + h + gap; }
    else if (place === 'above') { x = left; y = top - gap - ch; }
    else if (place === 'right') { x = left + w + gap; y = top; }
    else if (place === 'left') { x = left - gap - cw; y = top; }
    else { x = (vw - cw) / 2; y = (vh - ch) / 2; }
    x = Math.min(Math.max(16, x), vw - cw - 16); y = Math.min(Math.max(16, y), vh - ch - 16);
    // If the ring is so big that nothing fits, shade the page and show the card centred on top of it.
    if (place === 'center') { ring.className = 'tour-ring center'; ring.style.cssText = 'top:50%;left:50%;width:0;height:0;'; }
    card.className = 'tour-card ' + place; card.style.left = x + 'px'; card.style.top = y + 'px';
  }
  $('tourNext').addEventListener('click', function () { if (tourStep >= TOUR.length - 1) return endTour(true); tourStep++; tourShow(); });
  $('tourPrev').addEventListener('click', function () { if (tourStep > 0) { tourStep--; tourShow(); } });
  $('tourSkip').addEventListener('click', function () { endTour(false); });
  window.addEventListener('resize', function () { if (tourActive()) tourPlace(); });
  document.querySelector('.main').addEventListener('scroll', function () { if (tourActive()) tourPlace(); }, { passive: true });
  function openGuide() { startTour(0); }
  function closeGuide() { if (tourActive()) endTour(false); }

  // ------------------------------------------------------------ boot
  if (window.store) initApp(); else $('login').classList.remove('hidden');
})();
