import { Ban, CalendarClock, ClipboardList, Globe2, ListPlus, Lock, Plug, SlidersHorizontal, UserRound, Users, Workflow, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/i18n';
import { hasAny } from '@/lib/permissions';

export interface SettingsSection {
  href: string;
  /** Catalog key, translated at render time. */
  label: MessageKey;
  icon: LucideIcon;
  /** Any of these permissions shows the entry (UI hint only; every route is authorized by the API). */
  any?: string[];
}

/** Secondary settings navigation (ch. 06). Order is the order shown. */
export const SETTINGS_SECTIONS: SettingsSection[] = [
  { href: '/settings/general', label: 'settings.nav.general', icon: SlidersHorizontal, any: ['tenant.read'] },
  { href: '/settings/account', label: 'settings.nav.account', icon: UserRound },
  { href: '/settings/departments', label: 'settings.nav.departments', icon: Users, any: ['departments.view'] },
  { href: '/settings/hours', label: 'settings.nav.hours', icon: CalendarClock, any: ['schedules.view'] },
  { href: '/settings/sites', label: 'settings.nav.sites', icon: Globe2, any: ['sites.view'] },
  { href: '/settings/triggers', label: 'settings.nav.triggers', icon: Workflow, any: ['triggers.view'] },
  { href: '/settings/custom-fields', label: 'settings.nav.customFields', icon: ListPlus, any: ['custom_fields.manage'] },
  { href: '/settings/bans', label: 'settings.nav.bans', icon: Ban, any: ['bans.manage'] },
  { href: '/settings/integrations', label: 'settings.nav.integrations', icon: Plug, any: ['integrations.manage'] },
  { href: '/settings/privacy', label: 'settings.nav.privacy', icon: Lock, any: ['privacy.manage'] },
  { href: '/settings/audit', label: 'settings.nav.audit', icon: ClipboardList, any: ['audit.view'] },
];

export function visibleSections(perms: ReadonlySet<string>): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => hasAny(perms, s.any));
}

export function isActiveSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
