CREATE TABLE "activity_metric" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"region" text NOT NULL,
	"activity_id" text NOT NULL,
	"sport" text NOT NULL,
	"subtype" text,
	"start_time" timestamp NOT NULL,
	"distance_km" numeric(8, 3),
	"duration_min" numeric(8, 2),
	"elevation_gain_m" integer,
	"avg_pace_sec_per_km" integer,
	"avg_pace_sec_per_100m" integer,
	"avg_power" integer,
	"normalized_power" integer,
	"cadence_avg" integer,
	"ground_contact_time_ms" numeric(6, 2),
	"vertical_oscillation_cm" numeric(5, 2),
	"vertical_ratio" numeric(5, 2),
	"avg_hr" integer,
	"max_hr" integer,
	"hr_zone_seconds" jsonb,
	"vo2_max" numeric(4, 1),
	"lactate_threshold_hr" integer,
	"lactate_threshold_pace_sec_per_km" integer,
	"aerobic_te" numeric(3, 1),
	"anaerobic_te" numeric(3, 1),
	"training_load" integer,
	"recovery_time_hours" integer,
	"pool_length_m" integer,
	"swim_stroke" text,
	"stimulus" text,
	"quality_confidence" text DEFAULT 'medium' NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "activity_metric_sport_chk" CHECK ("activity_metric"."sport" IN ('running','swimming','cycling','other')),
	CONSTRAINT "activity_metric_confidence_chk" CHECK ("activity_metric"."quality_confidence" IN ('low','medium','high'))
);
--> statement-breakpoint
CREATE TABLE "athletic_profile" (
	"user_id" text NOT NULL,
	"sport" text NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"confidence" text DEFAULT 'low' NOT NULL,
	"primary_metric" numeric(8, 2),
	"primary_metric_unit" text,
	"primary_metric_source" text DEFAULT 'computed' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"activity_count_used" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "athletic_profile_sport_chk" CHECK ("athletic_profile"."sport" IN ('running','swimming','cycling')),
	CONSTRAINT "athletic_profile_confidence_chk" CHECK ("athletic_profile"."confidence" IN ('low','medium','high')),
	CONSTRAINT "athletic_profile_source_chk" CHECK ("athletic_profile"."primary_metric_source" IN ('computed','user_override','tested'))
);
--> statement-breakpoint
CREATE TABLE "performance_record" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sport" text NOT NULL,
	"anchor" text NOT NULL,
	"best_value" numeric(10, 2) NOT NULL,
	"best_unit" text NOT NULL,
	"achieved_at" timestamp NOT NULL,
	"source_activity_id" text,
	"source_region" text,
	"confidence" text DEFAULT 'medium' NOT NULL,
	"is_user_entered" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "performance_record_sport_chk" CHECK ("performance_record"."sport" IN ('running','swimming','cycling')),
	CONSTRAINT "performance_record_unit_chk" CHECK ("performance_record"."best_unit" IN ('seconds','watts')),
	CONSTRAINT "performance_record_confidence_chk" CHECK ("performance_record"."confidence" IN ('low','medium','high'))
);
--> statement-breakpoint
CREATE TABLE "user_activity_flag" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"region" text NOT NULL,
	"activity_id" text NOT NULL,
	"exclude_from_capability" boolean DEFAULT false NOT NULL,
	"note" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_metric" ADD CONSTRAINT "activity_metric_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "athletic_profile" ADD CONSTRAINT "athletic_profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "performance_record" ADD CONSTRAINT "performance_record_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_activity_flag" ADD CONSTRAINT "user_activity_flag_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_metric_user_region_act_idx" ON "activity_metric" USING btree ("user_id","region","activity_id");--> statement-breakpoint
CREATE INDEX "activity_metric_user_sport_time_idx" ON "activity_metric" USING btree ("user_id","sport","start_time" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "athletic_profile_user_sport_idx" ON "athletic_profile" USING btree ("user_id","sport");--> statement-breakpoint
CREATE UNIQUE INDEX "performance_record_user_anchor_idx" ON "performance_record" USING btree ("user_id","anchor");--> statement-breakpoint
CREATE INDEX "performance_record_user_sport_idx" ON "performance_record" USING btree ("user_id","sport");--> statement-breakpoint
CREATE UNIQUE INDEX "user_activity_flag_user_act_idx" ON "user_activity_flag" USING btree ("user_id","region","activity_id");