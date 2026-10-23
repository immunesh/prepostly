import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { Empty, ErrorBox, Loading } from '../components/ui.jsx';
import PostCard from '../components/PostCard.jsx';
import BulkSchedule from '../components/BulkSchedule.jsx';

export default function Library() {
  const { toast, can } = useApp();
  const [q, setQ] = useState('');
  const [media, setMedia] = useState('');
  const [status, setStatus] = useState('');
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState([]);
  const [bulk, setBulk] = useState(false);
  const query = new URLSearchParams({ ...(q && { q }), ...(media && { media }), ...(status && { status }), ...(archived && { archived: '1' }), limit: '60' }).toString();
  const [data, { loading, error, reload }] = useLoad(() => get(`/api/posts?${query}`), [query]);

  // Poll while anything is generating.
  useEffect(() => {
    if (!data?.posts.some((p) => p.status === 'generating')) return;
    const t = setTimeout(reload, 2500);
    return () => clearTimeout(t);
  }, [data, reload]);

  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const bulkArchive = async () => {
    await post('/api/posts/bulk-archive', { ids: selected, archived: !archived });
    toast(`${selected.length} post${selected.length > 1 ? 's' : ''} ${archived ? 'restored' : 'archived'}`, 'ok');
    setSelected([]);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Content library</h1><p>Everything you’ve created. Open a post to edit, resize or publish it.</p></div>
        {can('editor') && <Link to="/app/create" className="btn primary">✨ Create post</Link>}
      </div>
      <div className="row wrap mb">
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search posts…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search posts" />
        <select className="select" style={{ width: 160 }} value={media} onChange={(e) => setMedia(e.target.value)} aria-label="Media type"><option value="">All media</option><option value="image">Images</option><option value="carousel">Carousels</option><option value="video">Videos</option></select>
        <select className="select" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option><option value="ready">Ready</option><option value="generating">Generating</option><option value="failed">Failed</option></select>
        <button className={`chip ${archived ? 'on' : ''}`} onClick={() => setArchived(!archived)}>🗄️ Archived</button>
        {selected.length > 0 && can('editor') && (
          <div className="row right">
            {!archived && <button className="btn primary sm" onClick={() => setBulk(true)}>🗓️ Schedule {selected.length} selected</button>}
            <button className="btn sm" onClick={bulkArchive}>{archived ? 'Restore' : 'Archive'} {selected.length} selected</button>
          </div>
        )}
      </div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : !data?.posts.length ? (
        <Empty icon="🗂️" title={q || media || status ? 'Nothing to show here' : 'Your library is empty'} action={<Link to="/app/create" className="btn primary">Create a new post</Link>}>
          {q || media || status ? 'Try changing the filters, or create a new post.' : 'Generate your first post and it will appear here.'}
        </Empty>
      ) : (
        <>
          <p className="small muted mb">{data.total} post{data.total === 1 ? '' : 's'}{can('editor') && !archived && !selected.length ? ' · Select posts to schedule a week or a month of them at once' : ''}</p>
          <div className="post-grid">{data.posts.map((p) => <PostCard key={p.id} post={p} selected={selected.includes(p.id)} onSelect={can('editor') ? toggle : undefined} />)}</div>
        </>
      )}
      {bulk && <BulkSchedule postIds={selected} onClose={() => setBulk(false)} onDone={() => setSelected([])} />}
    </>
  );
}
