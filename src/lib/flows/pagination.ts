/**
 * PostgREST/Supabase can cap a single select response. Consumers must use
 * this helper with `count: "exact"`; it fails closed if any page is missing,
 * changes its total while being read, or is shorter than the stated total.
 */
export const FLOW_PAGE_SIZE = 200;

export type ExactPage<T> = {
  data: T[] | null;
  error: unknown;
  count: number | null;
};

export async function collectCompletePages<T>(
  getPage: (from: number, to: number) => PromiseLike<ExactPage<T>>
): Promise<T[] | null> {
  const all: T[] = [];
  let expectedCount: number | null = null;

  for (let from = 0; ; from += FLOW_PAGE_SIZE) {
    const page = await getPage(from, from + FLOW_PAGE_SIZE - 1);
    if (page.error || page.count === null || page.count < 0) return null;

    if (expectedCount === null) expectedCount = page.count;
    if (page.count !== expectedCount) return null;

    const rows = page.data ?? [];
    all.push(...rows);
    if (all.length > expectedCount) return null;
    if (all.length === expectedCount) return all;
    if (rows.length !== FLOW_PAGE_SIZE) return null;
  }
}
