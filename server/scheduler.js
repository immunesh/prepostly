import { one, all, run, now, json } from './db.js';
import { config } from './config.js';
import { PLATFORMS } from './catalog.js';
import { publishTarget, syncMetrics } from './publishers/index.js';
import { runDueAutopilots } from './engines/autopilot.js';
import { notify } from './notify.js';

// Background worker: publishes due posts, retries transient failures with backoff, tops up
// auto-posting queues and refreshes engagement metrics.

const MAX_ATTEMPTS = 3;
let timer = null;
let running = false;
let lastMetrics = 0;

/** Recompute a job's status from its targets. */
export function finalizeJob(jobId) {
  const targets = all('SELECT status FROM publish_targets WHERE job_id = ?', jobId);
  if (!targets.length) return;
  const count = (s) => targets.filter((t) => t.status === s).length;
  let status;
  if (count('pending') || count('publishing')) status = count('published') || count('failed') ? 'publishing' : null;
  else if (count('published') === targets.length) status = 'published';
  else if (count('failed') === targets.length) status = 'failed';
  else status = 'partial';
  if (status) run('UPDATE publish_jobs SET status = ?, updated_at = ? WHERE id = ?', status, now(), jobId);
  return status;
}

async function publishOne(target) {
  run("UPDATE publish_targets SET status = 'publishing', attempts = attempts + 1 WHERE id = ?", target.id);
  const job = one('SELECT * FROM publish_jobs WHERE id = ?', target.job_id);
  try {
    const r = await publishTarget(target.id);
    run("UPDATE publish_targets SET status = 'published', external_id = ?, url = ?, error = ?, published_at = ?, next_attempt_at = NULL WHERE id = ?", r.external_id || null, r.url || null, r.note || null, now(), target.id);
  } catch (e) {
    const attempts = target.attempts + 1;
    if (e.retryable && attempts < MAX_ATTEMPTS) {
      const wait = 60000 * 2 ** (attempts - 1);
      run("UPDATE publish_targets SET status = 'pending', error = ?, next_attempt_at = ? WHERE id = ?", e.message.slice(0, 500), new Date(Date.now() + (config.isTest ? 0 : wait)).toISOString(), target.id);
    } else {
      run("UPDATE publish_targets SET status = 'failed', error = ?, next_attempt_at = NULL WHERE id = ?", e.message.slice(0, 500), target.id);
      const acc = one('SELECT platform, name FROM social_accounts WHERE id = ?', target.account_id);
      notify(job.created_by, job.brand_id, 'publish_failed', `Couldn't publish to ${acc ? `${PLATFORMS[acc.platform]?.label} (${acc.name})` : 'a channel'}`, e.message, `/app/calendar?job=${job.id}`);
    }
  }
  finalizeJob(target.job_id);
}

/** Publish every due target (optionally only one job's). */
export async function publishDue({ jobId } = {}) {
  const ts = now();
  // Posts that failed to generate can never publish.
  for (const t of all(`SELECT t.id, t.job_id FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id JOIN posts p ON p.id = j.post_id
    WHERE t.status = 'pending' AND p.status = 'failed' AND j.status IN ('scheduled','publishing')`)) {
    run("UPDATE publish_targets SET status = 'failed', error = 'The post failed to generate.' WHERE id = ?", t.id);
    finalizeJob(t.job_id);
  }
  const due = all(`SELECT t.* FROM publish_targets t JOIN publish_jobs j ON j.id = t.job_id JOIN posts p ON p.id = j.post_id
    WHERE t.status = 'pending' AND j.status IN ('scheduled','publishing') AND j.scheduled_at <= ? AND p.status = 'ready'
      AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?) ${jobId ? 'AND j.id = ?' : ''}
    ORDER BY j.scheduled_at LIMIT 50`, ts, ts, ...(jobId ? [jobId] : []));
  for (const t of due) await publishOne(t);
  return due.length;
}

export async function tick() {
  if (running) return;
  running = true;
  try {
    await publishDue();
    await runDueAutopilots().catch((e) => console.error('[autopilot]', e.message));
    if (Date.now() - lastMetrics > 3600e3) {
      lastMetrics = Date.now();
      syncMetrics().catch((e) => console.error('[metrics]', e.message));
    }
  } catch (e) {
    console.error('[scheduler]', e);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  // Targets interrupted mid-publish by a restart go back to the queue.
  run("UPDATE publish_targets SET status = 'pending' WHERE status = 'publishing'");
  if (!config.schedulerEnabled || timer) return;
  timer = setInterval(tick, config.schedulerIntervalMs);
  timer.unref();
  setTimeout(tick, 1000).unref();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}

export const jobOptions = (job) => json(job.options, {});
