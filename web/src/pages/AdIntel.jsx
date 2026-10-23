import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, del, fmtDate, fmtDay } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Empty, Loading, Modal } from '../components/ui.jsx';
import { HBars } from '../components/Charts.jsx';

export default function AdIntel() {
  const { toast, can } = useApp();
  const nav = useNavigate();
  const [data, { loading, reload }] = useLoad(() => get('/api/adintel'), []);
  const [sel, setSel] = useState(null);
  const [detail, setDetail] = useState(null);
  const [adding, setAdding] = useState(false);
  const fail = (e) => toast(e.message, 'err');
  const open = async (id) => {
    setSel(id);
    setDetail(await get(`/api/adintel/${id}`));
  };
  if (loading && !data) return <Loading />;
  const s = detail?.summary;
  return (
    <>
      <div className="page-head">
        <div><h1>🛰️ Ad intelligence</h1><p>See which ads your competitors keep running on Meta. Ads that run for months are usually the profitable ones.</p></div>
        {can('editor') && <button className="btn primary" onClick={() => setAdding(true)} disabled={data.trackers.length >= data.limit}>＋ Track a competitor</button>}
      </div>
      <p className="small muted mb">Tracking {data.trackers.length} of {data.limit} brands on your plan. Data comes from the Meta Ad Library using your connected Facebook account.</p>
      {!data.trackers.length ? <Empty icon="🛰️" title="Track your first competitor" action={can('editor') && <button className="btn primary" onClick={() => setAdding(true)}>Track a competitor</button>}>Enter a brand name or Facebook Page ID to see their running ads.</Empty> : (
        <div className="grid" style={{ gridTemplateColumns: '260px minmax(0, 1fr)', alignItems: 'start' }}>
          <div className="card" style={{ padding: 8 }}>
            {data.trackers.map((t) => (
              <button key={t.id} className={`chip ${sel === t.id ? 'on' : ''}`} style={{ display: 'flex', width: '100%', marginBottom: 6, borderRadius: 10, justifyContent: 'space-between' }} onClick={() => open(t.id)}>
                <span className="clip">{t.name}</span><span className="tiny muted">{t.summary?.total ?? '–'} ads</span>
              </button>
            ))}
          </div>
          <div className="stack">
            {!detail ? <div className="card pad muted">Select a tracked brand.</div> : (
              <>
                <div className="card pad row between wrap">
                  <div><h2>{detail.name}</h2><p className="small muted">{detail.country} · {detail.last_run_at ? `updated ${fmtDate(detail.last_run_at)}` : 'not fetched yet'}</p></div>
                  <div className="row">
                    {can('editor') && <AsyncButton className="btn primary sm" onError={fail} onClick={async () => { const d = await post(`/api/adintel/${sel}/run`); setDetail(d); if (d.status === 'error') toast(d.error, 'err'); reload(); }}>↻ Fetch ads</AsyncButton>}
                    {can('editor') && <AsyncButton className="btn ghost sm danger" onError={fail} onClick={async () => { await del(`/api/adintel/${sel}`); setDetail(null); setSel(null); reload(); }}>Stop tracking</AsyncButton>}
                  </div>
                </div>
                {detail.status === 'error' && <div className="alert err">{detail.error} <Link to="/app/brand?tab=social">Connect Facebook</Link></div>}
                {s?.total > 0 && (
                  <>
                    <div className="grid g4">
                      {[['Ads found', s.total], ['Active now', s.active], ['Running 30+ days', s.long_runners], ['Avg. days running', s.avg_days_running]].map(([l, v]) => <div key={l} className="card metric"><div className="small muted">{l}</div><div className="value">{v}</div></div>)}
                    </div>
                    <div className="grid g2">
                      <div className="card pad"><h3>Angles they use</h3><div className="mt"><HBars items={s.angles.map((a) => ({ label: a.angle, value: a.count }))} format={(v) => `${v} ads`} /></div></div>
                      <div className="card pad"><h3>Top hooks</h3>{s.top_hooks.map((h) => <p key={h.hook} className="small mt" style={{ marginTop: 8 }}>“{h.hook}” <span className="faint">×{h.count}</span></p>)}<p className="tiny muted mt">Keywords: {s.keywords.join(', ')}</p></div>
                    </div>
                    <div className="card">
                      <div className="card-head"><h3>🏆 Winners (longest running)</h3></div>
                      <table className="table"><thead><tr><th>Ad</th><th>Started</th><th>Days</th><th>Platforms</th><th /></tr></thead><tbody>
                        {s.winners.map((a) => (
                          <tr key={a.id}>
                            <td style={{ maxWidth: 380 }}><div className="bold small clip">{a.title || a.page_name}</div><div className="tiny muted clip">{a.body}</div></td>
                            <td className="nowrap small">{fmtDay(a.started)}</td>
                            <td><span className={`badge ${a.days_running >= 30 ? 'ok' : ''}`}>{a.days_running}d{a.active ? ' · live' : ''}</span></td>
                            <td className="small">{a.platforms.join(', ')}</td>
                            <td className="nowrap">
                              {a.snapshot && <a className="btn ghost sm" href={a.snapshot} target="_blank" rel="noreferrer">View</a>}
                              {can('editor') && <AsyncButton className="btn sm" onError={fail} onClick={async () => { const p = await post(`/api/adintel/${sel}/recreate`, { ad_id: a.id }); nav(`/app/posts/${p.id}`); }}>✨ Recreate for my brand</AsyncButton>}
                            </td>
                          </tr>
                        ))}
                      </tbody></table>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {adding && <TrackModal onClose={() => setAdding(false)} onDone={(t) => { reload(); open(t.id); }} />}
    </>
  );
}

function TrackModal({ onClose, onDone }) {
  const { toast } = useApp();
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('US');
  return (
    <Modal title="Track a competitor" onClose={onClose} footer={<AsyncButton className="btn primary" disabled={!query.trim()} onError={(e) => toast(e.message, 'err')} onClick={async () => { const t = await post('/api/adintel', { query, country }); onDone(t); onClose(); }}>Track</AsyncButton>}>
      <div className="stack">
        <div className="field"><label htmlFor="q">Brand name or Facebook Page ID</label><input id="q" className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. Blue Bottle Coffee" /></div>
        <div className="field"><label htmlFor="c">Country</label><input id="c" className="input" maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} /><span className="hint">Two-letter country code where the ads run.</span></div>
      </div>
    </Modal>
  );
}
