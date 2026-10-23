# Predis AI: reverse-engineering findings

This document records what was learned about Predis AI (app.predis.ai, build `v22.76.0`, captured 2026-10-21) and how each finding maps onto Prepostly. Prepostly is a clean-room reimplementation. No Predis code, assets or branding were copied. Only observable behaviour, the feature list and the UI vocabulary were used to decide *what* to build.

## Method

| Step | Tool | Evidence |
|---|---|---|
| Launched headless Chrome against `https://app.predis.ai/`, captured network and response bodies | REA `capture_browser_scenario` | `ev_2b862dc2…8b85` |
| Exported the 50+ captured JS chunks to disk | REA `export_web_scripts` | `ev_712018a2…71c9` |
| Static analysis of the main bundle (`index-37e727a3.js`) and service chunk | REA `analyze_javascript_application` | `ev_026a1fd2…07d5` (summary view `ev_03483135…39e2`) |
| Pulled the lazy route chunks (`AppRouter`, `AppHomeRouter`) and constant chunks named in the main bundle's import map, then read routes, endpoints and enums | grep over the shipped chunks | — |
| Read the full English UI string table `locales/en/translation.json` (649 KB, 195 namespaces) | Python | — |
| Read the public marketing, pricing and feature pages | WebFetch | predis.ai, predis.ai/pricing |

**Limit:** the app is behind a login (Google OAuth, Apple, email plus Cloudflare Turnstile). Nothing was observed executing *inside* an authenticated session. Every authenticated-feature finding below is derived from shipped code and strings, not from watching the feature run.

## Observed architecture

- **Frontend:** Vite and React SPA, MUI, react-router, i18next (`/locales/{lng}/translation.json`), Remotion vendor chunk (client-side video composition and preview), react-konva (canvas editor), Polotno font labels (design editor), Sentry, Mixpanel, Firebase, Paddle and Stripe checkout.
- **Backend API (from the shipped endpoint strings):** a Django-style `/users/*` REST surface, for example `get_content_library`, `upload_assets`, `set_brand_attribute`, `create_subscription`, `apply_coupon`, `get_active_notifications`, `login_google`, `login_facebook` and `login_apple`, plus `/igpost/get_post_previews/`.
- **Generation modes:** `predis_2_0`, `predis_4_0` and `ltd`. Generation runs asynchronously: the UI shows "key frames are ready" previews while a video is still rendering.

## Route map (from `AppRouter` and `AppHomeRouter` chunks)

`/dashboard`, `/new_post/create`, `/content_library`, `/content_calendar`, `/edit/:post_id`, `/chat_gpt` (Idea Lab), `/competitor`, `/ad_intelligence`, `/ads_studio`, `/autoposting`, `/autoposting_review`, `/inspiration_library`, `/asset-generator` and `/model-studio`, `/create_template`, `/workspace` (brand), `/settings`, `/package` (plans), `/post/share/:id`, `/shareable-link/:share_id`, `/onboarding`, `/onboarding-ecom/:store`, `/connect/authorize` (MCP OAuth consent), `/print-preview`.

## Feature ledger

Status: **Built** = implemented in Prepostly. **Adapter** = implemented against the provider's official API, needs your credentials to run live. **Not built** = out of scope; the reason is given.

| # | Predis feature | Evidence | Prepostly implementation | Status |
|---|---|---|---|---|
| 1 | Post types: single image, carousel, video, meme, quote, special day, business post, blog→post, text→video, voiceover video, e-commerce product post, ad creatives, product photoshoot, UGC/avatar video | `post_form_constants` (`create_*` enums), `post_generation_constants` | `server/catalog.js` POST_TYPES, `server/engines/content.js` | Built (avatar video: Adapter) |
| 2 | Aspect ratios and 39 placement presets (IG post 1:1/4:5, story/reel 9:16, YouTube 16:9, LinkedIn, Pinterest, GBP…) | `create-post.search-terms.*` | `catalog.js` FORMATS | Built |
| 3 | Brand kit: name, website fetch, colors and palettes, gradient, fonts and case, logo for light and dark backgrounds, social handle, website, hashtags, tonality (20 tones), ethnicity, voiceover voice, avatar, timezone | `manageBrand.brandDetails.*`, `brand_constants` | `routes/brands.js`, `engines/scraper.js` (website→brand) | Built |
| 4 | Multiple brands (workspaces), switch brand, activate and deactivate, delete | `teamBrands.*`, `sideBarBtn.switchBrandText` | `routes/brands.js`, `routes/team.js` | Built |
| 5 | Team members, invite, shared-with-me, roles and permissions | `teamBrands.addMember`, `myAcc.teamMember` | `routes/team.js` (owner/admin/editor/reviewer) | Built |
| 6 | Content library: filters, search, archive and bulk archive, delete, download quality, duplicate, retry failed generation at no credit cost | `contentLibrary.*` (903 strings) | `routes/posts.js`, `web/src/pages/Library.jsx` | Built |
| 7 | Editor: text and element edits, template switch, resize panel with sync, video edits and regenerate, VFX | `Editor.*` | `web/src/pages/Editor.jsx`, `routes/posts.js` | Built (blend-mode VFX not built: low value) |
| 8 | Resize with AI into other ratios as linked variants | `resizeWithAI.*` | `POST /api/posts/:id/resize` (variant with `parent_id`) | Built |
| 9 | Caption and hashtag generation, rewrite caption (limited rewrites), prompt booster | `publishing.ShareScreen.modelStudio.*`, `prompt-booster-0`, `boosted-prompt` | `engines/content.js` (`rewriteCaption`, `boostPrompt`) | Built |
| 10 | Publish now, schedule, AI-suggested time, brand timezone, per-platform title, description, destination link, tag people, location, collaborators | `publishing.*` | `routes/publish.js`, `engines/besttime.js` | Built (tagging fields passed where the platform API supports them) |
| 11 | Approval workflow: send for review to selected teammates, approve or reject with feedback, in-review and rejected states on calendar | `publishing.ScheduleScreen.review`, `contentCalender.postPreview.in_review` | `routes/publish.js` review endpoints, calendar statuses | Built |
| 12 | Content calendar: month, week and day, status colors (draft, failed, in review, rejected, scheduled, published), click empty slot to schedule, change date and time, discard, token-expiry relink banner | `contentCalender.*` | `web/src/pages/Calendar.jsx` | Built |
| 13 | Channels: Facebook pages and groups, Instagram (posts, reels, carousels, stories), TikTok, LinkedIn (personal and page), YouTube Shorts, X/Twitter, Pinterest, Google Business Profile | pricing page, `linkModal.*` | `server/publishers/*` | Adapter for each (plus Threads, Bluesky, Mastodon, Telegram and a local Sandbox channel) |
| 14 | Auto posting: content direction with suggestions, post-type mix, UGC hook, days and times, channels, approve-before-publish review queue, store-product sourcing | `autoPostingV32.*` (383 strings) | `engines/autopilot.js`, `routes/autopilot.js` | Built |
| 15 | Idea Lab ("Chat by Predis"): conversations, rename, clear, delete, example prompts (content ideas, content calendar, ad ideas) | `idealLab.*` | `routes/ideas.js` (streaming SSE) | Built |
| 16 | Competitor analysis: IG and FB handles, profile stats, content themes (sunburst), hashtag analysis, post performance, date range, refresh, PDF save, monthly run limits | `contentAnalysis.*` | `engines/competitor.js`, `routes/competitors.js` | Built (Instagram via Graph `business_discovery`; manual import for other platforms; print-to-PDF) |
| 17 | Ad Intelligence: track competitor Meta ads, longevity signals, breakdowns, boards, recreate an ad | `adIntelligence.*` (747 strings) | `engines/adintel.js` (Meta Ad Library API), `routes/adintel.js` | Adapter (needs Meta token) |
| 18 | Ads Studio: product URL or store → ad concepts (headline, stat, claim, badge, label, offer, price, comparison, CTA, disclaimer) → multi-concept static ads and video ads | `create-post.ad-concept.*`, `adsStudio.*` | `routes/adstudio.js` | Built (UGC avatar presenter: Adapter, needs HeyGen key) |
| 19 | E-commerce: Shopify, WooCommerce, Wix, Squarespace, Ecwid store connect, product import, product posts and videos | `brand_constants`, `Ecwid`, `Wix` chunks | `engines/scraper.js` (Shopify `products.json`, Woo Store API, JSON-LD for any store) | Built |
| 20 | Uploads library (images, video, audio) | `assetGenerator.uploads.*`, `workSpaceTabs.label3` | `routes/uploads.js` | Built |
| 21 | Templates: save a post as a template, template library, create-from-template | `workSpaceTabs.label4`, `/create_template` | `routes/templates.js` | Built |
| 22 | Analytics dashboard: greeting, posting streak, posting goal and progress, new posts, followers and engagement metric cards, engagement, activity, follower growth, post-time distribution and engagement contribution charts, upcoming and latest published posts | `dashboard.*` | `routes/analytics.js`, `web/src/pages/Dashboard.jsx` | Built (follower and engagement metrics need connected channels that expose insights) |
| 23 | Shareable post preview link (versioned) | `sharePreview.*`, `/shareable-link/:id` | `GET /s/:shareId` | Built |
| 24 | Plans, credits per content type, monthly refresh, usage stats, competitor-run quotas, brand and channel limits | pricing page, `credit-usage`, `myAcc.*` | `catalog.js` PLANS and CREDIT_COSTS, `server/credits.js` | Built (payment checkout not built: plug in Stripe, Paddle or Dodo) |
| 25 | Developer API and MCP server for Claude and ChatGPT (connected apps, consent, scopes) | `connectedApps.*`, `/connect/authorize` | `routes/v1.js` (API keys), `routes/mcp.js` (MCP over streamable HTTP, API-key auth) | Built (OAuth consent screen replaced by API-key bearer auth) |
| 26 | Voiceover videos (brand voice) | `brandDetails.brandVoiceoverTitle` | `engines/tts.js` (Kokoro on-device TTS) and `engines/video.js` (ffmpeg) | Built |
| 27 | AI video cover (thumbnail) | `aiCover.*` | first frame rendered as cover, sent where the platform API accepts it | Built |
| 28 | Watermark on free plan, removed on paid plans | `remove-watermark*` | renderer watermark flag | Built |
| 29 | Notifications | `/users/get_active_notifications/` | `routes/notifications.js` | Built (in-app only; no email delivery) |
| 30 | Referral rewards, checklist gamification, lifetime deals, Black Friday offers, G2 review prompts | `referral`, `checklist`, `ltd-*` | — | Not built (growth marketing, not product) |
| 31 | Inspiration library of trending reference videos | `inspirationLibrary.*` | — | Not built (needs a licensed reference-video catalogue) |
| 32 | Model Studio (third-party image and video models such as Veo, Kling, Seedance) | `assetGenerator.*`, `veo_video`, `Kling` | Image generation through OpenAI Images when `OPENAI_API_KEY` is set | Partial |
