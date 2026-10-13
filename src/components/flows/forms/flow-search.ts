/**
 * Pure helpers for the "Run another flow" picker: accent- and case-insensitive name search over the account's flows.
 * No I/O: the catalog is the RLS-scoped list the form already loads (own account only).
 */
export interface SearchableFlow {
  id: string;
  name: string;
}

/** Lower-cases, strips combining accents (é -> e, ñ -> n) and collapses whitespace. */
export function normalizeSearch(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** How many matches are rendered at once; the rest are reachable by typing more. Keeps hundreds of flows instant. */
export const MAX_VISIBLE_FLOWS = 100;

export interface FlowSearchResult<T extends SearchableFlow> {
  /** Matches to render (at most `limit`). */
  visible: T[];
  /** Total matches before the cap. */
  total: number;
}

/**
 * Every whitespace-separated term of the query must appear in the name ("lead qa" matches "QA - Lead capture").
 * An empty query returns the whole catalog. Order of the catalog is preserved; the selected flow, if any,
 * is not special-cased here (the caller keeps it visible through the trigger).
 */
export function searchFlows<T extends SearchableFlow>(flows: readonly T[], query: string, limit = MAX_VISIBLE_FLOWS): FlowSearchResult<T> {
  const terms = normalizeSearch(query).split(" ").filter(Boolean);
  const matches = terms.length === 0 ? flows : flows.filter((flow) => {
    const name = normalizeSearch(flow.name);
    return terms.every((term) => name.includes(term));
  });
  return { visible: matches.slice(0, limit), total: matches.length };
}
