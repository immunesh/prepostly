import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, patch, fmtDate, toLocalInput, timeAgo, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Loading, Modal, StatusBadge } from './ui.jsx';

/** Scheduled post details: status per channel, approvals, comments, reschedule, discard, retry. */
export default function JobDetail({ jobId, onClose, onChange }) {
  const { toast, can, me } = useApp();
  const [job, { loading, reload }] = useLoad(() => get(`/api/jobs/${jobId}`), [jobId]);
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(null);
  const fail = (e) => toast(e.message, 'err');
  const done = async (msg) => {
    if (msg) toast(msg, 'ok');
    await reload();
    onChange?.();
  };
  if (loading && !job) return <Modal title="Post" onClose={onClose}><Loading /></Modal>;
  const editable = ['draft', 'in_review', 'rejected', 'scheduled', 'failed', 'partial'].includes(job.status) && can('editor');
  const title = { in_review: 'Post for approval', rejected: 'Request for approval', published: 'Published post', scheduled: 'Scheduled post', failed: 'Post status', partial: 'Post status', draft: 'Draft' }[job.status] || 'Post';
  const canReview = job.status === 'in_review' && can('reviewer') && (job.created_by !== me.user.id || can('admin'));

  return (
    <Modal wide title={title} onClose={onClose}>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.3fr)', gap: 22 }}>
        <div className="stack">
          {job.post?.cover && <Link to={`/app/posts/${job.post.id}`}><img src={job.post.cover} alt="" style={{ borderRadius: 12, width: '100%', maxHeight: 360, objectFit: 'contain', background: 'var(--surface-2)' }} /></Link>}
          <Link to={`/app/posts/${job.post_id}`} className="small">Open in editor →</Link>
        </div>
        <div className="stack">
          <div className="row between"><StatusBadge status={job.status} /><span className="small muted">{fmtDate(job.scheduled_at, { weekday: 'short' })}</span></div>
          <p className="small" style={{ whiteSpace: 'pre-wrap', maxHeight: 140, overflowY: 'auto', background: 'var(--surface-2)', padding: 10, borderRadius: 10 }}>{job.caption || job.post?.caption}</p>
          <div className="stack tight">
            <span className="label">Platforms</span>
            {job.targets.map((t) => (
              <div key={t.id} className="row small">
                <span>{PLATFORM_ICON[t.platform]}</span><span className="clip" style={{ flex: 1 }}>{t.account_name}</span>
                <StatusBadge status={t.status === 'pending' ? (job.status === 'in_review' ? 'in_review' : 'scheduled') : t.status} />
                {t.url && <a href={t.url} target="_blank" rel="noreferrer">View ↗</a>}
              </div>
            ))}
            {job.targets.filter((t) => t.error).map((t) => <div key={t.id} className="alert err small">{PLATFORM_ICON[t.platform]} {t.error}</div>)}
            {job.targets.some((t) => t.account_status === 'relink') && <div className="alert warn small">Some accounts need to be relinked. <Link to="/app/brand?tab=social">Relink now</Link></div>}
          </div>
          {job.review_note && <div className="alert info small">💬 {job.review_note}</div>}

          {canReview && (
            <div className="stack tight">
              <span className="label">Review</span>
              <textarea className="textarea" rows={2} placeholder="Leave feedback (optional for approval)" value={note} onChange={(e) => setNote(e.target.value)} />
              <div className="row">
                <AsyncButton className="btn primary" onError={fail} onClick={async () => { await post(`/api/jobs/${jobId}/approve`, { note }); await done('Approved'); }}>✅ Approve</AsyncButton>
                <AsyncButton className="btn danger" onError={fail} onClick={async () => { await post(`/api/jobs/${jobId}/reject`, { note: note || 'Changes requested' }); await done('Rejected'); }}>Request changes</AsyncButton>
              </div>
            </div>
          )}
          {job.status === 'rejected' && can('editor') && <AsyncButton className="btn" onError={fail} onClick={async () => { await post(`/api/jobs/${jobId}/resubmit`); await done('Resubmitted for approval'); }}>↻ Resubmit for approval</AsyncButton>}
          {job.status === 'draft' && can('editor') && <AsyncButton className="btn primary" onError={fail} onClick={async () => { await patch(`/api/jobs/${jobId}`, { status: 'scheduled' }); await done('Scheduled'); }}>Schedule this draft</AsyncButton>}
          {['failed', 'partial'].includes(job.status) && can('editor') && <AsyncButton className="btn" onError={fail} onClick={async () => { await post(`/api/jobs/${jobId}/retry`); await done('Retried'); }}>↻ Retry failed channels</AsyncButton>}

          {editable && (
            <div className="stack tight">
              {when === null ? (
                <div className="row">
                  <button className="btn sm" onClick={() => setWhen(toLocalInput(job.scheduled_at))}>🕒 Change date & time</button>
                  <AsyncButton className="btn sm danger" onError={fail} onClick={async () => { if (!confirm('Discarding stops this post from publishing to any selected platform.')) return; await post(`/api/jobs/${jobId}/discard`); toast('Post discarded'); onChange?.(); onClose(); }}>Discard</AsyncButton>
                </div>
              ) : (
                <div className="row">
                  <input className="input" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="New time" />
                  <AsyncButton className="btn primary sm" onError={fail} onClick={async () => { await patch(`/api/jobs/${jobId}`, { scheduled_at: new Date(when).toISOString() }); setWhen(null); await done('Rescheduled'); }}>Save</AsyncButton>
                  <button className="btn sm ghost" onClick={() => setWhen(null)}>Cancel</button>
                </div>
              )}
            </div>
          )}

          <div className="stack tight">
            <span className="label">Comments</span>
            {job.comments.map((c) => <div key={c.id} className="small"><span className="bold">{c.user_name}</span> <span className="faint tiny">{timeAgo(c.created_at)}{c.action ? ` · ${c.action}` : ''}</span><div>{c.body}</div></div>)}
            {!job.comments.length && <span className="small muted">No comments yet.</span>}
            <CommentBox jobId={jobId} onPosted={reload} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function CommentBox({ jobId, onPosted }) {
  const { toast } = useApp();
  const [body, setBody] = useState('');
  return (
    <div className="row">
      <input className="input" placeholder="Add a comment" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Comment" />
      <AsyncButton className="btn sm" disabled={!body.trim()} onError={(e) => toast(e.message, 'err')} onClick={async () => { await post(`/api/jobs/${jobId}/comments`, { body }); setBody(''); onPosted(); }}>Post</AsyncButton>
    </div>
  );
}
