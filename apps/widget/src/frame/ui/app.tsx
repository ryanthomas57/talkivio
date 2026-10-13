import { useEffect, useLayoutEffect, useMemo, useRef } from 'preact/hooks';
import { FRAME_SOURCE, LAYOUT_PAD, type LayoutMessage } from '../../common/protocol';
import type { Controller } from '../controller';
import { translator } from '../i18n';
import { layoutMode, type LayoutMode, type State } from '../state';
import { clamp, isDarkTheme, themeVars } from '../theme';
import { cls, UiContext, useControllerState, useUi } from './common';
import { InvitationCard, Launcher } from './launcher';
import { Panel } from './panel';

/** Iframe geometry the loader should apply for the current state. */
export function computeLayout(s: State, mode: LayoutMode, stack: HTMLElement | null): LayoutMessage {
  const a = s.config.appearance;
  const compact = s.viewport.compact;
  const offsetX = compact ? 12 : clamp(a.offsetX, 0, 240);
  const offsetY = compact ? 12 : clamp(a.offsetY, 0, 240);
  const base = { source: FRAME_SOURCE, type: 'layout' as const, position: a.position, fullscreen: false };
  if (mode === 'open') {
    return {
      ...base,
      mode,
      width: clamp(a.width, 300, 640),
      height: clamp(a.height, 400, 900),
      offsetX,
      offsetY,
      fullscreen: s.viewport.fullscreen,
      radius: clamp(a.borderRadius, 0, 28),
      ...(s.closing ? { closing: true } : {}),
      ...(s.openFocus ? { focus: true } : {}),
    };
  }
  if (mode === 'hidden') return { ...base, mode, width: 0, height: 0, offsetX: 0, offsetY: 0, ...(s.focusReturn ? { restoreFocus: true } : {}) };
  const r = stack?.getBoundingClientRect();
  const w = Math.ceil(r && r.width ? r.width : 56);
  const h = Math.ceil(r && r.height ? r.height : 56);
  return { ...base, mode, width: w + 2 * LAYOUT_PAD, height: h + 2 * LAYOUT_PAD, offsetX: offsetX - LAYOUT_PAD, offsetY: offsetY - LAYOUT_PAD };
}

function PreviewStage({ vars, dark }: { vars: Record<string, string>; dark: boolean }) {
  const { s } = useUi();
  const a = s.config.appearance;
  const style = {
    ...vars,
    '--rd-ox': `${clamp(a.offsetX, 0, 48)}px`,
    '--rd-oy': `${clamp(a.offsetY, 0, 48)}px`,
    '--rd-pw': `${clamp(a.width, 300, 640)}px`,
    '--rd-ph': `${clamp(a.height, 400, 900)}px`,
  };
  return (
    <div class={cls('rd-stage', dark && 'rd-dark')} style={style} data-pos={a.position === 'bottom-left' ? 'left' : 'right'} dir="ltr">
      {s.open ? (
        <div class="rd-stage-panel">
          <Panel framed />
        </div>
      ) : (
        s.invitation && <InvitationCard key={s.invitation.id} />
      )}
      <Launcher />
    </div>
  );
}

export function App({ c }: { c: Controller }) {
  const s = useControllerState(c);
  const t = useMemo(() => translator(s.locale), [s.locale]);
  const dark = isDarkTheme(s.config, s.viewport.dark);
  const vars = useMemo(() => themeVars(s.config, dark), [s.config, dark]);
  const stackRef = useRef<HTMLDivElement>(null);
  const mode = layoutMode(s);
  const ui = { c, s, t };

  useEffect(() => {
    document.documentElement.lang = s.locale;
  }, [s.locale]);

  // Report the geometry after every render (cheap: the controller dedupes identical layouts).
  useLayoutEffect(() => {
    if (!s.preview) c.postLayout(computeLayout(c.state, layoutMode(c.state), stackRef.current));
  });

  // Content size can change without a state change (fonts, images): observe the stack.
  useEffect(() => {
    const el = stackRef.current;
    if (!el || typeof ResizeObserver === 'undefined' || s.preview) return;
    const ro = new ResizeObserver(() => c.postLayout(computeLayout(c.state, layoutMode(c.state), stackRef.current)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [mode]);

  if (s.preview) {
    return (
      <UiContext.Provider value={ui}>
        <PreviewStage vars={vars} dark={dark} />
      </UiContext.Provider>
    );
  }

  const left = s.config.appearance.position === 'bottom-left';
  return (
    <UiContext.Provider value={ui}>
      <div
        class={cls('rd-root', dark && 'rd-dark', mode === 'open' && 'rd-root-open', mode === 'open' && s.viewport.fullscreen && 'rd-full', s.standalone && 'rd-standalone')}
        style={vars}
        data-pos={left ? 'left' : 'right'}
        dir="ltr"
      >
        {mode === 'open' ? (
          <Panel />
        ) : mode !== 'hidden' ? (
          <div class="rd-stack" ref={stackRef}>
            {s.invitation && <InvitationCard key={s.invitation.id} />}
            <Launcher />
          </div>
        ) : null}
      </div>
    </UiContext.Provider>
  );
}
