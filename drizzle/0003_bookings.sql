CREATE TYPE "public"."actor_kind" AS ENUM('customer', 'operator', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('confirmed', 'customer_ready', 'in_progress', 'completed', 'cancelled', 'no_show', 'expired');--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operator_slot_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"operator_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"location_session_type_id" uuid NOT NULL,
	"price_snapshot" numeric(10, 2) NOT NULL,
	"currency" char(3) NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"status" "booking_status" DEFAULT 'confirmed' NOT NULL,
	"late_cancellation" boolean DEFAULT false NOT NULL,
	"cancelled_by" "actor_kind",
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_ack_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"session_end_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_operator_slot_id_operator_slots_id_fk" FOREIGN KEY ("operator_slot_id") REFERENCES "public"."operator_slots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_location_session_type_id_location_session_types_id_fk" FOREIGN KEY ("location_session_type_id") REFERENCES "public"."location_session_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookings_customer_idx" ON "bookings" USING btree ("customer_id","start_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "bookings_operator_idx" ON "bookings" USING btree ("operator_id","start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "booking_one_active_per_slot" ON "bookings" USING btree ("operator_slot_id") WHERE status IN ('confirmed','customer_ready','in_progress');--> statement-breakpoint
CREATE UNIQUE INDEX "customer_one_booking_per_tick" ON "bookings" USING btree ("customer_id","start_at") WHERE status IN ('confirmed','customer_ready','in_progress');