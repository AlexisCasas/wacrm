/**
 * One reading of a `condition` node's configuration, for the old and the new shape alike.
 *
 *   legacy   { subject, subject_key, operator, value?, case_sensitive?, true_next, false_next }      one rule at the top level
 *   compound { match_mode: "all" | "any", conditions: ConditionRule[], true_next, false_next }        1..10 rules
 *
 * Nothing migrates stored flows: a legacy node stays legacy until the editor is asked to add a second rule. A node that
 * mixes both shapes is rejected instead of guessed at, so two readers can never disagree about its result.
 *
 * `customer_activity` ("did the customer reply after message X") stays a legacy, stand-alone condition: it arms the
 * reply guard on its false branch and its reference is read from the top level by the send tracking, so combining it
 * would change what those mean.
 */
import type { ConditionRule } from "./types";

export const MAX_CONDITION_RULES = 10;
export type MatchMode = "all" | "any";

export const RULE_KEYS = ["subject", "subject_key", "operator", "value", "case_sensitive"] as const;
export const COMBINABLE_SUBJECTS = ["var", "tag", "contact_field"] as const;

export type ConditionReadError =
  | "ambiguous_mixed_shapes"
  | "match_mode_without_conditions"
  | "conditions_not_array"
  | "conditions_empty"
  | "conditions_too_many"
  | "match_mode_invalid"
  | "rule_not_object"
  | "rule_not_combinable";

export type ReadConditions =
  | { kind: "legacy"; rule: ConditionRule }
  | { kind: "compound"; mode: MatchMode; rules: ConditionRule[] }
  | { kind: "invalid"; error: ConditionReadError };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Does this stored config use the compound shape (or try to)? */
export function hasConditionsField(config: unknown): boolean {
  return isObject(config) && config.conditions !== undefined;
}

export function readConditionConfig(config: unknown): ReadConditions {
  const cfg = isObject(config) ? config : {};
  if (cfg.conditions === undefined) {
    if (cfg.match_mode !== undefined) return { kind: "invalid", error: "match_mode_without_conditions" };
    return { kind: "legacy", rule: Object.fromEntries(RULE_KEYS.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]])) as unknown as ConditionRule };
  }
  if (RULE_KEYS.some((k) => cfg[k] !== undefined)) return { kind: "invalid", error: "ambiguous_mixed_shapes" };
  if (!Array.isArray(cfg.conditions)) return { kind: "invalid", error: "conditions_not_array" };
  if (cfg.conditions.length === 0) return { kind: "invalid", error: "conditions_empty" };
  if (cfg.conditions.length > MAX_CONDITION_RULES) return { kind: "invalid", error: "conditions_too_many" };
  if (cfg.match_mode !== "all" && cfg.match_mode !== "any") return { kind: "invalid", error: "match_mode_invalid" };
  for (const rule of cfg.conditions) {
    if (!isObject(rule)) return { kind: "invalid", error: "rule_not_object" };
    if (!(COMBINABLE_SUBJECTS as readonly unknown[]).includes(rule.subject)) return { kind: "invalid", error: "rule_not_combinable" };
  }
  return { kind: "compound", mode: cfg.match_mode, rules: cfg.conditions as ConditionRule[] };
}

/**
 * Editor helper: the config patch that turns a legacy node into a compound one WITHOUT losing the rule it already had
 * (every rule key is carried over, then removed from the top level so the shapes never mix).
 */
export function toCompoundPatch(config: unknown, extraRule: ConditionRule, mode: MatchMode = "all"): Record<string, unknown> {
  const read = readConditionConfig(config);
  if (read.kind === "compound") return { match_mode: read.mode, conditions: [...read.rules, extraRule] };
  const existing = read.kind === "legacy" ? read.rule : null;
  const cleared = Object.fromEntries(RULE_KEYS.map((k) => [k, undefined]));
  return { ...cleared, match_mode: mode, conditions: [...(existing && Object.keys(existing).length ? [existing] : []), extraRule] };
}
