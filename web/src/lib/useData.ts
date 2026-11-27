import { useCallback, useEffect, useRef, useState } from "react";

/** Loads data once and, optionally, refreshes it on an interval while the page is visible. */
export function useData<T>(load: () => Promise<T>, deps: unknown[] = [], refreshMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;

  const run = useCallback(async () => {
    try {
      const v = await loadRef.current();
      setData(v);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    run();
    if (!refreshMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, refreshMs);
    return () => clearInterval(id);
    // The refresh interval counts too: a page can learn it should refresh faster.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, refreshMs]);

  return { data, error, loading, reload: run };
}
