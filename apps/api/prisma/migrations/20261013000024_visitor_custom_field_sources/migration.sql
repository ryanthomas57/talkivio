-- Custom-field provenance (AUD-71-26).
--
-- Tags already record who applied them (visitor_tags.source); custom-field values did not. Each write now records,
-- per key, where the value came from: `visitor` (the site's page through the SDK — unverified), `agent` (a staff
-- edit, with the membership id) or `trigger` (an automation, with the trigger id), and when. The map is cleared
-- together with the values (removals, privacy erasure). A constant default makes the column catalog-only to add.
ALTER TABLE "visitors" ADD COLUMN "custom_field_sources" JSONB NOT NULL DEFAULT '{}';
