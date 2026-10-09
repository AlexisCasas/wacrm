export type FlowStatus = "draft" | "active" | "archived";

export type FlowStatusFilter = "all" | FlowStatus;

export type FlowSort =
  | "newest"
  | "most-used"
  | "least-used"
  | "last-executed"
  | "last-modified"
  | "name-asc"
  | "name-desc";

export interface ListableFlow {
  id: string;
  name: string;
  status: FlowStatus;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowListingOptions {
  query: string;
  status: FlowStatusFilter;
  sort: FlowSort;
}

const collator = new Intl.Collator(undefined, {
  sensitivity: "base",
  numeric: true,
});

/** Normalizes user-facing text for accent- and case-insensitive matching. */
export function normalizeFlowSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

function dateValue(value: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

function compareNewestFirst(left: ListableFlow, right: ListableFlow): number {
  return dateValue(right.created_at) - dateValue(left.created_at);
}

/**
 * Deterministic fallback used after every primary sort. It preserves the
 * historical newest-first ordering when possible, then resolves equal values
 * by localized name and finally the stable flow id.
 */
function compareTieBreakers(left: ListableFlow, right: ListableFlow): number {
  return (
    compareNewestFirst(left, right) ||
    collator.compare(left.name, right.name) ||
    left.id.localeCompare(right.id)
  );
}

function compareFlows(left: ListableFlow, right: ListableFlow, sort: FlowSort): number {
  let primary = 0;

  switch (sort) {
    case "most-used":
      primary = right.execution_count - left.execution_count;
      break;
    case "least-used":
      primary = left.execution_count - right.execution_count;
      break;
    case "last-executed":
      primary = dateValue(right.last_executed_at) - dateValue(left.last_executed_at);
      break;
    case "last-modified":
      primary = dateValue(right.updated_at) - dateValue(left.updated_at);
      break;
    case "name-asc":
      primary = collator.compare(left.name, right.name);
      break;
    case "name-desc":
      primary = collator.compare(right.name, left.name);
      break;
    case "newest":
      primary = compareNewestFirst(left, right);
      break;
  }

  return primary || compareTieBreakers(left, right);
}

/** Applies name search, status filter, and a non-mutating deterministic sort. */
export function listFlows<T extends ListableFlow>(
  flows: readonly T[],
  { query, status, sort }: FlowListingOptions,
): T[] {
  const normalizedQuery = normalizeFlowSearchText(query.trim());

  return flows
    .filter((flow) => {
      const matchesStatus = status === "all" || flow.status === status;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        normalizeFlowSearchText(flow.name).includes(normalizedQuery);
      return matchesStatus && matchesQuery;
    })
    .sort((left, right) => compareFlows(left, right, sort));
}
