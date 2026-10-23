import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { post, TYPE_ICON } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Loading, Spinner, Switch } from '../components/ui.jsx';
import { ProductPicker, UploadPicker } from '../components/Pickers.jsx';

const GROUPS = ['Images', 'Videos', 'E-commerce', 'Ads', 'Repurpose'];
const NEEDS_PRODUCT = ['ecom_product', 'ecom_carousel', 'ecom_video', 'ad_creative'];
const EXAMPLES = {
  single_image: 'Why fresh ingredients make all the difference',
  carousel: '5 mistakes beginners make with home workouts',
  quote: 'Motivation for small business owners',
  meme: 'When the client says "just one small change"',
  video: '3 quick tips to stay productive when working from home',
  voiceover_video: 'How our coffee goes from farm to cup',
  text_to_video: 'Paste your script here, one scene per line',
};

export default function Create() {
  const { catalog, me, brand, toast, refresh, can } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [type, setType] = useState(params.get('type') || null);
  const [f, setF] = useState({ prompt: params.get('prompt') || '', format: '', template: 'auto', language: '', tone: '', slides: 0, media_source: 'auto', image_urls: [], product_id: params.get('product') || null, article_url: '', special_day: '', boost: false, template_id: params.get('template') || undefined });
  const [busy, setBusy] = useState(false);
  const [boosting, setBoosting] = useState(false);
  const [error, setError] = useState('');

  const meta = type && catalog?.post_types[type];
  useEffect(() => {
    if (!meta) return;
    setF((x) => ({ ...x, format: x.format || (meta.media === 'video' ? 'story' : 'ig_portrait'), slides: meta.slides, language: x.language || brand?.language || 'English', tone: x.tone || brand?.tone || 'Friendly' }));
  }, [type, meta, brand]);

  const estimate = useMemo(() => {
    if (!meta || !catalog) return 0;
    const c = catalog.costs;
    let cost = type === 'avatar_video' ? c.avatar_video : type === 'voiceover_video' ? c.voiceover_video : meta.media === 'video' ? c.video : meta.media === 'carousel' ? c.image + c.carousel_slide * Math.max(0, f.slides - 1) : c.image;
    if (f.media_source === 'ai' && type !== 'avatar_video') cost += c.ai_image;
    return cost;
  }, [meta, catalog, f.slides, f.media_source, type]);

  if (!catalog) return <Loading />;
  if (!can('editor')) return <div className="alert warn">Reviewers can view and approve content but can’t create it. Ask a brand admin for the editor role.</div>;
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'number' ? Number(e.target.value) : e.target.value) : e });

  const boost = async () => {
    setBoosting(true);
    try {
      const r = await post('/api/posts/boost-prompt', { prompt: f.prompt, type });
      setF({ ...f, prompt: r.prompt });
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBoosting(false);
    }
  };

  const generate = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body = { type, ...f, image_urls: f.media_source === 'upload' ? f.image_urls : undefined, media_source: f.media_source === 'upload' ? 'auto' : f.media_source, article_url: f.article_url || undefined, special_day: f.special_day || undefined, product_id: NEEDS_PRODUCT.includes(type) ? f.product_id : undefined };
      const p = await post('/api/posts', body);
      refresh();
      nav(`/app/posts/${p.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  if (!type) {
    return (
      <>
        <div className="page-head"><div><h1>Create your next post</h1><p>Choose a media type to get started.</p></div></div>
        {GROUPS.map((g) => (
          <section key={g} className="mb" style={{ marginBottom: 26 }}>
            <h3 className="mb" style={{ marginBottom: 12 }}>{g}</h3>
            <div className="type-grid">
              {Object.entries(catalog.post_types).filter(([, t]) => t.group === g).map(([id, t]) => (
                <button key={id} className="type-card" onClick={() => setType(id)} disabled={t.requires === 'heygen' && !me.capabilities.avatar_video} title={t.requires === 'heygen' && !me.capabilities.avatar_video ? 'Avatar videos aren’t available yet' : ''} style={t.requires === 'heygen' && !me.capabilities.avatar_video ? { opacity: 0.55 } : undefined}>
                  <span className="emoji">{TYPE_ICON[id]}</span>
                  <span className="lbl">{t.label}</span>
                  <span className="small muted">{t.description}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }

  const isVideo = meta.media === 'video';
  const multi = meta.media === 'carousel' || isVideo;
  return (
    <form onSubmit={generate}>
      <div className="page-head">
        <div className="row"><button type="button" className="btn ghost" onClick={() => setType(null)}>← All types</button><h1>{TYPE_ICON[type]} {meta.label}</h1></div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)', alignItems: 'start' }}>
        <div className="card pad stack">
          {error && <div className="alert err">{error}</div>}
          {NEEDS_PRODUCT.includes(type) && (
            <div className="field"><span className="label">Product</span><ProductPicker value={f.product_id} onChange={set('product_id')} /></div>
          )}
          {type === 'blog_to_carousel' && (
            <div className="field"><label htmlFor="art">Article URL</label><input id="art" className="input" placeholder="https://yourblog.com/post" value={f.article_url} onChange={set('article_url')} /><span className="hint">Or paste the article text below instead.</span></div>
          )}
          {type === 'special_day' && (
            <div className="field">
              <span className="label">Occasion</span>
              <div className="chips">{catalog.special_days.map((d) => <button type="button" key={d.date + d.name} className={`chip ${f.special_day === d.name ? 'on' : ''}`} onClick={() => setF({ ...f, special_day: d.name })}>{d.name} · {new Date(d.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</button>)}</div>
              <input className="input" placeholder="…or type any occasion" value={f.special_day} onChange={set('special_day')} />
            </div>
          )}
          <div className="field">
            <div className="row between"><label htmlFor="prompt">{type === 'text_to_video' || type === 'blog_to_carousel' ? 'Text' : 'What is your post about?'}</label>
              <button type="button" className="btn ghost sm" onClick={boost} disabled={boosting || f.prompt.trim().length < 3}>{boosting ? <Spinner /> : '🚀'} Boost prompt</button></div>
            <textarea id="prompt" className="textarea" rows={type === 'text_to_video' || type === 'blog_to_carousel' ? 8 : 4} placeholder={EXAMPLES[type] || 'Describe the post, or list the points you want on each slide (one per line).'} value={f.prompt} onChange={set('prompt')} />
            <span className="hint">Tip: write one point per line and each becomes a slide.</span>
          </div>
          {type === 'avatar_video' ? <p className="small muted">A HeyGen presenter speaks a 20–30 second script written from your description. Rendering takes a few minutes.</p> : <div className="field">
            <span className="label">Images</span>
            <div className="chips">
              {[['auto', 'Auto'], ['stock', 'Stock photos'], ['ai', 'AI generated'], ['upload', 'My uploads'], ['none', 'Design only']].map(([v, l]) => (
                <button type="button" key={v} className={`chip ${f.media_source === v ? 'on' : ''}`} onClick={() => setF({ ...f, media_source: v })} disabled={(v === 'stock' && !me.capabilities.stock) || (v === 'ai' && !me.capabilities.ai_images)} title={v === 'stock' && !me.capabilities.stock ? 'Stock photos aren’t available yet' : v === 'ai' && !me.capabilities.ai_images ? 'AI images aren’t available yet' : ''}>{l}</button>
              ))}
            </div>
            {f.media_source === 'upload' && <UploadPicker selected={f.image_urls} onChange={set('image_urls')} max={10} />}
          </div>}
          <Switch on={f.boost} onChange={(v) => setF({ ...f, boost: v })} label="Prompt booster: automatically enrich my prompt" />
        </div>
        <div className="card pad stack">
          <div className="field"><label htmlFor="fmt">Size</label>
            <select id="fmt" className="select" value={f.format} onChange={set('format')}>{Object.entries(catalog.formats).map(([k, v]) => <option key={k} value={k}>{v.label} · {v.uses[0]}</option>)}</select>
          </div>
          {type !== 'avatar_video' && <div className="field"><label htmlFor="tpl">Design</label>
            <select id="tpl" className="select" value={f.template} onChange={set('template')}><option value="auto">Auto (best match)</option>{Object.entries(catalog.templates).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select>
          </div>}
          {multi && type !== 'avatar_video' && (
            <div className="field"><label htmlFor="sl">{isVideo ? 'Scenes' : 'Slides'}: {f.slides}</label><input id="sl" type="range" min={isVideo ? 2 : 2} max={10} value={f.slides} onChange={set('slides')} /></div>
          )}
          <div className="grid g2">
            <div className="field"><label htmlFor="lang">Language</label><select id="lang" className="select" value={f.language} onChange={set('language')}>{catalog.languages.map((l) => <option key={l}>{l}</option>)}</select></div>
            <div className="field"><label htmlFor="tone">Tone</label><select id="tone" className="select" value={f.tone} onChange={set('tone')}>{catalog.tones.map((t) => <option key={t}>{t}</option>)}</select></div>
          </div>
          {isVideo && !['voiceover_video', 'text_to_video', 'avatar_video'].includes(type) && <p className="tiny muted">Want narration? Use the Voiceover video type.</p>}
          {me.capabilities.writer === 'offline' && f.language !== 'English' && <div className="alert warn small">Posts in other languages aren’t available yet, so this one will be written in English.</div>}
          <div className="divider" style={{ margin: '4px 0' }} />
          <div className="row between"><span className="muted">Cost</span><span className="bold">{estimate} credits</span></div>
          <div className="row between small"><span className="muted">Balance</span><span>{me.brand_credits.toLocaleString()}</span></div>
          <button className="btn primary lg block" disabled={busy}>{busy && <Spinner />}Generate</button>
        </div>
      </div>
    </form>
  );
}
