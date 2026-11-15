CREATE TABLE "demo_load_op" (
	"admin_id" text NOT NULL,
	"client_op_id" uuid NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_load_op_admin_id_client_op_id_pk" PRIMARY KEY("admin_id","client_op_id")
);
--> statement-breakpoint
ALTER TABLE "demo_load_op" ADD CONSTRAINT "demo_load_op_admin_id_user_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;