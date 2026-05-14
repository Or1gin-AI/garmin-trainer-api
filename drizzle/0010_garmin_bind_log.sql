CREATE TABLE "garmin_bind_log" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "region" text NOT NULL,
  "profile" jsonb,
  "bound_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "garmin_bind_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "garmin_bind_log_user_region_bound_idx" ON "garmin_bind_log" USING btree ("user_id","region","bound_at");
