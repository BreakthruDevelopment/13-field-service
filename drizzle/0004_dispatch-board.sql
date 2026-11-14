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
ALTER TABLE "customer" ADD CONSTRAINT "customer_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_customer_id_customer_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_id_customer_uidx" ON "site" USING btree ("id","customer_id");--> statement-breakpoint
ALTER TABLE "service_job" ADD CONSTRAINT "service_job_site_customer_fk" FOREIGN KEY ("site_id","customer_id") REFERENCES "public"."site"("id","customer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_created_by_client_op_uidx" ON "customer" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "customer_name_idx" ON "customer" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_number_uidx" ON "service_job" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "service_job_created_by_client_op_uidx" ON "service_job" USING btree ("created_by","client_op_id");--> statement-breakpoint
CREATE INDEX "service_job_assignee_status_start_idx" ON "service_job" USING btree ("assignee_id","status","scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_scheduled_start_idx" ON "service_job" USING btree ("scheduled_start");--> statement-breakpoint
CREATE INDEX "service_job_customer_id_idx" ON "service_job" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_customer_client_op_uidx" ON "site" USING btree ("customer_id","client_op_id");--> statement-breakpoint
CREATE INDEX "site_customer_id_idx" ON "site" USING btree ("customer_id");