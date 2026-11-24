/* Campaign preview: how the notification looks on Android, Windows, macOS and
 * iPhone. Reads the campaign form fields (campTitle, campMsg, campImg,
 * campIcon, campUrl, btn1Txt, btn2Txt) and renders into #rpPreview.
 * Mockups are approximate: each platform decides the final look.
 */
(function () {
  'use strict';

  var DEVICES = [
    { key: 'android', label: 'Android', icon: 'fab fa-android' },
    { key: 'windows', label: 'Windows', icon: 'fab fa-windows' },
    { key: 'mac', label: 'macOS', icon: 'fab fa-apple' },
    { key: 'ios', label: 'iPhone', icon: 'fas fa-mobile-screen-button' },
  ];
  var NOTES = {
    android: 'Chrome on Android shows the big image and up to 2 buttons when the notification is expanded. Collapsed, the title gets about 1 line and the message about 2.',
    windows: 'Chrome and Edge on Windows show the big image on top and up to 2 buttons.',
    mac: 'macOS does not show the big image. Buttons appear under "Options".',
    ios: 'iPhone (iOS 16.4+) only shows notifications to shoppers who added your store to their Home Screen. No big image or buttons.',
  };
  var state = { device: 'android', logo: '', name: '', loaded: false };

  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el && typeof el.value === 'string' ? el.value.trim() : ''; }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function https(u) { return /^https:\/\/\S+$/.test(u || '') ? u : ''; }
  function currentStore() {
    try { return typeof store !== 'undefined' && store ? store : null; } catch (e) { return null; }
  }
  function domain() {
    var link = val('campUrl');
    if (link) {
      try { return new URL(/^[a-z]+:/i.test(link) ? link : 'https://' + link).hostname.replace(/^www\./, ''); } catch (e) { /* fall through */ }
    }
    var s = currentStore();
    return (s && s.domain) || 'yourstore.com';
  }
  function storeName() {
    var s = currentStore();
    return state.name || (s && s.name) || 'Your store';
  }

  // Store logo + real name for the icon fallback (once).
  function loadDetails() {
    if (state.loaded) return;
    state.loaded = true;
    fetch('/my-store/details').then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.store) {
        state.logo = https(d.store.logo_url);
        if (d.store.store_name) state.name = d.store.store_name;
        render();
      }
    }).catch(function () { /* preview still works without it */ });
  }

  function data() {
    return {
      title: val('campTitle') || 'Your notification title',
      body: val('campMsg') || 'Your message appears here. Keep it short and clear.',
      image: https(val('campImg')),
      icon: https(val('campIcon')) || state.logo,
      buttons: [val('btn1Txt'), val('btn2Txt')].filter(Boolean).slice(0, 2),
      domain: domain(),
      name: storeName(),
    };
  }

  function iconImg(cls, src) {
    return src ? '<img class="' + cls + '" src="' + esc(src) + '" alt="">'
      : '<span class="' + cls + ' rp-icon-ph"><i class="fas fa-bell"></i></span>';
  }

  function android(d) {
    return '<div class="rp-shade"><div class="rp-a">' +
      '<div class="rp-a-top"><span class="rp-a-app"><i class="fab fa-chrome"></i></span><span>Chrome</span><span class="rp-sep">•</span>' +
      '<span class="rp-a-dom">' + esc(d.domain) + '</span><span class="rp-sep">•</span><span>now</span><i class="fas fa-chevron-up rp-a-chev"></i></div>' +
      '<div class="rp-a-main"><div class="rp-a-text"><div class="rp-a-title">' + esc(d.title) + '</div><div class="rp-a-body">' + esc(d.body) + '</div></div>' +
      iconImg('rp-a-icon', d.icon) + '</div>' +
      (d.image ? '<img class="rp-a-img" src="' + esc(d.image) + '" alt="">' : '') +
      '<div class="rp-a-actions">' + d.buttons.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '<span>Site settings</span></div>' +
      '</div></div>';
  }

  function windows(d) {
    return '<div class="rp-desk rp-desk-win"><div class="rp-w">' +
      '<div class="rp-w-top"><i class="fab fa-chrome"></i><span>Google Chrome</span><span class="rp-w-ctl"><i class="fas fa-ellipsis"></i><i class="fas fa-xmark"></i></span></div>' +
      (d.image ? '<img class="rp-w-hero" src="' + esc(d.image) + '" alt="">' : '') +
      '<div class="rp-w-main">' + iconImg('rp-w-icon', d.icon) +
      '<div class="rp-w-text"><div class="rp-w-title">' + esc(d.title) + '</div><div class="rp-w-body">' + esc(d.body) + '</div><div class="rp-w-dom">' + esc(d.domain) + '</div></div></div>' +
      (d.buttons.length ? '<div class="rp-w-actions">' + d.buttons.map(function (b) { return '<span>' + esc(b) + '</span>'; }).join('') + '</div>' : '') +
      '</div></div>';
  }

  function mac(d) {
    return '<div class="rp-desk rp-desk-mac"><div class="rp-m">' +
      '<span class="rp-m-app"><i class="fab fa-chrome"></i></span>' +
      '<div class="rp-m-text"><div class="rp-m-row"><span class="rp-m-title">' + esc(d.title) + '</span><span class="rp-m-time">now</span></div>' +
      '<div class="rp-m-dom">' + esc(d.domain) + '</div><div class="rp-m-body">' + esc(d.body) + '</div>' +
      (d.buttons.length ? '<span class="rp-m-opt">Options <i class="fas fa-chevron-down"></i></span>' : '') + '</div>' +
      (d.icon ? '<img class="rp-m-thumb" src="' + esc(d.icon) + '" alt="">' : '') +
      '</div></div>';
  }

  function ios(d) {
    return '<div class="rp-phone"><div class="rp-i-clock">9:41</div><div class="rp-i-date">' +
      esc(new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })) + '</div>' +
      '<div class="rp-i">' + iconImg('rp-i-icon', d.icon) +
      '<div class="rp-i-text"><div class="rp-i-row"><span class="rp-i-app">' + esc(d.name) + '</span><span class="rp-i-time">now</span></div>' +
      '<div class="rp-i-title">' + esc(d.title) + '</div><div class="rp-i-body">' + esc(d.body) + '</div></div></div></div>';
  }

  function warnings(d) {
    var w = [];
    if (val('campTitle').length > 50) w.push('Long title: Android and Windows may cut it off after about 50 characters.');
    if (val('campMsg').length > 120) w.push('Long message: most devices show about 120 characters before cutting it off.');
    if (!d.icon) w.push('Add an icon or a store logo (Settings) so shoppers recognise your store.');
    return w.map(function (t) { return '<div class="rp-warn"><i class="fas fa-triangle-exclamation"></i> ' + esc(t) + '</div>'; }).join('');
  }

  function render() {
    var root = $('rpPreview');
    if (!root) return;
    loadDetails();
    var d = data();
    var view = { android: android, windows: windows, mac: mac, ios: ios }[state.device](d);
    root.innerHTML =
      '<div class="rp-head"><h3>Preview</h3><span class="rp-sub">How shoppers will see it</span></div>' +
      '<div class="rp-tabs" role="tablist">' + DEVICES.map(function (x) {
        return '<button type="button" role="tab" class="rp-tab' + (x.key === state.device ? ' active' : '') + '" data-dev="' + x.key + '" aria-selected="' + (x.key === state.device) + '">' +
          '<i class="' + x.icon + '"></i><span>' + x.label + '</span></button>';
      }).join('') + '</div>' +
      '<div class="rp-stage">' + view + '</div>' +
      '<div class="rp-note"><i class="fas fa-circle-info"></i> ' + esc(NOTES[state.device]) + '</div>' +
      warnings(d);
  }

  document.addEventListener('click', function (e) {
    var tab = e.target && e.target.closest ? e.target.closest('#rpPreview .rp-tab') : null;
    if (!tab) return;
    state.device = tab.getAttribute('data-dev');
    render();
  });
  // Fields without an inline oninput handler (links and button texts).
  document.addEventListener('input', function (e) {
    var id = e.target && e.target.id;
    if (id === 'campUrl' || id === 'btn1Txt' || id === 'btn2Txt') render();
  });

  window.RetnerPreview = { render: render };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})();
