import type { ReactNavigationState } from '../global-state/types';
import { defaultLoaderContextValue, type LoaderContextValue } from './LoaderContext';

// Render can start a loader before that route commits, so the committed navigation state cannot
// reconstruct ownership on its own. Keep the minimal route-key-to-path association outside the
// client, scoped to the paired client/store context that it coordinates.
interface LoaderRouteRegistry {
  claim(routeKey: string, path: string): void;
  reconcile(state: ReactNavigationState | undefined): void;
  reset(): void;
}

export function createLoaderRouteRegistry({
  client,
  store,
}: LoaderContextValue): LoaderRouteRegistry {
  const routePaths = new Map<string, string>();

  function abandon(path: string) {
    const entry = store.get(path);
    if (entry === undefined) {
      return;
    }

    if (entry instanceof Promise) {
      client.abort(path);
    } else if (client.hasSubscribers(path)) {
      return;
    }
    if (store.get(path) === entry) {
      store.clear(path);
    }
  }

  function abandonUnowned(candidatePaths: Iterable<string>) {
    const ownedPaths = new Set(routePaths.values());
    for (const path of candidatePaths) {
      if (!ownedPaths.has(path)) {
        abandon(path);
      }
    }
  }

  return {
    claim(routeKey, path) {
      const previousPath = routePaths.get(routeKey);
      if (previousPath === path) {
        return;
      }

      routePaths.set(routeKey, path);
      if (previousPath !== undefined) {
        abandonUnowned([previousPath]);
      }
    },

    reconcile(state) {
      const presentKeys = new Set<string>();
      const walk = (node: ReactNavigationState | undefined) => {
        for (const route of node?.routes ?? []) {
          if (route.key) {
            presentKeys.add(route.key);
          }
          walk(route.state);
        }
      };
      walk(state);

      const removedPaths = new Set<string>();
      for (const [routeKey, path] of routePaths) {
        if (!presentKeys.has(routeKey)) {
          routePaths.delete(routeKey);
          removedPaths.add(path);
        }
      }
      abandonUnowned(removedPaths);
    },

    reset() {
      routePaths.clear();
    },
  };
}

export const defaultLoaderRouteRegistry = createLoaderRouteRegistry(defaultLoaderContextValue);
