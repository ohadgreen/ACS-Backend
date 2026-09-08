CREATE TABLE "location_session_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"location_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"price" numeric(10, 2) NOT NULL,
	"currency" char(3) DEFAULT 'ILS' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_session_types_location_code" UNIQUE("location_id","code"),
	CONSTRAINT "location_session_types_price_nonneg" CHECK ("location_session_types"."price" >= 0),
	CONSTRAINT "location_session_types_name_locales" CHECK (jsonb_exists("location_session_types"."name", 'en') AND jsonb_exists("location_session_types"."name", 'he'))
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"site_code" text NOT NULL,
	"site_name" jsonb NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"geog" geography(Point,4326) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "locations_code_unique" UNIQUE("code"),
	CONSTRAINT "locations_site_name_locales" CHECK (jsonb_exists("locations"."site_name", 'en') AND jsonb_exists("locations"."site_name", 'he')),
	CONSTRAINT "locations_name_locales" CHECK (jsonb_exists("locations"."name", 'en') AND jsonb_exists("locations"."name", 'he'))
);
--> statement-breakpoint
ALTER TABLE "location_session_types" ADD CONSTRAINT "location_session_types_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "locations_site_idx" ON "locations" USING btree ("site_code");--> statement-breakpoint
-- Hand-written: drizzle-kit does not emit GIST indexes for custom column
-- types, and without this every ST_DWithin in discovery is a sequential scan.
CREATE INDEX IF NOT EXISTS "locations_geog_idx" ON "locations" USING GIST ("geog");