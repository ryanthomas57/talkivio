-- Foreign-key indexes on the smaller visitor-owned tables (see 20261013000011): visitor erasure and tenant deletion
-- no longer scan these tables once per deleted visitor.
CREATE INDEX "chat_ratings_tenant_id_visitor_id_idx" ON "chat_ratings"("tenant_id", "visitor_id");
CREATE INDEX "identity_handoffs_tenant_id_visitor_id_idx" ON "identity_handoffs"("tenant_id", "visitor_id");
CREATE INDEX "offline_submissions_tenant_id_visitor_id_idx" ON "offline_submissions"("tenant_id", "visitor_id");
CREATE INDEX "privacy_requests_tenant_id_visitor_id_idx" ON "privacy_requests"("tenant_id", "visitor_id");
