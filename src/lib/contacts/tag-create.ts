import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

export class TagCreateError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'TagCreateError';
    this.status = status;
    this.code = code;
  }
}

/** Same cap as the existing Settings tag input (`tag-manager.tsx`'s `maxLength={40}`) — kept in sync intentionally. */
const MAX_NAME_LENGTH = 40;

/** Strict `#RRGGBB` — no CSS color names, no `rgb()`, no shorthand `#fff`. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface CreateTagInput {
  /** Never trust a client-supplied account_id — this must come from
   *  the caller's resolved session (e.g. `requireRole()`'s ctx.accountId). */
  accountId: string;
  userId: string;
  name: string;
  color: string;
}

export interface CreatedTag {
  id: string;
  name: string;
  color: string;
  account_id: string;
  user_id: string;
  created_at: string;
}

/**
 * The single server-side write path for creating a tag definition.
 * Both the Inbox "create tag" flow and Settings' TagManager should
 * call this (directly, or through `POST /api/tags`) instead of
 * inserting into `tags` themselves, so name/color validation and the
 * case-insensitive duplicate check live in exactly one place.
 *
 * Validates and rejects BEFORE ever touching the database — never
 * relies on the frontend having already checked. The database's own
 * case-insensitive unique index (migration 048) is the final backstop
 * for a race between two concurrent creates of the same name; a hit
 * there is remapped to the same `tag_name_conflict` code this
 * function raises for its own pre-check.
 */
export async function createTag(
  db: SupabaseClient,
  input: CreateTagInput,
): Promise<CreatedTag> {
  const name = input.name.trim();
  if (!name) {
    throw new TagCreateError('Tag name is required', 400, 'name_required');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new TagCreateError(
      `Tag name must be ${MAX_NAME_LENGTH} characters or fewer`,
      400,
      'name_too_long',
    );
  }
  if (!HEX_COLOR_RE.test(input.color)) {
    throw new TagCreateError(
      'Tag color must be a #RRGGBB hex value',
      400,
      'invalid_color',
    );
  }

  // Case-insensitive pre-check — gives a clean, stable error code
  // instead of surfacing the DB's raw 23505 on the common path. Reuses
  // the exact same-account tags list a caller would already need for
  // the "pick a tag" UI, so this is cheap (one small, indexed select).
  const { data: existingTags, error: existingErr } = await db
    .from('tags')
    .select('id, name')
    .eq('account_id', input.accountId);
  if (existingErr) {
    throw new TagCreateError('Failed to check existing tags', 500, 'internal');
  }
  const key = name.toLowerCase();
  const collision = (existingTags ?? []).find(
    (t) => (t.name as string).trim().toLowerCase() === key,
  );
  if (collision) {
    throw new TagCreateError('A tag with this name already exists', 409, 'tag_name_conflict');
  }

  const { data: created, error: createErr } = await db
    .from('tags')
    .insert({
      account_id: input.accountId,
      user_id: input.userId,
      name,
      color: input.color,
    })
    .select('id, name, color, account_id, user_id, created_at')
    .single();

  if (createErr || !created) {
    // Lost a race against a concurrent create of the same normalized
    // name — migration 048's unique index rejected it.
    if (isUniqueViolation(createErr)) {
      throw new TagCreateError('A tag with this name already exists', 409, 'tag_name_conflict');
    }
    throw new TagCreateError('Failed to create tag', 500, 'internal');
  }

  return created as CreatedTag;
}
