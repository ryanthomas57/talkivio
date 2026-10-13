-- Split the oldest-queued gauge into routable / not routable. A queued chat is routable when its
-- department (or, for chats without a department, any department) has a serving member whose
-- server-recorded availability interval is open with status 'online'. Ages only, no tenant data.
DROP FUNCTION IF EXISTS rd_metrics_snapshot();
CREATE FUNCTION rd_metrics_snapshot()
RETURNS TABLE (
  oldest_routable_queued_seconds double precision,
  oldest_unroutable_queued_seconds double precision,
  oldest_unscanned_seconds double precision,
  oldest_unpublished_seconds double precision
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH waiting AS (
    SELECT c.requested_at,
           EXISTS (
             SELECT 1 FROM department_members dm
               JOIN availability_intervals ai ON ai.tenant_id = dm.tenant_id AND ai.membership_id = dm.membership_id
                                            AND ai.ended_at IS NULL AND ai.status = 'online'
              WHERE dm.tenant_id = c.tenant_id AND dm.can_serve
                AND (c.department_id IS NULL OR dm.department_id = c.department_id)
           ) AS routable
      FROM chats c
     WHERE c.status IN ('queued', 'offered') AND c.is_preview = false
  )
  SELECT
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(requested_at) FROM waiting WHERE routable)), 0)::double precision,
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(requested_at) FROM waiting WHERE NOT routable)), 0)::double precision,
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(updated_at) FROM attachments WHERE state IN ('uploaded', 'scanning') AND deleted_at IS NULL)), 0)::double precision,
    COALESCE(EXTRACT(EPOCH FROM now() - (SELECT min(occurred_at) FROM outbox_events WHERE published_at IS NULL)), 0)::double precision
$$;
REVOKE ALL ON FUNCTION rd_metrics_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd_metrics_snapshot() TO talkivio_app_role;

-- Open availability intervals are looked up per member.
CREATE INDEX IF NOT EXISTS "availability_intervals_open_idx" ON "availability_intervals" ("tenant_id", "membership_id") WHERE ended_at IS NULL;
