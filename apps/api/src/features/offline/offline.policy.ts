import { randomBytes } from 'node:crypto';
import { mergeWidgetConfig, type FieldRequirement } from '@talkivio/contracts';

/** Effective offline-form policy from the published widget config (ch. 23 / ch. 75 `offline` block). */
export interface OfflinePolicy {
  enabled: boolean;
  emailRequired: boolean;
  confirmationEnabled: boolean;
  phone: FieldRequirement;
  department: FieldRequirement;
  /** Membership ids that receive team notifications (ch. 75 `team_recipient_ids`). */
  teamRecipientIds: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function pick<T>(sources: Array<Record<string, unknown>>, keys: string[], guard: (v: unknown) => v is T): T | undefined {
  for (const src of sources) for (const k of keys) if (guard(src[k])) return src[k] as T;
  return undefined;
}
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isIdList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

export function offlinePolicy(rawConfig: unknown): OfflinePolicy {
  const merged = mergeWidgetConfig(rawConfig).behavior.offlineForm;
  const raw = isObj(rawConfig) ? rawConfig : {};
  const behavior = isObj(raw.behavior) ? raw.behavior : {};
  const sources = [isObj(behavior.offlineForm) ? behavior.offlineForm : {}, isObj(raw.offline) ? raw.offline : {}];
  return {
    enabled: pick(sources.slice(1), ['enabled'], isBool) ?? merged.enabled,
    emailRequired: pick(sources, ['emailRequired', 'email_required'], isBool) ?? true,
    confirmationEnabled: pick(sources, ['confirmationEnabled', 'confirmation_enabled'], isBool) ?? true,
    phone: merged.phone,
    department: merged.department,
    teamRecipientIds: pick(sources, ['teamRecipientIds', 'team_recipient_ids'], isIdList) ?? [],
  };
}

/** Tenant-configurable per-visitor hourly limit (raw `settings.offline.rateLimitPerHour`, default 5). */
export function visitorHourlyLimit(rawSettings: unknown): number {
  const off = isObj(rawSettings) && isObj(rawSettings.offline) ? rawSettings.offline : {};
  const v = off.rateLimitPerHour ?? off.rate_limit_per_hour;
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100 ? v : 5;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Human reference "R-" + 8 Crockford base32 characters (40 random bits). */
export function newReference(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < 8; i++) {
    out = CROCKFORD[Number(bits & 31n)] + out;
    bits >>= 5n;
  }
  return `R-${out}`;
}

/** "j***@example.com" style mask for list views. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return email ? '***' : '';
  return `${email[0]}***${email.slice(at)}`;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_RE = /^[0-9+()\-. ]+$/;
/** Reserved key inside `custom_fields` holding the encrypted phone number. */
export const PHONE_FIELD_KEY = '_phone_ciphertext';
