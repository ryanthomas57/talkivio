# Dashboard localization

Every user-visible string (text, `aria-*`, `placeholder`, `title`, toasts, validation and empty states)
comes from a typed catalog. English is the source of truth and the runtime fallback; Arabic ships with
the same keys. `<html lang dir>` is set from the locale, so the whole UI mirrors in Arabic.

## Using it

```tsx
import { useT } from '@/i18n';

function Example({ name, count }: { name: string; count: number }) {
  const t = useT();
  return (
    <p>
      {t('inbox.accept.withName', { name })} · {t('inbox.list.chatCount', { count })}
    </p>
  );
}
```

- Outside React (a toast in a module-level helper): `tStatic('common.saved')`.
- Maps from codes to copy hold **keys**, translated at render time:
  `const LABEL: Record<Status, MessageKey> = { open: 'offline.status.open' }` → `t(LABEL[s])`.
- Dates, numbers, durations and sizes: `@/lib/format` (it follows the UI locale). Never call
  `toLocaleString(undefined, …)` / `new Intl.X(undefined, …)` in components — pass `intlLocale()` from `@/i18n`.
- Brand: `t('auth.signIn.title', { brand: BRAND_NAME })` with `BRAND_NAME` from `@/components/brand`.

## Catalog files

`src/i18n/messages/en/<area>.ts` and `src/i18n/messages/ar/<area>.ts`, one pair per area. Keys are
`<area>.<component-or-topic>.<name>` in camelCase (`triggers.editor.publishTitle`). Areas never share
keys; `common.*` holds the shared words (Save, Cancel, Retry, …) and is read-only for area work.
`src/i18n/catalog.test.ts` fails when a key lacks its prefix, Arabic misses or adds a key, a pattern is
malformed, the variables differ between languages, or an Arabic value is just the English text.

## Message syntax (ICU subset)

- `{name}` variable · `'{'` literal brace
- `{count, plural, one {# chat} other {# chats}}` — Arabic uses `zero one two few many other`
- `{kind, select, transfer {Transfer request} other {New chat}}`

Write whole sentences with variables; never concatenate translated fragments (word order differs in Arabic).

## Bidirectional text and RTL layout

- User content (visitor names, messages, emails, URLs, notes, tags, page titles) gets `dir="auto"` on its
  element, or `<bdi>` when it sits inside a translated sentence. When it is a **variable of a visible
  translated string**, wrap it: `t('shell.verify.notice', { email: isolate(email) })` (`isolate` from `@/i18n`;
  not for file names, URLs or copied values).
- Use logical utilities: `ms-/me-` (not `ml-/mr-`), `ps-/pe-`, `start-/end-` (not `left-/right-`),
  `text-start/text-end`, `border-s/border-e`, `rounded-s/rounded-e`, `rounded-ss/se/es/ee`.
- Icons that point a direction (chevrons, arrows for back/next/open) get `rtl:-scale-x-100`.
- Codes, ids, keys and URLs that must stay left-to-right get `dir="ltr"` (e.g. API tokens, hostnames).

## Checks

```
npx tsc --noEmit -p .                     # from apps/dashboard
npx vitest run src/i18n
node scripts/i18n-scan.mjs src/components/<dir>   # hard-coded copy left; 0 is the goal
```

A line that must stay literal (sample data, CSS, a protocol code) ends with `// i18n-ignore`.
`src/app/design-system` (developer component stories, not served in production) is English only and not scanned.

## Arabic terminology (use consistently)

Modern Standard Arabic, short UI register, imperative for buttons (حفظ، إلغاء، إرسال).

| English | Arabic | English | Arabic |
| --- | --- | --- | --- |
| chat / conversation | محادثة | visitor | زائر |
| agent (team member) | موظف | team | الفريق |
| owner / admin | المالك / مسؤول | supervisor / analyst | مشرف / محلل |
| department | قسم | queue (waiting) | قائمة الانتظار |
| unassigned | غير مُسندة | capacity | السعة |
| routing | التوجيه | transfer | تحويل |
| offer (chat offer) | عرض محادثة | accept / decline | قبول / رفض |
| transcript | سجل المحادثة | internal note | ملاحظة داخلية |
| shortcut (canned reply) | اختصار | trigger (automation) | مُشغِّل |
| tag | وسم | custom field | حقل مخصص |
| website / site | موقع | chat widget | أداة الدردشة |
| offline message | رسالة خارج الدوام | operating hours | ساعات العمل |
| ban | حظر | rating | التقييم |
| analytics | التحليلات | monitor | المراقبة |
| history | السجل | audit log | سجل التدقيق |
| integration | تكامل | webhook | Webhook (ويب هوك) |
| API token | رمز API | privacy request | طلب خصوصية |
| erasure | محو البيانات | data export | تصدير البيانات |
| workspace | مساحة العمل | settings | الإعدادات |
| sign in / sign out | تسجيل الدخول / تسجيل الخروج | two-step verification | التحقق بخطوتين |
| draft / publish | مسودة / نشر | revision | مراجعة |
