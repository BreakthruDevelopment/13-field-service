CREATE TABLE "work_order_op" (
	"actor_id" text NOT NULL,
	"op_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"job_id" uuid NOT NULL,
	"payload_hash" text NOT NULL,
	"rate_event_id" uuid,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_order_op_actor_id_op_id_pk" PRIMARY KEY("actor_id","op_id"),
	CONSTRAINT "work_order_op_kind_chk" CHECK ("work_order_op"."kind" in ('generate', 'edit', 'submit', 'approve', 'return')),
	CONSTRAINT "work_order_op_result_size_chk" CHECK ("work_order_op"."result" is null or octet_length("work_order_op"."result"::text) <= 65536)
);
--> statement-breakpoint
ALTER TABLE "work_order_op" ADD CONSTRAINT "work_order_op_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_order_op" ADD CONSTRAINT "work_order_op_job_id_service_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."service_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_order_op_job_kind_idx" ON "work_order_op" USING btree ("job_id","kind","created_at");--> statement-breakpoint
CREATE INDEX "work_order_op_actor_created_idx" ON "work_order_op" USING btree ("actor_id","created_at");