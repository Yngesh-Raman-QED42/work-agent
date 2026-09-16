import { eq } from 'drizzle-orm';
import type { AnyDb } from '../db/index.js';
import { approvals } from '../db/schema.js';

export type RiskLevel = 'low' | 'medium' | 'high';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalInput {
  id: string;
  source: string; // "observation" | "engineering_execution" | "pr_monitoring" | "communication" | "task_intelligence"
  action: string;
  target: string;
  targetUrl?: string | null;
  context: Record<string, unknown>;
  reasoning: string;
  riskLevel: RiskLevel;
  consequenceIfApproved: string;
  recommendedAction: string;
}

export interface ApprovalRow extends ApprovalInput {
  status: ApprovalStatus;
  createdAt: Date;
  resolvedAt: Date | null;
}

/**
 * The single Human Approval queue, shared by every agent. An approval is
 * something that genuinely requires human judgment — low-risk autonomous
 * work never touches this table except to log that it happened elsewhere
 * (the audit log), per "low-risk autonomous work should be invisible from a
 * supervision perspective except for logging and summaries."
 */
export class ApprovalsStore {
  constructor(private db: AnyDb) {}

  /** Upsert — re-filing the same id (e.g. the same PR still needing review)
   * just refreshes it rather than duplicating. */
  async file(entry: ApprovalInput): Promise<void> {
    const row = { ...entry, targetUrl: entry.targetUrl ?? null, status: 'pending' as const, createdAt: new Date(), resolvedAt: null };
    await this.db
      .insert(approvals)
      .values(row)
      .onConflictDoUpdate({
        target: approvals.id,
        set: { ...row },
      });
  }

  async fileMany(entries: ApprovalInput[]): Promise<void> {
    for (const entry of entries) await this.file(entry);
  }

  async listPending(): Promise<ApprovalRow[]> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.status, 'pending'));
    return rows as ApprovalRow[];
  }

  async listBySource(source: string): Promise<ApprovalRow[]> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.source, source));
    return rows as ApprovalRow[];
  }

  async resolve(id: string, status: 'approved' | 'rejected'): Promise<void> {
    await this.db.update(approvals).set({ status, resolvedAt: new Date() }).where(eq(approvals.id, id));
  }

  async get(id: string): Promise<ApprovalRow | undefined> {
    const rows = await this.db.select().from(approvals).where(eq(approvals.id, id));
    return rows[0] as ApprovalRow | undefined;
  }
}
