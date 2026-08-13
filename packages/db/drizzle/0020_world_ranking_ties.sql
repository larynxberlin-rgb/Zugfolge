DROP INDEX "world_final_rankings_world_type_rank_idx";--> statement-breakpoint
CREATE INDEX "world_final_rankings_world_type_rank_idx" ON "world_final_rankings" ("world_id", "ranking_type", "rank");
