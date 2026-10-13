-- Foreign-key index (docs/performance/performance-report.md, data scale). Without it every deleted parent row
-- (visitor erasure, tenant deletion) scanned the tenant's rows of this table: deleting a 10 000-visitor tenant with
-- 1 M messages did not finish in 10 minutes. CONCURRENTLY on a large live table (ch. 34): one statement per
-- migration, because a multi-statement script runs as one implicit transaction. If a build is interrupted, drop the
-- INVALID index and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_tenant_id_sender_visitor_id_idx" ON "messages"("tenant_id", "sender_visitor_id");
