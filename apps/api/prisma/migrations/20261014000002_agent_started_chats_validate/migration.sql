-- Validates the CHECK constraints widened in 20261014000001 (SHARE UPDATE EXCLUSIVE: reads and writes continue).
ALTER TABLE "chats" VALIDATE CONSTRAINT "ck_chats_started_by";
ALTER TABLE "chats" VALIDATE CONSTRAINT "ck_chats_route_reason";
ALTER TABLE "metric_chat_facts" VALIDATE CONSTRAINT "ck_metric_chat_facts_started_by";
ALTER TABLE "assignment_history" VALIDATE CONSTRAINT "ck_assignment_history_reason";
