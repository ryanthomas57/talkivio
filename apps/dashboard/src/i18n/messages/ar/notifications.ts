import type { notifications as source } from '../en/notifications';

/** Arabic for 'notifications': same keys and variables as English (enforced by the type and src/i18n/catalog.test.ts). */
export const notifications: Record<keyof typeof source, string> = {
  'notifications.title': 'الإشعارات',
  'notifications.bellUnread': '{count, plural, zero {الإشعارات، لا إشعارات غير مقروءة} one {الإشعارات، إشعار واحد غير مقروء} two {الإشعارات، إشعاران غير مقروءين} few {الإشعارات، # إشعارات غير مقروءة} many {الإشعارات، # إشعارًا غير مقروء} other {الإشعارات، # إشعار غير مقروء}}',
  'notifications.unreadBadge': 'غير مقروءة',
  'notifications.unreadCount': '{count, plural, zero {لا إشعارات غير مقروءة} one {إشعار واحد غير مقروء} two {إشعاران غير مقروءين} few {# إشعارات غير مقروءة} many {# إشعارًا غير مقروء} other {# إشعار غير مقروء}}',
  'notifications.allCaughtUp': 'لا إشعارات جديدة',
  'notifications.announceNew': 'إشعار جديد: {title}',
  'notifications.allMarkedRead': 'عُلِّمت كل الإشعارات كمقروءة',
  'notifications.markReadFailed': 'تعذّر التعليم كمقروء: {error}',
  'notifications.markAllFailed': 'تعذّر تعليم الكل كمقروء: {error}',
  'notifications.markAll': 'تعليم الكل كمقروء',
  'notifications.loading': 'جارٍ تحميل الإشعارات',
  'notifications.loadFailed': 'تعذّر تحميل الإشعارات: {error}',
  'notifications.emptyTitle': 'لا إشعارات بعد',
  'notifications.emptyBody': 'تظهر هنا إسنادات المحادثات والتحويلات ورسائل خارج الدوام الجديدة.',
  'notifications.offlineMessages': 'رسائل خارج الدوام',
  'notifications.srUnread': '، غير مقروء',
  'notifications.markAsReadLabel': '{title}. تعليم كمقروء',
};
