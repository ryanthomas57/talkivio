import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { FieldRequirement, PublicDepartment } from '@talkivio/contracts/protocol';
import type { StringKey } from '../i18n';
import { EMAIL_RE, PHONE_RE } from '../util';
import { useUi } from './common';
import { IconAlert, IconCheck, IconMoon, IconRefresh } from './icons';

type Errors = Partial<Record<string, string>>;

function Field({ id, label, requirement, error, children }: { id: string; label: string; requirement: FieldRequirement | 'required'; error?: string; children: ComponentChildren }) {
  const { t } = useUi();
  return (
    <div class="rd-field">
      <label class="rd-label" for={id}>
        {label}
        {requirement === 'optional' && <span class="rd-optional"> ({t('optional')})</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-err`} class="rd-field-error">
          <IconAlert size={14} />
          {error}
        </p>
      )}
    </div>
  );
}

const inputProps = (id: string, error: string | undefined, required: boolean) => ({
  id,
  class: 'rd-input',
  'aria-invalid': error ? true : undefined,
  'aria-describedby': error ? `${id}-err` : undefined,
  'aria-required': required ? true : undefined,
});

function focusFirstError(form: HTMLFormElement | null) {
  form?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

function DepartmentSelect({ id, value, onChange, departments, requirement, markOffline, error }: { id: string; value: string; onChange: (v: string) => void; departments: PublicDepartment[]; requirement: FieldRequirement; markOffline: boolean; error?: string }) {
  const { t } = useUi();
  return (
    <select {...inputProps(id, error, requirement === 'required')} class="rd-input rd-select" value={value} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
      {requirement === 'required' ? (
        <option value="" disabled>
          {t('choose_department')}
        </option>
      ) : (
        <option value="">{t('any_department')}</option>
      )}
      {departments.map((d) => (
        <option key={d.id} value={d.id} disabled={markOffline && !d.online}>
          {markOffline && !d.online ? `${d.name} ${t('offline_suffix')}` : d.name}
        </option>
      ))}
    </select>
  );
}

function validate(t: (k: StringKey) => string, fields: Array<[string, string, FieldRequirement, 'text' | 'email' | 'phone']>): Errors {
  const errors: Errors = {};
  for (const [key, value, req, kind] of fields) {
    const v = value.trim();
    if (req === 'hidden') continue;
    if (!v) {
      if (req === 'required') errors[key] = t('required');
      continue;
    }
    if (kind === 'email' && !EMAIL_RE.test(v)) errors[key] = t('invalid_email');
    if (kind === 'phone' && !PHONE_RE.test(v)) errors[key] = t('invalid_phone');
  }
  return errors;
}

export function PrechatForm() {
  const { c, s, t } = useUi();
  const p = s.config.behavior.prechatForm;
  const departments = s.account?.departments ?? [];
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(s.visitor?.name ?? '');
  const [email, setEmail] = useState(s.visitor?.email ?? '');
  const [phone, setPhone] = useState(s.visitor?.phone ?? '');
  const [dept, setDept] = useState(s.departmentId && departments.some((d) => d.id === s.departmentId && d.online) ? s.departmentId : '');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const deptReq: FieldRequirement = departments.length ? p.department : 'hidden';

  const submit = async (e: Event) => {
    e.preventDefault();
    const errs = validate(t, [
      ['name', name, p.name, 'text'],
      ['email', email, p.email, 'email'],
      ['phone', phone, p.phone, 'phone'],
      ['dept', dept, deptReq, 'text'],
      ['message', message, 'required', 'text'],
    ]);
    setErrors(errs);
    if (Object.keys(errs).length) return requestAnimationFrame(() => focusFirstError(formRef.current));
    setBusy(true);
    const profile = {
      ...(p.name !== 'hidden' && name.trim() ? { name: name.trim() } : {}),
      ...(p.email !== 'hidden' && email.trim() ? { email: email.trim() } : {}),
      ...(p.phone !== 'hidden' && phone.trim() ? { phone: phone.trim() } : {}),
    };
    await c.submitPrechat({ profile, departmentId: dept || null, message });
    setBusy(false);
  };

  return (
    <form ref={formRef} class="rd-form" onSubmit={submit} noValidate>
      {s.config.content.prechatGreeting.trim() && (
        <p class="rd-form-intro" dir="auto">
          {s.config.content.prechatGreeting}
        </p>
      )}
      {p.name !== 'hidden' && (
        <Field id="rd-pc-name" label={t('name')} requirement={p.name} error={errors.name}>
          <input {...inputProps('rd-pc-name', errors.name, p.name === 'required')} type="text" autocomplete="name" dir="auto" maxLength={100} value={name} data-autofocus="" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </Field>
      )}
      {p.email !== 'hidden' && (
        <Field id="rd-pc-email" label={t('email')} requirement={p.email} error={errors.email}>
          <input {...inputProps('rd-pc-email', errors.email, p.email === 'required')} type="email" inputMode="email" autocomplete="email" dir="ltr" maxLength={200} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} />
        </Field>
      )}
      {p.phone !== 'hidden' && (
        <Field id="rd-pc-phone" label={t('phone')} requirement={p.phone} error={errors.phone}>
          <input {...inputProps('rd-pc-phone', errors.phone, p.phone === 'required')} type="tel" inputMode="tel" autocomplete="tel" dir="ltr" maxLength={40} value={phone} onInput={(e) => setPhone((e.target as HTMLInputElement).value)} />
        </Field>
      )}
      {deptReq !== 'hidden' && (
        <Field id="rd-pc-dept" label={t('department')} requirement={deptReq} error={errors.dept}>
          <DepartmentSelect id="rd-pc-dept" value={dept} onChange={setDept} departments={departments} requirement={deptReq} markOffline error={errors.dept} />
        </Field>
      )}
      <Field id="rd-pc-msg" label={t('message_label')} requirement="required" error={errors.message}>
        <textarea {...inputProps('rd-pc-msg', errors.message, true)} rows={3} dir="auto" maxLength={5000} value={message} onInput={(e) => setMessage((e.target as HTMLTextAreaElement).value)} />
      </Field>
      <button type="submit" class="rd-btn rd-btn-primary rd-btn-block" disabled={busy}>
        {t('start_chat')}
      </button>
    </form>
  );
}

export function OfflineView() {
  const { c, s, t } = useUi();
  const o = s.config.behavior.offlineForm;
  const content = s.config.content;
  const draft = s.offlineDraft;
  const departments = s.account?.departments ?? [];
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(draft?.name ?? s.visitor?.name ?? '');
  const [email, setEmail] = useState(draft?.email ?? s.visitor?.email ?? '');
  const [phone, setPhone] = useState(draft?.phone ?? s.visitor?.phone ?? '');
  const [dept, setDept] = useState(draft?.departmentId ?? s.departmentId ?? '');
  const [message, setMessage] = useState(draft?.message ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const deptReq: FieldRequirement = departments.length ? o.department : 'hidden';

  if (!o.enabled) {
    return (
      <div class="rd-center">
        <span class="rd-center-icon">
          <IconMoon size={22} />
        </span>
        <h3 dir="auto">{content.offlineTitle}</h3>
        <p dir="auto">{content.offlineMessage}</p>
      </div>
    );
  }

  const keep = (patch: Record<string, string>) => c.setOfflineDraft({ name, email, phone, departmentId: dept || null, message, ...patch });
  const submit = async (e: Event) => {
    e.preventDefault();
    const errs = validate(t, [
      ['name', name, 'required', 'text'],
      ['email', email, 'required', 'email'],
      ['phone', phone, o.phone, 'phone'],
      ['dept', dept, deptReq, 'text'],
      ['message', message, 'required', 'text'],
    ]);
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return requestAnimationFrame(() => focusFirstError(formRef.current));
    setBusy(true);
    const res = await c.submitOffline({ name, email, phone: o.phone !== 'hidden' ? phone : undefined, departmentId: dept || null, message });
    setBusy(false);
    if (res.ok) return;
    // Server validation (wire field names) → inline field errors.
    const fe = res.fieldErrors ?? {};
    const mapped: Errors = {};
    for (const [wire, key] of [['name', 'name'], ['email', 'email'], ['phone', 'phone'], ['message', 'message'], ['department_id', 'dept']] as const) {
      if (fe[wire]?.length) mapped[key] = fe[wire][0];
    }
    if (Object.keys(mapped).length) {
      setErrors(mapped);
      return requestAnimationFrame(() => focusFirstError(formRef.current));
    }
    setFormError(res.error === 'RATE_LIMITED' ? t('rate_limited') : res.error === 'NOT_CONNECTED' ? t('error_network') : t('error_session'));
  };
  const fromQueue = s.offline?.reason === 'queue';

  return (
    <form ref={formRef} class="rd-form" onSubmit={submit} noValidate>
      <div class="rd-form-head">
        <h3 class="rd-form-title" dir="auto">
          {content.offlineTitle}
        </h3>
        <p class="rd-form-intro" dir="auto">
          {content.offlineMessage}
        </p>
      </div>
      {fromQueue && (
        <button type="button" class="rd-link rd-self-start" onClick={() => c.backToChat()}>
          {t('back_to_chat')}
        </button>
      )}
      {s.offline?.reason === 'department' && (
        <p class="rd-alert rd-alert-info" role="status">
          <IconAlert size={16} />
          <span>{t('dept_offline', { name: s.offline.department ?? t('department') })}</span>
        </p>
      )}
      {formError && (
        <p class="rd-alert" role="alert">
          <IconAlert size={16} />
          <span>{formError}</span>
        </p>
      )}
      <Field id="rd-of-name" label={t('name')} requirement="required" error={errors.name}>
        <input {...inputProps('rd-of-name', errors.name, true)} type="text" autocomplete="name" dir="auto" maxLength={100} value={name} data-autofocus="" onInput={(e) => (setName((e.target as HTMLInputElement).value), keep({ name: (e.target as HTMLInputElement).value }))} />
      </Field>
      <Field id="rd-of-email" label={t('email')} requirement="required" error={errors.email}>
        <input {...inputProps('rd-of-email', errors.email, true)} type="email" inputMode="email" autocomplete="email" dir="ltr" maxLength={200} value={email} onInput={(e) => (setEmail((e.target as HTMLInputElement).value), keep({ email: (e.target as HTMLInputElement).value }))} />
      </Field>
      {o.phone !== 'hidden' && (
        <Field id="rd-of-phone" label={t('phone')} requirement={o.phone} error={errors.phone}>
          <input {...inputProps('rd-of-phone', errors.phone, o.phone === 'required')} type="tel" inputMode="tel" autocomplete="tel" dir="ltr" maxLength={40} value={phone} onInput={(e) => (setPhone((e.target as HTMLInputElement).value), keep({ phone: (e.target as HTMLInputElement).value }))} />
        </Field>
      )}
      {deptReq !== 'hidden' && (
        <Field id="rd-of-dept" label={t('department')} requirement={deptReq} error={errors.dept}>
          <DepartmentSelect id="rd-of-dept" value={dept} onChange={(v) => (setDept(v), keep({ departmentId: v }))} departments={departments} requirement={deptReq} markOffline={false} error={errors.dept} />
        </Field>
      )}
      <Field id="rd-of-msg" label={t('message_label')} requirement="required" error={errors.message}>
        <textarea {...inputProps('rd-of-msg', errors.message, true)} rows={4} dir="auto" maxLength={5000} value={message} onInput={(e) => (setMessage((e.target as HTMLTextAreaElement).value), keep({ message: (e.target as HTMLTextAreaElement).value }))} />
      </Field>
      <button type="submit" class="rd-btn rd-btn-primary rd-btn-block" disabled={busy}>
        {t('send_message')}
      </button>
    </form>
  );
}

export function OfflineSuccess() {
  const { c, s, t } = useUi();
  const ref = s.offlineSent?.reference;
  return (
    <div class="rd-center" role="status">
      <span class="rd-center-icon rd-success">
        <IconCheck size={22} />
      </span>
      <h3>{t('sent_title')}</h3>
      <p dir="auto">{s.config.content.offlineThanks}</p>
      {ref && (
        <p class="rd-ref">
          {t('reference')}: <code dir="ltr">{ref}</code>
        </p>
      )}
      <button type="button" class="rd-btn rd-btn-secondary rd-mt" onClick={() => c.resetOffline()}>
        {t('send_another')}
      </button>
    </div>
  );
}

export function LoadingView() {
  const { t } = useUi();
  return (
    <div class="rd-skel" role="status" aria-live="polite">
      <span class="rd-sr">{t('connecting')}</span>
      <div class="rd-skel-row">
        <span class="rd-skel-a" />
        <span class="rd-skel-b" style={{ width: '62%' }} />
      </div>
      <div class="rd-skel-row">
        <span class="rd-skel-a" />
        <span class="rd-skel-b" style={{ width: '44%' }} />
      </div>
      <div class="rd-skel-row rd-skel-me">
        <span class="rd-skel-b" style={{ width: '50%' }} />
      </div>
    </div>
  );
}

const ERROR_TEXT: Record<string, StringKey> = {
  UNKNOWN_SITE: 'error_widget',
  ORIGIN_NOT_ALLOWED: 'error_origin',
  RATE_LIMITED: 'error_rate',
  AUTH_REQUIRED: 'error_session',
  SERVICE_UNAVAILABLE: 'error_session',
  INTERNAL: 'error_session',
};

export function ErrorView() {
  const { c, s, t } = useUi();
  const code = s.fatal ?? 'NETWORK';
  if (code === 'BANNED') {
    // Neutral wording: never reveal that the visitor was banned.
    return (
      <div class="rd-center" role="status">
        <span class="rd-center-icon">
          <IconMoon size={22} />
        </span>
        <h3>{t('service_unavailable')}</h3>
      </div>
    );
  }
  const retryable = code !== 'UNKNOWN_SITE' && code !== 'ORIGIN_NOT_ALLOWED';
  return (
    <div class="rd-center" role="alert">
      <span class="rd-center-icon rd-danger">
        <IconAlert size={22} />
      </span>
      <h3>{t('error_title')}</h3>
      <p>{t(ERROR_TEXT[code] ?? 'error_network')}</p>
      {retryable && code !== 'RATE_LIMITED' && (
        <button type="button" class="rd-btn rd-btn-secondary rd-mt" onClick={() => c.retryConnection()}>
          <IconRefresh size={16} />
          {t('try_again')}
        </button>
      )}
    </div>
  );
}
