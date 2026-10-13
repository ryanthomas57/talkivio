-- The remaining foreign keys get indexes too (small tables; see 20261013000011): every foreign key in the schema is now
-- backed by an index whose leading columns are the referencing columns (asserted by apps/api/test/security.e2e.mjs).
CREATE INDEX "oauth_accounts_user_id_idx" ON "oauth_accounts"("user_id");
CREATE INDEX "tenants_owner_user_id_idx" ON "tenants"("owner_user_id");
CREATE INDEX "memberships_user_id_idx" ON "memberships"("user_id");
CREATE INDEX "departments_tenant_id_fallback_department_id_idx" ON "departments"("tenant_id", "fallback_department_id");
CREATE INDEX "departments_tenant_id_schedule_id_idx" ON "departments"("tenant_id", "schedule_id");
CREATE INDEX "emergency_closures_tenant_id_department_id_idx" ON "emergency_closures"("tenant_id", "department_id");
CREATE INDEX "emergency_closures_tenant_id_site_id_idx" ON "emergency_closures"("tenant_id", "site_id");
CREATE INDEX "sites_tenant_id_default_department_id_idx" ON "sites"("tenant_id", "default_department_id");
CREATE INDEX "sites_tenant_id_schedule_id_idx" ON "sites"("tenant_id", "schedule_id");
CREATE INDEX "identity_handoffs_tenant_id_destination_site_id_idx" ON "identity_handoffs"("tenant_id", "destination_site_id");
CREATE INDEX "identity_handoffs_tenant_id_source_site_id_idx" ON "identity_handoffs"("tenant_id", "source_site_id");
CREATE INDEX "bans_tenant_id_site_id_idx" ON "bans"("tenant_id", "site_id");
CREATE INDEX "assignment_offers_tenant_id_target_department_id_idx" ON "assignment_offers"("tenant_id", "target_department_id");
CREATE INDEX "offline_submissions_tenant_id_department_id_idx" ON "offline_submissions"("tenant_id", "department_id");
CREATE INDEX "offline_submissions_tenant_id_site_id_idx" ON "offline_submissions"("tenant_id", "site_id");
CREATE INDEX "exports_tenant_id_job_id_idx" ON "exports"("tenant_id", "job_id");
