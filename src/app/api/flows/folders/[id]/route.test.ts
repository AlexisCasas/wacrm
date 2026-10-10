import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: (error: { status?: number; message?: string }) =>
    Response.json(
      { error: error.message ?? 'Unauthorized' },
      { status: error.status ?? 403 }
    ),
}));

import { DELETE } from './route';

const folderId = '11111111-1111-4111-8111-111111111111';

describe('DELETE /api/flows/folders/[id]', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireRole.mockResolvedValue({
      supabase: { rpc: mocks.rpc },
    });
  });

  it('uses the single-result RPC contract for a successful deletion', async () => {
    mocks.rpc.mockResolvedValue({ data: true, error: null });

    const response = await DELETE(new Request('https://example.test'), {
      params: Promise.resolve({ id: folderId }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.rpc).toHaveBeenCalledWith('delete_flow_folder', {
      p_folder_id: folderId,
    });
  });

  it('does not expose an RPC failure', async () => {
    mocks.rpc.mockResolvedValue({
      data: null,
      error: { code: '08006', message: 'connection refused' },
    });

    const response = await DELETE(new Request('https://example.test'), {
      params: Promise.resolve({ id: folderId }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Could not delete folder',
    });
  });

  it('treats a false RPC result as a non-visible folder', async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await DELETE(new Request('https://example.test'), {
      params: Promise.resolve({ id: folderId }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Folder not found',
    });
  });

  it('rejects malformed identifiers without invoking the RPC', async () => {
    const response = await DELETE(new Request('https://example.test'), {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
