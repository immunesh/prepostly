import { useParams, Link } from 'react-router-dom';
import { get } from '../lib/api.js';
import { useLoad } from '../lib/app.jsx';
import { Loading } from '../components/ui.jsx';

// Public preview of a shared post (no login needed).
export default function Share() {
  const { shareId } = useParams();
  const [p, { loading, error }] = useLoad(() => get(`/api/share/${shareId}`), [shareId]);
  if (loading) return <Loading label="Loading content" />;
  if (error) return <div className="share-page"><div className="card pad center"><h2>There’s nothing here</h2><p className="muted mt">{error.message}</p></div></div>;
  const video = p.media.find((m) => m.kind === 'video');
  return (
    <div className="share-page">
      <div className="row mb"><img src="/favicon.svg" alt="" width={28} /><span className="muted small">Shared from Prepostly</span></div>
      <div className="card pad stack">
        <div className="row">{p.brand?.logo_light && <img src={p.brand.logo_light} alt="" style={{ height: 32 }} />}<div><div className="bold">{p.brand?.name}</div>{p.brand?.handle && <div className="tiny muted">@{p.brand.handle}</div>}</div></div>
        {video ? <video className="preview-video" src={video.url} poster={p.cover} controls style={{ alignSelf: 'center', maxWidth: '100%' }} /> : (
          <div className="slides">{p.media.map((m, i) => <img key={m.url} src={m.url} alt={`Slide ${i + 1}`} style={{ height: 460 }} />)}</div>
        )}
        <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{p.caption}</p>
        <p className="small" style={{ color: 'var(--brand)' }}>{p.hashtags}</p>
        <p className="tiny faint">Version {p.version} · updated {new Date(p.updated_at).toLocaleString()}</p>
      </div>
      <p className="center small muted mt"><Link to="/">Create posts like this with Prepostly →</Link></p>
    </div>
  );
}
