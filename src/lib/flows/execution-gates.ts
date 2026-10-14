import { durableWaitExecutionAccountIds, isDurableWaitExecutionEnabledForAccount } from "./durable-wait-capability";
import { isSubflowExecutionEnabledForAccount, subflowExecutionAccountIds } from "./subflow-execution-capability";

/**
 * The two keys to RUN subflows / durable waits:
 *   1. the environment (FLOW_EXECUTION_SCOPE, flow-scope.ts), and
 *   2. the database (flow_execution_enablement per account, else flow_execution_defaults; migrations 070 / 071), which only a
 *      privileged operator can change.
 * Both must say yes. Any failure to read the database counts as "no".
 */
export type ExecutionKind = "subflow" | "durable_wait";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any; rpc?: (fn: string, args: Record<string, unknown>) => any };

export async function executionEnabledInDb(db: Db, accountId: string, kind: ExecutionKind): Promise<boolean> {
  try {
    const { data, error } = await db.rpc!("flow_execution_enabled", { p_account_id: accountId, p_kind: kind });
    if (!error && typeof data === "boolean") return data;
  } catch { /* function not there yet (070 only) or a test double: fall back to the per-account row */ }
  const column = kind === "subflow" ? "subflow_execution" : "durable_wait_execution";
  try {
    const { data, error } = await db.from("flow_execution_enablement").select(column).eq("account_id", accountId).maybeSingle();
    return !error && (data as Record<string, boolean> | null)?.[column] === true;
  } catch {
    return false;
  }
}

export function executionEnabledInEnv(accountId: string, kind: ExecutionKind): boolean {
  return kind === "subflow" ? isSubflowExecutionEnabledForAccount(accountId) : isDurableWaitExecutionEnabledForAccount(accountId);
}

export async function executionAllowedForAccount(db: Db, accountId: string, kind: ExecutionKind): Promise<boolean> {
  return executionEnabledInEnv(accountId, kind) && (await executionEnabledInDb(db, accountId, kind));
}

/**
 * Accounts a scheduler pass may serve. A fixed list from the environment ("allowlist"), nothing ("off" / empty list: no database
 * call at all), or, with the "all" scope, the accounts the DATABASE has enabled (enabled_execution_account_ids).
 */
export async function schedulerAccountIds(getDb: () => Db, kinds: ExecutionKind[]): Promise<string[]> {
  const ids = new Set<string>();
  for (const kind of kinds) {
    const fromEnv = kind === "subflow" ? subflowExecutionAccountIds() : durableWaitExecutionAccountIds();
    if (fromEnv !== null) { fromEnv.forEach((id) => ids.add(id)); continue; }
    const { data, error } = await getDb().rpc!("enabled_execution_account_ids", { p_kind: kind });
    if (error) throw new Error(`enabled_execution_account_ids failed: ${error.message}`);
    ((data ?? []) as string[]).forEach((id) => ids.add(id));
  }
  return [...ids];
}
