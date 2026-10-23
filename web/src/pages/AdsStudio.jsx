import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { AsyncButton, Switch } from '../components/ui.jsx';
import { ProductPicker } from '../components/Pickers.jsx';

// Product → ad concepts → one creative per concept (+ optional video ad).

const FIELDS = [['headline', 'Header'], ['subheader', 'Sub-header'], ['badge', 'Badge'], ['offer', 'Special offer'], ['cta', 'CTA'], ['disclaimer', 'Disclaimer']];

export default function AdsStudio() {
  const { toast, refresh, catalog, can } = useApp();
  const nav = useNavigate();
  const [url, setUrl] = useState('');
  const [productId, setProductId] = useState(null);
  const [pickerKey, setPickerKey] = useState(0);
  const [concepts, setConcepts] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [format, setFormat] = useState('square');
  const [video, setVideo] = useState(false);
  const fail = (e) => toast(e.message, 'err');

  if (!can('editor')) return <div className="alert warn">Ads Studio needs the editor role.</div>;
  const edit = (i, k, v) => setConcepts(concepts.map((c, j) => (j === i ? { ...c, [k]: v } : c)));

  return (
    <>
      <div className="page-head"><div><h1>📣 Ads studio</h1><p>Turn a product into ready-to-run static and video ads. Pick concepts, tweak the copy, generate in parallel.</p></div></div>
      <div className="card pad stack mb">
        <h3>1. Choose a product</h3>
        <div className="row">
          <input className="input" placeholder="Paste a product page URL (Shopify, WooCommerce or any store)" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Product URL" />
          <AsyncButton className="btn" disabled={!url.trim()} onError={fail} onClick={async () => { const p = await post('/api/products', { url }); setProductId(p.id); setUrl(''); setPickerKey((k) => k + 1); toast(`Added ${p.title}`, 'ok'); }}>Add product</AsyncButton>
        </div>
        <ProductPicker key={pickerKey} value={productId} onChange={(id) => { setProductId(id); setConcepts(null); }} />
      </div>
      {productId && (
        <div className="card pad stack mb">
          <div className="row between"><h3>2. Ad concepts</h3>
            <AsyncButton className="btn primary" onError={fail} onClick={async () => { const r = await post('/api/adstudio/concepts', { product_id: productId, count: 4 }); setConcepts(r.concepts); setChosen(r.concepts.map((_, i) => i)); refresh(); }}>✨ {concepts ? 'Regenerate concepts' : 'Create concepts'} ({catalog?.costs.ad_concepts} credits)</AsyncButton></div>
          {concepts && (
            <div className="grid g2">
              {concepts.map((c, i) => (
                <div key={i} className={`card pad stack tight ${chosen.includes(i) ? '' : ''}`} style={{ boxShadow: 'none', borderColor: chosen.includes(i) ? 'var(--brand)' : undefined }}>
                  <label className="checkbox"><input type="checkbox" checked={chosen.includes(i)} onChange={(e) => setChosen(e.target.checked ? [...chosen, i] : chosen.filter((x) => x !== i))} /><span className="bold">{c.name}</span></label>
                  <span className="tiny muted">Visual direction: {c.visual_direction}</span>
                  {FIELDS.map(([k, l]) => <div key={k} className="row"><span className="tiny muted" style={{ width: 90 }}>{l}</span><input className="input" style={{ padding: '5px 9px' }} value={c[k] || ''} onChange={(e) => edit(i, k, e.target.value)} aria-label={`${c.name} ${l}`} /></div>)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {concepts && (
        <div className="card pad row wrap">
          <h3>3. Generate</h3>
          <select className="select" style={{ width: 220 }} value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Ad size">{Object.entries(catalog?.formats || {}).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}</select>
          <Switch on={video} onChange={setVideo} label="Also make a 9:16 video ad" />
          <span className="small muted right">{chosen.length} static ad{chosen.length === 1 ? '' : 's'} × {catalog?.costs.image} credits{video ? ` + video ${catalog?.costs.video}` : ''}</span>
          <AsyncButton className="btn primary" disabled={!chosen.length && !video} onError={fail} onClick={async () => { const posts = await post('/api/adstudio/generate', { product_id: productId, concepts: chosen.map((i) => concepts[i]), format, video }); refresh(); toast(`Generating ${posts.length} ads…`, 'ok'); nav('/app/library'); }}>Generate ads</AsyncButton>
        </div>
      )}
    </>
  );
}
