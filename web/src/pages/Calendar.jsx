import { Fragment, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { get, patch, fmtDate } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { ErrorBox, Modal } from '../components/ui.jsx';
import JobDetail from '../components/JobDetail.jsx';
import PublishDialog from '../components/PublishDialog.jsx';
import { thumbOf } from '../components/PostCard.jsx';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LEGEND = [['scheduled', 'Scheduled'], ['published', 'Published'], ['in_review', 'In review'], ['rejected', 'Rejected'], ['failed', 'Failed'], ['draft', 'Draft']];
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export default function Calendar() {
  const { toast, can } = useApp();
  const [params] = useSearchParams();
  const [view, setView] = useState('month');
  const [cursor, setCursor] = useState(startOfDay(new Date()));
  const [open, setOpen] = useState(params.get('job'));
  const [slot, setSlot] = useState(null);
  const [chosen, setChosen] = useState(null);

  const range = useMemo(() => {
    if (view === 'month') {
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      return { start, days: 42 };
    }
    const start = new Date(cursor);
    start.setDate(cursor.getDate() - cursor.getDay());
    return { start, days: 7 };
  }, [view, cursor]);
  const end = new Date(range.start);
  end.setDate(end.getDate() + range.days);
  const [jobs, { error, reload }] = useLoad(() => get(`/api/jobs?from=${range.start.toISOString()}&to=${end.toISOString()}`), [range.start.getTime(), range.days]);

  const move = (n) => {
    const d = new Date(cursor);
    if (view === 'month') d.setMonth(d.getMonth() + n);
    else d.setDate(d.getDate() + 7 * n);
    setCursor(d);
  };
  const days = Array.from({ length: range.days }, (_, i) => {
    const d = new Date(range.start);
    d.setDate(d.getDate() + i);
    return d;
  });
  const jobsOn = (d, hour) => (jobs || []).filter((j) => {
    const t = new Date(j.scheduled_at);
    return sameDay(t, d) && (hour === undefined || t.getHours() === hour);
  });

  const reschedule = async (jobId, day) => {
    const j = jobs.find((x) => x.id === jobId);
    if (!j) return;
    const t = new Date(j.scheduled_at);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate(), t.getHours(), t.getMinutes());
    try {
      await patch(`/api/jobs/${jobId}`, { scheduled_at: next.toISOString() });
      toast(`Moved to ${fmtDate(next.toISOString())}`, 'ok');
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  const clickSlot = (d, hour) => {
    if (!can('editor')) return;
    const t = new Date(d);
    t.setHours(hour ?? 10, 0, 0, 0);
    if (t < new Date()) t.setTime(Date.now() + 3600e3);
    setSlot(t);
  };

  const Event = ({ j }) => (
    <div className={`event ${j.status}`} draggable={['scheduled', 'draft', 'in_review'].includes(j.status) && can('editor')} onDragStart={(e) => e.dataTransfer.setData('text/job', j.id)} onClick={(e) => { e.stopPropagation(); setOpen(j.id); }} title={j.post?.title}>
      {j.post?.cover && <img src={j.post.cover} alt="" />}
      <span>{new Date(j.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} {j.post?.title}</span>
    </div>
  );

  return (
    <>
      <div className="page-head">
        <div><h1>Content calendar</h1><p>Click an empty slot to schedule a post. Drag posts to move them.</p></div>
        <div className="row wrap">
          <div className="chips">{[['month', 'Month'], ['week', 'Week']].map(([v, l]) => <button key={v} className={`chip ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{l}</button>)}</div>
          <button className="btn sm" onClick={() => move(-1)} aria-label="Previous">‹</button>
          <button className="btn sm" onClick={() => setCursor(startOfDay(new Date()))}>Today</button>
          <button className="btn sm" onClick={() => move(1)} aria-label="Next">›</button>
          <h3 style={{ minWidth: 170, textAlign: 'right' }}>{cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
        </div>
      </div>
      <div className="row wrap mb small">{LEGEND.map(([k, l]) => <span key={k} className={`event ${k}`} style={{ cursor: 'default' }}>{l}</span>)}</div>
      <ErrorBox error={error} onRetry={reload} />
      {view === 'month' ? (
        <div className="cal">
          {DOW.map((d) => <div key={d} className="dow">{d}</div>)}
          {days.map((d) => {
            const list = jobsOn(d);
            return (
              <div key={d.toISOString()} className={`day ${d.getMonth() !== cursor.getMonth() ? 'other' : ''} ${sameDay(d, new Date()) ? 'today' : ''}`} onClick={() => clickSlot(d)} onDragOver={(e) => e.preventDefault()} onDrop={(e) => reschedule(e.dataTransfer.getData('text/job'), d)}>
                <span className="num">{d.getDate()}</span>
                {list.slice(0, 3).map((j) => <Event key={j.id} j={j} />)}
                {list.length > 3 && <span className="tiny muted">+{list.length - 3} more</span>}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="week">
          <div />
          {days.map((d) => <div key={d.toISOString()} className="wh">{DOW[d.getDay()]} {d.getDate()}</div>)}
          {Array.from({ length: 18 }, (_, i) => i + 6).map((h) => (
            <Fragment key={h}>
              <div className="hour">{new Date(2000, 0, 1, h).toLocaleTimeString([], { hour: 'numeric' })}</div>
              {days.map((d) => (
                <div key={`${d.toISOString()}${h}`} className="slot" onClick={() => clickSlot(d, h)}>
                  {jobsOn(d, h).map((j) => <Event key={j.id} j={j} />)}
                </div>
              ))}
            </Fragment>
          ))}
        </div>
      )}
      {open && <JobDetail jobId={open} onClose={() => setOpen(null)} onChange={reload} />}
      {slot && !chosen && <PickPost when={slot} onClose={() => setSlot(null)} onPick={setChosen} />}
      {chosen && <PublishDialog postData={chosen} initialTime={slot} onClose={() => { setChosen(null); setSlot(null); }} onDone={reload} />}
    </>
  );
}

function PickPost({ when, onClose, onPick }) {
  const [data] = useLoad(() => get('/api/posts?status=ready&limit=60'), []);
  return (
    <Modal wide title={`Schedule a post for ${fmtDate(when.toISOString(), { weekday: 'short' })}`} onClose={onClose}>
      {!data ? <div className="skeleton" style={{ height: 160 }} /> : !data.posts.length ? <p className="muted">No ready posts yet. <Link to="/app/create">Create one</Link>.</p> : (
        <div className="post-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}>
          {data.posts.map((p) => (
            <button key={p.id} className="post-card" style={{ padding: 0, cursor: 'pointer', textAlign: 'left' }} onClick={() => onPick(p)}>
              <div className="post-thumb">{thumbOf(p) && <img src={thumbOf(p)} alt="" />}</div>
              <div className="post-meta"><span className="title small">{p.title}</span></div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
