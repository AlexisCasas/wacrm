import { describe, expect, it } from "vitest";
import { createMemoryDb, type Row } from "@/lib/flows/test-support/memory-db";
import { readAudioGuideHealth } from "./health";
import type { SequencerDb } from "./sequencer";

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const db = (requests: Row[], sends: Row[]) => createMemoryDb({ audio_guide_requests: requests, audio_guide_sends: sends }).client as unknown as SequencerDb;
const read = (d: SequencerDb) => readAudioGuideHealth(d, { now: () => NOW });

describe("readAudioGuideHealth", () => {
  it("is ok when nothing is stuck, even with recent uncertain/partial results (those are for attention)", async () => {
    const h = await read(db(
      [{ id: "r1", status: "completed", created_at: ago(60) }, { id: "r2", status: "partial", created_at: ago(120) }, { id: "r3", status: "sending", created_at: ago(2) }],
      [{ id: "s1", status: "uncertain", finished_at: ago(30) }, { id: "s2", status: "pending", not_before: new Date(NOW + 5000).toISOString() }],
    ));
    expect(h).toMatchObject({ status: "ok", checks: { stuckRequests: 0, dueBacklog: 0, uncertainSends24h: 1, incompleteRequests24h: 1 } });
  });
  it("is degraded when a request has been in flight longer than the threshold", async () => {
    const h = await read(db([{ id: "r1", status: "sending", created_at: ago(11) }, { id: "r2", status: "claimed", created_at: ago(30) }], []));
    expect(h).toMatchObject({ status: "degraded", checks: { stuckRequests: 2 } });
  });
  it("is degraded when audios have been due for more than 5 minutes and nobody sent them (no resumer)", async () => {
    const h = await read(db([], [{ id: "s1", status: "pending", not_before: ago(6) }, { id: "s2", status: "pending", not_before: ago(1) }, { id: "s3", status: "pending", not_before: null }]));
    expect(h).toMatchObject({ status: "degraded", checks: { dueBacklog: 1 } });
  });
  it("only counts the last 24 hours", async () => {
    const h = await read(db([{ id: "r1", status: "failed", created_at: ago(25 * 60) }], [{ id: "s1", status: "uncertain", finished_at: ago(25 * 60) }]));
    expect(h.checks).toMatchObject({ uncertainSends24h: 0, incompleteRequests24h: 0 });
  });
  it("throws when it cannot read: a failing check is never reported as healthy", async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["in", "eq", "lt", "gte"]) chain[m] = () => chain;
    chain.then = (resolve: (r: unknown) => unknown) => resolve({ count: null, error: { message: "x" } });
    const broken = { from: () => ({ select: () => chain }) } as unknown as SequencerDb;
    await expect(read(broken)).rejects.toThrow(/health/);
  });
});
