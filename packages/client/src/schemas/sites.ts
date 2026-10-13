/** Sites, widget configuration revisions and installation diagnostics (ch. 42). */
import { z } from 'zod';
import { DateTime, Uuid } from './common.ts';

const FieldMode = z.enum(['hidden', 'optional', 'required']);

export const WidgetConfigSchema = z.object({
  appearance: z.object({
    primaryColor: z.string(),
    secondaryColor: z.string(),
    headerBackground: z.string(),
    headerTextColor: z.string(),
    position: z.enum(['bottom-right', 'bottom-left']),
    offsetX: z.number(),
    offsetY: z.number(),
    launcherIcon: z.enum(['chat', 'message', 'help', 'wave', 'custom']),
    launcherIconUrl: z.string().nullable(),
    launcherLabel: z.string(),
    showLauncherLabel: z.boolean(),
    logoUrl: z.string().nullable(),
    companyName: z.string(),
    title: z.string(),
    subtitle: z.string(),
    buttonRadius: z.number(),
    borderRadius: z.number(),
    width: z.number(),
    height: z.number(),
    showAgentAvatars: z.boolean(),
    showAgentNames: z.boolean(),
    font: z.enum(['system', 'inter', 'serif', 'rounded', 'mono']),
    theme: z.enum(['light', 'dark', 'auto']),
    showBranding: z.boolean(),
  }),
  content: z.object({
    language: z.enum(['auto', 'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ar', 'ja']),
    welcomeMessage: z.string(),
    inputPlaceholder: z.string(),
    offlineTitle: z.string(),
    offlineMessage: z.string(),
    offlineThanks: z.string(),
    prechatGreeting: z.string(),
    waitingMessage: z.string(),
    chatEndedMessage: z.string(),
    ratingPrompt: z.string(),
  }),
  behavior: z.object({
    greeting: z.object({ enabled: z.boolean(), message: z.string(), delaySeconds: z.number(), showOnMobile: z.boolean() }),
    prechatForm: z.object({ enabled: z.boolean(), name: FieldMode, email: FieldMode, phone: FieldMode, department: FieldMode }),
    offlineForm: z.object({ enabled: z.boolean(), phone: FieldMode, department: FieldMode }),
    attachments: z.object({ enabled: z.boolean() }),
    ratings: z.object({ enabled: z.boolean() }),
    transcripts: z.object({ enabled: z.boolean() }),
    sound: z.boolean(),
    hideOnMobile: z.boolean(),
    hideWhenOffline: z.boolean(),
    visibility: z.object({ mode: z.enum(['all', 'include', 'exclude']), patterns: z.array(z.string()) }),
    trackPages: z.boolean(),
    openOnAgentMessage: z.boolean(),
    showQueuePosition: z.boolean(),
  }),
});

export const SiteSchema = z.object({
  id: Uuid,
  name: z.string(),
  publicKey: z.string(),
  enabled: z.boolean(),
  configRevision: z.number().int(),
  defaultDepartmentId: Uuid.nullable(),
  scheduleId: Uuid.nullable(),
  origins: z.array(z.object({ origin: z.string(), patternType: z.enum(['exact', 'subdomain']), verifiedAt: DateTime.nullable() })),
  identityVerificationEnabled: z.boolean(),
  installedAt: DateTime.nullable(),
  lastVerifiedAt: DateTime.nullable(),
  lastVerifiedOrigin: z.string().nullable(),
  previousKeyExpiresAt: DateTime.nullable(),
  archivedAt: DateTime.nullable(),
  version: z.number().int(),
  createdAt: DateTime,
});

/** Key rotation result: the site plus the refreshed install snippet. */
export const SiteKeyRotationSchema = SiteSchema.extend({ snippet: z.string() });

export const WidgetConfigRevisionsSchema = z.object({
  draft: z.object({ revision: z.number().int(), config: WidgetConfigSchema, etag: z.string(), createdAt: DateTime }).nullable(),
  published: z.object({ revision: z.number().int(), config: WidgetConfigSchema, etag: z.string(), publishedAt: DateTime.nullable() }).nullable(),
});
/** Saved draft; `etag` is the configuration hash used for optimistic concurrency. */
export const WidgetConfigDraftSchema = z.object({ revision: z.number().int(), config: WidgetConfigSchema, etag: z.string() });
export const WidgetConfigDiscardResultSchema = z.object({ discarded: z.boolean(), revision: z.number().int().nullable() });
export const WidgetConfigPublishResultSchema = z.object({ revision: z.number().int(), alreadyPublished: z.boolean() });

export const InstallationStatusSchema = z.object({
  siteKey: z.string(),
  snippet: z.string(),
  loaderUrl: z.string(),
  apiOrigin: z.string(),
  installedAt: DateTime.nullable(),
  lastVerifiedAt: DateTime.nullable(),
  lastVerifiedOrigin: z.string().nullable(),
  status: z.string(),
  diagnostics: z.array(z.string()),
  csp: z.object({ scriptSrc: z.string(), frameSrc: z.string(), connectSrc: z.string() }),
});

/** Identity-verification secret; shown once when created, `null` after removal. */
export const IdentitySecretSchema = z.object({ secret: z.string().nullable() });

export type WidgetConfig = z.infer<typeof WidgetConfigSchema>;
export type Site = z.infer<typeof SiteSchema>;
export type WidgetConfigRevisions = z.infer<typeof WidgetConfigRevisionsSchema>;
