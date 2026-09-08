CREATE TYPE "public"."operator_approval" AS ENUM('pending', 'approved', 'rejected', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."operator_presence" AS ENUM('offline', 'online', 'in_session');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('customer', 'operator', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('operator_pending_setup', 'active', 'suspended');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"role" "user_role" NOT NULL,
	"phone" text,
	"email" text,
	"password_hash" text,
	"display_name" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"preferred_locale" text DEFAULT 'he' NOT NULL,
	"phone_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "customer_identity" CHECK ("users"."role" <> 'customer' OR ("users"."phone" IS NOT NULL AND "users"."email" IS NULL AND "users"."password_hash" IS NULL)),
	CONSTRAINT "staff_identity" CHECK ("users"."role" = 'customer' OR ("users"."email" IS NOT NULL AND "users"."phone" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"bio" text,
	"gear_tags" text[] DEFAULT '{}' NOT NULL,
	"approval_status" "operator_approval" DEFAULT 'pending' NOT NULL,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"presence" "operator_presence" DEFAULT 'offline' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_info" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "setup_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_replaced_by_refresh_tokens_id_fk" FOREIGN KEY ("replaced_by") REFERENCES "public"."refresh_tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_tokens" ADD CONSTRAINT "setup_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");