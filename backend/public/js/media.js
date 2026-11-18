/* Retner image uploader: drag & drop / click, preview, replace, remove.
 * Accepts JPG, PNG, WebP up to 10 MB, resizes in the browser (keeps
 * transparency as PNG, otherwise JPEG) so uploads stay under 2 MB, then
 * uploads to /my-store/media. Usage:
 *   RetnerMedia.create(el, { value, purpose, maxSide, hint, onChange(url) })
 *   RetnerMedia.attachAll(root)  // for <div data-media-for="inputId">
 */
(function () {
  'use strict';

  var TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var MAX_INPUT = 10 * 1024 * 1024;
  var MAX_UPLOAD = 2 * 1024 * 1024;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file could not be read as an image.')); };
      img.src = url;
    });
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, quality); });
  }

  function hasAlpha(ctx, w, h) {
    try {
      var data = ctx.getImageData(0, 0, w, h).data;
      for (var i = 3; i < data.length; i += 16) if (data[i] < 255) return true;
    } catch (e) { /* tainted canvas cannot happen for local files */ }
    return false;
  }

  // Resize + re-encode in the browser. Returns { blob, width, height }.
  async function prepare(file, maxSide) {
    var loaded = await loadImage(file);
    var img = loaded.img;
    try {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (w < 16 || h < 16) throw new Error('Image is too small.');
      var scale = Math.min(1, maxSide / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      var canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, cw, ch);
      var transparent = file.type !== 'image/jpeg' && hasAlpha(ctx, cw, ch);
      var blob;
      if (transparent) {
        blob = await toBlob(canvas, 'image/png');
      } else {
        blob = await toBlob(canvas, 'image/jpeg', 0.86);
        if (blob && blob.size > MAX_UPLOAD) blob = await toBlob(canvas, 'image/jpeg', 0.72);
      }
      // Small originals that are already fine: keep them as they are.
      if (scale === 1 && file.size <= MAX_UPLOAD && (!blob || file.size < blob.size)) blob = file;
      if (!blob) throw new Error('Could not process this image.');
      if (blob.size > MAX_UPLOAD) throw new Error('Image is still larger than 2 MB after compression. Please use a smaller image.');
      return { blob: blob, width: cw, height: ch };
    } finally {
      URL.revokeObjectURL(loaded.url);
    }
  }

  function create(el, opts) {
    opts = opts || {};
    var state = { value: opts.value || '', busy: false, error: '', info: '' };
    var maxSide = opts.maxSide || 1440;
    var hint = opts.hint || '';

    function render() {
      var v = state.value;
      el.classList.add('rm');
      if (state.busy) {
        el.innerHTML = '<div class="rm-zone rm-busy"><i class="fas fa-spinner fa-spin"></i><div>Uploading…</div></div>';
        return;
      }
      var errorHtml = state.error ? '<div class="rm-error" role="alert"><i class="fas fa-circle-exclamation"></i> ' + esc(state.error) + '</div>' : '';
      if (v) {
        el.innerHTML = '<div class="rm-preview">' +
          '<img src="' + esc(v) + '" alt="" onerror="this.parentNode.classList.add(\'rm-broken\')">' +
          '<div class="rm-meta"><div class="rm-name">' + esc(state.info || 'Image added') + '</div>' +
          '<div class="rm-actions"><button type="button" class="rm-btn" data-rm="replace"><i class="fas fa-arrow-up-from-bracket"></i> Replace</button>' +
          '<button type="button" class="rm-btn rm-danger" data-rm="remove"><i class="fas fa-trash"></i> Remove</button></div></div></div>' + errorHtml +
          '<input type="file" accept="image/jpeg,image/png,image/webp" hidden>';
      } else {
        el.innerHTML = '<div class="rm-zone" tabindex="0" role="button" aria-label="Upload image">' +
          '<i class="fas fa-cloud-arrow-up"></i><div><b>Drag & drop</b> an image or <span class="rm-link">browse</span></div>' +
          '<div class="rm-hint">JPG, PNG or WebP · up to 10 MB' + (hint ? ' · ' + esc(hint) : '') + '</div></div>' + errorHtml +
          '<details class="rm-url"><summary>or paste an image link</summary><input type="url" placeholder="https://…" data-rm="url"></details>' +
          '<input type="file" accept="image/jpeg,image/png,image/webp" hidden>';
      }
    }

    function set(url, info) {
      state.value = url || '';
      state.info = info || '';
      state.error = '';
      render();
      if (opts.onChange) opts.onChange(state.value);
    }

    async function handleFile(file) {
      if (!file) return;
      state.error = '';
      if (TYPES.indexOf(file.type) === -1) { state.error = 'Only JPG, PNG and WebP images are supported.'; render(); return; }
      if (file.size > MAX_INPUT) { state.error = 'Image is too large (' + kb(file.size) + '). The maximum is 10 MB.'; render(); return; }
      state.busy = true; render();
      try {
        var prepared = await prepare(file, maxSide);
        var res = await fetch('/my-store/media?purpose=' + encodeURIComponent(opts.purpose || ''), {
          method: 'POST',
          headers: { 'Content-Type': prepared.blob.type },
          body: prepared.blob,
        });
        var data = {};
        try { data = await res.json(); } catch (e) { data = {}; }
        state.busy = false;
        if (!res.ok || !data.success) throw new Error(data.error || (res.status === 413 ? 'Image is too large.' : 'Upload failed. Please try again.'));
        set(data.url, file.name + ' · ' + data.width + '×' + data.height + ' · ' + kb(data.size));
      } catch (err) {
        state.busy = false;
        state.error = err.message || 'Upload failed.';
        render();
      }
    }

    el.addEventListener('click', function (e) {
      var t = e.target.closest('[data-rm]');
      if (t && t.getAttribute('data-rm') === 'remove') { e.preventDefault(); set(''); return; }
      if ((t && t.getAttribute('data-rm') === 'replace') || e.target.closest('.rm-zone')) {
        e.preventDefault();
        var input = el.querySelector('input[type=file]');
        if (input) input.click();
      }
    });
    el.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('rm-zone')) {
        e.preventDefault();
        el.querySelector('input[type=file]').click();
      }
    });
    el.addEventListener('change', function (e) {
      if (e.target.type === 'file') handleFile(e.target.files && e.target.files[0]);
      if (e.target.getAttribute('data-rm') === 'url') {
        var u = e.target.value.trim();
        if (!u) return;
        if (!/^https:\/\/.{3,490}$/.test(u)) { state.error = 'Please use a link that starts with https://'; render(); return; }
        set(u, 'Image link');
      }
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.preventDefault(); var z = el.querySelector('.rm-zone, .rm-preview'); if (z) z.classList.add('rm-over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      el.addEventListener(ev, function (e) { e.preventDefault(); var z = el.querySelector('.rm-over'); if (z) z.classList.remove('rm-over'); });
    });
    el.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      handleFile(f);
    });

    render();
    return {
      setValue: function (url) { state.value = url || ''; state.info = ''; state.error = ''; render(); },
      getValue: function () { return state.value; },
    };
  }

  // <input id="x" type="hidden"> + <div data-media-for="x" data-purpose data-max-side data-hint>
  function attachAll(root) {
    (root || document).querySelectorAll('[data-media-for]').forEach(function (el) {
      if (el.__rm) return;
      var input = document.getElementById(el.getAttribute('data-media-for'));
      if (!input) return;
      el.__rm = create(el, {
        value: input.value,
        purpose: el.getAttribute('data-purpose'),
        maxSide: Number(el.getAttribute('data-max-side')) || 1440,
        hint: el.getAttribute('data-hint') || '',
        onChange: function (url) {
          input.value = url;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      });
      input.__rm = el.__rm;
    });
  }

  window.RetnerMedia = { create: create, attachAll: attachAll };
})();
