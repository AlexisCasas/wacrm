import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { createTag, TagCreateError } from '@/lib/contacts/tag-create';

/**
 * POST /api/tags — create a tag definition (P3, admin+ only per the
 * audited permission matrix: docs/P3_TAGS_INBOX_AUDIT.md section F/H).
 *
 * The single reusable write path for tag creation — both the Inbox
 * ContactSidebar and Settings' TagManager should call this instead of
 * inserting into `tags` directly.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
      color?: unknown;
    } | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object', code: 'bad_request' },
        { status: 400 },
      );
    }
    if (typeof body.name !== 'string') {
      return NextResponse.json(
        { error: 'Tag name is required', code: 'name_required' },
        { status: 400 },
      );
    }
    if (typeof body.color !== 'string') {
      return NextResponse.json(
        { error: 'Tag color is required', code: 'invalid_color' },
        { status: 400 },
      );
    }

    // ctx.supabase is the RLS-scoped SSR client (never supabaseAdmin())
    // — the insert below is still gated by the `tags_insert` RLS
    // policy (admin+) as a second, independent layer under the
    // `requireRole` check above.
    const tag = await createTag(ctx.supabase, {
      accountId: ctx.accountId,
      userId: ctx.userId,
      name: body.name,
      color: body.color,
    });

    return NextResponse.json({ tag }, { status: 201 });
  } catch (error) {
    if (error instanceof TagCreateError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    return toErrorResponse(error);
  }
}
