import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isUuid } from '@/lib/flows/folders';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!isUuid(id))
      return NextResponse.json({ error: 'Invalid flow id' }, { status: 400 });
    const body = (await request.json().catch(() => null)) as {
      folder_id?: unknown;
    } | null;
    if (!body || !Object.hasOwn(body, 'folder_id'))
      return NextResponse.json(
        { error: 'folder_id is required' },
        { status: 400 }
      );
    if (body.folder_id !== null && !isUuid(body.folder_id))
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });

    const { data: flow, error: flowError } = await ctx.supabase
      .from('flows')
      .select('id')
      .eq('id', id)
      .maybeSingle();
    if (flowError)
      return NextResponse.json(
        { error: 'Could not load flow' },
        { status: 503 }
      );
    if (!flow)
      return NextResponse.json({ error: 'Flow not found' }, { status: 404 });

    if (body.folder_id) {
      const { data: folder, error: folderError } = await ctx.supabase
        .from('flow_folders')
        .select('id')
        .eq('id', body.folder_id)
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (folderError)
        return NextResponse.json(
          { error: 'Could not load folder' },
          { status: 503 }
        );
      // RLS makes another account's folder indistinguishable from missing.
      if (!folder)
        return NextResponse.json(
          { error: 'Folder not found' },
          { status: 404 }
        );
    }

    // This is intentionally a narrow PATCH: it never touches graph nodes,
    // flow status, triggers, or run history. The composite FK remains the
    // final race-safe tenant check if the folder is deleted concurrently.
    const { data, error } = await ctx.supabase
      .from('flows')
      .update({ folder_id: body.folder_id })
      .eq('id', id)
      .select('id, folder_id')
      .maybeSingle();
    if (error)
      return NextResponse.json(
        { error: 'Could not move flow' },
        { status: 409 }
      );
    if (!data)
      return NextResponse.json({ error: 'Flow not found' }, { status: 404 });
    return NextResponse.json({ flow: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
