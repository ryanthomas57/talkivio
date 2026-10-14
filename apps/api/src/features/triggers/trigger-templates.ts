/**
 * Disabled starter templates seeded once per tenant (first GET /triggers when the
 * tenant has no triggers). They reference no tenant-specific ids, so they validate
 * everywhere. Classic behaviour (legacy audit A-41: proactive triggers did not run
 * while nobody was online) is expressed explicitly with `schedule.is_open` /
 * `eligible_agent_count` conditions instead of a hidden rule.
 */
export interface TriggerTemplate {
  key: string;
  name: string;
  description: string;
  definition: Record<string, unknown>;
}

export const TRIGGER_TEMPLATES: TriggerTemplate[] = [
  {
    key: 'pricing-invitation',
    name: 'Pricing page invitation',
    description: 'Invite visitors who spend 30 seconds on a pricing page while agents are available.',
    definition: {
      dsl_version: 1,
      event: 'visitor.timer.elapsed',
      priority: 200,
      all: [
        { field: 'page.path', op: 'starts_with', value: '/pricing' },
        { field: 'page.visible_dwell_seconds', op: 'gte', value: 30 },
        { field: 'schedule.is_open', op: 'eq', value: true },
        { field: 'eligible_agent_count', op: 'gt', value: 0 },
      ],
      any: [],
      actions: [
        {
          type: 'display_invitation',
          message: 'Questions about plans or pricing? We are happy to help.',
          attribution: 'Sales team',
          department_id: null,
          expires_in_seconds: 600,
          max_per_session: 1,
          dismiss_cooldown_hours: 24,
        },
      ],
      stop_processing: true,
      cooldown_seconds: 0,
    },
  },
  {
    key: 'queue-apology',
    name: 'Queue apology',
    description: 'Tell visitors who start a chat while every agent is busy that they are in the queue.',
    definition: {
      dsl_version: 1,
      event: 'chat.requested',
      priority: 100,
      all: [
        { field: 'schedule.is_open', op: 'eq', value: true },
        { field: 'eligible_agent_count', op: 'eq', value: 0 },
      ],
      any: [],
      actions: [
        {
          type: 'send_public_message',
          text: 'Thanks for your patience. All of our agents are helping other customers right now. You are in the queue and we will be with you shortly.',
          attribution: 'Support team',
        },
      ],
      stop_processing: false,
      cooldown_seconds: 0,
    },
  },
  {
    key: 'first-visit-greeting',
    name: 'First-visit greeting',
    description: 'Offer help to first-time visitors after 20 seconds on the site.',
    definition: {
      dsl_version: 1,
      event: 'visitor.timer.elapsed',
      priority: 100,
      all: [
        { field: 'visitor.returning', op: 'eq', value: false },
        { field: 'session.time_on_site_seconds', op: 'gte', value: 20 },
        { field: 'schedule.is_open', op: 'eq', value: true },
        { field: 'eligible_agent_count', op: 'gt', value: 0 },
      ],
      any: [],
      actions: [
        {
          type: 'display_invitation',
          message: 'Hi there! 👋 Let us know if you have any questions.',
          attribution: 'Team',
          department_id: null,
          expires_in_seconds: 600,
          max_per_session: 1,
          dismiss_cooldown_hours: 24,
        },
      ],
      stop_processing: false,
      cooldown_seconds: 0,
    },
  },
  {
    key: 'returning-visitor-tag',
    name: 'Tag returning visitors',
    description: 'Add the "returning" tag to visitors who come back for another session.',
    definition: {
      dsl_version: 1,
      event: 'visitor.session.started',
      priority: 50,
      all: [{ field: 'visitor.returning', op: 'eq', value: true }],
      any: [],
      actions: [{ type: 'add_tag', tag: 'returning', target: 'visitor' }],
      stop_processing: false,
      cooldown_seconds: 0,
    },
  },
];
