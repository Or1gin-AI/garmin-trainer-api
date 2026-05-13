CREATE TABLE "user_calendar" (
  "user_id" text PRIMARY KEY NOT NULL,
  "active_plan_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "user_calendar_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "user_calendar_active_plan_id_training_plan_id_fk" FOREIGN KEY ("active_plan_id") REFERENCES "public"."training_plan"("id") ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "user_calendar_active_plan_idx" ON "user_calendar" USING btree ("active_plan_id");
