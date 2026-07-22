const { ObjectId } = require('mongodb');
const { getDb } = require('../db');
const config = require('../config');

/**
 * Partner logos — the "In partnership with" strip on the public floorplan.
 *
 * Separate from the `sponsors` catalogue: that one carries tiers and (private)
 * prices for the recommendation panel. These are purely display branding —
 * an image and the link it points at — managed from the admin so logos can be
 * changed without editing a file and redeploying.
 */
const col = () => getDb().collection('partners');

const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

/**
 * A link the browser will navigate to: http(s) or a site-relative path only.
 * Never javascript:, data: or anything else that could execute.
 */
function safeLink(v) {
  const s = clean(v, 500);
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('/')) return s;
  return '';
}

/**
 * An image source. Same rules as a link, plus inline `data:image/…` so a small
 * logo can be pasted directly. Only image MIME types — never data:text/html.
 */
function safeImage(v) {
  const s = clean(v, 200000);   // data URIs are long
  if (!s) return '';
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(s)) return s;
  return safeLink(s);
}

const ensureIndexes = () => col().createIndex({ showId: 1, order: 1 });

/** Everything, for the admin list. */
const all = () =>
  col().find({ showId: config.showId }).sort({ order: 1, _id: 1 }).toArray();

/** Active partners with an image, for the public strip. */
const publicList = async () => {
  const rows = await col()
    .find({ showId: config.showId, active: { $ne: false }, image: { $nin: [null, ''] } })
    .sort({ order: 1, _id: 1 }).toArray();
  return rows.map(p => ({ name: p.name, image: p.image, url: p.url || null, alt: p.alt || p.name }));
};

async function create({ name, image, url, alt }) {
  const last = await col().find({ showId: config.showId }).sort({ order: -1 }).limit(1).toArray();
  const doc = {
    showId: config.showId,
    name:  clean(name, 120),
    image: safeImage(image),
    url:   safeLink(url),
    alt:   clean(alt, 160),
    active: true,
    order: (last[0]?.order ?? -1) + 1,
    createdAt: new Date(), updatedAt: new Date(),
  };
  if (!doc.image) return { ok: false, error: 'A logo image URL or path is required.' };
  const { insertedId } = await col().insertOne(doc);
  return { ok: true, partner: { ...doc, _id: insertedId } };
}

async function update(id, fields) {
  const $set = { updatedAt: new Date() };
  if ('name'   in fields) $set.name  = clean(fields.name, 120);
  if ('alt'    in fields) $set.alt   = clean(fields.alt, 160);
  if ('active' in fields) $set.active = fields.active === true || fields.active === 'true';
  if ('order'  in fields) $set.order = Number(fields.order) || 0;
  if ('image'  in fields) {
    const v = safeImage(fields.image);
    if (!v) return { ok: false, error: 'Logo must be an http(s) URL, a path starting with /, or a data:image URI' };
    $set.image = v;
  }
  if ('url' in fields) {
    // An empty link is allowed — the logo simply isn't clickable.
    if (clean(fields.url, 500) && !safeLink(fields.url)) {
      return { ok: false, error: 'Link must be an http(s) URL or a path starting with /' };
    }
    $set.url = safeLink(fields.url);
  }
  const res = await col().updateOne({ _id: new ObjectId(id), showId: config.showId }, { $set });
  return res.matchedCount ? { ok: true } : { ok: false, error: 'Partner not found.' };
}

async function remove(id) {
  const res = await col().deleteOne({ _id: new ObjectId(id), showId: config.showId });
  return res.deletedCount === 1;
}

module.exports = { col, ensureIndexes, all, publicList, create, update, remove };
