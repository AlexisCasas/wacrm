import { NextResponse, type NextRequest } from "next/server";

import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { LEGACY_IMPORT_TOKEN, renderTemplate } from "@/lib/variables";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/variables/preview { template, contact_id } — the text exactly as the engine would render it for that contact, plus a warning per
 * variable that has no value. Read-only: sends nothing and stores nothing. Uses the caller's session (RLS) and the caller's account.
 */
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireRole("viewer");
    const body = (await req.json().catch(() => null)) as { template?: unknown; contact_id?: unknown } | null;
    if (!body || typeof body.template !== "string" || body.template.length > 4096) {
      return NextResponse.json({ error: "template must be a string of at most 4096 characters" }, { status: 400 });
    }
    if (typeof body.contact_id !== "string" || !UUID.test(body.contact_id)) {
      return NextResponse.json({ error: "contact_id must be a uuid" }, { status: 400 });
    }
    const { text, warnings } = await renderTemplate(
      ctx.supabase,
      body.template,
      { accountId: ctx.accountId, contactId: body.contact_id },
      { unknown: "empty", keepUnknown: LEGACY_IMPORT_TOKEN },
    );
    return NextResponse.json({ text, warnings });
  } catch (err) {
    return toErrorResponse(err);
  }
}
