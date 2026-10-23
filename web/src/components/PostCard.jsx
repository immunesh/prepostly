import { Link } from 'react-router-dom';
import { TYPE_ICON, timeAgo, fmtDate } from '../lib/api.js';
import { Spinner, StatusBadge } from './ui.jsx';

export function thumbOf(p) {
  return p.cover || p.media?.find((m) => m.kind === 'image')?.url || null;
}

export default function PostCard({ post, selected, onSelect, footer }) {
  const img = thumbOf(post);
  const slides = post.media?.filter((m) => m.kind === 'image').length || 0;
  return (
    <div className="post-card" style={selected ? { outline: '2px solid var(--brand)' } : undefined}>
      <Link to={`/app/posts/${post.id}`} className="post-thumb" style={{ aspectRatio: post.format === 'story' ? '9 / 16' : post.format === 'square' ? '1' : post.format === 'landscape' ? '16 / 9' : '4 / 5' }}>
        {post.status === 'generating' && <div className="gen"><Spinner lg /><span>Creating your content…</span></div>}
        {post.status === 'failed' && <div className="gen"><span style={{ fontSize: 28 }}>⚠️</span><span>Couldn’t generate</span><span className="tiny">No credits were used</span></div>}
        {post.status === 'ready' && img && <img src={img} alt={post.title} loading="lazy" />}
        <span className="tag badge" style={{ background: 'rgba(255,255,255,0.92)' }}>{TYPE_ICON[post.type]} {post.media_type}</span>
        {slides > 1 && <span className="count">1/{slides}</span>}
        {post.media?.some((m) => m.kind === 'video') && <span className="count">▶ {Math.round(post.media.find((m) => m.kind === 'video').duration)}s</span>}
      </Link>
      <div className="post-meta">
        <div className="row">
          {onSelect && <input type="checkbox" checked={selected} onChange={() => onSelect(post.id)} aria-label="Select post" />}
          <span className="title" title={post.title}>{post.title}</span>
        </div>
        <div className="row between tiny muted">
          <span>{timeAgo(post.created_at)}</span>
          {post.job ? <span className="row" style={{ gap: 4 }}><StatusBadge status={post.job.status} /> {post.job.status === 'scheduled' && fmtDate(post.job.scheduled_at)}</span> : post.status !== 'ready' && <StatusBadge status={post.status} />}
        </div>
        {footer}
      </div>
    </div>
  );
}
