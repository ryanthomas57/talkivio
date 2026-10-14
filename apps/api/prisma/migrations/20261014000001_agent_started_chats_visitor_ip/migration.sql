-- Expand-only (docs/operations/deployment.md §5): agent-started chats (an agent opens a chat with a browsing
-- visitor from the Visitors list) and the visitor's IP address and network owner on each visit.
-- CHECK lists are widened as NOT VALID here and validated in the next migration, so no long lock is held.

ALTER TABLE "chats" DROP CONSTRAINT "ck_chats_started_by";
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_started_by" CHECK ("started_by" IN ('visitor', 'invitation', 'agent')) NOT VALID;

ALTER TABLE "chats" DROP CONSTRAINT "ck_chats_route_reason";
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_route_reason" CHECK ("route_reason" IN ('default', 'site_default', 'department_selected', 'invitation_accepted', 'trigger_override', 'max_wait_fallback', 'agent_started')) NOT VALID;

ALTER TABLE "metric_chat_facts" DROP CONSTRAINT "ck_metric_chat_facts_started_by";
ALTER TABLE "metric_chat_facts" ADD CONSTRAINT "ck_metric_chat_facts_started_by" CHECK ("started_by" IN ('visitor', 'invitation', 'agent')) NOT VALID;

ALTER TABLE "assignment_history" DROP CONSTRAINT "ck_assignment_history_reason";
ALTER TABLE "assignment_history" ADD CONSTRAINT "ck_assignment_history_reason" CHECK ("reason" IN ('queued_no_candidate', 'offered', 'offer_accepted', 'picked_up', 'transfer_accepted', 'agent_suspended', 'department_transfer', 'forced_transfer', 'transfer_offered', 'trigger_override', 'max_wait_exceeded', 'max_wait_fallback', 'agent_started')) NOT VALID;

-- Stored only while the workspace enables "Store visitor IP addresses" (settings.tracking.retainIp) and the visit
-- may be tracked; erased with the visitor and on consent withdrawal.
ALTER TABLE "visitor_sessions" ADD COLUMN "ip_address" VARCHAR(45);
ALTER TABLE "visitor_sessions" ADD COLUMN "network" VARCHAR(160);
