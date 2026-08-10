import type { ReactNavigationState } from '../../global-state/types';
import { LoaderClient } from '../LoaderClient';
import { createLoaderContextValue } from '../LoaderContext';
import { createLoaderRouteRegistry } from '../LoaderRouteRegistry';
import { readLoaderData } from '../readLoaderData';

const navigationState = (routes: object[]) => ({ routes }) as unknown as ReactNavigationState;
const getSignal = (requestInit: RequestInit) => requestInit.signal as AbortSignal;

function createTestLoaderRouteRegistry() {
  const ctx = createLoaderContextValue(new LoaderClient());
  return { ctx, registry: createLoaderRouteRegistry(ctx) };
}

describe(createLoaderRouteRegistry, () => {
  it('does nothing when the candidate has no store entry', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const abort = jest.spyOn(ctx.client, 'abort');

    registry.claim('route-1', '/missing');
    registry.reconcile(navigationState([]));

    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts and identity-clears a pending entry', async () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    let signal!: AbortSignal;
    const pending = readLoaderData(ctx, '/p', (_path, requestInit) => {
      const executionSignal = getSignal(requestInit);
      signal = executionSignal;
      return new Promise((_, reject) => {
        executionSignal.addEventListener('abort', () => reject(executionSignal.reason));
      });
    }) as Promise<unknown>;

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));

    expect(signal.aborted).toBe(true);
    expect(ctx.store.get('/p')).toBeUndefined();
    await expect(pending).rejects.toThrow('Failed to load loader data for route: /p');
    expect(ctx.store.get('/p')).toBeUndefined();
  });

  it('cannot resurrect an entry when a custom fetcher ignores abort', async () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    let signal!: AbortSignal;
    let resolveFetch!: (value: string) => void;
    const pending = readLoaderData(ctx, '/p', (_path, requestInit) => {
      signal = getSignal(requestInit);
      return new Promise<string>((resolve) => {
        resolveFetch = resolve;
      });
    }) as Promise<string>;

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));
    resolveFetch('ignored-abort');

    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toBe('ignored-abort');
    expect(ctx.store.get('/p')).toBeUndefined();
  });

  it('preserves a settled entry with a live subscriber', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const entry = { data: 'live' };
    ctx.store.set('/p', entry);
    ctx.client.subscribeLoader('/p');

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));

    expect(ctx.store.get('/p')).toBe(entry);
  });

  it('clears a parked settled entry', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    ctx.store.set('/p', { data: 'parked' });

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));

    expect(ctx.store.get('/p')).toBeUndefined();
  });

  it('preserves a replacement written synchronously while aborting', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const pending = new Promise(() => {});
    const replacement = { data: 'replacement' };
    ctx.client.subscribeLoader('/p');
    ctx.client.execute('/p', (_path, requestInit) => {
      getSignal(requestInit).addEventListener('abort', () => ctx.store.set('/p', replacement));
      return new Promise(() => {});
    });
    ctx.store.set('/p', pending);

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));

    expect(ctx.store.get('/p')).toBe(replacement);
  });

  it('preserves a settled replacement written during the liveness check', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const replacement = { data: 'replacement' };
    ctx.store.set('/p', { data: 'old' });
    jest.spyOn(ctx.client, 'hasSubscribers').mockImplementation(() => {
      ctx.store.set('/p', replacement);
      return false;
    });

    registry.claim('route-1', '/p');
    registry.reconcile(navigationState([]));

    expect(ctx.store.get('/p')).toBe(replacement);
  });

  it('walks the full nested state tree rather than only the focused branch', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const entry = { data: 'inactive-tab' };
    ctx.store.set('/p', entry);
    registry.claim('deep-route', '/p');

    registry.reconcile(
      navigationState([
        { key: 'focused-tab' },
        {
          key: 'inactive-tab',
          state: navigationState([
            {
              key: 'nested-layout',
              state: navigationState([{ key: 'deep-route' }]),
            },
          ]),
        },
      ])
    );

    expect(ctx.store.get('/p')).toBe(entry);
  });

  it('abandons an old pending path immediately when the same key changes paths', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    let signal!: AbortSignal;
    const pending = readLoaderData(ctx, '/posts/1', (_path, requestInit) => {
      signal = getSignal(requestInit);
      return new Promise(() => {});
    });
    expect(pending).toBeInstanceOf(Promise);
    registry.claim('post-route', '/posts/1');

    registry.claim('post-route', '/posts/2');

    expect(signal.aborted).toBe(true);
    expect(ctx.store.get('/posts/1')).toBeUndefined();
  });

  it('removes one duplicate owner without abandoning the remaining owner', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const entry = { data: 'shared' };
    ctx.store.set('/p', entry);
    registry.claim('route-1', '/p');
    registry.claim('route-2', '/p');

    registry.reconcile(navigationState([{ key: 'route-2' }]));
    expect(ctx.store.get('/p')).toBe(entry);

    registry.reconcile(navigationState([]));
    expect(ctx.store.get('/p')).toBeUndefined();
  });

  it('can reset route associations without changing loader state', () => {
    const { ctx, registry } = createTestLoaderRouteRegistry();
    const entry = { data: 'parked' };
    ctx.store.set('/p', entry);
    registry.claim('route-1', '/p');

    registry.reset();
    registry.reconcile(navigationState([]));

    expect(ctx.store.get('/p')).toBe(entry);
  });
});
