import { describe, expect, it } from "vitest";
import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { listRecentRequests } from "./requests";
import type { CatalogDb } from "./catalog";

const A = "046ff8c2-1111-4222-8333-444455556666";
const B = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const req = (id: string, account: string, createdAt: string, over: Row = {}): Row => ({ id, account_id: account, created_at: createdAt, status: "completed", reason: null, product_key: "combo xtd", flow_run_id: null, ...over });
const send = (requestId: string, account: string, position: number, status: string, over: Row = {}): Row => ({ request_id: requestId, account_id: account, position, status, error_code: null, finished_at: null, ...over });

const make = () => createMemoryDb({
  audio_guide_requests: [req("r1", A, "2026-10-18T10:00:00Z", { flow_run_id: "run1" }), req("r2", A, "2026-10-18T11:00:00Z", { status: "partial", flow_run_id: "run2" }), req("rb", B, "2026-10-18T12:00:00Z", { flow_run_id: "runb" }), req("r3", A, "2026-10-18T09:00:00Z", { status: "skipped", reason: "gate_closed" })],
  audio_guide_sends: [send("r1", A, 1, "sent"), send("r2", A, 2, "failed", { error_code: "meta_131053" }), send("r2", A, 1, "sent"), send("rb", B, 1, "sent")],
  flow_runs: [{ id: "run1", account_id: A, flow_id: "f1", status: "completed", end_reason: "end_node" }, { id: "run2", account_id: A, flow_id: "f1", status: "failed", end_reason: "audio_sequence_incomplete" }, { id: "runb", account_id: B, flow_id: "fb", status: "completed", end_reason: null }],
}).client as unknown as CatalogDb;

describe("listRecentRequests", () => {
  it("returns the account's latest requests first, each with its audios in order and the originating run", async () => {
    const list = await listRecentRequests(make(), A);
    expect(list?.map((r) => r.id)).toEqual(["r2", "r1", "r3"]);
    expect(list?.[0]).toMatchObject({ status: "partial", sends: [{ position: 1, status: "sent" }, { position: 2, status: "failed", errorCode: "meta_131053" }], run: { id: "run2", flowId: "f1", status: "failed", endReason: "audio_sequence_incomplete" } });
    expect(list?.[2]).toMatchObject({ status: "skipped", reason: "gate_closed", sends: [], run: null });
  });
  it("never shows another account's requests, audios or runs", async () => {
    expect((await listRecentRequests(make(), A))?.some((r) => r.id === "rb")).toBe(false);
    const b = await listRecentRequests(make(), B);
    expect(b?.map((r) => r.id)).toEqual(["rb"]);
    expect(b?.[0].run?.flowId).toBe("fb");
  });
  it("bounds the page (1..50) and reports a database failure as null", async () => {
    expect((await listRecentRequests(make(), A, 1))?.map((r) => r.id)).toEqual(["r2"]);
    expect((await listRecentRequests(make(), A, 0))?.length).toBe(1);
    const broken = { from: () => ({ select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "x" } }) }) }) }) }) } as unknown as CatalogDb;
    expect(await listRecentRequests(broken, A)).toBeNull();
  });
});
