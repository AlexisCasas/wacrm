interface ContactTagMutationResult {
  added?: boolean;
  dispatched?: boolean;
  reason?: 'duplicate' | 'max_depth';
}

async function mutateContactTag(
  contactId: string,
  tagId: string,
  method: 'POST' | 'DELETE'
): Promise<ContactTagMutationResult> {
  const response = await fetch(`/api/contacts/${contactId}/tags`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_id: tagId }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & ContactTagMutationResult;
  if (!response.ok) {
    throw new Error(body.error ?? 'Failed to update contact tag');
  }
  return body;
}

export function addContactTag(contactId: string, tagId: string) {
  return mutateContactTag(contactId, tagId, 'POST');
}

export function deleteContactTag(contactId: string, tagId: string) {
  return mutateContactTag(contactId, tagId, 'DELETE');
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
 * Thrown by `createTag` below. `.code` is the stable machine-readable
 * reason (`name_required` / `name_too_long` / `invalid_color` /
 * `tag_name_conflict` / `internal`) — callers should branch on this
 * for a localized message rather than displaying `.message`, which is
 * the server's raw (English-only) string.
 */
export class TagApiError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'TagApiError';
    this.code = code;
  }
}

/**
 * Create a new tag definition (admin+ — see `POST /api/tags`). Throws
 * `TagApiError` on any non-2xx response.
 */
export async function createTag(name: string, color: string): Promise<CreatedTag> {
  const response = await fetch('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    tag?: CreatedTag;
  };
  if (!response.ok || !body.tag) {
    throw new TagApiError(body.error ?? 'Failed to create tag', body.code);
  }
  return body.tag;
}
