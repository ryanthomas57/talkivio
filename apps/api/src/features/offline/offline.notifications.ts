import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { mergeOrgSettings } from '@talkivio/contracts';
import { TenantDb } from '../../db/tenant-db';
import { decrypt } from '../../common/crypto';
import { env } from '../../config/env';
import { MailService } from '../../core/mail.service';
import { EventConsumers } from '../../outbox/event-consumers';
import type { InternalEvent } from '../../outbox/outbox.publisher';
import { EMAIL_RE, offlinePolicy } from './offline.policy';

/**
 * Offline notifications (ch. 23), run by the worker after the submission commits.
 * At-least-once safe: every email is keyed by (template, submission, recipient) in
 * `outbound_emails`, so retries never duplicate; SMTP failures retry in the email
 * queue while the submission stays saved. Phone numbers are never emailed.
 */
@Injectable()
export class OfflineNotifications implements OnModuleInit {
  private readonly logger = new Logger('OfflineNotifications');

  constructor(
    private readonly db: TenantDb,
    private readonly consumers: EventConsumers,
    private readonly mail: MailService,
  ) {}

  onModuleInit(): void {
    this.consumers.on('offline.submitted', 'offline.notify', (e) => this.handle(e));
  }

  async handle(e: InternalEvent): Promise<void> {
    const tenantId = e.tenantId;
    const ctx = await this.db.read(tenantId, async (tx) => {
      const sub = await tx.offlineSubmission.findFirst({ where: { tenantId, id: e.aggregateId } });
      if (!sub || sub.status === 'erased') return null;
      const [tenant, site, rev] = await Promise.all([
        tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true, name: true } }),
        tx.site.findFirst({ where: { tenantId, id: sub.siteId }, select: { name: true } }),
        tx.widgetConfigRevision.findFirst({ where: { tenantId, siteId: sub.siteId, publishedAt: { not: null } }, orderBy: { revision: 'desc' } }),
      ]);
      const policy = offlinePolicy(rev?.config ?? null);
      const settings = mergeOrgSettings(tenant.settings);
      let recipients: string[] = settings.notifications.offlineMessageRecipients.filter((r) => EMAIL_RE.test(r));
      if (!recipients.length) {
        const members = await tx.membership.findMany({
          where: {
            tenantId,
            enabled: true,
            archivedAt: null,
            ...(policy.teamRecipientIds.length ? { id: { in: policy.teamRecipientIds } } : { role: { in: ['owner', 'admin'] } }),
          },
          include: { user: { select: { email: true } } },
        });
        recipients = members.map((m) => m.user.email).filter((x): x is string => !!x);
      }
      return { sub, site: site?.name ?? tenant.name, policy, notifyTeam: settings.notifications.emailOfflineMessages, recipients: [...new Set(recipients.map((r) => r.toLowerCase()))] };
    });
    if (!ctx) return;
    const { sub } = ctx;
    let email = '';
    try {
      email = sub.emailCiphertext ? decrypt(sub.emailCiphertext) : '';
    } catch {
      this.logger.warn(`Cannot decrypt email for offline submission ${sub.id}`);
    }
    if (ctx.policy.confirmationEnabled && email) {
      await this.mail.sendTemplate('offline_confirmation', email, { name: sub.name, site: ctx.site, reference: sub.reference, message: sub.message }, sub.id, tenantId);
    }
    if (ctx.notifyTeam) {
      const url = `${env().APP_URL.replace(/\/$/, '')}/offline-messages/${sub.id}`;
      for (const to of ctx.recipients) {
        await this.mail.sendTemplate('offline_team_notification', to, { name: sub.name, site: ctx.site, reference: sub.reference, message: sub.message, url }, sub.id, tenantId);
      }
    }
  }
}
