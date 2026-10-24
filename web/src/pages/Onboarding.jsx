import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../lib/api.js';
import { useApp } from '../lib/app.jsx';
import { Spinner } from '../components/ui.jsx';
import { BrandColors } from './Brand.jsx';

// First run: fetch brand details from the website (or enter them), confirm, create the brand.

export default function Onboarding() {
  const { refresh, catalog, toast } = useApp();
  const nav = useNavigate();
  const [step, setStep] = useState(1);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [b, setB] = useState({ name: '', website: '', industry: '', description: '', audience: '', tone: 'Friendly', colors: ['#7c3aed', '#ec4899'], handle: '', logo: null, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });

  const fetchSite = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await post('/api/brands/from-website', { url });
      setB((x) => ({ ...x, ...d, colors: d.colors.length ? d.colors.slice(0, 4) : x.colors }));
      setStep(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await post('/api/brands', { name: b.name, website: b.website, industry: b.industry, description: b.description, audience: b.audience, tone: b.tone, colors: b.colors, handle: b.handle, timezone: b.timezone, logo_url: b.logo || undefined });
      await refresh();
      toast('Your brand is ready. Let’s create your first post!', 'ok');
      nav('/app/create');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const set = (k) => (e) => setB({ ...b, [k]: e.target.value });

  return (
    <div style={{ minHeight: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: 'linear-gradient(180deg, var(--lime) 0, var(--lime) 220px, var(--bg) 220px)' }}>
      <div className="card" style={{ width: 'min(640px, 100%)', padding: 32 }}>
        <div className="row" style={{ marginBottom: 20 }}><img src="/favicon.svg" alt="" width={34} /><span className="badge brand">Step {step} of 2</span></div>
        {error && <div className="alert err mb">{error}</div>}
        {step === 1 && (
          <form className="stack" onSubmit={fetchSite}>
            <h1>Let’s set up your brand</h1>
            <p className="muted">Paste your website and we’ll pull your name, logo, colors and description so every post looks like you.</p>
            <div className="field">
              <label htmlFor="site">Website</label>
              <input id="site" className="input" placeholder="yourbrand.com" value={url} onChange={(e) => setUrl(e.target.value)} required />
            </div>
            <div className="row">
              <button className="btn primary lg" disabled={busy}>{busy && <Spinner />}Fetch my brand</button>
              <button type="button" className="btn ghost" onClick={() => setStep(2)}>I’ll enter details myself</button>
            </div>
          </form>
        )}
        {step === 2 && (
          <div className="stack">
            <h1>Confirm your brand kit</h1>
            <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
              {b.logo && <img src={b.logo} alt="Logo" style={{ width: 72, height: 72, objectFit: 'contain', border: '1px solid var(--border)', borderRadius: 12, padding: 6 }} />}
              <div className="grid g2" style={{ flex: 1 }}>
                <div className="field"><label htmlFor="bn">Brand name</label><input id="bn" className="input" value={b.name} onChange={set('name')} required /></div>
                <div className="field"><label htmlFor="bi">Industry</label><input id="bi" className="input" value={b.industry} onChange={set('industry')} placeholder="e.g. coffee, fitness, SaaS" /></div>
              </div>
            </div>
            <div className="field"><label htmlFor="bd">What do you do?</label><textarea id="bd" className="textarea" value={b.description} onChange={set('description')} placeholder="One or two sentences about your business." /></div>
            <div className="grid g2">
              <div className="field"><label htmlFor="ba">Audience</label><input id="ba" className="input" value={b.audience} onChange={set('audience')} placeholder="Who you talk to" /></div>
              <div className="field"><label htmlFor="bt">Tone</label><select id="bt" className="select" value={b.tone} onChange={set('tone')}>{(catalog?.tones || ['Friendly']).map((t) => <option key={t}>{t}</option>)}</select></div>
              <div className="field"><label htmlFor="bh">Social handle</label><input id="bh" className="input" value={b.handle} onChange={set('handle')} placeholder="@yourbrand" /></div>
              <div className="field"><label htmlFor="bw">Website</label><input id="bw" className="input" value={b.website} onChange={set('website')} /></div>
            </div>
            <div className="field"><span className="label">Brand colors</span><BrandColors colors={b.colors} onChange={(colors) => setB({ ...b, colors })} /></div>
            <div className="row">
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary lg right" disabled={busy || !b.name.trim()} onClick={create}>{busy && <Spinner />}Create brand</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
