/**
 * A small in-memory stand-in for the slice of the Supabase query builder the Flow runner and the senders use. Rows live in
 * plain arrays, so a test can run the REAL runner and the REAL sender and then read back what they persisted (run state,
 * events, messages), instead of asserting on call shapes.
 *
 * Supported: select / insert / update / upsert / delete, eq / neq / gt / gte / lt / lte / in / is / filter("a->>b", "eq", v), order, limit,
 * maybeSingle / single, select(.., { count: "exact", head: true }), rpc (recorded, scripted by name).
 * Not a database: no constraints, no joins, no RLS. Unknown tables behave as empty.
 */

export type Row = Record<string, unknown>;

type Filter = (row: Row) => boolean;
type Result = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };

export interface MemoryDbOptions {
  /** Return an error to make an insert into `table` fail; return undefined to let it through. */
  failInsert?: (table: string, row: Row) => { message: string; code?: string } | undefined;
  /** Scripted `rpc` results by function name. Unlisted functions succeed with `data: null`. */
  rpc?: Record<string, (args: Row) => { data?: unknown; error?: { message: string; code?: string } | null }>;
}

function readPath(row: Row, path: string): unknown {
  if (path.includes("->>")) {
    const [col, key] = path.split("->>");
    const value = row[col];
    return value && typeof value === "object" ? (value as Row)[key] : undefined;
  }
  return row[path];
}

/** Orders two column values (numbers numerically, everything else, ISO timestamps included, as strings). */
const compare = (a: unknown, b: unknown): number => {
  if (a == null || b == null) return Number.NaN;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

const same = (a: unknown, b: unknown) => (a === b) || (a != null && b != null && String(a) === String(b));

export function createMemoryDb(initial: Record<string, Row[]> = {}, options: MemoryDbOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(initial)) tables[name] = rows.map((r) => ({ ...r }));
  const rpcCalls: Array<{ fn: string; args: Row }> = [];
  let sequence = 0;
  const table = (name: string) => (tables[name] ??= []);

  const defaults = (name: string, row: Row): Row => {
    const base: Row = { id: `${name}-${++sequence}`, created_at: new Date().toISOString() };
    if (name === "flow_runs") Object.assign(base, { status: "active", reprompt_count: 0, vars: {}, started_at: new Date().toISOString() });
    return { ...base, ...row };
  };

  function query(name: string) {
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: Row | Row[] | undefined;
    let upsertKeys: string[] = [];
    let ignoreDuplicates = false;
    let head = false;
    let wantCount = false;
    let returning = false;
    let limitN: number | undefined;
    let order: { col: string; ascending: boolean } | undefined;
    const filters: Filter[] = [];

    const run = (): Result => {
      const rows = table(name);
      const matching = () => rows.filter((r) => filters.every((f) => f(r)));
      if (op === "insert" || op === "upsert") {
        const input = Array.isArray(payload) ? payload : [payload as Row];
        const out: Row[] = [];
        for (const raw of input) {
          const failure = options.failInsert?.(name, raw);
          if (failure) return { data: null, error: failure };
          if (op === "upsert" && upsertKeys.length) {
            const existing = rows.find((r) => upsertKeys.every((k) => same(r[k], raw[k])));
            if (existing) {
              if (!ignoreDuplicates) Object.assign(existing, raw);
              continue;
            }
          }
          const row = defaults(name, raw);
          rows.push(row);
          out.push(row);
        }
        return { data: returning ? out.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "update") {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload as Row);
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      if (op === "delete") {
        const hit = new Set(matching());
        tables[name] = rows.filter((r) => !hit.has(r));
        return { data: null, error: null };
      }
      let hit = matching();
      if (order) {
        const { col, ascending } = order;
        hit = [...hit].sort((a, b) => (String(a[col] ?? "") < String(b[col] ?? "") ? -1 : 1) * (ascending ? 1 : -1));
      }
      if (limitN !== undefined) hit = hit.slice(0, limitN);
      return { data: head ? null : hit.map((r) => ({ ...r })), error: null, count: wantCount ? matching().length : null };
    };

    const q: Record<string, unknown> = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (op === "select") op = "select";
        returning = true;
        head = opts?.head === true;
        wantCount = opts?.count === "exact";
        return q;
      },
      insert(rows: Row | Row[]) { op = "insert"; payload = rows; return q; },
      upsert(rows: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        op = "upsert"; payload = rows; upsertKeys = (opts?.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        ignoreDuplicates = opts?.ignoreDuplicates === true; return q;
      },
      update(patch: Row) { op = "update"; payload = patch; return q; },
      delete() { op = "delete"; return q; },
      eq(col: string, v: unknown) { filters.push((r) => same(readPath(r, col), v)); return q; },
      neq(col: string, v: unknown) { filters.push((r) => !same(readPath(r, col), v)); return q; },
      gte(col: string, v: unknown) { filters.push((r) => compare(readPath(r, col), v) >= 0); return q; },
      gt(col: string, v: unknown) { filters.push((r) => compare(readPath(r, col), v) > 0); return q; },
      lte(col: string, v: unknown) { filters.push((r) => compare(readPath(r, col), v) <= 0); return q; },
      lt(col: string, v: unknown) { filters.push((r) => compare(readPath(r, col), v) < 0); return q; },
      in(col: string, vs: unknown[]) { filters.push((r) => vs.some((v) => same(readPath(r, col), v))); return q; },
      is(col: string, v: unknown) { filters.push((r) => (v === null ? readPath(r, col) == null : same(readPath(r, col), v))); return q; },
      filter(col: string, operator: string, v: unknown) {
        if (operator !== "eq") throw new Error(`memory-db: unsupported filter operator ${operator}`);
        filters.push((r) => same(readPath(r, col), v)); return q;
      },
      order(col: string, opts?: { ascending?: boolean }) { order = { col, ascending: opts?.ascending !== false }; return q; },
      limit(n: number) { limitN = n; return q; },
      maybeSingle() { const r = run(); const rows = (r.data as Row[] | null) ?? []; return Promise.resolve({ ...r, data: rows[0] ?? null }); },
      single() { const r = run(); const rows = (r.data as Row[] | null) ?? []; return Promise.resolve(rows[0] ? { ...r, data: rows[0] } : { data: null, error: { message: "no rows" } }); },
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        try { return Promise.resolve(run()).then(resolve, reject); } catch (e) { return Promise.reject(e).then(resolve, reject); }
      },
    };
    return q;
  }

  return {
    client: {
      from: (name: string) => query(name),
      rpc: (fn: string, args: Row = {}) => {
        rpcCalls.push({ fn, args });
        const scripted = options.rpc?.[fn]?.(args);
        return Promise.resolve({ data: scripted?.data ?? null, error: scripted?.error ?? null });
      },
    },
    tables,
    table,
    rpcCalls,
  };
}
