/**
 * Where the P4-P8 Flows features are available, decided on the SERVER (never by the browser) with two global switches instead of
 * one UUID list per customer:
 *
 *   FLOW_AUTHORING_SCOPE  who may AUTHOR them in draft flows (run another flow, durable waits, "customer replied" condition,
 *                         inherited reference, call/return settings, End scope).
 *   FLOW_EXECUTION_SCOPE  who may RUN them (the environment half of the two keys; the database half is flow_execution_enablement,
 *                         migrations 070 / 071).
 *
 * Values: "all"       every account, including companies that sign up later (no list to maintain);
 *         "allowlist" only the account ids of the historic per-feature lists (FLOW_*_ACCOUNT_IDS). This is the DEFAULT, so deploying
 *                     the code changes nothing until an operator sets the switch;
 *         "off"       nobody, whatever the lists say (kill switch).
 * Anything else (a typo, "true", "*") is treated as "off": a misconfiguration can never open a feature by accident.
 *
 * Unrelated experimental switches (F04 custom-field conditions, ManyChat, F06) are NOT governed by these two.
 */
export const FLOW_AUTHORING_SCOPE_ENV = "FLOW_AUTHORING_SCOPE";
export const FLOW_EXECUTION_SCOPE_ENV = "FLOW_EXECUTION_SCOPE";
export type FlowScope = "all" | "allowlist" | "off";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readScope(envName: string): FlowScope {
  const raw = process.env[envName];
  if (raw === undefined || raw.trim() === "") return "allowlist";
  const value = raw.trim().toLowerCase();
  return value === "all" || value === "allowlist" || value === "off" ? value : "off";
}

export function listedAccountIds(listEnvName: string): string[] {
  return (process.env[listEnvName] ?? "").split(",").map((id) => id.trim()).filter((id) => UUID.test(id)).map((id) => id.toLowerCase());
}

function allowed(scopeEnv: string, listEnvName: string, accountId: string): boolean {
  if (typeof accountId !== "string" || accountId.length === 0) return false;
  const scope = readScope(scopeEnv);
  if (scope === "off") return false;
  if (scope === "all") return true;
  return listedAccountIds(listEnvName).includes(accountId.toLowerCase());
}

export const authoringAllowed = (listEnvName: string, accountId: string) => allowed(FLOW_AUTHORING_SCOPE_ENV, listEnvName, accountId);
export const executionAllowed = (listEnvName: string, accountId: string) => allowed(FLOW_EXECUTION_SCOPE_ENV, listEnvName, accountId);
