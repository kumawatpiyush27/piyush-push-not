'use strict';
// Service worker served at /sw.js (dashboard test notifications). The same
// code is served to shoppers by the Shopify app at /apps/push/sw.js.
//
// Payload contract (all fields optional except title):
//   { title, body, icon, image, url, tag,
//     data: { url, ... },                       // click target (tracked link)
//     actions: [{ action, title, url }] }       // buttons with their own URLs
// Old payloads are still understood: top-level `url`, button `action` that is
// itself a URL, and data.tracking for legacy welcome click counting.

const SERVICE_WORKER_SOURCE = String.raw`/* Retner SmartPush service worker v3 */
var DEFAULT_ICON = 'https://cdn-icons-png.flaticon.com/512/733/733585.png';

self.addEventListener('install', function (event) { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

function parsePayload(event) {
  if (!event.data) return {};
  try { return event.data.json(); } catch (e) {
    try { return { title: 'Notification', body: event.data.text() }; } catch (e2) { return {}; }
  }
}

self.addEventListener('push', function (event) {
  var msg = parsePayload(event);
  var data = {};
  var src = msg.data && typeof msg.data === 'object' ? msg.data : {};
  for (var k in src) { if (Object.prototype.hasOwnProperty.call(src, k)) data[k] = src[k]; }
  if (!data.url) data.url = msg.url || '/';

  var actionUrls = {};
  var actions = [];
  (Array.isArray(msg.actions) ? msg.actions : []).slice(0, 2).forEach(function (a, i) {
    if (!a || !a.title) return;
    var name = a.action && !/^https?:/i.test(a.action) ? String(a.action) : 'a' + i;
    var url = a.url || (/^https?:/i.test(a.action || '') ? a.action : data.url);
    actionUrls[name] = url;
    actions.push({ action: name, title: String(a.title) });
  });
  data.actionUrls = actionUrls;

  var options = {
    body: msg.body || '',
    icon: msg.icon || DEFAULT_ICON,
    data: data,
    actions: actions
  };
  if (msg.image) options.image = msg.image;
  if (msg.badge) options.badge = msg.badge;
  if (msg.tag) { options.tag = msg.tag; options.renotify = true; }
  if (msg.requireInteraction) options.requireInteraction = true;

  event.waitUntil(self.registration.showNotification(msg.title || 'Notification', options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var data = event.notification.data || {};
  var url = data.url || '/';
  if (event.action && data.actionUrls && data.actionUrls[event.action]) url = data.actionUrls[event.action];
  else if (event.action && /^https?:/i.test(event.action)) url = event.action;

  var work = [];
  if (data.tracking && data.tracking.type && data.tracking.storeId) {
    work.push(fetch('https://push-retner.vercel.app/api/track-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: data.tracking.type, storeId: data.tracking.storeId, event: 'click' })
    }).catch(function () {}));
  }
  work.push(self.clients.openWindow(url));
  event.waitUntil(Promise.all(work));
});
`;

module.exports = { SERVICE_WORKER_SOURCE };
