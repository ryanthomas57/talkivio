-- Talkivio security migration: application role, RLS, composite tenant FKs,
-- constraints, search indexes and narrow SECURITY DEFINER entry points.
-- The migrating (owner) role must be able to create roles and should have BYPASSRLS
-- so the SECURITY DEFINER functions below can perform their narrow cross-tenant lookups.

-- ───────────────────────── Application role ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'talkivio_app_role') THEN
    CREATE ROLE talkivio_app_role NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO talkivio_app_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO talkivio_app_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO talkivio_app_role;
-- Conditional so the migration also applies to Prisma shadow databases (schema drift checks).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE _prisma_migrations FROM talkivio_app_role;
  END IF;
END $$;
-- Audit trail is append-only for the application.
REVOKE UPDATE, DELETE ON TABLE audit_events FROM talkivio_app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO talkivio_app_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO talkivio_app_role;

-- ───────────────────────── Tenant context helper ─────────────────────────
CREATE OR REPLACE FUNCTION rd_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ───────────────────────── Row level security ─────────────────────────
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants USING (id = rd_current_tenant()) WITH CHECK (id = rd_current_tenant());

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','agent_invitations','departments','department_members','agent_capacity','availability_intervals',
    'schedules','schedule_exceptions','emergency_closures','sites','site_origins','widget_configs','triggers',
    'trigger_revisions','trigger_runs','trigger_effects','canned_replies','visitors','visitor_credentials',
    'visitor_identities','visitor_sessions','page_events','consent_records','tags','visitor_tags',
    'custom_field_definitions','identity_handoffs','bans','chats','chat_participants','assignment_offers',
    'assignment_history','messages','message_attachments','attachments','chat_ratings','chat_tags','invitations',
    'offline_submissions','outbox_events','command_idempotency','jobs','exports','integration_credentials',
    'webhook_endpoints','webhook_deliveries','audit_events','notifications','metric_chat_facts','privacy_requests',
    'subject_tombstones','integration_mappings','billing_accounts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = rd_current_tenant()) WITH CHECK (tenant_id = rd_current_tenant())', t);
  END LOOP;
END $$;

-- ───────────────────────── Tenant foreign keys ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'memberships','agent_invitations','departments','department_members','agent_capacity','availability_intervals',
    'schedules','schedule_exceptions','emergency_closures','sites','site_origins','widget_configs','triggers',
    'trigger_revisions','trigger_runs','trigger_effects','canned_replies','visitors','visitor_credentials',
    'visitor_identities','visitor_sessions','page_events','consent_records','tags','visitor_tags',
    'custom_field_definitions','identity_handoffs','bans','chats','chat_participants','assignment_offers',
    'assignment_history','messages','message_attachments','attachments','chat_ratings','chat_tags','invitations',
    'offline_submissions','outbox_events','command_idempotency','jobs','exports','integration_credentials',
    'webhook_endpoints','webhook_deliveries','audit_events','notifications','metric_chat_facts','privacy_requests',
    'subject_tombstones','integration_mappings','billing_accounts'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE', t, t || '_tenant_fk');
  END LOOP;
END $$;

ALTER TABLE tenants ADD CONSTRAINT tenants_owner_fk FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;

-- Unique (tenant_id, id) targets for composite references not declared in Prisma.
ALTER TABLE trigger_runs ADD CONSTRAINT trigger_runs_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE jobs ADD CONSTRAINT jobs_tenant_id_key UNIQUE (tenant_id, id);
ALTER TABLE offline_submissions ADD CONSTRAINT offline_submissions_tenant_id_key UNIQUE (tenant_id, id);

-- Composite (tenant_id, x_id) references: cross-tenant references fail even if application validation is wrong.
ALTER TABLE departments
  ADD CONSTRAINT departments_schedule_fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES schedules(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT departments_fallback_fk FOREIGN KEY (tenant_id, fallback_department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE agent_capacity ADD CONSTRAINT agent_capacity_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE availability_intervals ADD CONSTRAINT availability_intervals_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE emergency_closures
  ADD CONSTRAINT emergency_closures_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT emergency_closures_department_fk FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE sites
  ADD CONSTRAINT sites_department_fk FOREIGN KEY (tenant_id, default_department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT sites_schedule_fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES schedules(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE trigger_runs ADD CONSTRAINT trigger_runs_trigger_fk FOREIGN KEY (tenant_id, trigger_id) REFERENCES triggers(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE trigger_effects ADD CONSTRAINT trigger_effects_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES trigger_runs(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE visitors ADD CONSTRAINT visitors_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE visitor_credentials ADD CONSTRAINT visitor_credentials_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE visitor_identities ADD CONSTRAINT visitor_identities_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE visitor_sessions
  ADD CONSTRAINT visitor_sessions_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT visitor_sessions_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE page_events ADD CONSTRAINT page_events_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES visitor_sessions(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE consent_records
  ADD CONSTRAINT consent_records_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE SET NULL (visitor_id),
  ADD CONSTRAINT consent_records_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES visitor_sessions(tenant_id, id) ON DELETE SET NULL (session_id);
ALTER TABLE visitor_tags ADD CONSTRAINT visitor_tags_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES tags(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE identity_handoffs
  ADD CONSTRAINT identity_handoffs_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT identity_handoffs_source_fk FOREIGN KEY (tenant_id, source_site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT identity_handoffs_destination_fk FOREIGN KEY (tenant_id, destination_site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE bans
  ADD CONSTRAINT bans_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT bans_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE chats
  ADD CONSTRAINT chats_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chats_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT chats_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES visitor_sessions(tenant_id, id) ON DELETE SET NULL (session_id),
  ADD CONSTRAINT chats_department_fk FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chats_acq_department_fk FOREIGN KEY (tenant_id, acquisition_department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT chats_owner_fk FOREIGN KEY (tenant_id, owner_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (owner_membership_id);
ALTER TABLE chat_participants
  ADD CONSTRAINT chat_participants_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (membership_id),
  ADD CONSTRAINT chat_participants_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE assignment_offers
  ADD CONSTRAINT assignment_offers_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT assignment_offers_department_fk FOREIGN KEY (tenant_id, target_department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE assignment_history ADD CONSTRAINT assignment_history_chat_fk FOREIGN KEY (tenant_id, chat_id) REFERENCES chats(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE messages
  ADD CONSTRAINT messages_sender_membership_fk FOREIGN KEY (tenant_id, sender_membership_id) REFERENCES memberships(tenant_id, id) ON DELETE SET NULL (sender_membership_id),
  ADD CONSTRAINT messages_sender_visitor_fk FOREIGN KEY (tenant_id, sender_visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE SET NULL (sender_visitor_id);
ALTER TABLE attachments ADD CONSTRAINT attachments_chat_fk FOREIGN KEY (tenant_id, chat_id) REFERENCES chats(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE chat_ratings ADD CONSTRAINT chat_ratings_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE chat_tags ADD CONSTRAINT chat_tags_tag_fk FOREIGN KEY (tenant_id, tag_id) REFERENCES tags(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE invitations
  ADD CONSTRAINT invitations_session_fk FOREIGN KEY (tenant_id, session_id) REFERENCES visitor_sessions(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT invitations_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT invitations_campaign_fk FOREIGN KEY (tenant_id, campaign_id) REFERENCES triggers(tenant_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT invitations_chat_fk FOREIGN KEY (tenant_id, accepted_chat_id) REFERENCES chats(tenant_id, id) ON DELETE SET NULL (accepted_chat_id);
ALTER TABLE offline_submissions
  ADD CONSTRAINT offline_submissions_site_fk FOREIGN KEY (tenant_id, site_id) REFERENCES sites(tenant_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT offline_submissions_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE SET NULL (visitor_id),
  ADD CONSTRAINT offline_submissions_department_fk FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE exports ADD CONSTRAINT exports_job_fk FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE notifications ADD CONSTRAINT notifications_membership_fk FOREIGN KEY (tenant_id, membership_id) REFERENCES memberships(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE metric_chat_facts ADD CONSTRAINT metric_chat_facts_chat_fk FOREIGN KEY (tenant_id, chat_id) REFERENCES chats(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE privacy_requests ADD CONSTRAINT privacy_requests_visitor_fk FOREIGN KEY (tenant_id, visitor_id) REFERENCES visitors(tenant_id, id) ON DELETE SET NULL (visitor_id);

-- ───────────────────────── Domain constraints ─────────────────────────
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slug_chk CHECK (slug ~ '^[a-z0-9-]{3,63}$'),
  ADD CONSTRAINT tenants_name_chk CHECK (char_length(name) BETWEEN 1 AND 120),
  ADD CONSTRAINT tenants_retention_chk CHECK (retention_days BETWEEN 1 AND 3650),
  ADD CONSTRAINT tenants_version_chk CHECK (version > 0);
CREATE UNIQUE INDEX tenants_slug_lower_idx ON tenants (lower(slug));
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
ALTER TABLE users ADD CONSTRAINT users_display_name_chk CHECK (char_length(display_name) BETWEEN 1 AND 120);
ALTER TABLE memberships
  ADD CONSTRAINT memberships_capacity_chk CHECK (capacity BETWEEN 1 AND 20),
  ADD CONSTRAINT memberships_version_chk CHECK (version > 0);
ALTER TABLE agent_invitations ADD CONSTRAINT agent_invitations_capacity_chk CHECK (capacity BETWEEN 1 AND 20);
ALTER TABLE departments
  ADD CONSTRAINT departments_queue_chk CHECK (queue_limit > 0 AND queue_limit <= 10000),
  ADD CONSTRAINT departments_wait_chk CHECK (max_wait_seconds >= 0 AND max_wait_seconds <= 86400),
  ADD CONSTRAINT departments_name_chk CHECK (char_length(name) BETWEEN 1 AND 80),
  ADD CONSTRAINT departments_no_self_fallback CHECK (fallback_department_id IS NULL OR fallback_department_id <> id);
CREATE UNIQUE INDEX departments_active_name_idx ON departments (tenant_id, normalized_name) WHERE archived_at IS NULL;
ALTER TABLE availability_intervals ADD CONSTRAINT availability_intervals_range_chk CHECK (ended_at IS NULL OR ended_at >= started_at);
ALTER TABLE emergency_closures
  ADD CONSTRAINT emergency_closures_range_chk CHECK (ends_at IS NULL OR ends_at > starts_at),
  ADD CONSTRAINT emergency_closures_scope_chk CHECK (num_nonnulls(site_id, department_id) <= 1);
ALTER TABLE site_origins ADD CONSTRAINT site_origins_pattern_chk CHECK (pattern_type IN ('exact', 'subdomain'));
ALTER TABLE triggers ADD CONSTRAINT triggers_priority_chk CHECK (priority BETWEEN 0 AND 1000);
ALTER TABLE canned_replies
  ADD CONSTRAINT canned_replies_body_chk CHECK (char_length(body) BETWEEN 1 AND 8000),
  ADD CONSTRAINT canned_replies_slug_chk CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
  ADD CONSTRAINT canned_replies_scope_chk CHECK ((scope_type = 'tenant' AND scope_id IS NULL) OR (scope_type <> 'tenant' AND scope_id IS NOT NULL));
ALTER TABLE tags
  ADD CONSTRAINT tags_slug_chk CHECK (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  ADD CONSTRAINT tags_label_chk CHECK (char_length(label) BETWEEN 1 AND 80);
ALTER TABLE custom_field_definitions
  ADD CONSTRAINT custom_fields_key_chk CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT custom_fields_type_chk CHECK (data_type IN ('string', 'number', 'boolean', 'date', 'enum'));
ALTER TABLE identity_handoffs ADD CONSTRAINT identity_handoffs_expiry_chk CHECK (expires_at <= created_at + interval '60 seconds');
ALTER TABLE bans ADD CONSTRAINT bans_target_chk CHECK (num_nonnulls(visitor_id, ip_match_hash) = 1);
ALTER TABLE visitor_sessions ADD CONSTRAINT visitor_sessions_range_chk CHECK (ended_at IS NULL OR ended_at >= started_at);
ALTER TABLE visitor_sessions ADD CONSTRAINT visitor_sessions_country_chk CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');
ALTER TABLE page_events ADD CONSTRAINT page_events_dwell_chk CHECK (dwell_ms IS NULL OR (dwell_ms >= 0 AND dwell_ms <= 86400000));
ALTER TABLE chats
  ADD CONSTRAINT chats_priority_chk CHECK (priority BETWEEN 0 AND 100),
  ADD CONSTRAINT chats_seq_chk CHECK (next_seq > 0),
  ADD CONSTRAINT chats_closed_chk CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  ADD CONSTRAINT chats_version_chk CHECK (version > 0);
ALTER TABLE chat_participants
  ADD CONSTRAINT chat_participants_identity_chk CHECK (
    (actor_type = 'visitor' AND membership_id IS NULL AND role = 'visitor') OR
    (actor_type = 'agent' AND visitor_id IS NULL AND role IN ('primary', 'collaborator'))
  ),
  ADD CONSTRAINT chat_participants_read_chk CHECK (last_read_seq >= 0 AND last_delivered_seq >= 0);
CREATE UNIQUE INDEX chat_participants_one_primary_idx ON chat_participants (tenant_id, chat_id) WHERE role = 'primary' AND left_at IS NULL;
CREATE UNIQUE INDEX chat_participants_active_agent_idx ON chat_participants (tenant_id, chat_id, membership_id) WHERE left_at IS NULL AND membership_id IS NOT NULL;
CREATE UNIQUE INDEX chat_participants_active_visitor_idx ON chat_participants (tenant_id, chat_id, visitor_id) WHERE left_at IS NULL AND visitor_id IS NOT NULL;
CREATE UNIQUE INDEX assignment_offers_live_target_idx ON assignment_offers (tenant_id, chat_id, membership_id) WHERE status = 'pending';
CREATE UNIQUE INDEX assignment_offers_single_assigned_idx ON assignment_offers (tenant_id, chat_id) WHERE status = 'pending' AND mode IN ('assigned', 'transfer');
ALTER TABLE messages
  ADD CONSTRAINT messages_seq_chk CHECK (seq > 0),
  ADD CONSTRAINT messages_body_chk CHECK (body IS NULL OR (char_length(body) <= 8000 AND octet_length(body) <= 32768)),
  ADD CONSTRAINT messages_sender_chk CHECK (
    (sender_type = 'agent' AND sender_visitor_id IS NULL) OR
    (sender_type = 'visitor' AND sender_membership_id IS NULL) OR
    (sender_type = 'system' AND sender_membership_id IS NULL AND sender_visitor_id IS NULL)
  ),
  ADD CONSTRAINT messages_visibility_chk CHECK (visibility = 'public' OR sender_type = 'agent');
ALTER TABLE message_attachments ADD CONSTRAINT message_attachments_ordinal_chk CHECK (ordinal BETWEEN 0 AND 4);
ALTER TABLE attachments ADD CONSTRAINT attachments_size_chk CHECK (size_bytes > 0);
ALTER TABLE chat_ratings ADD CONSTRAINT chat_ratings_comment_chk CHECK (comment IS NULL OR char_length(comment) <= 2000);
ALTER TABLE offline_submissions ADD CONSTRAINT offline_submissions_message_chk CHECK (char_length(message) BETWEEN 1 AND 8000);
ALTER TABLE command_idempotency ADD CONSTRAINT command_idempotency_state_chk CHECK (state IN ('processing', 'complete'));
ALTER TABLE webhook_deliveries ADD CONSTRAINT webhook_deliveries_excerpt_chk CHECK (response_excerpt IS NULL OR char_length(response_excerpt) <= 1000);

-- Full-text search on message bodies (tenant and permission filters are applied before ranking).
CREATE INDEX messages_body_fts_idx ON messages USING GIN (to_tsvector('simple', coalesce(body, '')));

-- ───────────────────────── Narrow SECURITY DEFINER entry points ─────────────────────────
CREATE OR REPLACE FUNCTION rd_resolve_site_key(p_key text)
RETURNS TABLE (tenant_id uuid, site_id uuid, active boolean, key_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.tenant_id, s.id,
         (s.enabled AND s.archived_at IS NULL AND t.status = 'active' AND t.deleted_at IS NULL),
         CASE WHEN s.public_key = p_key THEN 'current' ELSE 'previous' END
  FROM sites s JOIN tenants t ON t.id = s.tenant_id
  WHERE s.public_key = p_key OR (s.previous_public_key = p_key AND s.previous_key_expires_at > now())
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION rd_user_memberships(p_user uuid)
RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_name text, tenant_slug text, role text, enabled boolean, onboarding_completed boolean, plan text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.id, t.id, t.name, t.slug, m.role::text, m.enabled, t.onboarding_completed_at IS NOT NULL, t.plan::text
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = p_user AND m.archived_at IS NULL AND t.deleted_at IS NULL
  ORDER BY m.created_at
$$;

CREATE OR REPLACE FUNCTION rd_resolve_api_token(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, name text, scopes text[], enabled boolean, expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.tenant_id, c.name, c.scopes, c.enabled, c.expires_at, c.revoked_at, c.last_used_at
  FROM integration_credentials c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.secret_hash = p_hash AND t.deleted_at IS NULL AND t.status = 'active'
$$;

CREATE OR REPLACE FUNCTION rd_resolve_agent_invitation(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, email text, role text, expires_at timestamptz, accepted_at timestamptz, revoked_at timestamptz, tenant_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id, i.email, i.role::text, i.expires_at, i.accepted_at, i.revoked_at, t.name
  FROM agent_invitations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_hash AND t.deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION rd_active_tenants()
RETURNS TABLE (id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM tenants WHERE deleted_at IS NULL AND status <> 'deleting' ORDER BY id
$$;

-- Outbox claim for the single leased publisher (ordered by seq; caller sorts).
CREATE OR REPLACE FUNCTION rd_claim_outbox(p_limit int, p_lease_seconds int)
RETURNS SETOF outbox_events
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events o
     SET attempt_count = o.attempt_count + 1,
         available_at = now() + make_interval(secs => p_lease_seconds)
   WHERE o.seq IN (
     SELECT seq FROM outbox_events
      WHERE published_at IS NULL AND available_at <= now()
      ORDER BY seq
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING o.*
$$;

CREATE OR REPLACE FUNCTION rd_mark_outbox_published(p_seqs bigint[])
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  UPDATE outbox_events SET published_at = now() WHERE seq = ANY(p_seqs) AND published_at IS NULL
$$;

CREATE OR REPLACE FUNCTION rd_purge_outbox(p_older_than interval)
RETURNS bigint
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (DELETE FROM outbox_events WHERE published_at IS NOT NULL AND occurred_at < now() - p_older_than RETURNING 1)
  SELECT count(*) FROM d
$$;

CREATE OR REPLACE FUNCTION rd_slug_taken(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE lower(slug) = lower(p_slug))
$$;

CREATE OR REPLACE FUNCTION rd_tenant_by_billing_customer(p_customer text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM billing_accounts WHERE provider_customer_id = p_customer LIMIT 1
$$;

-- Low-latency outbox wake-up for publishers (LISTEN rd_outbox).
CREATE OR REPLACE FUNCTION rd_outbox_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('rd_outbox', NEW.seq::text);
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION rd_outbox_notify();

REVOKE ALL ON FUNCTION rd_resolve_site_key(text), rd_user_memberships(uuid), rd_resolve_api_token(text),
  rd_resolve_agent_invitation(text), rd_active_tenants(), rd_claim_outbox(int, int), rd_mark_outbox_published(bigint[]),
  rd_purge_outbox(interval), rd_tenant_by_billing_customer(text), rd_slug_taken(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rd_current_tenant(), rd_resolve_site_key(text), rd_user_memberships(uuid), rd_resolve_api_token(text),
  rd_resolve_agent_invitation(text), rd_active_tenants(), rd_claim_outbox(int, int), rd_mark_outbox_published(bigint[]),
  rd_purge_outbox(interval), rd_tenant_by_billing_customer(text), rd_slug_taken(text) TO talkivio_app_role;
