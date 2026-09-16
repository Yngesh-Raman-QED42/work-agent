import { describe, expect, it, afterEach } from 'vitest';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { Scheduler } from '../../src/scheduler/scheduler.js';
import { eq } from 'drizzle-orm';
import { scheduledJobs, jobRuns } from '../../src/db/schema.js';

let handle: TestDbHandle | null = null;
afterEach(async () => {
  await handle?.close();
  handle = null;
});

describe('Scheduler', () => {
  it('runs a newly-registered job immediately (due on first tick)', async () => {
    handle = await createTestDb();
    let runs = 0;
    const scheduler = new Scheduler(handle.db, [{ id: 'job-a', intervalMinutes: 60, run: async () => { runs++; } }]);
    const ran = await scheduler.tick();
    expect(ran).toEqual(['job-a']);
    expect(runs).toBe(1);
  });

  it('does not re-run a job before its interval elapses', async () => {
    handle = await createTestDb();
    let runs = 0;
    const scheduler = new Scheduler(handle.db, [{ id: 'job-a', intervalMinutes: 60, run: async () => { runs++; } }]);
    await scheduler.tick();
    const ranAgain = await scheduler.tick();
    expect(ranAgain).toEqual([]);
    expect(runs).toBe(1);
  });

  it('survives a "restart" — state is read from the DB, not memory', async () => {
    handle = await createTestDb();
    let runs = 0;
    const jobDef = { id: 'job-a', intervalMinutes: 60, run: async () => { runs++; } };

    const scheduler1 = new Scheduler(handle.db, [jobDef]);
    await scheduler1.tick();

    // A brand-new Scheduler instance, as if the process restarted.
    const scheduler2 = new Scheduler(handle.db, [jobDef]);
    const ranAgain = await scheduler2.tick();
    expect(ranAgain).toEqual([]); // still not due — persisted nextRunAt survived
    expect(runs).toBe(1);
  });

  it('records a job_runs row with success status', async () => {
    handle = await createTestDb();
    const scheduler = new Scheduler(handle.db, [{ id: 'job-a', intervalMinutes: 60, run: async () => {} }]);
    await scheduler.tick();
    const runs = await handle.db.select().from(jobRuns).where(eq(jobRuns.jobId, 'job-a'));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('success');
  });

  it('records a failed job_runs row when the job throws, and still reschedules it', async () => {
    handle = await createTestDb();
    const scheduler = new Scheduler(handle.db, [
      { id: 'job-a', intervalMinutes: 60, run: async () => { throw new Error('boom'); } },
    ]);
    await scheduler.tick();
    const runs = await handle.db.select().from(jobRuns).where(eq(jobRuns.jobId, 'job-a'));
    expect(runs[0]!.status).toBe('failed');

    const jobs = await handle.db.select().from(scheduledJobs).where(eq(scheduledJobs.id, 'job-a'));
    expect(jobs[0]!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('a disabled job never runs', async () => {
    handle = await createTestDb();
    let runs = 0;
    const scheduler = new Scheduler(handle.db, [{ id: 'job-a', intervalMinutes: 60, run: async () => { runs++; } }]);
    await scheduler.ensureRegistered();
    await handle.db.update(scheduledJobs).set({ enabled: false }).where(eq(scheduledJobs.id, 'job-a'));
    await scheduler.tick();
    expect(runs).toBe(0);
  });
});
