import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  isUniqueViolation,
  isUuid,
  normalizeFlowFolderName,
} from '@/lib/flows/folders';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!isUuid(id))
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });
    const body = (await request.json().catch(() => null)) as {
      name?: unknown;
    } | null;
    const name = normalizeFlowFolderName(body?.name);
    if (!name)
      return NextResponse.json(
        { error: 'Invalid folder name' },
        { status: 400 }
      );

    const { data, error } = await ctx.supabase
      .from('flow_folders')
      .update({ name })
      .eq('id', id)
      .select('id, name, created_at, updated_at')
      .maybeSingle();
    if (isUniqueViolation(error))
      return NextResponse.json(
        { error: 'Folder name already exists' },
        { status: 409 }
      );
    if (error)
      return NextResponse.json(
        { error: 'Could not rename folder' },
        { status: 503 }
      );
    if (!data)
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    return NextResponse.json({ folder: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    if (!isUuid(id))
      return NextResponse.json({ error: 'Invalid folder id' }, { status: 400 });

    // The SECURITY INVOKER function locks the folder, unassigns only its
    // account's flows, and deletes it in one transaction under RLS.
    const { data, error } = await ctx.supabase.rpc('delete_flow_folder', {
      p_folder_id: id,
    });
    if (error)
      return NextResponse.json(
        { error: 'Could not delete folder' },
        { status: 503 }
      );
    if (!data)
      return NextResponse.json({ error: 'Folder not found' }, { status: 404 });
    // The RPC deliberately returns one boolean rather than every unfiled
    // flow. The client performs one complete, paginated catalogue reload so
    // large folders cannot be truncated by a PostgREST response limit.
    return NextResponse.json({ ok: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
