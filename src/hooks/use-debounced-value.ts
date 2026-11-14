import { useEffect, useState } from 'react';

/**
 * Returns `value` after it has stopped changing for `delayMs`.
 *
 * An empty (or whitespace-only) string is passed through immediately, so
 * clearing a search box restores the full list without waiting for the
 * delay. The previous value is kept while a newer one is pending.
 */
export function useDebouncedValue(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (value.trim() === '') {
      // Flush right away — no timer needed.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDebounced(value);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
