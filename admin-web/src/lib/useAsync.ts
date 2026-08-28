// Run an async loader on mount and whenever a caller-supplied key changes,
// with a manual reload. Guards against out-of-order responses.
import { useCallback, useEffect, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
}

export function useAsync<T>(loader: () => Promise<T>, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // Keep the latest loader without making it a dependency of the effect.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    loaderRef.current().then(
      (result) => {
        if (current === seq.current) {
          setData(result);
          setLoading(false);
        }
      },
      (err: unknown) => {
        if (current === seq.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      },
    );
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
