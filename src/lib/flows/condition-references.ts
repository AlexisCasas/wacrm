import type { SupabaseClient } from "@supabase/supabase-js";
import { readConditionConfig } from "./condition-rules";

export const NATIVE_CONTACT_CONDITION_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
] as const;

export type ConditionReferenceIssue =
  | "invalid_reference"
  | "reference_unavailable"
  | "custom_condition_capability_disabled"
  | "invalid_condition_config"
  | "compound_condition_capability_disabled";

export class ConditionReferenceInfrastructureError extends Error {
  constructor() {
    super("Could not validate condition references");
    this.name = "ConditionReferenceInfrastructureError";
  }
}

type FlowNodeInput = {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
};

export function isCustomConditionKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("custom:");
}

function customFieldId(value: string): string | null {
  const id = value.slice("custom:".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

type ReferenceIssue = { node_key: string; issue: ConditionReferenceIssue; rule_index?: number };

/**
 * Validate persisted references using a caller-scoped client and account id. Walks EVERY rule of a compound node.
 * `compoundConditionsEnabled` defaults to false: a caller that forgets it cannot admit a compound node.
 */
export async function validateConditionReferences(
  db: SupabaseClient,
  accountId: string,
  nodes: FlowNodeInput[],
  customConditionsEnabled: boolean,
  compoundConditionsEnabled = false,
): Promise<ReferenceIssue[]> {
  const issues: ReferenceIssue[] = [];
  const tags = new Map<string, Array<{ node_key: string; rule_index?: number }>>();
  const fields = new Map<string, Array<{ node_key: string; rule_index?: number }>>();

  for (const node of nodes) {
    if (node.node_type !== "condition") continue;
    const read = readConditionConfig(node.config);
    if (read.kind === "invalid") {
      issues.push({ node_key: node.node_key, issue: "invalid_condition_config" });
      continue;
    }
    if (read.kind === "compound" && !compoundConditionsEnabled) {
      issues.push({ node_key: node.node_key, issue: "compound_condition_capability_disabled" });
      continue;
    }
    const rules = read.kind === "legacy" ? [read.rule] : read.rules;
    rules.forEach((rule, index) => {
      const where = read.kind === "compound" ? { node_key: node.node_key, rule_index: index } : { node_key: node.node_key };
      const subject = rule.subject;
      const key = rule.subject_key;
      if (subject === "tag") {
        if (typeof key !== "string" || !key) issues.push({ ...where, issue: "invalid_reference" });
        else tags.set(key, [...(tags.get(key) ?? []), where]);
      }
      if (subject !== "contact_field") return;
      if (typeof key !== "string") {
        issues.push({ ...where, issue: "invalid_reference" });
      } else if (isCustomConditionKey(key)) {
        const id = customFieldId(key);
        if (!id) issues.push({ ...where, issue: "invalid_reference" });
        else if (!customConditionsEnabled) issues.push({ ...where, issue: "custom_condition_capability_disabled" });
        else fields.set(id, [...(fields.get(id) ?? []), where]);
      } else if (!(NATIVE_CONTACT_CONDITION_FIELDS as readonly string[]).includes(key)) {
        issues.push({ ...where, issue: "invalid_reference" });
      }
    });
  }

  for (const [table, wanted] of [["tags", tags], ["custom_fields", fields]] as const) {
    if (!wanted.size) continue;
    const { data, error } = await db.from(table).select("id").eq("account_id", accountId).in("id", [...wanted.keys()]);
    if (error) throw new ConditionReferenceInfrastructureError();
    const found = new Set((data ?? []).map((row) => row.id));
    for (const [id, places] of wanted) if (!found.has(id)) for (const place of places) issues.push({ ...place, issue: "reference_unavailable" });
  }
  return issues;
}
