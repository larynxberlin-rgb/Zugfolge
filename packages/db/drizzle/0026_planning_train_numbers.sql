CREATE TABLE "planning_train_numbers" (
  "world_id" uuid NOT NULL,
  "account_id" uuid NOT NULL,
  "request_id" text NOT NULL,
  "train_category" text NOT NULL,
  "train_number" integer NOT NULL,
  "train_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "planning_train_numbers_pk" PRIMARY KEY("world_id", "account_id", "request_id"),
  CONSTRAINT "planning_train_numbers_category_range_check" CHECK (
    ("train_category" = 'long-distance' and "train_number" between 1 and 9999)
    or ("train_category" = 'suburban' and "train_number" between 10000 and 19999)
    or ("train_category" = 'regional' and "train_number" between 20000 and 39999)
    or ("train_category" = 'freight' and "train_number" between 40000 and 79999)
    or ("train_category" = 'supplementary' and "train_number" between 80000 and 99999)
  )
);
--> statement-breakpoint
ALTER TABLE "planning_train_numbers" ADD CONSTRAINT "planning_train_numbers_world_fk" FOREIGN KEY ("world_id") REFERENCES "public"."worlds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "planning_train_numbers" ADD CONSTRAINT "planning_train_numbers_world_account_fk" FOREIGN KEY ("world_id","account_id") REFERENCES "public"."accounts"("world_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "planning_train_numbers_world_number_idx" ON "planning_train_numbers" USING btree ("world_id","train_number");
--> statement-breakpoint
CREATE UNIQUE INDEX "planning_train_numbers_world_train_idx" ON "planning_train_numbers" USING btree ("world_id","train_id");
