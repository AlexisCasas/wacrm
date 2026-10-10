import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  normalizeFlowFolderName,
  isUniqueViolation,
} from '@/lib/flows/folders';
import { collectCompletePages } from '@/lib/flows/pagination';

/** GET lists folders with counts without issuing one query per folder. */
export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const [folders, assignments] = await Promise.all([
      collectCompletePages<{
        id: string;
        name: string;
        created_at: string;
        updated_at: string;
      }>((from, to) =>
        ctx.supabase
          .from('flow_folders')
          .select('id, name, created_at, updated_at', { count: 'exact' })
          .order('name', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      ),
      collectCompletePages<{ folder_id: string | null }>((from, to) =>
        ctx.supabase
          .from('flows')
          .select('folder_id', { count: 'exact' })
          .order('id', { ascending: true })
          .range(from, to)
      ),
    ]);
    if (!folders || !assignments) {
      return NextResponse.json(
        { error: 'Could not load complete folder list' },
        { status: 503 }
      );
    }

    const counts = new Map<string, number>();
    let unfiledCount = 0;
    for (const flow of assignments) {
      if (flow.folder_id)
        counts.set(flow.folder_id, (counts.get(flow.folder_id) ?? 0) + 1);
      else unfiledCount += 1;
    }
    return NextResponse.json({
      folders: folders.map((folder) => ({
        ...folder,
        flow_count: counts.get(folder.id) ?? 0,
      })),
      unfiled_count: unfiledCount,
      total_flow_count: assignments.length,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
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
      .insert({ account_id: ctx.accountId, name })
      .select('id, name, created_at, updated_at')
      .single();
    if (isUniqueViolation(error))
      return NextResponse.json(
        { error: 'Folder name already exists' },
        { status: 409 }
      );
    if (error || !data)
      return NextResponse.json(
        { error: 'Could not create folder' },
        { status: 503 }
      );
    return NextResponse.json(
      { folder: { ...data, flow_count: 0 } },
      { status: 201 }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
