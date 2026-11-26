'use strict';
// Image uploads for campaigns, automations and store logos.
// Images are stored in Postgres (push_media) and served publicly at
// /m/<id>.<ext> — push services and shoppers' browsers must be able to load
// them. The real format is detected from the file bytes, never trusted from
// the name or Content-Type.

const crypto = require('crypto');

const MAX_BYTES = 2 * 1024 * 1024;        // after the browser resized it
const MAX_DIMENSION = 6000;
const MIN_DIMENSION = 16;
const MAX_FILES_PER_STORE = 500;
const MAX_TOTAL_BYTES_PER_STORE = 200 * 1024 * 1024;
const PURPOSES = new Set(['hero', 'icon', 'logo', 'automation']);
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function detectType(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    return null;
}

function jpegSize(buf) {
    let i = 2;
    while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        if (len < 2) return null;
        i += 2 + len;
    }
    return null;
}

function webpSize(buf) {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
        const b = buf.readUInt32LE(21);
        return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && buf.length >= 30) {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    return null;
}

function imageSize(buf, mime) {
    try {
        if (mime === 'image/png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
        if (mime === 'image/jpeg') return jpegSize(buf);
        if (mime === 'image/webp') return webpSize(buf);
    } catch { /* fall through */ }
    return null;
}

// Returns { ok, mime, width, height } or { ok: false, error }.
function inspectImage(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'No image received.' };
    if (buf.length > MAX_BYTES) return { ok: false, error: 'Image is too large. The maximum is 2 MB.' };
    const mime = detectType(buf);
    if (!mime) return { ok: false, error: 'Only JPG, PNG and WebP images are supported.' };
    const size = imageSize(buf, mime);
    if (!size || !size.width || !size.height) return { ok: false, error: 'This image file looks damaged. Please try another one.' };
    if (size.width < MIN_DIMENSION || size.height < MIN_DIMENSION) return { ok: false, error: 'Image is too small.' };
    if (size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) return { ok: false, error: `Image is too big (max ${MAX_DIMENSION}px per side).` };
    return { ok: true, mime, width: size.width, height: size.height };
}

function publicUrl(id, mime) {
    const base = (process.env.APP_URL || 'https://push-retner.vercel.app').replace(/\/$/, '');
    return `${base}/m/${id}.${EXT[mime]}`;
}

async function saveImage(db, storeId, buf, purpose) {
    const info = inspectImage(buf);
    if (!info.ok) return info;
    const id = crypto.createHash('sha256').update(storeId).update(':').update(buf).digest('hex').slice(0, 32);

    const existing = await db.query('SELECT id, mime FROM push_media WHERE id = $1', [id]);
    if (existing.rows.length) {
        return { ok: true, id, url: publicUrl(id, existing.rows[0].mime), width: info.width, height: info.height, size: buf.length, deduplicated: true };
    }
    const usage = await db.query('SELECT COUNT(*)::int AS n, COALESCE(SUM(size), 0)::bigint AS total FROM push_media WHERE store_id = $1', [storeId]);
    const { n, total } = usage.rows[0];
    if (n >= MAX_FILES_PER_STORE || Number(total) + buf.length > MAX_TOTAL_BYTES_PER_STORE) {
        return { ok: false, error: 'Your image storage is full. Please contact support.' };
    }
    await db.query(
        `INSERT INTO push_media (id, store_id, mime, bytes, size, width, height, purpose)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (id) DO NOTHING`,
        [id, storeId, info.mime, buf, buf.length, info.width, info.height, PURPOSES.has(purpose) ? purpose : null]
    );
    return { ok: true, id, url: publicUrl(id, info.mime), width: info.width, height: info.height, size: buf.length };
}

async function loadImage(db, id) {
    if (!/^[a-f0-9]{32}$/.test(String(id))) return null;
    const { rows } = await db.query('SELECT mime, bytes FROM push_media WHERE id = $1', [id]);
    return rows[0] || null;
}

// Recent images of a store for the "choose from library" picker (no bytes).
async function listImages(db, storeId, limit) {
    const { rows } = await db.query(
        'SELECT id, mime, width, height, size, purpose, created_at FROM push_media WHERE store_id = $1 ORDER BY created_at DESC LIMIT $2',
        [storeId, Math.min(200, Math.max(1, Number(limit) || 60))]
    );
    return rows.map((r) => ({ id: r.id, url: publicUrl(r.id, r.mime), mime: r.mime, width: r.width, height: r.height, size: r.size, purpose: r.purpose, created_at: r.created_at }));
}

module.exports = { MAX_BYTES, EXT, detectType, inspectImage, saveImage, loadImage, listImages, publicUrl };
