import type { dock as source } from '../en/dock';

/** Arabic for 'dock': same keys and variables as English (enforced by the type and src/i18n/catalog.test.ts). */
export const dock: Record<keyof typeof source, string> = {
  'dock.region': 'نوافذ المحادثة',
  'dock.expand': 'توسيع نافذة المحادثة',
  'dock.minimize': 'تصغير نافذة المحادثة',
  'dock.close': 'إغلاق نافذة المحادثة (تبقى المحادثة مفتوحة)',
  'dock.openInInbox': 'فتح في صندوق الوارد',
  'dock.loading': 'جارٍ تحميل المحادثة…',
  'dock.unread':
    '{count, plural, zero {لا رسائل غير مقروءة} one {رسالة واحدة غير مقروءة} two {رسالتان غير مقروءتين} few {# رسائل غير مقروءة} many {# رسالة غير مقروءة} other {# رسالة غير مقروءة}}',
  'dock.chatUnavailable': 'لم تعد هذه المحادثة متاحة.',
  'dock.newChat': 'محادثة جديدة',
  'dock.startHint': 'اكتب رسالة لبدء محادثة مع {name}. ستظهر في نافذة الدردشة على موقعك.',
  'dock.cannotStart': 'لا يسمح دورك ببدء المحادثات.',
  'dock.startLabel': 'الرسالة الأولى إلى {name}',
  'dock.startPlaceholder': 'مرحبًا! هل يمكنني مساعدتك في شيء؟',
  'dock.startChat': 'بدء المحادثة',
  'dock.visitorLeft': 'غادر هذا الزائر موقعك، لذا تعذّر بدء المحادثة.',
  'dock.chatExists': 'لدى {name} محادثة مفتوحة بالفعل. يتم عرضها.',
};
