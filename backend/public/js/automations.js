/* Retner SmartPush — Automations dashboard (vanilla JS, no build step).
 * Mounted by the store dashboard: RetnerAutomations.mount(el, { store, api }).
 * api(path, options) -> Promise<{ ok, status, data }> and adds the session token.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ meta
  var META = {
    welcome: {
      name: 'Welcome notification',
      icon: 'fa-hand-sparkles',
      desc: 'Thank new subscribers the moment they say yes to notifications.',
      how: ['Sent once, right after a shopper subscribes.', 'Great place to mention your best offer.'],
      vars: ['store_name'],
    },
    abandoned_cart: {
      name: 'Abandoned cart recovery',
      icon: 'fa-cart-shopping',
      desc: 'Bring shoppers back to the cart they left — with the product photo and a one-tap link that rebuilds their cart.',
      how: [
        'Starts when a subscriber adds something to the cart and leaves.',
        'Up to 3 reminders; the timer restarts whenever they change their cart.',
        'Stops automatically when the cart is emptied or replaced by a new one.',
        'Each subscriber gets at most 3 automated notifications per day.',
      ],
      vars: ['product_name', 'item_count', 'cart_total', 'store_name', 'discount_code'],
    },
    browse_abandonment: {
      name: 'Browse abandonment',
      icon: 'fa-eye',
      desc: 'Remind subscribers about a product they looked at but did not add to the cart.',
      how: [
        'Starts when a subscriber views a product and does not add anything to the cart.',
        'One reminder per browsing session, at most one per day.',
        'Skipped when the shopper already has a cart (cart reminders take over).',
      ],
      vars: ['product_name', 'store_name'],
    },
    winback: {
      name: 'Win-back',
      icon: 'fa-heart',
      desc: 'Re-engage subscribers who have not visited your store for a while.',
      how: [
        'Sent once when a subscriber has not visited for the number of days you choose.',
        'Counts visits from today, so the first win-back messages go out after that many days.',
      ],
      vars: ['store_name', 'discount_code'],
    },
  };

  var SOON = [
    { name: 'Price drop', icon: 'fa-tag', desc: 'Alert shoppers when a product they viewed gets cheaper.', badge: 'Next update' },
    { name: 'Back in stock', icon: 'fa-box-open', desc: 'Tell shoppers the moment a sold-out product they wanted is back.', badge: 'Next update' },
    { name: 'Order thank-you', icon: 'fa-bag-shopping', desc: 'Thank buyers after checkout and stop cart reminders instantly.', badge: 'Next update' },
    { name: 'Shipping updates', icon: 'fa-truck-fast', desc: 'Shipped, out for delivery and delivered notifications.', badge: 'Needs Shopify approval' },
  ];

  var TEMPLATES = {
    en: {
      welcome: { title: 'Welcome to {store_name}! 🎉', body: 'Thanks for subscribing. You will be the first to know about new arrivals and offers.' },
      abandoned_cart: [
        { title: 'You left something behind 🛒', body: '{product_name} is still in your cart. Complete your order before it sells out!', button: 'Complete order' },
        { title: 'Still thinking it over?', body: 'Your cart with {item_count} item(s) worth {cart_total} is saved. Tap to pick up where you left off.', button: 'View my cart' },
        { title: 'Last reminder ⏰', body: 'Your cart is about to expire. Complete your order now!', button: 'Complete order' },
      ],
      browse_abandonment: { title: 'Still interested in {product_name}?', body: 'Take another look before it sells out.', button: 'View product' },
      winback: { title: 'We miss you at {store_name} 💙', body: 'New arrivals are waiting for you. Come take a look!', button: 'Shop now' },
    },
    hi: {
      welcome: { title: '{store_name} mein aapka swagat hai! 🎉', body: 'Subscribe karne ke liye shukriya. Naye products aur offers sabse pehle aapko milenge.' },
      abandoned_cart: [
        { title: 'Aapka cart wait kar raha hai 🛒', body: '{product_name} abhi bhi aapke cart mein hai. Stock khatam hone se pehle order complete karein!', button: 'Order complete karein' },
        { title: 'Abhi bhi soch rahe hain?', body: 'Aapka cart ({item_count} items, {cart_total}) save hai. Tap karke wahin se continue karein.', button: 'Cart dekhein' },
        { title: 'Last reminder ⏰', body: 'Aapka cart jaldi expire hone wala hai. Abhi order karein!', button: 'Order karein' },
      ],
      browse_abandonment: { title: '{product_name} pasand aaya?', body: 'Ek baar phir dekh lijiye — stock limited hai!', button: 'Product dekhein' },
      winback: { title: '{store_name} aapko miss kar raha hai 💙', body: 'Naye products aa gaye hain. Ek nazar daaliye!', button: 'Shop karein' },
    },
  };

  var LIMITS = { title: 80, body: 220, button: 24 };
  var ORDER = ['welcome', 'abandoned_cart', 'browse_abandonment', 'winback'];

  // ------------------------------------------------------------------ state
  var S = { el: null, api: null, store: null, data: null, edit: null, busy: false };

  // --------------------------------------------------------------- helpers
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function num(n) { return Number(n || 0).toLocaleString('en-IN'); }
  function ctr(s) { return s && s.sent ? ((s.clicks / s.sent) * 100).toFixed(1) + '%' : '—'; }

  function splitDelay(min) {
    min = Number(min) || 0;
    if (min >= 1440 && min % 1440 === 0) return { value: min / 1440, unit: 'days' };
    if (min >= 60 && min % 60 === 0) return { value: min / 60, unit: 'hours' };
    return { value: min, unit: 'minutes' };
  }
  function toMinutes(value, unit) {
    var v = Number(value) || 0;
    return Math.round(unit === 'days' ? v * 1440 : unit === 'hours' ? v * 60 : v);
  }
  function delayLabel(min) {
    var d = splitDelay(min);
    var unit = d.value === 1 ? d.unit.replace(/s$/, '') : d.unit;
    return d.value + ' ' + unit;
  }
  function ago(iso) {
    if (!iso) return 'never';
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    return h < 48 ? h + ' h ago' : Math.round(h / 24) + ' days ago';
  }

  function sampleVars() {
    var code = '';
    if (S.edit) {
      var c = currentFormConfig();
      code = c.discount_code || '';
    }
    return {
      product_name: 'Classic Cotton T-Shirt',
      item_count: 2,
      cart_total: '₹1,299',
      store_name: (S.store && S.store.name) || 'Your Store',
      discount_code: code,
    };
  }
  function render(str, vars) {
    return String(str || '').replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ''; }).replace(/\s{2,}/g, ' ').trim();
  }

  function isOn(key) {
    var a = S.data && S.data.automations && S.data.automations[key];
    return !!(a && a.enabled);
  }
  function needsReview(key) {
    var a = S.data && S.data.automations && S.data.automations[key];
    return !!(a && a.needs_review);
  }

  // ------------------------------------------------------------- loading
  function load() {
    S.el.innerHTML = '<div class="ra"><div class="ra-loading"><i class="fas fa-spinner fa-spin"></i> Loading automations…</div></div>';
    return S.api('/my-store/automations').then(function (r) {
      if (!r.ok || !r.data.success) {
        S.el.innerHTML = '<div class="ra"><div class="ra-alert ra-alert-err">Could not load automations. ' + esc(r.data.error || '') + ' <button class="ra-btn" data-act="reload">Try again</button></div></div>';
        return;
      }
      S.data = r.data;
      if (S.edit) renderEditor(); else renderList();
    });
  }

  // ------------------------------------------------------------- list view
  function checklistItem(state, title, text) {
    var icon = state === 'ok' ? 'fa-circle-check' : state === 'warn' ? 'fa-circle-exclamation' : 'fa-circle-info';
    return '<div class="ra-check ra-check-' + state + '"><i class="fas ' + icon + '"></i><div><div class="ra-check-title">' + esc(title) + '</div><div class="ra-check-text">' + text + '</div></div></div>';
  }

  function renderChecklist() {
    var h = S.data.health || {};
    var popupOk = h.new_subscribers_7d > 0 || h.visitors_seen_24h > 0;
    var trackOk = h.carts_tracked_7d > 0 || h.product_views_7d > 0 || h.visitors_seen_24h > 0;
    return '<section class="ra-card ra-checklist"><h3>Setup checklist</h3><div class="ra-checks">' +
      checklistItem(popupOk ? 'ok' : 'warn', 'Push popup is live on your store',
        popupOk ? esc(num(h.new_subscribers_7d)) + ' new subscribers this week · ' + esc(num(h.subscribers)) + ' total'
          : 'No new subscribers this week. Make sure the <b>Retner SmartPush</b> app embed is on: Shopify admin → Online Store → Themes → Customize → App embeds.') +
      checklistItem(trackOk ? 'ok' : 'warn', 'Shopper activity tracking',
        trackOk ? esc(num(h.carts_tracked_7d)) + ' carts and ' + esc(num(h.product_views_7d)) + ' product views tracked in 7 days'
          : 'Waiting for the first subscriber to visit your store after this update (usually within a few hours).') +
      checklistItem(h.engine_ok ? 'ok' : 'warn', 'Automation engine',
        h.engine_ok ? 'Running every 5 minutes · last run ' + esc(ago(h.engine_last_run)) : 'Not running yet' + (h.engine_last_run ? ' · last run ' + esc(ago(h.engine_last_run)) : '') + '. It starts automatically after deployment.') +
      checklistItem('info', 'Stop reminders after purchase',
        'Reminders stop when a cart is emptied or replaced. Instant order detection arrives in the next update.') +
      '</div></section>';
  }

  function statusPill(key) {
    if (needsReview(key)) return '<span class="ra-pill ra-pill-warn">Review needed</span>';
    return isOn(key) ? '<span class="ra-pill ra-pill-on">On</span>' : '<span class="ra-pill">Off</span>';
  }

  function card(key) {
    var m = META[key];
    var s = (S.data.stats && S.data.stats[key]) || { sent: 0, clicks: 0 };
    var extra = '';
    if (key === 'abandoned_cart') extra = '<div class="ra-stat"><b>' + esc(num(S.data.health.open_carts)) + '</b><span>Open carts</span></div>';
    if (key === 'welcome' && s.sent_all_time) extra = '<div class="ra-stat"><b>' + esc(num(s.sent_all_time)) + '</b><span>Sent all-time</span></div>';
    var review = needsReview(key)
      ? '<div class="ra-note">We imported your old settings. Please review the text and timing, then turn it on.</div>' : '';
    return '<div class="ra-card ra-auto" data-key="' + key + '">' +
      '<div class="ra-auto-head"><div class="ra-icon"><i class="fas ' + m.icon + '"></i></div>' +
      '<div class="ra-auto-title"><div class="ra-row"><h4>' + esc(m.name) + '</h4>' + statusPill(key) + '</div><p>' + esc(m.desc) + '</p></div></div>' +
      review +
      '<div class="ra-stats"><div class="ra-stat"><b>' + esc(num(s.sent)) + '</b><span>Sent (30 days)</span></div>' +
      '<div class="ra-stat"><b>' + esc(num(s.clicks)) + '</b><span>Clicks</span></div>' +
      '<div class="ra-stat"><b>' + esc(ctr(s)) + '</b><span>Click rate</span></div>' + extra + '</div>' +
      '<div class="ra-auto-foot"><label class="ra-switch" title="Turn on/off"><input type="checkbox" data-act="toggle" data-key="' + key + '"' + (isOn(key) ? ' checked' : '') + '><span></span></label>' +
      '<span class="ra-foot-text">' + (isOn(key) ? 'Running automatically' : 'Turned off') + '</span>' +
      '<button class="ra-btn" data-act="edit" data-key="' + key + '"><i class="fas fa-pen"></i> ' + (isOn(key) ? 'Edit' : 'Set up') + '</button></div>' +
      '</div>';
  }

  function renderList() {
    var html = '<div class="ra">' +
      '<div class="ra-head"><div><h2>Automations</h2><p>Set them up once — they run on their own every 5 minutes.</p></div>' +
      '<button class="ra-btn ra-btn-ghost" data-act="reload"><i class="fas fa-rotate"></i> Refresh</button></div>' +
      renderChecklist() +
      '<div class="ra-grid">' + ORDER.map(card).join('') + '</div>' +
      '<h3 class="ra-subhead">Coming next</h3><div class="ra-grid">' +
      SOON.map(function (c) {
        return '<div class="ra-card ra-auto ra-soon"><div class="ra-auto-head"><div class="ra-icon"><i class="fas ' + c.icon + '"></i></div>' +
          '<div class="ra-auto-title"><div class="ra-row"><h4>' + esc(c.name) + '</h4><span class="ra-pill">' + esc(c.badge) + '</span></div><p>' + esc(c.desc) + '</p></div></div></div>';
      }).join('') + '</div></div>';
    S.el.innerHTML = html;
  }

  // ------------------------------------------------------------- editor
  function openEditor(key) {
    var cfg = clone(S.data.automations[key] || {});
    if (key === 'abandoned_cart') {
      cfg.steps = (cfg.steps || []).slice(0, 3);
      while (cfg.steps.length < 3) {
        var t = TEMPLATES.en.abandoned_cart[cfg.steps.length];
        cfg.steps.push({ enabled: false, delay_minutes: [60, 1440, 4320][cfg.steps.length], title: t.title, body: t.body, button: t.button, image: '', discount_code: '' });
      }
    }
    S.edit = { key: key, cfg: cfg, step: 0, focus: 'body', errors: [], msg: null };
    renderEditor();
    window.scrollTo(0, 0);
  }

  function stepConfig() {
    var e = S.edit;
    return e.key === 'abandoned_cart' ? e.cfg.steps[e.step] : e.cfg;
  }

  function currentFormConfig() {
    var e = S.edit;
    if (!e) return {};
    return stepConfig();
  }

  function fieldHtml(label, id, value, opts) {
    opts = opts || {};
    var max = opts.max ? ' maxlength="' + opts.max + '"' : '';
    var counter = opts.max ? '<span class="ra-count" data-count-for="' + id + '">' + String(value || '').length + '/' + opts.max + '</span>' : '';
    var input = opts.textarea
      ? '<textarea id="' + id + '" data-field="' + opts.field + '" rows="3"' + max + ' placeholder="' + esc(opts.placeholder || '') + '">' + esc(value) + '</textarea>'
      : '<input id="' + id + '" type="' + (opts.type || 'text') + '" data-field="' + opts.field + '" value="' + esc(value) + '"' + max + ' placeholder="' + esc(opts.placeholder || '') + '">';
    return '<div class="ra-field"><div class="ra-label-row"><label for="' + id + '">' + esc(label) + '</label>' + counter + '</div>' + input +
      (opts.hint ? '<div class="ra-hint">' + opts.hint + '</div>' : '') + '</div>';
  }

  function timelineHtml() {
    var e = S.edit;
    if (e.key !== 'abandoned_cart') return '';
    var items = e.cfg.steps.map(function (st, i) {
      return '<div class="ra-line"></div><button class="ra-step' + (i === e.step ? ' ra-step-active' : '') + '" data-act="step" data-step="' + i + '">' +
        '<div class="ra-step-title">Reminder ' + (i + 1) + '</div>' +
        '<div class="ra-step-meta">' + (st.enabled ? 'After ' + esc(delayLabel(st.delay_minutes)) : 'Off') + '</div>' +
        '<span class="ra-pill ' + (st.enabled ? 'ra-pill-on' : '') + '">' + (st.enabled ? 'On' : 'Off') + '</span></button>';
    }).join('');
    return '<div class="ra-card ra-timeline"><div class="ra-step ra-step-trigger"><div class="ra-step-title"><i class="fas fa-bolt"></i> Trigger</div>' +
      '<div class="ra-step-meta">Subscriber adds to cart and leaves</div></div>' + items +
      '<div class="ra-hint" style="margin-top:12px">Wait times count from the shopper\'s last cart activity.</div></div>';
  }

  function formHtml() {
    var e = S.edit;
    var key = e.key;
    var c = stepConfig();
    var html = '';
    if (key === 'abandoned_cart') {
      html += '<div class="ra-form-head"><h3>Reminder ' + (e.step + 1) + '</h3><label class="ra-switch-row">Send this reminder <span class="ra-switch"><input type="checkbox" data-field="enabled"' + (c.enabled ? ' checked' : '') + '><span></span></span></label></div>';
    } else {
      html += '<div class="ra-form-head"><h3>Message</h3></div>';
    }

    if (key === 'abandoned_cart' || key === 'browse_abandonment') {
      var d = splitDelay(c.delay_minutes);
      html += '<div class="ra-field"><label>Send after</label><div class="ra-inline">' +
        '<input type="number" min="1" data-field="delay_value" value="' + esc(d.value) + '" style="width:90px">' +
        '<select data-field="delay_unit">' + ['minutes', 'hours', 'days'].map(function (u) { return '<option value="' + u + '"' + (u === d.unit ? ' selected' : '') + '>' + u + '</option>'; }).join('') + '</select>' +
        '</div><div class="ra-hint">' + (key === 'abandoned_cart' ? 'Recommended: 1 hour, then 1 day, then 3 days.' : 'Recommended: 2 hours after the product view.') + '</div></div>';
    }
    if (key === 'winback') {
      html += '<div class="ra-field"><label>Send when a subscriber has not visited for</label><div class="ra-inline">' +
        '<input type="number" min="7" max="180" data-field="inactive_days" value="' + esc(c.inactive_days) + '" style="width:90px"><span>days</span></div>' +
        '<div class="ra-hint">Between 7 and 180 days. Recommended: 30.</div></div>';
    }

    html += '<div class="ra-templates">Use template: <button class="ra-link" data-act="tpl" data-lang="en">English</button> · <button class="ra-link" data-act="tpl" data-lang="hi">Hinglish</button></div>';
    html += fieldHtml('Title', 'ra-f-title', c.title, { field: 'title', max: LIMITS.title });
    html += fieldHtml('Message', 'ra-f-body', c.body, { field: 'body', max: LIMITS.body, textarea: true });
    html += '<div class="ra-chips"><span>Insert:</span>' + META[key].vars.map(function (v) {
      return '<button class="ra-chip" data-act="var" data-var="' + v + '">{' + v + '}</button>';
    }).join('') + '</div>';
    if (key !== 'welcome') {
      html += fieldHtml('Button text', 'ra-f-button', c.button, { field: 'button', max: LIMITS.button });
    }
    if (key === 'abandoned_cart' || key === 'browse_abandonment') {
      html += fieldHtml('Image (optional)', 'ra-f-image', c.image, { field: 'image', placeholder: 'https://…', hint: 'Leave empty to show the product photo automatically.' });
    }
    if (key === 'abandoned_cart' || key === 'winback') {
      html += fieldHtml('Discount code (optional)', 'ra-f-discount', c.discount_code, {
        field: 'discount_code', placeholder: 'e.g. COMEBACK10',
        hint: 'Create the code first in Shopify admin → Discounts. It is applied automatically when the shopper taps.',
      });
    }
    return html;
  }

  function previewHtml() {
    var c = stepConfig();
    var v = sampleVars();
    var title = render(c.title, v) || 'Title';
    var body = render(c.body, v) || 'Message';
    var img = c.image || (S.edit.key === 'abandoned_cart' || S.edit.key === 'browse_abandonment' ? 'product' : '');
    var imgHtml = img === 'product'
      ? '<div class="ra-pv-img ra-pv-img-ph"><i class="fas fa-shirt"></i><span>Product photo</span></div>'
      : img ? '<img class="ra-pv-img" src="' + esc(img) + '" alt="">' : '';
    var btn = S.edit.key === 'welcome' ? 'Visit store' : (c.button || 'Open');
    var domain = (S.store && S.store.domain) || 'yourstore.com';
    return '<div class="ra-card ra-preview"><h4>Live preview</h4>' +
      '<div class="ra-pv-label">Android</div><div class="ra-pv-android">' +
      '<div class="ra-pv-app"><i class="fab fa-chrome"></i> Chrome · ' + esc(domain) + ' · now</div>' +
      '<div class="ra-pv-title">' + esc(title) + '</div><div class="ra-pv-body">' + esc(body) + '</div>' + imgHtml +
      '<div class="ra-pv-actions">' + esc(btn).toUpperCase() + '</div></div>' +
      '<div class="ra-pv-label">Windows / Mac</div><div class="ra-pv-desktop"><div class="ra-pv-logo"><i class="fas fa-store"></i></div><div>' +
      '<div class="ra-pv-title">' + esc(title) + '</div><div class="ra-pv-body">' + esc(body) + '</div><div class="ra-pv-site">' + esc(domain) + '</div>' +
      '<div class="ra-pv-dbtn">' + esc(btn) + '</div></div></div>' +
      '<div class="ra-hint" style="margin-top:10px">Preview uses sample data. Real notifications show the shopper\'s own product, cart total and store logo.</div></div>';
  }

  function renderEditor() {
    var e = S.edit;
    var m = META[e.key];
    var on = isOn(e.key);
    var errors = e.errors.length ? '<div class="ra-alert ra-alert-err"><b>Please fix:</b><ul>' + e.errors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' : '';
    var msg = e.msg ? '<div class="ra-alert ra-alert-' + e.msg.type + '">' + esc(e.msg.text) + '</div>' : '';
    var review = needsReview(e.key) ? '<div class="ra-alert ra-alert-warn">These are your old settings. Check the text and timing of every reminder so no old test text reaches shoppers, then save and turn it on.</div>' : '';

    S.el.innerHTML = '<div class="ra">' +
      '<div class="ra-head"><div class="ra-row"><button class="ra-btn ra-btn-ghost" data-act="back"><i class="fas fa-arrow-left"></i> Back</button>' +
      '<h2 style="margin:0 0 0 8px">' + esc(m.name) + '</h2>' + statusPill(e.key) + '</div></div>' +
      review + errors + msg +
      '<div class="ra-how"><b>How it works:</b><ul>' + m.how.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>' +
      '<div class="ra-editor' + (e.key === 'abandoned_cart' ? ' ra-editor-3' : '') + '">' +
      timelineHtml() +
      '<div class="ra-card ra-form">' + formHtml() + '</div>' +
      '<div class="ra-preview-col">' + previewHtml() + '</div>' +
      '</div>' +
      '<div class="ra-actions">' +
      '<button class="ra-btn" data-act="test"><i class="fas fa-paper-plane"></i> Send test to this browser</button>' +
      '<span class="ra-spacer"></span>' +
      '<button class="ra-btn" data-act="save" data-enable="keep">Save</button>' +
      (on ? '<button class="ra-btn ra-btn-danger" data-act="save" data-enable="off">Turn off</button>'
        : '<button class="ra-btn ra-btn-primary" data-act="save" data-enable="on">Save &amp; turn on</button>') +
      '</div></div>';

    var f = S.el.querySelector('[data-field="' + e.focus + '"]');
    if (f && document.activeElement !== f && e.focusRestore) { f.focus(); e.focusRestore = false; }
  }

  function refreshPreviewOnly() {
    var col = S.el.querySelector('.ra-preview-col');
    if (col) col.innerHTML = previewHtml();
    var tl = S.el.querySelector('.ra-timeline');
    if (tl) tl.outerHTML = timelineHtml();
  }

  // Read one form control into the edited config.
  function applyField(el) {
    var field = el.getAttribute('data-field');
    var c = stepConfig();
    if (!field) return;
    if (field === 'enabled') c.enabled = el.checked;
    else if (field === 'delay_value' || field === 'delay_unit') {
      var val = S.el.querySelector('[data-field="delay_value"]').value;
      var unit = S.el.querySelector('[data-field="delay_unit"]').value;
      c.delay_minutes = toMinutes(val, unit);
    } else if (field === 'inactive_days') c.inactive_days = Number(el.value) || 0;
    else c[field] = el.value;

    var counter = S.el.querySelector('[data-count-for="' + el.id + '"]');
    if (counter) counter.textContent = el.value.length + '/' + el.getAttribute('maxlength');
  }

  function insertVar(name) {
    var e = S.edit;
    var fieldName = e.focus === 'title' ? 'title' : 'body';
    var el = S.el.querySelector('[data-field="' + fieldName + '"]');
    if (!el) return;
    var token = '{' + name + '}';
    var start = el.selectionStart != null ? el.selectionStart : el.value.length;
    var end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + token + el.value.slice(end);
    applyField(el);
    el.focus();
    el.selectionStart = el.selectionEnd = start + token.length;
    refreshPreviewOnly();
  }

  function applyTemplate(lang) {
    var e = S.edit;
    var t = TEMPLATES[lang][e.key];
    if (e.key === 'abandoned_cart') {
      var st = t[e.step];
      Object.assign(e.cfg.steps[e.step], { title: st.title, body: st.body, button: st.button });
    } else {
      Object.assign(e.cfg, t);
    }
    renderEditor();
  }

  function configForSave(enableMode) {
    var e = S.edit;
    var cfg = clone(e.cfg);
    delete cfg.needs_review;
    delete cfg.imported_from_legacy;
    if (enableMode === 'on') cfg.enabled = true;
    else if (enableMode === 'off') cfg.enabled = false;
    else cfg.enabled = isOn(e.key) && !needsReview(e.key);
    if (enableMode === 'on' && e.key === 'abandoned_cart' && !cfg.steps.some(function (s) { return s.enabled; })) {
      cfg.steps[0].enabled = true;
    }
    return cfg;
  }

  function save(enableMode) {
    if (S.busy) return;
    var e = S.edit;
    S.busy = true;
    e.errors = [];
    e.msg = { type: 'info', text: 'Saving…' };
    renderEditor();
    var cfg = configForSave(enableMode);
    S.api('/my-store/automations', { method: 'POST', body: { automation: e.key, config: cfg } }).then(function (r) {
      S.busy = false;
      if (!r.ok || !r.data.success) {
        e.msg = null;
        e.errors = r.data.errors || [r.data.error || 'Could not save. Please try again.'];
        renderEditor();
        return;
      }
      e.cfg = clone(r.data.config);
      if (e.key === 'abandoned_cart') { while (e.cfg.steps.length < 3) e.cfg.steps.push({ enabled: false, delay_minutes: [60, 1440, 4320][e.cfg.steps.length], title: '', body: '', button: 'Complete order', image: '', discount_code: '' }); }
      e.msg = { type: 'ok', text: cfg.enabled ? 'Saved. This automation is now running.' : 'Saved. This automation is turned off.' };
      return S.api('/my-store/automations').then(function (r2) {
        if (r2.ok && r2.data.success) S.data = r2.data;
        renderEditor();
      });
    });
  }

  function quickToggle(key, checked) {
    if (checked && needsReview(key)) { openEditor(key); return; }
    var cfg = clone(S.data.automations[key]);
    cfg.enabled = checked;
    delete cfg.needs_review;
    delete cfg.imported_from_legacy;
    S.api('/my-store/automations', { method: 'POST', body: { automation: key, config: cfg } }).then(function (r) {
      if (!r.ok || !r.data.success) {
        alert('Could not update: ' + ((r.data.errors || [r.data.error]).join('\n') || 'unknown error') + '\nOpen “Set up” to fix it.');
      }
      load();
    });
  }

  // ------------------------------------------------------- test notification
  function urlBase64ToUint8Array(base64) {
    var padding = '='.repeat((4 - (base64.length % 4)) % 4);
    var raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function testSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') {
      return Promise.reject(new Error('This browser does not support push notifications. Try Chrome or Edge on a computer.'));
    }
    return Notification.requestPermission().then(function (perm) {
      if (perm !== 'granted') throw new Error('Please allow notifications for this page (click the lock icon in the address bar), then try again.');
      return navigator.serviceWorker.register('/sw.js', { scope: '/' });
    }).then(function () { return navigator.serviceWorker.ready; }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (sub) {
        if (sub) return sub;
        return fetch('/api/vapid-public-key').then(function (r) { return r.json(); }).then(function (k) {
          if (!k.publicKey) throw new Error('Push is not configured on the server.');
          return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(k.publicKey) });
        });
      });
    }).then(function (sub) { return sub.toJSON(); });
  }

  function sendTest() {
    var e = S.edit;
    e.msg = { type: 'info', text: 'Sending a test notification to this browser…' };
    e.errors = [];
    renderEditor();
    testSubscription().then(function (sub) {
      var cfg = configForSave('keep');
      return S.api('/my-store/automation-test', { method: 'POST', body: { automation: e.key, step: e.step, subscription: sub, config: cfg } });
    }).then(function (r) {
      e.msg = r.ok && r.data.success
        ? { type: 'ok', text: 'Test sent! It should appear within a few seconds (check your notification centre).' }
        : { type: 'err', text: 'Test failed: ' + (r.data.error || 'unknown error') };
      renderEditor();
    }).catch(function (err) {
      e.msg = { type: 'err', text: err.message };
      renderEditor();
    });
  }

  // ------------------------------------------------------------- events
  function onClick(ev) {
    var t = ev.target.closest('[data-act]');
    if (!t || !S.el.contains(t)) return;
    var act = t.getAttribute('data-act');
    if (act === 'toggle') return; // handled by change
    ev.preventDefault();
    if (act === 'reload') load();
    else if (act === 'edit') openEditor(t.getAttribute('data-key'));
    else if (act === 'back') { S.edit = null; load(); }
    else if (act === 'step') { S.edit.step = Number(t.getAttribute('data-step')); S.edit.msg = null; renderEditor(); }
    else if (act === 'var') insertVar(t.getAttribute('data-var'));
    else if (act === 'tpl') applyTemplate(t.getAttribute('data-lang'));
    else if (act === 'save') save(t.getAttribute('data-enable'));
    else if (act === 'test') sendTest();
  }

  function onInput(ev) {
    var el = ev.target;
    if (!S.edit || !el.getAttribute || !el.getAttribute('data-field')) return;
    applyField(el);
    refreshPreviewOnly();
  }

  function onChange(ev) {
    var el = ev.target;
    if (el.getAttribute && el.getAttribute('data-act') === 'toggle') {
      quickToggle(el.getAttribute('data-key'), el.checked);
      return;
    }
    if (!S.edit || !el.getAttribute || !el.getAttribute('data-field')) return;
    applyField(el);
    if (el.getAttribute('data-field') === 'enabled') renderEditor(); else refreshPreviewOnly();
  }

  function onFocus(ev) {
    var f = ev.target.getAttribute && ev.target.getAttribute('data-field');
    if (S.edit && (f === 'title' || f === 'body')) S.edit.focus = f;
  }

  // ------------------------------------------------------------- public
  window.RetnerAutomations = {
    mount: function (el, opts) {
      if (!el) return;
      if (S.el !== el) {
        S.el = el;
        el.addEventListener('click', onClick);
        el.addEventListener('input', onInput);
        el.addEventListener('change', onChange);
        el.addEventListener('focusin', onFocus);
      }
      S.api = opts.api;
      S.store = opts.store;
      S.edit = null;
      load();
    },
  };
})();
