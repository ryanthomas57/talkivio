'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, KeyRound, MoreHorizontal, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  PanelError,
  Skeleton,
  SwitchField,
  Table,
  TableScroll,
  TD,
  TH,
  THead,
  TR,
} from '@/components/ui';
import { BRAND_NAME } from '@/components/brand';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatRelative } from '@/lib/format';
import { uuid } from '@/lib/ids';
import { useSession } from '@/stores/session';
import { useRecentAuth } from './recent-auth';
import { richT } from './rich';
import { DAY_MS, DEFAULT_TTL_DAYS, MAX_TTL_DAYS, scopeLabel } from './scopes';
import { OneTimeSecretDialog } from './secret-panel';
import { TokenCreateDialog } from './token-create-dialog';
import { integrationKeys, type IntegrationToken, type IntegrationTokenWithSecret, type TokenStatus } from './types';

const STATUS: Record<TokenStatus, { label: MessageKey; tone: 'success' | 'warning' | 'neutral'; Icon: typeof CheckCircle2 }> = {
  active: { label: 'integrations.tokenStatus.active', tone: 'success', Icon: CheckCircle2 },
  expired: { label: 'integrations.tokenStatus.expired', tone: 'warning', Icon: Clock },
  revoked: { label: 'integrations.tokenStatus.revoked', tone: 'neutral', Icon: XCircle },
};

/** Protocol sample (a code: shown as-is). */
const AUTH_HEADER_SAMPLE = 'Authorization: Bearer <token>';

export function TokenStatusBadge({ status }: { status: TokenStatus }) {
  const t = useT();
  const m = STATUS[status];
  return (
    <Badge tone={m.tone} icon={<m.Icon className="size-3.5" aria-hidden />}>
      {t(m.label)}
    </Badge>
  );
}

export function TokensPanel({ showRevoked, onShowRevoked }: { showRevoked: boolean; onShowRevoked: (v: boolean) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const meId = useSession((s) => s.me?.user.id);
  const { guard, dialog } = useRecentAuth();
  const q = useQuery({ queryKey: integrationKeys.tokens(showRevoked), queryFn: () => api.get<IntegrationToken[]>('/integration-tokens', { includeRevoked: showRevoked ? 'true' : undefined }) });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ title: string; token: IntegrationTokenWithSecret } | null>(null);
  const [rotating, setRotating] = useState<IntegrationToken | null>(null);
  const [revoking, setRevoking] = useState<IntegrationToken | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: integrationKeys.tokensAll });
  // The API resolves the creator's display name; a null name means the user no longer exists.
  const creator = (tok: IntegrationToken) => {
    if (!tok.createdBy) return t('common.unknown');
    if (tok.createdBy === meId) return tok.createdByName ? t('integrations.tokens.creatorYouNamed', { name: isolate(tok.createdByName) }) : t('integrations.tokens.creatorYou');
    return tok.createdByName ?? t('integrations.tokens.creatorFormer');
  };
  const items = q.data ?? [];

  return (
    <Card>
      <CardHeader
        title={t('integrations.tokens.title')}
        description={t('integrations.tokens.description', { brand: BRAND_NAME, defaultDays: DEFAULT_TTL_DAYS, maxDays: MAX_TTL_DAYS })}
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden />
            {t('integrations.tokens.create')}
          </Button>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-4 py-2 sm:px-6">
        <SwitchField label={t('integrations.tokens.showRevoked')} checked={showRevoked} onCheckedChange={onShowRevoked} className="w-full max-w-xs" />
      </div>
      {q.isPending ? (
        <div className="flex flex-col gap-3 p-4 sm:p-6" aria-busy>
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : q.error ? (
        <PanelError message={t('integrations.tokens.loadError', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title={showRevoked ? t('integrations.tokens.emptyTitle') : t('integrations.tokens.emptyActiveTitle')}
          description={showRevoked ? t('integrations.tokens.emptyBody') : t('integrations.tokens.emptyActiveBody')}
          action={
            <Button variant="secondary" onClick={() => setCreating(true)}>
              {t('integrations.tokens.create')}
            </Button>
          }
        />
      ) : (
        <TableScroll>
          <Table className="min-w-[860px]">
            <THead>
              <tr>
                <TH>{t('common.name')}</TH>
                <TH>{t('integrations.tokens.colPrefix')}</TH>
                <TH>{t('integrations.tokens.colScopes')}</TH>
                <TH>{t('integrations.tokens.colCreatedBy')}</TH>
                <TH>{t('integrations.tokens.colLastUsed')}</TH>
                <TH>{t('integrations.tokens.colExpires')}</TH>
                <TH>{t('common.status')}</TH>
                <TH>
                  <span className="sr-only">{t('common.actions')}</span>
                </TH>
              </tr>
            </THead>
            <tbody>
              {items.map((tok) => {
                const daysLeft = Math.ceil((new Date(tok.expiresAt).getTime() - Date.now()) / DAY_MS);
                return (
                  <TR key={tok.id}>
                    <TD className="max-w-[220px]">
                      <span className="block truncate font-medium" title={tok.name} dir="auto">
                        {tok.name}
                      </span>
                      <span className="text-xs text-fg-2" title={formatDateTime(tok.createdAt)}>
                        {tok.rotatedAt
                          ? t('integrations.tokens.createdOnRotated', { date: formatDate(tok.createdAt), relative: formatRelative(tok.rotatedAt) })
                          : t('integrations.tokens.createdOn', { date: formatDate(tok.createdAt) })}
                      </span>
                    </TD>
                    <TD>
                      <code className="font-mono text-xs" dir="ltr">{tok.prefix}_…</code>
                    </TD>
                    <TD className="max-w-[260px]">
                      <span className="flex flex-wrap gap-1 py-2">
                        {tok.scopes.map((s) => (
                          <Badge key={s} tone="neutral" title={scopeLabel(s, t)}>
                            <span className="font-mono" dir="ltr">{s}</span>
                          </Badge>
                        ))}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap" dir="auto">{creator(tok)}</TD>
                    <TD className="whitespace-nowrap">
                      {tok.lastUsedAt ? (
                        <time dateTime={tok.lastUsedAt} title={formatDateTime(tok.lastUsedAt)}>
                          {formatRelative(tok.lastUsedAt)}
                        </time>
                      ) : (
                        <span className="text-fg-2">{t('integrations.tokens.never')}</span>
                      )}
                    </TD>
                    <TD className="whitespace-nowrap">
                      <time dateTime={tok.expiresAt} title={formatDateTime(tok.expiresAt)}>
                        {formatDate(tok.expiresAt)}
                      </time>
                      {tok.status === 'active' && daysLeft <= 14 && <span className="block text-xs font-medium text-warning">{daysLeft <= 1 ? t('integrations.tokens.expiresWithinDay') : t('integrations.tokens.expiresInDays', { count: daysLeft })}</span>}
                    </TD>
                    <TD>
                      <TokenStatusBadge status={tok.status} />
                    </TD>
                    <TD className="text-end">
                      {tok.status !== 'revoked' && (
                        <Menu>
                          <MenuTrigger asChild>
                            <Button variant="ghost" size="icon" aria-label={t('integrations.tokens.actionsFor', { name: isolate(tok.name) })}>
                              <MoreHorizontal className="size-4" aria-hidden />
                            </Button>
                          </MenuTrigger>
                          <MenuContent>
                            {tok.status === 'active' && (
                              <MenuItem icon={<RefreshCw />} onSelect={() => setRotating(tok)}>
                                {t('integrations.tokens.rotateMenu')}
                              </MenuItem>
                            )}
                            <MenuItem danger icon={<Trash2 />} onSelect={() => setRevoking(tok)}>
                              {t('integrations.tokens.revokeMenu')}
                            </MenuItem>
                          </MenuContent>
                        </Menu>
                      )}
                    </TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        </TableScroll>
      )}

      <TokenCreateDialog
        open={creating}
        onOpenChange={setCreating}
        guard={guard}
        onCreated={(token) => {
          void refresh();
          setSecret({ title: t('integrations.tokens.createdTitle', { name: isolate(token.name) }), token });
        }}
      />

      <ConfirmDialog
        open={!!rotating}
        onOpenChange={(o) => !o && setRotating(null)}
        title={rotating ? t('integrations.tokens.rotateTitle', { name: isolate(rotating.name) }) : t('integrations.tokens.rotateTitleFallback')}
        description={t('integrations.tokens.rotateBody')}
        confirmLabel={t('integrations.tokens.rotateConfirm')}
        onConfirm={async () => {
          if (!rotating) return;
          const res = await guard(
            () => api.post<IntegrationTokenWithSecret>(`/integration-tokens/${rotating.id}/rotate`, {}, { idempotencyKey: uuid() }),
            t('integrations.reauth.action.rotateToken', { name: isolate(rotating.name) }),
          );
          void refresh();
          setSecret({ title: t('integrations.tokens.newSecretTitle', { name: isolate(res.name) }), token: res });
        }}
      />

      <ConfirmDialog
        open={!!revoking}
        danger
        onOpenChange={(o) => !o && setRevoking(null)}
        title={revoking ? t('integrations.tokens.revokeTitle', { name: isolate(revoking.name) }) : t('integrations.tokens.revokeTitleFallback')}
        description={
          revoking
            ? richT(t, 'integrations.tokens.revokeBody', {
                prefix: (
                  <code className="font-mono text-xs" dir="ltr">
                    {revoking.prefix}_…
                  </code>
                ),
              })
            : ''
        }
        confirmLabel={t('integrations.tokens.revokeConfirm')}
        onConfirm={async () => {
          if (!revoking) return;
          await api.delete(`/integration-tokens/${revoking.id}`);
          void refresh();
          toast.success(t('integrations.tokens.revoked', { name: isolate(revoking.name) }));
        }}
      />

      <OneTimeSecretDialog
        open={!!secret}
        title={secret?.title ?? ''}
        description={secret ? t('integrations.tokens.secretSummary', { scopes: isolate(secret.token.scopes.join(', ')), date: formatDate(secret.token.expiresAt) }) : undefined}
        label={t('integrations.secret.tokenLabel')}
        what={t('integrations.what.integrationToken')}
        value={secret?.token.token ?? null}
        onDone={() => setSecret(null)}
      >
        <p className="text-sm text-fg-2">
          {richT(t, 'integrations.tokens.secretUsage', {
            header: (
              <code className="font-mono text-xs" dir="ltr">
                {AUTH_HEADER_SAMPLE}
              </code>
            ),
          })}
        </p>
      </OneTimeSecretDialog>
      {dialog}
    </Card>
  );
}
