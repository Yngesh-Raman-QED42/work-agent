CREATE TABLE "archived_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"summary" text NOT NULL,
	"url" text NOT NULL,
	"archived_at" timestamp with time zone NOT NULL
);
