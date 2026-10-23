// Static product catalogue: post types, formats, templates, tones, plans and credit costs.

export const POST_TYPES = {
  single_image: { label: 'Single image post', media: 'image', group: 'Images', description: 'One eye-catching creative with a caption.', slides: 1 },
  carousel: { label: 'Carousel', media: 'carousel', group: 'Images', description: 'A multi-slide post that tells a story or teaches.', slides: 5 },
  quote: { label: 'Quote post', media: 'image', group: 'Images', description: 'An inspiring or on-brand quote.', slides: 1 },
  meme: { label: 'Meme', media: 'image', group: 'Images', description: 'A relatable meme for your niche.', slides: 1 },
  special_day: { label: 'Special day', media: 'image', group: 'Images', description: 'Greetings for holidays and observances.', slides: 1 },
  blog_to_carousel: { label: 'Blog to carousel', media: 'carousel', group: 'Repurpose', description: 'Turn an article URL or text into a carousel.', slides: 6 },
  ecom_product: { label: 'Product post', media: 'image', group: 'E-commerce', description: 'Showcase a product from your store.', slides: 1 },
  ecom_carousel: { label: 'Product carousel', media: 'carousel', group: 'E-commerce', description: 'Several products, or one product from several angles.', slides: 4 },
  ad_creative: { label: 'Ad creative', media: 'image', group: 'Ads', description: 'Static ad with headline, offer and CTA.', slides: 1 },
  video: { label: 'Short video', media: 'video', group: 'Videos', description: 'Reel/Short/TikTok built from animated scenes.', slides: 5 },
  voiceover_video: { label: 'Voiceover video', media: 'video', group: 'Videos', description: 'Scenes narrated in your brand voice.', slides: 5 },
  text_to_video: { label: 'Text to video', media: 'video', group: 'Videos', description: 'Paste a script; get a captioned video.', slides: 6 },
  ecom_video: { label: 'Product video ad', media: 'video', group: 'E-commerce', description: 'A short promo video from product images.', slides: 4 },
  avatar_video: { label: 'UGC avatar video', media: 'video', group: 'Videos', description: 'A presenter talks about your product (needs HeyGen).', slides: 1, requires: 'heygen' },
};

// Output sizes. id → width x height plus the placements that use it.
export const FORMATS = {
  square: { label: 'Square 1:1', ratio: '1:1', w: 1080, h: 1080, uses: ['Instagram post', 'Facebook post', 'LinkedIn post', 'X post'] },
  ig_portrait: { label: 'Portrait 4:5', ratio: '4:5', w: 1080, h: 1350, uses: ['Instagram feed', 'Facebook feed', 'Instagram ads'] },
  story: { label: 'Story / Reel 9:16', ratio: '9:16', w: 1080, h: 1920, uses: ['Instagram story & reel', 'TikTok', 'YouTube Shorts', 'Facebook reel', 'WhatsApp status'] },
  landscape: { label: 'Landscape 16:9', ratio: '16:9', w: 1920, h: 1080, uses: ['YouTube', 'LinkedIn video', 'X video', 'Banners'] },
  pin: { label: 'Pin 2:3', ratio: '2:3', w: 1000, h: 1500, uses: ['Pinterest pin'] },
  gbp: { label: 'Google Business 4:3', ratio: '4:3', w: 1200, h: 900, uses: ['Google Business post'] },
};

export const TEMPLATES = {
  bold: { label: 'Bold', description: 'Big headline on a brand-color gradient.' },
  minimal: { label: 'Minimal', description: 'Clean light background with an accent bar.' },
  photo: { label: 'Photo overlay', description: 'Full-bleed image with a dark overlay.' },
  split: { label: 'Split', description: 'Image on one side, text on the other.' },
  editorial: { label: 'Editorial', description: 'Magazine-style serif headline.' },
  neon: { label: 'Neon', description: 'Dark background with glowing accents.' },
};

export const TONES = ['Friendly', 'Professional', 'Conversational', 'Educational', 'Inspirational', 'Humorous', 'Playful', 'Persuasive', 'Authoritative', 'Empathetic', 'Enthusiastic', 'Emotional', 'Luxurious', 'Minimalist', 'Nostalgic', 'Romantic', 'Sarcastic', 'Uplifting', 'Urgent', 'Informal'];

export const LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Hindi', 'Arabic', 'Japanese', 'Korean', 'Chinese (Simplified)', 'Turkish', 'Russian', 'Polish', 'Indonesian', 'Vietnamese', 'Thai', 'Swedish'];

export const FONTS = ['Poppins', 'Inter', 'Montserrat', 'Playfair Display', 'Anton', 'Lora', 'Oswald', 'Raleway'];

// Kokoro voices (on-device TTS).
export const VOICES = {
  af_heart: 'Heart (US, female)',
  af_bella: 'Bella (US, female)',
  af_nicole: 'Nicole (US, female, soft)',
  am_michael: 'Michael (US, male)',
  am_fenrir: 'Fenrir (US, male, deep)',
  bf_emma: 'Emma (UK, female)',
  bm_george: 'George (UK, male)',
};

export const PLATFORMS = {
  facebook: { label: 'Facebook Page', auth: 'oauth', media: ['image', 'carousel', 'video', 'text'] },
  instagram: { label: 'Instagram (Business/Creator)', auth: 'oauth', media: ['image', 'carousel', 'video'], publicMedia: true },
  threads: { label: 'Threads', auth: 'oauth', media: ['image', 'carousel', 'video', 'text'], publicMedia: true },
  linkedin: { label: 'LinkedIn profile', auth: 'oauth', media: ['image', 'carousel', 'video', 'text'] },
  linkedin_page: { label: 'LinkedIn Page', auth: 'oauth', media: ['image', 'carousel', 'video', 'text'] },
  x: { label: 'X (Twitter)', auth: 'oauth', media: ['image', 'carousel', 'video', 'text'] },
  pinterest: { label: 'Pinterest', auth: 'oauth', media: ['image', 'carousel', 'video'], publicMedia: true },
  youtube: { label: 'YouTube (Shorts)', auth: 'oauth', media: ['video'] },
  tiktok: { label: 'TikTok', auth: 'oauth', media: ['carousel', 'image', 'video'], publicMedia: true },
  google_business: { label: 'Google Business Profile', auth: 'oauth', media: ['image', 'text'], publicMedia: true },
  bluesky: { label: 'Bluesky', auth: 'token', media: ['image', 'carousel', 'text'], fields: [{ key: 'identifier', label: 'Handle (e.g. you.bsky.social)' }, { key: 'password', label: 'App password', secret: true }] },
  mastodon: { label: 'Mastodon', auth: 'token', media: ['image', 'carousel', 'video', 'text'], fields: [{ key: 'instance', label: 'Instance URL (e.g. https://mastodon.social)' }, { key: 'token', label: 'Access token (write:statuses, write:media)', secret: true }] },
  telegram: { label: 'Telegram channel', auth: 'token', media: ['image', 'carousel', 'video', 'text'], fields: [{ key: 'botToken', label: 'Bot token', secret: true }, { key: 'chatId', label: 'Channel (@name or numeric id)' }] },
  sandbox: { label: 'Sandbox (test channel)', auth: 'token', media: ['image', 'carousel', 'video', 'text'], fields: [{ key: 'name', label: 'Channel name' }] },
};

// Credits consumed per generation. Images ≈ 4, videos ≈ 40, like the reference product.
export const CREDIT_COSTS = {
  image: 4,
  carousel_slide: 2,
  video: 40,
  voiceover_video: 50,
  avatar_video: 120,
  resize: 2,
  caption_rewrite: 0,
  chat_message: 1,
  ad_concepts: 2,
  ai_image: 6,
};

export const PLANS = {
  trial: { label: 'Free trial', price: 0, credits: 300, brands: 1, channels: 5, competitorRuns: 5, adTrackers: 1, autoPosting: true, watermark: true, days: 7 },
  core: { label: 'Core', price: 19, credits: 1300, brands: 1, channels: 10, competitorRuns: 60, adTrackers: 2, autoPosting: false, watermark: false },
  rise: { label: 'Rise', price: 40, credits: 3200, brands: 4, channels: 20, competitorRuns: 130, adTrackers: 5, autoPosting: true, watermark: false },
  enterprise: { label: 'Enterprise', price: 212, credits: 10000, brands: 1000, channels: 60, competitorRuns: 600, adTrackers: 20, autoPosting: true, watermark: false },
};

export const ROLES = {
  owner: 'Full control, billing and deletion',
  admin: 'Manage brand, team and channels; publish',
  editor: 'Create and edit content; publish or send for approval',
  reviewer: 'View content and approve or reject posts',
};

export const AUTOPILOT_SUGGESTIONS = ['Product highlights', 'How to use it', 'Behind the scenes', 'Customer stories', 'Seasonal moments', 'Tips & education', 'Industry news', 'Myths vs facts'];
