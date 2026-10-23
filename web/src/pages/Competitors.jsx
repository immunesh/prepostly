import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, del, fmtDate, fmtNum } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Empty, Loading, Modal, Tabs } from '../components/ui.jsx';
import { ChartCard, HBars, Heatmap } from '../components/Charts.jsx';

export default function Competitors() {
  const { toast, can } = useApp();
  const [list, { loading, reload }] = useLoad(() => get('/api/competitors'), []);
  const [sel, setSel] = useState(null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(null);
  const [tab, setTab] = useState('content');
  const fail = (e) => toast(e.message, 'err');
  const current = list?.find((c) => c.id === sel) || list?.find((c) => c.status === 'ready') || list?.[0];

  if (loading && !list) return <Loading />;
  const a = current?.analysis;
  return (
    <>
      <div className="page-head">
        <div><h1>🔍 Competitor analysis</h1><p>Understand your competitors’ content themes, formats and hashtags.</p></div>
        {can('editor') && <button className="btn primary" onClick={() => setAdding(true)}>＋ Add competitors</button>}
      </div>
      <div className="alert info mb small">Instagram analysis uses the Graph API through your linked Instagram Business account. For other platforms, add a “manual” competitor and paste their posts as CSV.</div>
      {!list?.length ? <Empty icon="🔍" title="No competitors added" action={can('editor') && <button className="btn primary" onClick={() => setAdding(true)}>Add one</button>}>Add a competitor to see what content works for them.</Empty> : (
        <>
          <div className="row wrap mb">
            {list.map((c) => (
              <button key={c.id} className={`chip ${current?.id === c.id ? 'on' : ''}`} onClick={() => setSel(c.id)}>
                {c.platform === 'instagram' ? '📸' : c.platform === 'facebook' ? '📘' : '📋'} {c.name || c.handle}
                {c.status === 'error' && ' ⚠️'}
              </button>
            ))}
          </div>
          {current && (
            <div className="card pad mb">
              <div className="row between wrap">
                <div><h2>{current.profile?.name || current.name}</h2><p className="small muted">@{current.handle} · {current.platform}{current.last_run_at ? ` · analyzed ${fmtDate(current.last_run_at)}` : ''}</p></div>
                <div className="row">
                  {current.platform === 'manual' && can('editor') && <button className="btn sm" onClick={() => setImporting(current)}>📥 Import posts ({current.post_count})</button>}
                  {can('editor') && <AsyncButton className="btn primary sm" onError={fail} onClick={async () => { const r = await post('/api/competitors/run', { ids: [current.id] }); if (r[0]?.status === 'error') toast(r[0].error, 'err'); reload(); }}>↻ Refresh analysis</AsyncButton>}
                  {a?.summary && <button className="btn sm" onClick={() => window.print()}>🖨️ Save PDF</button>}
                  {can('editor') && <AsyncButton className="btn ghost sm danger" onError={fail} onClick={async () => { await del(`/api/competitors/${current.id}`); setSel(null); reload(); }}>Remove</AsyncButton>}
                </div>
              </div>
              {current.status === 'error' && <div className="alert err mt">{current.error}{/Instagram|Facebook/.test(current.error) && <> <Link to="/app/brand?tab=social">Link accounts</Link></>}</div>}
            </div>
          )}
          {!a?.summary ? <Empty icon="📈" title="No analysis yet">{current?.platform === 'manual' ? 'Import their posts, then refresh the analysis.' : 'Click “Refresh analysis” to fetch and analyze their recent posts.'}</Empty> : (
            <>
              <div className="grid g4 mb">
                {[['Followers', fmtNum(a.summary.followers)], ['Total posts', a.summary.total_posts], ['Average likes', fmtNum(a.summary.avg_likes)], ['Avg. engagement', a.summary.engagement_rate != null ? `${a.summary.engagement_rate}%` : fmtNum(a.summary.avg_engagement)]].map(([l, v]) => (
                  <div key={l} className="card metric"><div className="small muted">{l}</div><div className="value">{v}</div></div>
                ))}
              </div>
              <Tabs value={tab} onChange={setTab} tabs={[['content', '1. Content analysis'], ['themes', '2. Content themes'], ['hashtags', '3. Hashtag analysis'], ['posts', '4. Post performance']]} />
              {tab === 'content' && (
                <div className="grid g2">
                  <ChartCard title="Post types" subtitle="Share of posts and their average engagement" rows={a.post_types.map((t) => [t.type, `${t.count} posts · ${t.avg_engagement} avg`])}>
                    <HBars items={a.post_types.map((t) => ({ label: `${t.type} (${t.avg_engagement} avg engagement)`, value: t.count }))} format={(v) => `${v} posts`} />
                  </ChartCard>
                  <ChartCard title="When they post" subtitle={a.posting_times.best_slot_utc ? `Best slot: ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][a.posting_times.best_slot_utc.weekday]} ${a.posting_times.best_slot_utc.hour}:00 UTC` : 'UTC'}>
                    <Heatmap grid={a.posting_times.grid} />
                  </ChartCard>
                  <div className="card pad"><h3>Cadence</h3><p className="mt">{a.summary.posts_per_week} posts per week · {a.summary.avg_comments} comments per post on average</p><p className="small muted mt">Data from {fmtDate(a.summary.data_from)}</p></div>
                </div>
              )}
              {tab === 'themes' && (
                <div className="grid g2">
                  <ChartCard title="Content distribution pattern" subtitle="Themes by number of posts" rows={a.themes.map((t) => [t.theme, t.count])}>
                    <HBars items={a.themes.map((t) => ({ label: t.theme, value: t.count }))} format={(v) => `${v} posts`} />
                  </ChartCard>
                  <ChartCard title="Content distribution (engagement)" subtitle="Themes ordered by average engagement" rows={a.themes.map((t) => [t.theme, t.avg_engagement])}>
                    <HBars items={[...a.themes].sort((x, y) => y.avg_engagement - x.avg_engagement).map((t) => ({ label: t.theme, value: t.avg_engagement }))} />
                  </ChartCard>
                  {a.themes.slice(0, 4).map((t) => (
                    <div key={t.theme} className="card pad"><h3>{t.theme}</h3><p className="tiny muted">{t.count} posts · {t.avg_engagement} avg engagement</p>{t.examples.map((e, i) => <p key={i} className="small mt" style={{ marginTop: 8 }}>“{e.caption}”</p>)}</div>
                  ))}
                </div>
              )}
              {tab === 'hashtags' && (
                <div className="grid g2">
                  <div className="card pad"><h3>Their best-performing hashtag set</h3><p className="mt">{a.hashtag_set.join(' ') || 'Not enough repeated hashtags yet.'}</p>{a.hashtag_set.length > 0 && <button className="btn sm mt" onClick={() => { navigator.clipboard?.writeText(a.hashtag_set.join(' ')); toast('Copied'); }}>📋 Copy set</button>}</div>
                  <div className="card"><table className="table"><thead><tr><th>Hashtag</th><th>Used</th><th>Avg engagement</th></tr></thead><tbody>{a.hashtags.slice(0, 15).map((h) => <tr key={h.tag}><td>{h.tag}</td><td>{h.count}</td><td>{h.avg_engagement}</td></tr>)}</tbody></table></div>
                </div>
              )}
              {tab === 'posts' && (
                <div className="card"><table className="table"><thead><tr><th>Post</th><th>Type</th><th>Likes</th><th>Comments</th><th>Date</th></tr></thead><tbody>
                  {a.top_posts.map((p) => <tr key={p.id}><td style={{ maxWidth: 420 }}><span className="clip" style={{ display: 'block' }}>{p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer">{p.caption || '(no caption)'}</a> : p.caption}</span></td><td><span className="badge">{p.media_type}</span></td><td>{fmtNum(p.likes)}</td><td>{fmtNum(p.comments)}</td><td className="nowrap">{fmtDate(p.timestamp)}</td></tr>)}
                </tbody></table></div>
              )}
            </>
          )}
        </>
      )}
      {adding && <AddCompetitor onClose={() => setAdding(false)} onAdded={(c) => { setSel(c.id); reload(); }} />}
      {importing && <ImportPosts comp={importing} onClose={() => setImporting(null)} onDone={reload} />}
    </>
  );
}

function AddCompetitor({ onClose, onAdded }) {
  const { toast } = useApp();
  const [platform, setPlatform] = useState('instagram');
  const [handle, setHandle] = useState('');
  const [followers, setFollowers] = useState('');
  return (
    <Modal title="Add competitors" onClose={onClose} footer={<AsyncButton className="btn primary" disabled={!handle.trim()} onError={(e) => toast(e.message, 'err')} onClick={async () => { const c = await post('/api/competitors', { platform, handle, followers: followers || undefined }); onAdded(c); onClose(); }}>Add</AsyncButton>}>
      <div className="stack">
        <div className="chips">{[['instagram', '📸 Instagram'], ['facebook', '📘 Facebook page'], ['manual', '📋 Any platform (manual)']].map(([v, l]) => <button key={v} className={`chip ${platform === v ? 'on' : ''}`} onClick={() => setPlatform(v)}>{l}</button>)}</div>
        <div className="field"><label htmlFor="ch">{platform === 'facebook' ? 'Facebook page name or ID' : 'Handle'}</label><input id="ch" className="input" placeholder="@competitor" value={handle} onChange={(e) => setHandle(e.target.value)} /></div>
        {platform === 'manual' && <div className="field"><label htmlFor="cf">Followers (optional)</label><input id="cf" className="input" type="number" value={followers} onChange={(e) => setFollowers(e.target.value)} /></div>}
        {platform === 'instagram' && <p className="small muted">Must be a Business or Creator account. Your Instagram must be linked through a Facebook Page.</p>}
      </div>
    </Modal>
  );
}

function ImportPosts({ comp, onClose, onDone }) {
  const { toast } = useApp();
  const [text, setText] = useState('caption,likes,comments,media_type,timestamp,permalink\n');
  return (
    <Modal wide title={`Import posts for ${comp.handle}`} onClose={onClose} footer={<AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={async () => { const r = await post(`/api/competitors/${comp.id}/import`, { text }); toast(`Imported ${r.imported} posts`, 'ok'); onDone(); onClose(); }}>Import</AsyncButton>}>
      <p className="small muted mb">Paste CSV (or a JSON array) with columns: caption, likes, comments, shares, media_type, timestamp, permalink.</p>
      <textarea className="textarea" rows={12} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: 'monospace' }} aria-label="CSV" />
    </Modal>
  );
}
