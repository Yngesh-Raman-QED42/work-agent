CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"target_url" text,
	"context" jsonb NOT NULL,
	"reasoning" text NOT NULL,
	"risk_level" text NOT NULL,
	"consequence_if_approved" text NOT NULL,
	"recommended_action" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"event" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefings" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'daily' NOT NULL,
	"run_date" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "execution_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"jira_key" text,
	"repo" text NOT NULL,
	"branch" text,
	"worktree_path" text,
	"status" text NOT NULL,
	"session_info" jsonb,
	"validation_status" jsonb,
	"pr_url" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "memory_facts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"content" jsonb NOT NULL,
	"source_system" text NOT NULL,
	"source_ref" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"interval_minutes" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slack_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"channel_name" text NOT NULL,
	"thread_ts" text,
	"category" text NOT NULL,
	"text" text NOT NULL,
	"linked_jira_key" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"urgency" text NOT NULL,
	"jira_key" text,
	"jira" jsonb,
	"prs" jsonb NOT NULL,
	"slack_messages" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"event_type" text NOT NULL,
	"source" text NOT NULL,
	"details" jsonb NOT NULL,
	"source_audit_id" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "audit_log_event_idx" ON "audit_log" USING btree ("event");--> statement-breakpoint
CREATE UNIQUE INDEX "briefings_kind_date_idx" ON "briefings" USING btree ("kind","run_date");--> statement-breakpoint
CREATE INDEX "execution_tasks_status_idx" ON "execution_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "job_runs_job_id_idx" ON "job_runs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "memory_facts_subject_idx" ON "memory_facts" USING btree ("subject");--> statement-breakpoint
CREATE INDEX "work_items_jira_key_idx" ON "work_items" USING btree ("jira_key");--> statement-breakpoint
CREATE INDEX "work_log_event_type_idx" ON "work_log" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "work_log_source_audit_id_idx" ON "work_log" USING btree ("source_audit_id");