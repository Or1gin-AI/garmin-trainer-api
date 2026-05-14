CREATE TABLE "referral" (
	"id" text PRIMARY KEY NOT NULL,
	"referrer_user_id" text NOT NULL,
	"referral_code" text NOT NULL,
	"referee_email" text NOT NULL,
	"referee_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reward_days" integer DEFAULT 15 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "subscription" ADD COLUMN "referral_code" text;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_referrer_user_id_user_id_fk" FOREIGN KEY ("referrer_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral" ADD CONSTRAINT "referral_referee_user_id_user_id_fk" FOREIGN KEY ("referee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "referral_referee_email_idx" ON "referral" USING btree ("referee_email");--> statement-breakpoint
CREATE INDEX "referral_referrer_idx" ON "referral" USING btree ("referrer_user_id");--> statement-breakpoint
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_referral_code_unique" UNIQUE("referral_code");
