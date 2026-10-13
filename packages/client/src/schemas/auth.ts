/** Authentication, sessions, MFA and tenant (workspace) resources (ch. 41). */
import { z } from 'zod';
import { DateTime, JsonObject, RoleSchema, Uuid } from './common.ts';

export const MeSchema = z.object({
  user: z.object({
    id: Uuid,
    email: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().nullable(),
    emailVerified: z.boolean(),
    mfaEnabled: z.boolean(),
    createdAt: DateTime,
  }),
  memberships: z.array(
    z.object({
      membershipId: Uuid,
      tenantId: Uuid,
      tenantName: z.string(),
      tenantSlug: z.string(),
      role: RoleSchema,
      enabled: z.boolean(),
      onboardingCompleted: z.boolean(),
      plan: z.string(),
    }),
  ),
  activeTenantId: Uuid.nullable(),
});

export const SignupResultSchema = z.object({
  userId: Uuid,
  tenantId: Uuid,
  verificationRequired: z.boolean(),
  me: MeSchema,
});

export const AuthProvidersSchema = z.object({ oauth: z.array(z.enum(['google', 'github'])) });

export const AuthSessionSchema = z.object({
  id: Uuid,
  browser: z.string().nullable(),
  location: z.string().nullable(),
  lastActiveAt: DateTime,
  createdAt: DateTime,
  current: z.boolean(),
});

export const RevokedCountSchema = z.object({ revoked: z.number().int() });
export const MfaEnrollmentSchema = z.object({ enrollmentId: z.string(), secret: z.string(), otpauthUrl: z.string(), qrDataUrl: z.string() });
export const RecoveryCodesSchema = z.object({ recoveryCodes: z.array(z.string()) });

const TimeRangeSchema = z.object({ start: z.string(), end: z.string() });
export const WeeklyIntervalsSchema = z.object({
  sun: z.array(TimeRangeSchema),
  mon: z.array(TimeRangeSchema),
  tue: z.array(TimeRangeSchema),
  wed: z.array(TimeRangeSchema),
  thu: z.array(TimeRangeSchema),
  fri: z.array(TimeRangeSchema),
  sat: z.array(TimeRangeSchema),
});

/** Organization settings (`mergeOrgSettings` in `@talkivio/contracts`). */
export const OrgSettingsSchema = z.object({
  routing: z.object({ mode: z.enum(['BROADCAST', 'ASSIGNED']), maxChatsPerAgent: z.number().int().nullable(), reassignAfterSeconds: z.number(), strictDepartments: z.boolean() }),
  chat: z.object({
    idleTimeoutMinutes: z.number(),
    missedAfterSeconds: z.number(),
    agentAutoAwayMinutes: z.number(),
    allowVisitorEndChat: z.boolean(),
    requestRatingOnEnd: z.boolean(),
    maskCreditCards: z.boolean(),
    allowAttachments: z.boolean(),
    maxAttachmentMb: z.number(),
    allowedFileTypes: z.array(z.string()),
    showTypingPreview: z.boolean(),
    readReceipts: z.boolean(),
    reconnectGraceSeconds: z.number(),
    offerOfflineAfterSeconds: z.number(),
  }),
  tracking: z.object({ analyticsConsentRequired: z.boolean(), queryAllowlist: z.array(z.string()), retainIp: z.boolean(), locationEnabled: z.boolean(), pageEventRetentionDays: z.number() }),
  availability: z.object({ defaultScheduleId: Uuid.nullable() }),
  offline: z.object({ rateLimitPerHour: z.number() }),
  analytics: z.object({ excludeQuickCancellations: z.boolean() }),
  files: z.object({ dailyQuotaMb: z.number().nullable(), dailyQuotaFiles: z.number().nullable() }),
  operatingHours: z.object({
    enabled: z.boolean(),
    mode: z.enum(['department', 'account']),
    schedule: z.object({ timezone: z.string(), days: WeeklyIntervalsSchema, holidays: z.array(z.object({ date: z.string(), name: z.string() })) }),
  }),
  security: z.object({ requireMfa: z.boolean(), sessionTimeoutHours: z.number(), ipAllowlist: z.array(z.string()), anonymizeIps: z.boolean(), dataRetentionDays: z.number().nullable() }),
  notifications: z.object({ emailOfflineMessages: z.boolean(), offlineMessageRecipients: z.array(z.string()), weeklyReport: z.boolean() }),
  locale: z.object({ timezone: z.string(), weekStartsOn: z.union([z.literal(0), z.literal(1)]) }),
});

export const TenantSchema = z.object({
  id: Uuid,
  name: z.string(),
  slug: z.string(),
  timezone: z.string(),
  status: z.enum(['active', 'suspended', 'deleting']),
  plan: z.enum(['starter', 'team', 'business', 'enterprise']),
  retentionDays: z.number().int(),
  settings: OrgSettingsSchema,
  onboardingState: JsonObject,
  onboardingCompleted: z.boolean(),
  version: z.number().int(),
  createdAt: DateTime,
});

export type Me = z.infer<typeof MeSchema>;
export type SignupResult = z.infer<typeof SignupResultSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type OrgSettings = z.infer<typeof OrgSettingsSchema>;
export type Tenant = z.infer<typeof TenantSchema>;
