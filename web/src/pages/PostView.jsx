import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post, patch, del, fmtDate, PLATFORM_ICON, TYPE_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Dropdown, ErrorBox, Loading, Modal, Spinner, StatusBadge, Tabs } from '../components/ui.jsx';
import { UploadPicker } from '../components/Pickers.jsx';
import PublishDialog from '../components/PublishDialog.jsx';

const LOADER = ['Fine-tuning your message for clarity…', 'Picking colors from your brand kit…', 'Laying out your slides…', 'Writing your caption…', 'Adding the finishing touches…'];

const FIELDS = {
  cover: ['kicker', 'headline', 'body'],
  point: ['headline', 'body'],
  cta: ['headline', 'body', 'cta'],
  quote: ['headline', 'author'],
  meme: ['top', 'bottom'],
  product: ['headline', 'body', 'price', 'compareAt', 'badge', 'cta'],
  ad: ['headline', 'body', 'price', 'compareAt', 'badge', 'cta', 'disclaimer'],
  stat: ['stat', 'headline', 'body'],
};
const LABEL = { kicker: 'Label', headline: 'Headline', body: 'Body text', cta: 'Button', author: 'Author', top: 'Top text', bottom: 'Bottom text', price: 'Price', compareAt: 'Was price', badge: 'Badge', disclaimer: 'Disclaimer', stat: 'Big number', narration: 'Voiceover line' };

export default function PostView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { toast, catalog, can, refresh } = useApp();
  const [p, { loading, error, reload, setData }] = useLoad(() => get(`/api/posts/${id}`), [id]);
  const [tab, setTab] = useState('edit');
  const [slide, setSlide] = useState(0);
  const [draft, setDraft] = useState(null);
  const [publishing, setPublishing] = useState(false);
  const [tick, setTick] = useState(0);
  const [picker, setPicker] = useState(false);

  const prevStatus = useRef(p?.status);
  useEffect(() => {
    if (prevStatus.current === 'rendering' && p?.status === 'ready' && !p.error) toast('Video updated', 'ok');
    prevStatus.current = p?.status;
  }, [p?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!['generating', 'rendering'].includes(p?.status)) return;
    const t = setInterval(() => { setTick((x) => x + 1); reload(); }, 2000);
    return () => clearInterval(t);
  }, [p?.status, reload]);
  useEffect(() => { if (p?.content?.slides) setDraft(structuredClone(p.content.slides)); }, [p?.version, p?.content?.slides?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !p) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const fail = (e) => toast(e.message, 'err');

  if (p.status === 'generating') {
    return (
      <div className="card pad center" style={{ padding: 60 }}>
        <div className="row" style={{ justifyContent: 'center' }}><Spinner lg /></div>
        <h2 className="mt">Creating your content…</h2>
        <p className="muted mt">{LOADER[tick % LOADER.length]}</p>
        <p className="tiny faint mt">{p.media_type === 'video' ? 'Videos take up to a minute.' : 'This usually takes a few seconds.'} You can leave this page; it will appear in your library.</p>
      </div>
    );
  }
  if (p.status === 'failed') {
    return (
      <div className="card pad center" style={{ padding: 50 }}>
        <div style={{ fontSize: 40 }}>⚠️</div>
        <h2 className="mt">Couldn’t generate this post</h2>
        <p className="muted mt">{p.error}</p>
        <p className="small ok mt" style={{ color: 'var(--ok)' }}>No credits were used.</p>
        <div className="row mt" style={{ justifyContent: 'center' }}>
          <AsyncButton className="btn primary" onError={fail} onClick={async () => { setData(await post(`/api/posts/${id}/retry`)); refresh(); }}>Try again</AsyncButton>
          <Link className="btn" to="/app/create">Create something else</Link>
        </div>
      </div>
    );
  }

  const images = p.media.filter((m) => m.kind === 'image' || m.kind === 'frame');
  const video = p.media.find((m) => m.kind === 'video');
  // HeyGen renders the presenter once, so avatar videos have no slide or design editing.
  const avatar = p.type === 'avatar_video';
  const view = avatar && ['edit', 'design'].includes(tab) ? 'caption' : tab;
  const s = draft?.[slide];
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(p.content.slides);
  // A video re-encodes in the background after an edit; the current version stays visible meanwhile.
  const updating = p.status === 'rendering';
  const editable = can('editor');
  const canChange = editable && !updating;

  const saveSlides = async () => {
    const updated = await patch(`/api/posts/${id}`, { content: { slides: draft } });
    setData({ ...p, ...updated });
    toast(updated.status === 'rendering' ? 'Updating the video…' : 'Changes applied', updated.status === 'rendering' ? undefined : 'ok');
  };
  const setField = (k, v) => setDraft(draft.map((x, i) => (i === slide ? { ...x, [k]: v } : x)));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row"><Link to="/app/library" className="btn ghost sm">← Library</Link><span className="badge">{TYPE_ICON[p.type]} {catalog?.post_types[p.type]?.label}</span><span className="badge">{catalog?.formats[p.format]?.label}</span>{p.parent_id && <span className="badge info">Resized variant</span>}</div>
          <h1 style={{ marginTop: 8 }}>{p.title}</h1>
          <p className="small">Created {fmtDate(p.created_at)} · v{p.version} · {p.writer === 'claude' ? 'Written by Claude' : 'Offline writer'} · {p.credits_used} credits</p>
        </div>
        <div className="row wrap">
          {editable && <button className="btn primary" disabled={updating} onClick={() => setPublishing(true)}>🚀 Publish / schedule</button>}
          <Dropdown trigger={<button className="btn">⋯ More</button>}>
            {(video ? [video] : images).map((m, i) => <a key={m.url} href={m.url} download>{video ? '⬇️ Download video (MP4)' : `⬇️ Download slide ${i + 1}`}</a>)}
            {editable && <button onClick={async () => { try { const d = await post(`/api/posts/${id}/duplicate`); nav(`/app/posts/${d.id}`); toast('Duplicated', 'ok'); } catch (e) { fail(e); } }}>📄 Duplicate</button>}
            {editable && <button onClick={async () => { try { await post(`/api/posts/${id}/template`, { name: p.title }); toast('Saved to your templates', 'ok'); } catch (e) { fail(e); } }}>⭐ Save as template</button>}
            {editable && <button onClick={async () => { try { const r = await post(`/api/posts/${id}/share`); const url = `${location.origin}${r.url}`; await navigator.clipboard?.writeText(url).catch(() => {}); toast(`Share link copied: ${url}`, 'ok'); } catch (e) { fail(e); } }}>🔗 Copy share link</button>}
            {editable && <button onClick={async () => { await post(`/api/posts/${id}/archive`, { archived: !p.archived }); toast(p.archived ? 'Restored' : 'Archived', 'ok'); reload(); }}>🗄️ {p.archived ? 'Restore' : 'Archive'}</button>}
            {editable && <button style={{ color: 'var(--err)' }} onClick={async () => { if (!confirm('Delete this post permanently?')) return; try { await del(`/api/posts/${id}`); toast('Deleted'); nav('/app/library'); } catch (e) { fail(e); } }}>🗑️ Delete</button>}
          </Dropdown>
        </div>
      </div>
      {updating && <div className="alert info mb"><Spinner /><span>Updating the video with your changes. This takes about a minute; you can leave this page.</span></div>}
      {!updating && p.error && <div className="alert warn mb"><span>⚠️</span><span>{p.error} Your previous version is unchanged.</span></div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)', alignItems: 'start' }}>
        <div className="card pad stack">
          {video && <video className="preview-video" src={video.url} poster={p.cover} controls playsInline style={{ alignSelf: 'center', maxWidth: '100%' }} />}
          {video && <p className="tiny muted center">{video.duration}s · {video.narrated ? '🎙️ narrated' : 'music-free'} · scenes below</p>}
          <div className="slides">
            {images.map((m, i) => <img key={m.url} src={`${m.url}?v=${p.version}`} alt={`Slide ${i + 1}`} className={i === slide ? 'on' : ''} onClick={() => setSlide(i)} style={video ? { height: 200 } : undefined} />)}
          </div>
          {p.variants?.length > 0 && (
            <div className="stack tight">
              <span className="label">Other sizes</span>
              <div className="row wrap">{p.variants.map((v) => <Link key={v.id} to={`/app/posts/${v.id}`} className="chip">{catalog?.formats[v.format]?.label}{!v.parent_id && ' (original)'}</Link>)}</div>
            </div>
          )}
        </div>

        <div className="card">
          <div style={{ padding: '6px 16px 0' }}><Tabs value={view} onChange={setTab} tabs={[...(avatar ? [] : [['edit', 'Edit'], ['design', 'Design & size']]), ['caption', 'Caption'], ['history', 'Publishing']]} /></div>
          <div className="card-body stack" style={{ paddingTop: 0 }}>
            {view === 'edit' && s && (
              <>
                <div className="row between"><span className="bold">{video ? 'Scene' : 'Slide'} {slide + 1} of {draft.length}</span>
                  <select className="select" style={{ width: 140 }} value={s.kind} disabled={!editable} onChange={(e) => setField('kind', e.target.value)} aria-label="Slide layout">{Object.keys(FIELDS).map((k) => <option key={k} value={k}>{k}</option>)}</select></div>
                {[...(FIELDS[s.kind] || FIELDS.cover), ...(video ? ['narration'] : [])].map((k) => (
                  <div className="field" key={k}>
                    <label htmlFor={`f-${k}`}>{LABEL[k]}</label>
                    {['body', 'narration'].includes(k) || (k === 'headline' && s.kind === 'quote')
                      ? <textarea id={`f-${k}`} className="textarea" rows={3} disabled={!editable} value={s[k] || ''} onChange={(e) => setField(k, e.target.value)} />
                      : <input id={`f-${k}`} className="input" disabled={!editable} value={s[k] || ''} onChange={(e) => setField(k, e.target.value)} />}
                  </div>
                ))}
                <div className="field">
                  <span className="label">Image</span>
                  <div className="row">
                    {s.image ? <img src={s.image} alt="" style={{ width: 54, height: 54, objectFit: 'cover', borderRadius: 8 }} /> : <span className="small muted">No image (design background)</span>}
                    {editable && <button className="btn sm" onClick={() => setPicker(true)}>Choose</button>}
                    {editable && s.image && <button className="btn sm ghost" onClick={() => setField('image', null)}>Remove</button>}
                  </div>
                  {s.image && !['photo', 'split'].includes(p.template) && !['product', 'ad', 'meme'].includes(s.kind) && <span className="hint">Switch the design to Photo overlay or Split to show this image.</span>}
                </div>
                {editable && (
                  <div className="row">
                    <AsyncButton className="btn primary" disabled={!dirty || updating} onError={fail} onClick={saveSlides}>Apply changes</AsyncButton>
                    {dirty && <button className="btn ghost" onClick={() => setDraft(structuredClone(p.content.slides))}>Reset</button>}
                  </div>
                )}
                {video && <p className="tiny muted">Applying changes re-renders the video.</p>}
              </>
            )}
            {view === 'design' && (
              <>
                <span className="label">Design</span>
                <div className="grid g2">
                  {Object.entries(catalog?.templates || {}).map(([k, t]) => (
                    <AsyncButton key={k} className={`type-card ${p.template === k ? 'on' : ''}`} disabled={!canChange || p.template === k} onError={fail} onClick={async () => { setData({ ...p, ...(await patch(`/api/posts/${id}`, { template: k })) }); }}>
                      <span className="lbl">{t.label}</span><span className="tiny muted">{t.description}</span>
                    </AsyncButton>
                  ))}
                </div>
                <div className="divider" />
                <span className="label">Resize with AI</span>
                <p className="small muted">Creates a linked copy in another size ({catalog?.costs.resize} credits).</p>
                <div className="chips">
                  {Object.entries(catalog?.formats || {}).filter(([k]) => k !== p.format).map(([k, f]) => (
                    <AsyncButton key={k} className="chip" disabled={!canChange} onError={fail} onClick={async () => { const v = await post(`/api/posts/${id}/resize`, { format: k }); toast(`Resized to ${f.ratio}`, 'ok'); refresh(); nav(`/app/posts/${v.id}`); }}>{f.label}</AsyncButton>
                  ))}
                </div>
              </>
            )}
            {view === 'caption' && <CaptionEditor p={p} setData={setData} editable={editable} />}
            {view === 'history' && (
              !p.jobs.length ? <p className="muted">Not published or scheduled yet.</p> : p.jobs.map((j) => (
                <div key={j.id} className="card pad" style={{ boxShadow: 'none' }}>
                  <div className="row between"><StatusBadge status={j.status} /><span className="small muted">{fmtDate(j.scheduled_at)}</span></div>
                  {j.targets.map((t) => (
                    <div key={t.id} className="row small mt" style={{ marginTop: 8 }}>
                      <span>{PLATFORM_ICON[t.platform]}</span><span className="clip" style={{ flex: 1 }}>{t.account_name}</span>
                      <StatusBadge status={t.status === 'pending' ? 'scheduled' : t.status} />
                      {t.url && <a href={t.url} target="_blank" rel="noreferrer">View ↗</a>}
                    </div>
                  ))}
                  {j.targets.filter((t) => t.error).map((t) => <p key={t.id} className="tiny mt" style={{ color: 'var(--err)', marginTop: 6 }}>{t.error}</p>)}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      {publishing && <PublishDialog postData={p} onClose={() => setPublishing(false)} onDone={reload} />}
      {picker && (
        <Modal title="Choose an image" onClose={() => setPicker(false)} footer={<button className="btn primary" onClick={() => setPicker(false)}>Done</button>}>
          <UploadPicker selected={s?.image ? [s.image] : []} max={1} onChange={(sel) => { setField('image', sel.at(-1) || null); }} />
        </Modal>
      )}
    </>
  );
}

function CaptionEditor({ p, setData, editable }) {
  const { toast } = useApp();
  const [caption, setCaption] = useState(p.caption);
  const [hashtags, setHashtags] = useState(p.hashtags);
  const [instruction, setInstruction] = useState('');
  const [left, setLeft] = useState(5 - (p.caption_rewrites || 0));
  const fail = (e) => toast(e.message, 'err');
  return (
    <>
      <div className="field"><label htmlFor="caption">Caption</label><textarea id="caption" className="textarea" rows={9} value={caption} disabled={!editable} onChange={(e) => setCaption(e.target.value)} /></div>
      {editable && (
        <div className="row">
          <input className="input" placeholder="e.g. shorter, more playful, add a question" value={instruction} onChange={(e) => setInstruction(e.target.value)} aria-label="Rewrite instruction" />
          <AsyncButton className="btn" disabled={left <= 0} onError={fail} onClick={async () => { const r = await post(`/api/posts/${p.id}/caption/rewrite`, { caption, instruction }); setCaption(r.caption); setLeft(r.rewrites_left); }}>✨ Rewrite</AsyncButton>
        </div>
      )}
      <span className="tiny muted">{left > 0 ? `${left} AI rewrites left for this post` : "You've used all your caption rewrites for this post. You can still edit it."}</span>
      <div className="field"><div className="row between"><label htmlFor="tags">Hashtags</label>{editable && <AsyncButton className="btn ghost sm" onError={fail} onClick={async () => setHashtags((await post(`/api/posts/${p.id}/hashtags`)).hashtags)}>↻ Regenerate</AsyncButton>}</div>
        <textarea id="tags" className="textarea" rows={3} value={hashtags} disabled={!editable} onChange={(e) => setHashtags(e.target.value)} /></div>
      <div className="row">
        {editable && <AsyncButton className="btn primary" onError={fail} onClick={async () => { setData({ ...p, ...(await patch(`/api/posts/${p.id}`, { caption, hashtags })) }); toast('Caption saved', 'ok'); }}>Save caption</AsyncButton>}
        <button className="btn" onClick={() => { navigator.clipboard?.writeText(`${caption}\n\n${hashtags}`); toast('Copied to clipboard'); }}>📋 Copy</button>
      </div>
    </>
  );
}
