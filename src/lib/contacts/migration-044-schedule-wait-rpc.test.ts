import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// P0 — BLOQUEO INTERNO DE CONTACTOS. Static content check for
// schedule_automation_wait_if_contact_active (migration 044) — the
// RPC that closes the wait-scheduling TOCTOU (see engine.ts's wait-
// step handling and its own doc comment for the full race). Vitest
// has no real Postgres to run the migration against, so this proves
// the SQL text itself carries the invariants the fix depends on:
// the same row lock block_contact_internal uses, tenant scoping, the
// insert happening inside the same function body, and the
// server-only privilege lockdown — rather than trusting that a
// future edit to the migration keeps them.

const MIGRATION_PATH = path.join(
  process.cwd(),
  "supabase/migrations/044_contact_blocking.sql",
);
const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

const FN_NAME = "schedule_automation_wait_if_contact_active";

function extractFunctionBody(): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${FN_NAME}(`);
  if (start < 0) {
    throw new Error(`function ${FN_NAME} not found in migration 044`);
  }
  const end = sql.indexOf("$$;", start);
  if (end < 0) {
    throw new Error(`could not find the end ($$;) of ${FN_NAME}'s body`);
  }
  return sql.slice(start, end + 3);
}

describe(`migration 044 — ${FN_NAME} (static check)`, () => {
  const fnBody = extractFunctionBody();

  it("takes the SAME row lock block_contact_internal uses (SELECT ... FOR UPDATE on contacts)", () => {
    expect(fnBody).toMatch(/SELECT\s+blocked\s+INTO\s+\w+\s+FROM\s+contacts/i);
    expect(fnBody).toMatch(/FOR UPDATE/i);
  });

  it("scopes that lock by both contact_id and account_id — never a bare contact id", () => {
    expect(fnBody).toMatch(
      /WHERE\s+id\s*=\s*p_contact_id\s+AND\s+account_id\s*=\s*p_account_id/i,
    );
  });

  it("inserts automation_pending_executions inside the SAME function body as the lock", () => {
    expect(fnBody).toMatch(/INSERT INTO automation_pending_executions/i);
  });

  it("is SECURITY DEFINER with a pinned search_path, matching the other block/unblock RPCs", () => {
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path = public/);
  });

  it("is locked to service_role only — REVOKE PUBLIC/anon/authenticated, GRANT service_role", () => {
    // Privilege statements sit right after the function body, before
    // the next CREATE OR REPLACE FUNCTION (or EOF, since this is
    // currently the last function in the file).
    const afterBody = sql.slice(sql.indexOf(fnBody) + fnBody.length);
    const nextFnIdx = afterBody.indexOf("CREATE OR REPLACE FUNCTION");
    const privilegeBlock = nextFnIdx === -1 ? afterBody : afterBody.slice(0, nextFnIdx);

    expect(privilegeBlock).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${FN_NAME}[\\s\\S]*?FROM PUBLIC`),
    );
    expect(privilegeBlock).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${FN_NAME}[\\s\\S]*?FROM anon`),
    );
    expect(privilegeBlock).toMatch(
      new RegExp(`REVOKE ALL ON FUNCTION ${FN_NAME}[\\s\\S]*?FROM authenticated`),
    );
    expect(privilegeBlock).toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${FN_NAME}[\\s\\S]*?TO service_role`),
    );
    // Never granted to anything else.
    expect(privilegeBlock).not.toMatch(
      new RegExp(`GRANT EXECUTE ON FUNCTION ${FN_NAME}[\\s\\S]*?TO authenticated`),
    );
  });

  it("returns FALSE rather than raising for 'not eligible' — the caller distinguishes success from stop without parsing an error message", () => {
    expect(fnBody).toMatch(/RETURN\s+FALSE\s*;/);
    expect(fnBody).toMatch(/RETURN\s+TRUE\s*;/);
  });
});
