import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

/**
 * Fetches `path` and, if `refreshMs` is set, refetches on that interval while the tab is visible.
 * Keeps showing the last good data while refreshing, so the page never flickers.
 */
export function useApi<T>(path: string | null, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const latestPath = useRef(path);
  latestPath.current = path;

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const result = await api<T>(path);
      if (latestPath.current === path) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (latestPath.current === path) setError(err as Error);
    }
  }, [path]);

  useEffect(() => {
    setData(null);
    void load();
    if (!refreshMs) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, refreshMs);
    return () => clearInterval(timer);
  }, [load, refreshMs]);

  return { data, error, loading: data === null && error === null, reload: load };
}
