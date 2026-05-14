ALTER TABLE "redemption_code" ADD COLUMN "plan" text DEFAULT 'max' NOT NULL;
--> statement-breakpoint
UPDATE "subscription"
SET "plan" = 'max', "updated_at" = now()
WHERE "plan" = 'pro';
