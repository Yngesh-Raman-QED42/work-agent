import { pgTable, text, timestamp, jsonb, serial, boolean, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ---------------------------------------------------------------------------
// Observation (Phase 1)
// ---------------------------------------------------------------------------

export const workItems = pgTable(
  'work_items',
  {
    id: text('id').primaryKey(),
    category: text('category').notNull(),
    urgency: text('urgency').notNull(),
    jiraKey: text('jira_key'),
    jira: jsonb('jira'),
    prs: jsonb('prs').notNull(),
    slackMessages: jsonb('slack_messages').notNull(),
    reasons: jsonb('reasons').notNull(),
    firstSeenAt: ts('first_seen_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('work_items_jira_key_idx').on(table.jiraKey)],
);

export const briefings = pgTable('briefings', {
  id: serial('id').primaryKey(),
  kind: text('kind').notNull().default('daily'), // "daily" | "end_of_day" | "weekly"
  runDate: text('run_date').notNull(),
  content: text('content').notNull(),
  createdAt: ts('created_at').notNull(),
}, (table) => [uniqueIndex('briefings_kind_date_idx').on(table.kind, table.runDate)]);

// ---------------------------------------------------------------------------
// Audit log — append-only, spans every subsystem
// ---------------------------------------------------------------------------

export const auditLog = pgTable(
  'audit_log',
  {
    id: serial('id').primaryKey(),
    ts: ts('ts').notNull(),
    event: text('event').notNull(),
    details: jsonb('details').notNull(),
  },
  (table) => [index('audit_log_event_idx').on(table.event)],
);

// ---------------------------------------------------------------------------
// Human Approval — first-class, unified across every agent. Every entry
// carries what the spec requires: context, proposed action, reasoning, risk
// level, consequence if approved, and a recommended action.
// ---------------------------------------------------------------------------

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(), // "observation" | "engineering_execution" | "pr_monitoring" | "communication" | "task_intelligence"
    action: text('action').notNull(),
    target: text('target').notNull(),
    targetUrl: text('target_url'),
    context: jsonb('context').notNull(),
    reasoning: text('reasoning').notNull(),
    riskLevel: text('risk_level').notNull(), // "low" | "medium" | "high"
    consequenceIfApproved: text('consequence_if_approved').notNull(),
    recommendedAction: text('recommended_action').notNull(),
    status: text('status').notNull(), // "pending" | "approved" | "rejected"
    createdAt: ts('created_at').notNull(),
    resolvedAt: ts('resolved_at'),
  },
  (table) => [index('approvals_status_idx').on(table.status)],
);

// ---------------------------------------------------------------------------
// Engineering Execution (Phase 2) — isolated context per task
// ---------------------------------------------------------------------------

export const executionTasks = pgTable(
  'execution_tasks',
  {
    id: text('id').primaryKey(), // Jira key when there is one, else a generated id
    jiraKey: text('jira_key'),
    repo: text('repo').notNull(), // "owner/repo"
    branch: text('branch'),
    worktreePath: text('worktree_path'),
    status: text('status').notNull(), // "selected"|"implementing"|"checking"|"gated_stop"|"pr_opened"|"monitoring"|"done"|"failed"
    sessionInfo: jsonb('session_info'),
    validationStatus: jsonb('validation_status'),
    prUrl: text('pr_url'),
    createdAt: ts('created_at').notNull(),
    updatedAt: ts('updated_at').notNull(),
  },
  (table) => [index('execution_tasks_status_idx').on(table.status)],
);

// ---------------------------------------------------------------------------
// Work Log — actual observed events only, never fabricated
// ---------------------------------------------------------------------------

export const workLog = pgTable(
  'work_log',
  {
    id: serial('id').primaryKey(),
    ts: ts('ts').notNull(),
    eventType: text('event_type').notNull(),
    source: text('source').notNull(),
    details: jsonb('details').notNull(),
    // Watermark for deriving work_log from audit_log idempotently — see
    // agents/workLog/sync.ts. Not a foreign key on purpose: audit_log rows
    // are never deleted, but this stays robust even if that changes.
    sourceAuditId: integer('source_audit_id').notNull(),
  },
  (table) => [index('work_log_event_type_idx').on(table.eventType), uniqueIndex('work_log_source_audit_id_idx').on(table.sourceAuditId)],
);

// ---------------------------------------------------------------------------
// Manual time entries — the ONLY source of hours in this system. Work Log
// records WHAT happened and WHEN (from real events); it never records HOW
// LONG anything took, because nothing observes that. This table is a human
// deliberately telling the system a real number, against a real day and
// (optionally) a real ticket — closing the loop so Weekly Summary can
// produce an actual timesheet-ready figure without ever inventing one.
// ---------------------------------------------------------------------------

export const manualTimeEntries = pgTable(
  'manual_time_entries',
  {
    id: serial('id').primaryKey(),
    date: text('date').notNull(), // YYYY-MM-DD, the day the work was done
    jiraKey: text('jira_key'), // optional — not every logged hour maps to one ticket
    minutes: integer('minutes').notNull(),
    note: text('note'),
    loggedAt: ts('logged_at').notNull(), // when the entry was recorded, not the day worked
  },
  (table) => [index('manual_time_entries_date_idx').on(table.date)],
);

// ---------------------------------------------------------------------------
// Work Memory — facts observed from systems vs. AI-generated conclusions,
// each with a timestamp and source reference.
// ---------------------------------------------------------------------------

export const memoryFacts = pgTable(
  'memory_facts',
  {
    id: serial('id').primaryKey(),
    kind: text('kind').notNull(), // "fact" | "conclusion"
    subject: text('subject').notNull(), // e.g. a Jira key, "pr:org/repo#12", "slack:C1:169..."
    content: jsonb('content').notNull(),
    sourceSystem: text('source_system').notNull(), // "jira" | "github" | "slack" | "ai"
    sourceRef: text('source_ref'),
    observedAt: ts('observed_at').notNull(),
  },
  (table) => [index('memory_facts_subject_idx').on(table.subject)],
);

// ---------------------------------------------------------------------------
// Slack Intelligence — only classified-relevant signals are kept; the rest
// (informational/irrelevant noise) is deliberately not persisted.
// ---------------------------------------------------------------------------

export const slackSignals = pgTable('slack_signals', {
  id: text('id').primaryKey(), // "<channel>:<ts>"
  channel: text('channel').notNull(),
  channelName: text('channel_name').notNull(),
  threadTs: text('thread_ts'),
  category: text('category').notNull(),
  text: text('text').notNull(),
  linkedJiraKey: text('linked_jira_key'),
  createdAt: ts('created_at').notNull(),
});

// ---------------------------------------------------------------------------
// Scheduling — persisted so the agent can recover after a restart
// ---------------------------------------------------------------------------

export const scheduledJobs = pgTable('scheduled_jobs', {
  id: text('id').primaryKey(), // "morning_briefing" | "pr_monitor" | "end_of_day" | "weekly_summary"
  intervalMinutes: text('interval_minutes').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  lastRunAt: ts('last_run_at'),
  nextRunAt: ts('next_run_at').notNull(),
});

export const jobRuns = pgTable(
  'job_runs',
  {
    id: serial('id').primaryKey(),
    jobId: text('job_id').notNull(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    status: text('status').notNull(), // "running" | "success" | "failed"
    details: jsonb('details'),
  },
  (table) => [index('job_runs_job_id_idx').on(table.jobId)],
);
