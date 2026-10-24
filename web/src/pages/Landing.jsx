import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useApp } from '../lib/app.jsx';
import { LegalLinks } from './Legal.jsx';

// Marketing page. Post types, languages, plans and credit costs come from /api/catalog so the
// page always matches what the app sells.

const TYPE_ICON = {
  single_image: '🖼️', carousel: '🎠', quote: '💬', meme: '😂', special_day: '🎉', blog_to_carousel: '📰', ecom_product: '🛍️',
  ecom_carousel: '🧺', ad_creative: '📣', video: '🎬', voiceover_video: '🎙️', text_to_video: '📝', ecom_video: '📦', avatar_video: '🧑‍💼',
};

const AUDIENCES = ['Creators', 'Small businesses', 'Online stores', 'Agencies', 'Marketing teams', 'Coaches & consultants', 'Restaurants & cafés', 'Real estate'];

const CHANNELS = [
  ['📸', 'Instagram', 'Posts, carousels, Reels and Stories'],
  ['👍', 'Facebook Pages', 'Images, carousels, video and text'],
  ['🎵', 'TikTok', 'Videos and photo carousels'],
  ['▶️', 'YouTube', 'Shorts and videos'],
  ['💼', 'LinkedIn', 'Your profile or your company Page'],
  ['📌', 'Pinterest', 'Image, multi-image and video pins'],
  ['🧵', 'Threads', 'Images, carousels, video and text'],
  ['✖️', 'X', 'Up to 4 images, video and text'],
  ['📍', 'Google Business', 'Updates with an image'],
];
const MORE_CHANNELS = ['Blogger', 'Tumblr', 'Bluesky', 'Mastodon', 'Telegram', 'Discord', 'Slack'];

// Hero tiles sit on the background grid: [emoji, column from the centre line, row], in 54px cells.
const TILES = [
  ['📸', -12, 1], ['🎵', -7, 0], ['▶️', -11, 4], ['💼', -9, 6], ['🎨', -12, 8], ['📌', -9, 11],
  ['🦋', 6, 0], ['📍', 11, 1], ['👍', 9, 4], ['🧵', 11, 7], ['✖️', 8, 9], ['🗓️', 4, 11],
];

const FORMATS = [['1:1', 1, 1], ['4:5', 4, 5], ['9:16', 9, 16], ['16:9', 16, 9], ['2:3', 2, 3], ['4:3', 4, 3]];

const STEPS = [
  ['Add your brand', 'Paste your website. Prepostly reads your logo, colors, fonts and voice into a brand kit.'],
  ['Generate', 'Pick a post type and describe your idea, or paste a blog or product link.'],
  ['Edit or make variants', 'Change any slide’s text, layout or image, rewrite the caption, or resize it for every format.'],
  ['Schedule or auto-post', 'Publish now, put it on the calendar, or let auto posting plan the weeks ahead.'],
];

const FAQ = [
  ['What is Prepostly?', 'An AI content studio for social media. Describe an idea, paste a blog or a product link, and get on-brand posts, carousels, videos and ads with captions and hashtags. Then schedule them or let auto posting fill your calendar.'],
  ['How does the AI create posts?', 'It writes the copy, caption and hashtags from your prompt and brand kit, chooses photos for each slide (your uploads, product photos, stock photos or AI images), and lays them out in your colors, fonts and logo.'],
  ['Can I try it for free?', 'Yes. The free trial gives you 7 days and 300 credits with every feature switched on. No card is needed, and trial posts carry a small watermark.'],
  ['Can I use the posts commercially?', 'Yes, the posts you create are yours to publish. Stock photos come from licensed sources and each photo’s credit is saved with its slide.'],
  ['Can I edit the designs?', 'Every slide’s text, layout and image can be changed. You can switch designs, save a post as a template, and resize it into other formats.'],
  ['Can I create in other languages?', 'Posts, captions and videos can be written in 19 languages. Set a default per brand or pick one per post.'],
  ['Which networks can I publish to?', `${CHANNELS.map((c) => c[1]).concat(MORE_CHANNELS).join(', ')}. You log in on each platform’s own page; Prepostly never sees your password.`],
  ['Can my team review posts before they go live?', 'Yes. Invite editors and reviewers, send posts for review, approve or request changes, and optionally require approval for every post.'],
  ['Does it work for online stores?', 'Import products from Shopify, WooCommerce or any store with product data, then create product posts, carousels and video ads with price and sale badges.'],
  ['Can I use Prepostly from my own tools?', 'Yes. Create an API key to use the REST API, or connect the MCP server so Claude can create posts for you.'],
];

const LIMITS = [
  ['credits', (v, id) => `${v.toLocaleString()} credits${id === 'trial' ? '' : ' / month'}`],
  ['brands', (v) => (v >= 1000 ? 'Unlimited brands' : `${v} brand${v === 1 ? '' : 's'}`)],
  ['channels', (v) => `${v} connected channels`],
  ['competitorRuns', (v) => `${v} competitor analyses`],
  ['adTrackers', (v) => `${v} ad tracker${v === 1 ? '' : 's'}`],
];

const Arrow = () => <span className="arr" aria-hidden="true">→</span>;

/** Fades and lifts `.rv` elements (and the children of `.rv-kids`, staggered) as they scroll in. */
function useReveal(ref, deps) {
  useEffect(() => {
    const root = ref.current;
    if (!root || !('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    root.querySelectorAll('.rv-kids').forEach((group) => {
      [...group.children].forEach((el, i) => {
        el.classList.add('rv');
        el.style.setProperty('--d', `${Math.min(i, 8) * 70}ms`);
      });
    });
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -8% 0px' });
    root.querySelectorAll('.rv:not(.in)').forEach((el) => io.observe(el));
    root.classList.add('rv-on');
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

function Cursor({ label, tone, style }) {
  return (
    <span className={`cur ${tone}`} style={style} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="17" height="17"><path d="M1 1l5.2 13.6 2-5.8 5.8-2z" fill="currentColor" /></svg>
      <b>{tone === 'ink' && <i />}{label}</b>
    </span>
  );
}

function Header({ me, go }) {
  const [stuck, setStuck] = useState(false);
  const [mega, setMega] = useState(false);
  const [menu, setMenu] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    const onKey = (e) => { if (e.key === 'Escape') { setMega(false); setMenu(false); } };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('keydown', onKey); };
  }, []);

  const enter = () => { clearTimeout(timer.current); setMega(true); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setMega(false), 140); };
  const close = () => { setMega(false); setMenu(false); };

  return (
    <header className={`mk-head${stuck ? ' stuck' : ''}`}>
      <div className="mk-head-in">
        <Link to="/" className="logo"><img src="/favicon.svg" alt="" /><span>Prepostly</span></Link>
        <nav className="mk-pillnav" aria-label="Main" onMouseLeave={leave}>
          <button type="button" aria-expanded={mega} aria-controls="mk-mega" onMouseEnter={enter} onClick={() => setMega((v) => !v)}>
            Product <span className="chev" aria-hidden="true" />
          </button>
          <a href="#how" onMouseEnter={leave}>How it works</a>
          <a href="#publish" onMouseEnter={leave}>Channels</a>
          <a href="#pricing" onMouseEnter={leave}>Pricing</a>
          <a href="#faq" onMouseEnter={leave}>FAQ</a>
          <div id="mk-mega" className={`mk-mega${mega ? ' open' : ''}`} onMouseEnter={enter}>
            <div className="mm-cards">
              <a href="#create" className="mm-card" onClick={close}>
                <div className="mm-art a1"><span>Carousel</span><span>Video</span><span>Ad</span></div>
                <span className="mk-tag">14 post types</span>
                <b>Create on-brand content <Arrow /></b>
                <p>Posts, carousels, videos and ads from a prompt, a blog or a product link.</p>
              </a>
              <a href="#insights" className="mm-card" onClick={close}>
                <div className="mm-art a2">{[40, 62, 48, 80, 66, 94].map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}</div>
                <span className="mk-tag">Competitor ads</span>
                <b>Insights and analytics <Arrow /></b>
                <p>See which competitor ads win, and when your audience is listening.</p>
              </a>
              <a href="#publish" className="mm-card" onClick={close}>
                <div className="mm-art a3">{CHANNELS.slice(0, 5).map(([e]) => <span key={e}>{e}</span>)}</div>
                <span className="mk-tag">{CHANNELS.length + MORE_CHANNELS.length} channels</span>
                <b>Schedule and auto-post <Arrow /></b>
                <p>Publish now, plan the calendar, or let auto posting fill the weeks ahead.</p>
              </a>
            </div>
            <div className="mm-foot">
              <span className="mm-ico" aria-hidden="true">✨</span>
              <div><b>Not sure where to start? <span className="free">FREE</span></b><p>Try every feature for 7 days with 300 credits. No card needed.</p></div>
              <Link className="btn dark" to={go('/app/create')} onClick={close}>Try it free <Arrow /></Link>
            </div>
          </div>
        </nav>
        <div className="right">
          {me ? <Link className="btn lime" to="/app/dashboard">Open app <Arrow /></Link> : (
            <>
              <Link className="login" to="/login">Log in</Link>
              <Link className="btn lime" to="/signup">Start free trial</Link>
            </>
          )}
          <button type="button" className="mk-burger" aria-label="Menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)}><i /><i /></button>
        </div>
      </div>
      {menu && (
        <div className="mk-sheet">
          {[['#create', 'Create'], ['#insights', 'Insights'], ['#how', 'How it works'], ['#publish', 'Channels'], ['#pricing', 'Pricing'], ['#faq', 'FAQ']].map(([h, t]) => (
            <a key={h} href={h} onClick={close}>{t} <Arrow /></a>
          ))}
          {!me && <Link to="/login" onClick={close}>Log in <Arrow /></Link>}
        </div>
      )}
    </header>
  );
}

function Hero({ me, start, email, setEmail }) {
  return (
    <section className="mk-hero">
      <div className="mk-gridbg" aria-hidden="true" />
      <div className="mk-tiles" aria-hidden="true">
        {TILES.map(([e, c, r], i) => (
          <span key={e} className={Math.abs(c) < 9 ? 'near' : ''} style={{ left: `calc(50% + ${c * 54}px)`, top: r * 54, '--d': `${0.25 + i * 0.06}s`, '--f': `${5 + (i % 4)}s` }}><i>{e}</i></span>
        ))}
      </div>
      <div className="mk-hero-in">
        <span className="mk-eyebrow hi"><i />AI content studio for social media</span>
        <h1 className="mk-h1 hi" style={{ '--d': '0.08s' }}>
          <span className="g1">Your social</span> <span className="g2">media,</span><br />
          <span className="sweep">posted</span> on <em>autopilot.</em>
          <Cursor label="Copywriter" tone="blue" style={{ left: '-4%', top: '44%', '--d': '1.1s', '--t': '7s', '--x1': '10px', '--y1': '-8px', '--x2': '-6px', '--y2': '6px' }} />
          <Cursor label="Designer" tone="ink" style={{ right: '-2%', top: '-6%', '--d': '1.3s', '--t': '8.5s', '--x1': '-12px', '--y1': '6px', '--x2': '8px', '--y2': '-4px' }} />
          <Cursor label="Scheduler" tone="blue" style={{ left: '46%', top: '98%', '--d': '1.5s', '--t': '9.5s', '--x1': '14px', '--y1': '4px', '--x2': '-10px', '--y2': '-6px' }} />
        </h1>
        <p className="mk-lead hi" style={{ '--d': '0.16s' }}>Turn a one-line idea, a blog or a product link into on-brand posts, carousels, videos and ads. Prepostly schedules and publishes them for you.</p>
        <form className="mk-pillform hi" style={{ '--d': '0.24s' }} onSubmit={start}>
          {!me && <input type="email" placeholder="Enter your email…" aria-label="Your email" value={email} onChange={(e) => setEmail(e.target.value)} />}
          <button className="btn lime">{me ? 'Create a post' : 'Get started free'} <Arrow /></button>
        </form>
        <p className="mk-note hi" style={{ '--d': '0.3s' }}>7-day free trial · 300 credits · no card needed</p>
      </div>
      <div className="mk-hlinks">
        <a href="#create">Posts & carousels <span aria-hidden="true">↗</span></a>
        <a href="#videos">AI videos <span aria-hidden="true">↗</span></a>
        <a href="#insights">Competitor ads <span aria-hidden="true">↗</span></a>
        <a href="#publish">Auto posting <span aria-hidden="true">↗</span></a>
      </div>
    </section>
  );
}

function Marquee({ items }) {
  return (
    <div className="mk-marquee">
      <div className="track">
        {[...items, ...items].map((a, i) => <span key={i} aria-hidden={i >= items.length || undefined}>{a}</span>)}
      </div>
    </div>
  );
}

function Collage() {
  return (
    <div className="collage" aria-hidden="true">
      <div className="card-post" style={{ left: 0, top: 60, background: 'var(--orchid)', color: 'var(--ink)', transform: 'rotate(-7deg)', '--f': '7s' }}>
        <small>Carousel · 5 slides</small>5 tips for better cold brew
      </div>
      <div className="card-post" style={{ right: 0, top: 250, background: 'var(--cobalt)', color: '#fff', transform: 'rotate(6deg)', '--f': '8s' }}>
        <small>Product post</small>New season. Same great beans.
      </div>
      <div className="phone">
        <div className="av">☕</div>
        <div className="nm">Your brand</div>
        <div className="row-btn">✨ This week: 7 posts ready</div>
        <div className="row-btn alt">🗓️ Next: Tue 9:30 AM</div>
        <div className="tiles">
          <div style={{ background: 'var(--lime)', color: 'var(--forest)' }}>Monday motivation</div>
          <div style={{ background: 'var(--orchid)', color: 'var(--ink)' }}>Behind the scenes</div>
          <div style={{ background: '#fff', color: 'var(--ink)' }}>Customer story</div>
          <div style={{ background: 'var(--maroon)', color: '#fff' }}>Weekend offer</div>
        </div>
      </div>
      <div className="float" style={{ left: 10, bottom: 40, '--f': '6s' }}><span style={{ fontSize: 26 }}>✅</span><span><b>Published</b>to 4 channels</span></div>
      <div className="float" style={{ right: 20, top: 40, '--f': '7.5s' }}><span style={{ fontSize: 26 }}>🗓️</span><span><b>30 days</b>planned ahead</span></div>
    </div>
  );
}

function BrandKit() {
  return (
    <div className="mk-kit" aria-hidden="true">
      <div className="row between"><div className="row"><span className="logo-dot">B</span><b>Your brand kit</b></div><span className="badge brand">Auto-filled</span></div>
      <div><div className="tiny muted" style={{ marginBottom: 8 }}>Colors</div><div className="row">{['#254f1a', '#d2e823', '#e9c0e9', '#2665d6', '#1e2330'].map((c) => <span key={c} className="sw" style={{ background: c }} />)}</div></div>
      <div className="grid g2">
        <div className="kit-box"><div className="tiny muted">Headline font</div><b style={{ fontFamily: 'var(--display)', fontSize: 22 }}>Aa Bold</b></div>
        <div className="kit-box"><div className="tiny muted">Voice</div><b>Friendly, expert</b></div>
      </div>
      <div className="kit-box"><div className="tiny muted">Hashtags</div><span className="small">#coldbrew #coffeetime #morningritual</span></div>
    </div>
  );
}

function Pricing({ catalog, me }) {
  const plans = catalog?.plans;
  if (!plans) return <div className="grid g4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 420, borderRadius: 32 }} />)}</div>;
  return (
    <>
      <div className="mk-plans rv-kids">
        {Object.entries(plans).map(([id, p]) => (
          <div key={id} className={`plan${id === 'rise' ? ' hot' : ''}`}>
            {id === 'rise' && <span className="badge brand" style={{ alignSelf: 'flex-start' }}>Most popular</span>}
            <h3>{p.label}</h3>
            <div><span className="price">${p.price}</span><span className="muted">{id === 'trial' ? ` for ${p.days} days` : ' / month'}</span></div>
            <ul>
              {LIMITS.map(([k, f]) => <li key={k}>{f(p[k], id)}</li>)}
              <li>{p.autoPosting ? 'Auto posting' : 'No auto posting'}</li>
              <li>{p.watermark ? 'Small watermark on posts' : 'No watermark'}</li>
            </ul>
            <Link className={`btn ${id === 'rise' ? 'primary' : 'dark'} block`} to={me ? '/app/account' : '/signup'}>{id === 'trial' ? 'Try it free' : `Choose ${p.label}`}</Link>
          </div>
        ))}
      </div>
      {catalog.costs && (
        <p className="center muted mt rv" style={{ fontSize: 15 }}>
          What a credit buys: an image post {catalog.costs.image} credits · each carousel slide {catalog.costs.carousel_slide} · a short video {catalog.costs.video} · a UGC avatar video {catalog.costs.avatar_video}. Failed generations are refunded.
        </p>
      )}
    </>
  );
}

function Faq() {
  const [open, setOpen] = useState(0);
  return (
    <div className="faq rv-kids">
      {FAQ.map(([q, a], i) => (
        <div key={q} className={`qa${open === i ? ' open' : ''}`}>
          <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
            {q}<span className="pm" aria-hidden="true" />
          </button>
          <div className="ans"><div><p>{a}</p></div></div>
        </div>
      ))}
    </div>
  );
}

function Heading({ kicker, children, lead }) {
  return (
    <div className="mk-center rv">
      {kicker && <span className="mk-kicker">{kicker}</span>}
      <h2 className="mk-h2">{children}</h2>
      {lead && <p className="mk-lead">{lead}</p>}
    </div>
  );
}

export default function Landing() {
  const { me, catalog } = useApp();
  const nav = useNavigate();
  const root = useRef(null);
  const [email, setEmail] = useState('');
  const start = (e) => {
    e.preventDefault();
    nav(me ? '/app/create' : `/signup${email ? `?email=${encodeURIComponent(email)}` : ''}`);
  };
  const go = (path) => (me ? path : '/signup');
  const types = Object.entries(catalog?.post_types || {});
  const languages = catalog?.languages || [];
  useReveal(root, [catalog]);

  return (
    <div className="mk" ref={root}>
      <Header me={me} go={go} />
      <Hero me={me} start={start} email={email} setEmail={setEmail} />

      {/* Who it's for */}
      <section className="mk-band">
        <p className="mk-rule">Made for everyone who posts for a living</p>
        <Marquee items={AUDIENCES} />
      </section>

      {/* A week of posts */}
      <section className="mk-sec ink">
        <div className="mk-gridbg dark" aria-hidden="true" />
        <div className="mk-spark" aria-hidden="true" />
        <div className="mk-in mk-split">
          <div className="rv">
            <span className="mk-kicker">Your week, handled</span>
            <h2 className="mk-h2">One prompt in. A week of posts <em>out.</em></h2>
            <ul className="mk-list rv-kids">
              <li><span>✍️</span><div><b>Describe it once</b><p>A one-line idea, a blog post or a product link is enough.</p></div></li>
              <li><span>🎨</span><div><b>Get it on brand</b><p>Your logo, colors, fonts and voice on every slide and caption.</p></div></li>
              <li><span>🗓️</span><div><b>Let it post</b><p>Scheduled to every channel, or planned weeks ahead by auto posting.</p></div></li>
            </ul>
            <Link className="btn lime lg" to={go('/app/create')}>Start creating <Arrow /></Link>
          </div>
          <div className="rv" style={{ '--d': '120ms' }}><Collage /></div>
        </div>
      </section>

      {/* Brand style */}
      <section className="mk-sec orchid">
        <div className="mk-in mk-split">
          <div className="rv">
            <span className="mk-kicker">Brand kit</span>
            <h2 className="mk-h2">Every post in your brand’s <em>style</em></h2>
            <p className="mk-lead">Paste your website once. Prepostly pulls your name, logo, colors, fonts, hashtags and tone of voice, and applies them to every post, video and ad, for every brand you run.</p>
            <Link className="btn dark lg" to={go('/app/brand')}>Build your brand kit <Arrow /></Link>
          </div>
          <div className="rv" style={{ '--d': '120ms' }}><BrandKit /></div>
        </div>
      </section>

      {/* Content types */}
      <section className="mk-sec cobalt" id="create">
        <div className="mk-in">
          <Heading kicker="Create" lead={`${types.length || 14} post types in 6 formats. Images, carousels, videos, product posts and ads, each with copy, caption and hashtags.`}>
            Create exactly the content <em>you need</em>
          </Heading>
          <div className="mk-types rv-kids">
            {types.map(([id, t]) => (
              <Link key={id} to={go('/app/create')} className="t">
                <span className="em">{TYPE_ICON[id] || '✨'}</span>
                <b>{t.label}</b>
                <span>{t.description.replace(' (needs HeyGen)', '')}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Inputs */}
      <section className="mk-sec">
        <div className="mk-in">
          <Heading kicker="Inputs" lead="Creatives, headlines, captions, hashtags and calls to action come out of one flow.">
            Start from a prompt, a link or <em>your own images</em>
          </Heading>
          <div className="bento rv-kids">
            <div className="b-white"><span className="em">✍️</span><div><h3>A one-line prompt</h3><p>“5 tips for better sleep” becomes a five-slide carousel. The prompt booster adds detail when you need it.</p></div></div>
            <div className="b-lime"><span className="em">🔗</span><div><h3>A blog or product link</h3><p>Paste an article to turn it into a carousel, or a product page to get posts and ads with its price and photos.</p></div></div>
            <div className="b-white"><span className="em">🖼️</span><div><h3>Your own images</h3><p>Upload photos or use your product images. Or let Prepostly choose stock photos or create AI images per slide.</p></div></div>
          </div>
        </div>
      </section>

      {/* UGC avatar video */}
      <section className="mk-sec forest" id="videos">
        <div className="mk-in">
          <Heading kicker="Video" lead="Short videos, narrated voiceovers, text-to-video and UGC-style presenter videos, ready for Reels, Shorts and TikTok.">
            Videos that talk about <em>your product</em>
          </Heading>
          <div className="bento rv-kids">
            <div className="b-lime"><span className="em">🧑‍💼</span><div><h3>AI presenters</h3><p>A presenter introduces your product in a UGC-style video, from a script Prepostly writes for you.</p></div></div>
            <div className="b-orchid"><span className="em">🎙️</span><div><h3>Natural voiceovers</h3><p>Scenes narrated in your brand voice, with captions on every scene.</p></div></div>
            <div className="b-white"><span className="em">🌍</span><div><h3>In your audience’s language</h3><p>Write and narrate videos in any of {languages.length || 19} languages.</p></div></div>
          </div>
        </div>
      </section>

      {/* Insights */}
      <section className="mk-sec sage" id="insights">
        <div className="mk-in">
          <div className="mk-split">
            <div className="rv">
              <span className="mk-kicker">Insights</span>
              <h2 className="mk-h2">Know what’s working <em>before</em> you post</h2>
              <p className="mk-lead">Track your competitors’ ads and posts, learn which angles win, and see your own results in one dashboard.</p>
              <Link className="btn dark lg" to={go('/app/competitors')}>Analyze a competitor <Arrow /></Link>
            </div>
            <div className="mk-stats rv" style={{ '--d': '120ms' }} aria-hidden="true">
              <div className="kpis">
                <div><b>Followers</b>by channel</div>
                <div><b>Engagement</b>per post</div>
                <div><b>Streak</b>& monthly goal</div>
              </div>
              <div className="bars">
                {[38, 52, 44, 70, 58, 86, 64, 92, 74, 100].map((h, i) => <span key={i} style={{ height: `${h}%`, '--i': i }} />)}
              </div>
            </div>
          </div>
          <div className="mk-cards4 rv-kids">
            <div><span className="em">🏆</span><span className="mk-tag">Ad library</span><h3>Winning ads</h3><p>See which of a competitor’s Meta ads have run the longest, and recreate the idea for your brand in one click.</p></div>
            <div><span className="em">🎯</span><span className="mk-tag">Messaging</span><h3>Angles & hooks</h3><p>The offers, angles and opening lines competitors use most.</p></div>
            <div><span className="em">🔍</span><span className="mk-tag">Reports</span><h3>Competitor themes</h3><p>Engagement rate, content themes, post-type mix and top hashtags, exportable as a PDF.</p></div>
            <div><span className="em">⏰</span><span className="mk-tag">Timing</span><h3>Best time to post</h3><p>Suggested times from your own engagement history, plus a posting-time heatmap.</p></div>
          </div>
        </div>
      </section>

      {/* Channels */}
      <section className="mk-sec maroon" id="publish">
        <div className="mk-in">
          <Heading kicker="Publish" lead="Connect each account by logging in on the platform itself. Post now, schedule, or bulk-schedule weeks at once.">
            Publish to every platform <em>you use</em>
          </Heading>
          <div className="mk-channels rv-kids">
            {CHANNELS.map(([e, n, d]) => <div key={n}><span className="em">{e}</span><b>{n}</b><span>{d}</span></div>)}
          </div>
          <div className="mk-pills rv" style={{ justifyContent: 'center', marginTop: 24 }}>
            <span className="pill on">Also:</span>
            {MORE_CHANNELS.map((c) => <span key={c} className="pill">{c}</span>)}
          </div>
        </div>
      </section>

      {/* Variants */}
      <section className="mk-sec">
        <div className="mk-in mk-split">
          <div className="rv">
            <span className="mk-kicker">Variants</span>
            <h2 className="mk-h2">More variants, without <em>more work</em></h2>
            <p className="mk-lead">Resize any post into every format with AI, rewrite the caption, regenerate hashtags, or duplicate it to test a new angle.</p>
            <div className="mk-langs">{languages.map((l) => <span key={l}>{l}</span>)}</div>
          </div>
          <div className="mk-formats rv-kids" aria-hidden="true">
            {FORMATS.map(([r, w, h]) => (
              <div key={r}><span className="box" style={{ aspectRatio: `${w} / ${h}`, [w > h ? 'width' : 'height']: 92 }} /><b>{r}</b></div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="mk-sec lime" id="how">
        <div className="mk-in">
          <Heading kicker="How it works">From idea to published in <em>four steps</em></Heading>
          <ol className="mk-steps rv-kids">
            {STEPS.map(([t, d], i) => <li key={t}><span className="n">{i + 1}</span><h3>{t}</h3><p>{d}</p></li>)}
          </ol>
          <div className="center rv" style={{ marginTop: 40 }}><Link className="btn primary lg" to={go('/app/create')}>Try it free for 7 days <Arrow /></Link></div>
        </div>
      </section>

      {/* Always on */}
      <section className="mk-sec">
        <div className="mk-in">
          <Heading kicker="…and so much more">Built to keep you <em>posting</em></Heading>
          <div className="bento rv-kids">
            <div className="b-indigo wide"><span className="em">🤖</span><div><h3>Auto posting</h3><p>Set a content direction, post-type mix, days and times once. Prepostly plans one week to a month ahead and tops up daily, from topics or your store products.</p><Link className="mk-more" to={go('/app/autoposting')}>Set it up <Arrow /></Link></div></div>
            <div className="b-orchid"><span className="em">👥</span><div><h3>Teams & approvals</h3><p>Owner, admin, editor and reviewer roles. Nothing goes live until it is approved.</p><Link className="mk-more" to={go('/app/team')}>Invite your team <Arrow /></Link></div></div>
            <div className="b-white"><span className="em">💡</span><div><h3>Idea Lab</h3><p>A brand-aware chat for post ideas, content calendars and ad copy. Turn any answer into a post.</p><Link className="mk-more" to={go('/app/ideas')}>Get ideas <Arrow /></Link></div></div>
            <div className="b-lime"><span className="em">📣</span><div><h3>Ads studio</h3><p>Product link in; ad concepts, creatives and a 9:16 video ad out.</p><Link className="mk-more" to={go('/app/ads-studio')}>Make an ad <Arrow /></Link></div></div>
            <div className="b-forest"><span className="em">🧩</span><div><h3>API & MCP</h3><p>Create content from your own apps, or straight from Claude.</p><Link className="mk-more" to={go('/app/account')}>Get an API key <Arrow /></Link></div></div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="mk-sec sage" id="pricing">
        <div className="mk-in">
          <Heading kicker="Pricing" lead="Every plan includes all post types, the editor, scheduling and analytics. Credits refill monthly.">
            A plan for <em>every stage</em>
          </Heading>
          <Pricing catalog={catalog} me={me} />
        </div>
      </section>

      {/* FAQ */}
      <section className="mk-sec" id="faq">
        <div className="mk-in mk-faq">
          <div className="rv">
            <span className="mk-kicker">FAQ</span>
            <h2 className="mk-h2">Questions? <em>Answered.</em></h2>
            <p className="mk-lead">Can’t find what you need? Start the free trial and every feature is switched on for 7 days.</p>
          </div>
          <Faq />
        </div>
      </section>

      {/* Closing call to action */}
      <section className="mk-sec ink mk-cta">
        <div className="mk-gridbg dark" aria-hidden="true" />
        <div className="mk-spark mid" aria-hidden="true" />
        <div className="mk-in rv">
          <span className="mk-kicker">Ready when you are</span>
          <h2 className="mk-h1">Let’s fill your <em>calendar.</em></h2>
          <p className="mk-lead">Your first week of on-brand posts is one prompt away.</p>
          <div className="mk-cta-row">
            <Link className="btn lime lg" to={go('/app/create')}>Create your first post <Arrow /></Link>
            <a className="btn outline lg" href="#pricing">See pricing</a>
          </div>
        </div>
      </section>

      <footer className="mk-foot">
        <div className="box">
          <div className="col">
            <Link to="/" className="logo" style={{ padding: 0 }}><img src="/favicon.svg" alt="" /><span>Prepostly</span></Link>
            <p className="muted" style={{ maxWidth: 320, lineHeight: 1.55 }}>AI social media content automation: create, schedule and publish on-brand posts from one place.</p>
            <span className="small faint">© {new Date().getFullYear()} Prepostly</span>
          </div>
          <div className="col">
            <h4>Product</h4>
            <a href="#create">Post types</a>
            <a href="#insights">Insights</a>
            <a href="#publish">Channels</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="col">
            <h4>Account & legal</h4>
            <Link to="/login">Log in</Link>
            <Link to="/signup">Sign up</Link>
            <LegalLinks />
          </div>
        </div>
      </footer>
    </div>
  );
}
