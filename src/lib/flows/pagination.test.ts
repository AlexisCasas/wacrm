import { describe, expect, it } from 'vitest';

import { collectCompletePages, FLOW_PAGE_SIZE } from './pagination';

function pageFor<T>(
  rows: T[],
  options: { errorAt?: number; incompleteAt?: number } = {}
) {
  return async (from: number, to: number) => {
    if (options.errorAt === from)
      return { data: null, error: { message: 'failed' }, count: null };
    const data = rows.slice(from, to + 1);
    return {
      data: options.incompleteAt === from ? data.slice(0, -1) : data,
      error: null,
      count: rows.length,
    };
  };
}

describe('collectCompletePages', () => {
  it('returns every row beyond Supabase default limits', async () => {
    const rows = Array.from({ length: 1001 }, (_, id) => ({ id }));
    await expect(collectCompletePages(pageFor(rows))).resolves.toEqual(rows);
  });

  it('fails closed when an intermediate page errors', async () => {
    const rows = Array.from({ length: FLOW_PAGE_SIZE + 1 }, (_, id) => ({
      id,
    }));
    await expect(
      collectCompletePages(pageFor(rows, { errorAt: FLOW_PAGE_SIZE }))
    ).resolves.toBeNull();
  });

  it('fails closed when a page is shorter than its exact count', async () => {
    const rows = Array.from({ length: FLOW_PAGE_SIZE + 1 }, (_, id) => ({
      id,
    }));
    await expect(
      collectCompletePages(pageFor(rows, { incompleteAt: FLOW_PAGE_SIZE }))
    ).resolves.toBeNull();
  });

  it('returns an empty complete result', async () => {
    await expect(collectCompletePages(pageFor([]))).resolves.toEqual([]);
  });
});
