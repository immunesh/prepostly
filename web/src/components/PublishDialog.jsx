import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, toLocalInput, fmtDate, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { Modal, Spinner, Switch, Avatar } from './ui.jsx';

const LIMITS = { x: 280, bluesky: 300, threads: 500, mastodon: 500, instagram: 2200, linkedin: 3000, linkedin_page: 3000, tiktok: 2200, google_business: 1500, telegram: 1024, discord: 2000, slack: 3000, pinterest: 800 };

/** Publish now, schedule, send for approval, or save as draft. */
export default function PublishDialog({ postData, onClose, onDone, initialTime }) {
  const { toast, can } = useApp();
  const [accounts] = useLoad(() => get('/api/accounts'), []);
  const [team] = useLoad(() => get('/api/team'), []);
  const [times] = useLoad(() => get('/api/best-times?count=4'), []);
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState('schedule');
  const [when, setWhen] = useState(toLocalInput(initialTime || Date.now() + 3600e3));
  const [caption, setCaption] = useState(postData.caption || '');
  const [hashtags, setHashtags] = useState(true);
  const [link, setLink] = useState('');
  const [title, setTitle] = useState(postData.title || '');
  const [reviewers, setReviewers] = useState([]);
  const [busy, setBusy] = useState(false);

  const isVideo = postData.media?.some((m) => m.kind === 'video');
  const kind = isVideo ? 'video' : postData.media?.filter((m) => m.kind === 'image').length > 1 ? 'carousel' : 'image';
  const { catalog } = useApp();
  const supports = (a) => catalog?.platforms.find((p) => p.id === a.platform)?.media.includes(kind);

  useEffect(() => {
    if (accounts && !selected.length) setSelected(accounts.filter((a) => supports(a) && !a.needs_relink).map((a) => a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  const chosen = (accounts || []).filter((a) => selected.includes(a.id));
  const full = `${caption}${hashtags && postData.hashtags ? `\n\n${postData.hashtags}` : ''}`;
  const over = chosen.filter((a) => LIMITS[a.platform] && [...full].length > LIMITS[a.platform]);
  const reviewerOptions = (team?.members || []).filter((m) => ['owner', 'admin', 'reviewer'].includes(m.role));

  const submit = async () => {
    setBusy(true);
    try {
      const job = await post('/api/publish', {
        post_id: postData.id, account_ids: selected, mode, caption,
        scheduled_at: mode === 'now' ? undefined : new Date(when).toISOString(),
        reviewers: mode === 'review' ? reviewers : undefined,
        options: { include_hashtags: hashtags, link: link || undefined, title: title || undefined },
      });
      const msg = { now: job.status === 'published' ? 'Published! 🎉' : job.status === 'partial' ? 'Published to some channels. Check the calendar for details.' : job.status === 'failed' ? 'Publishing failed. See details in the calendar.' : 'Publishing…', schedule: `Scheduled for ${fmtDate(job.scheduled_at)}`, review: 'Sent for approval', draft: 'Saved as draft' }[mode];
      toast(msg, job.status === 'failed' ? 'err' : 'ok');
      onDone?.(job);
      onClose();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title="Publish post" onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !selected.length || (mode === 'review' && !reviewerOptions.length)} onClick={submit}>{busy && <Spinner />}{{ now: 'Publish now', schedule: 'Schedule', review: 'Send for approval', draft: 'Save draft' }[mode]}</button>
      </>
    }>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 22 }}>
        <div className="stack">
          <span className="label">Channels</span>
          {!accounts ? <div className="skeleton" style={{ height: 60 }} /> : !accounts.length ? (
            <div className="alert info">No social accounts connected. <Link to="/app/brand?tab=social">Connect a channel</Link> (a Sandbox test channel works without any setup).</div>
          ) : (
            <div className="stack tight">
              <label className="checkbox small"><input type="checkbox" checked={selected.length === accounts.filter(supports).length} onChange={(e) => setSelected(e.target.checked ? accounts.filter(supports).map((a) => a.id) : [])} />Select all accounts</label>
              {accounts.map((a) => (
                <label key={a.id} className="checkbox" style={{ opacity: supports(a) ? 1 : 0.45, padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 10 }} title={supports(a) ? '' : `Doesn't support ${kind} posts`}>
                  <input type="checkbox" disabled={!supports(a)} checked={selected.includes(a.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, a.id] : selected.filter((x) => x !== a.id))} />
                  <span>{PLATFORM_ICON[a.platform]}</span>
                  <Avatar src={a.avatar} name={a.name} size={22} />
                  <span className="clip" style={{ flex: 1 }}>{a.name}</span>
                  {a.needs_relink && <span className="badge err">Relink</span>}
                </label>
              ))}
            </div>
          )}
          <div className="field">
            <label htmlFor="cap">Caption</label>
            <textarea id="cap" className="textarea" rows={7} value={caption} onChange={(e) => setCaption(e.target.value)} />
            <div className="row between"><Switch on={hashtags} onChange={setHashtags} label="Add hashtags" /><span className={`tiny ${over.length ? 'delta down' : 'muted'}`}>{[...full].length} chars</span></div>
            {over.length > 0 && <span className="tiny muted">Will be shortened for {over.map((a) => a.platform).join(', ')}.</span>}
          </div>
          <div className="grid g2">
            <div className="field"><label htmlFor="lnk">Destination link</label><input id="lnk" className="input" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></div>
            <div className="field"><label htmlFor="ttl">Title (YouTube, Pinterest)</label><input id="ttl" className="input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          </div>
        </div>
        <div className="stack">
          <span className="label">When</span>
          <div className="chips">
            {[['schedule', '🗓️ Schedule'], ['now', '⚡ Now'], ['review', '✅ Approval'], ['draft', '📝 Draft']].map(([v, l]) => <button key={v} className={`chip ${mode === v ? 'on' : ''}`} onClick={() => setMode(v)}>{l}</button>)}
          </div>
          {mode !== 'now' && (
            <>
              <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Publish time" />
              <div className="stack tight">
                <span className="tiny muted">✨ AI-suggested times ({times?.suggestions?.[0]?.source === 'history' ? 'from your engagement' : 'industry peaks'})</span>
                <div className="chips">{(times?.suggestions || []).map((s) => <button key={s.at} className={`chip ${new Date(when).getTime() === new Date(s.at).getTime() ? 'on' : ''}`} onClick={() => setWhen(toLocalInput(s.at))}>{fmtDate(s.at, { weekday: 'short' })}</button>)}</div>
              </div>
            </>
          )}
          {mode === 'now' && <div className="alert info small">Your post goes out right away. Some platforms take a few minutes to show it.</div>}
          {mode === 'review' && (
            <div className="field">
              <span className="label">Reviewers</span>
              {!reviewerOptions.length ? <div className="alert warn small">Invite a teammate as reviewer or admin to use approvals.</div> : reviewerOptions.map((m) => (
                <label key={m.id} className="checkbox small"><input type="checkbox" checked={reviewers.includes(m.id)} onChange={(e) => setReviewers(e.target.checked ? [...reviewers, m.id] : reviewers.filter((x) => x !== m.id))} />{m.name} <span className="badge">{m.role}</span></label>
              ))}
              <span className="hint">Leave empty to ask every reviewer.</span>
            </div>
          )}
          {!can('admin') && mode !== 'review' && <p className="tiny muted">If your brand requires approval, this will be sent for review.</p>}
          {postData.cover && <img src={postData.cover} alt="" style={{ borderRadius: 12, maxHeight: 220, objectFit: 'contain', background: 'var(--surface-2)' }} />}
        </div>
      </div>
    </Modal>
  );
}
