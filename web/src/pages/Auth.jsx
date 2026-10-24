import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Spinner } from '../components/ui.jsx';
import { LegalLinks } from './Legal.jsx';

const CHANNEL_NAMES = ['Instagram', 'Facebook', 'LinkedIn', 'TikTok', 'YouTube', 'Pinterest', 'Threads', 'X', 'Google Business', 'Bluesky'];

function Shell({ children }) {
  return (
    <div className="auth">
      <div className="auth-form">
        <Link to="/" className="logo"><img src="/favicon.svg" alt="" /><span>Prepostly</span></Link>
        {children}
        <LegalLinks />
      </div>
      <div className="auth-side">
        <h2>Create a month of on-brand content in an afternoon.</h2>
        <p>Posts, carousels, videos and ads from one prompt. Scheduled and published to every channel you use.</p>
        <div className="mk-pills">{CHANNEL_NAMES.map((c) => <span key={c} className="pill">{c}</span>)}<span className="pill">+ 6 more</span></div>
      </div>
    </div>
  );
}

function useSubmit(path, body) {
  const { refresh } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post(path, body());
      const me = await refresh();
      nav(params.get('next') || (me?.brand ? '/app/dashboard' : '/app/onboarding'));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return { submit, busy, error };
}

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { submit, busy, error } = useSubmit('/api/auth/login', () => ({ email, password }));
  return (
    <Shell>
      <form onSubmit={submit}>
        <h1>Welcome back</h1>
        <p className="sub">Log in to keep creating.</p>
        {error && <div className="alert err">{error}</div>}
        <div className="field"><label htmlFor="email">Email</label><input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        <button className="btn primary lg" disabled={busy}>{busy && <Spinner />}Log in</button>
        <p className="small muted center">New to Prepostly? <Link to="/signup">Create an account</Link></p>
      </form>
    </Shell>
  );
}

export function Signup() {
  const [params] = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(params.get('email') || '');
  const [password, setPassword] = useState('');
  const { submit, busy, error } = useSubmit('/api/auth/signup', () => ({ name, email, password }));
  return (
    <Shell>
      <form onSubmit={submit}>
        <h1>Start your free trial</h1>
        <p className="sub">{params.get('invite') ? 'Create your account to join your team.' : '300 credits for 7 days. No card needed.'}</p>
        {error && <div className="alert err">{error}</div>}
        <div className="field"><label htmlFor="name">Your name</label><input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
        <div className="field"><label htmlFor="email">Work email</label><input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
        <div className="field"><label htmlFor="password">Password</label><input id="password" className="input" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required /><span className="hint">At least 8 characters.</span></div>
        <button className="btn primary lg" disabled={busy}>{busy && <Spinner />}Create account</button>
        <p className="small muted center">Already have an account? <Link to="/login">Log in</Link></p>
      </form>
    </Shell>
  );
}
