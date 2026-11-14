CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_by" text NOT NULL,
	"name" text NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"email" text,
	"notes" text DEFAULT '' NOT NULL,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_version_chk" CHECK ("customer"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "job_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"lat" numeric(7, 4),
	"lng" numeric(7, 4),
	"accuracy_m" integer,
	"captured_at" timestamp (3) with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"client_at" timestamp (3) with time zone,
	"server_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"op_id" uuid,
	CONSTRAINT "job_event_kind_chk" CHECK ("job_event"."kind" in ('created', 'assigned', 'unassigned', 'rescheduled', 'status')),
	CONSTRAINT "job_event_location_chk" CHECK ((("job_event"."lat" is null and "job_event"."lng" is null) or ("job_event"."to_status" = 'on_site' and "job_event"."lat" is not null and "job_event"."lng" is not null)))
);
--> statement-breakpoint
CREATE TABLE "job_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"client_at" timestamp (3) with time zone NOT NULL,
	"server_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"op_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" serial NOT NULL,
	"customer_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"created_by" text NOT NULL,
	"assignee_id" text,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'unassigned' NOT NULL,
	"scheduled_start" timestamp (3) with time zone,
	"scheduled_end" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"client_op_id" uuid,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_job_priority_chk" CHECK ("service_job"."priority" in ('low', 'normal', 'high', 'emergency')),
	CONSTRAINT "service_job_status_chk" CHECK ("service_job"."status" in ('unassigned', 'scheduled', 'en_route', 'on_site', 'on_hold', 'completed', 'cancelled')),
	CONSTRAINT "service_job_version_chk" CHECK ("service_job"."version" >= 1 and "service_job"."status_version" >= 1),
	CONSTRAINT "service_job_window_chk" CHECK ((("service_job"."scheduled_start" is null and "service_job"."scheduled_end" is null) or ("service_job"."scheduled_end" > "service_job"."scheduled_start" and "service_job"."scheduled_end" <= "service_job"."scheduled_start" + interval '12 hours')))
);
--> statement-breakpoint
CREATE TABLE "site" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"label" text NOT NULL,
	"address" text NOT NULL,
	"lat" numeric(8, 5),
	"lng" numeric(8, 5),
	"access_notes" text DEFAULT '' NOT NULL,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_version_chk" CHECK ("site"."version" >= 1),
	CONSTRAINT "site_coords_chk" CHECK (("site"."lat" is null and "site"."lng" is null) or ("site"."lat" is not null and "site"."lng" is not null))
);
--> statement-breakpoint
CREATE TABLE "sync_op" (
	"actor_id" text NOT NULL,
	"op_id" uuid NOT NULL,
	"device_id" text,
	"kind" text NOT NULL,
	"job_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"code" text,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_op_actor_id_op_id_pk" PRIMARY KEY("actor_id","op_id"),
	CONSTRAINT "sync_op_outcome_chk" CHECK ("sync_op"."outcome" in ('applied', 'conflict', 'rejected')),
	CONSTRAINT "sync_op_kind_chk" CHECK ("sync_op"."kind" in ('note.add', 'status.set'))
);
--> statement-breakpoint
CREATE TABLE "work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up" text DEFAULT '' NOT NULL,
	"return_reason" text,
	"submitted_by" text,
	"approved_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_status_chk" CHECK ("work_order"."status" in ('draft', 'submitted', 'approved', 'returned')),
	CONSTRAINT "work_order_version_chk" CHECK ("work_order"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "work_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"mentioned" text NOT NULL,
	"qty" numeric(10, 2) NOT NULL,
	"unit" text NOT NULL,
	"used" text NOT NULL,
	"source" text DEFAULT 'human' NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "work_order_line_unit_chk" CHECK ("work_order_line"."unit" in ('each', 'ft', 'm', 'box', 'roll', 'l', 'kg', 'set')),
	CONSTRAINT "work_order_line_used_chk" CHECK ("work_order_line"."used" in ('used', 'needed')),
	CONSTRAINT "work_order_line_source_chk" CHECK ("work_order_line"."source" in ('ai', 'human')),
	CONSTRAINT "work_order_line_qty_chk" CHECK ("work_order_line"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_note" ADD CONSTRAINT "job_note_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_note" ADD CONSTRAINT "job_note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_id_customer_uidx" ON "site" USING btree ("id","customer_id");--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_site_customer_fk" FOREIGN KEY ("site_id","customer_id") REFERENCES "public"."site"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_op" ADD CONSTRAINT "sync_op_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_line" ADD CONSTRAINT "work_order_line_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_created_by_client_op_uidx" ON "customer" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "customer" USING btree ("name");--> statement-breakpoint
CREATE INDEX "job_event_job_id_idx" ON "job_event" USING btree ("job_id","server_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_note_author_op_uidx" ON "job_note" USING btree ("author_id","op_id");--> statement-breakpoint
CREATE INDEX "job_note_job_id_idx" ON "job_note" USING btree ("job_id","server_at");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_number_uidx" ON "service_job" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_created_by_client_op_uidx" ON "service_job" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "service_job_assignee_status_start_idx" ON "service_job" USING btree ("assignee_id","status","scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_scheduled_start_idx" ON "service_job" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_customer_id_idx" ON "service_job" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_customer_client_op_uidx" ON "site" USING btree ("customer_id","client_op_id");--> statement-breakpoint
CREATE INDEX "site_customer_id_idx" ON "site" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sync_op_received_idx" ON "sync_op" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "work_order_job_uidx" ON "work_order" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "work_order_line_order_idx" ON "work_order_line" USING btree ("work_order_id","position");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'ai', 'upload', 'sync', 'snapshot'));