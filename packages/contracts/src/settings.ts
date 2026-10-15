/** Organization-level settings (stored as JSON on Organization.settings). Dependency-free. */
import type { RoutingMode } from './enums';
import { DEFAULT_OPERATING_HOURS, type OperatingHoursSettings } from './logic/hours';

export interface OrgSettings {
  routing: {
    mode: RoutingMode;
    /** Max concurrent chats per agent (null = unlimited). Per-agent override on membership. */
    maxChatsPerAgent: number | null;
    /** Seconds an auto-assigned chat waits for the agent's first reply before being re-queued (0 = never). */
    reassignAfterSeconds: number;
    /** Restrict department chats to department members only. */
    strictDepartments: boolean;
  };
  chat: {
    /** Minutes without visitor activity before an active chat is ended automatically. */
    idleTimeoutMinutes: number;
    /** Seconds a waiting visitor must be gone before an unanswered chat becomes "missed". */
    missedAfterSeconds: number;
    /** Minutes of inactivity before an agent is set to Away. 0 disables. */
    agentAutoAwayMinutes: number;
    allowVisitorEndChat: boolean;
    requestRatingOnEnd: boolean;
    maskCreditCards: boolean;
    allowAttachments: boolean;
    maxAttachmentMb: number;
    allowedFileTypes: string[];
    showTypingPreview: boolean;
    /** Read receipts shown to the other side (ch. 13). */
    readReceipts: boolean;
    /** Seconds a disconnected visitor may reconnect before the chat closes (60–1800). */
    reconnectGraceSeconds: number;
    /** Seconds in queue before the visitor is offered the offline form (0 disables). */
    offerOfflineAfterSeconds: number;
  };
  tracking: {
    /** Require analytics consent before collecting browsing events (ch. 26). */
    analyticsConsentRequired: boolean;
    /** Query parameters kept in sanitized URLs (default none). */
    queryAllowlist: string[];
    retainIp: boolean;
    locationEnabled: boolean;
    pageEventRetentionDays: number;
  };
  availability: {
    defaultScheduleId: string | null;
  };
  offline: {
    /** Offline form submissions accepted per visitor per hour (ch. 23). */
    rateLimitPerHour: number;
  };
  analytics: {
    /** Exclude visitor cancellations within 10 s from the missed measure (ch. 50). */
    excludeQuickCancellations: boolean;
  };
  files: {
    /** Daily upload quota per workspace; null uses the deployment default (ch. 19). */
    dailyQuotaMb: number | null;
    dailyQuotaFiles: number | null;
  };
  operatingHours: OperatingHoursSettings;
  security: {
    requireMfa: boolean;
    sessionTimeoutHours: number;
    ipAllowlist: string[];
    anonymizeIps: boolean;
    dataRetentionDays: number | null;
  };
  notifications: {
    emailOfflineMessages: boolean;
    offlineMessageRecipients: string[];
    weeklyReport: boolean;
  };
  locale: {
    timezone: string;
    weekStartsOn: 0 | 1;
  };
}

export const DEFAULT_ORG_SETTINGS: OrgSettings = {
  routing: {
    mode: 'BROADCAST',
    maxChatsPerAgent: null,
    reassignAfterSeconds: 0,
    strictDepartments: true,
  },
  chat: {
    idleTimeoutMinutes: 20,
    missedAfterSeconds: 60,
    agentAutoAwayMinutes: 15,
    allowVisitorEndChat: true,
    requestRatingOnEnd: true,
    maskCreditCards: true,
    allowAttachments: true,
    maxAttachmentMb: 10,
    allowedFileTypes: [
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'text/plain',
      '.docx',
      '.xlsx',
      '.pptx',
      '.odt',
      '.ods',
    ],
    showTypingPreview: false,
    readReceipts: true,
    reconnectGraceSeconds: 300,
    offerOfflineAfterSeconds: 300,
  },
  tracking: {
    // Every visitor is listed (with IP and network) the moment they open a page with the widget; workspaces whose
    // visitors must agree first turn consent mode on (Privacy Policy: customers "can run the widget in consent mode").
    analyticsConsentRequired: false,
    queryAllowlist: [],
    retainIp: true,
    locationEnabled: true,
    pageEventRetentionDays: 30,
  },
  availability: {
    defaultScheduleId: null,
  },
  offline: {
    rateLimitPerHour: 5,
  },
  analytics: {
    excludeQuickCancellations: false,
  },
  files: {
    dailyQuotaMb: null,
    dailyQuotaFiles: null,
  },
  operatingHours: DEFAULT_OPERATING_HOURS,
  security: {
    requireMfa: false,
    sessionTimeoutHours: 24 * 14,
    ipAllowlist: [],
    anonymizeIps: true,
    dataRetentionDays: null,
  },
  notifications: {
    emailOfflineMessages: true,
    offlineMessageRecipients: [],
    weeklyReport: false,
  },
  locale: {
    timezone: 'UTC',
    weekStartsOn: 1,
  },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function mergeOrgSettings(stored: unknown): OrgSettings {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObj(a)) return b === undefined ? a : b;
    if (!isObj(b)) return a;
    const out: Record<string, unknown> = { ...a };
    for (const k of Object.keys(a)) if (k in b) out[k] = merge(a[k], b[k]);
    return out;
  };
  return merge(DEFAULT_ORG_SETTINGS, stored) as OrgSettings;
}

export interface MemberPreferences {
  sendOnEnter: boolean;
  sound: boolean;
  desktopNotifications: boolean;
  theme: 'light' | 'dark' | 'system';
  /** Generic notification text without visitor names or message content (ch. 14). */
  privacyMode: boolean;
  /** Dashboard language; null follows the browser (ch. 29). */
  locale: 'en' | 'ar' | null;
}

export const DEFAULT_MEMBER_PREFERENCES: MemberPreferences = {
  sendOnEnter: true,
  sound: true,
  desktopNotifications: true,
  theme: 'system',
  privacyMode: false,
  locale: null,
};
