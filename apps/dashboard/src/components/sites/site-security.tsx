'use client';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  DialogContent,
  Field,
  RadioGroup,
} from '@/components/ui';
import { useReauth, isReauthCancelled } from '@/components/team/reauth-dialog';
import { isolate, useT, type MessageKey } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { qk } from '@/lib/queries';
import type { Site } from '@/lib/types';
import { useCan, useSession } from '@/stores/session';
import { CodeBlock, CopyButton } from './copy-button';
import { richT, slots } from './rich-text';
import { siteKey } from './site-general';

// Code identifiers shown inside <code>, never translated.
const SECRET_ENV = 'TALKIVIO_IDENTITY_SECRET'; // i18n-ignore: environment variable name
const JTI_CLAIM = 'jti'; // i18n-ignore: JWT claim name
const IDENTIFY_CALL = "Talkivio('identify', { externalIdToken })"; // i18n-ignore: JavaScript API call

const OVERLAPS: ReadonlyArray<{ value: string; label: MessageKey; description?: MessageKey }> = [
  { value: '0', label: 'sites.security.overlap.none', description: 'sites.security.overlap.noneHint' },
  { value: '900', label: 'sites.security.overlap.15m' },
  { value: '3600', label: 'sites.security.overlap.1h', description: 'sites.security.overlap.1hHint' },
  { value: '21600', label: 'sites.security.overlap.6h' },
  { value: '86400', label: 'sites.security.overlap.24h', description: 'sites.security.overlap.24hHint' },
];

/**
 * Site key rotation (with overlap) and the identity-verification secret
 * (ch. 08, 25). Both require recent re-authentication; the secret is shown once.
 */
export function SiteSecurity({ site }: { site: Site }) {
  const t = useT();
  const qc = useQueryClient();
  const canManage = useCan('sites.manage') && !site.archivedAt;
  const tenantId = useSession((s) => s.tenant?.id ?? '');
  const { withReauth, reauthDialog } = useReauth();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [overlap, setOverlap] = useState<string>('3600');
  const [rotating, setRotating] = useState(false);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotated, setRotated] = useState<{
    key: string;
    snippet: string;
    previousKeyExpiresAt: string | null;
  } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretBusy, setSecretBusy] = useState(false);
  const [secretError, setSecretError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate-secret' | 'disable' | null>(null);

  const refreshSite = (s?: Site) => {
    if (s) qc.setQueryData(siteKey(site.id), s);
    else void qc.invalidateQueries({ queryKey: siteKey(site.id), exact: true });
    void qc.invalidateQueries({ queryKey: qk.sites, exact: true });
    void qc.invalidateQueries({ queryKey: [...qk.sites, site.id, 'installation'] });
  };

  const rotate = async () => {
    setRotating(true);
    setRotateError(null);
    try {
      const r = await withReauth(
        () =>
          api.post<Site & { snippet: string }>(`/sites/${site.id}/key-rotation`, {
            overlapSeconds: Number(overlap),
          }),
        t('sites.security.action.rotateKey'),
      );
      const { snippet, ...updated } = r;
      refreshSite(updated);
      setRotated({ key: updated.publicKey, snippet, previousKeyExpiresAt: updated.previousKeyExpiresAt });
      toast.success(t('sites.security.rotated'));
    } catch (e) {
      setRotateError(errorMessage(e));
    } finally {
      setRotating(false);
    }
  };

  const createSecret = async () => {
    setSecretBusy(true);
    setSecretError(null);
    try {
      const r = await withReauth(
        () => api.post<{ secret: string }>(`/sites/${site.id}/identity-secret`),
        site.identityVerificationEnabled
          ? t('sites.security.action.rotateSecret')
          : t('sites.security.action.enableIdentity'),
      );
      setSecret(r.secret);
      refreshSite();
    } finally {
      setSecretBusy(false);
    }
  };

  const disable = async () => {
    await withReauth(
      () => api.delete(`/sites/${site.id}/identity-secret`),
      t('sites.security.action.disableIdentity'),
    );
    setSecret(null);
    refreshSite();
    toast.success(t('sites.security.identityOff'));
  };

  const overlapActive =
    site.previousKeyExpiresAt && new Date(site.previousKeyExpiresAt).getTime() > Date.now();

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader title={t('sites.install.siteKey')} description={t('sites.security.keyDescription')} />
        <CardBody className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <code className="break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-sm" dir="ltr">
              {site.publicKey}
            </code>
            <CopyButton text={site.publicKey} what={t('sites.security.whatKey')} />
          </div>
          {overlapActive && (
            <Banner tone="info" title={t('sites.security.previousTitle')}>
              {t('sites.security.previousBody', {
                time: formatDateTime(site.previousKeyExpiresAt),
                relative: formatRelative(site.previousKeyExpiresAt),
              })}
            </Banner>
          )}
          <div className="text-sm text-fg-2">{t('sites.security.rotateHelp')}</div>
          {canManage && (
            <Button
              variant="secondary"
              className="self-start"
              onClick={() => {
                setRotated(null);
                setRotateError(null);
                setRotateOpen(true);
              }}
            >
              <RefreshCw className="size-4" aria-hidden />
              {t('sites.security.rotateKey')}
            </Button>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={t('sites.list.identityVerification')}
          description={t('sites.security.identityDescription')}
          action={
            site.identityVerificationEnabled ? (
              <Badge tone="success" icon={<ShieldCheck className="size-3" aria-hidden />}>
                {t('common.on')}
              </Badge>
            ) : (
              <Badge icon={<ShieldOff className="size-3" aria-hidden />}>{t('common.off')}</Badge>
            )
          }
        />
        <CardBody className="flex flex-col gap-4">
          {secretError && <Banner tone="danger">{secretError}</Banner>}
          {secret && (
            <div className="flex flex-col gap-3 rounded-[var(--radius-control)] border border-warning/40 bg-warning-tint p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-warning">
                <KeyRound className="size-4" aria-hidden /> {t('sites.security.copySecretNow')}
              </p>
              <p className="text-sm">
                {richT(t('sites.security.storeSecret', slots(1)), [
                  <code key="env" className="font-mono" dir="ltr">
                    {SECRET_ENV}
                  </code>,
                ])}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <code
                  className="min-w-0 break-all rounded-md bg-surface px-3 py-2 font-mono text-sm"
                  dir="ltr"
                >
                  {secret}
                </code>
                <CopyButton text={secret} what={t('sites.security.whatSecret')} />
              </div>
              <Button variant="secondary" size="sm" className="self-start" onClick={() => setSecret(null)}>
                {t('sites.security.storedSafely')}
              </Button>
            </div>
          )}
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {site.identityVerificationEnabled ? (
                <>
                  <Button
                    variant="secondary"
                    onClick={() => setConfirm('rotate-secret')}
                    loading={secretBusy}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    {t('sites.security.rotateSecret')}
                  </Button>
                  <Button variant="danger-ghost" onClick={() => setConfirm('disable')}>
                    {t('sites.security.turnOff')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="primary"
                  onClick={() =>
                    void createSecret().catch(
                      (e: unknown) => !isReauthCancelled(e) && setSecretError(errorMessage(e)),
                    )
                  }
                  loading={secretBusy}
                >
                  <ShieldCheck className="size-4" aria-hidden />
                  {t('sites.security.enableAndCreate')}
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t('sites.security.signTitle')}</h3>
            <p className="text-sm text-fg-2">
              <Badge tone="warning" className="me-1.5">
                {t('sites.security.serverOnly')}
              </Badge>
              {richT(t('sites.security.signBody', slots(2)), [
                <code key="jti" className="font-mono" dir="ltr">
                  {JTI_CLAIM}
                </code>,
                <code key="call" className="font-mono text-xs" dir="ltr">
                  {IDENTIFY_CALL}
                </code>,
              ])}
            </p>
            <CodeBlock what={t('sites.security.whatNodeSample')} code={nodeSample(site.id, tenantId)} />
          </div>
        </CardBody>
      </Card>

      <Dialog open={rotateOpen} onOpenChange={(o) => !rotating && setRotateOpen(o)}>
        <DialogContent
          size="md"
          title={
            rotated
              ? t('sites.security.newKeyActive')
              : t('sites.security.rotateTitle', { name: isolate(site.name) })
          }
          description={rotated ? t('sites.security.deployNew') : t('sites.security.rotateDescription')}
          footer={
            rotated ? (
              <Button variant="primary" onClick={() => setRotateOpen(false)}>
                {t('common.done')}
              </Button>
            ) : (
              <>
                <Button variant="secondary" onClick={() => setRotateOpen(false)} disabled={rotating}>
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" onClick={() => void rotate()} loading={rotating}>
                  {t('sites.security.rotateKeyShort')}
                </Button>
              </>
            )
          }
        >
          {rotated ? (
            <div className="flex flex-col gap-4">
              <Field label={t('sites.security.newKey')}>
                <div className="flex flex-wrap items-center gap-3">
                  <code className="break-all rounded-md bg-surface-2 px-3 py-2 font-mono text-sm" dir="ltr">
                    {rotated.key}
                  </code>
                  <CopyButton text={rotated.key} what={t('sites.security.whatNewKey')} />
                </div>
              </Field>
              <Banner
                tone={
                  rotated.previousKeyExpiresAt &&
                  new Date(rotated.previousKeyExpiresAt).getTime() > Date.now()
                    ? 'info'
                    : 'warning'
                }
              >
                {rotated.previousKeyExpiresAt && new Date(rotated.previousKeyExpiresAt).getTime() > Date.now()
                  ? t('sites.security.previousUntil', { time: formatDateTime(rotated.previousKeyExpiresAt) })
                  : t('sites.security.previousGone')}
              </Banner>
              <CodeBlock code={rotated.snippet} what={t('sites.security.whatNewSnippet')} />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {rotateError && <Banner tone="danger">{rotateError}</Banner>}
              <RadioGroup
                legend={t('sites.security.overlapLegend')}
                name="overlap"
                value={overlap}
                onChange={setOverlap}
                options={OVERLAPS.map((o) => ({
                  value: o.value,
                  label: t(o.label),
                  description: o.description ? t(o.description) : undefined,
                }))}
              />
              <p className="text-sm text-fg-2">{t('sites.security.passwordNote')}</p>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'rotate-secret'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('sites.security.rotateSecretTitle')}
        danger
        confirmLabel={t('sites.security.rotateSecret')}
        description={t('sites.security.rotateSecretBody')}
        onConfirm={createSecret}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={t('sites.security.disableTitle')}
        danger
        confirmLabel={t('sites.security.turnOff')}
        description={t('sites.security.disableBody')}
        onConfirm={disable}
      />
      {reauthDialog}
    </div>
  );
}

function nodeSample(siteId: string, tenantId: string): string {
  return `// server.js: runs on YOUR backend only. Never expose the secret to browsers.
import { createHmac, randomUUID } from 'node:crypto';

const SITE_ID = '${siteId}';
const TENANT_ID = '${tenantId}';
const SECRET = process.env.TALKIVIO_IDENTITY_SECRET; // the secret shown once above

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Short-lived HS256 identity token for the signed-in customer. */
export function talkivioIdentityToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const claims = {
    iss: SITE_ID,                 // this website's id
    aud: 'talkivio visitor',
    tenant_id: TENANT_ID,
    site_id: SITE_ID,
    sub: String(user.id),         // your stable customer id
    iat: now,
    exp: now + 300,               // at most 5 minutes
    jti: randomUUID(),            // unique per token (single use)
    name: user.name,              // optional
    email: user.email,            // optional
  };
  const unsigned = \`\${b64url(header)}.\${b64url(claims)}\`;
  const signature = createHmac('sha256', SECRET).update(unsigned).digest('base64url');
  return \`\${unsigned}.\${signature}\`;
}

// Render the token into the page for signed-in users, then in the browser:
// Talkivio('identify', { externalIdToken: tokenFromYourServer });`;
}
