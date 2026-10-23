import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && !process.env.PREPOSTLY_SKIP_DOTENV) process.loadEnvFile(envFile);

const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  port: Number(env('PORT', 4100)),
  host: env('HOST', '127.0.0.1'),
  // Public base URL. Social platforms fetch media from here, so it must be reachable
  // from the internet for Instagram, Threads, Pinterest, TikTok and Google Business.
  publicUrl: env('PUBLIC_URL', '').replace(/\/$/, ''),
  isProd: env('NODE_ENV') === 'production',
  isTest: env('NODE_ENV') === 'test',
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  secret: env('APP_SECRET', ''),
  maxUploadBytes: Number(env('MAX_UPLOAD_MB', 200)) * 1024 * 1024,

  // Workers
  schedulerEnabled: bool(env('SCHEDULER'), true),
  schedulerIntervalMs: Number(env('SCHEDULER_INTERVAL_MS', 15000)),

  // Copywriting LLM (Claude). Without it the built-in offline writer is used.
  anthropicConfigured: Boolean(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN')) && !bool(env('LLM_OFFLINE')),
  anthropicModel: env('ANTHROPIC_MODEL', 'claude-opus-5-5'),

  // Media
  voiceoverEnabled: bool(env('VOICEOVER'), true),
  pexelsKey: env('PEXELS_API_KEY'),
  unsplashKey: env('UNSPLASH_ACCESS_KEY'),
  pixabayKey: env('PIXABAY_API_KEY'),
  // Openverse needs no key, so it's the stock fallback unless OPENVERSE=off.
  openverse: bool(env('OPENVERSE'), true),
  openaiKey: env('OPENAI_API_KEY'),
  openaiImageModel: env('OPENAI_IMAGE_MODEL', 'gpt-image-1'),
  heygenKey: env('HEYGEN_API_KEY'),
  // Presenter and voice for avatar videos. Empty picks the account's first avatar and a voice in the post's language.
  heygenAvatarId: env('HEYGEN_AVATAR_ID'),
  heygenVoiceId: env('HEYGEN_VOICE_ID'),
  heygenPollMs: Number(env('HEYGEN_POLL_MS', 10000)),
  // Allow fetching private/loopback URLs (tests and local stores only).
  allowPrivateFetch: bool(env('ALLOW_PRIVATE_FETCH'), env('NODE_ENV') === 'test'),

  // Shown on the privacy policy, terms and data deletion pages.
  legalName: env('LEGAL_NAME', 'Prepostly'),
  supportEmail: env('SUPPORT_EMAIL', ''),

  // Billing: 'manual' lets account owners switch plans without payment (self-hosted).
  billingMode: env('BILLING_MODE', 'manual'),

  // Social platform apps (OAuth). A platform without credentials shows as "not configured".
  oauth: {
    facebook: { clientId: env('META_APP_ID'), clientSecret: env('META_APP_SECRET'), graphVersion: env('META_GRAPH_VERSION', 'v23.0') },
    instagram: { clientId: env('META_APP_ID'), clientSecret: env('META_APP_SECRET'), graphVersion: env('META_GRAPH_VERSION', 'v23.0') },
    threads: { clientId: env('THREADS_APP_ID'), clientSecret: env('THREADS_APP_SECRET') },
    linkedin: { clientId: env('LINKEDIN_CLIENT_ID'), clientSecret: env('LINKEDIN_CLIENT_SECRET'), apiVersion: env('LINKEDIN_API_VERSION', '202609') },
    // Company Pages (Community Management API). Can be the same app as above if it has both products.
    linkedin_page: { clientId: env('LINKEDIN_PAGES_CLIENT_ID'), clientSecret: env('LINKEDIN_PAGES_CLIENT_SECRET') },
    x: { clientId: env('X_CLIENT_ID'), clientSecret: env('X_CLIENT_SECRET') },
    pinterest: { clientId: env('PINTEREST_APP_ID'), clientSecret: env('PINTEREST_APP_SECRET') },
    youtube: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
    google_business: { clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET') },
    tiktok: { clientId: env('TIKTOK_CLIENT_KEY'), clientSecret: env('TIKTOK_CLIENT_SECRET') },
  },
};

for (const d of ['', 'media', 'uploads', 'outbox', 'tmp']) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });

/** The base URL the app is reachable at (for links and OAuth redirects). */
export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  if (req) return `${req.protocol}://${req.get('host')}`;
  return `http://${config.host}:${config.port}`;
}
