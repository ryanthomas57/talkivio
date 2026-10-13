-- Bounded text (ch. 48, AUD-72-01): every text column carries a CHECK — closed sets list their values, machine
-- generated identifiers keep their shape, everything else has a length bound taken from the API validation.
-- Step 1 of 2: added NOT VALID (no table scan, brief locks); existing rows are validated by migration 26.

-- agent_invitations
ALTER TABLE "agent_invitations" ADD CONSTRAINT "ck_agent_invitations_email" CHECK (char_length("email") <= 200) NOT VALID;
ALTER TABLE "agent_invitations" ADD CONSTRAINT "ck_agent_invitations_token_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$' AND char_length("token_hash") <= 64) NOT VALID;

-- assignment_history
ALTER TABLE "assignment_history" ADD CONSTRAINT "ck_assignment_history_reason" CHECK ("reason" IN ('queued_no_candidate', 'offered', 'offer_accepted', 'picked_up', 'transfer_accepted', 'agent_suspended', 'department_transfer', 'forced_transfer', 'transfer_offered', 'trigger_override', 'max_wait_exceeded', 'max_wait_fallback')) NOT VALID;

-- assignment_offers
ALTER TABLE "assignment_offers" ADD CONSTRAINT "ck_assignment_offers_decision_reason" CHECK (char_length("decision_reason") <= 200) NOT VALID;
ALTER TABLE "assignment_offers" ADD CONSTRAINT "ck_assignment_offers_note" CHECK (char_length("note") <= 2000) NOT VALID;

-- attachments
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_declared_mime" CHECK (char_length("declared_mime") <= 73) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_detected_mime" CHECK (char_length("detected_mime") <= 73) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_object_key" CHECK (char_length("object_key") <= 128) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_original_name" CHECK (char_length("original_name") <= 180) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_reject_reason" CHECK ("reject_reason" IN ('executable', 'script', 'html', 'svg', 'archive', 'macro', 'type_not_allowed', 'type_mismatch', 'pdf_active_content', 'corrupt', 'image_too_large', 'encrypted', 'malware', 'checksum_mismatch', 'size_mismatch')) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_scan_result" CHECK (char_length("scan_result") <= 300) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND char_length("sha256") <= 64) NOT VALID;
ALTER TABLE "attachments" ADD CONSTRAINT "ck_attachments_thumbnail_key" CHECK (char_length("thumbnail_key") <= 512) NOT VALID;

-- audit_events
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_action" CHECK ("action" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length("action") <= 100) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_actor_name" CHECK (char_length("actor_name") <= 200) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_actor_type" CHECK ("actor_type" IN ('user', 'integration_token', 'system', 'anonymous')) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_ip_hash" CHECK ("ip_hash" ~ '^[0-9a-f]{32}$' AND char_length("ip_hash") <= 32) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_object_id" CHECK (char_length("object_id") <= 36) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_object_type" CHECK ("object_type" ~ '^[a-z][a-z0-9_]*$' AND char_length("object_type") <= 60) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_outcome" CHECK ("outcome" IN ('success', 'failure', 'denied')) NOT VALID;
ALTER TABLE "audit_events" ADD CONSTRAINT "ck_audit_events_request_id" CHECK (char_length("request_id") <= 64) NOT VALID;

-- auth_sessions
ALTER TABLE "auth_sessions" ADD CONSTRAINT "ck_auth_sessions_csrf_token_hash" CHECK ("csrf_token_hash" ~ '^[0-9a-f]{64}$' AND char_length("csrf_token_hash") <= 64) NOT VALID;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "ck_auth_sessions_ip_hash" CHECK ("ip_hash" ~ '^[0-9a-f]{32}$' AND char_length("ip_hash") <= 32) NOT VALID;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "ck_auth_sessions_location_label" CHECK (char_length("location_label") <= 120) NOT VALID;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "ck_auth_sessions_token_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$' AND char_length("token_hash") <= 64) NOT VALID;
ALTER TABLE "auth_sessions" ADD CONSTRAINT "ck_auth_sessions_ua_summary" CHECK (char_length("ua_summary") <= 26) NOT VALID;

-- auth_tokens
ALTER TABLE "auth_tokens" ADD CONSTRAINT "ck_auth_tokens_token_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$' AND char_length("token_hash") <= 64) NOT VALID;

-- availability_intervals
ALTER TABLE "availability_intervals" ADD CONSTRAINT "ck_availability_intervals_source" CHECK ("source" IN ('connection', 'reconciliation', 'manual')) NOT VALID;
ALTER TABLE "availability_intervals" ADD CONSTRAINT "ck_availability_intervals_status" CHECK ("status" IN ('online', 'away', 'invisible', 'offline')) NOT VALID;

-- bans
ALTER TABLE "bans" ADD CONSTRAINT "ck_bans_ip_masked" CHECK (char_length("ip_masked") <= 64) NOT VALID;
ALTER TABLE "bans" ADD CONSTRAINT "ck_bans_reason" CHECK (char_length("reason") <= 500) NOT VALID;

-- billing_accounts
ALTER TABLE "billing_accounts" ADD CONSTRAINT "ck_billing_accounts_provider_customer_id" CHECK (char_length("provider_customer_id") <= 255) NOT VALID;
ALTER TABLE "billing_accounts" ADD CONSTRAINT "ck_billing_accounts_provider_subscription_id" CHECK (char_length("provider_subscription_id") <= 255) NOT VALID;
ALTER TABLE "billing_accounts" ADD CONSTRAINT "ck_billing_accounts_state" CHECK (char_length("state") <= 64) NOT VALID;

-- billing_events
ALTER TABLE "billing_events" ADD CONSTRAINT "ck_billing_events_event_id" CHECK (char_length("event_id") <= 255) NOT VALID;
ALTER TABLE "billing_events" ADD CONSTRAINT "ck_billing_events_provider" CHECK (char_length("provider") <= 64) NOT VALID;
ALTER TABLE "billing_events" ADD CONSTRAINT "ck_billing_events_type" CHECK (char_length("type") <= 255) NOT VALID;

-- canned_replies
ALTER TABLE "canned_replies" ADD CONSTRAINT "ck_canned_replies_scope_key" CHECK (char_length("scope_key") <= 47) NOT VALID;
ALTER TABLE "canned_replies" ADD CONSTRAINT "ck_canned_replies_title" CHECK (char_length("title") <= 120) NOT VALID;

-- chats
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_close_reason" CHECK (char_length("close_reason") <= 100) NOT VALID;
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_closed_by_actor" CHECK ("closed_by_actor" IN ('agent', 'visitor', 'system')) NOT VALID;
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_last_message_preview" CHECK (char_length("last_message_preview") <= 140) NOT VALID;
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_page_url" CHECK (char_length("page_url") <= 2000) NOT VALID;
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_route_reason" CHECK ("route_reason" IN ('default', 'site_default', 'department_selected', 'invitation_accepted', 'trigger_override', 'max_wait_fallback')) NOT VALID;
ALTER TABLE "chats" ADD CONSTRAINT "ck_chats_started_by" CHECK ("started_by" IN ('visitor', 'invitation')) NOT VALID;

-- command_idempotency
ALTER TABLE "command_idempotency" ADD CONSTRAINT "ck_command_idempotency_actor_scope" CHECK (char_length("actor_scope") <= 100) NOT VALID;
ALTER TABLE "command_idempotency" ADD CONSTRAINT "ck_command_idempotency_key_hash" CHECK ("key_hash" ~ '^[0-9a-f]{64}$' AND char_length("key_hash") <= 64) NOT VALID;
ALTER TABLE "command_idempotency" ADD CONSTRAINT "ck_command_idempotency_request_hash" CHECK ("request_hash" ~ '^[0-9a-f]{64}$' AND char_length("request_hash") <= 64) NOT VALID;
ALTER TABLE "command_idempotency" ADD CONSTRAINT "ck_command_idempotency_route_key" CHECK (char_length("route_key") <= 200) NOT VALID;

-- consent_records
ALTER TABLE "consent_records" ADD CONSTRAINT "ck_consent_records_policy_version" CHECK (char_length("policy_version") <= 40) NOT VALID;
ALTER TABLE "consent_records" ADD CONSTRAINT "ck_consent_records_source" CHECK ("source" IN ('widget', 'widget_reset', 'handoff', 'sdk')) NOT VALID;

-- custom_field_definitions
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "ck_custom_field_definitions_label" CHECK (char_length("label") <= 80) NOT VALID;

-- departments
ALTER TABLE "departments" ADD CONSTRAINT "ck_departments_description" CHECK (char_length("description") <= 300) NOT VALID;
ALTER TABLE "departments" ADD CONSTRAINT "ck_departments_normalized_name" CHECK (char_length("normalized_name") <= 160) NOT VALID;
ALTER TABLE "departments" ADD CONSTRAINT "ck_departments_public_label" CHECK (char_length("public_label") <= 80) NOT VALID;

-- emergency_closures
ALTER TABLE "emergency_closures" ADD CONSTRAINT "ck_emergency_closures_reason" CHECK (char_length("reason") <= 300) NOT VALID;

-- exports
ALTER TABLE "exports" ADD CONSTRAINT "ck_exports_object_key" CHECK (char_length("object_key") <= 160) NOT VALID;
ALTER TABLE "exports" ADD CONSTRAINT "ck_exports_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$' AND char_length("sha256") <= 64) NOT VALID;
ALTER TABLE "exports" ADD CONSTRAINT "ck_exports_timezone" CHECK (char_length("timezone") <= 64) NOT VALID;
ALTER TABLE "exports" ADD CONSTRAINT "ck_exports_visitor_grant_hash" CHECK ("visitor_grant_hash" ~ '^[0-9a-f]{64}$' AND char_length("visitor_grant_hash") <= 64) NOT VALID;

-- identity_handoffs
ALTER TABLE "identity_handoffs" ADD CONSTRAINT "ck_identity_handoffs_destination_origin" CHECK ("destination_origin" ~ '^https?://[^/[:space:]]+$' AND char_length("destination_origin") <= 350) NOT VALID;
ALTER TABLE "identity_handoffs" ADD CONSTRAINT "ck_identity_handoffs_nonce_hash" CHECK ("nonce_hash" ~ '^[0-9a-f]{64}$' AND char_length("nonce_hash") <= 64) NOT VALID;

-- integration_credentials
ALTER TABLE "integration_credentials" ADD CONSTRAINT "ck_integration_credentials_kind" CHECK ("kind" IN ('api_token')) NOT VALID;
ALTER TABLE "integration_credentials" ADD CONSTRAINT "ck_integration_credentials_name" CHECK (char_length("name") <= 80) NOT VALID;
ALTER TABLE "integration_credentials" ADD CONSTRAINT "ck_integration_credentials_prefix" CHECK ("prefix" ~ '^rdt_[0-9a-f]{8}$' AND char_length("prefix") <= 12) NOT VALID;
ALTER TABLE "integration_credentials" ADD CONSTRAINT "ck_integration_credentials_secret_hash" CHECK ("secret_hash" ~ '^[0-9a-f]{64}$' AND char_length("secret_hash") <= 64) NOT VALID;

-- integration_mappings
ALTER TABLE "integration_mappings" ADD CONSTRAINT "ck_integration_mappings_external_id" CHECK (char_length("external_id") <= 255) NOT VALID;
ALTER TABLE "integration_mappings" ADD CONSTRAINT "ck_integration_mappings_provider" CHECK (char_length("provider") <= 64) NOT VALID;
ALTER TABLE "integration_mappings" ADD CONSTRAINT "ck_integration_mappings_source_type" CHECK ("source_type" IN ('chat', 'offline_submission')) NOT VALID;
ALTER TABLE "integration_mappings" ADD CONSTRAINT "ck_integration_mappings_status" CHECK ("status" IN ('active', 'erasure_pending_manual', 'erasure_requested', 'erased')) NOT VALID;

-- invitations
ALTER TABLE "invitations" ADD CONSTRAINT "ck_invitations_attribution" CHECK (char_length("attribution") <= 80) NOT VALID;
ALTER TABLE "invitations" ADD CONSTRAINT "ck_invitations_message" CHECK (char_length("message") <= 500) NOT VALID;
ALTER TABLE "invitations" ADD CONSTRAINT "ck_invitations_occurrence_key" CHECK (char_length("occurrence_key") <= 48) NOT VALID;

-- jobs
ALTER TABLE "jobs" ADD CONSTRAINT "ck_jobs_dedupe_key" CHECK (char_length("dedupe_key") <= 128) NOT VALID;
ALTER TABLE "jobs" ADD CONSTRAINT "ck_jobs_kind" CHECK ("kind" IN ('export', 'transcript_email', 'analytics.export', 'privacy.access', 'privacy.erase', 'tenant_deletion', 'consent_purge', 'visitor_merge')) NOT VALID;
ALTER TABLE "jobs" ADD CONSTRAINT "ck_jobs_last_error_code" CHECK ("last_error_code" ~ '^[A-Za-z][A-Za-z0-9_]*$' AND char_length("last_error_code") <= 64) NOT VALID;

-- memberships
ALTER TABLE "memberships" ADD CONSTRAINT "ck_memberships_display_name" CHECK (char_length("display_name") <= 120) NOT VALID;
ALTER TABLE "memberships" ADD CONSTRAINT "ck_memberships_title" CHECK (char_length("title") <= 80) NOT VALID;

-- messages
ALTER TABLE "messages" ADD CONSTRAINT "ck_messages_client_message_id" CHECK (char_length("client_message_id") <= 64) NOT VALID;
ALTER TABLE "messages" ADD CONSTRAINT "ck_messages_sender_name_snapshot" CHECK (char_length("sender_name_snapshot") <= 120) NOT VALID;

-- metric_chat_facts
ALTER TABLE "metric_chat_facts" ADD CONSTRAINT "ck_metric_chat_facts_close_reason" CHECK (char_length("close_reason") <= 100) NOT VALID;
ALTER TABLE "metric_chat_facts" ADD CONSTRAINT "ck_metric_chat_facts_started_by" CHECK ("started_by" IN ('visitor', 'invitation')) NOT VALID;

-- notifications
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_body" CHECK (char_length("body") <= 500) NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_link" CHECK (char_length("link") <= 60) NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_title" CHECK (char_length("title") <= 200) NOT VALID;
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_type" CHECK ("type" IN ('chat.assigned', 'chat.transfer_offered', 'chat.transferred', 'chat.transferred_away', 'offline.submitted', 'trigger.notify')) NOT VALID;

-- oauth_accounts
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "ck_oauth_accounts_provider" CHECK ("provider" IN ('google', 'github')) NOT VALID;
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "ck_oauth_accounts_provider_account_id" CHECK (char_length("provider_account_id") <= 255) NOT VALID;

-- offline_submissions
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_conversion_reason" CHECK ("conversion_reason" IN ('max_wait_exceeded', 'visitor_requested')) NOT VALID;
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_email_ciphertext" CHECK (char_length("email_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_email_lookup_hash" CHECK (char_length("email_lookup_hash") <= 64) NOT VALID;
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_name" CHECK (char_length("name") <= 120) NOT VALID;
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_reference" CHECK ("reference" ~ '^R-[0-9A-HJKMNP-TV-Z]{8}$' AND char_length("reference") <= 10) NOT VALID;
ALTER TABLE "offline_submissions" ADD CONSTRAINT "ck_offline_submissions_status" CHECK ("status" IN ('received', 'handled', 'exported', 'erased')) NOT VALID;

-- outbound_emails
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_dedupe_key" CHECK (char_length("dedupe_key") <= 600) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_html_body" CHECK (char_length("html_body") <= 10000000) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_last_error" CHECK (char_length("last_error") <= 500) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_provider_message_id" CHECK (char_length("provider_message_id") <= 255) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_recipient" CHECK (char_length("recipient") <= 320) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_status" CHECK ("status" IN ('queued', 'accepted', 'failed', 'cancelled', 'delivered')) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_subject" CHECK (char_length("subject") <= 1000) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_template" CHECK ("template" IN ('verify_email', 'password_reset', 'agent_invitation', 'transcript', 'offline_confirmation', 'offline_team_notification', 'offline_reply', 'weekly_report', 'export_ready', 'transcript_export', 'tenant_deletion_scheduled', 'tenant_deletion_cancelled')) NOT VALID;
ALTER TABLE "outbound_emails" ADD CONSTRAINT "ck_outbound_emails_text_body" CHECK (char_length("text_body") <= 10000000) NOT VALID;

-- outbox_events
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_aggregate_type" CHECK ("aggregate_type" ~ '^[a-z][a-z0-9_]*$' AND char_length("aggregate_type") <= 64) NOT VALID;
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_audience" CHECK ("audience" IN ('staff', 'public', 'internal')) NOT VALID;
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_event_type" CHECK ("event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$' AND char_length("event_type") <= 100) NOT VALID;
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_scope_id" CHECK (char_length("scope_id") <= 64) NOT VALID;
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_scope_kind" CHECK ("scope_kind" IN ('chat', 'queue', 'visitor', 'config', 'agent', 'team', 'tenant')) NOT VALID;
ALTER TABLE "outbox_events" ADD CONSTRAINT "ck_outbox_events_trace_parent" CHECK ("trace_parent" ~ '^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$' AND char_length("trace_parent") <= 55) NOT VALID;

-- page_events
ALTER TABLE "page_events" ADD CONSTRAINT "ck_page_events_client_event_id" CHECK (char_length("client_event_id") <= 64) NOT VALID;
ALTER TABLE "page_events" ADD CONSTRAINT "ck_page_events_sanitized_url" CHECK ("sanitized_url" ~ '^https?://' AND char_length("sanitized_url") <= 2000) NOT VALID;
ALTER TABLE "page_events" ADD CONSTRAINT "ck_page_events_title" CHECK (char_length("title") <= 200) NOT VALID;

-- privacy_requests
ALTER TABLE "privacy_requests" ADD CONSTRAINT "ck_privacy_requests_proof_reference" CHECK (char_length("proof_reference") <= 200) NOT VALID;

-- schedule_exceptions
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "ck_schedule_exceptions_reason" CHECK (char_length("reason") <= 200) NOT VALID;

-- schedules
ALTER TABLE "schedules" ADD CONSTRAINT "ck_schedules_name" CHECK (char_length("name") <= 120) NOT VALID;
ALTER TABLE "schedules" ADD CONSTRAINT "ck_schedules_timezone" CHECK ("timezone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$' AND char_length("timezone") <= 64) NOT VALID;

-- site_origins
ALTER TABLE "site_origins" ADD CONSTRAINT "ck_site_origins_origin" CHECK ("origin" ~ '^https?://[^/[:space:]]+$' AND char_length("origin") <= 350) NOT VALID;

-- sites
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_identity_secret_ciphertext" CHECK ("identity_secret_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("identity_secret_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_last_verified_origin" CHECK (char_length("last_verified_origin") <= 300) NOT VALID;
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_name" CHECK (char_length("name") <= 120) NOT VALID;
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_previous_public_key" CHECK (char_length("previous_public_key") <= 64) NOT VALID;
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_public_key" CHECK (char_length("public_key") <= 64) NOT VALID;
ALTER TABLE "sites" ADD CONSTRAINT "ck_sites_timezone" CHECK ("timezone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$' AND char_length("timezone") <= 64) NOT VALID;

-- subject_tombstones
ALTER TABLE "subject_tombstones" ADD CONSTRAINT "ck_subject_tombstones_subject_hash" CHECK ("subject_hash" ~ '^[vie]:[0-9a-f]{64}$' AND char_length("subject_hash") <= 66) NOT VALID;

-- tenant_tombstones
ALTER TABLE "tenant_tombstones" ADD CONSTRAINT "ck_tenant_tombstones_slug_hash" CHECK ("slug_hash" ~ '^[0-9a-f]{64}$' AND char_length("slug_hash") <= 64) NOT VALID;

-- tenants
ALTER TABLE "tenants" ADD CONSTRAINT "ck_tenants_timezone" CHECK ("timezone" ~ '^[A-Za-z][A-Za-z0-9_+/-]{0,63}$' AND char_length("timezone") <= 64) NOT VALID;

-- trigger_effects
ALTER TABLE "trigger_effects" ADD CONSTRAINT "ck_trigger_effects_action_type" CHECK ("action_type" IN ('set_department', 'set_priority', 'add_tag', 'remove_tag', 'send_public_message', 'display_invitation', 'set_visitor_field', 'notify_department', 'create_webhook_job', 'block_admission')) NOT VALID;
ALTER TABLE "trigger_effects" ADD CONSTRAINT "ck_trigger_effects_reason" CHECK ("reason" ~ '^[a-z][a-z0-9_]*$' AND char_length("reason") <= 100) NOT VALID;
ALTER TABLE "trigger_effects" ADD CONSTRAINT "ck_trigger_effects_status" CHECK ("status" IN ('pending', 'applied', 'skipped', 'suppressed', 'failed')) NOT VALID;

-- trigger_runs
ALTER TABLE "trigger_runs" ADD CONSTRAINT "ck_trigger_runs_event_type" CHECK ("event_type" IN ('visitor.session.started', 'visitor.page.changed', 'visitor.timer.elapsed', 'chat.requested', 'message.created', 'chat.queued', 'chat.closed', 'offline.submitted')) NOT VALID;

-- triggers
ALTER TABLE "triggers" ADD CONSTRAINT "ck_triggers_description" CHECK (char_length("description") <= 500) NOT VALID;
ALTER TABLE "triggers" ADD CONSTRAINT "ck_triggers_event_type" CHECK ("event_type" IN ('visitor.session.started', 'visitor.page.changed', 'visitor.timer.elapsed', 'chat.requested', 'message.created', 'chat.queued', 'chat.closed', 'offline.submitted')) NOT VALID;
ALTER TABLE "triggers" ADD CONSTRAINT "ck_triggers_name" CHECK (char_length("name") <= 120) NOT VALID;

-- trusted_devices
ALTER TABLE "trusted_devices" ADD CONSTRAINT "ck_trusted_devices_label" CHECK (char_length("label") <= 120) NOT VALID;
ALTER TABLE "trusted_devices" ADD CONSTRAINT "ck_trusted_devices_token_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$' AND char_length("token_hash") <= 64) NOT VALID;

-- users
ALTER TABLE "users" ADD CONSTRAINT "ck_users_avatar_url" CHECK (char_length("avatar_url") <= 2048) NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "ck_users_email" CHECK (char_length("email") <= 320) NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "ck_users_mfa_secret_ciphertext" CHECK ("mfa_secret_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("mfa_secret_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "users" ADD CONSTRAINT "ck_users_password_hash" CHECK (char_length("password_hash") <= 255) NOT VALID;

-- visitor_credentials
ALTER TABLE "visitor_credentials" ADD CONSTRAINT "ck_visitor_credentials_token_hash" CHECK ("token_hash" ~ '^[0-9a-f]{64}$' AND char_length("token_hash") <= 64) NOT VALID;

-- visitor_identities
ALTER TABLE "visitor_identities" ADD CONSTRAINT "ck_visitor_identities_subject_hash" CHECK ("subject_hash" ~ '^[0-9a-f]{64}$' AND char_length("subject_hash") <= 64) NOT VALID;
ALTER TABLE "visitor_identities" ADD CONSTRAINT "ck_visitor_identities_verification_method" CHECK ("verification_method" IN ('jwt_hs256')) NOT VALID;

-- visitor_sessions
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_analytics_consent" CHECK ("analytics_consent" IN ('unknown', 'granted', 'denied', 'withdrawn')) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_browser" CHECK (char_length("browser") <= 512) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_city" CHECK (char_length("city") <= 1000) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_current_title" CHECK (char_length("current_title") <= 200) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_current_url" CHECK ("current_url" ~ '^https?://' AND char_length("current_url") <= 2000) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_device_category" CHECK ("device_category" IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown')) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_landing_url" CHECK ("landing_url" ~ '^https?://' AND char_length("landing_url") <= 2000) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_os" CHECK (char_length("os") <= 512) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_referrer_origin" CHECK (char_length("referrer_origin") <= 300) NOT VALID;
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "ck_visitor_sessions_session_key_hash" CHECK ("session_key_hash" ~ '^[0-9a-f]{64}$' AND char_length("session_key_hash") <= 64) NOT VALID;

-- visitors
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_anonymous_label" CHECK (char_length("anonymous_label") <= 14) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_browser" CHECK (char_length("browser") <= 512) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_city" CHECK (char_length("city") <= 1000) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_country_code" CHECK (char_length("country_code") <= 2) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_device_category" CHECK ("device_category" IN ('desktop', 'mobile', 'tablet', 'bot', 'unknown')) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_email_ciphertext" CHECK ("email_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("email_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_email_lookup_hash" CHECK ("email_lookup_hash" ~ '^[0-9a-f]{64}$' AND char_length("email_lookup_hash") <= 64) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_language" CHECK (char_length("language") <= 20) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_name" CHECK (char_length("name") <= 100) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_notes" CHECK (char_length("notes") <= 5000) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_os" CHECK (char_length("os") <= 512) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_phone_ciphertext" CHECK ("phone_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("phone_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_region" CHECK (char_length("region") <= 255) NOT VALID;
ALTER TABLE "visitors" ADD CONSTRAINT "ck_visitors_timezone" CHECK (char_length("timezone") <= 60) NOT VALID;

-- webhook_deliveries
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "ck_webhook_deliveries_event_type" CHECK ("event_type" IN ('chat.requested', 'chat.started', 'chat.closed', 'rating.updated', 'offline.submitted', 'privacy.erased', 'trigger.webhook', 'webhook.test')) NOT VALID;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "ck_webhook_deliveries_last_error" CHECK (char_length("last_error") <= 300) NOT VALID;
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "ck_webhook_deliveries_status" CHECK ("status" IN ('pending', 'sending', 'retrying', 'delivered', 'failed', 'dead', 'cancelled')) NOT VALID;

-- webhook_endpoints
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "ck_webhook_endpoints_description" CHECK (char_length("description") <= 200) NOT VALID;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "ck_webhook_endpoints_previous_key_ciphertext" CHECK ("previous_key_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("previous_key_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "ck_webhook_endpoints_signing_key_ciphertext" CHECK ("signing_key_ciphertext" ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]*$' AND char_length("signing_key_ciphertext") <= 1024) NOT VALID;
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "ck_webhook_endpoints_url" CHECK (char_length("url") <= 4096) NOT VALID;

-- widget_configs
ALTER TABLE "widget_configs" ADD CONSTRAINT "ck_widget_configs_config_hash" CHECK ("config_hash" ~ '^[0-9a-f]{32}$' AND char_length("config_hash") <= 32) NOT VALID;

