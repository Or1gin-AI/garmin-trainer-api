ALTER TABLE "workout" ADD COLUMN "slot_index" integer DEFAULT 1 NOT NULL;
ALTER TABLE "workout" ADD COLUMN "session_label" text;
ALTER TABLE "workout" ADD COLUMN "time_of_day" text;
DROP INDEX IF EXISTS "workout_plan_day_idx";
CREATE UNIQUE INDEX "workout_plan_day_slot_idx" ON "workout" USING btree ("plan_id","day_index","slot_index");
ALTER TABLE "workout" ADD CONSTRAINT "workout_slot_index_chk" CHECK ("slot_index" BETWEEN 1 AND 3);
ALTER TABLE "workout" ADD CONSTRAINT "workout_time_of_day_chk" CHECK ("time_of_day" IS NULL OR "time_of_day" IN ('morning','midday','afternoon','evening'));
