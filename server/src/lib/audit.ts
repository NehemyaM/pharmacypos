import { getDb, nowIso } from '../db/index.js';

/** Record a sensitive action. Auditing must never break the business action. */
export function audit(
  userId: number | null,
  username: string,
  action: string,
  entity: string,
  entityId: number | null,
  details: string,
): void {
  try {
    getDb().prepare(
      `INSERT INTO audit_log (user_id, username, action, entity, entity_id, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(userId, username, action, entity, entityId, details, nowIso());
  } catch (err) {
    console.error('[audit] failed to write audit entry:', err);
  }
}
