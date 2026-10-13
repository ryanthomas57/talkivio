-- Foreign-key index (see 20261013000011): a delete or restrict check on the parent no longer scans the tenant's rows of
-- this table. CONCURRENTLY on a large live table (ch. 34): one statement per migration, because a multi-statement script
-- runs as one implicit transaction. If a build is interrupted, drop the INVALID index and re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chats_tenant_id_acquisition_department_id_idx" ON "chats"("tenant_id", "acquisition_department_id");
