import { eq } from 'drizzle-orm';
import type { AnyDb } from '../db/index.js';
import { scheduledJobs, jobRuns } from '../db/schema.js';

export interface JobDefinition {
  id: string;
  intervalMinutes: number;
  run: () => Promise<void>;
}

/**
 * Persisted, restart-safe job scheduler. Due-ness is computed entirely from
 * `scheduled_jobs.next_run_at` in the database, never from in-memory state
 * — so a process restart just picks up wherever the persisted state says,
 * per "persist state so the agent can recover after a restart." This class
 * only defines *how* jobs get run; nothing here starts an unattended loop —
 * see runner.ts, which the operator (i.e. you) runs deliberately when
 * ready.
 */
export class Scheduler {
  constructor(
    private db: AnyDb,
    private jobs: JobDefinition[],
  ) {}

  async ensureRegistered(): Promise<void> {
    for (const job of this.jobs) {
      const existing = await this.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, job.id));
      if (existing.length === 0) {
        await this.db.insert(scheduledJobs).values({
          id: job.id,
          intervalMinutes: String(job.intervalMinutes),
          enabled: true,
          nextRunAt: new Date(), // due immediately on first registration
        });
      }
    }
  }

  /** Runs whatever is currently due and reschedules it. Safe to call
   * repeatedly, from a fresh process, at any cadence — it will simply be a
   * no-op for anything not yet due. Returns the ids of jobs that ran. */
  async tick(): Promise<string[]> {
    await this.ensureRegistered();
    const ran: string[] = [];
    const rows = await this.db.select().from(scheduledJobs);
    const now = new Date();

    for (const row of rows) {
      if (!row.enabled) continue;
      if (row.nextRunAt > now) continue;
      const job = this.jobs.find((j) => j.id === row.id);
      if (!job) continue;

      const [runRow] = await this.db.insert(jobRuns).values({ jobId: job.id, startedAt: now, status: 'running' }).returning();

      try {
        await job.run();
        await this.db.update(jobRuns).set({ status: 'success', finishedAt: new Date() }).where(eq(jobRuns.id, runRow!.id));
      } catch (err) {
        await this.db
          .update(jobRuns)
          .set({ status: 'failed', finishedAt: new Date(), details: { error: String(err) } })
          .where(eq(jobRuns.id, runRow!.id));
      }

      const nextRunAt = new Date(Date.now() + job.intervalMinutes * 60_000);
      await this.db.update(scheduledJobs).set({ lastRunAt: now, nextRunAt }).where(eq(scheduledJobs.id, job.id));
      ran.push(job.id);
    }

    return ran;
  }
}
