/** Zod input schemas. Used by the API (validation pipe) and the dashboard (forms). */
import { z } from 'zod';
import {
  AGENT_STATUSES,
  API_KEY_SCOPES,
  CONVERSATION_STATUSES,
  INBOX_VIEWS,
  PRIORITIES,
  RATINGS,
  ROLES,
  ROUTING_MODES,
  WEBHOOK_EVENTS,
} from './enums';
import { TRIGGER_EVENTS, TRIGGER_OPERATORS, TRIGGER_RUN_MODES } from './logic/triggers';
import { WEEKDAYS, isValidTimezone } from './logic/hours';
import { SHORTCUT_NAME_RE } from './logic/shortcuts';
import { parseIpRule } from './logic/ip';
import { WIDGET_LANGUAGES } from './widget-config';
import { BILLING_CYCLES, PLAN_IDS } from './plans';

const trimmed = (max: number) => z.string().trim().max(max);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a 6-digit hex color');
/** Image URLs rendered by the widget/dashboard: https only (no javascript:, data:, file: or mixed content). */
const httpsImageUrl = z
  .string()
  .max(500)
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'Use an https:// image URL');
const timezone = z.string().refine(isValidTimezone, 'Unknown timezone');
const cuidish = z.string().min(1).max(64);

// ───────────────────────────── Auth ─────────────────────────────
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[0-9\W]/.test(p), 'Mix letters with numbers or symbols');

export const registerSchema = z.object({
  name: trimmed(80).min(1, 'Enter your name'),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(200),
  password: passwordSchema,
  inviteToken: z.string().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password').max(200),
  mfaCode: z.string().trim().max(20).optional(),
  rememberDevice: z.boolean().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const forgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetPasswordSchema = z.object({ token: z.string().min(10), password: passwordSchema });
export const verifyEmailSchema = z.object({ token: z.string().min(10) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});
export const updateProfileSchema = z.object({
  name: trimmed(80).min(1).optional(),
  avatarUrl: z.string().url().max(500).nullable().optional(),
});
export const mfaVerifySchema = z.object({ code: z.string().trim().min(6).max(20) });
export const mfaDisableSchema = z.object({
  password: z.string().min(1),
  code: z.string().trim().min(6).max(20),
});

// ───────────────────────────── Organizations ─────────────────────────────
export const createOrgSchema = z.object({
  name: trimmed(80).min(2, 'Organization name is too short'),
  timezone: timezone.optional(),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const updateOrgSchema = z.object({
  name: trimmed(80).min(2).optional(),
  logoUrl: httpsImageUrl.nullable().optional(),
});

export const inviteMembersSchema = z.object({
  invites: z
    .array(
      z.object({
        email: z.string().trim().toLowerCase().email(),
        role: z.enum(['ADMIN', 'AGENT']),
        departmentIds: z.array(cuidish).max(50).default([]),
      }),
    )
    .min(1)
    .max(50),
});
export type InviteMembersInput = z.infer<typeof inviteMembersSchema>;

export const updateMemberSchema = z.object({
  role: z.enum(ROLES).optional(),
  displayName: trimmed(80).nullable().optional(),
  title: trimmed(80).nullable().optional(),
  maxChats: z.number().int().min(1).max(100).nullable().optional(),
  departmentIds: z.array(cuidish).max(100).optional(),
  disabled: z.boolean().optional(),
});

export const updatePreferencesSchema = z.object({
  sendOnEnter: z.boolean().optional(),
  sound: z.boolean().optional(),
  visitorAlerts: z.boolean().optional(),
  desktopNotifications: z.boolean().optional(),
  theme: z.enum(['light', 'dark', 'system']).optional(),
  displayName: trimmed(80).nullable().optional(),
  title: trimmed(80).nullable().optional(),
});

export const setStatusSchema = z.object({ status: z.enum(AGENT_STATUSES) });

// ───────────────────────────── Settings ─────────────────────────────
export const timeRangeSchema = z
  .object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) })
  .refine((r) => r.start !== r.end, 'Start and end must differ');

export const weeklyScheduleSchema = z.object({
  timezone,
  days: z.object(
    Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(timeRangeSchema).max(6)])) as Record<
      (typeof WEEKDAYS)[number],
      z.ZodArray<typeof timeRangeSchema>
    >,
  ),
  holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: trimmed(80) })).max(100),
});

export const operatingHoursSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['account', 'department']),
  schedule: weeklyScheduleSchema,
});

/** Exact IPv4 / IPv6 address or CIDR range (IPv4 /8–/32, IPv6 /16–/128): the forms the API allowlist matcher supports. */
export const ipRuleSchema = z
  .string()
  .trim()
  .max(64)
  .refine(
    (v) => parseIpRule(v) !== null,
    'Use an IPv4 or IPv6 address or a CIDR range such as 203.0.113.0/24 or 2001:db8:1::/48',
  );

export const orgSettingsPatchSchema = z
  .object({
    routing: z
      .object({
        mode: z.enum(ROUTING_MODES),
        maxChatsPerAgent: z.number().int().min(1).max(100).nullable(),
        reassignAfterSeconds: z.number().int().min(0).max(3600),
        strictDepartments: z.boolean(),
      })
      .partial(),
    chat: z
      .object({
        idleTimeoutMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60),
        missedAfterSeconds: z.number().int().min(10).max(3600),
        agentAutoAwayMinutes: z
          .number()
          .int()
          .min(0)
          .max(24 * 60),
        allowVisitorEndChat: z.boolean(),
        requestRatingOnEnd: z.boolean(),
        maskCreditCards: z.boolean(),
        allowAttachments: z.boolean(),
        maxAttachmentMb: z.number().int().min(1).max(10),
        allowedFileTypes: z.array(trimmed(100)).max(50),
        showTypingPreview: z.boolean(),
        readReceipts: z.boolean(),
        reconnectGraceSeconds: z.number().int().min(60).max(1800),
        offerOfflineAfterSeconds: z.number().int().min(0).max(3600),
      })
      .partial(),
    tracking: z
      .object({
        analyticsConsentRequired: z.boolean(),
        queryAllowlist: z.array(z.string().trim().max(64)).max(20),
        retainIp: z.boolean(),
        locationEnabled: z.boolean(),
        pageEventRetentionDays: z.number().int().min(1).max(365),
      })
      .partial(),
    availability: z.object({ defaultScheduleId: z.string().uuid().nullable() }).partial(),
    offline: z.object({ rateLimitPerHour: z.number().int().min(1).max(100) }).partial(),
    analytics: z.object({ excludeQuickCancellations: z.boolean() }).partial(),
    files: z
      .object({
        dailyQuotaMb: z.number().int().min(1).max(100_000).nullable(),
        dailyQuotaFiles: z.number().int().min(1).max(100_000).nullable(),
      })
      .partial(),
    operatingHours: operatingHoursSchema,
    security: z
      .object({
        requireMfa: z.boolean(),
        sessionTimeoutHours: z
          .number()
          .int()
          .min(1)
          .max(24 * 90),
        ipAllowlist: z.array(ipRuleSchema).max(200),
        anonymizeIps: z.boolean(),
        dataRetentionDays: z.number().int().min(7).max(3650).nullable(),
      })
      .partial(),
    notifications: z
      .object({
        emailOfflineMessages: z.boolean(),
        offlineMessageRecipients: z.array(z.string().email()).max(20),
        weeklyReport: z.boolean(),
      })
      .partial(),
    locale: z.object({ timezone, weekStartsOn: z.union([z.literal(0), z.literal(1)]) }).partial(),
  })
  .partial();
export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

// ───────────────────────────── Websites & widget ─────────────────────────────
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .refine((d) => /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?$/.test(d), 'Enter a domain like example.com');

export const originSchema = z
  .string()
  .trim()
  .max(300)
  .refine(
    (o) => /^(https?:\/\/)?(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(o),
    'Use an origin like https://example.com or *.example.com',
  );

export const createWebsiteSchema = z.object({
  name: trimmed(80).min(1),
  domain: domainSchema,
  allowedOrigins: z.array(originSchema).max(50).optional(),
});
export const updateWebsiteSchema = z.object({
  name: trimmed(80).min(1).optional(),
  domain: domainSchema.optional(),
  allowedOrigins: z.array(originSchema).max(50).optional(),
});

const requirement = z.enum(['hidden', 'optional', 'required']);
export const widgetConfigSchema = z.object({
  appearance: z.object({
    primaryColor: hexColor,
    secondaryColor: hexColor,
    headerBackground: hexColor,
    headerTextColor: hexColor,
    position: z.enum(['bottom-right', 'bottom-left']),
    offsetX: z.number().int().min(0).max(200),
    offsetY: z.number().int().min(0).max(200),
    launcherIcon: z.enum(['chat', 'message', 'help', 'wave', 'custom']),
    launcherIconUrl: httpsImageUrl.nullable(),
    launcherLabel: trimmed(40),
    showLauncherLabel: z.boolean(),
    logoUrl: httpsImageUrl.nullable(),
    companyName: trimmed(60),
    title: trimmed(60),
    subtitle: trimmed(120),
    buttonRadius: z.number().int().min(0).max(40),
    borderRadius: z.number().int().min(0).max(32),
    width: z.number().int().min(320).max(480),
    height: z.number().int().min(420).max(760),
    showAgentAvatars: z.boolean(),
    showAgentNames: z.boolean(),
    font: z.enum(['system', 'inter', 'serif', 'rounded', 'mono']),
    theme: z.enum(['light', 'dark', 'auto']),
    showBranding: z.boolean(),
  }),
  content: z.object({
    language: z.enum(WIDGET_LANGUAGES),
    welcomeMessage: trimmed(500),
    inputPlaceholder: trimmed(80),
    offlineTitle: trimmed(80),
    offlineMessage: trimmed(500),
    offlineThanks: trimmed(300),
    prechatGreeting: trimmed(300),
    waitingMessage: trimmed(300),
    chatEndedMessage: trimmed(200),
    ratingPrompt: trimmed(200),
  }),
  behavior: z.object({
    greeting: z.object({
      enabled: z.boolean(),
      message: trimmed(200),
      delaySeconds: z.number().int().min(0).max(600),
      showOnMobile: z.boolean(),
    }),
    prechatForm: z.object({
      enabled: z.boolean(),
      name: requirement,
      email: requirement,
      phone: requirement,
      department: requirement,
    }),
    offlineForm: z.object({ enabled: z.boolean(), phone: requirement, department: requirement }),
    attachments: z.object({ enabled: z.boolean() }),
    ratings: z.object({ enabled: z.boolean() }),
    transcripts: z.object({ enabled: z.boolean() }),
    sound: z.boolean(),
    hideOnMobile: z.boolean(),
    hideWhenOffline: z.boolean(),
    visibility: z.object({
      mode: z.enum(['all', 'include', 'exclude']),
      patterns: z.array(trimmed(300)).max(50),
    }),
    trackPages: z.boolean(),
    openOnAgentMessage: z.boolean(),
    showQueuePosition: z.boolean(),
  }),
});

// ───────────────────────────── Departments ─────────────────────────────
export const departmentSchema = z.object({
  name: trimmed(60).min(1),
  description: trimmed(300).nullable().optional(),
  enabled: z.boolean().optional(),
  memberIds: z.array(cuidish).max(500).optional(),
  schedule: weeklyScheduleSchema.nullable().optional(),
  scheduleEnabled: z.boolean().optional(),
});

// ───────────────────────────── Conversations ─────────────────────────────
export const listConversationsSchema = z.object({
  view: z.enum(INBOX_VIEWS).default('all'),
  q: z.string().trim().max(200).optional(),
  status: z.enum(CONVERSATION_STATUSES).optional(),
  departmentId: cuidish.optional(),
  assigneeId: cuidish.optional(),
  websiteId: cuidish.optional(),
  priority: z.enum(PRIORITIES).optional(),
  tag: z.string().trim().max(50).optional(),
  rating: z.enum([...RATINGS, 'NONE'] as const).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  sort: z.enum(['recent', 'oldest', 'priority', 'waiting']).default('recent'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsQuery = z.infer<typeof listConversationsSchema>;

export const sendMessageSchema = z.object({
  body: z.string().max(5000).default(''),
  type: z.enum(['TEXT', 'NOTE']).default('TEXT'),
  clientId: z.string().max(64).optional(),
  attachmentIds: z.array(cuidish).max(10).default([]),
  options: z.array(trimmed(60)).max(8).default([]),
  shortcutId: cuidish.optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const updateConversationSchema = z.object({
  status: z.enum(CONVERSATION_STATUSES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  subject: trimmed(200).nullable().optional(),
  tags: z.array(trimmed(50).min(1)).max(50).optional(),
});

export const assignConversationSchema = z.object({
  assigneeId: cuidish.nullable().optional(),
  departmentId: cuidish.nullable().optional(),
  note: trimmed(500).optional(),
});

export const bulkConversationSchema = z.object({
  ids: z.array(cuidish).min(1).max(200),
  action: z.enum(['assign', 'close', 'reopen', 'tag', 'untag', 'priority', 'mark_spam']),
  assigneeId: cuidish.nullable().optional(),
  tags: z.array(trimmed(50).min(1)).max(20).optional(),
  priority: z.enum(PRIORITIES).optional(),
});

export const emailTranscriptSchema = z.object({ email: z.string().email() });

export const startConversationSchema = z.object({
  visitorId: cuidish,
  body: z.string().trim().min(1).max(5000),
  clientId: z.string().max(64).optional(),
});

// ───────────────────────────── Visitors ─────────────────────────────
export const updateVisitorSchema = z.object({
  name: trimmed(100).nullable().optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal('')),
  phone: trimmed(40).nullable().optional(),
  notes: trimmed(5000).nullable().optional(),
  tags: z.array(trimmed(50).min(1)).max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
});

export const banVisitorSchema = z.object({
  reason: trimmed(300).default(''),
  includeIp: z.boolean().default(true),
});

export const listVisitorsSchema = z.object({
  q: z.string().trim().max(200).optional(),
  websiteId: cuidish.optional(),
  identified: z.coerce.boolean().optional(),
  tag: z.string().trim().max(50).optional(),
  countryCode: z.string().trim().max(2).optional(),
  banned: z.coerce.boolean().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// ───────────────────────────── Triggers ─────────────────────────────
const triggerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_message'),
    senderName: trimmed(60).min(1),
    message: trimmed(2000).min(1),
  }),
  z.object({ type: z.literal('wait'), seconds: z.number().int().min(1).max(3600) }),
  z.object({ type: z.literal('set_name'), name: trimmed(100).min(1) }),
  z.object({ type: z.literal('add_tags'), tags: z.array(trimmed(50).min(1)).min(1).max(20) }),
  z.object({ type: z.literal('remove_tags'), tags: z.array(trimmed(50).min(1)).min(1).max(20) }),
  z.object({ type: z.literal('set_department'), departmentId: cuidish }),
  z.object({ type: z.literal('set_priority'), priority: z.enum(PRIORITIES) }),
  z.object({ type: z.literal('add_note'), note: trimmed(1000).min(1) }),
  z.object({ type: z.literal('open_widget') }),
  z.object({ type: z.literal('ban_visitor'), reason: trimmed(300) }),
]);

export const triggerSchema = z.object({
  name: trimmed(80).min(1),
  description: trimmed(300).nullable().optional(),
  enabled: z.boolean().default(true),
  event: z.enum(TRIGGER_EVENTS),
  runMode: z.enum(TRIGGER_RUN_MODES).default('always'),
  websiteIds: z.array(cuidish).max(100).default([]),
  conditions: z.object({
    match: z.enum(['all', 'any']),
    rules: z
      .array(
        z.object({
          field: z.string().min(1).max(60),
          operator: z.enum(TRIGGER_OPERATORS),
          value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(),
        }),
      )
      .max(25),
  }),
  actions: z.array(triggerActionSchema).min(1).max(20),
});
export type TriggerInput = z.infer<typeof triggerSchema>;

// ───────────────────────────── Shortcuts ─────────────────────────────
export const shortcutSchema = z.object({
  name: z.string().trim().toLowerCase().regex(SHORTCUT_NAME_RE, 'Use lowercase letters, numbers, - or _'),
  message: trimmed(5000).min(1),
  options: z.array(trimmed(60).min(1)).max(8).default([]),
  tags: z.array(trimmed(50).min(1)).max(20).default([]),
  departmentIds: z.array(cuidish).max(50).default([]),
  scope: z.enum(['ORG', 'PERSONAL']).default('ORG'),
});
export type ShortcutInput = z.infer<typeof shortcutSchema>;

// ───────────────────────────── Integrations ─────────────────────────────
export const webhookSchema = z.object({
  url: z
    .string()
    .url()
    .max(500)
    .refine((u) => /^https?:\/\//.test(u), 'Must be an http(s) URL'),
  description: trimmed(200).nullable().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  enabled: z.boolean().default(true),
});

export const apiKeySchema = z.object({
  name: trimmed(60).min(1),
  scopes: z.array(z.enum(API_KEY_SCOPES)).min(1),
});

export const checkoutSchema = z.object({
  plan: z.enum(PLAN_IDS),
  cycle: z.enum(BILLING_CYCLES),
  seats: z.number().int().min(1).max(500),
});

// ───────────────────────────── Analytics ─────────────────────────────
export const analyticsRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  websiteId: cuidish.optional(),
  departmentId: cuidish.optional(),
  agentId: cuidish.optional(),
  interval: z.enum(['hour', 'day', 'week']).default('day'),
});
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const ratingSchema = z.object({
  rating: z.enum(RATINGS).nullable(),
  comment: trimmed(1000).optional(),
});
