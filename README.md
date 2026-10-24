# Prepostly

Prepostly is a self-hosted social media content automation platform. It turns a one-line idea, an article or a product link into on-brand posts, carousels, videos and ads, then schedules them, routes them through approvals, and publishes to your channels. Auto posting keeps the calendar filled.

It is a clean-room reimplementation of the feature set of [Predis AI](https://predis.ai). See [docs/REVERSE_ENGINEERING.md](docs/REVERSE_ENGINEERING.md) for how each feature was identified and where it lives in this codebase.

## Quick start

```bash
cd ~/Documents/prepostly
npm install
npm run build        # builds the web app into dist/
npm start            # http://127.0.0.1:4100
```

Open http://127.0.0.1:4100, sign up (you get a 7-day trial with 300 credits), paste your website to build your brand kit, and create a post. To try publishing without real accounts, open **Brand & channels → Social platforms** and connect the **Sandbox** channel.

For development with hot reload, run `npm run dev`. The API runs on :4100 and Vite on :5174; open :5174.

Everything works without keys out of the box (stock photos come from Openverse; set `OPENVERSE=off` for a fully offline setup). Add keys to `.env` (copy `.env.example`) to switch on:

| Key | What it adds |
|---|---|
| `ANTHROPIC_API_KEY` | Claude writes post copy, captions, ad concepts, auto-posting topics, competitor themes and Idea Lab answers in any of 19 languages. Without it, a built-in offline writer produces English copy. |
| `PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` or `PIXABAY_API_KEY` | Stock photos chosen per slide. Without any of them, photos come from Openverse (no key; Creative Commons photos licensed for commercial use; each photo's credit is saved with its slide). Set `OPENVERSE=off` to turn that off. |
| `OPENAI_API_KEY` | AI-generated images |
| `HEYGEN_API_KEY` | UGC avatar videos |
| `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID` | Presenter and voice for avatar videos (list them with `npm run heygen`). Empty picks your first avatar and a voice in the post's language. |
| Platform app credentials | OAuth connections for Facebook, Instagram, Threads, LinkedIn profiles and Pages, X, Pinterest, YouTube, TikTok and Google Business Profile. You set them up once; every user then connects their own accounts by logging in on the platform. Platforms without credentials are listed as coming soon |
| `LEGAL_NAME`, `SUPPORT_EMAIL` | Business name and contact shown on the privacy policy, terms and data deletion pages |
| `PUBLIC_URL` | Required for platforms that download media by URL: Instagram, Threads, Pinterest, TikTok photo posts and Google Business |

Voiceover runs on-device with Kokoro (no key). The first narrated video downloads the model, about 90 MB.

## Features

| Area | What you get |
|---|---|
| **Create** | 14 post types: single image, carousel, quote, meme, special day, blog → carousel, product post, product carousel, ad creative, short video, voiceover video, text → video, product video ad, UGC avatar video. 6 formats (1:1, 4:5, 9:16, 16:9, 2:3, 4:3), 6 visual templates, 19 languages, 20 tones, prompt booster, image sources (uploads, product photos, stock, AI) |
| **Brand kit** | Fetch name, logo, colors, description and handle from your website. Colors and palettes, fonts, headline case, logos for light and dark backgrounds, hashtags, CTA, timezone and voice |
| **Editor** | Edit any slide's text, layout and image, switch design, "Resize with AI" into linked variants, caption rewrite (5 per post), hashtag regeneration, save as template, duplicate, share preview link, download |
| **Publish** | Publish now, schedule, bulk-schedule many posts over a weekly pattern for 1 to 12 weeks (select posts in the library), AI-suggested times from your own engagement history, drafts, per-platform caption limits, destination link and title, retries with backoff, relink detection |
| **Calendar** | Month and week views, colored by status, click an empty slot to schedule, drag to reschedule, discard, retry |
| **Approvals** | Owner, admin, editor and reviewer roles. Send for review, approve or request changes with comments, resubmit. Optionally require approval for all editors |
| **Auto posting** | Content direction, post-type mix, days and times, channels, approve-before-publish queue. Source from topics or your store products. Plans 1 week, 2 weeks or 1 month ahead and tops up daily |
| **E-commerce** | Import from Shopify, WooCommerce, or any store with schema.org product data. Product posts, carousels and video ads with price and sale badge |
| **Ads Studio** | Product link → ad concepts (headline, sub-header, badge, offer, CTA, disclaimer) → one creative per concept + a 9:16 video ad |
| **Ad Intelligence** | Track competitors' Meta ads through the Ad Library API. Longest-running "winners", angles, hooks, and one-click "recreate for my brand" |
| **Competitor analysis** | Instagram via Graph `business_discovery` (or paste CSV for any platform): engagement rate, content themes, post-type mix, hashtag performance, best posting slot, top posts, PDF export |
| **Idea Lab** | Brand-aware chat with streaming answers: post ideas, content calendars, ad copy. Turn any answer into a post |
| **Analytics** | Posting streak, monthly goal, new posts, followers, engagement, activity, engagement and follower charts, posting-time heatmap, engagement by platform, upcoming and latest posts |
| **Team & brands** | Multiple brands, invite links, roles, activate and deactivate, storage usage |
| **Plans & credits** | Trial, Core, Rise and Enterprise with credit costs per content type, monthly refills, plan limits (brands, channels, competitor runs, ad trackers, auto posting), refunds on failed generations, trial watermark |
| **Privacy** | Public privacy policy, terms and data deletion pages, Meta and Threads deletion and deauthorize callbacks, and self-service account deletion |
| **Developers** | API keys, REST API under `/v1`, and an MCP server at `/mcp` so Claude can create posts directly |

### Channels

| Platform | Connect with | Supports |
|---|---|---|
| Facebook Pages | OAuth (Meta app) | image, carousel, video, text |
| Instagram Business/Creator | OAuth (Meta app) | image, carousel, Reels, Stories |
| Threads | OAuth | image, carousel, video, text |
| LinkedIn profile | OAuth | image, multi-image, video, text |
| LinkedIn Page | OAuth (Community Management API) | image, multi-image, video, text; posts as the company |
| X | OAuth 2.0 (PKCE) | up to 4 images, video, text |
| Pinterest | OAuth | image, multi-image, video pins |
| YouTube | OAuth (Google) | Shorts and videos |
| TikTok | OAuth | video (direct post), photo carousels |
| Google Business Profile | OAuth (Google) | image, text |
| Blogger | OAuth (Google) | images, text; images are embedded from `PUBLIC_URL` |
| Tumblr | OAuth | up to 10 images, video, text; hashtags become tags |
| Bluesky | App password | up to 4 images, text |
| Mastodon | Access token | images, video, text |
| Telegram channel | Bot token | photo, album, video, text |
| Discord channel | Webhook URL | up to 10 images, video (10 MB max), text |
| Slack channel | Incoming webhook URL | images (from `PUBLIC_URL`), text |
| Sandbox | — | everything; writes to `data/outbox` for testing |

### Connecting platforms for your users

Create one developer app per platform, put its ID and secret in `.env`, and add the redirect URI `{PUBLIC_URL}/oauth/callback/{platform}` (for example `/oauth/callback/linkedin_page`). Each user then clicks **Log in with …** in **Brand & channels → Social platforms** and approves on the platform's own page. Their tokens are stored per brand and encrypted.

For app review, give each platform these URLs: `{PUBLIC_URL}/privacy`, `{PUBLIC_URL}/terms` and `{PUBLIC_URL}/data-deletion`. For Meta, also set the data deletion callback `{PUBLIC_URL}/callbacks/meta/data-deletion` and the deauthorize callback `{PUBLIC_URL}/callbacks/meta/deauthorize`. For Threads, set `{PUBLIC_URL}/callbacks/threads/data-deletion` and `{PUBLIC_URL}/callbacks/threads/uninstall`. The policy pages are a starting point; have them reviewed for your business and country.

TikTok only lets apps that pass its audit post publicly; until then, posts are private (`SELF_ONLY`) and Prepostly says so.

## Admin dashboard

Site admins get an **Admin dashboard** link in the sidebar (`/app/admin`). Put your email in `ADMIN_EMAILS` (comma-separated) in `.env` and restart; admins can then grant admin access to others from the dashboard.

- **Overview**: users, signups, active users, plans, posts, publishing, credits used and API spend per day.
- **Users**: search and sort every account; add or remove credits with a note, change plan, suspend (signs them out and blocks API keys), make admin, create or delete accounts.
- **API usage**: every Claude, HeyGen and OpenAI call with tokens and dollar cost, by model, feature and user.
- **Credit ledger**: every credit charge, refund and grant, with who made admin changes.
- **Credit pricing**: what one credit costs in API fees (measured from real calls, and estimated per action), against revenue per credit on each plan.

Claude costs use built-in list prices per model. Set `HEYGEN_USD_PER_MINUTE` (default 1) and `OPENAI_IMAGE_USD` (empty prices images from token usage) to match your contracts. Calls are recorded from the moment this version runs; earlier spend is not known.

## MCP (use Prepostly from Claude)

Create an API key in **Plan & account → API & MCP**, then:

```bash
claude mcp add --transport http prepostly http://127.0.0.1:4100/mcp --header "Authorization: Bearer cd_..."
```

Tools: `brand_info`, `list_post_types`, `create_post`, `get_post`, `list_posts`.

## REST API

All brand resources are available under `/v1` with `Authorization: Bearer <API key>`:

```bash
curl -X POST http://127.0.0.1:4100/v1/posts -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -d '{"type":"carousel","prompt":"5 tips for better sleep","slides":5}'
curl http://127.0.0.1:4100/v1/posts/<id>            # poll until "ready"
curl -X POST http://127.0.0.1:4100/v1/publish ...    # {post_id, account_ids, mode, scheduled_at}
```

## Testing

```bash
npm test             # 116 unit + integration tests (offline, isolated temp data dir)
npm run build && npm run test:e2e   # 6 browser tests in Chrome (set CHROME_PATH if needed)
```

- **Integration** ([test/integration/api.test.js](test/integration/api.test.js)) runs the real server against a local fixture website and store, covering auth, brand kit, every post type, rendering, video, editing, resizing, uploads, publishing, scheduling, retries, approvals, roles, e-commerce, Ads Studio, auto posting, competitor analysis, Idea Lab, analytics, API keys, MCP and credits.
- **Platform adapters** ([test/unit/publishers.test.js](test/unit/publishers.test.js)) check each platform's API call sequence against mocked endpoints.
- **Engines** ([test/unit/engines.test.js](test/unit/engines.test.js)) cover the writer (including the Claude request shape), renderer, scheduling math, analytics, scraper, SSRF protection and token encryption.
- **E2E** ([test/e2e/ui.test.js](test/e2e/ui.test.js)) clicks through sign-up → onboarding → create → edit → connect channel → publish → calendar → analytics → Idea Lab, and fails on any console error.

Live posting to real social networks was not tested, because that needs your platform app credentials. The adapters follow each platform's official API and are verified against mocked responses.

## Layout

```
server/
  index.js            Express app, static files, error handling
  config.js db.js     settings, SQLite schema (node:sqlite)
  auth.js credits.js  sessions, API keys, roles, token encryption, plans and credits
  generate.js         generation pipeline and job queue
  scheduler.js        publishing worker, retries, auto posting, metrics sync
  engines/            content (writer), llm (Claude), render (SVG→PNG), video (ffmpeg),
                      tts (Kokoro), images, scraper, besttime, autopilot, competitor, adintel
  publishers/         one adapter per platform
  routes/             HTTP API
web/src/              React app (pages, components)
test/                 unit, integration and e2e tests
docs/                 reverse-engineering findings
```

## Not included

- Payment checkout. Plans switch instantly in `BILLING_MODE=manual`; connect Stripe, Paddle or Dodo Payments for real billing.
- Email delivery. Invitations return a link to share, and notifications are in-app.
- Referral programs, an inspiration library of trending reference videos, and third-party video models (Veo, Kling).
