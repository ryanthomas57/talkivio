/**
 * Frame side of the postMessage bridge. Only messages from `window.parent` are accepted;
 * the parent origin is taken from `location.ancestorOrigins` / `document.referrer` when
 * available, otherwise pinned to the origin of the first valid `init` message.
 */
import { FRAME_SOURCE, HOST_SOURCE, isObject, type FrameMessage, type HostMessage } from '../common/protocol';
import { originOf } from './util';

export function ancestorOrigin(): string | null {
  try {
    const list = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (list && list.length) return originOf(list[0]) ?? null;
  } catch {
    /* unsupported */
  }
  return null;
}

export class HostBridge {
  readonly embedded: boolean;
  private readonly expected: string | null;
  private pinned: string | null = null;

  constructor(private readonly onMessage: (m: HostMessage) => void) {
    this.embedded = window.parent !== window;
    this.expected = ancestorOrigin() ?? originOf(document.referrer);
    window.addEventListener('message', (e) => this.receive(e));
  }

  get origin(): string | null {
    return this.pinned;
  }

  private receive(e: MessageEvent) {
    if (!this.embedded || e.source !== window.parent) return;
    const d = e.data;
    if (!isObject(d) || d.source !== HOST_SOURCE || typeof d.type !== 'string') return;
    if (this.pinned) {
      if (e.origin !== this.pinned) return;
    } else {
      if (d.type !== 'init') return;
      if (this.expected && e.origin !== this.expected) return;
      this.pinned = e.origin;
    }
    this.onMessage(d as unknown as HostMessage);
  }

  post(msg: FrameMessage): void {
    if (!this.embedded) return;
    try {
      if (this.pinned) window.parent.postMessage(msg, this.pinned);
      else if (msg.type === 'ready') window.parent.postMessage(msg, this.expected ?? '*');
    } catch {
      /* parent gone */
    }
  }

  ready(): void {
    this.post({ source: FRAME_SOURCE, type: 'ready' });
  }
}
