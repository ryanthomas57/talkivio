/**
 * Widget configuration. Stored per website as a JSON document and versioned so
 * deployed widgets pick up changes without reinstalling the embed snippet.
 * This module is dependency-free so the widget bundle can import it.
 */

export type WidgetPosition = 'bottom-right' | 'bottom-left';
export type LauncherIcon = 'chat' | 'message' | 'help' | 'wave' | 'custom';
export type WidgetFont = 'system' | 'inter' | 'serif' | 'rounded' | 'mono';
export type WidgetTheme = 'light' | 'dark' | 'auto';
export type FieldRequirement = 'hidden' | 'optional' | 'required';
export type VisibilityMode = 'all' | 'include' | 'exclude';

export const WIDGET_LANGUAGES = ['auto', 'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ar', 'ja'] as const;
export type WidgetLanguage = (typeof WIDGET_LANGUAGES)[number];

export interface WidgetAppearance {
  primaryColor: string;
  secondaryColor: string;
  headerBackground: string;
  headerTextColor: string;
  position: WidgetPosition;
  offsetX: number;
  offsetY: number;
  launcherIcon: LauncherIcon;
  launcherIconUrl: string | null;
  launcherLabel: string;
  showLauncherLabel: boolean;
  logoUrl: string | null;
  companyName: string;
  title: string;
  subtitle: string;
  buttonRadius: number;
  borderRadius: number;
  width: number;
  height: number;
  showAgentAvatars: boolean;
  showAgentNames: boolean;
  font: WidgetFont;
  theme: WidgetTheme;
  showBranding: boolean;
}

export interface WidgetContent {
  language: WidgetLanguage;
  welcomeMessage: string;
  inputPlaceholder: string;
  offlineTitle: string;
  offlineMessage: string;
  offlineThanks: string;
  prechatGreeting: string;
  waitingMessage: string;
  chatEndedMessage: string;
  ratingPrompt: string;
}

export interface WidgetBehavior {
  greeting: {
    enabled: boolean;
    message: string;
    delaySeconds: number;
    showOnMobile: boolean;
  };
  prechatForm: {
    enabled: boolean;
    name: FieldRequirement;
    email: FieldRequirement;
    phone: FieldRequirement;
    department: FieldRequirement;
  };
  offlineForm: {
    enabled: boolean;
    phone: FieldRequirement;
    department: FieldRequirement;
  };
  attachments: { enabled: boolean };
  ratings: { enabled: boolean };
  transcripts: { enabled: boolean };
  sound: boolean;
  hideOnMobile: boolean;
  hideWhenOffline: boolean;
  visibility: { mode: VisibilityMode; patterns: string[] };
  trackPages: boolean;
  openOnAgentMessage: boolean;
  showQueuePosition: boolean;
}

export interface WidgetConfig {
  appearance: WidgetAppearance;
  content: WidgetContent;
  behavior: WidgetBehavior;
}

export const DEFAULT_WIDGET_CONFIG: WidgetConfig = {
  appearance: {
    primaryColor: '#07778A',
    secondaryColor: '#E0F5F6',
    headerBackground: '#0A0F1E',
    headerTextColor: '#FFFFFF',
    position: 'bottom-right',
    offsetX: 20,
    offsetY: 20,
    launcherIcon: 'chat',
    launcherIconUrl: null,
    launcherLabel: 'Chat with us',
    showLauncherLabel: false,
    logoUrl: null,
    companyName: 'Our team',
    title: 'Chat with us',
    subtitle: 'We typically reply in a few minutes',
    buttonRadius: 28,
    borderRadius: 16,
    width: 380,
    height: 600,
    showAgentAvatars: true,
    showAgentNames: true,
    font: 'system',
    theme: 'light',
    showBranding: true,
  },
  content: {
    language: 'auto',
    welcomeMessage: 'Hi there! How can we help you today?',
    inputPlaceholder: 'Write a message…',
    offlineTitle: 'Leave us a message',
    offlineMessage: "We're away right now. Leave a message and we'll get back to you by email.",
    offlineThanks: "Thanks! We've received your message and will reply by email.",
    prechatGreeting: 'Tell us a little about yourself so we can help you faster.',
    waitingMessage: 'Thanks for reaching out. An agent will be with you shortly.',
    chatEndedMessage: 'This chat has ended.',
    ratingPrompt: 'How would you rate this conversation?',
  },
  behavior: {
    greeting: {
      enabled: false,
      message: 'Questions? We are here to help.',
      delaySeconds: 8,
      showOnMobile: false,
    },
    prechatForm: {
      enabled: false,
      name: 'optional',
      email: 'optional',
      phone: 'hidden',
      department: 'hidden',
    },
    offlineForm: {
      enabled: true,
      phone: 'hidden',
      department: 'optional',
    },
    attachments: { enabled: true },
    ratings: { enabled: true },
    transcripts: { enabled: true },
    sound: true,
    hideOnMobile: false,
    hideWhenOffline: false,
    visibility: { mode: 'all', patterns: [] },
    trackPages: true,
    openOnAgentMessage: true,
    showQueuePosition: true,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type WidgetConfigPatch = DeepPartial<WidgetConfig>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge a stored (possibly partial / older-version) config over the defaults. */
export function mergeWidgetConfig(stored: unknown, base: WidgetConfig = DEFAULT_WIDGET_CONFIG): WidgetConfig {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isPlainObject(a)) return b === undefined ? a : b;
    if (!isPlainObject(b)) return a;
    const out: Record<string, unknown> = { ...a };
    for (const key of Object.keys(a)) {
      if (key in b) out[key] = merge(a[key], b[key]);
    }
    return out;
  };
  return merge(base, stored) as WidgetConfig;
}

/** Simple glob-ish URL matching used by page-visibility rules: `*` is a wildcard. */
export function urlMatchesPattern(url: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`, 'i').test(url) || (!p.includes('*') && url.toLowerCase().includes(p.toLowerCase()));
  } catch {
    return false;
  }
}

export function isWidgetVisibleOnUrl(config: WidgetConfig, url: string): boolean {
  const { mode, patterns } = config.behavior.visibility;
  if (mode === 'all' || patterns.length === 0) return true;
  const hit = patterns.some((p) => urlMatchesPattern(url, p));
  return mode === 'include' ? hit : !hit;
}
