import { desc, eq } from 'drizzle-orm';
import type { AnyDb } from '../db/index.js';
import { auditLog } from '../db/schema.js';

export class AuditLog {
  constructor(private db: AnyDb) {}

  async log(event: string, details: object = {}): Promise<void> {
    await this.db.insert(auditLog).values({ ts: new Date(), event, details });
  }

  async readAll(): Promise<Array<{ ts: Date; event: string; details: unknown }>> {
    const rows = await this.db.select().from(auditLog).orderBy(auditLog.id);
    return rows.map((r) => ({ ts: r.ts, event: r.event, details: r.details }));
  }

  async readByEvent(event: string): Promise<Array<{ ts: Date; event: string; details: unknown }>> {
    const rows = await this.db.select().from(auditLog).where(eq(auditLog.event, event)).orderBy(desc(auditLog.id));
    return rows.map((r) => ({ ts: r.ts, event: r.event, details: r.details }));
  }
}
