import type { SupabaseClient } from "@supabase/supabase-js";

export const NATIVE_CONTACT_CONDITION_FIELDS = [
  "name",
  "email",
  "phone",
  "company",
] as const;

export type ConditionReferenceIssue =
  | "invalid_reference"
  | "reference_unavailable"
  | "custom_condition_capability_disabled";

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

/** Validate persisted references using a caller-scoped client and account id. */
export async function validateConditionReferences(
  db: SupabaseClient,
  accountId: string,
  nodes: FlowNodeInput[],
  customConditionsEnabled: boolean,
): Promise<Array<{ node_key: string; issue: ConditionReferenceIssue }>> {
  const issues: Array<{ node_key: string; issue: ConditionReferenceIssue }> = [];
  const tags = new Set<string>();
  const fields = new Map<string, string>();

  for (const node of nodes) {
    if (node.node_type !== "condition") continue;
    const subject = node.config.subject;
    const key = node.config.subject_key;
    if (subject === "tag") {
      if (typeof key !== "string" || !key) issues.push({ node_key: node.node_key, issue: "invalid_reference" });
      else tags.add(key);
    }
    if (subject !== "contact_field") continue;
    if (typeof key !== "string") {
      issues.push({ node_key: node.node_key, issue: "invalid_reference" });
    } else if (isCustomConditionKey(key)) {
      const id = customFieldId(key);
      if (!id) issues.push({ node_key: node.node_key, issue: "invalid_reference" });
      else if (!customConditionsEnabled) issues.push({ node_key: node.node_key, issue: "custom_condition_capability_disabled" });
      else fields.set(id, node.node_key);
    } else if (!(NATIVE_CONTACT_CONDITION_FIELDS as readonly string[]).includes(key)) {
      issues.push({ node_key: node.node_key, issue: "invalid_reference" });
    }
  }

  if (tags.size) {
    const { data, error } = await db.from("tags").select("id").eq("account_id", accountId).in("id", [...tags]);
    if (error) throw new ConditionReferenceInfrastructureError();
    const found = new Set((data ?? []).map((row) => row.id));
    for (const node of nodes) {
      if (node.node_type === "condition" && node.config.subject === "tag" && typeof node.config.subject_key === "string" && !found.has(node.config.subject_key)) {
        issues.push({ node_key: node.node_key, issue: "reference_unavailable" });
      }
    }
  }
  if (fields.size) {
    const { data, error } = await db.from("custom_fields").select("id").eq("account_id", accountId).in("id", [...fields.keys()]);
    if (error) throw new ConditionReferenceInfrastructureError();
    const found = new Set((data ?? []).map((row) => row.id));
    for (const [id, node_key] of fields) if (!found.has(id)) issues.push({ node_key, issue: "reference_unavailable" });
  }
  return issues;
}
