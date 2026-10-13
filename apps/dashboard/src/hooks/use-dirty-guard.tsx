'use client';
/**
 * Unsaved-changes guard (ch. 06): while a form is dirty, leaving the page — by an
 * in-app link, browser back, or closing the tab — prompts with Save, Discard and
 * Cancel. Returns an element to render once inside the page.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner, Button, Dialog, DialogContent } from '@/components/ui';
import { errorMessage } from '@/lib/api';
import { useT } from '@/i18n';

/** `what` is a translated noun phrase ("this trigger"); user content inside it should be isolate()d. */
export function useDirtyGuard(dirty: boolean, opts: { onSave?: () => Promise<boolean | void>; what?: string } = {}): ReactNode {
  const t = useT();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    // Intercept same-origin link clicks anywhere in the app.
    const onClick = (e: MouseEvent) => {
      if (!dirtyRef.current || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(url.pathname + url.search + url.hash);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  const leave = useCallback(
    (to: string) => {
      dirtyRef.current = false;
      setPending(null);
      router.push(to);
    },
    [router],
  );

  const save = async () => {
    if (!pending || !opts.onSave) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await opts.onSave();
      if (ok !== false) leave(pending);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!pending} onOpenChange={(o) => !o && !busy && setPending(null)}>
      <DialogContent
        size="sm"
        title={t('common.dirty.title')}
        description={opts.what ? t('common.dirty.bodyWhat', { what: opts.what }) : t('common.dirty.body')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger-ghost" onClick={() => pending && leave(pending)} disabled={busy}>
              {t('common.dirty.discard')}
            </Button>
            {opts.onSave && (
              <Button variant="primary" onClick={() => void save()} loading={busy}>
                {t('common.save')}
              </Button>
            )}
          </>
        }
      >
        {error && <Banner tone="danger">{error}</Banner>}
      </DialogContent>
    </Dialog>
  );
}
