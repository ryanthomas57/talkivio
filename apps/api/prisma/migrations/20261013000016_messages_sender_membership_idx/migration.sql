-- Foreign-key / filter index (docs/performance/performance-report.md, data scale): deleting the parent row no
-- longer scans the tenant's rows of this table. CONCURRENTLY on a large live table (ch. 34): one statement per
-- migration, because a multi-statement script runs as one implicit transaction. If a build is interrupted, drop the
-- INVALID index and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "messages_tenant_id_sender_membership_id_idx" ON "messages"("tenant_id", "sender_membership_id");
