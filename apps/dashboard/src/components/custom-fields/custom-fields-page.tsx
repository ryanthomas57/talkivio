'use client';
/** Settings → Custom fields (ch. 37): list, create, edit (key immutable) and archive with confirmation. */
import { useQueryClient } from '@tanstack/react-query';
import { Archive, ListPlus, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Badge, Banner, Button, Card, ConfirmDialog, EmptyState, Page, PageHeader, PanelError, Skeleton, SwitchField, Table, TableScroll, TD, TH, THead, TR } from '@/components/ui';
import { isolate, useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useCan } from '@/stores/session';
import { FieldDialog } from './field-dialog';
import { customFieldKeys, describeRules, TYPE_LABEL, useCustomFields, type CustomField } from './types';

export function CustomFieldsPage() {
  const t = useT();
  const canManage = useCan('custom_fields.manage');
  const [showArchived, setShowArchived] = useState(false);
  const q = useCustomFields(showArchived);
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CustomField | null>(null);
  const [creating, setCreating] = useState(false);
  const [archiving, setArchiving] = useState<CustomField | null>(null);
  const fields = q.data ?? [];

  return (
    <Page>
      <PageHeader
        title={t('customFields.page.title')}
        description={t('customFields.page.description')}
        actions={
          canManage && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              <Plus className="size-4" aria-hidden /> {t('customFields.page.new')}
            </Button>
          )
        }
      />
      {!canManage && <Banner tone="info">{t('customFields.page.readOnly')}</Banner>}
      <Banner tone="info">{t('customFields.page.rulesNote')}</Banner>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-subtle px-4 py-2">
          <p className="text-sm text-fg-2" aria-live="polite">
            {q.data ? t('customFields.page.activeCount', { count: fields.filter((f) => !f.archivedAt).length, max: 200 }) : ' '}
          </p>
          <SwitchField className="min-h-9 py-0" label={t('customFields.page.showArchived')} checked={showArchived} onCheckedChange={setShowArchived} />
        </div>
        {q.isLoading ? (
          <div className="flex flex-col gap-2 p-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : q.isError ? (
          <PanelError message={t('customFields.page.loadFailed', { error: errorMessage(q.error) })} onRetry={() => void q.refetch()} />
        ) : !fields.length ? (
          <EmptyState
            icon={<ListPlus />}
            title={showArchived ? t('customFields.page.emptyTitle') : t('customFields.page.emptyActiveTitle')}
            description={t('customFields.page.emptyBody')}
            action={
              canManage ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" aria-hidden /> {t('customFields.page.new')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <TableScroll>
            <Table className="min-w-[860px]">
              <THead>
                <tr>
                  <TH>{t('customFields.col.label')}</TH>
                  <TH>{t('customFields.col.key')}</TH>
                  <TH>{t('customFields.col.type')}</TH>
                  <TH>{t('customFields.col.rules')}</TH>
                  <TH>{t('customFields.col.writable')}</TH>
                  <TH>{t('customFields.col.visible')}</TH>
                  <TH>{t('common.status')}</TH>
                  {canManage && (
                    <TH>
                      <span className="sr-only">{t('common.actions')}</span>
                    </TH>
                  )}
                </tr>
              </THead>
              <tbody>
                {fields.map((f) => (
                  <TR key={f.id}>
                    <TD className="font-medium">
                      <bdi>{f.label}</bdi>
                    </TD>
                    <TD>
                      <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-xs" dir="ltr">
                        {f.key}
                      </code>
                    </TD>
                    <TD>{TYPE_LABEL[f.dataType] ? t(TYPE_LABEL[f.dataType]) : f.dataType}</TD>
                    <TD className="max-w-[240px] text-fg-2">{describeRules(f)}</TD>
                    <TD>{f.publicWritable ? <Badge tone="warning">{t('common.yes')}</Badge> : <span className="text-fg-2">{t('common.no')}</span>}</TD>
                    <TD>{f.visibleToVisitor ? <Badge tone="info">{t('common.yes')}</Badge> : <span className="text-fg-2">{t('common.no')}</span>}</TD>
                    <TD>{f.archivedAt ? <Badge tone="neutral">{t('customFields.page.archivedOn', { date: formatDate(f.archivedAt) })}</Badge> : <Badge tone="success">{t('customFields.page.active')}</Badge>}</TD>
                    {canManage && (
                      <TD className="whitespace-nowrap text-end">
                        {!f.archivedAt && (
                          <span className="inline-flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => setEditing(f)} aria-label={t('customFields.page.editLabel', { label: isolate(f.label) })}>
                              <Pencil className="size-3.5" aria-hidden /> {t('common.edit')}
                            </Button>
                            <Button size="sm" variant="danger-ghost" onClick={() => setArchiving(f)} aria-label={t('customFields.page.archiveLabel', { label: isolate(f.label) })}>
                              <Archive className="size-3.5" aria-hidden /> {t('common.archive')}
                            </Button>
                          </span>
                        )}
                      </TD>
                    )}
                  </TR>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {canManage && (
        <>
          <FieldDialog open={creating} onOpenChange={setCreating} field={null} />
          <FieldDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} field={editing} />
          <ConfirmDialog
            open={!!archiving}
            onOpenChange={(o) => !o && setArchiving(null)}
            title={t('customFields.archive.title', { label: isolate(archiving?.label) })}
            description={archiving ? t('customFields.archive.body', { key: isolate(archiving.key) }) : t('customFields.archive.bodyGeneric')}
            confirmLabel={t('customFields.archive.confirm')}
            danger
            onConfirm={async () => {
              if (!archiving) return;
              await api.post(`/custom-fields/${archiving.id}/archive`);
              await qc.invalidateQueries({ queryKey: customFieldKeys.root });
              toast.success(t('customFields.archive.done', { label: isolate(archiving.label) }));
            }}
          />
        </>
      )}
    </Page>
  );
}
