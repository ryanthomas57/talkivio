import { MetricsService } from './metrics.service';
import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { TenantDb } from '../db/tenant-db';
import { env, isProd } from '../config/env';
import { QueueService, QUEUES } from './queue.service';

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export type MailTemplate =
  | 'verify_email'
  | 'password_reset'
  | 'agent_invitation'
  | 'transcript'
  | 'offline_confirmation'
  | 'offline_team_notification'
  | 'offline_reply'
  | 'weekly_report'
  | 'export_ready'
  | 'transcript_export'
  | 'tenant_deletion_scheduled'
  | 'tenant_deletion_cancelled';

interface Rendered {
  subject: string;
  heading: string;
  paragraphs: string[];
  action?: { label: string; url: string };
  preformatted?: string;
  footer?: string;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Delivery attempts per email (BullMQ), exponential backoff from the base delay (5 s → ~10 min in total). */
const EMAIL_ATTEMPTS = 8;
/** Non-production override of the base delay (TALKIVIO_EMAIL_RETRY_BASE_MS), e.g. for the SMTP end-to-end test. */
function emailRetryBaseMs(): number {
  const override = Number(process.env.TALKIVIO_EMAIL_RETRY_BASE_MS);
  return !isProd() && Number.isFinite(override) && override > 0 ? override : 5000;
}

/** Templates: every interpolated value is escaped; no user-supplied headers. */
function render(t: MailTemplate, vars: Record<string, unknown>): Rendered {
  const brand = env().BRAND_NAME;
  switch (t) {
    case 'verify_email':
      return {
        subject: 'Confirm your email address',
        heading: 'Confirm your email address',
        paragraphs: [
          `Hi ${str(vars.name)},`,
          `Confirm this address to finish setting up your ${brand} account. The link expires in 48 hours.`,
        ],
        action: { label: 'Confirm email', url: str(vars.url) },
        footer: 'If you did not create an account, ignore this email.',
      };
    case 'password_reset':
      return {
        subject: 'Reset your password',
        heading: 'Reset your password',
        paragraphs: [
          `Hi ${str(vars.name)},`,
          'Someone asked to reset your password. This link expires in 30 minutes and works once.',
        ],
        action: { label: 'Choose a new password', url: str(vars.url) },
        footer: 'If you did not request this, you can ignore this email. Your password will not change.',
      };
    case 'agent_invitation':
      return {
        subject: `${str(vars.inviter)} invited you to ${str(vars.tenant)} on ${brand}`,
        heading: `Join ${str(vars.tenant)}`,
        paragraphs: [
          `${str(vars.inviter)} invited you to join ${str(vars.tenant)} as ${str(vars.role)}.`,
          'The invitation expires in 7 days.',
        ],
        action: { label: 'Accept invitation', url: str(vars.url) },
      };
    case 'transcript':
      return {
        subject: `Your chat transcript with ${str(vars.site)}`,
        heading: `Your conversation with ${str(vars.site)}`,
        paragraphs: ['Here is a copy of your chat.'],
        preformatted: str(vars.transcript),
        footer: 'This transcript excludes internal notes.',
      };
    case 'offline_confirmation':
      return {
        subject: `We received your message (ref ${str(vars.reference)})`,
        heading: 'Thanks, we got your message',
        paragraphs: [
          `Hi ${str(vars.name) || 'there'},`,
          `${str(vars.site)} will reply to you by email. Your reference is ${str(vars.reference)}.`,
        ],
        preformatted: str(vars.message),
      };
    case 'offline_team_notification':
      return {
        subject: `New offline message ${str(vars.reference)}`,
        heading: `New offline message from ${str(vars.name) || 'a visitor'}`,
        paragraphs: [`Reference: ${str(vars.reference)}`, `Site: ${str(vars.site)}`],
        preformatted: str(vars.message),
        action: { label: 'Open in Talkivio', url: str(vars.url) },
      };
    case 'offline_reply':
      return {
        subject: `Re: your message to ${str(vars.site)} (ref ${str(vars.reference)})`,
        heading: `Reply from ${str(vars.site)}`,
        paragraphs: [`${str(vars.agent)} replied:`],
        preformatted: str(vars.body),
      };
    case 'weekly_report':
      return {
        subject: `${str(vars.tenant)}: weekly chat summary`,
        heading: `${str(vars.tenant)}: your week`,
        paragraphs: (vars.lines as string[]) ?? [],
        action: { label: 'Open analytics', url: str(vars.url) },
      };
    case 'export_ready':
      return {
        subject: 'Your export is ready',
        heading: 'Your export is ready',
        paragraphs: ['Sign in to download it. The download link expires in 24 hours.'],
        action: { label: 'Open exports', url: str(vars.url) },
      };
    case 'tenant_deletion_scheduled':
      return {
        subject: `${str(vars.tenant)} is scheduled for deletion`,
        heading: `${str(vars.tenant)} will be deleted on ${str(vars.destroyAfter)}`,
        paragraphs: [
          `${str(vars.requester)} asked to permanently delete the ${str(vars.tenant)} workspace on ${brand}.`,
          `Until ${str(vars.cancelBefore)} the workspace keeps working and the owner can cancel the request. After that, its chats, visitors, files, settings and team memberships are destroyed; this cannot be undone.`,
          `The owner can download a transcript archive from the exports page until the deletion runs (${str(vars.exportScope)}).`,
        ],
        action: { label: 'Review or cancel', url: str(vars.url) },
        footer:
          'You receive this because you are an owner or admin of this workspace. If you did not expect it, contact the owner now.',
      };
    case 'tenant_deletion_cancelled':
      return {
        subject: `Deletion of ${str(vars.tenant)} was cancelled`,
        heading: `${str(vars.tenant)} will not be deleted`,
        paragraphs: [
          `${str(vars.requester)} cancelled the scheduled deletion of the ${str(vars.tenant)} workspace. Nothing was removed.`,
        ],
        action: { label: `Open ${brand}`, url: str(vars.url) },
        footer: 'You receive this because you are an owner or admin of this workspace.',
      };
    case 'transcript_export': {
      // Transcript with optional PDF link (files feature). `internal` marks staff copies that include notes.
      const internal = vars.internal === true;
      return {
        subject: internal
          ? `Chat #${str(vars.number)} transcript (internal) for ${str(vars.site)}`
          : `Your chat transcript with ${str(vars.site)}`,
        heading: internal
          ? `Chat #${str(vars.number)} transcript`
          : `Your conversation with ${str(vars.site)}`,
        paragraphs: [
          vars.url
            ? 'Your transcript is ready. The download link below works for 24 hours.'
            : 'Here is a copy of the chat.',
        ],
        action: vars.url ? { label: 'Download PDF transcript', url: str(vars.url) } : undefined,
        preformatted: str(vars.transcript),
        footer: internal
          ? 'This transcript includes internal notes. Do not forward it to customers.'
          : 'This transcript excludes internal notes.',
      };
    }
  }
}

export function renderEmail(r: Rendered): { html: string; text: string } {
  const brand = env().BRAND_NAME;
  const paras = r.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:24px;color:#17222E">${esc(p)}</p>`)
    .join('');
  const action = r.action
    ? `<p style="margin:24px 0"><a href="${esc(r.action.url)}" style="display:inline-block;background:#07778A;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:11px 18px;border-radius:8px">${esc(r.action.label)}</a></p><p style="margin:0 0 14px;font-size:12px;color:#4C5D70">Or paste this link into your browser:<br><span style="word-break:break-all">${esc(r.action.url)}</span></p>`
    : '';
  const pre = r.preformatted
    ? `<pre style="white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:13px;line-height:20px;background:#F4F7FA;border:1px solid #D5DEE8;border-radius:8px;padding:14px;color:#17222E">${esc(r.preformatted)}</pre>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F4F7FA;font-family:Inter,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border:1px solid #D5DEE8;border-radius:12px">
<tr><td style="padding:20px 28px;border-bottom:1px solid #D5DEE8;font-weight:650;font-size:15px;color:#17222E">${esc(brand)}</td></tr>
<tr><td style="padding:26px 28px"><h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:#17222E">${esc(r.heading)}</h1>${paras}${action}${pre}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #D5DEE8;font-size:12px;color:#4C5D70">${esc(r.footer ?? `Sent by ${brand}.`)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    r.heading,
    '',
    ...r.paragraphs,
    r.action ? `\n${r.action.label}: ${r.action.url}` : '',
    r.preformatted ? `\n${r.preformatted}` : '',
    '',
    r.footer ?? `Sent by ${brand}.`,
  ].join('\n');
  return { html, text };
}

/**
 * Transactional email through SMTP (Mailpit locally). One row per semantic send
 * (unique dedupe key), delivered by the worker with retries. "Accepted" (SMTP
 * accepted) is tracked separately from "delivered" (provider callback).
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private transporter: Transporter | null = null;

  constructor(
    private readonly db: TenantDb,
    private readonly queues: QueueService,
    private readonly metrics: MetricsService,
  ) {}

  async sendTemplate(
    template: MailTemplate,
    to: string,
    vars: Record<string, unknown>,
    dedupeKey: string,
    tenantId: string | null = null,
  ): Promise<{ id: string; duplicate: boolean }> {
    const r = render(template, vars);
    const { html, text } = renderEmail(r);
    try {
      const row = await this.db.root.outboundEmail.create({
        data: {
          tenantId,
          dedupeKey: `${template}:${dedupeKey}:${to.toLowerCase()}`,
          recipient: to,
          subject: r.subject,
          textBody: text,
          htmlBody: html,
          template,
        },
      });
      await this.queues.add(
        QUEUES.email,
        'send',
        { emailId: row.id },
        {
          jobId: `email-${row.id}`,
          attempts: EMAIL_ATTEMPTS,
          backoff: { type: 'exponential', delay: emailRetryBaseMs() },
        },
      );
      return { id: row.id, duplicate: false };
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        const existing = await this.db.root.outboundEmail.findUniqueOrThrow({
          where: { dedupeKey: `${template}:${dedupeKey}:${to.toLowerCase()}` },
        });
        return { id: existing.id, duplicate: true };
      }
      throw err;
    }
  }

  /**
   * Worker: attempt SMTP delivery. Throws to retry; never marks delivered without proof. A failed attempt that will
   * be retried leaves the row `queued` (with attempts and last_error); only the final attempt marks it `failed`.
   */
  async deliver(emailId: string, opts: { finalAttempt: boolean } = { finalAttempt: true }): Promise<void> {
    const email = await this.db.root.outboundEmail.findUnique({ where: { id: emailId } });
    // Cancelled rows (e.g. erased subjects) and already-sent rows are never (re)sent.
    if (!email || email.status === 'accepted' || email.status === 'delivered' || email.status === 'cancelled')
      return;
    const e = env();
    try {
      if (e.EMAIL_PROVIDER === 'smtp') {
        const info = await this.smtp().sendMail({
          from: e.EMAIL_FROM,
          to: email.recipient,
          subject: email.subject,
          text: email.textBody,
          html: email.htmlBody,
        });
        await this.db.root.outboundEmail.update({
          where: { id: emailId },
          data: {
            status: 'accepted',
            providerMessageId: info.messageId ?? null,
            acceptedAt: new Date(),
            attempts: { increment: 1 },
            lastError: null,
          },
        });
        this.metrics.emailDeliveries.inc(this.metrics.labels({ outcome: 'accepted' }));
      } else {
        this.logger.log(`[console mail] to=${email.recipient} subject="${email.subject}"`);
        // Local development without SMTP/Mailpit: print the text body so links can be followed.
        // Never in production (bodies can carry single-use links).
        if (!isProd()) this.logger.log(`[console mail body, development only]\n${email.textBody}`);
        await this.db.root.outboundEmail.update({
          where: { id: emailId },
          data: {
            status: 'accepted',
            providerMessageId: 'console',
            acceptedAt: new Date(),
            attempts: { increment: 1 },
          },
        });
      }
    } catch (err) {
      await this.db.root.outboundEmail.update({
        where: { id: emailId },
        data: {
          status: opts.finalAttempt ? 'failed' : 'queued',
          lastError: (err as Error).message.slice(0, 500),
          attempts: { increment: 1 },
        },
      });
      this.metrics.emailDeliveries.inc(
        this.metrics.labels({ outcome: opts.finalAttempt ? 'failed' : 'retried' }),
      );
      throw err;
    }
  }

  private smtp(): Transporter {
    if (!this.transporter) {
      const e = env();
      this.transporter = nodemailer.createTransport({
        host: e.SMTP_HOST ?? 'localhost',
        port: e.SMTP_PORT,
        secure: e.SMTP_SECURE,
        auth: e.SMTP_USER ? { user: e.SMTP_USER, pass: e.SMTP_PASSWORD } : undefined,
      });
    }
    return this.transporter;
  }
}
