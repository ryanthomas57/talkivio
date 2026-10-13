-- Outbox write path under burst load (docs/performance/performance-report.md).
--
-- The per-row pg_notify trigger had no listener: publishers are woken through Redis after commit
-- (OutboxService.append -> afterCommit nudge). Every transaction that queued a NOTIFY still took the
-- database-wide notify lock at commit and held it through the commit's WAL flush, so all message
-- writes committed one at a time; at burst rates that queue, not the publisher, set message latency.
DROP TRIGGER IF EXISTS outbox_events_notify ON outbox_events;
DROP FUNCTION IF EXISTS rd_outbox_notify();

-- Leave free space on each heap page so the publisher's claim update (attempt_count, available_at —
-- neither indexed) can stay a HOT update on the same page instead of a new tuple plus an entry in
-- every index. Applies to pages written from now on.
ALTER TABLE outbox_events SET (fillfactor = 70);
