import { describe, expect, it } from "vitest";
import { ConditionReferenceInfrastructureError, validateConditionReferences } from "./condition-references";

const account = "11111111-1111-4111-8111-111111111111";
const field = "22222222-2222-4222-8222-222222222222";

function db(results: Record<string, { data: unknown[] | null; error: unknown }>) {
  return {
    from(table: string) {
      const result = results[table] ?? { data: [], error: null };
      const query = { eq: () => query, in: () => Promise.resolve(result) };
      return { select: () => query };
    },
  } as never;
}

describe("validateConditionReferences", () => {
  it("accepts native fields without a database lookup", async () => {
    await expect(validateConditionReferences(db({}), account, [{ node_key: "n", node_type: "condition", config: { subject: "contact_field", subject_key: "email" } }], false)).resolves.toEqual([]);
  });

  it("accepts account-scoped tag and custom-field references", async () => {
    await expect(validateConditionReferences(db({ tags: { data: [{ id: "tag-1" }], error: null }, custom_fields: { data: [{ id: field }], error: null } }), account, [
      { node_key: "tag", node_type: "condition", config: { subject: "tag", subject_key: "tag-1" } },
      { node_key: "field", node_type: "condition", config: { subject: "contact_field", subject_key: `custom:${field}` } },
    ], true)).resolves.toEqual([]);
  });

  it("rejects custom fields while the server capability is disabled", async () => {
    await expect(validateConditionReferences(db({}), account, [{ node_key: "field", node_type: "condition", config: { subject: "contact_field", subject_key: `custom:${field}` } }], false)).resolves.toEqual([{ node_key: "field", issue: "custom_condition_capability_disabled" }]);
  });

  it("rejects malformed, missing, and cross-account references without exposing them", async () => {
    const issues = await validateConditionReferences(db({ tags: { data: [], error: null }, custom_fields: { data: [], error: null } }), account, [
      { node_key: "bad-native", node_type: "condition", config: { subject: "contact_field", subject_key: "address" } },
      { node_key: "bad-custom", node_type: "condition", config: { subject: "contact_field", subject_key: "custom:not-a-uuid" } },
      { node_key: "foreign-tag", node_type: "condition", config: { subject: "tag", subject_key: "foreign" } },
      { node_key: "foreign-field", node_type: "condition", config: { subject: "contact_field", subject_key: `custom:${field}` } },
    ], true);
    expect(issues.map((issue) => issue.issue)).toEqual(["invalid_reference", "invalid_reference", "reference_unavailable", "reference_unavailable"]);
  });

  it("fails closed when a reference query has an infrastructure error", async () => {
    await expect(validateConditionReferences(db({ tags: { data: null, error: { message: "unavailable" } } }), account, [{ node_key: "tag", node_type: "condition", config: { subject: "tag", subject_key: "tag-1" } }], true)).rejects.toBeInstanceOf(ConditionReferenceInfrastructureError);
  });
});
