import { Router } from 'express';
import { one, all, run, uuid, now, insert, json, tx } from '../db.js';
import { HttpError, requireUser, brandFor, atLeast } from '../auth.js';
import { PLATFORMS } from '../catalog.js';
import { publishDue, finalizeJob } from '../scheduler.js';
import { suggestTimes, zonedParts, zonedToUtc } from '../engines/besttime.js';
import { weeklySlots } from '../engines/autopilot.js';
import { notify } from '../notify.js';

export const router = Router();
router.use(requireUser);

const EDITABLE = ['draft', 'in_review', 'rejected', 'scheduled', 'failed', 'partial'];

export function jobDetail(job) {
  const post = one('SELECT id, title, type, media_type, format, cover, caption, hashtags, status, media FROM posts WHERE id = ?', job.post_id);
  const targets = all('SELECT t.*, a.platform, a.name AS account_name, a.username, a.avatar, a.status AS account_status FROM publish_targets t JOIN social_accounts a ON a.id = t.account_id WHERE t.job_id = ? ORDER BY a.platform', job.id);
  return { ...job, options: json(job.options, {}), reviewers: json(job.reviewers, []), post: post && { ...post, media: json(post.media, []) }, targets };
}

function loadJob(req, min) {
  const brand = brandFor(req, min);
  const job = one('SELECT * FROM publish_jobs WHERE id = ? AND brand_id = ?', req.params.id, brand.id);
  if (!job) throw new HttpError(404, 'Scheduled post not found.');
  return { brand, job };
}

function mediaKind(post) {
  const media = json(post.media, []);
  return media.some((m) => m.kind === 'video') ? 'video' : media.filter((m) => m.kind === 'image').length > 1 ? 'carousel' : 'image';
}

function validAccounts(brand, ids, post) {
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'Choose at least one channel.');
  const kind = mediaKind(post);
  return [...new Set(ids)].map((id) => {
    const a = one('SELECT * FROM social_accounts WHERE id = ? AND brand_id = ?', id, brand.id);
    if (!a) throw new HttpError(404, 'One of the chosen channels was not found.');
    if (!PLATFORMS[a.platform].media.includes(kind)) throw new HttpError(400, `${PLATFORMS[a.platform].label} does not support ${kind} posts.`);
    return a;
  });
}

/**
 * Publish now, schedule, send for review, or save as a draft.
 * body: { post_id, account_ids[], mode: now|schedule|review|draft, scheduled_at, caption, options, reviewers[] }
 */
router.post('/publish', async (req, res) => {
  const brand = brandFor(req, 'editor');
  const post = one('SELECT * FROM posts WHERE id = ? AND brand_id = ?', req.body.post_id, brand.id);
  if (!post) throw new HttpError(404, 'Post not found.');
  if (post.status !== 'ready') throw new HttpError(409, 'This post is not ready yet.');
  let mode = req.body.mode || 'schedule';
  if (!['now', 'schedule', 'review', 'draft'].includes(mode)) throw new HttpError(400, 'mode must be now, schedule, review or draft.');
  const settings = json(brand.settings, {});
  // Brands can require approval for editors.
  if (settings.require_approval && req.role === 'editor' && (mode === 'now' || mode === 'schedule')) mode = 'review';
  const accounts = validAccounts(brand, req.body.account_ids, post);
  let scheduledAt = now();
  if (mode !== 'now') {
    const t = new Date(req.body.scheduled_at || Date.now() + 3600e3);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'Invalid schedule time.');
    if (mode === 'schedule' && t.getTime() < Date.now() - 60000) throw new HttpError(400, 'This post can\'t be scheduled in the past. To send it now, choose "Publish now".');
    scheduledAt = t.toISOString();
  }
  let reviewers = [];
  if (mode === 'review') {
    reviewers = (req.body.reviewers?.length ? req.body.reviewers : all("SELECT user_id FROM brand_members WHERE brand_id = ? AND role IN ('owner','admin','reviewer') AND user_id != ?", brand.id, req.user.id).map((r) => r.user_id));
    for (const r of reviewers) if (!one("SELECT 1 FROM brand_members WHERE brand_id = ? AND user_id = ? AND role IN ('owner','admin','reviewer')", brand.id, r)) throw new HttpError(400, 'Reviewers must be owners, admins or reviewers on this brand.');
    if (!reviewers.length) throw new HttpError(400, 'Invite a teammate with the reviewer or admin role to use approvals.');
  }
  const jobId = uuid();
  const status = { now: 'scheduled', schedule: 'scheduled', review: 'in_review', draft: 'draft' }[mode];
  insert('publish_jobs', { id: jobId, post_id: post.id, brand_id: brand.id, created_by: req.user.id, status, scheduled_at: scheduledAt, caption: req.body.caption ?? post.caption, options: req.body.options || {}, reviewers });
  const captions = req.body.captions || {};
  for (const a of accounts) insert('publish_targets', { id: uuid(), job_id: jobId, account_id: a.id, status: 'pending', caption: captions[a.platform] ?? null });
  if (mode === 'review') for (const r of reviewers) notify(r, brand.id, 'review_requested', `${req.user.name} asked you to approve a post`, post.title, `/app/calendar?job=${jobId}`);
  if (mode === 'now') await publishDue({ jobId });
  res.status(201).json(jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', jobId)));
});

/**
 * Spread several posts over a recurring schedule, one post per slot in the order given.
 * body: { post_ids[], account_ids[], days[0-6], times[HH:MM], start: YYYY-MM-DD, weeks: 1-12, mode: schedule|review|draft, include_hashtags }
 * Days, times and start are in the brand's timezone. Slots that already have a post are skipped.
 */
router.post('/publish/bulk', (req, res) => {
  const brand = brandFor(req, 'editor');
  const b = req.body;
  if (!Array.isArray(b.post_ids) || !b.post_ids.length) throw new HttpError(400, 'Pick at least one post.');
  if (b.post_ids.length > 100) throw new HttpError(400, 'You can schedule up to 100 posts at a time.');
  const posts = [...new Set(b.post_ids)].map((id) => {
    const p = one('SELECT * FROM posts WHERE id = ? AND brand_id = ?', id, brand.id);
    if (!p) throw new HttpError(404, 'One of the chosen posts was not found.');
    if (p.status !== 'ready') throw new HttpError(409, `"${p.title}" is not ready yet.`);
    return p;
  });
  if (!Array.isArray(b.account_ids) || !b.account_ids.length) throw new HttpError(400, 'Choose at least one channel.');
  const accounts = [...new Set(b.account_ids)].map((id) => {
    const a = one('SELECT * FROM social_accounts WHERE id = ? AND brand_id = ?', id, brand.id);
    if (!a) throw new HttpError(404, 'One of the chosen channels was not found.');
    return a;
  });
  const targets = posts.map((p) => {
    const kind = mediaKind(p);
    const fit = accounts.filter((a) => PLATFORMS[a.platform].media.includes(kind));
    if (!fit.length) throw new HttpError(400, `None of the chosen channels can post "${p.title}" (${kind}).`);
    return fit;
  });
  if (!Array.isArray(b.days) || !b.days.length || b.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new HttpError(400, 'Pick at least one weekday.');
  if (!Array.isArray(b.times) || !b.times.length || b.times.length > 4 || b.times.some((t) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) throw new HttpError(400, 'Pick 1 to 4 posting times (HH:MM).');
  const weeks = Number(b.weeks || 4);
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 12) throw new HttpError(400, 'Choose between 1 and 12 weeks.');
  const tz = brand.timezone || 'UTC';
  const start = b.start || zonedParts(new Date(), tz).day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(new Date(start).getTime())) throw new HttpError(400, 'Invalid start date.');
  const startAt = new Date(zonedToUtc(start, '00:00', tz));
  const from = new Date(Math.max(startAt.getTime(), Date.now() + 5 * 60000));
  const to = new Date(startAt.getTime() + weeks * 7 * 864e5);
  const taken = new Set(all("SELECT scheduled_at FROM publish_jobs WHERE brand_id = ? AND scheduled_at >= ? AND scheduled_at <= ? AND status NOT IN ('discarded','rejected','failed')", brand.id, from.toISOString(), to.toISOString()).map((r) => r.scheduled_at));
  const slots = weeklySlots({ days: b.days, times: b.times, tz, from, to }).filter((s) => !taken.has(s));
  if (slots.length < posts.length) throw new HttpError(400, `${posts.length} posts need ${posts.length} time slots, but this schedule has ${slots.length} free in ${weeks} week${weeks > 1 ? 's' : ''}. Add days, times or weeks.`, 'not_enough_slots');

  let mode = b.mode || 'schedule';
  if (!['schedule', 'review', 'draft'].includes(mode)) throw new HttpError(400, 'mode must be schedule, review or draft.');
  if (json(brand.settings, {}).require_approval && req.role === 'editor' && mode === 'schedule') mode = 'review';
  const reviewers = mode === 'review' ? all("SELECT user_id FROM brand_members WHERE brand_id = ? AND role IN ('owner','admin','reviewer') AND user_id != ?", brand.id, req.user.id).map((r) => r.user_id) : [];
  if (mode === 'review' && !reviewers.length) throw new HttpError(400, 'Invite a teammate with the reviewer or admin role to use approvals.');
  const status = { schedule: 'scheduled', review: 'in_review', draft: 'draft' }[mode];

  const ids = tx(() => posts.map((p, i) => {
    const jobId = uuid();
    insert('publish_jobs', { id: jobId, post_id: p.id, brand_id: brand.id, created_by: req.user.id, status, scheduled_at: slots[i], caption: p.caption, options: { include_hashtags: b.include_hashtags !== false }, reviewers });
    for (const a of targets[i]) insert('publish_targets', { id: uuid(), job_id: jobId, account_id: a.id, status: 'pending' });
    return jobId;
  }));
  if (mode === 'review') for (const r of reviewers) notify(r, brand.id, 'review_requested', `${req.user.name} asked you to approve ${ids.length} posts`, `Scheduled from ${slots[0].slice(0, 10)} to ${slots[ids.length - 1].slice(0, 10)}.`, '/app/calendar');
  res.status(201).json({ count: ids.length, status, jobs: ids.map((id) => jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', id))) });
});

/** Calendar: jobs in a time window. */
router.get('/jobs', (req, res) => {
  const brand = brandFor(req);
  const from = req.query.from || new Date(Date.now() - 31 * 864e5).toISOString();
  const to = req.query.to || new Date(Date.now() + 62 * 864e5).toISOString();
  const status = req.query.status ? String(req.query.status).split(',') : null;
  const rows = all(`SELECT * FROM publish_jobs WHERE brand_id = ? AND scheduled_at >= ? AND scheduled_at < ? ${status ? `AND status IN (${status.map(() => '?').join(',')})` : "AND status != 'discarded'"} ORDER BY scheduled_at`, brand.id, from, to, ...(status || []));
  res.json(rows.map(jobDetail));
});

router.get('/review-queue', (req, res) => {
  const brand = brandFor(req);
  res.json(all("SELECT * FROM publish_jobs WHERE brand_id = ? AND status = 'in_review' ORDER BY scheduled_at", brand.id).map(jobDetail));
});

router.get('/best-times', (req, res) => {
  const brand = brandFor(req);
  res.json({ timezone: brand.timezone, suggestions: suggestTimes(brand, { count: Number(req.query.count) || 3 }) });
});

router.get('/jobs/:id', (req, res) => {
  const { job } = loadJob(req);
  res.json({ ...jobDetail(job), comments: all('SELECT c.*, u.name AS user_name FROM comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.job_id = ? ORDER BY c.created_at', job.id) });
});

router.patch('/jobs/:id', (req, res) => {
  const { brand, job } = loadJob(req, 'editor');
  if (!EDITABLE.includes(job.status)) throw new HttpError(409, `A ${job.status} post can't be edited.`);
  if (job.status === 'scheduled' && new Date(job.scheduled_at).getTime() - Date.now() < 2 * 60000) throw new HttpError(409, "You can't edit this post because it is about to be published. Discard it and reschedule.");
  if (req.body.scheduled_at) {
    const t = new Date(req.body.scheduled_at);
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'Invalid schedule time.');
    if (t.getTime() < Date.now() - 60000 && job.status !== 'draft') throw new HttpError(400, "This post can't be scheduled in the past.");
    run('UPDATE publish_jobs SET scheduled_at = ?, updated_at = ? WHERE id = ?', t.toISOString(), now(), job.id);
  }
  if (req.body.caption !== undefined) run('UPDATE publish_jobs SET caption = ?, updated_at = ? WHERE id = ?', String(req.body.caption), now(), job.id);
  if (req.body.options !== undefined) run('UPDATE publish_jobs SET options = ? WHERE id = ?', JSON.stringify(req.body.options || {}), job.id);
  if (req.body.account_ids) {
    const post = one('SELECT * FROM posts WHERE id = ?', job.post_id);
    const accounts = validAccounts(brand, req.body.account_ids, post);
    run("DELETE FROM publish_targets WHERE job_id = ? AND status != 'published'", job.id);
    for (const a of accounts) if (!one('SELECT 1 FROM publish_targets WHERE job_id = ? AND account_id = ?', job.id, a.id)) insert('publish_targets', { id: uuid(), job_id: job.id, account_id: a.id, status: 'pending' });
  }
  if (req.body.status === 'scheduled' && job.status === 'draft') {
    const settings = json(brand.settings, {});
    run('UPDATE publish_jobs SET status = ? WHERE id = ?', settings.require_approval && req.role === 'editor' ? 'in_review' : 'scheduled', job.id);
  }
  res.json(jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', job.id)));
});

router.post('/jobs/:id/discard', (req, res) => {
  const { job } = loadJob(req, 'editor');
  if (job.status === 'published') throw new HttpError(409, 'Published posts cannot be discarded.');
  if (req.body?.account_id) {
    run("DELETE FROM publish_targets WHERE job_id = ? AND account_id = ? AND status != 'published'", job.id, req.body.account_id);
    if (!one('SELECT 1 FROM publish_targets WHERE job_id = ?', job.id)) run("UPDATE publish_jobs SET status = 'discarded', updated_at = ? WHERE id = ?", now(), job.id);
    else finalizeJob(job.id);
  } else {
    run("UPDATE publish_jobs SET status = 'discarded', updated_at = ? WHERE id = ?", now(), job.id);
  }
  res.json({ ok: true });
});

function review(action) {
  return (req, res) => {
    const { brand, job } = loadJob(req, 'reviewer');
    if (job.status !== 'in_review') throw new HttpError(409, 'This post is not waiting for review.');
    if (job.created_by === req.user.id && !atLeast(req.role, 'admin')) throw new HttpError(403, "You can't approve your own post.");
    const note = String(req.body?.note || '').slice(0, 2000);
    const status = action === 'approve' ? 'scheduled' : 'rejected';
    run('UPDATE publish_jobs SET status = ?, review_note = ?, reviewed_by = ?, updated_at = ? WHERE id = ?', status, note || null, req.user.id, now(), job.id);
    // Approved posts whose time already passed go out on the next scheduler tick.
    if (note || action === 'reject') run('INSERT INTO comments (id, job_id, user_id, body, action) VALUES (?, ?, ?, ?, ?)', uuid(), job.id, req.user.id, note || 'Rejected', action);
    const post = one('SELECT title FROM posts WHERE id = ?', job.post_id);
    notify(job.created_by, brand.id, action === 'approve' ? 'post_approved' : 'post_rejected', `${req.user.name} ${action === 'approve' ? 'approved' : 'rejected'} your post`, note || post?.title || '', `/app/calendar?job=${job.id}`);
    res.json(jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', job.id)));
  };
}
router.post('/jobs/:id/approve', review('approve'));
router.post('/jobs/:id/reject', review('reject'));

router.post('/jobs/:id/comments', (req, res) => {
  const { job } = loadJob(req, 'reviewer');
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(400, 'Write a comment.');
  const row = insert('comments', { id: uuid(), job_id: job.id, user_id: req.user.id, body: body.slice(0, 2000) });
  res.status(201).json({ ...row, user_name: req.user.name });
});

/** Resubmit a rejected post for review after edits. */
router.post('/jobs/:id/resubmit', (req, res) => {
  const { job } = loadJob(req, 'editor');
  if (job.status !== 'rejected') throw new HttpError(409, 'Only rejected posts can be resubmitted.');
  run("UPDATE publish_jobs SET status = 'in_review', updated_at = ? WHERE id = ?", now(), job.id);
  for (const r of json(job.reviewers, [])) notify(r, job.brand_id, 'review_requested', `${req.user.name} resubmitted a post for approval`, '', `/app/calendar?job=${job.id}`);
  res.json(jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', job.id)));
});

/** Retry failed targets now. */
router.post('/jobs/:id/retry', async (req, res) => {
  const { job } = loadJob(req, 'editor');
  const n = run("UPDATE publish_targets SET status = 'pending', attempts = 0, error = NULL, next_attempt_at = NULL WHERE job_id = ? AND status = 'failed'", job.id).changes;
  if (!n) throw new HttpError(409, 'Nothing to retry.');
  run("UPDATE publish_jobs SET status = 'scheduled', scheduled_at = CASE WHEN scheduled_at > ? THEN scheduled_at ELSE ? END WHERE id = ?", now(), now(), job.id);
  await publishDue({ jobId: job.id });
  res.json(jobDetail(one('SELECT * FROM publish_jobs WHERE id = ?', job.id)));
});

