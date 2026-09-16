import { desc, gt, sql } from 'drizzle-orm';
import type { AnyDb } from '../../db/index.js';
import { auditLog, workLog } from '../../db/schema.js';

/** Which audit-log events represent real, observable work activity worth
 * surfacing in daily/weekly reporting — never invented, only ever a
 * relabeling of something that was actually logged as it happened. */
const WORK_EVENT_TYPES: Record<string, string> = {
  execution_task_selected: 'task_started',
  execution_pr_opened: 'pr_created',
  execution_pushed: 'branch_pushed',
  execution_checks_run: 'tests_run',
  pr_monitor_pushed_followup: 'pr_updated',
  pr_monitor_started: 'review_cycle',
  communication_sent_after_approval: 'message_sent',
  communication_auto_sent: 'message_sent',
};

/** Derives work_log rows from audit_log, idempotently (via the
 * source_audit_id watermark) — this is a projection, not a second source of
 * truth, so there's no way for it to drift into fabricating activity. */
export async function syncWorkLogFromAudit(db: AnyDb): Promise<number> {
  const maxRows = await db.select({ maxId: sql<number>`coalesce(max(${workLog.sourceAuditId}), 0)` }).from(workLog);
  const maxId = maxRows[0]?.maxId ?? 0;

  const newRows = await db
    .select()
    .from(auditLog)
    .where(gt(auditLog.id, maxId))
    .orderBy(auditLog.id);

  const toInsert = newRows
    .filter((row) => row.event in WORK_EVENT_TYPES)
    .map((row) => ({
      ts: row.ts,
      eventType: WORK_EVENT_TYPES[row.event]!,
      source: row.event,
      details: row.details,
      sourceAuditId: row.id,
    }));

  if (toInsert.length > 0) {
    await db.insert(workLog).values(toInsert);
  }
  return toInsert.length;
}

export async function recentWorkLog(db: AnyDb, limit = 200) {
  return db.select().from(workLog).orderBy(desc(workLog.id)).limit(limit);
}
