import { Router } from 'express';
import { one, all, run, uuid, now, insert } from '../db.js';
import { HttpError, requireUser, brandFor } from '../auth.js';
import { CREDIT_COSTS } from '../catalog.js';
import { charge } from '../credits.js';
import { llmAvailable, streamChat } from '../engines/llm.js';
import { planTopics, topicOf, keywords, titleCase, upcomingSpecialDays } from '../engines/content.js';

// Idea Lab: a brand-aware chat for content ideas, calendars and ad copy.

export const router = Router();
router.use(requireUser);

const words = (s) => (String(s).match(/\S+/g) || []).length;

function systemPrompt(brand) {
  return `You are Prepostly, a social media strategist inside a content tool. You help ${brand.name}${brand.industry ? ` (${brand.industry})` : ''} plan and write social content.
${brand.description ? `About the brand: ${brand.description}\n` : ''}${brand.audience ? `Audience: ${brand.audience}\n` : ''}Tone: ${brand.tone}. Language: ${brand.language}.
Give specific, ready-to-use ideas. Use short headings and numbered lists. When writing a content calendar, use a table with Day, Format, Topic and Hook. Never invent statistics.`;
}

/** Offline assistant: structured ideas without a language model. */
async function offlineReply(brand, text) {
  // "…about X" names the topic; otherwise talk about the brand itself.
  const about = text.match(/\b(?:about|on|for)\s+(?!the next\b|next\b|my\b|our\b|this\b)(.+?)(?:[.?!]|$)/i)?.[1];
  const t = about ? topicOf(about) : brand.industry || brand.description?.split(/[.,]/)[0] || brand.name;
  const lower = text.toLowerCase();
  if (/calendar|schedule|plan|week|month/.test(lower)) {
    const days = Math.min(14, Number((lower.match(/(\d+)\s*(day|week)/) || [])[1]) * (/week/.test(lower) ? 7 : 1) || 7);
    const topics = await planTopics(brand, { direction: t, count: days });
    const formats = ['Carousel', 'Reel', 'Single image', 'Quote', 'Carousel', 'Story', 'Meme'];
    return `## ${days}-day content calendar: ${titleCase(t)}\n\n| Day | Format | Topic | Hook |\n|---|---|---|---|\n${topics.map((tp, i) => `| ${i + 1} | ${formats[i % formats.length]} | ${tp} | ${['Stop scrolling if…', 'Nobody talks about this:', 'Save this for later 👇', 'The 30-second version:', 'Unpopular opinion:', 'Here is what changed for us:', 'Try this today:'][i % 7]} |`).join('\n')}\n\nTip: open each **Create** post with the topic as your prompt.`;
  }
  if (/headline|ad copy|ad idea|ads?\b|tagline|slogan/.test(lower)) {
    const n = Math.min(10, Number((lower.match(/\b(\d+)\b/) || [])[1]) || 5);
    const k = keywords(t, 2).join(' ') || t;
    const forms = [`The ${k} you'll actually use`, `Stop settling for average ${k}`, `${titleCase(k)}, without the hassle`, `Why people are switching to ${brand.name}`, `Your ${k} upgrade starts today`, `Finally: ${k} that fits your life`, `Less effort. Better ${k}.`, `Made for people who love ${k}`, `The smarter way to ${k}`, `See why ${k} fans love ${brand.name}`];
    return `## ${n} ad headlines for ${t}\n\n${forms.slice(0, n).map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\nPair each with a clear CTA such as **Shop now** or **Learn more**.`;
  }
  const n = Math.min(10, Number((lower.match(/\b(\d+)\b/) || [])[1]) || 5);
  const days = upcomingSpecialDays(new Date(), 2).map((d) => `${d.name} (${d.date})`).join(', ');
  const ideas = [
    ['Myth vs fact carousel', `Bust 3 common myths about ${t}.`],
    ['Behind the scenes reel', `Show how ${brand.name} approaches ${t}, start to finish.`],
    ['Quick-win tip', `One thing your audience can do today to improve at ${t}.`],
    ['Customer question', `Answer the question you hear most about ${t}.`],
    ['Before / after', `Contrast the old way vs the better way of ${t}.`],
    ['Checklist post', `A save-worthy checklist for ${t}.`],
    ['Poll story', `Ask followers how they handle ${t} and share results.`],
    ['Mistakes to avoid', `3 mistakes people make with ${t}, and the fix.`],
    ['Tool roundup', `Your favorite tools or products for ${t}.`],
    ['Seasonal tie-in', `Connect ${t} to an upcoming moment: ${days}.`],
  ];
  return `## ${n} post ideas: ${titleCase(t)}\n\n${ideas.slice(0, n).map(([h, b], i) => `${i + 1}. **${h}** — ${b}`).join('\n')}`;
}

router.get('/ideas/conversations', (req, res) => {
  const brand = brandFor(req);
  res.json(all('SELECT * FROM conversations WHERE brand_id = ? AND user_id = ? ORDER BY updated_at DESC', brand.id, req.user.id));
});

router.post('/ideas/conversations', (req, res) => {
  const brand = brandFor(req, 'editor');
  res.status(201).json(insert('conversations', { id: uuid(), brand_id: brand.id, user_id: req.user.id, title: String(req.body.title || 'New conversation').slice(0, 80) }));
});

function conv(req) {
  const brand = brandFor(req);
  const c = one('SELECT * FROM conversations WHERE id = ? AND brand_id = ? AND user_id = ?', req.params.id, brand.id, req.user.id);
  if (!c) throw new HttpError(404, 'Conversation not found.');
  return { brand, c };
}

router.get('/ideas/conversations/:id', (req, res) => {
  const { c } = conv(req);
  res.json({ ...c, messages: all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', c.id) });
});
router.patch('/ideas/conversations/:id', (req, res) => {
  const { c } = conv(req);
  run('UPDATE conversations SET title = ? WHERE id = ?', String(req.body.title || c.title).slice(0, 80), c.id);
  res.json({ ok: true });
});
router.post('/ideas/conversations/:id/clear', (req, res) => {
  const { c } = conv(req);
  run('DELETE FROM messages WHERE conversation_id = ?', c.id);
  res.json({ ok: true });
});
router.delete('/ideas/conversations/:id', (req, res) => {
  const { c } = conv(req);
  run('DELETE FROM conversations WHERE id = ?', c.id);
  res.json({ ok: true });
});

/** Send a message; the reply streams back as Server-Sent Events. */
router.post('/ideas/conversations/:id/messages', async (req, res) => {
  const { brand, c } = conv(req);
  const content = String(req.body.content || '').trim().slice(0, 4000);
  if (!content) throw new HttpError(400, 'Type a message.');
  charge(brand, CREDIT_COSTS.chat_message, 'idea_lab', c.id);
  insert('messages', { id: uuid(), conversation_id: c.id, role: 'user', content });
  if (c.title === 'New conversation') run('UPDATE conversations SET title = ? WHERE id = ?', content.slice(0, 60), c.id);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let reply = '';
  try {
    if (llmAvailable()) {
      const history = all('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid', c.id).slice(-30).map((m) => ({ role: m.role, content: m.content }));
      for await (const ev of streamChat({ system: systemPrompt(brand), messages: history, signal: abort.signal })) {
        if (ev.type === 'text') { reply += ev.text; send('delta', { text: ev.text }); }
      }
    } else {
      reply = await offlineReply(brand, content);
      for (const piece of reply.match(/[\s\S]{1,40}/g) || []) send('delta', { text: piece });
    }
    insert('messages', { id: uuid(), conversation_id: c.id, role: 'assistant', content: reply });
    run('UPDATE conversations SET words = words + ?, updated_at = ? WHERE id = ?', words(content) + words(reply), now(), c.id);
    send('done', { ok: true });
  } catch (e) {
    if (!abort.signal.aborted) send('error', { error: e.message });
  }
  res.end();
});
