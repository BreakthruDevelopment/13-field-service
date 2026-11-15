CREATE TABLE "maintenance_run" (
	"name" text PRIMARY KEY NOT NULL,
	"ran_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'sync', 'snapshot', 'ai', 'demo_load', 'read'));