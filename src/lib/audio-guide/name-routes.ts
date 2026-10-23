/**
 * HTTP handlers shared by /api/audio-guide/purposes and /api/audio-guide/identifiers (the two catalogs are identical in shape and rules).
 * Reads need an account member; writes need an admin; the account is the session's; the module gate and the service-role client are the
 * same as every other audio-guide route (see api.ts).
 */

import { NextResponse } from "next/server";

import { badRequest, failure, guarded, json, notFound, validId } from "./api";
import { parseCreateName, parseSaveName } from "./input";
import { createName, deleteName, listNames, updateName, type CatalogName, type NameKind } from "./selection";

export const nameDto = (n: CatalogName) => ({ id: n.id, name: n.name, active: n.active, in_use: n.inUse, created_at: n.createdAt, updated_at: n.updatedAt });

type Ctx = { params: Promise<{ id: string }> };

export function nameCollectionHandlers(kind: NameKind) {
  const key = kind === "purpose" ? "purposes" : "identifiers";
  return {
    /** GET -> { purposes | identifiers: [{ id, name, active, in_use }] } */
    GET: async (): Promise<NextResponse> => guarded("read", async ({ account, db }) => {
      const result = await listNames(db, account.accountId, kind);
      return result.ok ? json({ [key]: result.value.map(nameDto) }) : failure(result);
    }),
    /** POST { name, active? } -> 201 { purpose | identifier }. Admin. */
    POST: async (request: Request): Promise<NextResponse> => guarded("write", async ({ account, db }) => {
      const parsed = parseCreateName(await request.json().catch(() => null));
      if (!parsed.ok) return badRequest(parsed.field, parsed.error);
      const result = await createName(db, account.accountId, kind, parsed.value);
      return result.ok ? json({ [kind]: nameDto(result.value) }, 201) : failure(result);
    }),
  };
}

export function nameItemHandlers(kind: NameKind) {
  return {
    /** PATCH { name?, active? } -> { purpose | identifier }. Admin. Renaming to the same normalised name is allowed; to another existing one is 409. */
    PATCH: async (request: Request, { params }: Ctx): Promise<NextResponse> => {
      const { id } = await params;
      if (!validId(id)) return notFound();
      return guarded("write", async ({ account, db }) => {
        const parsed = parseSaveName(await request.json().catch(() => null));
        if (!parsed.ok) return badRequest(parsed.field, parsed.error);
        const result = await updateName(db, account.accountId, kind, id, parsed.value);
        return result.ok ? json({ [kind]: nameDto(result.value) }) : failure(result);
      });
    },
    /** DELETE -> 200 {}. Admin. 409 in_use while any audio is classified with it (deactivate it instead). */
    DELETE: async (_request: Request, { params }: Ctx): Promise<NextResponse> => {
      const { id } = await params;
      if (!validId(id)) return notFound();
      return guarded("write", async ({ account, db }) => {
        const result = await deleteName(db, account.accountId, kind, id);
        return result.ok ? json({ ok: true }) : failure(result);
      });
    },
  };
}
