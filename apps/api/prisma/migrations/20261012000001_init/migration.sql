-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'admin', 'supervisor', 'agent', 'analyst');

-- CreateEnum
CREATE TYPE "DesiredStatus" AS ENUM ('online', 'away', 'invisible');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('active', 'suspended', 'deleting');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('verify', 'reset', 'invite', 'recovery', 'oauth_state', 'mfa_challenge');

-- CreateEnum
CREATE TYPE "RoutingMode" AS ENUM ('manual', 'broadcast', 'assigned');

-- CreateEnum
CREATE TYPE "ChatStatus" AS ENUM ('queued', 'offered', 'active', 'closed');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('primary', 'collaborator', 'visitor');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('visitor', 'agent', 'system');

-- CreateEnum
CREATE TYPE "OfferMode" AS ENUM ('broadcast', 'assigned', 'transfer');

-- CreateEnum
CREATE TYPE "OfferStatus" AS ENUM ('pending', 'accepted', 'declined', 'expired', 'withdrawn');

-- CreateEnum
CREATE TYPE "MessageVisibility" AS ENUM ('public', 'internal');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('text', 'attachment', 'system');

-- CreateEnum
CREATE TYPE "AttachmentState" AS ENUM ('initiated', 'uploading', 'uploaded', 'scanning', 'clean', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "RatingValue" AS ENUM ('good', 'bad');

-- CreateEnum
CREATE TYPE "ScopeType" AS ENUM ('tenant', 'department', 'personal');

-- CreateEnum
CREATE TYPE "InvitationState" AS ENUM ('eligible', 'displayed', 'accepted', 'dismissed', 'expired');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('service', 'analytics');

-- CreateEnum
CREATE TYPE "ConsentState" AS ENUM ('granted', 'denied', 'withdrawn');

-- CreateEnum
CREATE TYPE "PageEventKind" AS ENUM ('entered', 'left', 'visible', 'hidden');

-- CreateEnum
CREATE TYPE "TagSource" AS ENUM ('client', 'agent', 'trigger', 'integration');

-- CreateEnum
CREATE TYPE "JobState" AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "ExportFormat" AS ENUM ('txt', 'json', 'csv', 'pdf');

-- CreateEnum
CREATE TYPE "PrivacyKind" AS ENUM ('access', 'erase');

-- CreateEnum
CREATE TYPE "PrivacyState" AS ENUM ('pending_verification', 'queued', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('starter', 'team', 'business', 'enterprise');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "password_hash" TEXT,
    "avatar_url" TEXT,
    "email_verified_at" TIMESTAMPTZ(3),
    "mfa_secret_ciphertext" TEXT,
    "mfa_key_version" INTEGER,
    "mfa_enabled_at" TIMESTAMPTZ(3),
    "mfa_recovery_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "disabled_at" TIMESTAMPTZ(3),
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "active_tenant_id" UUID,
    "mfa_verified" BOOLEAN NOT NULL DEFAULT false,
    "recent_auth_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "ua_summary" TEXT,
    "ip_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "tenant_id" UUID,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "dedupe_key" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text_body" TEXT NOT NULL,
    "html_body" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "provider_message_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "accepted_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "owner_user_id" UUID NOT NULL,
    "retention_days" INTEGER NOT NULL DEFAULT 180,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "chat_counter" INTEGER NOT NULL DEFAULT 0,
    "submission_counter" INTEGER NOT NULL DEFAULT 0,
    "onboarding_state" JSONB NOT NULL DEFAULT '{}',
    "onboarding_completed_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "desired_status" "DesiredStatus" NOT NULL DEFAULT 'online',
    "status_changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "display_name" TEXT,
    "title" TEXT,
    "preferences" JSONB NOT NULL DEFAULT '{}',
    "last_assignment_at" TIMESTAMPTZ(3),
    "last_seen_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',
    "department_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "agent_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "public_label" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "schedule_id" UUID,
    "routing_mode" "RoutingMode" NOT NULL DEFAULT 'broadcast',
    "queue_limit" INTEGER NOT NULL DEFAULT 1000,
    "max_wait_seconds" INTEGER NOT NULL DEFAULT 300,
    "fallback_department_id" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "department_members" (
    "tenant_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "can_serve" BOOLEAN NOT NULL DEFAULT true,
    "can_monitor" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_members_pkey" PRIMARY KEY ("tenant_id","department_id","membership_id")
);

-- CreateTable
CREATE TABLE "agent_capacity" (
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_capacity_pkey" PRIMARY KEY ("tenant_id","membership_id")
);

-- CreateTable
CREATE TABLE "availability_intervals" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "source" TEXT NOT NULL,

    CONSTRAINT "availability_intervals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "weekly_intervals" JSONB NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_exceptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "schedule_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "intervals" JSONB NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_closures" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "department_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ends_at" TIMESTAMPTZ(3),
    "reason" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_closures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "previous_public_key" TEXT,
    "previous_key_expires_at" TIMESTAMPTZ(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config_revision" INTEGER NOT NULL DEFAULT 0,
    "default_department_id" UUID,
    "schedule_id" UUID,
    "timezone" TEXT,
    "identity_secret_ciphertext" TEXT,
    "identity_key_version" INTEGER,
    "installed_at" TIMESTAMPTZ(3),
    "last_verified_at" TIMESTAMPTZ(3),
    "last_verified_origin" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_origins" (
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "pattern_type" TEXT NOT NULL DEFAULT 'exact',
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "site_origins_pkey" PRIMARY KEY ("tenant_id","site_id","origin")
);

-- CreateTable
CREATE TABLE "widget_configs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "config_hash" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "triggers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "event_type" TEXT NOT NULL,
    "current_revision" INTEGER NOT NULL DEFAULT 1,
    "published_revision" INTEGER,
    "last_matched_at" TIMESTAMPTZ(3),
    "match_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_revisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "dsl_version" INTEGER NOT NULL DEFAULT 1,
    "definition" JSONB NOT NULL,
    "published_by" UUID,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trigger_id" UUID NOT NULL,
    "trigger_revision" INTEGER NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "visitor_session_id" UUID,
    "visitor_id" UUID,
    "chat_id" UUID,
    "matched" BOOLEAN NOT NULL,
    "result" JSONB NOT NULL,
    "causation_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "executed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trigger_effects" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "action_index" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reason" TEXT,
    "executed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trigger_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "canned_replies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "scope_type" "ScopeType" NOT NULL,
    "scope_id" UUID,
    "scope_key" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "canned_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "anonymous_label" TEXT NOT NULL,
    "name" TEXT,
    "email_ciphertext" TEXT,
    "email_lookup_hash" TEXT,
    "phone_ciphertext" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "notes" TEXT,
    "country_code" TEXT,
    "region" TEXT,
    "city" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "device_category" TEXT,
    "language" TEXT,
    "timezone" TEXT,
    "visit_count" INTEGER NOT NULL DEFAULT 0,
    "chat_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "visitors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_identities" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "issuer_id" UUID NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "verification_method" TEXT NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "session_key_hash" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ(3),
    "analytics_consent" TEXT NOT NULL DEFAULT 'unknown',
    "current_url" TEXT,
    "current_title" TEXT,
    "referrer_origin" TEXT,
    "landing_url" TEXT,
    "utm" JSONB,
    "device_category" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "country" TEXT,
    "city" TEXT,
    "page_view_count" INTEGER NOT NULL DEFAULT 0,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "page_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "client_event_id" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "client_at" TIMESTAMPTZ(3),
    "kind" "PageEventKind" NOT NULL,
    "sanitized_url" TEXT NOT NULL,
    "title" TEXT,
    "dwell_ms" BIGINT,

    CONSTRAINT "page_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID,
    "session_id" UUID,
    "purpose" "ConsentPurpose" NOT NULL,
    "state" "ConsentState" NOT NULL,
    "policy_version" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_tags" (
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "source" "TagSource" NOT NULL,
    "added_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "visitor_tags_pkey" PRIMARY KEY ("tenant_id","visitor_id","tag_id")
);

-- CreateTable
CREATE TABLE "custom_field_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,
    "public_writable" BOOLEAN NOT NULL DEFAULT false,
    "visible_to_visitor" BOOLEAN NOT NULL DEFAULT false,
    "validation" JSONB NOT NULL DEFAULT '{}',
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "custom_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_handoffs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "nonce_hash" TEXT NOT NULL,
    "visitor_id" UUID NOT NULL,
    "source_site_id" UUID NOT NULL,
    "destination_site_id" UUID NOT NULL,
    "destination_origin" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "redeemed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_handoffs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID,
    "visitor_id" UUID,
    "ip_match_hash" TEXT,
    "ip_masked" TEXT,
    "reason" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_by" UUID NOT NULL,
    "revoked_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chats" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "site_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "session_id" UUID,
    "department_id" UUID,
    "acquisition_department_id" UUID,
    "owner_membership_id" UUID,
    "status" "ChatStatus" NOT NULL DEFAULT 'queued',
    "started_by" TEXT NOT NULL DEFAULT 'visitor',
    "route_reason" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 50,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "first_assigned_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "closed_by_actor" TEXT,
    "closed_by_id" UUID,
    "next_seq" BIGINT NOT NULL DEFAULT 1,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_message_preview" TEXT NOT NULL DEFAULT '',
    "last_public_sender_type" "ActorType",
    "last_visitor_message_at" TIMESTAMPTZ(3),
    "last_agent_reply_at" TIMESTAMPTZ(3),
    "visitor_disconnected_at" TIMESTAMPTZ(3),
    "page_url" TEXT,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_participants" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "visitor_id" UUID,
    "membership_id" UUID,
    "role" "ParticipantRole" NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "last_read_seq" BIGINT NOT NULL DEFAULT 0,
    "last_delivered_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_offers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "membership_id" UUID,
    "from_membership_id" UUID,
    "target_department_id" UUID,
    "mode" "OfferMode" NOT NULL,
    "status" "OfferStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "assignment_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignment_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "previous_owner_id" UUID,
    "next_owner_id" UUID,
    "previous_department_id" UUID,
    "next_department_id" UUID,
    "reason" TEXT NOT NULL,
    "route_revision" INTEGER NOT NULL DEFAULT 0,
    "decision" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "seq" BIGINT NOT NULL,
    "client_message_id" TEXT,
    "sender_type" "ActorType" NOT NULL,
    "sender_membership_id" UUID,
    "sender_visitor_id" UUID,
    "sender_name_snapshot" TEXT NOT NULL,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "MessageVisibility" NOT NULL DEFAULT 'public',
    "type" "MessageType" NOT NULL DEFAULT 'text',
    "body" TEXT,
    "system_event" JSONB,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reply_id" UUID,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(3),
    "redacted_at" TIMESTAMPTZ(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "attachment_id" UUID NOT NULL,
    "ordinal" INTEGER NOT NULL,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("tenant_id","message_id","attachment_id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID,
    "uploaded_by_actor" "ActorType" NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "thumbnail_key" TEXT,
    "original_name" TEXT NOT NULL,
    "declared_mime" TEXT NOT NULL,
    "detected_mime" TEXT,
    "size_bytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "state" "AttachmentState" NOT NULL DEFAULT 'initiated',
    "scan_result" TEXT,
    "reject_reason" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_ratings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "rating" "RatingValue" NOT NULL,
    "comment" TEXT,
    "submitted_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revised_at" TIMESTAMPTZ(3),
    "revision_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "chat_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_tags" (
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "source" "TagSource" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_tags_pkey" PRIMARY KEY ("tenant_id","chat_id","tag_id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "visitor_id" UUID NOT NULL,
    "occurrence_key" TEXT NOT NULL,
    "state" "InvitationState" NOT NULL DEFAULT 'eligible',
    "message" TEXT NOT NULL,
    "attribution" TEXT NOT NULL,
    "department_id" UUID,
    "displayed_at" TIMESTAMPTZ(3),
    "accepted_chat_id" UUID,
    "dismissed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_submissions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "visitor_id" UUID,
    "session_id" UUID,
    "department_id" UUID,
    "reference" TEXT NOT NULL,
    "name" TEXT,
    "email_ciphertext" TEXT NOT NULL,
    "email_lookup_hash" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "custom_fields" JSONB NOT NULL DEFAULT '{}',
    "source_chat_id" UUID,
    "conversion_reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "handled_at" TIMESTAMPTZ(3),
    "handled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "offline_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "seq" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "scope_kind" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'staff',
    "payload" JSONB NOT NULL,
    "causation_id" UUID,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(3),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("seq")
);

-- CreateTable
CREATE TABLE "command_idempotency" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_scope" TEXT NOT NULL,
    "route_key" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'processing',
    "response_status" INTEGER,
    "response_body" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_idempotency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "state" "JobState" NOT NULL DEFAULT 'queued',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "progress" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_until" TIMESTAMPTZ(3),
    "last_error_code" TEXT,
    "requested_by" UUID,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exports" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "requested_by" UUID,
    "visitor_grant_hash" TEXT,
    "format" "ExportFormat" NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "include_internal" BOOLEAN NOT NULL DEFAULT false,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "job_id" UUID NOT NULL,
    "object_key" TEXT,
    "sha256" TEXT,
    "size_bytes" BIGINT,
    "item_count" INTEGER,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "erased_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'api_token',
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "rotated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "signing_key_ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "previous_key_ciphertext" TEXT,
    "previous_key_expires_at" TIMESTAMPTZ(3),
    "event_types" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_success_at" TIMESTAMPTZ(3),
    "failure_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response_status" INTEGER,
    "response_excerpt" TEXT,
    "last_error" TEXT,
    "duration_ms" INTEGER,
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" UUID,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT,
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "safe_diff" JSONB,
    "request_id" TEXT,
    "ip_hash" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "membership_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_chat_facts" (
    "tenant_id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "department_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "first_assigned_at" TIMESTAMPTZ(3),
    "first_response_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "close_reason" TEXT,
    "served" BOOLEAN NOT NULL DEFAULT false,
    "missed" BOOLEAN NOT NULL DEFAULT false,
    "abandoned" BOOLEAN NOT NULL DEFAULT false,
    "rating" "RatingValue",
    "owner_membership_id" UUID,
    "started_by" TEXT NOT NULL DEFAULT 'visitor',
    "dimension_snapshot" JSONB NOT NULL DEFAULT '{}',
    "source_version" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_chat_facts_pkey" PRIMARY KEY ("tenant_id","chat_id")
);

-- CreateTable
CREATE TABLE "privacy_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "visitor_id" UUID,
    "kind" "PrivacyKind" NOT NULL,
    "requested_by" UUID,
    "state" "PrivacyState" NOT NULL DEFAULT 'pending_verification',
    "proof_reference" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "report" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "privacy_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subject_tombstones" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_hash" TEXT NOT NULL,
    "erasure_request_id" UUID NOT NULL,
    "erased_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subject_tombstones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_mappings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "last_synced_revision" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_accounts" (
    "tenant_id" UUID NOT NULL,
    "provider_customer_id" TEXT,
    "state" TEXT NOT NULL DEFAULT 'active',
    "plan" "Plan" NOT NULL DEFAULT 'starter',
    "seats" INTEGER NOT NULL DEFAULT 10,
    "provider_subscription_id" TEXT,
    "current_period_end" TIMESTAMPTZ(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "trial_ends_at" TIMESTAMPTZ(3),
    "grace_ends_at" TIMESTAMPTZ(3),
    "provider_revision" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tenant_id" UUID,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_token_hash_key" ON "auth_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_expires_at_idx" ON "auth_sessions"("user_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_token_hash_key" ON "auth_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "auth_tokens_user_id_purpose_idx" ON "auth_tokens"("user_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_provider_account_id_key" ON "oauth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_devices_token_hash_key" ON "trusted_devices"("token_hash");

-- CreateIndex
CREATE INDEX "trusted_devices_user_id_idx" ON "trusted_devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_dedupe_key_key" ON "outbound_emails"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbound_emails_created_at_idx" ON "outbound_emails"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE INDEX "memberships_tenant_id_enabled_role_id_idx" ON "memberships"("tenant_id", "enabled", "role", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_id_key" ON "memberships"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_tenant_id_user_id_key" ON "memberships"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "agent_invitations_token_hash_key" ON "agent_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "agent_invitations_tenant_id_email_idx" ON "agent_invitations"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "departments_tenant_id_enabled_id_idx" ON "departments"("tenant_id", "enabled", "id");

-- CreateIndex
CREATE UNIQUE INDEX "departments_tenant_id_id_key" ON "departments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "department_members_tenant_id_membership_id_department_id_idx" ON "department_members"("tenant_id", "membership_id", "department_id");

-- CreateIndex
CREATE INDEX "availability_intervals_tenant_id_membership_id_started_at_idx" ON "availability_intervals"("tenant_id", "membership_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_tenant_id_id_key" ON "schedules"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_exceptions_tenant_id_schedule_id_local_date_key" ON "schedule_exceptions"("tenant_id", "schedule_id", "local_date");

-- CreateIndex
CREATE INDEX "emergency_closures_tenant_id_starts_at_ends_at_idx" ON "emergency_closures"("tenant_id", "starts_at", "ends_at");

-- CreateIndex
CREATE UNIQUE INDEX "sites_public_key_key" ON "sites"("public_key");

-- CreateIndex
CREATE UNIQUE INDEX "sites_previous_public_key_key" ON "sites"("previous_public_key");

-- CreateIndex
CREATE INDEX "sites_tenant_id_enabled_id_idx" ON "sites"("tenant_id", "enabled", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sites_tenant_id_id_key" ON "sites"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "site_origins_tenant_id_origin_idx" ON "site_origins"("tenant_id", "origin");

-- CreateIndex
CREATE INDEX "widget_configs_tenant_id_site_id_published_at_idx" ON "widget_configs"("tenant_id", "site_id", "published_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "widget_configs_tenant_id_site_id_revision_key" ON "widget_configs"("tenant_id", "site_id", "revision");

-- CreateIndex
CREATE INDEX "triggers_tenant_id_event_type_enabled_priority_id_idx" ON "triggers"("tenant_id", "event_type", "enabled", "priority" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "triggers_tenant_id_id_key" ON "triggers"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "trigger_revisions_tenant_id_trigger_id_revision_key" ON "trigger_revisions"("tenant_id", "trigger_id", "revision");

-- CreateIndex
CREATE INDEX "trigger_runs_tenant_id_trigger_id_executed_at_idx" ON "trigger_runs"("tenant_id", "trigger_id", "executed_at" DESC);

-- CreateIndex
CREATE INDEX "trigger_runs_tenant_id_visitor_session_id_trigger_id_idx" ON "trigger_runs"("tenant_id", "visitor_session_id", "trigger_id");

-- CreateIndex
CREATE UNIQUE INDEX "trigger_runs_tenant_id_trigger_id_trigger_revision_event_id_key" ON "trigger_runs"("tenant_id", "trigger_id", "trigger_revision", "event_id");

-- CreateIndex
CREATE UNIQUE INDEX "trigger_effects_tenant_id_run_id_action_index_key" ON "trigger_effects"("tenant_id", "run_id", "action_index");

-- CreateIndex
CREATE INDEX "canned_replies_tenant_id_scope_type_enabled_id_idx" ON "canned_replies"("tenant_id", "scope_type", "enabled", "id");

-- CreateIndex
CREATE UNIQUE INDEX "canned_replies_tenant_id_scope_key_slug_key" ON "canned_replies"("tenant_id", "scope_key", "slug");

-- CreateIndex
CREATE INDEX "visitors_tenant_id_last_seen_at_id_idx" ON "visitors"("tenant_id", "last_seen_at" DESC, "id");

-- CreateIndex
CREATE INDEX "visitors_tenant_id_email_lookup_hash_idx" ON "visitors"("tenant_id", "email_lookup_hash");

-- CreateIndex
CREATE UNIQUE INDEX "visitors_tenant_id_id_key" ON "visitors"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_credentials_token_hash_key" ON "visitor_credentials"("token_hash");

-- CreateIndex
CREATE INDEX "visitor_credentials_tenant_id_visitor_id_idx" ON "visitor_credentials"("tenant_id", "visitor_id");

-- CreateIndex
CREATE INDEX "visitor_identities_tenant_id_visitor_id_idx" ON "visitor_identities"("tenant_id", "visitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_identities_tenant_id_issuer_id_subject_hash_key" ON "visitor_identities"("tenant_id", "issuer_id", "subject_hash");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_session_key_hash_key" ON "visitor_sessions"("session_key_hash");

-- CreateIndex
CREATE INDEX "visitor_sessions_tenant_id_site_id_last_seen_at_id_idx" ON "visitor_sessions"("tenant_id", "site_id", "last_seen_at" DESC, "id");

-- CreateIndex
CREATE INDEX "visitor_sessions_tenant_id_visitor_id_started_at_idx" ON "visitor_sessions"("tenant_id", "visitor_id", "started_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_tenant_id_id_key" ON "visitor_sessions"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "page_events_tenant_id_session_id_received_at_id_idx" ON "page_events"("tenant_id", "session_id", "received_at", "id");

-- CreateIndex
CREATE INDEX "page_events_tenant_id_received_at_idx" ON "page_events"("tenant_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "page_events_tenant_id_session_id_client_event_id_key" ON "page_events"("tenant_id", "session_id", "client_event_id");

-- CreateIndex
CREATE INDEX "consent_records_tenant_id_visitor_id_purpose_recorded_at_idx" ON "consent_records"("tenant_id", "visitor_id", "purpose", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "tags_tenant_id_archived_at_slug_idx" ON "tags"("tenant_id", "archived_at", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_id_key" ON "tags"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_slug_key" ON "tags"("tenant_id", "slug");

-- CreateIndex
CREATE INDEX "visitor_tags_tenant_id_tag_id_visitor_id_idx" ON "visitor_tags"("tenant_id", "tag_id", "visitor_id");

-- CreateIndex
CREATE UNIQUE INDEX "custom_field_definitions_tenant_id_key_key" ON "custom_field_definitions"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "identity_handoffs_nonce_hash_key" ON "identity_handoffs"("nonce_hash");

-- CreateIndex
CREATE INDEX "identity_handoffs_expires_at_idx" ON "identity_handoffs"("expires_at");

-- CreateIndex
CREATE INDEX "bans_tenant_id_visitor_id_revoked_at_expires_at_idx" ON "bans"("tenant_id", "visitor_id", "revoked_at", "expires_at");

-- CreateIndex
CREATE INDEX "bans_tenant_id_ip_match_hash_idx" ON "bans"("tenant_id", "ip_match_hash");

-- CreateIndex
CREATE INDEX "chats_tenant_id_status_department_id_priority_requested_at__idx" ON "chats"("tenant_id", "status", "department_id", "priority" DESC, "requested_at", "id");

-- CreateIndex
CREATE INDEX "chats_tenant_id_visitor_id_requested_at_id_idx" ON "chats"("tenant_id", "visitor_id", "requested_at" DESC, "id");

-- CreateIndex
CREATE INDEX "chats_tenant_id_owner_membership_id_status_idx" ON "chats"("tenant_id", "owner_membership_id", "status");

-- CreateIndex
CREATE INDEX "chats_tenant_id_requested_at_id_idx" ON "chats"("tenant_id", "requested_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chats_tenant_id_id_key" ON "chats"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chats_tenant_id_number_key" ON "chats"("tenant_id", "number");

-- CreateIndex
CREATE INDEX "chat_participants_tenant_id_chat_id_left_at_idx" ON "chat_participants"("tenant_id", "chat_id", "left_at");

-- CreateIndex
CREATE INDEX "chat_participants_tenant_id_membership_id_left_at_idx" ON "chat_participants"("tenant_id", "membership_id", "left_at");

-- CreateIndex
CREATE UNIQUE INDEX "chat_participants_tenant_id_id_key" ON "chat_participants"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "assignment_offers_tenant_id_membership_id_status_expires_at_idx" ON "assignment_offers"("tenant_id", "membership_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "assignment_offers_tenant_id_status_expires_at_idx" ON "assignment_offers"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "assignment_offers_tenant_id_chat_id_status_idx" ON "assignment_offers"("tenant_id", "chat_id", "status");

-- CreateIndex
CREATE INDEX "assignment_history_tenant_id_chat_id_occurred_at_id_idx" ON "assignment_history"("tenant_id", "chat_id", "occurred_at", "id");

-- CreateIndex
CREATE INDEX "assignment_history_tenant_id_next_owner_id_occurred_at_idx" ON "assignment_history"("tenant_id", "next_owner_id", "occurred_at");

-- CreateIndex
CREATE INDEX "messages_tenant_id_sent_at_idx" ON "messages"("tenant_id", "sent_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_id_key" ON "messages"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_chat_id_seq_key" ON "messages"("tenant_id", "chat_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_tenant_id_chat_id_client_message_id_key" ON "messages"("tenant_id", "chat_id", "client_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_tenant_id_message_id_ordinal_key" ON "message_attachments"("tenant_id", "message_id", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_object_key_key" ON "attachments"("object_key");

-- CreateIndex
CREATE INDEX "attachments_tenant_id_chat_id_state_id_idx" ON "attachments"("tenant_id", "chat_id", "state", "id");

-- CreateIndex
CREATE INDEX "attachments_state_updated_at_idx" ON "attachments"("state", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_tenant_id_id_key" ON "attachments"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "chat_ratings_tenant_id_rating_submitted_at_id_idx" ON "chat_ratings"("tenant_id", "rating", "submitted_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_ratings_tenant_id_chat_id_key" ON "chat_ratings"("tenant_id", "chat_id");

-- CreateIndex
CREATE INDEX "chat_tags_tenant_id_tag_id_chat_id_idx" ON "chat_tags"("tenant_id", "tag_id", "chat_id");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_campaign_id_created_at_idx" ON "invitations"("tenant_id", "campaign_id", "created_at");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_visitor_id_dismissed_at_idx" ON "invitations"("tenant_id", "visitor_id", "dismissed_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tenant_id_session_id_occurrence_key_key" ON "invitations"("tenant_id", "session_id", "occurrence_key");

-- CreateIndex
CREATE INDEX "offline_submissions_tenant_id_created_at_id_idx" ON "offline_submissions"("tenant_id", "created_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "offline_submissions_tenant_id_reference_key" ON "offline_submissions"("tenant_id", "reference");

-- CreateIndex
CREATE INDEX "outbox_events_tenant_id_scope_kind_scope_id_seq_idx" ON "outbox_events"("tenant_id", "scope_kind", "scope_id", "seq");

-- CreateIndex
CREATE INDEX "outbox_events_published_at_seq_idx" ON "outbox_events"("published_at", "seq");

-- CreateIndex
CREATE INDEX "outbox_events_occurred_at_idx" ON "outbox_events"("occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_event_id_scope_kind_scope_id_audience_key" ON "outbox_events"("event_id", "scope_kind", "scope_id", "audience");

-- CreateIndex
CREATE INDEX "command_idempotency_expires_at_idx" ON "command_idempotency"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "command_idempotency_tenant_id_actor_scope_route_key_key_has_key" ON "command_idempotency"("tenant_id", "actor_scope", "route_key", "key_hash");

-- CreateIndex
CREATE INDEX "jobs_state_run_after_id_idx" ON "jobs"("state", "run_after", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_tenant_id_kind_dedupe_key_key" ON "jobs"("tenant_id", "kind", "dedupe_key");

-- CreateIndex
CREATE INDEX "exports_tenant_id_requested_by_created_at_id_idx" ON "exports"("tenant_id", "requested_by", "created_at" DESC, "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_secret_hash_key" ON "integration_credentials"("secret_hash");

-- CreateIndex
CREATE INDEX "integration_credentials_tenant_id_kind_enabled_id_idx" ON "integration_credentials"("tenant_id", "kind", "enabled", "id");

-- CreateIndex
CREATE INDEX "webhook_endpoints_tenant_id_enabled_id_idx" ON "webhook_endpoints"("tenant_id", "enabled", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_endpoints_tenant_id_id_key" ON "webhook_endpoints"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_id_idx" ON "webhook_deliveries"("status", "next_attempt_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_tenant_id_endpoint_id_event_id_key" ON "webhook_deliveries"("tenant_id", "endpoint_id", "event_id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_id_idx" ON "audit_events"("tenant_id", "occurred_at" DESC, "id");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_action_idx" ON "audit_events"("tenant_id", "action");

-- CreateIndex
CREATE INDEX "notifications_tenant_id_membership_id_created_at_idx" ON "notifications"("tenant_id", "membership_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "metric_chat_facts_tenant_id_requested_at_chat_id_idx" ON "metric_chat_facts"("tenant_id", "requested_at", "chat_id");

-- CreateIndex
CREATE INDEX "privacy_requests_tenant_id_state_created_at_id_idx" ON "privacy_requests"("tenant_id", "state", "created_at", "id");

-- CreateIndex
CREATE INDEX "subject_tombstones_tenant_id_subject_hash_idx" ON "subject_tombstones"("tenant_id", "subject_hash");

-- CreateIndex
CREATE UNIQUE INDEX "integration_mappings_tenant_id_provider_source_type_source__key" ON "integration_mappings"("tenant_id", "provider", "source_type", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_provider_customer_id_key" ON "billing_accounts"("provider_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_accounts_provider_subscription_id_key" ON "billing_accounts"("provider_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_events_provider_event_id_key" ON "billing_events"("provider", "event_id");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_tenant_id_department_id_fkey" FOREIGN KEY ("tenant_id", "department_id") REFERENCES "departments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_members" ADD CONSTRAINT "department_members_tenant_id_membership_id_fkey" FOREIGN KEY ("tenant_id", "membership_id") REFERENCES "memberships"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_tenant_id_schedule_id_fkey" FOREIGN KEY ("tenant_id", "schedule_id") REFERENCES "schedules"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_origins" ADD CONSTRAINT "site_origins_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_configs" ADD CONSTRAINT "widget_configs_tenant_id_site_id_fkey" FOREIGN KEY ("tenant_id", "site_id") REFERENCES "sites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trigger_revisions" ADD CONSTRAINT "trigger_revisions_tenant_id_trigger_id_fkey" FOREIGN KEY ("tenant_id", "trigger_id") REFERENCES "triggers"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_tags" ADD CONSTRAINT "visitor_tags_tenant_id_visitor_id_fkey" FOREIGN KEY ("tenant_id", "visitor_id") REFERENCES "visitors"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_tenant_id_chat_id_fkey" FOREIGN KEY ("tenant_id", "chat_id") REFERENCES "chats"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_offers" ADD CONSTRAINT "assignment_offers_tenant_id_chat_id_fkey" FOREIGN KEY ("tenant_id", "chat_id") REFERENCES "chats"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_chat_id_fkey" FOREIGN KEY ("tenant_id", "chat_id") REFERENCES "chats"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_tenant_id_message_id_fkey" FOREIGN KEY ("tenant_id", "message_id") REFERENCES "messages"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_tenant_id_attachment_id_fkey" FOREIGN KEY ("tenant_id", "attachment_id") REFERENCES "attachments"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_ratings" ADD CONSTRAINT "chat_ratings_tenant_id_chat_id_fkey" FOREIGN KEY ("tenant_id", "chat_id") REFERENCES "chats"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_tags" ADD CONSTRAINT "chat_tags_tenant_id_chat_id_fkey" FOREIGN KEY ("tenant_id", "chat_id") REFERENCES "chats"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_tenant_id_endpoint_id_fkey" FOREIGN KEY ("tenant_id", "endpoint_id") REFERENCES "webhook_endpoints"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

