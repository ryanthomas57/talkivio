-- Foreign-key / filter index (docs/performance/performance-report.md, data scale): deleting the parent row no
-- longer scans the tenant's rows of this table. CONCURRENTLY on a large live table (ch. 34): one statement per
-- migration, because a multi-statement script runs as one implicit transaction. If a build is interrupted, drop the
-- INVALID index and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chats_tenant_id_site_id_idx" ON "chats"("tenant_id", "site_id");
