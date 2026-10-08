"use client";

import { useState, useEffect, useCallback } from "react";

interface UseFetchOptions {
  immediate?: boolean;
}

export function useFetch<T>(
  url: string | null,
  options: UseFetchOptions = { immediate: true }
) {
  const immediate = options.immediate !== false;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The immediate fetch starts in the effect without touching state
  // synchronously, so the spinner flag is seeded from that same condition.
  const [loading, setLoading] = useState(immediate && url !== null);

  // Data-only loader: no setState before the first await, so it is safe to
  // call synchronously from an effect.
  const load = useCallback(async (): Promise<T | null> => {
    if (!url) return null;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }, [url]);

  // Event-handler variant (refetch): toggles the spinner around the loader.
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const json = await load();
      if (json !== null) setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    if (!immediate || !url) return;
    void load()
      .then((json) => {
        if (json !== null) setData(json);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "An error occurred");
      })
      .finally(() => setLoading(false));
  }, [immediate, load, url]);

  return { data, error, loading, refetch: fetchData, setData };
}
