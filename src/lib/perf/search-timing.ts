/**
 * Opt-in latency measurement for the Inbox / Contacts search boxes (SEARCH-01).
 *
 * Disabled by default and free when disabled. Enable per browser with:
 *   localStorage.setItem("wacrm:search-debug", "1")
 * and disable with `localStorage.removeItem("wacrm:search-debug")`.
 *
 * It logs only timings and counts — never the search term itself (it can be
 * a phone number), only its length.
 */

export type SearchTimingScope = 'inbox' | 'contacts';

export interface SearchTimingResult {
  /** Rows returned to the client for this search. */
  rows?: number;
  /** Number of network requests the search issued. */
  requests?: number;
  /** True when the search was cancelled before it finished. */
  aborted?: boolean;
  /** True when the search ended in an error. */
  failed?: boolean;
}

const STORAGE_KEY = 'wacrm:search-debug';

function isEnabled(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.localStorage.getItem(STORAGE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

const noop = () => {};

/** Starts a timer; call the returned function when the search finishes. */
export function startSearchTimer(
  scope: SearchTimingScope,
  termLength: number
): (result?: SearchTimingResult) => void {
  if (!isEnabled()) return noop;
  const startedAt = performance.now();
  return (result = {}) => {
    console.info('[wacrm:search-timing]', {
      scope,
      termLength,
      ms: Math.round(performance.now() - startedAt),
      ...result,
    });
  };
}
