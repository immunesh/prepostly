import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, put, fmtDate, fmtNum, PLATFORM_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, ErrorBox, Loading, StatusBadge } from '../components/ui.jsx';
import { Bars, ChartCard, Heatmap, HBars, Line } from '../components/Charts.jsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Metric({ label, m, hint }) {
  const c = m?.change;
  return (
    <div className="card metric">
      <div className="small muted">{label}</div>
      <div className="value">{fmtNum(m?.value ?? 0)}</div>
      <div className="tiny muted">
        {c == null ? hint || 'No earlier data to compare' : <><span className={`delta ${c >= 0 ? 'up' : 'down'}`}>{c >= 0 ? '▲' : '▼'} {Math.abs(c)}%</span> vs previous period</>}
      </div>
    </div>
  );
}

function JobRow({ j }) {
  return (
    <div className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      {j.post?.cover ? <img src={j.post.cover} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 8 }} /> : <span style={{ width: 40 }} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <Link to={`/app/calendar?job=${j.id}`} className="bold small clip" style={{ display: 'block', color: 'var(--text)' }}>{j.post?.title}</Link>
        <span className="tiny muted">{fmtDate(j.scheduled_at, { weekday: 'short' })} · {j.targets.map((t) => PLATFORM_ICON[t.platform]).join(' ')}</span>
      </div>
      <StatusBadge status={j.status} />
    </div>
  );
}

export default function Dashboard() {
  const { me, toast, can } = useApp();
  const [days, setDays] = useState(30);
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/analytics?days=${days}`), [days]);
  const [goal, setGoal] = useState('');

  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  const target = d.goal.posts_per_month;
  const activityRows = d.series.map((s) => [s.day, s.posts]);
  const hasFollowers = d.series.some((s) => s.followers != null);

  return (
    <>
      <div className="page-head">
        <div><h1>{greeting()}, {me.user.name.split(' ')[0]} 👋</h1><p>Track your social media progress here.</p></div>
        <div className="chips">{[7, 30, 90].map((n) => <button key={n} className={`chip ${days === n ? 'on' : ''}`} onClick={() => setDays(n)}>Last {n} days</button>)}</div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)', marginBottom: 16 }}>
        <div className="card pad">
          <div className="row between"><h3>🔥 {d.streak.days}-day posting streak</h3><span className="tiny muted">Last 14 days</span></div>
          <div className="streak mt" aria-label="Posting in the last 14 days">{d.streak.last14.map((s) => <span key={s.day} className={s.posted ? 'on' : ''} title={`${shortLabel(s.day)}: ${s.posted ? 'Posted' : 'No activity'}`} />)}</div>
          <div className="row tiny muted mt" style={{ gap: 14 }}><span><span className="dot" style={{ background: 'var(--brand)' }} /> Posted</span><span><span className="dot" style={{ background: 'var(--border)' }} /> No activity</span></div>
        </div>
        <div className="card pad">
          <h3>🎯 Monthly goal</h3>
          {target ? (
            <>
              <p className="small muted mt">{d.goal.this_month} of {target} posting days this month</p>
              <div style={{ height: 10, background: 'var(--border)', borderRadius: 99, marginTop: 10, overflow: 'hidden' }}><div style={{ width: `${Math.min(100, (d.goal.this_month / target) * 100)}%`, height: '100%', background: 'var(--gradient)' }} /></div>
            </>
          ) : <p className="small muted mt">Set a goal to stay consistent.</p>}
          {can('editor') && (
            <div className="row mt">
              <span className="small">I want to publish</span>
              <input className="input" style={{ width: 70 }} type="number" min={1} max={300} placeholder={target || 12} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Posts per month" />
              <span className="small">posts / month</span>
              <AsyncButton className="btn sm" disabled={!goal} onError={(e) => toast(e.message, 'err')} onClick={async () => { await put('/api/analytics/goal', { posts_per_month: Number(goal) }); setGoal(''); reload(); toast('Goal saved', 'ok'); }}>Set</AsyncButton>
            </div>
          )}
        </div>
      </div>

      <div className="grid g4 mb">
        <Metric label="New posts published" m={d.metrics.new_posts} />
        <Metric label="Followers" m={d.metrics.followers} hint="Connect channels that share follower counts" />
        <Metric label="Engagement" m={d.metrics.engagement} hint="Likes, comments and shares" />
        <div className="card metric"><div className="small muted">Posts created</div><div className="value">{d.metrics.generated}</div><div className="tiny muted">in the last {days} days · <Link to="/app/create">create more</Link></div></div>
      </div>

      <div className="grid g2 mb">
        <ChartCard title="Your posting activity" subtitle="Posts published per day" rows={activityRows} empty={d.metrics.new_posts.value ? null : ['No posting activity yet', 'Publish your first post to see your activity here.']}>
          <Bars data={d.series.map((s) => ({ day: s.day, value: s.posts }))} />
        </ChartCard>
        <ChartCard title="Your posts' engagement" subtitle="Likes + comments + shares per day" rows={d.series.map((s) => [s.day, s.engagement])} empty={d.metrics.engagement.value ? null : ['No engagement data yet', 'Engagement appears once channels report likes and comments.']}>
          <Line data={d.series.map((s) => ({ day: s.day, value: s.engagement }))} />
        </ChartCard>
        <ChartCard title="Your followers' growth" subtitle="Total followers across channels" rows={d.series.filter((s) => s.followers != null).map((s) => [s.day, s.followers])} empty={hasFollowers ? null : ['No follower data yet', 'Follower growth appears after connected channels report counts (daily).']}>
          <Line data={d.series.map((s) => ({ day: s.day, value: s.followers }))} />
        </ChartCard>
        <ChartCard title="Post distribution" subtitle="When you publish (your brand timezone)" rows={d.distribution.flatMap((row, w) => row.map((v, h) => [`${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][w]} ${h}:00`, v])).filter(([, v]) => v)} empty={d.metrics.new_posts.value ? null : ['No data to display', 'Post consistently to see your posting time distribution.']}>
          <Heatmap grid={d.distribution} />
        </ChartCard>
      </div>

      <div className="grid g3">
        <ChartCard title="Engagement contribution" subtitle="By platform" rows={d.engagement_by_platform.map((p) => [p.platform, p.engagement])} empty={d.engagement_by_platform.some((p) => p.engagement) ? null : ['No data to display', 'Engagement contribution will appear once there is data.']}>
          <HBars items={d.engagement_by_platform.sort((a, b) => b.engagement - a.engagement).map((p) => ({ label: p.platform, value: p.engagement, icon: PLATFORM_ICON[p.platform] }))} />
        </ChartCard>
        <div className="card">
          <div className="card-head"><h3>Upcoming posts</h3><Link to="/app/calendar" className="small">Calendar →</Link></div>
          <div className="card-body" style={{ paddingTop: 4 }}>
            {d.upcoming.length ? d.upcoming.map((j) => <JobRow key={j.id} j={j} />) : <div className="empty" style={{ padding: 24 }}><h3 style={{ fontSize: 14 }}>No upcoming posts</h3><p className="small">Schedule your first post to see it here.</p><Link to="/app/create" className="btn sm mt">Create post</Link></div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>Latest published</h3></div>
          <div className="card-body" style={{ paddingTop: 4 }}>
            {d.latest.length ? d.latest.map((j) => <JobRow key={j.id} j={j} />) : <div className="empty" style={{ padding: 24 }}><h3 style={{ fontSize: 14 }}>No published posts yet</h3><p className="small">Your published posts will appear here.</p></div>}
          </div>
        </div>
      </div>
    </>
  );
}

const shortLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
