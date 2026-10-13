-- History full-text search entry point (PERF02, docs/performance/performance-report.md).
--
-- Under row level security PostgreSQL never turns a non-leakproof operator such as tsvector @@ tsquery into an index
-- condition ahead of the tenant policy, so the policy-scoped search could not use messages_body_fts_idx and read every
-- message of the tenant (3.3 s for a rare term over 1 M messages). This SECURITY DEFINER function runs as the owner,
-- which bypasses RLS, and applies the same tenant scope explicitly from the transaction context (rd_current_tenant();
-- no context, no rows). It returns only chat ids of matching chats, newest first from an optional keyset cursor; the
-- caller applies the remaining filters and permissions as the application role. Dynamic SQL so each call is planned
-- with the actual term: a selective term drives from the body index, a common one from the newest chats.
CREATE OR REPLACE FUNCTION rd_search_chat_ids(p_query text, p_from timestamptz, p_to timestamptz, p_include_notes boolean,
                                              p_before_at timestamptz, p_before_id uuid, p_limit int)
RETURNS TABLE (chat_id uuid, requested_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY EXECUTE $q$
    SELECT c.id, c.requested_at
      FROM chats c
     WHERE c.tenant_id = rd_current_tenant()
       AND c.is_preview = false
       AND c.requested_at >= $2 AND c.requested_at < $3
       AND ($5::timestamptz IS NULL OR c.requested_at < $5 OR (c.requested_at = $5 AND c.id < $6))
       AND EXISTS (
         SELECT 1 FROM messages m
          WHERE m.tenant_id = c.tenant_id AND m.chat_id = c.id
            AND ($4 OR m.visibility = 'public')
            AND m.redacted_at IS NULL
            AND to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', $1))
     ORDER BY c.requested_at DESC, c.id DESC
     LIMIT $7 $q$
  USING p_query, p_from, p_to, p_include_notes, p_before_at, p_before_id, p_limit;
END
$$;

REVOKE ALL ON FUNCTION rd_search_chat_ids(text, timestamptz, timestamptz, boolean, timestamptz, uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd_search_chat_ids(text, timestamptz, timestamptz, boolean, timestamptz, uuid, int) TO talkivio_app_role;
