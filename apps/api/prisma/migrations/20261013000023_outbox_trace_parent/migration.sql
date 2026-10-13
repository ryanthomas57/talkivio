-- Message-lifecycle tracing (AUD-72-27).
--
-- A request that writes outbox rows records its W3C traceparent (55 characters; NULL when tracing is off) so the
-- worker's publish span continues the same trace across the process boundary. Nullable and without a default:
-- adding it is a catalog-only change, and rd_claim_outbox (RETURNS SETOF outbox_events … RETURNING o.*) returns
-- the new column without being redefined.
ALTER TABLE "outbox_events" ADD COLUMN "trace_parent" VARCHAR(128);
