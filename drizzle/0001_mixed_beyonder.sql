CREATE TABLE "manual_time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"jira_key" text,
	"minutes" integer NOT NULL,
	"note" text,
	"logged_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "manual_time_entries_date_idx" ON "manual_time_entries" USING btree ("date");