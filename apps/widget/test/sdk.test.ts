import { describe, expect, it, vi } from 'vitest';
import { STATE_EVENT } from '../src/common/protocol';
import { createSdk, type FrameHandle, type InitOptions, type MountHooks } from '../src/loader/sdk';

function fakeMount() {
  const calls: Array<[string, unknown[]]> = [];
  const mounts: InitOptions[] = [];
  let hooks: MountHooks | null = null;
  let destroyed = 0;
  const mount = (opts: InitOptions, h: MountHooks): FrameHandle => {
    mounts.push(opts);
    hooks = h;
    return {
      call: (method, args) => {
        calls.push([method, args]);
        return Promise.resolve({ method });
      },
      destroy: () => {
        destroyed++;
      },
    };
  };
  return { mount, calls, mounts, emit: (n: string, p: unknown) => hooks!.emit(n, p), destroyed: () => destroyed };
}

const args = (...a: unknown[]) => a as unknown as ArrayLike<unknown>;

describe('loader SDK queue', () => {
  it('replays queued stub calls in order after the implicit (script tag) init', async () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_test123' });
    sdk.processQueue([args('identify', { name: 'Pat' }), args('setTags', ['vip']), args('open')]);
    await Promise.resolve();
    expect(f.mounts).toEqual([{ siteKey: 'wk_test123' }]);
    expect(f.calls.map((c) => c[0])).toEqual(['identify', 'setTags', 'open']);
    expect(f.calls[0][1]).toEqual([{ name: 'Pat' }]);
  });

  it('merges a leading explicit init into the implicit one (script key wins)', () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_script' });
    sdk.processQueue([args('init', { siteKey: 'wk_other', locale: 'ar', position: 'bottom-left' }), args('open')]);
    expect(f.mounts).toEqual([{ siteKey: 'wk_script', locale: 'ar', position: 'bottom-left' }]);
    expect(f.calls.map((c) => c[0])).toEqual(['open']);
  });

  it('queues commands until an explicit init when there is no script key, and init runs once', async () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, null);
    const p = sdk.api('open') as Promise<unknown>;
    expect(f.calls).toHaveLength(0);
    await sdk.api('init', { siteKey: 'wk_abcdef' });
    await expect(p, 'open(): Promise<void> (master prompt SDK signature)').resolves.toBeUndefined();
    expect(f.calls.map((c) => c[0])).toEqual(['open']);
    await expect(sdk.api('init', { siteKey: 'wk_abcdef' })).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    expect(f.mounts).toHaveLength(1);
  });

  it('rejects an invalid site key', async () => {
    const sdk = createSdk(fakeMount().mount, null);
    await expect(sdk.api('init', { siteKey: '<bad key>' })).rejects.toMatchObject({ code: 'INVALID_SITE_KEY' });
  });

  it('dispatches events, returns unsubscribe functions and isolates handler exceptions', () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_test123' });
    sdk.processQueue([]);
    const seen: unknown[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    sdk.api('on', 'unread.changed', () => {
      throw new Error('boom');
    });
    const off = sdk.api('on', 'unread.changed', (p: unknown) => seen.push(p)) as () => void;
    expect(() => f.emit('unread.changed', { count: 2 })).not.toThrow();
    expect(seen).toEqual([{ count: 2 }]);
    off();
    f.emit('unread.changed', { count: 3 });
    expect(seen).toHaveLength(1);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('exposes a frozen state snapshot mirrored from the frame', () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_test123' });
    sdk.processQueue([]);
    expect(sdk.api('isOpen')).toBe(false);
    f.emit(STATE_EVENT, { ...(sdk.api('getState') as object), open: true, unreadCount: 4 });
    const state = sdk.api('getState') as { open: boolean; unreadCount: number };
    expect(state.open).toBe(true);
    expect(sdk.api('getUnreadCount')).toBe(4);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it('destroy removes the frame and drops handlers; later commands reject until re-init', async () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_test123' });
    sdk.processQueue([]);
    const handler = vi.fn();
    sdk.api('on', 'opened', handler);
    await sdk.api('destroy');
    expect(f.destroyed()).toBe(1);
    f.emit('opened', {});
    expect(handler).not.toHaveBeenCalled();
    await expect(sdk.api('open')).rejects.toMatchObject({ code: 'DESTROYED' });
    await sdk.api('init', { siteKey: 'wk_test123' });
    expect(f.mounts).toHaveLength(2);
  });
});

describe('SDK signatures (master prompt ch. 29: void display commands, Promise<void> open)', () => {
  it('close/show/hide/destroy return void; open resolves with nothing', async () => {
    const f = fakeMount();
    const sdk = createSdk(f.mount, { siteKey: 'wk_test123' });
    sdk.processQueue([]);
    for (const cmd of ['close', 'show', 'hide']) expect(sdk.api(cmd), `${cmd}() is void`).toBeUndefined();
    await expect(sdk.api('open') as Promise<unknown>).resolves.toBeUndefined();
    expect(f.calls.map((c) => c[0])).toEqual(['close', 'show', 'hide', 'open']);
    expect(sdk.api('destroy'), 'destroy() is void').toBeUndefined();
  });
});
