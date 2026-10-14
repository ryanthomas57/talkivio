'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailPlus, RotateCw, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  PanelError,
  Skeleton,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage, isApiError } from '@/lib/api';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { byId, useDepartments } from '@/lib/queries';
import { invitationsKey, useInviteErrorBanner, type Invitation } from './invite-dialog';
import { ROLE_LABEL } from './roles';

/** Pending invitations with expiry, revoke and resend (revoke + re-invite). */
export function Invitations({ onInvite }: { onInvite: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: invitationsKey,
    queryFn: () => api.get<Invitation[]>('/agents/invitations'),
    staleTime: 15_000,
  });
  const departments = useDepartments();
  const deptMap = byId(departments.data);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [resending, setResending] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ inv: Invitation; error: unknown } | null>(null);
  const describe = useInviteErrorBanner();

  const revoke = async (inv: Invitation) => {
    await api.delete(`/agents/invitations/${inv.id}`);
    await qc.invalidateQueries({ queryKey: invitationsKey });
    toast.success(t('team.invitations.revokedToast', { email: isolate(inv.email) }));
  };

  /**
   * Resend = revoke the old link, then invite again with the same role, departments
   * and capacity (the new email carries a fresh 7-day link). If the re-invite fails
   * the old link is already revoked, so the failure stays visible with a retry.
   */
  const resend = async (inv: Invitation, alreadyRevoked = false) => {
    setResending(inv.id);
    setFailure(null);
    try {
      if (!alreadyRevoked)
        await api.delete(`/agents/invitations/${inv.id}`).catch((e: unknown) => {
          // Already revoked elsewhere — continue with the new invitation.
          if (!isApiError(e, 'NOT_FOUND')) throw e;
        });
      const r = await api.post<{ email: string; expiresAt: string }>('/agents/invitations', {
        email: inv.email,
        role: inv.role,
        departmentIds: inv.departmentIds.filter((id) => deptMap.has(id)),
        capacity: inv.capacity,
      });
      toast.success(t('team.invitations.resentToast', { email: isolate(r.email) }));
    } catch (e) {
      setFailure({ inv, error: e });
    } finally {
      setResending(null);
      void qc.invalidateQueries({ queryKey: invitationsKey });
    }
  };

  let body: ReactNode;
  if (q.isLoading)
    body = (
      <div className="flex flex-col gap-3 p-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  else if (q.isError) body = <PanelError message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  else if (!q.data?.length)
    body = (
      <EmptyState
        icon={<MailPlus />}
        title={t('team.invitations.emptyTitle')}
        description={t('team.invitations.emptyBody')}
        action={
          <Button variant="primary" onClick={onInvite}>
            {t('team.invite.title')}
          </Button>
        }
      />
    );
  else {
    const rows = q.data;
    const deptNames = (inv: Invitation) =>
      inv.departmentIds
        .map((id) => deptMap.get(id)?.name)
        .filter(Boolean)
        .join(', ') || '';
    const actions = (inv: Invitation) => (
      <div className="flex justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void resend(inv)}
          loading={resending === inv.id}
          aria-label={t('team.invitations.resendAria', { email: isolate(inv.email) })}
        >
          <RotateCw className="size-4" aria-hidden />
          {t('team.invitations.resend')}
        </Button>
        <Button
          size="sm"
          variant="danger-ghost"
          onClick={() => setRevoking(inv)}
          aria-label={t('team.invitations.revokeAria', { email: isolate(inv.email) })}
        >
          <X className="size-4" aria-hidden />
          {t('team.invitations.revoke')}
        </Button>
      </div>
    );
    body = (
      <>
        <TableScroll className="hidden sm:block">
          <Table>
            <THead>
              <tr>
                <TH>{t('common.email')}</TH>
                <TH>{t('team.invite.role')}</TH>
                <TH>{t('common.departments')}</TH>
                <TH>{t('team.invitations.capacity')}</TH>
                <TH>{t('team.invitations.sent')}</TH>
                <TH>{t('team.invitations.expires')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {rows.map((inv) => (
                <TR key={inv.id}>
                  <TD className="max-w-[260px] truncate font-medium" dir="auto">
                    {inv.email}
                  </TD>
                  <TD>{t(ROLE_LABEL[inv.role])}</TD>
                  <TD className="max-w-[220px] truncate text-fg-2" dir="auto">
                    {deptNames(inv)}
                  </TD>
                  <TD className="tabular">{formatNumber(inv.capacity)}</TD>
                  <TD>
                    <time
                      dateTime={inv.createdAt}
                      title={formatDateTime(inv.createdAt)}
                      className="text-fg-2"
                    >
                      {formatRelative(inv.createdAt)}
                    </time>
                  </TD>
                  <TD>
                    <Expiry at={inv.expiresAt} />
                  </TD>
                  <TD>{actions(inv)}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </TableScroll>
        <ul className="flex flex-col sm:hidden" aria-label={t('team.invitations.listLabel')}>
          {rows.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-col gap-2 border-b border-line-subtle px-4 py-3 last:border-b-0"
            >
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-all text-sm font-medium" dir="auto">
                  {inv.email}
                </span>
                <Badge>{t(ROLE_LABEL[inv.role])}</Badge>
              </div>
              <span className="text-xs text-fg-2">
                {t('team.invitations.mobileMeta', {
                  departments: isolate(deptNames(inv)),
                  capacity: inv.capacity,
                  sent: formatRelative(inv.createdAt),
                })}
              </span>
              <Expiry at={inv.expiresAt} />
              {actions(inv)}
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <Card>
      {failure && (
        <div className="flex flex-col gap-2 border-b border-line-subtle p-4">
          <Banner
            tone="danger"
            title={t('team.invitations.resendFailedTitle', { email: isolate(failure.inv.email) })}
          >
            {t('team.invitations.resendFailedBody')}
          </Banner>
          {describe(failure.error)}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void resend(failure.inv, true)}
              loading={resending === failure.inv.id}
            >
              {t('team.invitations.retry')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
              {t('common.dismiss')}
            </Button>
          </div>
        </div>
      )}
      {body}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={t('team.invitations.revokeTitle', { email: isolate(revoking?.email) })}
        danger
        confirmLabel={t('team.invitations.revokeConfirm')}
        description={t('team.invitations.revokeBody')}
        onConfirm={() => (revoking ? revoke(revoking) : undefined)}
      />
    </Card>
  );
}

function Expiry({ at }: { at: string }) {
  const t = useT();
  const ms = new Date(at).getTime() - Date.now();
  const soon = ms < 24 * 3600_000;
  return (
    <time
      dateTime={at}
      title={formatDateTime(at)}
      className={soon ? 'text-sm font-medium text-warning' : 'text-sm text-fg-2'}
    >
      {ms <= 0
        ? t('team.invitations.expired')
        : t('team.invitations.expiresIn', { time: formatRelative(at) })}
    </time>
  );
}
