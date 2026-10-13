-- Operational follow-ups after feature integration (2026-10-12).

-- Offline submissions may omit the email when the offline form does not require it.
ALTER TABLE "offline_submissions" ALTER COLUMN "email_ciphertext" DROP NOT NULL;

-- Analytics read paths (invitation funnel, incremental fact reconciliation).
CREATE INDEX IF NOT EXISTS "invitations_tenant_id_displayed_at_idx" ON "invitations" ("tenant_id", "displayed_at");
CREATE INDEX IF NOT EXISTS "invitations_tenant_id_accepted_chat_id_idx" ON "invitations" ("tenant_id", "accepted_chat_id");
CREATE INDEX IF NOT EXISTS "chats_tenant_id_updated_at_idx" ON "chats" ("tenant_id", "updated_at");
-- Oldest-queued gauge without scanning closed chats (partial index; not modelled in Prisma).
CREATE INDEX IF NOT EXISTS "chats_waiting_requested_at_idx" ON "chats" ("requested_at") WHERE status IN ('queued', 'offered') AND is_preview = false;

-- Cross-tenant operational gauges for the internal metrics endpoint. Returns ages
-- in seconds only — never tenant identifiers or content.
CREATE OR REPLACE FUNCTION rd_metrics_snapshot()
RETURNS TABLE (oldest_queued_seconds double precision, oldest_unscanned_seconds double precision, oldest_unpublished_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(requested_at) FROM chats WHERE status IN ('queued', 'offered') AND is_preview = false)), 0)::double precision,
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(updated_at) FROM attachments WHERE state IN ('uploaded', 'scanning') AND deleted_at IS NULL)), 0)::double precision,
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(occurred_at) FROM outbox_events WHERE published_at IS NULL)), 0)::double precision
$$;
REVOKE ALL ON FUNCTION rd_metrics_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd_metrics_snapshot() TO talkivio_app_role;
