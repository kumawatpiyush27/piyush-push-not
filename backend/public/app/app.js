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
  var VIEWS = ['home', 'campaigns', 'creator', 'subscribers', 'analytics', 'automations', 'settings'];
  var ALIAS = { dashboard: 'home', campaign: 'creator', history: 'campaigns', 'automation-editor': 'automations' };
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
    window.scrollTo({ top: 0 });
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
  $('helpBtn').addEventListener('click', function () { window.open('https://retner.ai', '_blank'); });
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
    var q = new URLSearchParams(window.location.search).get('view');
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
      if (u && u.limit !== undefined) {
        var pct = Math.min(100, Number(u.percent) || 0);
        $('planName').textContent = (Number(u.limit) >= 50000 ? 'Growth plan' : 'Starter plan');
        $('planText').textContent = num(u.used) + ' of ' + num(u.limit) + ' notifications used this month';
        $('planBar').className = 'bar' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
        $('planBar').firstElementChild.style.width = pct + '%';
        $('planFoot').textContent = (u.resets_on ? 'Resets on ' + new Date(u.resets_on).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) + ' · ' : '') + num(u.remaining) + ' left';
        bellText = pct >= 80 ? 'You have used ' + pct + '% of this month\'s notifications.' : '';
        $('bellDot').classList.toggle('hidden', pct < 80);
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
    $('btnSend').addEventListener('click', sendCampaign);
    $('testBtn').addEventListener('click', sendTest);
    counters();
  }
  loaders.creator = function () {
    api('/my-store/stats').then(function (r) { $('estReach').textContent = r.ok ? num(r.data.subscribers) : '—'; });
    if (window.RetnerCampaigns) window.RetnerCampaigns.onScheduleMode(scheduleMode);
    preview();
  };
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
      image: val('campImg'), icon: val('campIcon'), type: cType, schedule: scheduleMode,
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
    if (!window.confirm((scheduleMode === 'later' ? 'Schedule this campaign for ' + when : 'Send this campaign now') + ' to ' + reach + ' subscribers?')) return;
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

  // ------------------------------------------------------------ boot
  if (window.store) initApp(); else $('login').classList.remove('hidden');
})();
