import { createContext } from 'preact';
import { useContext, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { avatarColor, initials } from '@talkivio/contracts/protocol';
import type { Controller } from '../controller';
import type { Translator } from '../i18n';
import type { State } from '../state';
import { readableOn } from '../theme';

export interface Ui {
  c: Controller;
  s: State;
  t: Translator;
}

export const UiContext = createContext<Ui>(null as unknown as Ui);
export const useUi = () => useContext(UiContext);

/** Subscribe a component tree to controller state changes. */
export function useControllerState(c: Controller): State {
  const [, force] = useState(0);
  const rendered = useRef(c.state);
  rendered.current = c.state;
  // Subscribe in a layout effect and re-check afterwards: the controller may have changed
  // state between this render and the subscription (e.g. start() right after render()).
  useLayoutEffect(() => {
    const unsubscribe = c.subscribe(() => force((n) => n + 1));
    if (c.state !== rendered.current) force((n) => n + 1);
    return unsubscribe;
  }, [c]);
  return c.state;
}

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Avatar({ name, url, size = 28, square = false, seed }: { name: string; url?: string | null; size?: number; square?: boolean; seed?: string }) {
  const [broken, setBroken] = useState(false);
  const style = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` };
  if (url && !broken) {
    return <img class={cls('rd-avatar', square && 'rd-avatar-sq')} style={style} src={url} alt="" onError={() => setBroken(true)} referrerpolicy="no-referrer" />;
  }
  const bg = avatarColor(seed || name || '?');
  return (
    <span class={cls('rd-avatar', square && 'rd-avatar-sq')} style={{ ...style, background: bg, color: readableOn(bg) }} aria-hidden="true">
      {initials(name || '?')}
    </span>
  );
}

/** Visually hidden text for assistive technology. */
export const Sr = ({ children }: { children: string }) => <span class="rd-sr">{children}</span>;
