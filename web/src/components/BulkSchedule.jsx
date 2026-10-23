import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { Avatar, Modal, Spinner, Switch } from './ui.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKS = [1, 2, 3, 4, 6, 8, 12];
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/** Spread several posts over a weekly schedule: one post per slot, in the order picked. */
export default function BulkSchedule({ postIds, onClose, onDone }) {
  const { toast, brand } = useApp();
  const [accounts] = useLoad(() => get('/api/accounts'), []);
  const [selected, setSelected] = useState([]);
  const [days, setDays] = useState([1, 3, 5]);
  const [times, setTimes] = useState(['10:00']);
  const [start, setStart] = useState(today());
  const [weeks, setWeeks] = useState(4);
  const [mode, setMode] = useState('schedule');
  const [hashtags, setHashtags] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (accounts && !selected.length) setSelected(accounts.filter((a) => !a.needs_relink).map((a) => a.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]);

  const toggleDay = (d) => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort());
  const room = days.length * times.length * weeks;

  const submit = async () => {
    setBusy(true);
    try {
      const r = await post('/api/publish/bulk', { post_ids: postIds, account_ids: selected, days, times, start, weeks, mode, include_hashtags: hashtags });
      const label = { scheduled: 'Scheduled', in_review: 'Sent for approval:', draft: 'Saved as drafts:' }[r.status];
      toast(`${label} ${r.count} posts`, 'ok');
      onDone?.(r);
      onClose();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal wide title={`Schedule ${postIds.length} post${postIds.length > 1 ? 's' : ''}`} onClose={onClose} footer={
      <>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !selected.length || !days.length || !times.length} onClick={submit}>{busy && <Spinner />}{{ schedule: 'Schedule all', review: 'Send all for approval', draft: 'Save as drafts' }[mode]}</button>
      </>
    }>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 22 }}>
        <div className="stack">
          <span className="label">Channels</span>
          {!accounts ? <div className="skeleton" style={{ height: 60 }} /> : !accounts.length ? (
            <div className="alert info">No social accounts connected. <Link to="/app/brand?tab=social">Connect a channel</Link>.</div>
          ) : accounts.map((a) => (
            <label key={a.id} className="checkbox" style={{ padding: '6px 8px', border: '1px solid var(--border)', borderRadius: 10 }}>
              <input type="checkbox" checked={selected.includes(a.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, a.id] : selected.filter((x) => x !== a.id))} />
              <span>{PLATFORM_ICON[a.platform]}</span>
              <Avatar src={a.avatar} name={a.name} size={22} />
              <span className="clip" style={{ flex: 1 }}>{a.name}</span>
              {a.needs_relink && <span className="badge err">Relink</span>}
            </label>
          ))}
          <span className="tiny muted">Each post goes to the channels that support it (for example, videos skip channels that only take images).</span>
          <Switch on={hashtags} onChange={setHashtags} label="Add hashtags" />
        </div>
        <div className="stack">
          <span className="label">Repeat on</span>
          <div className="chips">{DAYS.map((d, i) => <button key={d} className={`chip ${days.includes(i) ? 'on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>)}</div>
          <span className="label">At</span>
          <div className="row wrap">
            {times.map((t, i) => <input key={i} type="time" className="input" style={{ width: 120 }} value={t} onChange={(e) => setTimes(times.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`Time ${i + 1}`} />)}
            {times.length < 4 && <button className="btn sm" onClick={() => setTimes([...times, '18:00'])}>＋ Time</button>}
            {times.length > 1 && <button className="btn ghost sm" onClick={() => setTimes(times.slice(0, -1))}>－</button>}
          </div>
          <div className="grid g2">
            <div className="field"><label htmlFor="bs-start">Starting</label><input id="bs-start" type="date" className="input" min={today()} value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="field"><label htmlFor="bs-weeks">For</label><select id="bs-weeks" className="select" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>{WEEKS.map((w) => <option key={w} value={w}>{w} week{w > 1 ? 's' : ''}</option>)}</select></div>
          </div>
          <div className="chips">
            {[['schedule', '🗓️ Schedule'], ['review', '✅ Approval'], ['draft', '📝 Draft']].map(([v, l]) => <button key={v} className={`chip ${mode === v ? 'on' : ''}`} onClick={() => setMode(v)}>{l}</button>)}
          </div>
          <div className={`alert small ${room < postIds.length ? 'warn' : 'info'}`}>
            {room < postIds.length
              ? `This schedule has room for ${room} posts. Add days, times or weeks to fit all ${postIds.length}.`
              : `Posts go out one per slot in the order you picked them, starting with the first free slot. Times are in ${brand?.timezone || 'UTC'}.`}
          </div>
        </div>
      </div>
    </Modal>
  );
}
