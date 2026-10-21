/**
 * Read-only health of the audio-guide sequencer, for a monitor (see qa/audio-guide/OPERACION.md). Counts only: no account ids, contacts or
 * messages. `degraded` means somebody must act (the resumer is not running, or requests are stuck); the other numbers are for attention.
 */
import type { SequencerDb } from "./sequencer";

export interface AudioGuideHealth {
  status: "ok" | "degraded";
  checks: {
    /** Requests still claimed/sending that were opened more than `stuckMinutes` ago. */
    stuckRequests: number;
    /** Audios whose pause ended more than `backlogMinutes` ago and are still pending: nobody is resuming them. */
    dueBacklog: number;
    /** Last 24 h, for attention (not degradation): audios recorded uncertain, and requests that ended partial or failed. */
    uncertainSends24h: number;
    incompleteRequests24h: number;
  };
  thresholds: { stuckMinutes: number; backlogMinutes: number };
}

export async function readAudioGuideHealth(db: SequencerDb, opts: { now?: () => number; stuckMinutes?: number; backlogMinutes?: number } = {}): Promise<AudioGuideHealth> {
  const now = (opts.now ?? Date.now)();
  const stuckMinutes = opts.stuckMinutes ?? 10, backlogMinutes = opts.backlogMinutes ?? 5;
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const count = async (query: PromiseLike<{ count: number | null; error: { message: string } | null }>): Promise<number> => {
    const { count: n, error } = await query;
    if (error) throw new Error("health query failed");
    return n ?? 0;
  };
  const head = { count: "exact" as const, head: true };
  const [stuck, backlog, uncertain, incomplete] = await Promise.all([
    count(db.from("audio_guide_requests").select("id", head).in("status", ["claimed", "sending"]).lt("created_at", iso(stuckMinutes * 60_000))),
    count(db.from("audio_guide_sends").select("id", head).eq("status", "pending").lt("not_before", iso(backlogMinutes * 60_000))),
    count(db.from("audio_guide_sends").select("id", head).eq("status", "uncertain").gte("finished_at", iso(24 * 3_600_000))),
    count(db.from("audio_guide_requests").select("id", head).in("status", ["partial", "failed"]).gte("created_at", iso(24 * 3_600_000))),
  ]);
  return {
    status: stuck > 0 || backlog > 0 ? "degraded" : "ok",
    checks: { stuckRequests: stuck, dueBacklog: backlog, uncertainSends24h: uncertain, incompleteRequests24h: incomplete },
    thresholds: { stuckMinutes, backlogMinutes },
  };
}
