/* Campaign wizard scheduling + campaign history rows.
 * Schedule rules match the server (/my-store/broadcast): at least 5 minutes
 * ahead, at most 60 days; a flash sale must end at least 5 minutes after it
 * is sent. The cron sends scheduled campaigns within 5 minutes of the time.
 */
(function () {
  'use strict';

  var MIN_LEAD_MS = 5 * 60e3;
  var MAX_AHEAD_MS = 60 * 864e5;
  var EXPIRY_MIN_MS = 5 * 60e3;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function toLocalInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function tzName() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; } }
  function fmt(d) {
    return new Date(d).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  // ------------------------------------------------------------ scheduling
  function showError(msg) {
    var e = $('step3Error');
    if (!e) return;
    e.textContent = msg || '';
    e.classList.toggle('hidden', !msg);
  }
  function updateHint() {
    var h = $('scheduleHint');
    var v = $('scheduleTime') && $('scheduleTime').value;
    if (!h) return;
    var d = v ? new Date(v) : null;
    h.textContent = d && !isNaN(d)
      ? 'Goes out ' + fmt(d) + ' (' + tzName() + '), within 5 minutes of this time.'
      : 'Times are in your time zone (' + tzName() + ').';
  }
  function updateSendLabel(mode) {
    var b = $('btnSend');
    if (!b || b.disabled) return;
    b.innerHTML = mode === 'later'
      ? '<i class="fas fa-calendar-check"></i> Schedule campaign'
      : '<i class="fas fa-paper-plane"></i> Send campaign';
  }
  function onScheduleMode(mode) {
    var input = $('scheduleTime');
    if (input) {
      input.min = toLocalInput(new Date(Date.now() + MIN_LEAD_MS));
      input.max = toLocalInput(new Date(Date.now() + MAX_AHEAD_MS));
      if (mode === 'later' && !input.value) {
        var d = new Date(Date.now() + 60 * 60e3);
        d.setMinutes(0, 0, 0);
        d.setHours(d.getHours() + 1); // next full hour, at least an hour away
        input.value = toLocalInput(d);
      }
    }
    var exp = $('expiryTime');
    if (exp) exp.min = toLocalInput(new Date(Date.now() + MIN_LEAD_MS));
    updateHint();
    showError('');
    updateSendLabel(mode);
  }
  function scheduleError(mode, type) {
    var now = Date.now();
    var sendAt = now;
    if (mode === 'later') {
      var v = $('scheduleTime') && $('scheduleTime').value;
      if (!v) return 'Pick the date and time to send this campaign.';
      var t = new Date(v).getTime();
      if (isNaN(t)) return 'Pick a valid date and time.';
      if (t < now + MIN_LEAD_MS) return 'Pick a time at least 5 minutes from now.';
      if (t > now + MAX_AHEAD_MS) return 'You can schedule up to 60 days ahead.';
      sendAt = t;
    }
    if (type === 'flash') {
      var ev = $('expiryTime') && $('expiryTime').value;
      if (ev) {
        var et = new Date(ev).getTime();
        if (isNaN(et) || et < sendAt + EXPIRY_MIN_MS) return 'The offer must end at least 5 minutes after the campaign is sent.';
      }
    }
    return '';
  }
  // Returns the error text ('' when fine) and shows it under the schedule card.
  function validateStep3(mode, type) {
    var err = scheduleError(mode, type);
    showError(err);
    if (err && $('step3Error') && $('step3Error').scrollIntoView) $('step3Error').scrollIntoView({ block: 'center', behavior: 'smooth' });
    return err;
  }
  function describeSchedule(mode) {
    if (mode !== 'later') return 'Immediately';
    var v = $('scheduleTime') && $('scheduleTime').value;
    return v ? fmt(new Date(v)) + ' (' + tzName() + ')' : '-';
  }
  function describeExpiry(type) {
    if (type !== 'flash') return '';
    var v = $('expiryTime') && $('expiryTime').value;
    return v ? fmt(new Date(v)) : 'No end time';
  }
  function resultMessage(data) {
    if (data.status === 'scheduled') return 'Campaign scheduled for ' + fmt(data.scheduled_at) + '. You can cancel it from Campaign History until then.';
    if (data.sent === 0 && data.lastError) return 'Sent to 0 subscribers. Reason: ' + data.lastError;
    return 'Sent to ' + Number(data.sent || 0).toLocaleString('en-IN') + ' subscribers.';
  }

  // --------------------------------------------------------------- history
  var STATUS = {
    sent: ['Sent', 'grey', ''],
    sending: ['Sending', 'blue', 'Being sent right now.'],
    scheduled: ['Scheduled', 'amber', ''],
    missed: ['Missed', 'red', 'Not sent: the server was unavailable at the scheduled time. Create it again to send it.'],
    cancelled: ['Cancelled', 'grey', 'Cancelled before it was sent.'],
    expired: ['Offer ended', 'grey', 'Not sent because the offer had already ended.'],
  };
  function statusBadge(c) {
    var s = STATUS[c.status] || [c.status || 'Sent', 'grey', ''];
    return '<span class="rc-badge rc-' + s[1] + '"' + (s[2] ? ' title="' + esc(s[2]) + '"' : '') + '>' + esc(s[0]) + '</span>';
  }
  function isDelivered(c) { return c.status === 'sent' || !c.status; }
  function historyRow(c) {
    var when = c.status === 'scheduled' && c.scheduled_at
      ? '<span class="rc-when"><i class="far fa-clock"></i> ' + esc(fmt(c.scheduled_at)) + '</span>'
      : esc(c.created_at ? new Date(c.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '-');
    var type = c.type === 'flash' ? '⚡ Flash sale' : 'Regular';
    var msg = String(c.message || '');
    var action = c.status === 'scheduled'
      ? ' <button class="rc-cancel" type="button" data-cancel="' + esc(c.id) + '">Cancel</button>' : '';
    return '<tr class="rc-row">' +
      '<td>' + when + '</td>' +
      '<td>' + esc(type) + '</td>' +
      '<td class="rc-title">' + esc(c.title) + '</td>' +
      '<td class="rc-msg" title="' + esc(msg) + '">' + esc(msg.length > 60 ? msg.slice(0, 60) + '…' : msg) + '</td>' +
      '<td>' + statusBadge(c) + action + '</td>' +
      '<td>' + (isDelivered(c) ? '<span class="rc-count">' + Number(c.sent_count || 0).toLocaleString('en-IN') + '</span>' : '—') + '</td>' +
      '</tr>';
  }
  function cancel(id, btn) {
    if (!window.confirm('Cancel this scheduled campaign? It will not be sent.')) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Cancelling…'; }
    fetch('/my-store/campaigns/' + encodeURIComponent(id) + '/cancel', { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return { success: false, error: 'Server error (' + r.status + ')' }; }); })
      .then(function (d) {
        if (!d.success) window.alert(d.error || 'Could not cancel. Please try again.');
        if (typeof window.loadCampaignHistory === 'function') window.loadCampaignHistory();
      })
      .catch(function () {
        window.alert('Could not reach the server. Please try again.');
        if (btn) { btn.disabled = false; btn.textContent = 'Cancel'; }
      });
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cancel]') : null;
    if (b) cancel(b.getAttribute('data-cancel'), b);
  });
  document.addEventListener('input', function (e) {
    var id = e.target && e.target.id;
    if (id === 'scheduleTime') { updateHint(); showError(''); }
    if (id === 'expiryTime') showError('');
  });

  window.RetnerCampaigns = {
    onScheduleMode: onScheduleMode,
    validateStep3: validateStep3,
    updateSendLabel: updateSendLabel,
    describeSchedule: describeSchedule,
    describeExpiry: describeExpiry,
    resultMessage: resultMessage,
    statusBadge: statusBadge,
    historyRow: historyRow,
    isDelivered: isDelivered,
    showError: showError,
  };
})();
