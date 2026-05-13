DROP INDEX "garmin_pushed_workout_local_region_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "garmin_pushed_workout_local_region_idx" ON "garmin_pushed_workout" USING btree ("local_workout_id","region","scheduled_date");
--> statement-breakpoint
CREATE TABLE "training_evaluation" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" text,
  "evaluation_date" date NOT NULL,
  "planned_workout_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "activity_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "result" jsonb,
  "note" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "training_evaluation_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "training_evaluation_plan_id_training_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plan"("id") ON DELETE set null ON UPDATE no action,
  CONSTRAINT "training_evaluation_status_chk" CHECK ("status" IN ('pending','ready','failed'))
);
--> statement-breakpoint
CREATE INDEX "training_evaluation_user_date_idx" ON "training_evaluation" USING btree ("user_id","evaluation_date");
--> statement-breakpoint
CREATE INDEX "training_evaluation_plan_idx" ON "training_evaluation" USING btree ("plan_id");
