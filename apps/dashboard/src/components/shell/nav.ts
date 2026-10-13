import type { MessageKey } from '@/i18n';
import { BarChart3, Gauge, History, Inbox, LayoutDashboard, MessageSquareText, Settings, Users, UsersRound, type LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  /** Message key; render with t(). */
  label: MessageKey;
  icon: LucideIcon;
  /** Any of these permissions shows the item; the API still authorizes every request. */
  any?: string[];
  badge?: 'inbox';
}

/** Sidebar routes (ch. 06). */
export const NAV_ITEMS: NavItem[] = [
  { href: '/overview', label: 'shell.nav.overview', icon: LayoutDashboard },
  { href: '/visitors', label: 'shell.nav.visitors', icon: UsersRound, any: ['visitors.view'] },
  { href: '/inbox', label: 'shell.nav.inbox', icon: Inbox, any: ['chats.serve'], badge: 'inbox' },
  { href: '/history', label: 'shell.nav.history', icon: History, any: ['history.view'] },
  { href: '/monitor', label: 'shell.nav.monitor', icon: Gauge, any: ['monitor.view'] },
  { href: '/analytics', label: 'shell.nav.analytics', icon: BarChart3, any: ['analytics.view'] },
  { href: '/shortcuts', label: 'shell.nav.shortcuts', icon: MessageSquareText, any: ['shortcuts.view', 'shortcuts.manage_personal'] },
  { href: '/team', label: 'shell.nav.team', icon: Users, any: ['agents.view'] },
  { href: '/settings', label: 'shell.nav.settings', icon: Settings, any: ['tenant.read'] },
];
