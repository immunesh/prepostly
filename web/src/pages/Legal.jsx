import { Link, useSearchParams } from 'react-router-dom';
import { get, fmtDate } from '../lib/api.js';
import { useApp, useLoad } from '../lib/app.jsx';

// Public policy pages. Meta, Google, TikTok and LinkedIn app review link to these.
const EFFECTIVE = 'October 23, 2026';

function useLegal() {
  const { catalog } = useApp();
  const name = catalog?.legal?.name || 'Prepostly';
  const email = catalog?.legal?.email;
  const contact = email ? <a href={`mailto:${email}`}>{email}</a> : 'the contact address on our website';
  return { name, email, contact };
}

function Page({ title, children }) {
  return (
    <div className="share-page legal">
      <div className="row between mb">
        <Link to="/" className="row"><img src="/favicon.svg" alt="" width={28} /><span className="bold">Prepostly</span></Link>
        <LegalLinks />
      </div>
      <article className="card pad stack">
        <h1>{title}</h1>
        <p className="small muted">Effective {EFFECTIVE}</p>
        {children}
      </article>
    </div>
  );
}

export function LegalLinks() {
  return <nav className="row small muted legal-links"><Link to="/privacy">Privacy</Link><Link to="/terms">Terms</Link><Link to="/data-deletion">Data deletion</Link></nav>;
}

export function Privacy() {
  const { name, contact } = useLegal();
  return (
    <Page title="Privacy policy">
      <p>This policy explains what {name} (“we”) collects when you use Prepostly, how we use it, and the choices you have.</p>
      <h3>What we collect</h3>
      <ul>
        <li><b>Your account:</b> name, email address and a hashed password. We never store your password in readable form.</li>
        <li><b>Your brands and content:</b> brand details you enter or that we read from your website (name, logo, colors, description), prompts, uploads, generated posts, captions and schedules.</li>
        <li><b>Connected social accounts:</b> when you connect a channel, the platform gives us an access token plus your account or Page name, username, profile picture, ID and follower count. We use the token only to publish what you schedule and to read the metrics of posts we published for you. Tokens are encrypted at rest.</li>
        <li><b>Post performance:</b> likes, comments, shares, views and follower counts for posts published through Prepostly, to show your analytics.</li>
        <li><b>Store and competitor data you add:</b> product details from store links you import, and public posts or ads of competitors you choose to track.</li>
        <li><b>Technical data:</b> a session cookie to keep you logged in, and server logs (IP address, time, request) kept for security. We don’t use advertising or tracking cookies.</li>
      </ul>
      <h3>How we use it</h3>
      <p>To create, schedule and publish your content, show your analytics, run your team’s approvals, keep your account secure, and support you. We don’t sell your data or use it for advertising.</p>
      <h3>Who we share it with</h3>
      <ul>
        <li><b>Social platforms</b> you connect (such as Facebook, Instagram, Threads, LinkedIn, X, Pinterest, YouTube, TikTok and Google Business Profile), only to publish and to read your posts’ metrics.</li>
        <li><b>AI providers</b> that generate content when enabled: Anthropic (text), Cloudflare and OpenAI (images) and HeyGen (avatar videos). They receive your prompt and brand details needed for that request.</li>
        <li><b>Stock photo services</b> (Openverse, Pixabay, Pexels or Unsplash) receive search keywords, never personal data.</li>
        <li>Authorities, if the law requires it.</li>
      </ul>
      <h3>Google and YouTube data</h3>
      <p>Prepostly’s use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. We use YouTube API Services; by connecting YouTube you agree to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noreferrer">YouTube Terms of Service</a>, and Google’s handling of your data is covered by the <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google Privacy Policy</a>. You can revoke access at any time in your <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Google security settings</a>.</p>
      <h3>How long we keep it</h3>
      <p>We keep your data while your account is open. Disconnecting a channel deletes its tokens straight away. Deleting your account deletes your profile, the brands you own and all of their content, media and connected channels.</p>
      <h3>Your choices</h3>
      <p>You can view and edit your data in the app, disconnect any channel in <b>Brand & channels → Social platforms</b>, and delete your account in <b>Plan & account → Profile</b>. See <Link to="/data-deletion">data deletion</Link> for other ways to ask us to delete your data. You can also ask us for a copy of your data or to correct it.</p>
      <h3>Security</h3>
      <p>Connections are encrypted in transit, platform tokens are encrypted at rest, and access to your brands is limited to the team members you invite.</p>
      <h3>Children</h3>
      <p>Prepostly is not meant for anyone under 16.</p>
      <h3>Changes and contact</h3>
      <p>We’ll post changes here and update the effective date. Questions or requests: {contact}.</p>
    </Page>
  );
}

export function Terms() {
  const { name, contact } = useLegal();
  return (
    <Page title="Terms of service">
      <p>These terms are an agreement between you and {name} for your use of Prepostly. By creating an account you accept them.</p>
      <h3>Your account</h3>
      <p>Give accurate details and keep your password safe. You’re responsible for what happens in your account and for the team members you invite.</p>
      <h3>Your content</h3>
      <p>You own the content you upload and create. You give us permission to store, process and publish it only to provide the service to you. You confirm you have the rights to everything you upload or publish.</p>
      <h3>AI-generated content</h3>
      <p>Content made with AI can be inaccurate or similar to other people’s. Review it before you publish; you are responsible for what goes out under your name.</p>
      <h3>Social platforms</h3>
      <p>When you connect a channel, you authorize us to post on your behalf. You must follow each platform’s own terms and rules. Platforms can change or limit their APIs, which can affect publishing.</p>
      <h3>Acceptable use</h3>
      <p>Don’t use Prepostly for spam, deception, harassment, illegal content, or content that infringes others’ rights, and don’t try to break, overload or get around the security of the service.</p>
      <h3>Plans and credits</h3>
      <p>Paid plans and credits are described in the app. Credits refill each billing period and don’t carry over. Credits used for a generation that fails are refunded.</p>
      <h3>Ending your account</h3>
      <p>You can delete your account at any time. We may suspend accounts that break these terms.</p>
      <h3>Disclaimers and liability</h3>
      <p>The service is provided “as is”. To the extent the law allows, we aren’t liable for indirect or consequential losses, or for posts that platforms reject, delay or remove.</p>
      <h3>Changes and contact</h3>
      <p>We’ll post changes here and update the effective date. Questions: {contact}.</p>
    </Page>
  );
}

export function DataDeletion() {
  const { contact } = useLegal();
  const [params] = useSearchParams();
  const code = params.get('code');
  const [status, { error }] = useLoad(() => (code ? get(`/api/data-deletion/${encodeURIComponent(code)}`) : Promise.resolve(null)), [code]);
  return (
    <Page title="Data deletion">
      {code && (
        error ? <div className="alert err">{error.message}</div>
          : status && <div className="alert ok">Request <code>{status.code}</code> from {fmtDate(status.created_at)} is complete. We deleted {status.removed} connected account{status.removed === 1 ? '' : 's'} and their access tokens.</div>
      )}
      <p>You can remove your data from Prepostly in any of these ways:</p>
      <ul>
        <li><b>Disconnect a channel:</b> in <b>Brand & channels → Social platforms</b>, choose <b>Disconnect</b>. Its access tokens are deleted straight away.</li>
        <li><b>Delete your account:</b> in <b>Plan & account → Profile</b>, choose <b>Delete account</b>. This deletes your profile and the brands you own with all their posts, media and connected channels.</li>
        <li><b>Remove the app from Facebook or Instagram:</b> go to Settings → Apps and websites, remove Prepostly, and ask for your data to be deleted. We delete your connected Facebook Pages and Instagram accounts and give you a confirmation code you can check on this page.</li>
        <li><b>Remove the app from Threads:</b> in Threads, go to Settings → Account → Website permissions and remove Prepostly.</li>
        <li><b>Revoke access on other platforms</b> (LinkedIn, X, Google, TikTok, Pinterest) in that platform’s security or connected apps settings. Tokens stop working right away.</li>
        <li><b>Email us</b> at {contact} from your account’s email address and we’ll delete your data within 30 days.</li>
      </ul>
    </Page>
  );
}
