import { Link } from 'react-router-dom';
import { useApp } from '../lib/app.jsx';
import { LegalLinks } from './Legal.jsx';

const FEATURES = [
  ['🎠', 'Posts, carousels & videos', 'Describe an idea and get on-brand creatives with copy, captions and hashtags in seconds.'],
  ['🎨', 'Your brand, everywhere', 'Paste your website; we pull your logo, colors and voice into every design.'],
  ['🗓️', 'Schedule & auto-post', 'Plan on a calendar, get AI-suggested times, and publish to 12+ networks.'],
  ['🤖', 'Auto posting', 'Set a direction once. Prepostly fills your week with fresh posts for you to approve.'],
  ['🛍️', 'E-commerce ready', 'Import Shopify or WooCommerce products and turn them into posts, ads and videos.'],
  ['🔍', 'Competitor insights', 'See which themes, formats and hashtags win for your competitors.'],
  ['📣', 'Ads studio', 'Product link in, multiple ad concepts and creatives out.'],
  ['👥', 'Teams & approvals', 'Invite editors and reviewers. Nothing goes live until it is approved.'],
  ['🧩', 'API & MCP', 'Create content from your own apps, or straight from Claude.'],
];

export default function Landing() {
  const { me } = useApp();
  return (
    <div style={{ background: 'radial-gradient(ellipse at top, #efe7ff 0, var(--bg) 60%)', minHeight: '100%' }}>
      <div className="mk-nav">
        <Link to="/" className="logo" style={{ padding: 0 }}><img src="/favicon.svg" alt="" /><span>Prepostly</span></Link>
        <div className="right row">
          {me ? <Link className="btn primary" to="/app/dashboard">Open app</Link> : (
            <>
              <Link className="btn ghost" to="/login">Log in</Link>
              <Link className="btn primary" to="/signup">Start free trial</Link>
            </>
          )}
        </div>
      </div>
      <section className="hero">
        <span className="badge brand">AI social media content automation</span>
        <h1 style={{ marginTop: 18 }}>Your social media,<br /><em>on autopilot.</em></h1>
        <p>Prepostly turns a one-line idea, a blog or a product link into scroll-stopping posts, carousels, videos and ads in your brand style, then schedules and publishes them for you.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <Link className="btn primary lg" to={me ? '/app/create' : '/signup'}>Create your first post free</Link>
          <a className="btn lg" href="#features">See features</a>
        </div>
        <p className="small faint" style={{ marginTop: 14 }}>7-day free trial · 300 credits · no card needed</p>
      </section>
      <section id="features" style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 80px' }}>
        <div className="grid g3">
          {FEATURES.map(([e, t, d]) => (
            <div key={t} className="card feature">
              <div className="emoji">{e}</div>
              <h3>{t}</h3>
              <p className="muted">{d}</p>
            </div>
          ))}
        </div>
      </section>
      <footer className="row between wrap small muted" style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 40px' }}>
        <span>© {new Date().getFullYear()} Prepostly</span>
        <LegalLinks />
      </footer>
    </div>
  );
}
