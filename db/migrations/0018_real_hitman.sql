CREATE TABLE "user_favorite_firms" (
	"user_id" uuid NOT NULL,
	"firm_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_favorite_firms_user_id_firm_id_pk" PRIMARY KEY("user_id","firm_id")
);
--> statement-breakpoint
ALTER TABLE "user_favorite_firms" ADD CONSTRAINT "user_favorite_firms_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_favorite_firms" ADD CONSTRAINT "user_favorite_firms_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_favorite_firms_user_created_idx" ON "user_favorite_firms" USING btree ("user_id","created_at" DESC NULLS LAST);