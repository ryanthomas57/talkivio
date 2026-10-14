import type { monitor as source } from '../en/monitor';

/** Arabic for 'monitor': same keys and variables as English (enforced by the type and src/i18n/catalog.test.ts). */
export const monitor: Record<keyof typeof source, string> = {
  'monitor.wait.none': 'لا أحد في الانتظار',
  'monitor.wait.ok': 'ضمن الهدف (أقل من {seconds} ث)',
  'monitor.wait.warning': 'تحذير: انتظار {seconds} ث أو أكثر',
  'monitor.wait.critical': 'حرج: انتظار {seconds} ث أو أكثر',

  'monitor.def.queued':
    'المحادثات التي تنتظر موظفًا: في قائمة الانتظار أو معروضة حاليًا ولم تُقبل بعد. مقتصرة على أقسامك والمحادثات بلا قسم.',
  'monitor.def.oldestWait':
    'الوقت المنقضي منذ طلب أطول محادثة انتظارًا في قائمة الانتظار. التحذير عند 60 ث والحالة الحرجة عند 180 ث افتراضيًا.',
  'monitor.def.active': 'المحادثات التي يخدمها موظف حاليًا.',
  'monitor.def.agents':
    'المتاح = متصل، وحالته «متصل»، ودون حد السعة (تُحتسب المحادثات المملوكة والتعاونات وعروض المحادثات المحجوزة المعلّقة في كل الأقسام). المتصل = متصل وحالته «متصل».',
  'monitor.def.offered': 'عروض الإسناد أو التحويل المعلّقة التي تحجز من سعة الموظف ولم تنتهِ صلاحيتها.',
  'monitor.def.backlog':
    'المحادثات النشطة التي لم يتلقَّ أحدث رسالة عامة من الزائر فيها ردًا عامًا لاحقًا من موظف. لا تُفرغ الرسائل الآلية والملاحظات الداخلية قائمة الرد المتأخر.',
  'monitor.def.csat':
    'التقييمات الجيدة ÷ (الجيدة + السيئة)، أحدث تقييم للمحادثات المطلوبة منذ منتصف الليل بالمنطقة الزمنية لمساحة العمل. تُستبعد المحادثات غير المقيَّمة.',

  'monitor.card.stale': 'قديمة',
  'monitor.card.definition': 'التعريف',
  'monitor.card.definitionOf': 'تعريف {label}',
  'monitor.card.asOf': 'حتى <time>{time}</time>',

  'monitor.counters.queued': 'المحادثات في قائمة الانتظار',
  'monitor.counters.oldestWait': 'أقدم انتظار',
  'monitor.counters.active': 'المحادثات النشطة',
  'monitor.counters.available': 'الموظفون المتاحون',
  'monitor.counters.offered': 'عروض المحادثات المحجوزة',
  'monitor.counters.backlog': 'الردود المتأخرة',
  'monitor.counters.csat': 'رضا العملاء (CSAT) اليوم',
  'monitor.counters.unitChats':
    '{count, plural, zero {محادثة} one {محادثة} two {محادثة} few {محادثات} many {محادثة} other {محادثة}}',
  'monitor.counters.unitOffers':
    '{count, plural, zero {عرض} one {عرض} two {عرض} few {عروض} many {عرضًا} other {عرض}}',
  'monitor.counters.unitAwaiting':
    '{count, plural, zero {محادثة بانتظار الرد} one {محادثة بانتظار الرد} two {محادثة بانتظار الرد} few {محادثات بانتظار الرد} many {محادثة بانتظار الرد} other {محادثة بانتظار الرد}}',
  'monitor.counters.ofOnline': 'من أصل {count} متصلين',
  'monitor.counters.noneOnline': 'لا يوجد موظف متصل',
  'monitor.counters.noRatings': 'لا توجد تقييمات اليوم بعد',
  'monitor.counters.csatSample': '{good} جيدة ÷ {rated} مقيَّمة (n {n})',

  'monitor.view.noAccessTitle': 'المراقبة غير متاحة لدورك',
  'monitor.view.noAccessBody': 'يمكن للمشرفين والمسؤولين متابعة قوائم الانتظار المباشرة وحمل الموظفين هنا.',
  'monitor.view.title': 'المراقبة',
  'monitor.view.description':
    'قوائم الانتظار المباشرة وأوقات الانتظار وحمل الموظفين في أقسامك. تصل التحديثات خلال ثوانٍ.',
  'monitor.view.allDepartments': 'كل الأقسام',
  'monitor.view.allMyDepartments': 'كل أقسامي',
  'monitor.view.unavailable': 'المراقبة المباشرة غير متاحة: {error}',

  'monitor.live.staleTitle': 'تُعرض بيانات قديمة',
  'monitor.live.refreshNow': 'التحديث الآن',
  'monitor.live.silent': 'لا تحديث منذ أكثر من {seconds} ث.',
  'monitor.live.silentConn':
    'لا تحديث منذ أكثر من {seconds} ث: حالة الاتصال المباشر: {conn, select, idle {خامل} connecting {جارٍ الاتصال} reconnecting {جارٍ إعادة الاتصال} offline {غير متصل} other {{conn}}}.',
  'monitor.live.serverStale': 'وسم الخادم هذه اللقطة بأنها قديمة.',
  'monitor.live.serverStaleConn':
    'وسم الخادم هذه اللقطة بأنها قديمة، حالة الاتصال المباشر: {conn, select, idle {خامل} connecting {جارٍ الاتصال} reconnecting {جارٍ إعادة الاتصال} offline {غير متصل} other {{conn}}}.',
  'monitor.live.figuresAsOf': 'الأرقام حتى {date} وقد لا تكون محدّثة.',
  'monitor.live.refreshFailed': 'فشل آخر تحديث: {error}',
  'monitor.live.live': 'مباشر',
  'monitor.live.asOf': 'حتى <time>{time}</time> ({timezone})',
  'monitor.live.limited': '· مقتصر على أقسامك',

  'monitor.announce.level':
    'أقدم انتظار في مستوى {level, select, critical {حرج} other {التحذير}}: {duration}. {count} في قائمة الانتظار.',
  'monitor.announce.back': 'عاد أقدم انتظار إلى ضمن الهدف.',

  'monitor.departments.busy':
    '{count, plural, zero {لا أقسام مشغولة} one {قسم واحد مشغول} two {قسمان مشغولان} few {# أقسام مشغولة} many {# قسمًا مشغولًا} other {# قسم مشغول}}: محادثات تنتظر دون موظف متاح أو انتظار طويل.',
  'monitor.departments.noneBusy': 'لا يوجد قسم مشغول الآن.',
  'monitor.departments.emptyTitle': 'لا توجد أقسام ضمن النطاق',
  'monitor.departments.emptyBody': 'لست عضوًا في أي قسم يمكن مراقبته.',
  'monitor.departments.caption': 'الحمل في كل قسم',
  'monitor.departments.noDepartment': 'بلا قسم',
  'monitor.col.queued': 'في الانتظار',
  'monitor.col.oldestWait': 'أقدم انتظار',
  'monitor.col.active': 'نشطة',
  'monitor.col.offers': 'العروض',
  'monitor.col.backlog': 'الردود المتأخرة',
  'monitor.col.availableOnline': 'المتاحون / المتصلون',
  'monitor.col.load': 'الحمل',
  'monitor.col.collab': 'التعاون',
  'monitor.col.oldestUnanswered': 'أقدم رسالة بلا رد',
  'monitor.departments.busyBadge': 'مشغول',

  'monitor.agents.sortBy': '، الترتيب حسب {label}',
  'monitor.agents.title': 'الموظفون',
  'monitor.agents.description':
    'الحالة، والسعة المستخدمة (المملوكة + التعاونات + العروض المحجوزة)، وأقدم رسالة زائر لا تزال تنتظر ردًا.',
  'monitor.agents.emptyTitle': 'لا يوجد موظفون ضمن النطاق',
  'monitor.agents.emptyBody': 'لا يوجد موظف مفعَّل يمكنه خدمة الأقسام المحددة.',
  'monitor.agents.caption':
    'جدول الموظفين، مرتب حسب {sort, select, load {الحمل} backlog {الردود المتأخرة} unanswered {أقدم رسالة بلا رد} other {الاسم}}',
  'monitor.agents.accepting': 'يقبل المحادثات',
  'monitor.agents.atCapacity': 'بلغ حد السعة',
  'monitor.agents.notAccepting': 'لا يقبل المحادثات',
  'monitor.agents.slots': '{used} / {capacity} خانات',
  'monitor.agents.full': 'ممتلئ',

  'monitor.role.owner': 'المالك',
  'monitor.role.admin': 'مسؤول',
  'monitor.role.supervisor': 'مشرف',
  'monitor.role.agent': 'موظف',
  'monitor.role.analyst': 'محلل',
};
