import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, fmtDate, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Loading, StatusBadge, Switch, Tabs } from '../components/ui.jsx';
import JobDetail from '../components/JobDetail.jsx';

const TYPES = [['single_image', '🖼️ Single image'], ['carousel', '🎠 Carousel'], ['quote', '💬 Quote'], ['meme', '😂 Meme'], ['video', '🎬 Short video'], ['voiceover_video', '🎙️ Voiceover video'], ['ad_creative', '📣 Ad creative']];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HORIZONS = [[7, '1 week'], [14, '2 weeks'], [30, '1 month']];
const horizonLabel = (d) => HORIZONS.find(([v]) => v === d)?.[1] || `${d} days`;

export default function Autopilot({ review }) {
  const { toast, catalog, can, brand } = useApp();
  const [ap, { loading, reload, setData }] = useLoad(() => get('/api/autopilot'), []);
  const [accounts] = useLoad(() => get('/api/accounts'), []);
  const [queue, { reload: reloadQueue }] = useLoad(() => get('/api/autopilot/review'), []);
  const [tab, setTab] = useState(review ? 'review' : 'setup');
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => { if (ap && !form) setForm({ ...ap }); }, [ap, form]);
  useEffect(() => { setTab(review ? 'review' : 'setup'); }, [review]);
  const fail = (e) => toast(e.message, 'err');
  if (loading || !form) return <Loading />;
  const set = (k, v) => setForm({ ...form, [k]: v });
  const toggle = (k, v) => set(k, form[k].includes(v) ? form[k].filter((x) => x !== v) : [...form[k], v]);
  const admin = can('admin');

  const save = async (extra = {}) => {
    const saved = await put('/api/autopilot', { source: form.source, direction: form.direction, post_types: form.post_types, days: form.days, times: form.times, account_ids: form.account_ids, require_approval: form.require_approval, format: form.format, horizon_days: form.horizon_days, ...extra });
    setData({ ...ap, ...saved });
    setForm({ ...form, ...saved });
    await reload();
    return saved;
  };

  return (
    <>
      <div className="page-head">
        <div><h1>🤖 Auto posting</h1><p>Set it up once. We’ll keep posting for {catalog ? 'you' : ''}: create, schedule, publish, grow.</p></div>
        <div className="row">
          <span className={`badge ${ap.enabled ? 'ok' : ''}`}>{ap.enabled ? '● Active' : 'Paused'}</span>
          {admin && <AsyncButton className={`btn ${ap.enabled ? '' : 'primary'}`} onError={fail} onClick={async () => { await save({ enabled: !ap.enabled }); toast(ap.enabled ? 'Auto posting paused' : 'Auto posting is on', 'ok'); }}>{ap.enabled ? 'Pause' : 'Turn on'}</AsyncButton>}
          {admin && ap.enabled && <AsyncButton className="btn" onError={fail} onClick={async () => { const r = await post('/api/autopilot/run'); toast(r.created ? `Created ${r.created} posts` : r.error || 'All upcoming slots are already filled', r.error ? 'err' : 'ok'); reload(); reloadQueue(); }}>Fill next {horizonLabel(ap.horizon_days)} now</AsyncButton>}
        </div>
      </div>
      {!ap.allowed && <div className="alert warn mb">Auto posting isn’t included in your plan. <Link to="/app/account">Upgrade to Rise or Enterprise</Link>.</div>}
      {ap.last_error && <div className="alert err mb">{ap.last_error}</div>}
      <Tabs value={tab} onChange={setTab} tabs={[['setup', 'Setup'], ['review', `Review queue (${queue?.filter((j) => j.status === 'in_review').length ?? 0})`]]} />
      {tab === 'setup' && (
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div className="card pad stack">
            <h3>What should your posts focus on?</h3>
            <div className="chips">{[['topics', '✍️ Topics & direction'], ['products', `🛍️ My store products (${ap.products})`]].map(([v, l]) => <button key={v} className={`chip ${form.source === v ? 'on' : ''}`} disabled={!admin} onClick={() => set('source', v)}>{l}</button>)}</div>
            <textarea className="textarea" rows={4} disabled={!admin} value={form.direction} onChange={(e) => set('direction', e.target.value)} placeholder="e.g. Brewing tips for beginners, behind the scenes at our roastery, new coffee launches" aria-label="Content direction" />
            <span className="tiny muted">{form.direction.length}/1000 · Not sure? Add any of these:</span>
            <div className="chips">{(catalog?.autopilot_suggestions || []).map((s) => <button key={s} className="chip" disabled={!admin} onClick={() => set('direction', form.direction ? `${form.direction}, ${s.toLowerCase()}` : s)}>＋ {s}</button>)}</div>
            <h3 className="mt">Post types</h3>
            <div className="chips">{TYPES.map(([v, l]) => <button key={v} className={`chip ${form.post_types.includes(v) ? 'on' : ''}`} disabled={!admin} onClick={() => toggle('post_types', v)}>{l}</button>)}</div>
            <div className="field"><label htmlFor="af">Size</label><select id="af" className="select" disabled={!admin} value={form.format} onChange={(e) => set('format', e.target.value)}>{Object.entries(catalog?.formats || {}).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}</select></div>
          </div>
          <div className="card pad stack">
            <h3>When</h3>
            <div className="chips">{DAYS.map((d, i) => <button key={d} className={`chip ${form.days.includes(i) ? 'on' : ''}`} disabled={!admin} onClick={() => toggle('days', i)}>{d}</button>)}</div>
            <div className="row wrap">
              {form.times.map((t, i) => <input key={i} type="time" className="input" style={{ width: 120 }} disabled={!admin} value={t} onChange={(e) => set('times', form.times.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Time ${i + 1}`} />)}
              {admin && form.times.length < 4 && <button className="btn sm" onClick={() => set('times', [...form.times, '18:00'])}>＋ Time</button>}
              {admin && form.times.length > 1 && <button className="btn ghost sm" onClick={() => set('times', form.times.slice(0, -1))}>－</button>}
            </div>
            <div className="field"><label htmlFor="ah">Plan ahead</label>
              <div className="chips" id="ah">{HORIZONS.map(([v, l]) => <button key={v} className={`chip ${form.horizon_days === v ? 'on' : ''}`} disabled={!admin} onClick={() => set('horizon_days', v)}>{l}</button>)}</div>
            </div>
            <h3 className="mt">Channels</h3>
            {!accounts?.length ? <div className="alert info small">Connect a channel first. <Link to="/app/brand?tab=social">Connect</Link></div> : accounts.map((a) => (
              <label key={a.id} className="checkbox"><input type="checkbox" disabled={!admin} checked={form.account_ids.includes(a.id)} onChange={() => toggle('account_ids', a.id)} />{PLATFORM_ICON[a.platform]} {a.name}</label>
            ))}
            <div className="divider" />
            <Switch on={form.require_approval} disabled={!admin} onChange={(v) => set('require_approval', v)} label="Approve posts before they go live" />
            <p className="tiny muted">Posts are created up to {horizonLabel(form.horizon_days)} ahead and topped up every day. {form.require_approval ? 'They wait in the review queue until approved.' : 'They publish automatically at their time.'}</p>
            {admin && <AsyncButton className="btn primary" onError={fail} onClick={async () => { await save(); toast('Auto posting settings saved', 'ok'); }}>Save settings</AsyncButton>}
            {ap.upcoming_slots?.length > 0 && <p className="tiny muted">{ap.upcoming_slots.length} posts in the next {horizonLabel(ap.horizon_days)}. Next: {ap.upcoming_slots.slice(0, 3).map((s) => fmtDate(s, { weekday: 'short' })).join(' · ')}</p>}
          </div>
        </div>
      )}
      {tab === 'review' && (
        <div className="stack">
          {queue?.some((j) => j.status === 'in_review') && can('reviewer') && <div className="row"><AsyncButton className="btn primary" onError={fail} onClick={async () => { const r = await post('/api/autopilot/review/approve-all'); toast(`Approved ${r.approved} posts`, 'ok'); reloadQueue(); }}>✅ Approve all</AsyncButton></div>}
          {!queue?.length ? <div className="card pad muted">Nothing in the queue. Turn auto posting on and it will fill your next {horizonLabel(ap.horizon_days)}.</div> : (
            <div className="post-grid">
              {queue.map((j) => (
                <div key={j.id} className="post-card" onClick={() => setOpen(j.id)} style={{ cursor: 'pointer' }}>
                  <div className="post-thumb">{j.post?.cover ? <img src={j.post.cover} alt="" /> : <div className="gen">{j.post?.status === 'failed' ? '⚠️ Failed' : 'Generating…'}</div>}</div>
                  <div className="post-meta"><span className="title">{j.post?.title}</span><div className="row between tiny"><span className="muted">{fmtDate(j.scheduled_at, { weekday: 'short' })}</span><StatusBadge status={j.status} /></div></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {open && <JobDetail jobId={open} onClose={() => setOpen(null)} onChange={reloadQueue} />}
    </>
  );
}
