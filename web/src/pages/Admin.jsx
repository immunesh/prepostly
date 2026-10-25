import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { get, post, patch, del, fmtDate, fmtDay, fmtNum, fmtMoney, PLATFORM_ICON, TYPE_ICON } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Avatar, ErrorBox, Loading, Modal, Switch, Tabs } from '../components/ui.jsx';
import { Bars, ChartCard, HBars, Line } from '../components/Charts.jsx';

// Site admin dashboard: every user, credits in and out, and what the paid APIs cost.

const usd = (n, d) => {
  const v = Number(n) || 0;
  const digits = d ?? (v !== 0 && Math.abs(v) < 0.01 ? 4 : 2);
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};
const perCredit = (n) => (n == null ? '—' : usd(n, 4));
const PROVIDER = { anthropic: 'Claude (Anthropic)', heygen: 'HeyGen', openai: 'OpenAI Images' };
const FEATURE = {
  write_post: 'Write post', boost_prompt: 'Boost prompt', rewrite_caption: 'Rewrite caption', ad_concepts: 'Ad concepts', plan_topics: 'Auto-posting topics',
  competitor_themes: 'Competitor themes', idea_lab: 'Idea Lab chat', avatar_video: 'Avatar video', ai_image: 'AI image', chat: 'Chat', other: 'Other',
};
const featureLabel = (f) => FEATURE[f] || f;
function reasonLabel(r) {
  if (!r) return 'Free features (no credit charge)';
  if (r.startsWith('generate:')) return `Generate · ${r.slice(9).replaceAll('_', ' ')}`;
  if (r.startsWith('plan:')) return `Plan · ${r.slice(5)}`;
  return { trial_grant: 'Trial credits', monthly_refill: 'Monthly refill', admin_adjust: 'Admin adjustment', generation_failed: 'Refund · failed generation', resize_failed: 'Refund · failed resize', resize: 'Resize', ad_concepts: 'Ad concepts', idea_lab: 'Idea Lab message', autopilot: 'Auto-posting planner', generate: 'Generate' }[r] || r;
}
const tokens = (r) => fmtNum((r.input || 0) + (r.output || 0));

function Kpi({ label, value, sub }) {
  return (
    <div className="card metric">
      <div className="small muted">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="tiny muted">{sub}</div>}
    </div>
  );
}

function Table({ head, rows, empty = 'Nothing here yet.' }) {
  if (!rows.length) return <div className="empty" style={{ padding: 24 }}><p className="small">{empty}</p></div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table small">
        <thead><tr>{head.map((h, i) => <th key={i} style={i && typeof h === 'string' && h.startsWith(' ') ? { textAlign: 'right' } : undefined}>{h.trim?.() ?? h}</th>)}</tr></thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
const R = ({ children, ...p }) => <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} {...p}>{children}</td>;

function Card({ title, subtitle, action, children }) {
  return (
    <div className="card">
      <div className="card-head"><div><h3>{title}</h3>{subtitle && <p className="tiny muted">{subtitle}</p>}</div>{action}</div>
      <div className="card-body" style={{ paddingTop: 4 }}>{children}</div>
    </div>
  );
}

function DayChips({ days, setDays }) {
  return <div className="chips">{[7, 30, 90, 365].map((n) => <button key={n} className={`chip ${days === n ? 'on' : ''}`} onClick={() => setDays(n)}>{n === 365 ? 'Last year' : `Last ${n} days`}</button>)}</div>;
}

// ---------------------------------------------------------------- overview
function Overview({ days, openUser }) {
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/overview?days=${days}`), [days]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  const { users, content, credits, api, economics: e } = d;
  const period = `last ${days} days`;
  return (
    <>
      <div className="grid g4 mb">
        <Kpi label="Users" value={fmtNum(users.total)} sub={`+${users.new} new · ${users.active} active in the ${period}`} />
        <Kpi label="API spend" value={usd(api.cost)} sub={`${usd(api.cost_all_time)} all time · ${fmtNum(api.calls)} calls`} />
        <Kpi label="Credits used" value={fmtNum(credits.consumed)} sub={`${fmtNum(credits.refunded)} refunded · ${fmtNum(credits.granted)} granted`} />
        <Kpi label="API cost per credit" value={perCredit(e.usd_per_credit)} sub={e.usd_per_credit == null ? 'No credits used yet' : `All API spend ÷ credits used, ${period}`} />
      </div>
      <div className="grid g4 mb">
        <Kpi label="Plan value per month" value={usd(users.mrr, 0)} sub="Paid plans at list price" />
        <Kpi label="Credits in balances" value={fmtNum(credits.balance)} sub={`${fmtNum(credits.consumed_all_time)} used all time`} />
        <Kpi label="Tokens" value={fmtNum(api.input + api.output)} sub={`${fmtNum(api.input)} in · ${fmtNum(api.output)} out · ${fmtNum(api.cache)} cache`} />
        <Kpi label="Posts" value={fmtNum(content.posts_new)} sub={`${fmtNum(content.posts)} all time · ${content.published} published · ${content.publish_failed} failed`} />
      </div>

      <div className="grid g2 mb">
        <ChartCard title="API spend" subtitle="US dollars per day, all providers" rows={d.series.map((s) => [s.day, usd(s.cost)])} empty={api.calls ? null : ['No API calls yet', 'Spend appears once users generate with Claude, HeyGen or OpenAI.']}>
          <Line data={d.series.map((s) => ({ day: s.day, value: s.cost }))} format={(v) => usd(v)} />
        </ChartCard>
        <ChartCard title="Credits used" subtitle="Per day, net of refunds" rows={d.series.map((s) => [s.day, s.credits])} empty={credits.consumed ? null : ['No credits used yet', 'Credit use appears once users create posts.']}>
          <Bars data={d.series.map((s) => ({ day: s.day, value: Math.max(0, s.credits) }))} />
        </ChartCard>
        <ChartCard title="Signups" subtitle="New accounts per day" rows={d.series.map((s) => [s.day, s.signups])} empty={users.new ? null : ['No signups in this period', 'Try a longer range.']}>
          <Bars data={d.series.map((s) => ({ day: s.day, value: s.signups }))} />
        </ChartCard>
        <ChartCard title="Posts created" subtitle="Per day, all brands" rows={d.series.map((s) => [s.day, s.posts])} empty={content.posts_new ? null : ['No posts in this period', 'Try a longer range.']}>
          <Bars data={d.series.map((s) => ({ day: s.day, value: s.posts }))} />
        </ChartCard>
      </div>

      <div className="mb">
        <Card title="What a credit costs, by feature" subtitle={`API dollars matched to the credits each job charged, ${period}`}>
          <Table head={['Job', ' Runs', ' Credits', ' API cost', ' Per run', ' Per credit']} empty="No credit charges in this period." rows={[
            ...e.jobs.map((j) => <tr key={j.job}><td>{reasonLabel(j.job)}</td><R>{fmtNum(j.runs)}</R><R>{fmtNum(j.credits)}</R><R>{usd(j.cost)}</R><R>{j.usd_per_run == null ? '—' : usd(j.usd_per_run)}</R><R className="bold">{perCredit(j.usd_per_credit)}</R></tr>),
            ...e.uncharged.map((j) => <tr key={`u${j.job}`}><td className="muted">{reasonLabel(j.job)}</td><R className="muted">{fmtNum(j.calls)} call{j.calls === 1 ? '' : 's'}</R><R className="muted">0</R><R>{usd(j.cost)}</R><R /><R /></tr>),
          ]} />
          {e.uncharged_cost > 0 && <p className="tiny muted mt">Free features such as caption rewrites cost {usd(e.uncharged_cost)} with no credit charge. They are included in the overall cost per credit above.</p>}
        </Card>
      </div>

      <div className="grid g3 mb">
        <ChartCard title="Spend by provider" rows={api.by_provider.map((p) => [PROVIDER[p.provider] || p.provider, usd(p.cost)])} empty={api.by_provider.length ? null : ['No API calls yet', 'Nothing to break down.']}>
          <HBars items={api.by_provider.map((p) => ({ label: PROVIDER[p.provider] || p.provider, value: p.cost }))} format={(v) => usd(v)} />
        </ChartCard>
        <ChartCard title="Spend by feature" rows={api.by_feature.map((f) => [featureLabel(f.feature), usd(f.cost)])} empty={api.by_feature.length ? null : ['No API calls yet', 'Nothing to break down.']}>
          <HBars items={api.by_feature.slice(0, 8).map((f) => ({ label: featureLabel(f.feature), value: f.cost }))} format={(v) => usd(v)} />
        </ChartCard>
        <ChartCard title="Users by plan" rows={users.by_plan.map((p) => [p.plan, p.n])}>
          <HBars items={users.by_plan.map((p) => ({ label: p.plan, value: p.n }))} />
          <p className="tiny muted mt">{users.signed_in} signed in now · {users.trials_expired} expired trials · {users.suspended} suspended</p>
        </ChartCard>
      </div>

      <div className="grid g2 mb">
        <Card title="Spend by model">
          <Table head={['Model', ' Calls', ' Input', ' Output', ' Cost']} empty="No API calls in this period." rows={api.by_model.map((m) => (
            <tr key={m.provider + m.model}><td><div className="bold">{m.model || m.provider}</div><div className="tiny muted">{PROVIDER[m.provider] || m.provider}</div></td><R>{fmtNum(m.calls)}</R><R>{fmtNum(m.input)}</R><R>{fmtNum(m.output)}</R><R className="bold">{usd(m.cost)}</R></tr>
          ))} />
        </Card>
        <Card title="Top spenders" subtitle="API cost by paying account">
          <Table head={['User', ' Calls', ' Cost']} empty="No API calls in this period." rows={d.top_users.map((u) => (
            <tr key={u.id || 'none'} style={{ cursor: u.email ? 'pointer' : undefined }} onClick={() => u.email && openUser(u.id)}>
              <td>{u.email ? <><div className="bold">{u.name}</div><div className="tiny muted">{u.email} · {u.plan}</div></> : <span className="muted">{u.id ? 'Deleted account' : 'No account (system)'}</span>}</td><R>{fmtNum(u.calls)}</R><R className="bold">{usd(u.cost)}</R>
            </tr>
          ))} />
        </Card>
      </div>

      <div className="grid g2">
        <ChartCard title="Posts by type" subtitle={period} rows={content.by_type.map((t) => [t.type, t.n])} empty={content.by_type.length ? null : ['No posts in this period', 'Try a longer range.']}>
          <HBars items={content.by_type.map((t) => ({ label: t.type.replaceAll('_', ' '), value: t.n, icon: TYPE_ICON[t.type] }))} />
        </ChartCard>
        <ChartCard title="Connected channels" subtitle={`${content.brands} brands`} rows={content.channels.map((c) => [c.platform, c.n])} empty={content.channels.length ? null : ['No channels connected', 'Channels appear once users connect them.']}>
          <HBars items={content.channels.map((c) => ({ label: c.platform, value: c.n, icon: PLATFORM_ICON[c.platform] }))} />
        </ChartCard>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- users
function Users({ openUser, reloadKey }) {
  const { toast } = useApp();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [plan, setPlan] = useState('');
  const [sort, setSort] = useState('created');
  const [page, setPage] = useState(1);
  const [adding, setAdding] = useState(false);
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/users?q=${encodeURIComponent(query)}&plan=${plan}&sort=${sort}&page=${page}`), [query, plan, sort, page, reloadKey]);
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <form className="row wrap" style={{ flex: 1 }} onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search users" />
          <select className="select" style={{ width: 150 }} value={plan} onChange={(e) => { setPage(1); setPlan(e.target.value); }} aria-label="Plan">
            <option value="">All plans</option>{['trial', 'core', 'rise', 'enterprise'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select className="select" style={{ width: 170 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
            <option value="created">Newest first</option><option value="api_cost">Highest API cost</option><option value="credits_used">Most credits used</option><option value="credits">Most credits left</option><option value="name">Name</option>
          </select>
        </form>
        <button className="btn primary sm" onClick={() => setAdding(true)}>＋ Add user</button>
      </div>
      {error ? <div className="card-body"><ErrorBox error={error} onRetry={reload} /></div> : loading && !d ? <Loading /> : (
        <>
          <Table head={['User', 'Plan', ' Credits left', ' Credits used', ' API cost', ' Brands', ' Posts', 'Joined', '']} empty="No users match." rows={d.users.map((u) => (
            <tr key={u.id}>
              <td><div className="row"><Avatar name={u.name} size={28} /><div style={{ minWidth: 0 }}><div className="bold">{u.name} {u.is_admin && <span className="badge brand">admin</span>} {u.suspended && <span className="badge err">suspended</span>}</div><div className="tiny muted">{u.email}</div></div></div></td>
              <td><span className="badge">{u.plan}</span></td>
              <R>{fmtNum(u.credits)}</R><R>{fmtNum(u.credits_used)}</R><R>{usd(u.api_cost)}</R><R>{u.brands}</R><R>{u.posts}</R>
              <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDay(u.created_at)}</td>
              <R><button className="btn sm" onClick={() => openUser(u.id)}>Manage</button></R>
            </tr>
          ))} />
          <div className="row between card-body small muted">
            <span>{d.total.toLocaleString()} users</span>
            {d.pages > 1 && <div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button><span>Page {d.page} of {d.pages}</span><button className="btn sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>Next →</button></div>}
          </div>
        </>
      )}
      {adding && <AddUser onClose={() => setAdding(false)} onDone={(u) => { setAdding(false); toast(`Created ${u.email}`, 'ok'); reload(); openUser(u.id); }} />}
    </div>
  );
}

function AddUser({ onClose, onDone }) {
  const { toast } = useApp();
  const [f, setF] = useState({ name: '', email: '', password: '', plan: 'trial', credits: '', is_admin: false });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title="Add user" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={async () => onDone(await post('/api/admin/users', { ...f, credits: f.credits === '' ? undefined : Number(f.credits) }))}>Create user</AsyncButton></>}>
      <div className="stack">
        <div className="field"><label>Name</label><input className="input" value={f.name} onChange={set('name')} /></div>
        <div className="field"><label>Email</label><input className="input" type="email" value={f.email} onChange={set('email')} /></div>
        <div className="field"><label>Password</label><input className="input" type="text" value={f.password} onChange={set('password')} /><span className="hint">At least 8 characters. Share it with them securely; they can change it in Plan &amp; account.</span></div>
        <div className="grid g2">
          <div className="field"><label>Plan</label><select className="select" value={f.plan} onChange={set('plan')}>{['trial', 'core', 'rise', 'enterprise'].map((p) => <option key={p}>{p}</option>)}</select></div>
          <div className="field"><label>Starting credits</label><input className="input" type="number" min={0} placeholder="Plan default" value={f.credits} onChange={set('credits')} /></div>
        </div>
        <label className="checkbox"><input type="checkbox" checked={f.is_admin} onChange={(e) => setF({ ...f, is_admin: e.target.checked })} /> Site admin</label>
      </div>
    </Modal>
  );
}

function UserDetail({ id, onClose, onChanged }) {
  const { me, toast } = useApp();
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/users/${id}`), [id]);
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [plan, setPlan] = useState('');
  const fail = (e) => toast(e.message, 'err');
  const done = async (msg) => { toast(msg, 'ok'); await reload(); onChanged(); };
  const u = d?.user;
  const self = u?.id === me.user.id;
  const adjust = async (sign) => {
    const n = Math.abs(Math.round(Number(delta)));
    if (!n) throw new Error('Enter a number of credits.');
    await post(`/api/admin/users/${id}/credits`, { delta: sign * n, note });
    setDelta('');
    setNote('');
    await done(`${sign > 0 ? 'Added' : 'Removed'} ${n.toLocaleString()} credits`);
  };
  return (
    <Modal wide title={u ? u.name : 'User'} onClose={onClose}>
      {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !d ? <Loading /> : (
        <div className="stack">
          <div className="row wrap">
            <Avatar name={u.name} size={40} />
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="bold">{u.email} {u.is_admin && <span className="badge brand">admin</span>} {u.suspended && <span className="badge err">suspended</span>}</div>
              <div className="tiny muted">Joined {fmtDay(u.created_at)} · {d.plan.label}{d.plan.trialEndsAt ? ` · trial ${d.plan.expired ? 'ended' : 'ends'} ${fmtDay(d.plan.trialEndsAt)}` : u.credits_reset_at ? ` · refills ${fmtDay(u.credits_reset_at)}` : ''} · {d.sessions} active session{d.sessions === 1 ? '' : 's'}</div>
            </div>
          </div>
          <div className="grid g4">
            <Kpi label="Credits left" value={fmtNum(u.credits)} />
            <Kpi label="Credits used" value={fmtNum(d.totals.credits_used)} />
            <Kpi label="API cost" value={usd(d.totals.api_cost)} />
            <Kpi label="Cost per credit" value={perCredit(d.totals.credits_used > 0 ? d.totals.api_cost / d.totals.credits_used : null)} />
          </div>

          <div className="card pad">
            <h3>Credits</h3>
            <div className="row wrap mt">
              <input className="input" style={{ width: 120 }} type="number" min={1} placeholder="Amount" value={delta} onChange={(e) => setDelta(e.target.value)} aria-label="Credits" />
              <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Note (optional, shown in the ledger)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <AsyncButton className="btn primary sm" onError={fail} onClick={() => adjust(1)}>＋ Add</AsyncButton>
              <AsyncButton className="btn sm danger" onError={fail} onClick={() => adjust(-1)}>− Remove</AsyncButton>
            </div>
            <div className="row wrap mt">
              <span className="small">Plan</span>
              <select className="select" style={{ width: 160 }} value={plan || u.plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">{['trial', 'core', 'rise', 'enterprise'].map((p) => <option key={p}>{p}</option>)}</select>
              <AsyncButton className="btn sm" onError={fail} onClick={async () => { await patch(`/api/admin/users/${id}`, { plan: plan || u.plan }); setPlan(''); await done('Plan updated and credits refilled'); }}>{(plan || u.plan) === u.plan ? (u.plan === 'trial' ? 'Restart trial' : 'Refill credits') : 'Change plan'}</AsyncButton>
              <span className="tiny muted">Starts a new cycle and sets credits to the plan amount.</span>
            </div>
          </div>

          <div className="card pad">
            <h3>Access</h3>
            <div className="stack mt">
              <div className="row between"><Switch on={u.is_admin} label="Site admin" disabled={self || u.admin_via_env} onChange={async (v) => { try { await patch(`/api/admin/users/${id}`, { is_admin: v }); await done(v ? 'Admin access granted' : 'Admin access removed'); } catch (e) { fail(e); } }} />{u.admin_via_env && <span className="tiny muted">Set by ADMIN_EMAILS on the server</span>}</div>
              <div className="row between"><Switch on={u.suspended} label="Suspended" disabled={self} onChange={async (v) => { try { await patch(`/api/admin/users/${id}`, { suspended: v }); await done(v ? 'Account suspended and signed out' : 'Account restored'); } catch (e) { fail(e); } }} /><span className="tiny muted">Blocks sign-in, the app and API keys.</span></div>
              {!self && (
                <div className="row between">
                  <span className="small muted">Deletes the account, the {d.brands.length} brand{d.brands.length === 1 ? '' : 's'} it owns and all their posts.</span>
                  <AsyncButton className="btn sm danger" onError={fail} onClick={async () => { if (!confirm(`Delete ${u.email} and everything in the brands they own? This cannot be undone.`)) return; await del(`/api/admin/users/${id}`); toast('Account deleted', 'ok'); onChanged(); onClose(); }}>Delete account</AsyncButton>
                </div>
              )}
            </div>
          </div>

          <Card title="Brands owned">
            <Table head={['Brand', ' Posts', ' Channels', ' Members', 'Created']} empty="No brands." rows={d.brands.map((b) => <tr key={b.id}><td className="bold">{b.name}</td><R>{b.posts}</R><R>{b.channels}</R><R>{b.members}</R><td className="muted">{fmtDay(b.created_at)}</td></tr>)} />
            {d.member_of.length > 0 && <p className="tiny muted mt">Also a member of {d.member_of.map((b) => `${b.name} (${b.role})`).join(', ')}.</p>}
          </Card>
          <Card title="API usage" subtitle="All time">
            <Table head={['Feature', 'Model', ' Calls', ' Tokens', ' Cost']} empty="No API calls yet." rows={d.usage.map((r) => <tr key={r.provider + r.model + r.feature}><td>{featureLabel(r.feature)}</td><td className="muted">{r.model || r.provider}</td><R>{r.calls}</R><R>{r.provider === 'heygen' ? `${Math.round(r.units)} s video` : tokens(r)}</R><R>{usd(r.cost)}</R></tr>)} />
          </Card>
          <Card title="Payments" subtitle={d.plan.source === 'dodo' ? `Paid via checkout · ${d.plan.billingStatus || 'unknown'}${d.plan.paidUntil ? ` · paid until ${fmtDay(d.plan.paidUntil)}` : ''}` : d.plan.source === 'admin' ? 'Plan assigned by an admin' : undefined}>
            <PaymentRows rows={d.payments} />
          </Card>
          <Card title="Credit history" subtitle="Last 100 entries">
            <LedgerRows rows={d.ledger} />
          </Card>
        </div>
      )}
    </Modal>
  );
}

function LedgerRows({ rows, withUser, openUser }) {
  return (
    <Table head={['When', ...(withUser ? ['User'] : []), 'What', ' Credits', 'Note']} empty="No entries." rows={rows.map((l) => (
      <tr key={l.id}>
        <td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.created_at)}</td>
        {withUser && <td><button className="btn ghost sm" style={{ padding: 0, height: 'auto' }} onClick={() => openUser(l.user_id)}>{l.email}</button></td>}
        <td>{reasonLabel(l.reason)}{l.brand_name && <span className="tiny muted"> · {l.brand_name}</span>}</td>
        <R className="bold" style={{ textAlign: 'right', color: l.delta > 0 ? 'var(--ok)' : undefined }}>{l.delta > 0 ? '+' : ''}{l.delta.toLocaleString()}</R>
        <td className="tiny muted">{[l.note, l.by_email && `by ${l.by_email}`].filter(Boolean).join(' · ')}</td>
      </tr>
    ))} />
  );
}

// ---------------------------------------------------------------- API usage
function Usage({ days, openUser }) {
  const [provider, setProvider] = useState('');
  const [feature, setFeature] = useState('');
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/usage?days=${days}&provider=${provider}&feature=${feature}`), [days, provider, feature]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  const t = d.totals;
  return (
    <>
      <div className="row wrap mb">
        <select className="select" style={{ width: 200 }} value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="Provider"><option value="">All providers</option>{d.filters.providers.map((p) => <option key={p} value={p}>{PROVIDER[p] || p}</option>)}</select>
        <select className="select" style={{ width: 200 }} value={feature} onChange={(e) => setFeature(e.target.value)} aria-label="Feature"><option value="">All features</option>{d.filters.features.map((f) => <option key={f} value={f}>{featureLabel(f)}</option>)}</select>
      </div>
      <div className="grid g4 mb">
        <Kpi label="Cost" value={usd(t.cost)} sub={`last ${days} days`} />
        <Kpi label="Calls" value={fmtNum(t.calls)} sub={t.calls ? `${usd(t.cost / t.calls)} per call` : 'No calls yet'} />
        <Kpi label="Input tokens" value={fmtNum(t.input)} sub={`${fmtNum(t.cache_read)} cache reads · ${fmtNum(t.cache_write)} cache writes`} />
        <Kpi label="Output tokens" value={fmtNum(t.output)} />
      </div>
      <div className="mb">
        <ChartCard title="Cost per day" rows={d.series.map((s) => [s.day, usd(s.cost)])} empty={t.calls ? null : ['No API calls yet', 'Calls appear here as users generate content.']}>
          <Line data={d.series.map((s) => ({ day: s.day, value: s.cost }))} format={(v) => usd(v)} />
        </ChartCard>
      </div>
      <div className="grid g2 mb">
        <Card title="By model">
          <Table head={['Model', ' Calls', ' Input', ' Output', ' Cost']} empty="No calls." rows={d.by_model.map((m) => <tr key={m.provider + m.model}><td><div className="bold">{m.model || m.provider}</div><div className="tiny muted">{PROVIDER[m.provider] || m.provider}</div></td><R>{fmtNum(m.calls)}</R><R>{m.provider === 'heygen' ? `${Math.round(m.units)} s` : fmtNum(m.input)}</R><R>{fmtNum(m.output)}</R><R className="bold">{usd(m.cost)}</R></tr>)} />
        </Card>
        <Card title="By feature">
          <Table head={['Feature', ' Calls', ' Tokens', ' Avg / call', ' Cost']} empty="No calls." rows={d.by_feature.map((f) => <tr key={f.provider + f.feature}><td><div className="bold">{featureLabel(f.feature)}</div><div className="tiny muted">{PROVIDER[f.provider] || f.provider}</div></td><R>{fmtNum(f.calls)}</R><R>{f.provider === 'heygen' ? `${Math.round(f.units)} s` : tokens(f)}</R><R>{usd(f.avg_cost)}</R><R className="bold">{usd(f.cost)}</R></tr>)} />
        </Card>
      </div>
      <div className="mb">
        <Card title="By user" subtitle="Accounts that paid for the calls">
          <Table head={['User', 'Plan', ' Calls', ' Tokens', ' Cost']} empty="No calls." rows={d.by_user.map((u) => <tr key={u.id || 'none'} style={{ cursor: u.email ? 'pointer' : undefined }} onClick={() => u.email && openUser(u.id)}><td>{u.email || <span className="muted">{u.id ? 'Deleted account' : 'No account'}</span>}</td><td>{u.plan && <span className="badge">{u.plan}</span>}</td><R>{fmtNum(u.calls)}</R><R>{fmtNum(u.tokens)}</R><R className="bold">{usd(u.cost)}</R></tr>)} />
        </Card>
      </div>
      <Card title="Recent calls" subtitle="Latest 100">
        <Table head={['When', 'User', 'Feature', 'Model', ' In', ' Out', ' Cost']} empty="No calls." rows={d.recent.map((r) => <tr key={r.id}><td className="muted" style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.created_at)}</td><td className="clip" style={{ maxWidth: 200 }}>{r.email || '—'}</td><td>{featureLabel(r.feature)}</td><td className="muted">{r.model}</td><R>{r.provider === 'heygen' ? `${Math.round(r.units)} s` : fmtNum(r.input_tokens)}</R><R>{fmtNum(r.output_tokens)}</R><R className="bold">{usd(r.cost_usd)}</R></tr>)} />
      </Card>
    </>
  );
}

const PAY_BADGE = { succeeded: 'ok', pending: '', failed: 'err', cancelled: 'warn', refunded: 'warn' };
function PaymentRows({ rows, withUser, openUser }) {
  return (
    <Table head={['Date', ...(withUser ? ['User'] : []), 'Plan', ' Amount', 'Status', 'Payment ID']} empty="No payments yet." rows={rows.map((p) => (
      <tr key={p.id}>
        <td className="nowrap muted">{fmtDate(p.created_at)}</td>
        {withUser && <td><button className="btn ghost sm" onClick={() => openUser(p.user_id)}>{p.email}</button></td>}
        <td>{p.plan}</td>
        <R>{fmtMoney(p.amount, p.currency)}</R>
        <td><span className={`badge ${PAY_BADGE[p.status] || ''}`}>{p.status}</span></td>
        <td className="tiny muted"><code>{p.payment_id || '—'}</code></td>
      </tr>
    ))} />
  );
}

// ---------------------------------------------------------------- payments
function Payments({ days, openUser, reloadKey }) {
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/payments?days=${days}`), [days, reloadKey]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  return (
    <>
      <div className="grid g4 mb">
        {d.revenue.length ? d.revenue.map((r) => <Kpi key={r.currency} label={`Revenue (${r.currency})`} value={fmtMoney(r.amount, r.currency)} sub={`${r.n} successful payment${r.n === 1 ? '' : 's'}`} />) : <Kpi label="Revenue" value={fmtMoney(0)} sub="No successful payments in this window" />}
        <Kpi label="Pending checkouts" value={d.payments.filter((p) => p.status === 'pending').length} sub="Started but not paid" />
      </div>
      <Card title="Payments" subtitle={`Last ${d.days} days · plans switch on only when the payment provider confirms the payment`}>
        <PaymentRows rows={d.payments} withUser openUser={openUser} />
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- ledger
function Ledger({ openUser, reloadKey }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const [d, { loading, error, reload }] = useLoad(() => get(`/api/admin/ledger?q=${encodeURIComponent(query)}&kind=${kind}&page=${page}`), [query, kind, page, reloadKey]);
  return (
    <div className="card">
      <div className="card-head" style={{ flexWrap: 'wrap' }}>
        <form className="row" onSubmit={(e) => { e.preventDefault(); setPage(1); setQuery(q); }}><input className="input" style={{ width: 260 }} placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search ledger" /></form>
        <div className="chips">{[['', 'All'], ['spend', 'Spending & refunds'], ['grants', 'Grants'], ['admin', 'Admin changes']].map(([k, l]) => <button key={k} className={`chip ${kind === k ? 'on' : ''}`} onClick={() => { setPage(1); setKind(k); }}>{l}</button>)}</div>
      </div>
      {error ? <div className="card-body"><ErrorBox error={error} onRetry={reload} /></div> : loading && !d ? <Loading /> : (
        <>
          <LedgerRows rows={d.rows} withUser openUser={openUser} />
          <div className="row between card-body small muted">
            <span>{d.total.toLocaleString()} entries</span>
            {d.pages > 1 && <div className="row"><button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Prev</button><span>Page {d.page} of {d.pages}</span><button className="btn sm" disabled={page >= d.pages} onClick={() => setPage(page + 1)}>Next →</button></div>}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- pricing
function Pricing() {
  const [d, { loading, error, reload }] = useLoad(() => get('/api/admin/pricing'), []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (loading && !d) return <Loading />;
  const m = d.measured;
  const p = d.prices;
  const writerEst = d.estimates[0];
  const costBasis = m.usd_per_credit ?? writerEst.usd_per_credit;
  const writerRow = p.claude.map((c) => c.model).filter((id) => p.writer.startsWith(id)).sort((a, b) => b.length - a.length)[0];
  const paid = d.plans.filter((x) => x.price).map((x) => x.usd_per_credit);
  return (
    <>
      <div className="grid g3 mb">
        <Kpi label="Measured API cost per credit" value={perCredit(m.usd_per_credit)} sub={m.usd_per_credit == null ? 'No credits used yet. See the estimates below.' : `${usd(m.cost)} spent on ${fmtNum(m.credits)} credits, last ${m.days} days`} />
        <Kpi label="Estimated, image post" value={perCredit(writerEst.usd_per_credit)} sub={`${usd(writerEst.cost)} for ${writerEst.credits} credits on ${p.writer}`} />
        <Kpi label="Revenue per credit" value={`${perCredit(Math.min(...paid))} – ${perCredit(Math.max(...paid))}`} sub="Paid plans, list price ÷ monthly credits" />
      </div>

      <div className="grid g2 mb">
        <Card title="Plans" subtitle={`Margin uses ${m.usd_per_credit == null ? 'the image-post estimate' : 'the measured cost'} of ${perCredit(costBasis)} per credit`}>
          <Table head={['Plan', ' Price', ' Credits', ' Per credit', ' Max API cost', ' Margin']} rows={d.plans.map((x) => {
            const cost = costBasis * x.credits;
            return <tr key={x.id}><td className="bold">{x.label}</td><R>{usd(x.price, 0)}</R><R>{fmtNum(x.credits)}</R><R>{x.price ? perCredit(x.usd_per_credit) : '—'}</R><R>{usd(cost)}</R><R className="bold">{x.price ? `${Math.round(((x.price - cost) / x.price) * 100)}%` : '—'}</R></tr>;
          })} />
          <p className="tiny muted mt">Max API cost assumes every credit is spent at that rate. Video credits mostly pay for server rendering, which has no API cost. Avatar videos and AI images cost the most per credit.</p>
        </Card>
        <Card title="Estimated API cost per action" subtitle={`Writer model ${p.writer} · ${fmtNum(d.typical_tokens.write_post.input)} in + ${fmtNum(d.typical_tokens.write_post.output)} out tokens per post`}>
          <Table head={['Action', ' Credits', ' API cost', ' Per credit']} rows={d.estimates.map((e) => <tr key={e.label} title={e.basis}><td><div>{e.label}</div><div className="tiny muted">{e.basis}</div></td><R>{e.credits}</R><R>{usd(e.cost)}</R><R className="bold">{perCredit(e.usd_per_credit)}</R></tr>)} />
        </Card>
      </div>

      <div className="mb">
        <Card title="Measured by job" subtitle={`Real API dollars per credit, last ${m.days} days`}>
          <Table head={['Job', ' Runs', ' Credits', ' API cost', ' Per run', ' Per credit']} empty="No credit charges yet." rows={[
            ...m.jobs.map((j) => <tr key={j.job}><td>{reasonLabel(j.job)}</td><R>{fmtNum(j.runs)}</R><R>{fmtNum(j.credits)}</R><R>{usd(j.cost)}</R><R>{j.usd_per_run == null ? '—' : usd(j.usd_per_run)}</R><R className="bold">{perCredit(j.usd_per_credit)}</R></tr>),
            ...m.uncharged.map((j) => <tr key={`u${j.job}`}><td className="muted">{reasonLabel(j.job)}</td><R className="muted">{fmtNum(j.calls)} call{j.calls === 1 ? '' : 's'}</R><R>0</R><R>{usd(j.cost)}</R><R /><R /></tr>),
          ]} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Claude prices" subtitle="US dollars per million tokens. Cache reads cost 10% of input, cache writes 125%.">
          <Table head={['Model', ' Input', ' Output']} rows={p.claude.map((c) => <tr key={c.model} style={c.model === writerRow ? { background: 'var(--brand-soft)' } : undefined}><td>{c.model}{c.model === writerRow && <span className="badge brand" style={{ marginLeft: 6 }}>writer</span>}</td><R>{usd(c.input)}</R><R>{usd(c.output)}</R></tr>)} />
        </Card>
        <Card title="Other providers and credit prices">
          <Table head={['Item', ' Price']} rows={[
            <tr key="hg"><td>HeyGen avatar video</td><R>{usd(p.heygen_per_minute)} / minute</R></tr>,
            <tr key="oi"><td>{p.openai_image_model} image</td><R>{p.openai_image != null ? `${usd(p.openai_image)} flat` : `${usd(p.openai_image_tokens.image_output, 0)} / M output tokens`}</R></tr>,
            ...Object.entries(d.credit_costs).map(([k, v]) => <tr key={k}><td className="muted">Credits: {k.replaceAll('_', ' ')}</td><R>{v} credit{v === 1 ? '' : 's'}</R></tr>),
          ]} />
          <p className="tiny muted mt">Set HEYGEN_USD_PER_MINUTE and OPENAI_IMAGE_USD in the server .env to match your contracts. Claude list prices are built in.</p>
        </Card>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- page
export default function Admin() {
  const { me } = useApp();
  const [tab, setTab] = useState('overview');
  const [days, setDays] = useState(30);
  const [userId, setUserId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  if (!me.user.is_admin) return <Navigate to="/app/dashboard" replace />;
  return (
    <>
      <div className="page-head">
        <div><h1>Admin</h1><p>All users, credits and API spend across Prepostly.</p></div>
        {(tab === 'overview' || tab === 'usage' || tab === 'payments') && <DayChips days={days} setDays={setDays} />}
      </div>
      <Tabs tabs={[['overview', 'Overview'], ['users', 'Users'], ['payments', 'Payments'], ['usage', 'API usage'], ['ledger', 'Credit ledger'], ['pricing', 'Credit pricing']]} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview days={days} openUser={setUserId} key={reloadKey} />}
      {tab === 'users' && <Users openUser={setUserId} reloadKey={reloadKey} />}
      {tab === 'payments' && <Payments days={days} openUser={setUserId} reloadKey={reloadKey} />}
      {tab === 'usage' && <Usage days={days} openUser={setUserId} />}
      {tab === 'ledger' && <Ledger openUser={setUserId} reloadKey={reloadKey} />}
      {tab === 'pricing' && <Pricing />}
      {userId && <UserDetail id={userId} onClose={() => setUserId(null)} onChanged={() => setReloadKey((k) => k + 1)} />}
    </>
  );
}
