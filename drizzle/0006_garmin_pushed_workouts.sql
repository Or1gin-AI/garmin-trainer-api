CREATE TABLE "garmin_pushed_workout" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "plan_id" text NOT NULL,
  "local_workout_id" text NOT NULL,
  "region" text DEFAULT 'cn' NOT NULL,
  "garmin_workout_id" text,
  "garmin_schedule_id" text,
  "scheduled_date" date NOT NULL,
  "workout_name" text NOT NULL,
  "payload_hash" text NOT NULL,
  "status" text DEFAULT 'scheduled' NOT NULL,
  "last_error" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "garmin_pushed_workout_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "garmin_pushed_workout_plan_id_training_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plan"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "garmin_pushed_workout_local_workout_id_workout_id_fk" FOREIGN KEY ("local_workout_id") REFERENCES "public"."workout"("id") ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "garmin_pushed_workout_region_chk" CHECK ("region" IN ('cn','global')),
  CONSTRAINT "garmin_pushed_workout_status_chk" CHECK ("status" IN ('scheduled','deleting','deleted','failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "garmin_pushed_workout_local_region_idx" ON "garmin_pushed_workout" USING btree ("local_workout_id","region");
--> statement-breakpoint
CREATE INDEX "garmin_pushed_workout_plan_idx" ON "garmin_pushed_workout" USING btree ("plan_id");
--> statement-breakpoint
CREATE INDEX "garmin_pushed_workout_user_plan_idx" ON "garmin_pushed_workout" USING btree ("user_id","plan_id");
