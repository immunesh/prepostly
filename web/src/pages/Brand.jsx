import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, post, patch, del, upload, fmtDate, fmtBytes, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Avatar, Empty, Loading, Modal, Tabs } from '../components/ui.jsx';

export function BrandColors({ colors, onChange, disabled }) {
  return (
    <div className="row wrap">
      {colors.map((c, i) => (
        <div key={i} className="stack tight" style={{ alignItems: 'center' }}>
          <label className="swatch" style={{ background: c }} title={c}><input type="color" value={c} disabled={disabled} onChange={(e) => onChange(colors.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Color ${i + 1}`} /></label>
          {!disabled && colors.length > 1 && <button className="btn ghost sm" style={{ height: 20, padding: '0 4px' }} onClick={() => onChange(colors.filter((_, j) => j !== i))} aria-label="Remove color">✕</button>}
        </div>
      ))}
      {!disabled && colors.length < 6 && <button className="btn sm" onClick={() => onChange([...colors, '#111827'])}>＋</button>}
    </div>
  );
}

export default function Brand() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'details';
  const { toast } = useApp();
  useEffect(() => {
    if (params.get('connected')) toast(`Connected ${params.get('count') || ''} ${params.get('connected')} account(s)`, 'ok');
    if (params.get('error')) toast(params.get('error'), 'err');
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div className="page-head"><div><h1>🎨 Brand & channels</h1><p>Manage your brand kit, integrations, uploads and social accounts.</p></div></div>
      <Tabs value={tab} onChange={(t) => setParams({ tab: t })} tabs={[['details', 'Brand details'], ['social', 'Social platforms'], ['integrations', 'Integrations'], ['uploads', 'Uploads'], ['templates', 'Templates']]} />
      {tab === 'details' && <Details />}
      {tab === 'social' && <Social />}
      {tab === 'integrations' && <Integrations />}
      {tab === 'uploads' && <Uploads />}
      {tab === 'templates' && <Templates />}
    </>
  );
}

function Details() {
  const { brand, catalog, refresh, toast, can } = useApp();
  const [b, setB] = useState(null);
  const [site, setSite] = useState(false);
  useEffect(() => { if (brand) setB({ ...brand, palettes: brand.palettes || [] }); }, [brand]);
  if (!b || !catalog) return <Loading />;
  const admin = can('admin');
  const set = (k) => (e) => setB({ ...b, [k]: e?.target ? e.target.value : e });
  const save = async () => {
    await patch(`/api/brands/${b.id}`, { name: b.name, website: b.website, industry: b.industry, description: b.description, audience: b.audience, tone: b.tone, language: b.language, colors: b.colors, palettes: b.palettes, font_heading: b.font_heading, font_body: b.font_body, text_case: b.text_case, logo_light: b.logo_light, logo_dark: b.logo_dark, handle: b.handle, hashtags: b.hashtags, cta: b.cta, timezone: b.timezone, voice: b.voice, settings: b.settings, logo_url: b.logo_url || undefined });
    await refresh();
    toast('Brand saved. New posts will use these settings.', 'ok');
  };
  const logo = async (k, file) => {
    try {
      const u = await upload(file);
      setB((x) => ({ ...x, [k]: u.file }));
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <div className="card pad stack">
        <div className="row between"><h3>Business details</h3>{admin && <button className="btn sm" onClick={() => setSite(true)}>🌐 Fetch from website</button>}</div>
        <p className="small muted">These details help Prepostly write posts that fit your business. They also apply to auto posting.</p>
        <div className="grid g2">
          <div className="field"><label htmlFor="n">Brand name</label><input id="n" className="input" disabled={!admin} value={b.name} onChange={set('name')} /></div>
          <div className="field"><label htmlFor="i">Industry</label><input id="i" className="input" disabled={!admin} value={b.industry} onChange={set('industry')} /></div>
        </div>
        <div className="field"><label htmlFor="d">Description</label><textarea id="d" className="textarea" disabled={!admin} value={b.description} onChange={set('description')} /></div>
        <div className="field"><label htmlFor="a">Target audience</label><input id="a" className="input" disabled={!admin} value={b.audience} onChange={set('audience')} /></div>
        <div className="grid g2">
          <div className="field"><label htmlFor="t">Tonality of communication</label><select id="t" className="select" disabled={!admin} value={b.tone} onChange={set('tone')}>{catalog.tones.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="field"><label htmlFor="l">Language</label><select id="l" className="select" disabled={!admin} value={b.language} onChange={set('language')}>{catalog.languages.map((t) => <option key={t}>{t}</option>)}</select></div>
          <div className="field"><label htmlFor="w">Website (shown on creatives)</label><input id="w" className="input" disabled={!admin} value={b.website} onChange={set('website')} /></div>
          <div className="field"><label htmlFor="h">Social handle (shown on creatives)</label><input id="h" className="input" disabled={!admin} value={b.handle} onChange={set('handle')} placeholder="coolhandle" /></div>
        </div>
        <div className="field"><label htmlFor="ht">Brand hashtags</label><input id="ht" className="input" disabled={!admin} value={b.hashtags} onChange={set('hashtags')} placeholder="#yourbrand #yourniche" /><span className="hint">Always added to generated captions.</span></div>
        <div className="field"><label htmlFor="cta">Preferred call to action</label><input id="cta" className="input" disabled={!admin} value={b.cta} onChange={set('cta')} placeholder="e.g. Shop the drop at brewly.com" /></div>
        <div className="grid g2">
          <div className="field"><label htmlFor="tz">Timezone</label><select id="tz" className="select" disabled={!admin} value={b.timezone} onChange={set('timezone')}>{Intl.supportedValuesOf('timeZone').map((z) => <option key={z}>{z}</option>)}</select></div>
          <div className="field"><label htmlFor="v">Voiceover voice</label><select id="v" className="select" disabled={!admin} value={b.voice} onChange={set('voice')}>{Object.entries(catalog.voices).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        </div>
        <label className="checkbox"><input type="checkbox" disabled={!admin} checked={Boolean(b.settings?.require_approval)} onChange={(e) => setB({ ...b, settings: { ...b.settings, require_approval: e.target.checked } })} />Editors must get approval before publishing</label>
      </div>
      <div className="card pad stack">
        <h3>Brand specifications</h3>
        <div className="grid g2">
          {[['logo_light', 'Logo for light backgrounds', '#fff'], ['logo_dark', 'Logo for dark backgrounds', '#17142b']].map(([k, l, bg]) => (
            <div key={k} className="field"><span className="label">{l}</span>
              <div style={{ background: bg, border: '1px solid var(--border)', borderRadius: 12, height: 90, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 10 }}>{b[k] ? <img src={b[k]} alt="" style={{ maxHeight: 70 }} /> : <span className="faint small">No logo</span>}</div>
              {admin && <div className="row"><label className="btn sm">Change<input type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && logo(k, e.target.files[0])} /></label>{b[k] && <button className="btn ghost sm" onClick={() => setB({ ...b, [k]: null })}>Remove</button>}</div>}
            </div>
          ))}
        </div>
        <div className="field"><span className="label">Brand colors</span><BrandColors colors={b.colors.length ? b.colors : ['#7c3aed']} disabled={!admin} onChange={set('colors')} /><span className="hint">The first color is the primary. Not every design adapts well; check a preview after changing.</span></div>
        <div className="field">
          <span className="label">Saved palettes</span>
          {b.palettes.map((p, i) => <div key={i} className="row"><BrandColors colors={p} disabled={!admin} onChange={(c) => setB({ ...b, palettes: b.palettes.map((x, j) => (j === i ? c : x)) })} />{admin && <button className="btn ghost sm" onClick={() => setB({ ...b, colors: p })}>Use</button>}{admin && <button className="btn ghost sm" onClick={() => setB({ ...b, palettes: b.palettes.filter((_, j) => j !== i) })}>✕</button>}</div>)}
          {admin && b.palettes.length < 5 && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setB({ ...b, palettes: [...b.palettes, [...b.colors]] })}>＋ Save current colors as palette</button>}
        </div>
        <div className="grid g2">
          <div className="field"><label htmlFor="fh">Heading font</label><select id="fh" className="select" disabled={!admin} value={b.font_heading} onChange={set('font_heading')}>{catalog.fonts.map((f) => <option key={f}>{f}</option>)}</select></div>
          <div className="field"><label htmlFor="fb">Body font</label><select id="fb" className="select" disabled={!admin} value={b.font_body} onChange={set('font_body')}>{catalog.fonts.map((f) => <option key={f}>{f}</option>)}</select></div>
        </div>
        <div className="field"><span className="label">Headline case</span><div className="chips">{[['default', 'As written'], ['title', 'Title Case'], ['upper', 'UPPERCASE']].map(([v, l]) => <button key={v} disabled={!admin} className={`chip ${b.text_case === v ? 'on' : ''}`} onClick={() => setB({ ...b, text_case: v })}>{l}</button>)}</div></div>
        {admin && <AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={save}>Save brand</AsyncButton>}
      </div>
      {site && <FetchSite onClose={() => setSite(false)} onFetched={(d) => setB({ ...b, name: d.name || b.name, website: d.website, description: d.description || b.description, industry: d.industry || b.industry, colors: d.colors.length ? d.colors : b.colors, handle: d.handle || b.handle, logo_url: d.logo })} />}
    </div>
  );
}

function FetchSite({ onClose, onFetched }) {
  const { toast } = useApp();
  const [url, setUrl] = useState('');
  return (
    <Modal title="Fetch details from website" onClose={onClose} footer={<AsyncButton className="btn primary" disabled={!url} onError={(e) => toast(e.message, 'err')} onClick={async () => { onFetched(await post('/api/brands/from-website', { url })); toast('Fetched. Review and save.', 'ok'); onClose(); }}>Fetch details</AsyncButton>}>
      <div className="stack"><p className="small muted">We replace your business and brand details with what we find on the website. Review before saving.</p><input className="input" placeholder="yourbrand.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Website" /></div>
    </Modal>
  );
}

function Social() {
  const { catalog, toast, can } = useApp();
  const [accounts, { reload }] = useLoad(() => get('/api/accounts'), []);
  const [tokenFor, setTokenFor] = useState(null);
  if (!catalog || !accounts) return <Loading />;
  const admin = can('admin');
  const connect = async (p) => {
    if (p.auth === 'token') return setTokenFor(p);
    try {
      const { url } = await post(`/api/accounts/oauth/${p.id}`);
      window.location.href = url;
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  return (
    <div className="stack">
      {accounts.some((a) => a.needs_relink) && <div className="alert warn">Some accounts were disconnected. Relink them to keep scheduled posts on track.</div>}
      <div className="card">
        <div className="card-head"><h3>Connected accounts ({accounts.length})</h3></div>
        {!accounts.length ? <Empty icon="🔌" title="No social accounts connected">Connect at least one account to publish or schedule. Try the Sandbox channel to test the full flow.</Empty> : (
          <table className="table"><tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td style={{ width: 40 }}><Avatar src={a.avatar} name={a.name} /></td>
                <td><div className="bold">{a.name}</div><div className="tiny muted">{PLATFORM_ICON[a.platform]} {catalog.platforms.find((p) => p.id === a.platform)?.label}{a.username ? ` · @${a.username}` : ''}{a.followers != null ? ` · ${a.followers.toLocaleString()} followers` : ''}</div></td>
                <td>{a.needs_relink ? <span className="badge err">Needs relink</span> : <span className="badge ok">Active</span>}</td>
                <td>{a.boards?.length > 0 && <select className="select" style={{ width: 180 }} value={a.board_id || ''} disabled={!admin} onChange={async (e) => { await patch(`/api/accounts/${a.id}`, { board_id: e.target.value }); reload(); }} aria-label="Pinterest board">{a.boards.map((bd) => <option key={bd.id} value={bd.id}>{bd.name}</option>)}</select>}</td>
                <td className="right nowrap">{admin && a.needs_relink && <button className="btn sm" onClick={() => connect(catalog.platforms.find((p) => p.id === a.platform))}>Relink</button>} {admin && <AsyncButton className="btn ghost sm danger" onClick={async () => { await del(`/api/accounts/${a.id}`); reload(); }}>Disconnect</AsyncButton>}</td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
      <h3>Add a channel</h3>
      <p className="small muted">You log in on each platform’s own page and choose what to share. Prepostly never sees your password, and you can disconnect at any time.</p>
      <div className="type-grid">
        {catalog.platforms.filter((p) => p.auth === 'token' || p.configured).map((p) => (
          <button key={p.id} className="type-card" disabled={!admin} onClick={() => connect(p)}>
            <span className="emoji">{PLATFORM_ICON[p.id]}</span>
            <span className="lbl">{p.label}</span>
            <span className="tiny muted">{p.media.join(' · ')}</span>
            <span className="tiny" style={{ color: 'var(--ok)' }}>{p.auth === 'token' ? 'Connect with a token' : `Log in with ${p.label.split(' ')[0]}`}</span>
          </button>
        ))}
      </div>
      {catalog.platforms.some((p) => p.auth === 'oauth' && !p.configured) && <p className="tiny muted">Coming soon: {catalog.platforms.filter((p) => p.auth === 'oauth' && !p.configured).map((p) => p.label).join(', ')}</p>}
      {tokenFor && <TokenConnect platform={tokenFor} onClose={() => setTokenFor(null)} onDone={reload} />}
    </div>
  );
}

function TokenConnect({ platform, onClose, onDone }) {
  const { toast } = useApp();
  const [vals, setVals] = useState({});
  return (
    <Modal title={`Connect ${platform.label}`} onClose={onClose} footer={<AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={async () => { const r = await post(`/api/accounts/connect/${platform.id}`, vals); toast(`Connected ${r.map((a) => a.name).join(', ')}`, 'ok'); onDone(); onClose(); }}>Connect</AsyncButton>}>
      <div className="stack">
        {platform.id === 'sandbox' && <p className="small muted">The Sandbox channel “publishes” into the server’s outbox folder so you can try scheduling, approvals and auto posting without real accounts.</p>}
        {platform.fields.map((f) => <div key={f.key} className="field"><label htmlFor={f.key}>{f.label}</label><input id={f.key} className="input" type={f.secret ? 'password' : 'text'} autoComplete="off" value={vals[f.key] || ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} /></div>)}
      </div>
    </Modal>
  );
}

function Integrations() {
  const { toast, can } = useApp();
  const [stores, { reload }] = useLoad(() => get('/api/stores'), []);
  const [products, { reload: reloadProducts }] = useLoad(() => get('/api/products'), []);
  const [url, setUrl] = useState('');
  const fail = (e) => toast(e.message, 'err');
  return (
    <div className="stack">
      <div className="card pad stack">
        <h3>Connect your store</h3>
        <p className="small muted">Shopify, WooCommerce, and any store with schema.org product data (Wix, Squarespace, Ecwid and others). We import product names, prices and photos.</p>
        {can('admin') && <div className="row"><input className="input" placeholder="https://yourstore.com" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Store URL" /><AsyncButton className="btn primary" disabled={!url} onError={fail} onClick={async () => { const r = await post('/api/stores', { url }); toast(`Imported ${r.imported} products from ${r.store.platform}`, 'ok'); setUrl(''); reload(); reloadProducts(); }}>Import products</AsyncButton></div>}
        {(stores || []).map((s) => (
          <div key={s.id} className="row small" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            <span className="badge brand">{s.platform}</span><span className="bold">{s.name}</span><span className="muted">{s.product_count} products · synced {fmtDate(s.last_sync_at)}</span>
            {can('admin') && <span className="right row"><AsyncButton className="btn sm" onError={fail} onClick={async () => { const r = await post(`/api/stores/${s.id}/sync`); toast(`Synced (${r.added} new)`, 'ok'); reload(); reloadProducts(); }}>↻ Sync</AsyncButton><AsyncButton className="btn ghost sm danger" onClick={async () => { await del(`/api/stores/${s.id}`); reload(); reloadProducts(); }}>Remove</AsyncButton></span>}
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-head"><h3>Products ({products?.length ?? 0})</h3></div>
        {!products?.length ? <Empty icon="🛍️" title="No products yet">Import from your store above, or add products in Ads Studio.</Empty> : (
          <table className="table"><tbody>{products.map((p) => (
            <tr key={p.id}>
              <td style={{ width: 56 }}>{p.images[0] && <img src={p.images[0]} alt="" style={{ width: 44, height: 44, objectFit: 'cover', borderRadius: 8 }} />}</td>
              <td><div className="bold">{p.title}</div><div className="tiny muted clip" style={{ maxWidth: 420 }}>{p.description}</div></td>
              <td className="nowrap">{p.price && `${p.currency || ''} ${p.price}`}{p.compare_at_price && <span className="faint" style={{ textDecoration: 'line-through', marginLeft: 6 }}>{p.compare_at_price}</span>}</td>
              <td className="small muted">{p.posted_count} posts</td>
              <td className="nowrap right"><a className="btn sm" href={`/app/create?type=ecom_product&product=${p.id}`}>Create post</a> {can('editor') && <AsyncButton className="btn ghost sm" onClick={async () => { await del(`/api/products/${p.id}`); reloadProducts(); }}>✕</AsyncButton>}</td>
            </tr>
          ))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function Uploads() {
  const { toast, can } = useApp();
  const [kind, setKind] = useState('');
  const [items, { reload }] = useLoad(() => get(`/api/uploads${kind ? `?kind=${kind}` : ''}`), [kind]);
  const input = useRef(null);
  return (
    <div className="stack">
      <div className="row">
        <div className="chips">{[['', 'All'], ['image', 'Images'], ['video', 'Videos'], ['audio', 'Audio']].map(([v, l]) => <button key={v} className={`chip ${kind === v ? 'on' : ''}`} onClick={() => setKind(v)}>{l}</button>)}</div>
        {can('editor') && <button className="btn primary right" onClick={() => input.current.click()}>⬆️ Upload files</button>}
        <input ref={input} type="file" multiple hidden accept="image/*,video/mp4,audio/*" onChange={async (e) => { try { for (const f of e.target.files) await upload(f); toast('Uploaded', 'ok'); reload(); } catch (err) { toast(err.message, 'err'); } }} />
      </div>
      {!items?.length ? <Empty icon="🖼️" title="No uploads on this brand yet">Upload photos, videos and audio to use in your posts.</Empty> : (
        <div className="post-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))' }}>
          {items.map((u) => (
            <div key={u.id} className="post-card">
              <div className="post-thumb" style={{ aspectRatio: '1' }}>{u.kind === 'image' ? <img src={u.file} alt={u.name} /> : u.kind === 'video' ? <video src={u.file} muted /> : <div className="gen">🎵</div>}</div>
              <div className="post-meta"><span className="title small">{u.name}</span><div className="row between tiny muted"><span>{fmtBytes(u.size)}</span>{can('editor') && <AsyncButton className="btn ghost sm" onClick={async () => { await del(`/api/uploads/${u.id}`); reload(); }}>Delete</AsyncButton>}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Templates() {
  const { catalog, can } = useApp();
  const [items, { reload }] = useLoad(() => get('/api/templates'), []);
  if (!items) return <Loading />;
  if (!items.length) return <Empty icon="⭐" title="No saved templates">Open any post and choose “Save as template” to reuse its layout.</Empty>;
  return (
    <div className="card"><table className="table"><thead><tr><th>Name</th><th>Type</th><th>Design</th><th>Size</th><th /></tr></thead><tbody>
      {items.map((t) => (
        <tr key={t.id}>
          <td className="bold">{t.name}</td><td>{catalog?.post_types[t.post_type]?.label}</td><td>{catalog?.templates[t.template]?.label}</td><td>{catalog?.formats[t.format]?.label}</td>
          <td className="right nowrap"><a className="btn sm" href={`/app/create?type=${t.post_type}&template=${t.id}`}>Use</a> {can('editor') && <AsyncButton className="btn ghost sm" onClick={async () => { await del(`/api/templates/${t.id}`); reload(); }}>Delete</AsyncButton>}</td>
        </tr>
      ))}
    </tbody></table></div>
  );
}
