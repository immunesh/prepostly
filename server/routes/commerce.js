import { Router } from 'express';
import { one, all, run, uuid, now, insert, update, json } from '../db.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { CREDIT_COSTS, FORMATS } from '../catalog.js';
import { charge } from '../credits.js';
import { importProducts, productFromUrl } from '../engines/scraper.js';
import { adConcepts } from '../engines/content.js';
import { withMeter } from '../usage.js';
import { createPost } from '../generate.js';
import { normalizeUrl } from '../net.js';

// Store integrations, the product catalogue and Ads Studio.

export const router = Router();
router.use(requireUser);

const productOut = (p) => ({ ...p, images: json(p.images, []) });

function upsertProducts(brandId, storeId, products) {
  let added = 0;
  for (const p of products) {
    const existing = one('SELECT id FROM products WHERE brand_id = ? AND external_id = ?', brandId, p.external_id);
    const row = { title: p.title.slice(0, 200), description: p.description || '', price: String(p.price || ''), compare_at_price: String(p.compare_at_price || ''), currency: p.currency || '', url: p.url || '', images: JSON.stringify(p.images || []) };
    if (existing) update('products', existing.id, { ...row, store_id: storeId ?? null });
    else {
      insert('products', { id: uuid(), brand_id: brandId, store_id: storeId, external_id: p.external_id, ...row });
      added++;
    }
  }
  return added;
}

router.get('/stores', (req, res) => {
  const brand = brandFor(req);
  res.json(all('SELECT s.*, (SELECT COUNT(*) FROM products p WHERE p.store_id = s.id) AS product_count FROM stores s WHERE s.brand_id = ? ORDER BY created_at', brand.id));
});

router.post('/stores', async (req, res) => {
  const brand = brandFor(req, 'admin');
  const url = normalizeUrl(req.body.url);
  const { platform, products } = await importProducts(url.toString(), { limit: 100 });
  let store = one('SELECT * FROM stores WHERE brand_id = ? AND url = ?', brand.id, url.origin);
  if (!store) store = insert('stores', { id: uuid(), brand_id: brand.id, platform, url: url.origin, name: url.hostname.replace(/^www\./, '') });
  const added = upsertProducts(brand.id, store.id, products);
  update('stores', store.id, { last_sync_at: now(), platform });
  res.status(201).json({ store: one('SELECT * FROM stores WHERE id = ?', store.id), imported: products.length, added });
});

router.post('/stores/:id/sync', async (req, res) => {
  const brand = brandFor(req, 'admin');
  const store = one('SELECT * FROM stores WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!store) throw new HttpError(404, 'Store not found.');
  const { products } = await importProducts(store.url, { limit: 100 });
  const added = upsertProducts(brand.id, store.id, products);
  update('stores', store.id, { last_sync_at: now() });
  res.json({ imported: products.length, added });
});

router.delete('/stores/:id', (req, res) => {
  const brand = brandFor(req, 'admin');
  run('DELETE FROM stores WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  res.json({ ok: true });
});

router.get('/products', (req, res) => {
  const brand = brandFor(req);
  const q = req.query.q ? `%${req.query.q}%` : null;
  res.json(all(`SELECT * FROM products WHERE brand_id = ? ${q ? 'AND title LIKE ?' : ''} ORDER BY created_at DESC LIMIT 300`, brand.id, ...(q ? [q] : [])).map(productOut));
});

/** Add a product by hand or from a product page URL. */
router.post('/products', async (req, res) => {
  const brand = brandFor(req, 'editor');
  let p;
  if (req.body.url && !req.body.title) p = await productFromUrl(req.body.url);
  else {
    if (!String(req.body.title || '').trim()) throw new HttpError(400, 'Enter the product name.');
    p = { external_id: `manual:${uuid()}`, title: String(req.body.title), description: String(req.body.description || ''), price: String(req.body.price || ''), compare_at_price: String(req.body.compare_at_price || ''), currency: String(req.body.currency || ''), url: String(req.body.url || ''), images: (req.body.images || []).filter((u) => /^\/uploads\/|^https:\/\//.test(u)) };
  }
  upsertProducts(brand.id, null, [p]);
  res.status(201).json(productOut(one('SELECT * FROM products WHERE brand_id = ? AND external_id = ?', brand.id, p.external_id)));
});

router.delete('/products/:id', (req, res) => {
  const brand = brandFor(req, 'editor');
  run('DELETE FROM products WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Ads Studio
router.post('/adstudio/concepts', async (req, res) => {
  const brand = brandFor(req, 'editor');
  const product = one('SELECT * FROM products WHERE id = ? AND brand_id = ?', req.body.product_id, brand.id);
  if (!product) throw new HttpError(404, 'Pick a product first.');
  const count = Math.max(1, Math.min(6, Number(req.body.count) || 4));
  charge(brand, CREDIT_COSTS.ad_concepts, 'ad_concepts', product.id);
  res.json({ concepts: await withMeter({ job: 'ad_concepts', ref: product.id }, () => adConcepts(brand, productOut(product), count)) });
});

/** Generate one static ad per selected concept, plus an optional video ad. */
router.post('/adstudio/generate', (req, res) => {
  const brand = brandFor(req, 'editor');
  const product = one('SELECT * FROM products WHERE id = ? AND brand_id = ?', req.body.product_id, brand.id);
  if (!product) throw new HttpError(404, 'Pick a product first.');
  const concepts = (req.body.concepts || []).slice(0, 6);
  const format = FORMATS[req.body.format] ? req.body.format : 'square';
  const templates = ['bold', 'minimal', 'neon', 'editorial', 'split', 'photo'];
  if (!concepts.length && !req.body.video) throw new HttpError(400, 'Select at least one concept.');
  const posts = concepts.map((concept, i) => createPost({
    brand, user: req.user,
    input: { type: 'ad_creative', product_id: product.id, format, concept: { headline: concept.headline, subheader: concept.subheader, badge: concept.badge || concept.offer, cta: concept.cta, disclaimer: concept.disclaimer }, template: req.body.template || templates[i % templates.length], prompt: `${concept.name}: ${concept.visual_direction}` },
  }));
  if (req.body.video) posts.push(createPost({ brand, user: req.user, input: { type: 'ecom_video', product_id: product.id, format: 'story', template: 'auto' } }));
  res.status(201).json(posts);
});
