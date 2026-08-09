CREATE TABLE "batches" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "batches_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"as_of_date" date,
	"model_version" text NOT NULL,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text,
	"n_scored" integer DEFAULT 0 NOT NULL,
	"n_queue" integer DEFAULT 0 NOT NULL,
	"n_safe" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "batches_asof_model_uq" UNIQUE("as_of_date","model_version")
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"post_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"firm_id" text PRIMARY KEY NOT NULL,
	"corp_key" text,
	"name" text NOT NULL,
	"biz_no" text NOT NULL,
	"sido" text,
	"industry" text,
	"first_seen" date,
	"last_seen" date
);
--> statement-breakpoint
CREATE TABLE "inspector_queue" (
	"firm_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"grade" text NOT NULL,
	"risk_full" real,
	"door1_체납이력" boolean,
	"이미_임금체불공개" boolean,
	"reasons" text[],
	CONSTRAINT "inspector_queue_firm_id_batch_id_pk" PRIMARY KEY("firm_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"firm_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"author_id" uuid NOT NULL,
	"firm_id" text NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"rating_pay" smallint NOT NULL,
	"rating_worklife" smallint NOT NULL,
	"rating_culture" smallint NOT NULL,
	"rating_management" smallint NOT NULL,
	"pros" text NOT NULL,
	"cons" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_firm_author_uq" UNIQUE("firm_id","author_id")
);
--> statement-breakpoint
CREATE TABLE "safe_recommendation" (
	"firm_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"n_months" smallint,
	"n_green" smallint,
	"risk_full" real,
	"체불배제" boolean,
	"체납배제" boolean,
	"door1_ever" real,
	"판정" text NOT NULL,
	CONSTRAINT "safe_recommendation_firm_id_batch_id_pk" PRIMARY KEY("firm_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "scored_active" (
	"firm_id" text NOT NULL,
	"batch_id" integer NOT NULL,
	"n_months" smallint,
	"g1_고용안정" boolean,
	"g2_성실납부" boolean,
	"g3_인건비안정" boolean,
	"g4_인력유지" boolean,
	"g5_업력3년" boolean,
	"g6_낮은변동성" boolean,
	"n_green" smallint,
	"체불배제" boolean,
	"체납배제" boolean,
	"risk_full" real,
	"risk_calibrated" real,
	"turnover_avg_12m" real,
	"turnover_avg_3m" real,
	"turnover_max_12m" real,
	"turnover_std_12m" real,
	"emp_change_3m" real,
	"emp_change_6m" real,
	"emp_change_12m" real,
	"salary_avg_12m" real,
	"salary_last" real,
	"salary_change_6m" real,
	"salary_change_12m" real,
	"replacement_avg_12m" real,
	"replacement_avg_3m" real,
	"replacement_min_12m" real,
	"salary_drop_consecutive" real,
	"turnover_momentum" real,
	"zero_emp_months" real,
	"emp_volatility" real,
	"log_emp_count" real,
	"firm_age_months" real,
	"sido_code" text,
	"industry_category" text,
	"imputed_months_count" real,
	"imputed_ratio" real,
	"has_missing_recent_3m" real,
	"nf_bill_last_ratio" real,
	"nf_bill_maxdrop" real,
	"nf_pc_slope" real,
	"nf_pay_divergence" real,
	"nf_bill_cv" real,
	"nf_emp_slope" real,
	"nf_drawdown" real,
	"door1_ever" real,
	"door1_n_insu" real,
	"door1_maxamt" real,
	"door1_maxmonths" real,
	"door1_health" real,
	"door1_pension" real,
	"door1_labor" real,
	CONSTRAINT "scored_active_firm_id_batch_id_pk" PRIMARY KEY("firm_id","batch_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"firm_id" text,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_queue" ADD CONSTRAINT "inspector_queue_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspector_queue" ADD CONSTRAINT "inspector_queue_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_recommendation" ADD CONSTRAINT "safe_recommendation_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safe_recommendation" ADD CONSTRAINT "safe_recommendation_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scored_active" ADD CONSTRAINT "scored_active_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scored_active" ADD CONSTRAINT "scored_active_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firm_id_firms_firm_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("firm_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comments_post_idx" ON "comments" USING btree ("post_id","created_at");--> statement-breakpoint
CREATE INDEX "firms_name_idx" ON "firms" USING btree ("name");--> statement-breakpoint
CREATE INDEX "firms_biz_no_idx" ON "firms" USING btree ("biz_no");--> statement-breakpoint
CREATE INDEX "firms_corp_key_idx" ON "firms" USING btree ("corp_key");--> statement-breakpoint
CREATE INDEX "firms_sido_idx" ON "firms" USING btree ("sido");--> statement-breakpoint
CREATE INDEX "queue_batch_rank_idx" ON "inspector_queue" USING btree ("batch_id","rank");--> statement-breakpoint
CREATE INDEX "queue_batch_grade_idx" ON "inspector_queue" USING btree ("batch_id","grade");--> statement-breakpoint
CREATE INDEX "posts_created_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_firm_idx" ON "posts" USING btree ("firm_id");--> statement-breakpoint
CREATE INDEX "reviews_firm_created_idx" ON "reviews" USING btree ("firm_id","created_at");--> statement-breakpoint
CREATE INDEX "safe_batch_verdict_idx" ON "safe_recommendation" USING btree ("batch_id","판정");--> statement-breakpoint
CREATE INDEX "safe_batch_risk_idx" ON "safe_recommendation" USING btree ("batch_id","risk_full");--> statement-breakpoint
CREATE INDEX "scored_batch_risk_idx" ON "scored_active" USING btree ("batch_id","risk_full");--> statement-breakpoint
CREATE INDEX "scored_batch_idx" ON "scored_active" USING btree ("batch_id");