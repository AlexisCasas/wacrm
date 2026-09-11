import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Meta 131056 durable retry — PHASE 3. Static content check for
// schedule_automation_retry_if_contact_active (migration 050) — mirrors
// src/lib/contacts/migration-044-schedule-wait-rpc.test.ts's own pattern
// for schedule_automation_wait_if_contact_active, since this RPC is
// deliberately built the same way (same row lock, same SECURITY
// DEFINER posture, same server-only privilege lockdown). Vitest has no
// real Postgres to run the migration against, so this proves the SQL
// TEXT itself carries every invariant the design depends on, rather
// than trusting that a future edit keeps them.

const MIGRATION_PATH = path.join(
  process.cwd(),
  "supabase/migrations/050_meta_rate_limit_retry.sql",
);
const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

const FN_NAME = "schedule_automation_retry_if_contact_active";

function extractFunctionBody(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) {
    throw new Error(`function ${name} not found in migration 050`);
  }
  const end = sql.indexOf("$$;", start);
  if (end < 0) {
    throw new Error(`could not find the end ($$;) of ${name}'s body`);
  }
  return sql.slice(start, end + 3);
}

describe("migration 050 — schema", () => {
  it("adds retry_count/retry_reason/retry_step_id to automation_pending_executions, idempotently", () => {
    expect(sql).toMatch(/ALTER TABLE public\.automation_pending_executions[\s\S]*?ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS retry_reason TEXT/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS retry_step_id UUID/);
  });

  it("retry_step_id has NO foreign key to automation_steps — the UUID must survive the step being edited/deleted", () => {
    // A FK clause would appear on the SAME line/column definition —
    // confirm no "REFERENCES automation_steps" anywhere near retry_step_id.
    const retryStepIdLine = sql.split("\n").find((l) => l.includes("retry_step_id UUID"));
    expect(retryStepIdLine).toBeDefined();
    expect(retryStepIdLine).not.toMatch(/REFERENCES/i);
  });

  it("has a named, idempotent (DROP + ADD) CHECK constraint enforcing the wait-vs-retry shape", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS automation_pending_executions_retry_metadata_check/);
    expect(sql).toMatch(/ADD CONSTRAINT automation_pending_executions_retry_metadata_check/);
    expect(sql).toMatch(/retry_count = 0 AND retry_reason IS NULL AND retry_step_id IS NULL/);
    expect(sql).toMatch(/retry_count BETWEEN 1 AND 5 AND retry_reason IS NOT NULL AND retry_step_id IS NOT NULL/);
  });

  it("does NOT hardcode 'meta_pair_rate_limit' into the CHECK constraint itself (only the RPC restricts it)", () => {
    const checkStart = sql.indexOf("ADD CONSTRAINT automation_pending_executions_retry_metadata_check");
    const checkEnd = sql.indexOf(";", checkStart);
    const checkClause = sql.slice(checkStart, checkEnd);
    expect(checkClause).not.toMatch(/meta_pair_rate_limit/);
  });
});

describe("migration 050 — claim/lease crash recovery (Phase 3.1)", () => {
  it("adds claim_token/lease_expires_at to automation_pending_executions, idempotently, with no FK on claim_token", () => {
    expect(sql).toMatch(/ALTER TABLE public\.automation_pending_executions[\s\S]*?ADD COLUMN IF NOT EXISTS claim_token UUID/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ/);
    const claimTokenLine = sql.split("\n").find((l) => l.includes("claim_token UUID"));
    expect(claimTokenLine).toBeDefined();
    expect(claimTokenLine).not.toMatch(/REFERENCES/i);
  });

  it("backfills legacy (pre-050) 'running' rows with a synthetic, already-expired lease BEFORE the CHECK constraint exists", () => {
    // Final-review finding (BLOCKER, confirmed against real Postgres):
    // a pre-050 'running' row has NULL claim_token/lease_expires_at
    // after the plain ADD COLUMN above, which satisfies none of the
    // claim_lease_check's branches — the ADD CONSTRAINT statement
    // itself would fail outright without this backfill running first.
    const updateStart = sql.indexOf("UPDATE public.automation_pending_executions");
    expect(updateStart).toBeGreaterThan(-1);
    const updateEnd = sql.indexOf(";", updateStart);
    const updateClause = sql.slice(updateStart, updateEnd);

    // Targets exactly 'running' rows that are still missing claim/lease
    // — never touches a row a real claim already stamped with its own
    // token/future lease, and never touches 'pending'/'done'/'failed'.
    expect(updateClause).toMatch(/WHERE status = 'running'/);
    expect(updateClause).toMatch(/claim_token IS NULL/);
    expect(updateClause).toMatch(/lease_expires_at IS NULL/);

    // Generates a claim_token when missing (COALESCE — never
    // overwrites an existing one), using this schema's established
    // UUID function (uuid_generate_v4, not gen_random_uuid).
    expect(updateClause).toMatch(/claim_token = COALESCE\(claim_token, uuid_generate_v4\(\)\)/);

    // The synthetic lease is DELIBERATELY already expired (a past
    // timestamp), never a future one — it must be immediately
    // reclaimable by the next cron tick, not treated as a live claim.
    expect(updateClause).toMatch(/lease_expires_at = COALESCE\(\s*lease_expires_at,\s*now\(\) - interval '1 minute'\s*\)/);

    // Ordering: this UPDATE must appear in the file BEFORE the ADD
    // CONSTRAINT it exists to unblock — the CHECK cannot validate
    // existing rows correctly if it runs first.
    const constraintIndex = sql.indexOf("ADD CONSTRAINT automation_pending_executions_claim_lease_check");
    expect(constraintIndex).toBeGreaterThan(-1);
    expect(updateStart).toBeLessThan(constraintIndex);
  });

  it("has a named, idempotent (DROP + ADD) CHECK constraint tying status to claim/lease presence", () => {
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS automation_pending_executions_claim_lease_check/);
    expect(sql).toMatch(/ADD CONSTRAINT automation_pending_executions_claim_lease_check/);
    const checkStart = sql.indexOf("ADD CONSTRAINT automation_pending_executions_claim_lease_check");
    const checkEnd = sql.indexOf(");", checkStart);
    const checkClause = sql.slice(checkStart, checkEnd);
    // pending -> no claim/lease yet.
    expect(checkClause).toMatch(/status = 'pending' AND claim_token IS NULL AND lease_expires_at IS NULL/);
    // running -> MUST have both (ownership is unambiguous while active).
    expect(checkClause).toMatch(/status = 'running' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL/);
    // done/failed -> deliberately unconstrained (block_contact_internal's
    // bulk sweep doesn't null these out; a stale value there is inert).
    expect(checkClause).toMatch(/status IN \('done', 'failed'\)/);
  });

  it("adds a partial index on lease_expires_at scoped to status='running', for the cron's stale-lease half of its due-set query", () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_automation_pending_stale_running/);
    expect(sql).toMatch(/ON public\.automation_pending_executions \(lease_expires_at\)/);
    expect(sql).toMatch(/WHERE status = 'running'/);
  });
});

describe(`migration 050 — ${FN_NAME} (static check)`, () => {
  const fnBody = extractFunctionBody(FN_NAME);

  it("does NOT modify schedule_automation_wait_if_contact_active at all", () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.schedule_automation_wait_if_contact_active/);
  });

  it("validates structural retry metadata BEFORE touching contacts — retry_count 1..5", () => {
    expect(fnBody).toMatch(/p_retry_count[\s\S]*?<\s*1[\s\S]*?RAISE EXCEPTION/);
    expect(fnBody).toMatch(/USING ERRCODE = '22023'/);
  });

  it("restricts p_retry_reason to 'meta_pair_rate_limit' in this first version", () => {
    expect(fnBody).toMatch(/p_retry_reason IS DISTINCT FROM 'meta_pair_rate_limit'/);
  });

  it("validates retry_step_id against automation_steps: same automation, position, parent_step_id, branch, and an outbound send step_type", () => {
    expect(fnBody).toMatch(/FROM automation_steps/);
    expect(fnBody).toMatch(/id = p_retry_step_id/);
    expect(fnBody).toMatch(/automation_id = p_automation_id/);
    expect(fnBody).toMatch(/position = p_next_step_position/);
    expect(fnBody).toMatch(/parent_step_id IS NOT DISTINCT FROM p_parent_step_id/);
    expect(fnBody).toMatch(/branch IS NOT DISTINCT FROM p_branch/);
    expect(fnBody).toMatch(/step_type IN \('send_message', 'send_media', 'send_buttons', 'send_list', 'send_template'\)/);
  });

  it("takes the SAME row lock schedule_automation_wait_if_contact_active / block_contact_internal use (SELECT ... FOR UPDATE on contacts)", () => {
    expect(fnBody).toMatch(/SELECT\s+blocked\s+INTO\s+\w+\s+FROM\s+contacts/i);
    expect(fnBody).toMatch(/FOR UPDATE/i);
  });

  it("scopes that lock by both contact_id and account_id — never a bare contact id", () => {
    expect(fnBody).toMatch(/WHERE\s+id\s*=\s*p_contact_id\s+AND\s+account_id\s*=\s*p_account_id/i);
  });

  it("inserts automation_pending_executions with the retry columns, inside the SAME function body as the lock", () => {
    expect(fnBody).toMatch(/INSERT INTO automation_pending_executions/i);
    expect(fnBody).toMatch(/retry_count, retry_reason, retry_step_id/);
  });

  it("is SECURITY DEFINER with a pinned search_path, matching the other block/unblock/wait RPCs", () => {
    expect(fnBody).toMatch(/SECURITY DEFINER/);
    expect(fnBody).toMatch(/SET search_path = public/);
  });

  it("is locked to service_role only — REVOKE PUBLIC/anon/authenticated/service_role, then GRANT service_role", () => {
    const afterBody = sql.slice(sql.indexOf(fnBody) + fnBody.length);
    // service_role appears in BOTH the REVOKE and the GRANT — confirm
    // the REVOKE names all 4 (the P3 lesson: a plain "FROM PUBLIC" is
    // not sufficient, Supabase's own default-privileges grants EXECUTE
    // directly to anon/authenticated/service_role too) before the GRANT
    // hands it back to service_role alone.
    const revokeMatch = afterBody.match(/REVOKE ALL ON FUNCTION public\.schedule_automation_retry_if_contact_active[\s\S]*?;/);
    expect(revokeMatch).not.toBeNull();
    const revokeClause = revokeMatch![0];
    expect(revokeClause).toMatch(/PUBLIC/);
    expect(revokeClause).toMatch(/anon/);
    expect(revokeClause).toMatch(/authenticated/);
    expect(revokeClause).toMatch(/service_role/);

    const grantMatch = afterBody.match(/GRANT EXECUTE ON FUNCTION public\.schedule_automation_retry_if_contact_active[\s\S]*?;/);
    expect(grantMatch).not.toBeNull();
    expect(grantMatch![0]).toMatch(/TO service_role/);
  });

  it("returns FALSE rather than raising for 'not eligible' (not found / blocked) — distinct from the RAISE EXCEPTION structural-error path", () => {
    expect(fnBody).toMatch(/RETURN\s+FALSE\s*;/);
    expect(fnBody).toMatch(/RETURN\s+TRUE\s*;/);
  });
});
