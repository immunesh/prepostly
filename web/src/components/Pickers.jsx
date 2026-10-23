import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, upload } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { Spinner } from './ui.jsx';

/** Pick images (and optionally upload new ones) from the brand's uploads. */
export function UploadPicker({ selected = [], onChange, max = 10, kind = 'image' }) {
  const { toast } = useApp();
  const [items, { reload, loading }] = useLoad(() => get(`/api/uploads?kind=${kind}`), [kind]);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const toggle = (file) => {
    if (selected.includes(file)) onChange(selected.filter((f) => f !== file));
    else if (selected.length < max) onChange([...selected, file]);
  };
  const onFiles = async (files) => {
    setBusy(true);
    try {
      const added = [];
      for (const f of files) added.push((await upload(f)).file);
      await reload();
      onChange([...selected, ...added].slice(0, max));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack tight">
      <div className="row wrap" style={{ gap: 8 }}>
        <button type="button" className="btn sm" onClick={() => input.current.click()} disabled={busy}>{busy ? <Spinner /> : '⬆️'} Upload</button>
        <input ref={input} type="file" accept={kind === 'image' ? 'image/*' : kind === 'video' ? 'video/mp4' : '*/*'} multiple hidden onChange={(e) => onFiles([...e.target.files])} />
        <span className="tiny muted">{selected.length ? `${selected.length} selected` : `Pick up to ${max}`}</span>
      </div>
      {loading ? <div className="skeleton" style={{ height: 70 }} /> : (
        <div className="row wrap" style={{ gap: 8 }}>
          {(items || []).map((u) => (
            <button type="button" key={u.id} onClick={() => toggle(u.file)} title={u.name} style={{ padding: 0, border: selected.includes(u.file) ? '2px solid var(--brand)' : '2px solid transparent', borderRadius: 10, background: 'none', cursor: 'pointer', position: 'relative' }}>
              <img src={u.file} alt={u.name} style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 8 }} />
              {selected.includes(u.file) && <span style={{ position: 'absolute', top: 2, right: 4, color: '#fff', fontWeight: 700, textShadow: '0 0 3px #000' }}>✓</span>}
            </button>
          ))}
          {!items?.length && <span className="small muted">No uploads yet.</span>}
        </div>
      )}
    </div>
  );
}

/** Choose a product from the brand's catalogue. */
export function ProductPicker({ value, onChange }) {
  const [products, { loading }] = useLoad(() => get('/api/products'), []);
  if (loading) return <div className="skeleton" style={{ height: 60 }} />;
  if (!products?.length) return <div className="alert info">No products yet. <Link to="/app/brand?tab=integrations">Import from your store</Link> or add one in Ads Studio.</div>;
  return (
    <div className="row wrap" style={{ gap: 10 }}>
      {products.map((p) => (
        <button type="button" key={p.id} onClick={() => onChange(p.id)} className={`chip ${value === p.id ? 'on' : ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 12, padding: 6 }}>
          {p.images[0] ? <img src={p.images[0]} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 8 }} /> : <span style={{ width: 36, textAlign: 'center' }}>🛍️</span>}
          <span style={{ textAlign: 'left' }}><span className="bold small clip" style={{ maxWidth: 160, display: 'block' }}>{p.title}</span><span className="tiny muted">{p.price ? `${p.currency || '$'}${p.price}` : ''}</span></span>
        </button>
      ))}
    </div>
  );
}
