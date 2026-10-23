import { useState } from 'react';
import { api, get, post, patch, del, fmtDate, fmtDay } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Loading, Tabs } from '../components/ui.jsx';

export default function Account() {
  const { me, refresh, toast, can } = useApp();
  const [acc, { reload }] = useLoad(() => get('/api/account'), []);
  const [tab, setTab] = useState('plan');
  if (!acc) return <Loading />;
  const fail = (e) => toast(e.message, 'err');
  return (
    <>
      <div className="page-head"><div><h1>💳 Plan & account</h1><p>Check your usage, change plan, and connect developer tools.</p></div></div>
      <Tabs value={tab} onChange={setTab} tabs={[['plan', 'Billing plan'], ['usage', 'Account usage'], ['developers', 'API & MCP'], ['profile', 'Profile']]} />
      {tab === 'plan' && (
        <>
          <div className="card pad mb row between wrap">
            <div><h3>{acc.plan.label}{acc.plan.expired && <span className="badge err" style={{ marginLeft: 8 }}>Expired</span>}</h3>
              <p className="small muted">{acc.credits.toLocaleString()} credits left{acc.credits_reset_at ? ` · refreshes ${fmtDay(acc.credits_reset_at)}` : acc.plan.trialEndsAt ? ` · trial ends ${fmtDay(acc.plan.trialEndsAt)}` : ''}</p></div>
            {acc.billing_mode === 'manual' && <span className="small muted">Self-hosted billing: plan changes apply instantly. Connect a payment provider for checkout.</span>}
          </div>
          <div className="grid g3">
            {Object.entries(acc.plans).filter(([k]) => k !== 'trial').map(([k, p]) => (
              <div key={k} className="card pad stack" style={k === 'rise' ? { borderColor: 'var(--brand)', borderWidth: 2 } : undefined}>
                <div className="row between"><h2>{p.label}</h2>{k === 'rise' && <span className="badge brand">Most popular</span>}</div>
                <div><span style={{ fontSize: 34, fontWeight: 800, fontFamily: 'var(--display)' }}>${p.price}</span><span className="muted">/month</span></div>
                <ul className="small" style={{ paddingLeft: 18, margin: 0, lineHeight: 1.9 }}>
                  <li>{p.credits.toLocaleString()} credits / month (≈{Math.floor(p.credits / 4)} images or {Math.floor(p.credits / 40)} videos)</li>
                  <li>{p.brands >= 1000 ? 'Unlimited' : `Up to ${p.brands}`} brand{p.brands === 1 ? '' : 's'}</li>
                  <li>{p.channels} social channels</li>
                  <li>{p.autoPosting ? 'Auto posting' : 'No auto posting'}</li>
                  <li>{p.competitorRuns} competitor runs / month</li>
                  <li>Tracks {p.adTrackers} brands in Ad Intelligence</li>
                  <li>No watermark · unlimited team members · API & MCP</li>
                </ul>
                {acc.plan.plan === k ? <button className="btn" disabled>Current plan</button> : (
                  <AsyncButton className="btn primary" disabled={acc.billing_mode !== 'manual'} onError={fail} onClick={async () => { await post('/api/account/plan', { plan: k }); toast(`You're on ${p.label}`, 'ok'); reload(); refresh(); }}>Switch to {p.label}</AsyncButton>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {tab === 'usage' && (
        <div className="grid g2" style={{ alignItems: 'start' }}>
          <div className="card pad stack">
            <h3>This month</h3>
            <div className="row between"><span>Posts created</span><span className="bold">{acc.usage.posts_this_month}</span></div>
            <div className="row between"><span>Competitor runs</span><span className="bold">{acc.usage.competitor_runs} / {acc.plan.competitorRuns}</span></div>
            <div className="divider" />
            <span className="label">Credits by feature</span>
            {acc.usage.credits_by_reason.length ? acc.usage.credits_by_reason.map((r) => <div key={r.reason} className="row between small"><span>{r.reason.replace(/[:_]/g, ' ')}</span><span>{r.credits}</span></div>) : <span className="small muted">No credits used yet this month.</span>}
          </div>
          <div className="card"><div className="card-head"><h3>Credit history</h3></div>
            <table className="table small"><tbody>{acc.ledger.map((l) => <tr key={l.id}><td className="nowrap muted">{fmtDate(l.created_at)}</td><td>{l.reason.replace(/[:_]/g, ' ')}</td><td style={{ textAlign: 'right', color: l.delta < 0 ? 'var(--err)' : 'var(--ok)' }}>{l.delta > 0 ? '+' : ''}{l.delta}</td></tr>)}</tbody></table>
          </div>
        </div>
      )}
      {tab === 'developers' && (can('admin') ? <Developers /> : <div className="alert info">API keys are managed by brand admins.</div>)}
      {tab === 'profile' && <Profile me={me} refresh={refresh} />}
    </>
  );
}

function Developers() {
  const { toast, brand } = useApp();
  const [keys, { reload }] = useLoad(() => get('/api/api-keys'), [brand?.id]);
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const origin = location.origin;
  return (
    <div className="grid g2" style={{ alignItems: 'start' }}>
      <div className="card pad stack">
        <h3>API keys for {brand.name}</h3>
        <p className="small muted">Keys act on this brand with your permissions. Send as <code>Authorization: Bearer cd_…</code>.</p>
        <div className="row"><input className="input" placeholder="Key name, e.g. Zapier" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key name" /><AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={async () => { setCreated(await post('/api/api-keys', { name: name || 'API key' })); setName(''); reload(); }}>Create key</AsyncButton></div>
        {created && <div className="alert ok stack tight"><span>Copy this key now. It won’t be shown again.</span><input className="input" readOnly value={created.key} onFocus={(e) => e.target.select()} aria-label="New API key" /></div>}
        <table className="table small"><tbody>{(keys || []).map((k) => <tr key={k.id}><td className="bold">{k.name}</td><td><code>{k.key_hint}</code></td><td className="muted">{k.last_used_at ? `used ${fmtDate(k.last_used_at)}` : 'never used'}</td><td className="right"><AsyncButton className="btn ghost sm danger" onClick={async () => { await del(`/api/api-keys/${k.id}`); reload(); }}>Revoke</AsyncButton></td></tr>)}</tbody></table>
      </div>
      <div className="stack">
        <div className="card pad stack">
          <h3>Use Prepostly in Claude (MCP)</h3>
          <p className="small muted">Make images, carousels and videos for {brand.name} from Claude Code, Claude Desktop or any MCP client. Generations use this brand’s credits.</p>
          <span className="label">Server URL</span>
          <input className="input" readOnly value={`${origin}/mcp`} onFocus={(e) => e.target.select()} aria-label="MCP server URL" />
          <span className="label">Claude Code</span>
          <pre style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 10, whiteSpace: 'pre-wrap', margin: 0 }}>{`claude mcp add --transport http prepostly ${origin}/mcp --header "Authorization: Bearer <your API key>"`}</pre>
          <p className="tiny muted">Then ask: “Make a 9:16 video about our new cold brew” or “Create a carousel with 5 latte art tips”.</p>
        </div>
        <div className="card pad stack">
          <h3>REST API</h3>
          <pre style={{ background: 'var(--surface-2)', padding: 12, borderRadius: 10, whiteSpace: 'pre-wrap', margin: 0 }}>{`curl -X POST ${origin}/v1/posts \\
  -H "Authorization: Bearer $PREPOSTLY_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"type":"carousel","prompt":"5 tips for better sleep","slides":5}'

curl ${origin}/v1/posts/<id>          # poll until status is "ready"
curl -X POST ${origin}/v1/publish ...  # same body as the app`}</pre>
          <p className="tiny muted">Every /api resource for posts, accounts, publishing, products and Ads Studio is also available under /v1 with an API key.</p>
        </div>
      </div>
    </div>
  );
}

function Profile({ me, refresh }) {
  const { toast } = useApp();
  const [name, setName] = useState(me.user.name);
  const [pw, setPw] = useState({ password: '', new_password: '' });
  const [confirmPw, setConfirmPw] = useState('');
  return (
    <div className="grid g2">
      <div className="card pad stack">
        <h3>Profile</h3>
        <div className="field"><label htmlFor="pn">Name</label><input id="pn" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="pe">Email</label><input id="pe" className="input" value={me.user.email} disabled /></div>
        <AsyncButton className="btn primary" onError={(e) => toast(e.message, 'err')} onClick={async () => { await patch('/api/me', { name }); await refresh(); toast('Saved', 'ok'); }}>Save</AsyncButton>
      </div>
      <div className="card pad stack">
        <h3>Change password</h3>
        <div className="field"><label htmlFor="cp">Current password</label><input id="cp" className="input" type="password" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} /></div>
        <div className="field"><label htmlFor="np">New password</label><input id="np" className="input" type="password" value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} /></div>
        <AsyncButton className="btn" onError={(e) => toast(e.message, 'err')} onClick={async () => { await patch('/api/me', pw); setPw({ password: '', new_password: '' }); toast('Password changed', 'ok'); }}>Change password</AsyncButton>
      </div>
      <div className="card pad stack" style={{ borderColor: 'var(--err)' }}>
        <h3>Delete account</h3>
        <p className="small muted">Deletes your profile and the brands you own, with all their posts, media, schedules and connected channels. Brands you were invited to stay with their owners. This can’t be undone.</p>
        <div className="field"><label htmlFor="dp">Enter your password to confirm</label><input id="dp" className="input" type="password" autoComplete="current-password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} /></div>
        <AsyncButton className="btn danger" disabled={!confirmPw} onError={(e) => toast(e.message, 'err')} onClick={async () => {
          if (!window.confirm('Delete your account and everything in the brands you own?')) return;
          await api('/api/me', { method: 'DELETE', body: { password: confirmPw } });
          window.location.assign('/');
        }}>Delete my account</AsyncButton>
      </div>
    </div>
  );
}
