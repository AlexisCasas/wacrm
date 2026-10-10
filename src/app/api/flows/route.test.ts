import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  range: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: mocks.getUser },
    from: () => ({
      select: () => ({
        order: () => ({ range: mocks.range }),
      }),
    }),
  }),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(),
  toErrorResponse: vi.fn(),
}));

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }));
vi.mock('@/lib/flows/templates', () => ({ getFlowTemplate: vi.fn() }));

import { GET } from './route';

describe('GET /api/flows', () => {
  const rows = Array.from({ length: 1001 }, (_, id) => ({ id: String(id) }));

  beforeEach(() => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
    mocks.range.mockImplementation((from: number, to: number) =>
      Promise.resolve({
        data: rows.slice(from, to + 1),
        error: null,
        count: rows.length,
      })
    );
  });

  it('returns every RLS-visible flow beyond the provider default page limit', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ flows: rows });
    expect(mocks.range).toHaveBeenCalledTimes(6);
    expect(mocks.range).toHaveBeenLastCalledWith(1000, 1199);
  });

  it('fails closed rather than returning a partial catalogue', async () => {
    mocks.range.mockImplementation((from: number, to: number) =>
      Promise.resolve(
        from === 1000
          ? { data: null, error: { message: 'database failure' }, count: null }
          : { data: rows.slice(from, to + 1), error: null, count: rows.length }
      )
    );

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not load complete flow list',
    });
  });
});
