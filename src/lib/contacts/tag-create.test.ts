import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { createTag, TagCreateError } from './tag-create';

interface FakeOptions {
  existingTags?: { id: string; name: string }[];
  existingErr?: { message: string } | null;
  insertError?: { code?: string; message: string } | null;
}

function fakeDb(options: FakeOptions = {}): SupabaseClient {
  const existingTags = options.existingTags ?? [];

  return {
    from(table: string) {
      if (table !== 'tags') throw new Error(`unexpected table: ${table}`);
      const state: {
        operation: 'select' | 'insert';
        payload?: Record<string, unknown>;
      } = { operation: 'select' };

      const builder = {
        select() {
          return builder;
        },
        insert(payload: Record<string, unknown>) {
          state.operation = 'insert';
          state.payload = payload;
          return builder;
        },
        eq() {
          // The collision pre-check (`.select().eq('account_id', ...)`)
          // terminates here — no `.single()` in that chain.
          if (state.operation === 'select') {
            return Promise.resolve({
              data: existingTags,
              error: options.existingErr ?? null,
            });
          }
          return builder;
        },
        single() {
          if (options.insertError) {
            return Promise.resolve({ data: null, error: options.insertError });
          }
          return Promise.resolve({
            data: { id: 'tag-new', created_at: '2026-01-01T00:00:00Z', ...state.payload },
            error: null,
          });
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
}

const baseInput = {
  accountId: 'account-1',
  userId: 'user-1',
  name: 'Pendiente',
  color: '#3b82f6',
};

describe('createTag — validation', () => {
  it('rejects an empty name', async () => {
    await expect(
      createTag(fakeDb(), { ...baseInput, name: '' }),
    ).rejects.toMatchObject({ status: 400, code: 'name_required' });
  });

  it('rejects a whitespace-only name', async () => {
    await expect(
      createTag(fakeDb(), { ...baseInput, name: '    ' }),
    ).rejects.toMatchObject({ status: 400, code: 'name_required' });
  });

  it('trims the name before validating/persisting', async () => {
    const tag = await createTag(fakeDb(), { ...baseInput, name: '  Pendiente  ' });
    expect(tag.name).toBe('Pendiente');
  });

  it('rejects a name over the max length', async () => {
    await expect(
      createTag(fakeDb(), { ...baseInput, name: 'x'.repeat(41) }),
    ).rejects.toMatchObject({ status: 400, code: 'name_too_long' });
  });

  it('accepts a name exactly at the max length', async () => {
    const tag = await createTag(fakeDb(), { ...baseInput, name: 'x'.repeat(40) });
    expect(tag.name).toHaveLength(40);
  });

  it.each(['red', '#fff', '#ggg123', 'rgb(0,0,0)', ''])(
    'rejects an invalid color: %s',
    async (color) => {
      await expect(
        createTag(fakeDb(), { ...baseInput, color }),
      ).rejects.toMatchObject({ status: 400, code: 'invalid_color' });
    },
  );

  it('accepts a valid #RRGGBB color', async () => {
    const tag = await createTag(fakeDb(), { ...baseInput, color: '#AbCdEf' });
    expect(tag.color).toBe('#AbCdEf');
  });
});

describe('createTag — case-insensitive duplicate handling', () => {
  it('rejects a name that collides case-insensitively with an existing tag', async () => {
    const db = fakeDb({ existingTags: [{ id: 't1', name: 'pendiente' }] });
    await expect(
      createTag(db, { ...baseInput, name: 'PENDIENTE' }),
    ).rejects.toMatchObject({ status: 409, code: 'tag_name_conflict' });
  });

  it('rejects a name that collides after trimming', async () => {
    const db = fakeDb({ existingTags: [{ id: 't1', name: '  Pendiente  ' }] });
    await expect(
      createTag(db, { ...baseInput, name: 'pendiente' }),
    ).rejects.toMatchObject({ code: 'tag_name_conflict' });
  });

  it('allows a genuinely different name', async () => {
    const db = fakeDb({ existingTags: [{ id: 't1', name: 'Pendiente' }] });
    const tag = await createTag(db, { ...baseInput, name: 'Reclamo' });
    expect(tag.name).toBe('Reclamo');
  });

  it('remaps a 23505 race on insert to the same tag_name_conflict code', async () => {
    const db = fakeDb({ insertError: { code: '23505', message: 'duplicate key' } });
    await expect(createTag(db, baseInput)).rejects.toMatchObject({
      status: 409,
      code: 'tag_name_conflict',
    });
  });

  it('surfaces a non-duplicate insert failure as a generic internal error', async () => {
    const db = fakeDb({ insertError: { code: '42501', message: 'permission denied' } });
    await expect(createTag(db, baseInput)).rejects.toMatchObject({
      status: 500,
      code: 'internal',
    });
  });
});

describe('createTag — account scoping', () => {
  it('never accepts a caller-supplied account_id override — persists exactly the accountId argument', async () => {
    const db = fakeDb();
    const tag = await createTag(db, { ...baseInput, accountId: 'account-42' });
    expect(tag.account_id).toBe('account-42');
  });

  it('persists user_id as given (audit identity)', async () => {
    const tag = await createTag(fakeDb(), { ...baseInput, userId: 'user-99' });
    expect(tag.user_id).toBe('user-99');
  });
});

describe('TagCreateError', () => {
  it('carries both an HTTP-shaped status and a stable machine-readable code', () => {
    const err = new TagCreateError('boom', 418, 'teapot');
    expect(err.status).toBe(418);
    expect(err.code).toBe('teapot');
    expect(err.message).toBe('boom');
  });
});
