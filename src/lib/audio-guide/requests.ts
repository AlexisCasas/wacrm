/**
 * What an operator sees of the audio sequences of their account: the latest requests with the state of each audio and of the Flow run
 * that started it. Read-only and account-scoped (every query repeats the account id). Contains no contact data.
 */
import type { CatalogDb } from "./catalog";

export interface RecentSend { position: number; status: string; errorCode: string | null; finishedAt: string | null }
export interface RecentRequest {
  id: string;
  createdAt: string;
  status: string;
  reason: string | null;
  productKey: string | null;
  sends: RecentSend[];
  run: { id: string; flowId: string; status: string; endReason: string | null } | null;
}

export const MAX_RECENT_REQUESTS = 50;

export async function listRecentRequests(db: CatalogDb, accountId: string, limit = 20): Promise<RecentRequest[] | null> {
  const n = Math.min(MAX_RECENT_REQUESTS, Math.max(1, Math.floor(limit)));
  const { data, error } = await db.from("audio_guide_requests").select("id, created_at, status, reason, product_key, flow_run_id").eq("account_id", accountId).order("created_at", { ascending: false }).limit(n);
  if (error) return null;
  const requests = (data as Array<Record<string, unknown>> | null) ?? [];
  if (requests.length === 0) return [];
  const ids = requests.map((r) => r.id as string);
  const runIds = [...new Set(requests.map((r) => r.flow_run_id).filter((x): x is string => typeof x === "string"))];
  const [sendsResult, runsResult] = await Promise.all([
    db.from("audio_guide_sends").select("request_id, position, status, error_code, finished_at").eq("account_id", accountId).in("request_id", ids).order("position", { ascending: true }),
    runIds.length ? db.from("flow_runs").select("id, flow_id, status, end_reason").eq("account_id", accountId).in("id", runIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (sendsResult.error || runsResult.error) return null;
  const sends = new Map<string, RecentSend[]>();
  for (const s of (sendsResult.data as Array<Record<string, unknown>> | null) ?? []) {
    const list = sends.get(s.request_id as string) ?? [];
    list.push({ position: Number(s.position), status: String(s.status), errorCode: (s.error_code as string | null) ?? null, finishedAt: (s.finished_at as string | null) ?? null });
    sends.set(s.request_id as string, list);
  }
  const runs = new Map(((runsResult.data as Array<Record<string, unknown>> | null) ?? []).map((r) => [r.id as string, { id: r.id as string, flowId: r.flow_id as string, status: String(r.status), endReason: (r.end_reason as string | null) ?? null }]));
  return requests.map((r) => ({
    id: r.id as string, createdAt: String(r.created_at), status: String(r.status), reason: (r.reason as string | null) ?? null, productKey: (r.product_key as string | null) ?? null,
    sends: sends.get(r.id as string) ?? [], run: typeof r.flow_run_id === "string" ? (runs.get(r.flow_run_id) ?? null) : null,
  }));
}
