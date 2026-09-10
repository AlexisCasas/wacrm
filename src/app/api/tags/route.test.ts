import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createTag: vi.fn(),
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 }),
  ),
}));

vi.mock('@/lib/contacts/tag-create', () => ({
  createTag: mocks.createTag,
  TagCreateError: class TagCreateError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

import { POST } from './route';
import { TagCreateError } from '@/lib/contacts/tag-create';

const context = {
  supabase: { name: 'scoped-client' },
  accountId: 'account-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'account-1', name: 'Acme' },
};

function request(body: unknown) {
  return new Request('http://localhost/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.createTag.mockReset();
  mocks.requireRole.mockResolvedValue(context);
});

describe('POST /api/tags', () => {
  it('requires the admin role', async () => {
    mocks.createTag.mockResolvedValue({ id: 't1', name: 'Pendiente', color: '#3b82f6' });
    await POST(request({ name: 'Pendiente', color: '#3b82f6' }));
    expect(mocks.requireRole).toHaveBeenCalledWith('admin');
  });

  it('403s (via toErrorResponse) when the caller is below admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const response = await POST(request({ name: 'Pendiente', color: '#3b82f6' }));
    expect(response.status).toBe(403);
    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it('rejects a non-string name before calling createTag', async () => {
    const response = await POST(request({ color: '#3b82f6' }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.code).toBe('name_required');
    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it('rejects a non-string color before calling createTag', async () => {
    const response = await POST(request({ name: 'Pendiente' }));
    const json = await response.json();
    expect(response.status).toBe(400);
    expect(json.code).toBe('invalid_color');
    expect(mocks.createTag).not.toHaveBeenCalled();
  });

  it('never trusts a client-supplied account_id — always uses the session account', async () => {
    mocks.createTag.mockResolvedValue({ id: 't1', name: 'Pendiente', color: '#3b82f6' });
    await POST(
      request({ name: 'Pendiente', color: '#3b82f6', account_id: 'attacker-account' }),
    );
    expect(mocks.createTag).toHaveBeenCalledWith(
      context.supabase,
      expect.objectContaining({ accountId: 'account-1', userId: 'user-1' }),
    );
  });

  it('201s with the created tag on success', async () => {
    const tag = { id: 't1', name: 'Pendiente', color: '#3b82f6' };
    mocks.createTag.mockResolvedValue(tag);
    const response = await POST(request({ name: 'Pendiente', color: '#3b82f6' }));
    const json = await response.json();
    expect(response.status).toBe(201);
    expect(json.tag).toEqual(tag);
  });

  it('maps a TagCreateError to its own status/code, never a generic 500', async () => {
    mocks.createTag.mockRejectedValue(
      new TagCreateError('A tag with this name already exists', 409, 'tag_name_conflict'),
    );
    const response = await POST(request({ name: 'Pendiente', color: '#3b82f6' }));
    const json = await response.json();
    expect(response.status).toBe(409);
    expect(json.code).toBe('tag_name_conflict');
  });
});
