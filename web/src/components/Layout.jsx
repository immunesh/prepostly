import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app.jsx';
import { get, post, timeAgo } from '../lib/api.js';
import { Avatar, Dropdown } from './ui.jsx';

const NAV = [
  ['Create', [
    ['/app/create', '✨', 'Create post'],
    ['/app/library', '🗂️', 'Content library'],
    ['/app/calendar', '🗓️', 'Content calendar'],
    ['/app/autoposting', '🤖', 'Auto posting'],
  ]],
  ['Grow', [
    ['/app/dashboard', '📊', 'Analytics'],
    ['/app/ideas', '💡', 'Idea Lab'],
    ['/app/competitors', '🔍', 'Competitor analysis'],
    ['/app/ad-intelligence', '🛰️', 'Ad intelligence'],
    ['/app/ads-studio', '📣', 'Ads studio'],
  ]],
  ['Manage', [
    ['/app/brand', '🎨', 'Brand & channels'],
    ['/app/team', '👥', 'Team & brands'],
    ['/app/account', '💳', 'Plan & account'],
  ]],
];

function Notifications() {
  const { me, refresh } = useApp();
  const [items, setItems] = useState([]);
  const nav = useNavigate();
  const open = async () => {
    setItems(await get('/api/notifications'));
    if (me.unread) {
      await post('/api/notifications/read');
      refresh();
    }
  };
  return (
    <Dropdown trigger={<button className="btn ghost icon-btn" onClick={open} aria-label="Notifications" style={{ position: 'relative' }}>🔔{me.unread > 0 && <span style={{ position: 'absolute', top: 4, right: 4, background: 'var(--lime)', color: 'var(--ink)', borderRadius: 99, fontSize: 10, padding: '0 5px', fontWeight: 700 }}>{me.unread}</span>}</button>}>
      <div style={{ width: 340, maxHeight: 420, overflowY: 'auto' }}>
        {!items.length && <div className="muted small" style={{ padding: 14 }}>No notifications yet.</div>}
        {items.map((n) => (
          <button key={n.id} onClick={() => n.link && nav(n.link)} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span className="bold small">{n.title}</span>
            {n.body && <span className="muted tiny clip" style={{ maxWidth: 300 }}>{n.body}</span>}
            <span className="faint tiny">{timeAgo(n.created_at)}</span>
          </button>
        ))}
      </div>
    </Dropdown>
  );
}

export default function Layout() {
  const { me, brand, switchBrand, refresh } = useApp();
  const nav = useNavigate();
  // Keep credits fresh as generations finish.
  useEffect(() => {
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const plan = me.brand_plan;
  const pct = Math.max(0, Math.min(100, (me.brand_credits / (plan.credits || 1)) * 100));
  const logout = async () => {
    await post('/api/auth/logout');
    await refresh();
    nav('/');
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/app/dashboard" className="logo"><img src="/favicon.svg" alt="" /><span>Prepostly</span></Link>
        {[...NAV, ...(me.user.is_admin ? [['Admin', [['/app/admin', '🛡️', 'Admin dashboard']]]] : [])].map(([section, items]) => (
          <nav className="nav" key={section}>
            <div className="nav-section">{section}</div>
            {items.map(([to, ico, label]) => (
              <NavLink key={to} to={to} end={to === '/app/autoposting'}><span className="ico">{ico}</span>{label}</NavLink>
            ))}
          </nav>
        ))}
        <div className="grow" />
        <div className="credits-card">
          <div className="row between small"><span className="bold">Credits</span><span className="muted">{me.brand_credits.toLocaleString()} left</span></div>
          <div className="bar"><div style={{ width: `${pct}%` }} /></div>
          <div className="row between tiny muted">
            <span>{plan.label}{plan.trialEndsAt ? ` · ends ${new Date(plan.trialEndsAt).toLocaleDateString()}` : ''}</span>
            <Link to="/app/account">Upgrade</Link>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <Dropdown trigger={
            <button className="btn" aria-label="Switch brand">
              <Avatar src={brand?.logo_light} name={brand?.name} size={22} logo />
              <span className="clip" style={{ maxWidth: 180 }}>{brand?.name}</span>
              <span className="faint">▾</span>
            </button>
          }>
            <div className="tiny faint" style={{ padding: '6px 10px' }}>Switch brand</div>
            {me.brands.map((b) => (
              <button key={b.id} onClick={() => switchBrand(b.id)}>
                <Avatar src={b.logo_light} name={b.name} size={22} logo />
                <span className="clip" style={{ flex: 1 }}>{b.name}</span>
                {b.id === brand?.id && '✓'}
                <span className="badge">{b.role}</span>
              </button>
            ))}
            <div className="divider" style={{ margin: '6px 0' }} />
            <button onClick={() => nav('/app/team')}>➕ Add or manage brands</button>
          </Dropdown>
          {!brand?.active && <span className="badge warn">Brand inactive</span>}
          {me.capabilities.writer === 'offline' && <span className="badge" title="Basic writer: posts are written from templates">✍️ Offline writer</span>}
          <div className="spacer" />
          <Notifications />
          <Dropdown trigger={<button className="btn ghost" aria-label="Account menu"><Avatar name={me.user.name} size={26} /></button>}>
            <div style={{ padding: '6px 10px' }}><div className="bold">{me.user.name}</div><div className="tiny muted">{me.user.email}</div></div>
            <div className="divider" style={{ margin: '6px 0' }} />
            <button onClick={() => nav('/app/account')}>💳 Plan & account</button>
            <button onClick={logout}>↩️ Log out</button>
          </Dropdown>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
