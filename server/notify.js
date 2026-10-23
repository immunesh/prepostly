import { run, uuid } from './db.js';

/** Add an in-app notification for a user. */
export function notify(userId, brandId, kind, title, body = '', link = null) {
  if (!userId) return;
  run('INSERT INTO notifications (id, user_id, brand_id, kind, title, body, link) VALUES (?, ?, ?, ?, ?, ?, ?)', uuid(), userId, brandId, kind, title, String(body).slice(0, 500), link);
}
