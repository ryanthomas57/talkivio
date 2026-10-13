'use client';
/**
 * Tag picker (ch. 17): existing tags first, then creating a new one (label ≤ 80;
 * the API derives a lowercase slug ≤ 64). Used for visitor and chat tags — the
 * caller supplies the save function for its resource.
 */
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Banner, Button, Field, Input, MultiCombobox } from '@/components/ui';
import { useT } from '@/i18n';
import { api, errorMessage } from '@/lib/api';
import { qk, useTags } from '@/lib/queries';
import type { Tag, TagRef } from '@/lib/types';
import { useCan } from '@/stores/session';

export function TagEditor({ tags, onSave, canEdit, label, emptyText }: { tags: TagRef[]; onSave: (tagIds: string[]) => Promise<unknown>; canEdit: boolean; label?: string; emptyText?: string }) {
  const t = useT();
  const listLabel = label ?? t('visitors.live.col.tags');
  const all = useTags(canEdit);
  const qc = useQueryClient();
  const canCreate = useCan('tags.create');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = tags.map((tag) => tag.id);
  const options = (all.data ?? []).filter((tag) => !tag.archivedAt).map((tag) => ({ value: tag.id, label: tag.label, hint: tag.slug }));

  const save = async (ids: string[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(ids);
    } catch (e) {
      setError(t('visitors.tags.saveError', { error: errorMessage(e) }));
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    const lbl = newLabel.trim().slice(0, 80);
    if (!lbl) return;
    const existing = (all.data ?? []).find((tag) => tag.label.toLowerCase() === lbl.toLowerCase() || tag.slug === lbl.toLowerCase());
    setCreating(true);
    setError(null);
    try {
      const created = existing ?? (await api.post<Tag>('/tags', { label: lbl }));
      setNewLabel('');
      if (!existing) await qc.invalidateQueries({ queryKey: qk.tags });
      if (!selected.includes(created.id)) await save([...selected, created.id]);
    } catch (e) {
      setError(t('visitors.tags.createError', { error: errorMessage(e) }));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {tags.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={listLabel}>
          {tags.map((tag) => (
            <li key={tag.id}>
              <Badge tone="primary" dir="auto">
                {tag.label}
              </Badge>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-2">{emptyText ?? t('visitors.tags.empty')}</p>
      )}
      {canEdit && (
        <>
          <Field label={t('visitors.tags.editLabel', { label: listLabel.toLowerCase() })} hideLabel>
            <MultiCombobox
              values={selected}
              onChange={(v) => void save(v)}
              options={options}
              placeholder={saving ? t('common.saving') : t('visitors.tags.placeholder')}
              searchPlaceholder={t('visitors.tags.searchPlaceholder')}
              emptyText={all.isLoading ? t('visitors.tags.loading') : t('visitors.tags.noMatching')}
              disabled={saving}
            />
          </Field>
          {canCreate && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void create();
              }}
            >
              <Field label={t('visitors.tags.newTag')} hideLabel className="min-w-0 flex-1">
                <Input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} maxLength={80} placeholder={t('visitors.tags.createPlaceholder')} className="min-w-0" />
              </Field>
              <Button type="submit" variant="secondary" disabled={!newLabel.trim()} loading={creating}>
                <Plus className="size-4" aria-hidden /> {t('common.create')}
              </Button>
            </form>
          )}
        </>
      )}
      {error && <Banner tone="danger">{error}</Banner>}
    </div>
  );
}
