-- Per-row retry schedule for the outbox publisher.
--
-- A claimed batch used to succeed or fail as a whole: one event whose emit or dispatch failed left the
-- entire batch to be re-claimed together after the 30 s lease, where it failed again, so healthy events
-- that shared a batch with it were held back indefinitely. The publisher now marks the rows that went out
-- and pushes only the failed ones back with an attempt-based backoff (rd_claim_outbox already counts the
-- attempt), keeping the durable lease and retry state in PostgreSQL.
CREATE OR REPLACE FUNCTION rd_defer_outbox(p_seqs bigint[], p_seconds int)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events
     SET available_at = now() + make_interval(secs => p_seconds)
   WHERE seq = ANY(p_seqs) AND published_at IS NULL
$$;

REVOKE ALL ON FUNCTION rd_defer_outbox(bigint[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd_defer_outbox(bigint[], int) TO talkivio_app_role;
