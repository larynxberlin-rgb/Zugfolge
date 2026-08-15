DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "planning_train_numbers"
    WHERE "train_category" = 'regional'
      AND "train_number" BETWEEN 39000 AND 39999
  ) THEN
    RAISE EXCEPTION 'Regionalzugnummern 39000 bis 39999 sind bereits durch Spielerfahrten belegt';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "planning_train_numbers" DROP CONSTRAINT "planning_train_numbers_category_range_check";
--> statement-breakpoint
ALTER TABLE "planning_train_numbers" ADD CONSTRAINT "planning_train_numbers_category_range_check" CHECK (
  ("train_category" = 'long-distance' and "train_number" between 1 and 9999)
  or ("train_category" = 'suburban' and "train_number" between 10000 and 19999)
  or ("train_category" = 'regional' and "train_number" between 20000 and 38999)
  or ("train_category" = 'freight' and "train_number" between 40000 and 79999)
  or ("train_category" = 'supplementary' and "train_number" between 80000 and 99999)
);
