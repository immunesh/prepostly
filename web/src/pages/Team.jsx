import { useState } from 'react';
import { get, post, patch, del, fmtBytes } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';
import { AsyncButton, Avatar, Loading, Modal } from '../components/ui.jsx';

export default function Team() {
  const { me, toast, can, refresh, switchBrand, catalog } = useApp();
  const [overview, { reload: reloadOverview }] = useLoad(() => get('/api/team/overview'), []);
  const [team, { reload }] = useLoad(() => get('/api/team'), [me?.brand?.id]);
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState(false);
  const fail = (e) => toast(e.message, 'err');
  if (!overview || !team) return <Loading />;
  const s = overview.stats;
  const mine = overview.brands.filter((b) => b.owner_id === me.user.id);
  const shared = overview.brands.filter((b) => b.owner_id !== me.user.id);

  return (
    <>
      <div className="page-head"><div><h1>👥 Team & brands</h1><p>Manage your brands, team members and who can approve posts.</p></div></div>
      <div className="grid g4 mb">
        {[['Active brands', `${s.active_brands} of ${s.brand_limit >= 1000 ? '∞' : s.brand_limit}`], ['Team members', s.team_members], ['Shared with me', s.shared_with_me], ['Storage usage', fmtBytes(s.storage_bytes)]].map(([l, v]) => <div key={l} className="card metric"><div className="small muted">{l}</div><div className="value">{v}</div></div>)}
      </div>

      <div className="card mb">
        <div className="card-head"><h3>My brands</h3><button className="btn primary sm" onClick={() => setAdding(true)}>＋ Add a new brand</button></div>
        <table className="table"><thead><tr><th>Brand</th><th>Members</th><th>Channels</th><th>Posts</th><th>Status</th><th /></tr></thead><tbody>
          {mine.map((b) => (
            <tr key={b.id}>
              <td><div className="row"><Avatar src={b.logo_light} name={b.name} /><span className="bold">{b.name}</span>{b.id === me.brand.id && <span className="badge brand">Current</span>}</div></td>
              <td>{b.members}</td><td>{b.channels}</td><td>{b.posts}</td>
              <td>{b.active ? <span className="badge ok">Active</span> : <span className="badge">Inactive</span>}</td>
              <td className="right nowrap">
                {b.id !== me.brand.id && <button className="btn sm" onClick={() => switchBrand(b.id)}>Switch</button>}{' '}
                <AsyncButton className="btn ghost sm" onError={fail} onClick={async () => { await post(`/api/brands/${b.id}/${b.active ? 'deactivate' : 'activate'}`); reloadOverview(); refresh(); }}>{b.active ? 'Deactivate' : 'Activate'}</AsyncButton>
                <AsyncButton className="btn ghost sm danger" onError={fail} onClick={async () => { if (!confirm(`Once ${b.name} is deleted, all its generated content is lost and scheduled posts won't publish. Delete?`)) return; await del(`/api/brands/${b.id}`); await refresh(); reloadOverview(); }}>Delete</AsyncButton>
              </td>
            </tr>
          ))}
        </tbody></table>
      </div>

      {shared.length > 0 && (
        <div className="card mb">
          <div className="card-head"><h3>Shared with me</h3></div>
          <table className="table"><tbody>{shared.map((b) => <tr key={b.id}><td><div className="row"><Avatar src={b.logo_light} name={b.name} /><span className="bold">{b.name}</span></div></td><td className="small muted">Owner: {b.owner?.name}</td><td><span className="badge">{b.role}</span></td><td className="right">{b.id !== me.brand.id && <button className="btn sm" onClick={() => switchBrand(b.id)}>Switch</button>}</td></tr>)}</tbody></table>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h3>Team on {me.brand.name}</h3>{can('admin') && <button className="btn primary sm" onClick={() => setInviting(true)}>＋ Invite member</button>}</div>
        <table className="table"><tbody>
          {team.members.map((m) => (
            <tr key={m.id}>
              <td><div className="row"><Avatar name={m.name} /><div><div className="bold">{m.name}{m.id === me.user.id && ' (you)'}</div><div className="tiny muted">{m.email}</div></div></div></td>
              <td>
                {m.role === 'owner' || !can('admin') ? <span className="badge brand">{m.role}</span> : (
                  <select className="select" style={{ width: 140 }} value={m.role} onChange={async (e) => { try { await patch(`/api/team/${m.id}`, { role: e.target.value }); reload(); } catch (err) { fail(err); } }} aria-label={`Role for ${m.name}`}>
                    {['admin', 'editor', 'reviewer'].map((r) => <option key={r}>{r}</option>)}
                  </select>
                )}
              </td>
              <td className="small muted">{catalog?.roles[m.role]}</td>
              <td className="right">{m.role !== 'owner' && (can('admin') || m.id === me.user.id) && <AsyncButton className="btn ghost sm danger" onError={fail} onClick={async () => { await del(`/api/team/${m.id}`); if (m.id === me.user.id) await refresh(); else reload(); }}>{m.id === me.user.id ? 'Leave' : 'Remove'}</AsyncButton>}</td>
            </tr>
          ))}
          {team.invites.map((i) => (
            <tr key={i.id}><td><div className="row"><Avatar name={i.email} /><div><div>{i.email}</div><div className="tiny muted">Invitation pending</div></div></div></td><td><span className="badge warn">{i.role}</span></td>
              <td className="small"><button className="btn ghost sm" onClick={() => { navigator.clipboard?.writeText(`${location.origin}/signup?invite=${i.token}&email=${encodeURIComponent(i.email)}`); toast('Invite link copied'); }}>📋 Copy invite link</button></td>
              <td className="right">{can('admin') && <AsyncButton className="btn ghost sm" onClick={async () => { await del(`/api/team/invites/${i.id}`); reload(); }}>Revoke</AsyncButton>}</td></tr>
          ))}
        </tbody></table>
      </div>
      {inviting && <Invite onClose={() => setInviting(false)} onDone={reload} />}
      {adding && <NewBrand onClose={() => setAdding(false)} onDone={() => { reloadOverview(); refresh(); }} />}
    </>
  );
}

function Invite({ onClose, onDone }) {
  const { toast, catalog, can } = useApp();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('editor');
  const [link, setLink] = useState(null);
  return (
    <Modal title="Invite a team member" onClose={onClose} footer={!link && <AsyncButton className="btn primary" disabled={!email} onError={(e) => toast(e.message, 'err')} onClick={async () => { const r = await post('/api/team/invite', { email, role }); onDone(); if (r.link) setLink(`${location.origin}${r.link}`); else { toast(`${email} was added`, 'ok'); onClose(); } }}>Invite</AsyncButton>}>
      {link ? (
        <div className="stack"><div className="alert ok">Invitation created. Share this link with {email}; they join automatically when they sign up.</div><input className="input" readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" /><button className="btn" onClick={() => { navigator.clipboard?.writeText(link); toast('Copied'); }}>📋 Copy link</button></div>
      ) : (
        <div className="stack">
          <div className="field"><label htmlFor="ie">Email</label><input id="ie" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div className="field"><span className="label">Role</span>
            {['admin', 'editor', 'reviewer'].filter((r) => r !== 'admin' || can('owner')).map((r) => <label key={r} className="checkbox"><input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} /><span><span className="bold">{r}</span> <span className="small muted">— {catalog?.roles[r]}</span></span></label>)}
          </div>
        </div>
      )}
    </Modal>
  );
}

function NewBrand({ onClose, onDone }) {
  const { toast } = useApp();
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  return (
    <Modal title="Add a new brand" onClose={onClose} footer={<AsyncButton className="btn primary" disabled={!name.trim()} onError={(e) => toast(e.message, 'err')} onClick={async () => {
      let details = {};
      if (website) { try { details = await post('/api/brands/from-website', { url: website }); } catch { /* fall back to the name only */ } }
      await post('/api/brands', { name, website: details.website || website, description: details.description, industry: details.industry, colors: details.colors?.length ? details.colors : undefined, handle: details.handle, logo_url: details.logo || undefined });
      toast(`${name} created and selected`, 'ok');
      onDone();
      onClose();
    }}>Create</AsyncButton>}>
      <div className="stack">
        <div className="field"><label htmlFor="nb">Brand name</label><input id="nb" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label htmlFor="nw">Website (optional)</label><input id="nw" className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="We’ll fetch the logo and colors" /></div>
      </div>
    </Modal>
  );
}
