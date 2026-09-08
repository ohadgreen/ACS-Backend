CREATE TYPE "public"."checkin_status" AS ENUM('active', 'ended');--> statement-breakpoint
CREATE TYPE "public"."slot_status" AS ENUM('open', 'booked', 'cancelled', 'expired');--> statement-breakpoint
CREATE TABLE "operator_checkins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"available_from" timestamp with time zone NOT NULL,
	"available_until" timestamp with time zone NOT NULL,
	"checked_in_geog" geography(Point,4326) NOT NULL,
	"status" "checkin_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "operator_checkins_window" CHECK ("operator_checkins"."available_until" > "operator_checkins"."available_from")
);
--> statement-breakpoint
CREATE TABLE "operator_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"checkin_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"status" "slot_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grid_aligned" CHECK (EXTRACT(minute FROM "operator_slots"."start_at" AT TIME ZONE 'UTC') IN (0,15,30,45)
          AND EXTRACT(second FROM "operator_slots"."start_at" AT TIME ZONE 'UTC') = 0)
);
--> statement-breakpoint
ALTER TABLE "operator_checkins" ADD CONSTRAINT "operator_checkins_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_checkins" ADD CONSTRAINT "operator_checkins_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_slots" ADD CONSTRAINT "operator_slots_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_slots" ADD CONSTRAINT "operator_slots_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_slots" ADD CONSTRAINT "operator_slots_checkin_id_operator_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."operator_checkins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_checkins_operator_idx" ON "operator_checkins" USING btree ("operator_id","status");--> statement-breakpoint
CREATE INDEX "operator_checkins_location_idx" ON "operator_checkins" USING btree ("location_id","available_from");--> statement-breakpoint
CREATE UNIQUE INDEX "one_session_per_operator_per_tick" ON "operator_slots" USING btree ("operator_id","start_at") WHERE status <> 'cancelled';--> statement-breakpoint
CREATE INDEX "operator_slots_lookup_idx" ON "operator_slots" USING btree ("location_id","start_at","status");