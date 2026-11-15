-- array_to_string is only STABLE, and a generated column needs an IMMUTABLE expression. Joining text elements is
-- deterministic, so this wrapper is declared IMMUTABLE for the part.search column below.
CREATE FUNCTION "fs_part_search_text"(text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string($1, ' ') $$;--> statement-breakpoint
CREATE TABLE "customer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"email" text,
	"notes" text DEFAULT '' NOT NULL,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_name_len_chk" CHECK (char_length("customer"."name") between 1 and 120),
	CONSTRAINT "customer_phone_len_chk" CHECK (char_length("customer"."phone") between 1 and 40),
	CONSTRAINT "customer_email_len_chk" CHECK ("customer"."email" is null or char_length("customer"."email") <= 200),
	CONSTRAINT "customer_notes_len_chk" CHECK (char_length("customer"."notes") <= 1000)
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
	"captured_at" timestamp with time zone,
	"late" boolean DEFAULT false NOT NULL,
	"client_at" timestamp with time zone,
	"server_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"op_id" uuid,
	CONSTRAINT "job_event_kind_chk" CHECK ("job_event"."kind" in ('created', 'assigned', 'unassigned', 'rescheduled', 'status')),
	CONSTRAINT "job_event_location_chk" CHECK (("job_event"."lat" is null and "job_event"."lng" is null and "job_event"."accuracy_m" is null and "job_event"."captured_at" is null) or "job_event"."to_status" = 'on_site'),
	CONSTRAINT "job_event_location_pair_chk" CHECK (("job_event"."lat" is null) = ("job_event"."lng" is null))
);
--> statement-breakpoint
CREATE TABLE "job_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"client_at" timestamp with time zone,
	"server_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"op_id" uuid,
	CONSTRAINT "job_note_body_len_chk" CHECK (char_length("job_note"."body") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "part" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'each' NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_per_job" integer DEFAULT 20 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"client_op_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', sku || ' ' || name || ' ' || fs_part_search_text(aliases))) STORED,
	CONSTRAINT "part_sku_unique" UNIQUE("sku"),
	CONSTRAINT "part_sku_chk" CHECK ("part"."sku" ~ '^[A-Z0-9-]{2,40}$'),
	CONSTRAINT "part_name_len_chk" CHECK (char_length("part"."name") between 1 and 120),
	CONSTRAINT "part_unit_chk" CHECK ("part"."unit" in ('each', 'ft', 'm', 'box', 'roll', 'l', 'kg', 'set')),
	CONSTRAINT "part_aliases_chk" CHECK (coalesce(array_length("part"."aliases", 1), 0) <= 10),
	CONSTRAINT "part_max_per_job_chk" CHECK ("part"."max_per_job" between 1 and 9999)
);
--> statement-breakpoint
CREATE TABLE "service_job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer GENERATED ALWAYS AS IDENTITY (sequence name "service_job_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'unassigned' NOT NULL,
	"scheduled_start" timestamp with time zone,
	"scheduled_end" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"status_version" integer DEFAULT 1 NOT NULL,
	"client_op_id" uuid,
	"assignee_id" text,
	"created_by" text NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_job_status_chk" CHECK ("service_job"."status" in ('unassigned', 'scheduled', 'en_route', 'on_site', 'on_hold', 'completed', 'cancelled')),
	CONSTRAINT "service_job_priority_chk" CHECK ("service_job"."priority" in ('low', 'normal', 'high', 'emergency')),
	CONSTRAINT "service_job_title_len_chk" CHECK (char_length("service_job"."title") between 1 and 120),
	CONSTRAINT "service_job_description_len_chk" CHECK (char_length("service_job"."description") <= 2000),
	CONSTRAINT "service_job_window_chk" CHECK (("service_job"."scheduled_start" is null) = ("service_job"."scheduled_end" is null) and ("service_job"."scheduled_start" is null or ("service_job"."scheduled_end" > "service_job"."scheduled_start" and "service_job"."scheduled_end" <= "service_job"."scheduled_start" + interval '12 hours'))),
	CONSTRAINT "service_job_unassigned_chk" CHECK (("service_job"."status" = 'unassigned') = ("service_job"."assignee_id" is null) or "service_job"."status" = 'cancelled'),
	CONSTRAINT "service_job_scheduled_window_chk" CHECK ("service_job"."status" <> 'scheduled' or "service_job"."scheduled_start" is not null)
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
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_id_customer_uniq" UNIQUE("id","customer_id"),
	CONSTRAINT "site_label_len_chk" CHECK (char_length("site"."label") between 1 and 80),
	CONSTRAINT "site_address_len_chk" CHECK (char_length("site"."address") between 1 and 300),
	CONSTRAINT "site_access_notes_len_chk" CHECK (char_length("site"."access_notes") <= 500),
	CONSTRAINT "site_coords_chk" CHECK (("site"."lat" is null) = ("site"."lng" is null) and ("site"."lat" is null or ("site"."lat" between -90 and 90 and "site"."lng" between -180 and 180)))
);
--> statement-breakpoint
CREATE TABLE "sync_op" (
	"actor_id" text NOT NULL,
	"op_id" uuid NOT NULL,
	"device_id" text,
	"kind" text NOT NULL,
	"job_id" uuid,
	"payload_hash" text NOT NULL,
	"outcome" text,
	"result" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_op_actor_id_op_id_pk" PRIMARY KEY("actor_id","op_id"),
	CONSTRAINT "sync_op_kind_chk" CHECK ("sync_op"."kind" in ('note.add', 'status.set')),
	CONSTRAINT "sync_op_outcome_chk" CHECK ("sync_op"."outcome" is null or "sync_op"."outcome" in ('applied', 'conflict', 'rejected')),
	CONSTRAINT "sync_op_result_size_chk" CHECK ("sync_op"."result" is null or octet_length("sync_op"."result"::text) <= 2048)
);
--> statement-breakpoint
CREATE TABLE "work_order" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up" text,
	"ai" jsonb,
	"return_reason" text,
	"submitted_by" text,
	"approved_by" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "work_order_status_chk" CHECK ("work_order"."status" in ('draft', 'submitted', 'approved', 'returned')),
	CONSTRAINT "work_order_summary_len_chk" CHECK (char_length("work_order"."summary") <= 400),
	CONSTRAINT "work_order_follow_up_len_chk" CHECK ("work_order"."follow_up" is null or char_length("work_order"."follow_up") <= 300),
	CONSTRAINT "work_order_return_reason_len_chk" CHECK ("work_order"."return_reason" is null or char_length("work_order"."return_reason") <= 300)
);
--> statement-breakpoint
CREATE TABLE "work_order_line" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"part_id" uuid,
	"mentioned" text NOT NULL,
	"qty" numeric(10, 2) NOT NULL,
	"unit" text NOT NULL,
	"used" text NOT NULL,
	"source" text NOT NULL,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "work_order_line_qty_chk" CHECK ("work_order_line"."qty" > 0),
	CONSTRAINT "work_order_line_mentioned_len_chk" CHECK (char_length("work_order_line"."mentioned") between 1 and 120),
	CONSTRAINT "work_order_line_used_chk" CHECK ("work_order_line"."used" in ('used', 'needed')),
	CONSTRAINT "work_order_line_source_chk" CHECK ("work_order_line"."source" in ('ai', 'human'))
);
--> statement-breakpoint
ALTER TABLE "item" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "item" CASCADE;--> statement-breakpoint
ALTER TABLE "rate_event" DROP CONSTRAINT "rate_event_kind_chk";--> statement-breakpoint
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_note" ADD CONSTRAINT "job_note_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_note" ADD CONSTRAINT "job_note_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part" ADD CONSTRAINT "part_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_site_customer_fk" FOREIGN KEY ("site_id","customer_id") REFERENCES "public"."site"("id","customer_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_op" ADD CONSTRAINT "sync_op_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order" ADD CONSTRAINT "work_order_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_line" ADD CONSTRAINT "work_order_line_work_order_id_work_order_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_line" ADD CONSTRAINT "work_order_line_part_id_part_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."part"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_created_by_client_op_uidx" ON "customer" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "customer" USING btree ("name");--> statement-breakpoint
CREATE INDEX "job_event_job_idx" ON "job_event" USING btree ("job_id","server_at");--> statement-breakpoint
CREATE INDEX "job_event_located_idx" ON "job_event" USING btree ("job_id") WHERE "job_event"."lat" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "job_event_actor_op_uidx" ON "job_event" USING btree ("actor_id","op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_note_author_op_uidx" ON "job_note" USING btree ("author_id","op_id");--> statement-breakpoint
CREATE INDEX "job_note_job_idx" ON "job_note" USING btree ("job_id","server_at");--> statement-breakpoint
CREATE UNIQUE INDEX "part_created_by_client_op_uidx" ON "part" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "part_search_idx" ON "part" USING gin ("search");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_created_by_client_op_uidx" ON "service_job" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_number_uidx" ON "service_job" USING btree ("number");--> statement-breakpoint
CREATE INDEX "service_job_assignee_status_start_idx" ON "service_job" USING btree ("assignee_id","status","scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_scheduled_start_idx" ON "service_job" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_customer_idx" ON "service_job" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "service_job_status_idx" ON "service_job" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "site_created_by_client_op_uidx" ON "site" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "site_customer_idx" ON "site" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sync_op_received_idx" ON "sync_op" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "work_order_line_order_idx" ON "work_order_line" USING btree ("work_order_id","position");--> statement-breakpoint
ALTER TABLE "rate_event" ADD CONSTRAINT "rate_event_kind_chk" CHECK ("rate_event"."kind" in ('api_write', 'sync', 'snapshot', 'ai', 'demo_load'));