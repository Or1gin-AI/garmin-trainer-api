CREATE TABLE "ai_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period_start" date NOT NULL,
	"plan_generation_count" integer DEFAULT 0 NOT NULL,
	"chat_message_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_message" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"tool_result_refs" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_role_chk" CHECK ("chat_message"."role" IN ('user','assistant','tool'))
);
--> statement-breakpoint
CREATE TABLE "llm_config" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"model" text NOT NULL,
	"max_output_tokens" integer DEFAULT 4096 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "llm_config_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "training_plan" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"week_start_date" date NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"request" jsonb NOT NULL,
	"athlete_profile_snapshot" jsonb,
	"summary" text,
	"monitoring" text,
	"adjustment_rules" text,
	"model_meta" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "training_plan_status_chk" CHECK ("training_plan"."status" IN ('generating','ready','failed','archived'))
);
--> statement-breakpoint
CREATE TABLE "workout" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"day_index" integer NOT NULL,
	"date" date NOT NULL,
	"sport" text NOT NULL,
	"template_id" text NOT NULL,
	"workout_type" text,
	"title" text NOT NULL,
	"intensity" text NOT NULL,
	"duration_minutes" integer,
	"distance_km" numeric(6, 2),
	"target_metric" text NOT NULL,
	"target_heart_rate" text,
	"target_pace" text,
	"target_power" text,
	"workout_structure" text,
	"targets" jsonb,
	"parameter_source" jsonb,
	"adaptation" text,
	"status" text DEFAULT 'planned' NOT NULL,
	CONSTRAINT "workout_day_index_chk" CHECK ("workout"."day_index" BETWEEN 1 AND 7),
	CONSTRAINT "workout_sport_chk" CHECK ("workout"."sport" IN ('running','cycling','swimming','rest','strength','mobility')),
	CONSTRAINT "workout_intensity_chk" CHECK ("workout"."intensity" IN ('low','medium','high')),
	CONSTRAINT "workout_target_metric_chk" CHECK ("workout"."target_metric" IN ('heart_rate','pace','power','mixed','none')),
	CONSTRAINT "workout_status_chk" CHECK ("workout"."status" IN ('planned','completed','skipped','regenerating'))
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_plan_id_training_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_message" ADD CONSTRAINT "chat_message_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_plan" ADD CONSTRAINT "training_plan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workout" ADD CONSTRAINT "workout_plan_id_training_plan_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."training_plan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_user_period_idx" ON "ai_usage" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE INDEX "chat_message_plan_created_idx" ON "chat_message" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_message_user_idx" ON "chat_message" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "training_plan_user_week_idx" ON "training_plan" USING btree ("user_id","week_start_date" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "workout_plan_day_idx" ON "workout" USING btree ("plan_id","day_index");