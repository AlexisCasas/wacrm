import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  insert: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: { status?: number; message?: string }) =>
    Response.json(
      { error: error.message ?? 'Unauthorized' },
      { status: error.status ?? 403 }
    ),
}));

import { POST } from './route';

describe('POST /api/flows/folders', () => {
  beforeEach(() => {
    mocks.requireRole.mockResolvedValue({
      accountId: 'account-1',
      supabase: {
        from: () => ({
          insert: mocks.insert,
        }),
      },
    });
    mocks.insert.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ single: mocks.single });
  });

  it('rejects an invalid name before querying the database', async () => {
    const response = await POST(
      new Request('https://example.test', {
        method: 'POST',
        body: JSON.stringify({ name: '  ' }),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('uses the authenticated account instead of a browser-supplied account id', async () => {
    mocks.single.mockResolvedValue({
      data: { id: '11111111-1111-4111-8111-111111111111', name: 'Sales' },
      error: null,
    });

    const response = await POST(
      new Request('https://example.test', {
        method: 'POST',
        body: JSON.stringify({ name: ' Sales ', account_id: 'other-account' }),
      })
    );

    expect(response.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledWith({
      account_id: 'account-1',
      name: 'Sales',
    });
  });

  it('reports a same-account duplicate without exposing database details', async () => {
    mocks.single.mockResolvedValue({ data: null, error: { code: '23505' } });

    const response = await POST(
      new Request('https://example.test', {
        method: 'POST',
        body: JSON.stringify({ name: 'Sales' }),
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Folder name already exists',
    });
  });
});
