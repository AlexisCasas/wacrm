import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateConditionNode } from "./engine";
import { CUSTOM_CONDITION_ACCOUNT_IDS_ENV } from "./custom-condition-capability";
import { COMPOUND_CONDITION_ACCOUNT_IDS_ENV, isCompoundConditionEnabledForAccount } from "./compound-condition-capability";
import { MAX_CONDITION_RULES, readConditionConfig, toCompoundPatch } from "./condition-rules";
import { validateConditionReferences } from "./condition-references";
import { validateFlowForActivation } from "./validate";
import { inspectDowngradeCompatibility } from "./downgrade-compatibility";
import { summarizeNode } from "@/components/flows/shared";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const FIELD = "22222222-2222-4222-8222-222222222222";
const FOREIGN_FIELD = "33333333-3333-4333-8333-333333333333";
const TAG = "44444444-4444-4444-8444-444444444444";
const FOREIGN_TAG = "55555555-5555-4555-8555-555555555555";

type Rule = Record<string, unknown>;
interface State {
  contact: { id: string; name: string | null; email: string | null; phone: string | null; company: string | null };
  fields: Array<{ id: string; account_id: string }>;
  values: Array<{ custom_field_id: string; value: string | null }>;
  tags: Array<{ id: string; account_id: string }>;
  contactTags: string[];
  failTable?: string;
}
const fresh = (): State => ({
  contact: { id: "contact-1", name: "Ana", email: null, phone: "+51900", company: null },
  fields: [{ id: FIELD, account_id: ACCOUNT }, { id: FOREIGN_FIELD, account_id: OTHER }],
  values: [], tags: [{ id: TAG, account_id: ACCOUNT }, { id: FOREIGN_TAG, account_id: OTHER }], contactTags: [],
});

/** Fake service client. Counts reads per table and enforces the account filters the way the real query would. */
function fakeDb(state: State) {
  const reads: string[] = [];
  const db = {
    from(table: string) {
      const f: Record<string, unknown> = {};
      const resolve = () => {
        reads.push(table);
        if (state.failTable === table) return { data: null, count: null, error: { message: "boom with customer data Maria 999" } };
        if (table === "contacts") return { data: f.account_id === ACCOUNT ? state.contact : null, error: null };
        if (table === "custom_fields") { const r = state.fields.find((x) => x.id === f.id && x.account_id === f.account_id); return { data: r ? { id: r.id } : null, error: null }; }
        if (table === "tags") { const r = state.tags.find((x) => x.id === f.id && x.account_id === f.account_id); return { data: r ? { id: r.id } : null, error: null }; }
        if (table === "contact_custom_values") { const r = state.values.find((x) => x.custom_field_id === f.custom_field_id); return { data: r ? { value: r.value } : null, error: null }; }
        if (table === "contact_tags") return { count: state.contactTags.includes(String(f.tag_id)) ? 1 : 0, error: null };
        return { data: null, error: null };
      };
      const q: Record<string, unknown> = {
        eq(c: string, v: unknown) { f[c] = v; return q; },
        maybeSingle: async () => resolve(),
        then: (ok: (v: unknown) => unknown) => Promise.resolve(resolve()).then(ok),
      };
      return { select: () => q };
    },
  };
  return { db: db as never, reads };
}

const run = (vars: Record<string, unknown> = {}, account = ACCOUNT) => ({ account_id: account, contact_id: "contact-1", vars }) as never;
const node = (mode: "all" | "any", conditions: Rule[]) => ({ match_mode: mode, conditions, true_next: "yes", false_next: "no" }) as never;
const producto = (value: string, extra: Rule = {}) => ({ subject: "contact_field", subject_key: `custom:${FIELD}`, operator: "equals", value, ...extra });
const hasTag = { subject: "tag", subject_key: TAG, operator: "present" };

const prevCustom = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV];
const prevCompound = process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV];
beforeEach(() => { process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = ACCOUNT; process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV] = ACCOUNT; });
afterEach(() => {
  for (const [k, v] of [[CUSTOM_CONDITION_ACCOUNT_IDS_ENV, prevCustom], [COMPOUND_CONDITION_ACCOUNT_IDS_ENV, prevCompound]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("compound condition — configuration reader", () => {
  it("reads a legacy node exactly as one rule, keeping every key", () => {
    const legacy = { subject: "var", subject_key: "x", operator: "contains", value: "a", case_sensitive: false, true_next: "t", false_next: "f" };
    expect(readConditionConfig(legacy)).toEqual({ kind: "legacy", rule: { subject: "var", subject_key: "x", operator: "contains", value: "a", case_sensitive: false } });
  });
  it("reads a compound node", () => {
    const r = readConditionConfig({ match_mode: "any", conditions: [hasTag], true_next: "t", false_next: "f" });
    expect(r).toEqual({ kind: "compound", mode: "any", rules: [hasTag] });
  });
  it("rejects ambiguous and malformed shapes instead of guessing", () => {
    const err = (c: unknown) => (readConditionConfig(c) as { error?: string }).error;
    expect(err({ subject: "var", subject_key: "x", operator: "present", match_mode: "all", conditions: [hasTag] })).toBe("ambiguous_mixed_shapes");
    expect(err({ operator: "present", conditions: [hasTag], match_mode: "all" })).toBe("ambiguous_mixed_shapes");
    expect(err({ match_mode: "all" })).toBe("match_mode_without_conditions");
    expect(err({ match_mode: "all", conditions: "x" })).toBe("conditions_not_array");
    expect(err({ match_mode: "all", conditions: [] })).toBe("conditions_empty");
    expect(err({ match_mode: "all", conditions: Array.from({ length: MAX_CONDITION_RULES + 1 }, () => hasTag) })).toBe("conditions_too_many");
    expect(err({ conditions: [hasTag] })).toBe("match_mode_invalid");
    expect(err({ match_mode: "xor", conditions: [hasTag] })).toBe("match_mode_invalid");
    expect(err({ match_mode: "all", conditions: [null] })).toBe("rule_not_object");
    expect(err({ match_mode: "all", conditions: [{ subject: "customer_activity", subject_key: "m", operator: "replied_after_reference" }] })).toBe("rule_not_combinable");
    expect(readConditionConfig({ match_mode: "all", conditions: Array.from({ length: MAX_CONDITION_RULES }, () => hasTag) }).kind).toBe("compound");
  });
  it("converting a legacy node keeps its rule and clears the top-level keys (no mixed shape)", () => {
    const legacy = { subject: "contact_field", subject_key: `custom:${FIELD}`, operator: "equals", value: "SAFARI", case_sensitive: false, true_next: "t", false_next: "f" };
    const merged = { ...legacy, ...toCompoundPatch(legacy, hasTag as never) };
    const stored = JSON.parse(JSON.stringify(merged));
    expect(stored.conditions[0]).toEqual({ subject: "contact_field", subject_key: `custom:${FIELD}`, operator: "equals", value: "SAFARI", case_sensitive: false });
    expect(stored.conditions).toHaveLength(2);
    expect(stored).toMatchObject({ match_mode: "all", true_next: "t", false_next: "f" });
    for (const k of ["subject", "subject_key", "operator", "value", "case_sensitive"]) expect(k in stored).toBe(false);
    expect(readConditionConfig(stored).kind).toBe("compound");
  });
});

describe("compound condition — evaluation", () => {
  it("legacy node: unchanged result", async () => {
    const s = fresh(); s.values.push({ custom_field_id: FIELD, value: "SAFARI" });
    const { db } = fakeDb(s);
    await expect(evaluateConditionNode(db, run(), { ...producto("SAFARI"), true_next: "y", false_next: "n" } as never)).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), { ...producto("OTRO"), true_next: "y", false_next: "n" } as never)).resolves.toBe(false);
  });

  it("two rules: AND vs OR across both-true, one-true, both-false", async () => {
    const cases: Array<[boolean, boolean]> = [[true, true], [true, false], [false, true], [false, false]];
    for (const [a, b] of cases) {
      const s = fresh(); if (a) s.values.push({ custom_field_id: FIELD, value: "SAFARI" }); if (b) s.contactTags.push(TAG);
      const { db } = fakeDb(s);
      await expect(evaluateConditionNode(db, run(), node("all", [producto("SAFARI"), hasTag]))).resolves.toBe(a && b);
      await expect(evaluateConditionNode(db, run(), node("any", [producto("SAFARI"), hasTag]))).resolves.toBe(a || b);
    }
  });

  it("three or more rules mixing var, tag, native and custom subjects", async () => {
    const s = fresh(); s.values.push({ custom_field_id: FIELD, value: "Prensa SAFARI" }); s.contactTags.push(TAG);
    const { db } = fakeDb(s);
    const rules = [
      { subject: "var", subject_key: "intent", operator: "equals", value: "buy" },
      { subject: "contact_field", subject_key: "name", operator: "starts_with", value: "an", case_sensitive: false },
      producto("safari", { operator: "contains", case_sensitive: false }),
      hasTag,
    ];
    await expect(evaluateConditionNode(db, run({ intent: "buy" }), node("all", rules))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run({ intent: "browse" }), node("all", rules))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run({ intent: "browse" }), node("any", rules))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run({ intent: "browse" }), node("any", [rules[0], { ...rules[1], value: "zz" }]))).resolves.toBe(false);
  });

  it("negative operators and unknown values: unknown never counts as 'different'", async () => {
    const { db } = fakeDb(fresh()); // Producto unset, no tag
    await expect(evaluateConditionNode(db, run(), node("any", [producto("SAFARI", { operator: "not_equals" })]))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), node("all", [producto("SAFARI", { operator: "not_equals" }), { ...hasTag, operator: "absent" }]))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), node("all", [producto("x", { operator: "absent" }), { ...hasTag, operator: "absent" }]))).resolves.toBe(true);
    const s = fresh(); s.values.push({ custom_field_id: FIELD, value: "OTRO" });
    await expect(evaluateConditionNode(fakeDb(s).db, run(), node("all", [producto("SAFARI", { operator: "not_equals" })]))).resolves.toBe(true);
  });

  it("case sensitivity is per rule", async () => {
    const s = fresh(); s.values.push({ custom_field_id: FIELD, value: "SAFARI" });
    const { db } = fakeDb(s);
    await expect(evaluateConditionNode(db, run(), node("all", [producto("safari", { case_sensitive: false })]))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), node("all", [producto("safari", { case_sensitive: true })]))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), node("all", [producto("safari", { case_sensitive: false }), producto("safari")]))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), node("any", [producto("safari"), producto("safari", { case_sensitive: false })]))).resolves.toBe(true);
  });

  it("short-circuits: stops reading once the answer is decided", async () => {
    const s = fresh(); s.contactTags.push(TAG);
    const any = fakeDb(s); // first rule true -> second never read
    await expect(evaluateConditionNode(any.db, run(), node("any", [hasTag, producto("x")]))).resolves.toBe(true);
    expect(any.reads).not.toContain("custom_fields");
    const s2 = fresh(); // first rule false -> second never read
    const all = fakeDb(s2);
    await expect(evaluateConditionNode(all.db, run(), node("all", [hasTag, producto("x")]))).resolves.toBe(false);
    expect(all.reads).not.toContain("custom_fields");
  });

  it("a rule that cannot be evaluated throws; it is never silently false (also under OR with a true rule after it)", async () => {
    const s = fresh(); s.contactTags.push(TAG); s.failTable = "contact_custom_values";
    const { db } = fakeDb(s);
    const error = await evaluateConditionNode(db, run(), node("any", [producto("SAFARI"), hasTag])).catch((e: Error) => e);
    expect((error as Error).message).toBe("custom_condition_value_lookup_failed");
    expect((error as Error).message).not.toMatch(/Maria|999|boom/);
    const s2 = fresh(); s2.failTable = "contact_tags";
    await expect(evaluateConditionNode(fakeDb(s2).db, run(), node("all", [hasTag]))).rejects.toThrow("condition_tag_lookup_failed");
  });

  it("references of another account are rejected, not read", async () => {
    const s = fresh(); s.values.push({ custom_field_id: FOREIGN_FIELD, value: "SAFARI" });
    await expect(evaluateConditionNode(fakeDb(s).db, run(), node("any", [{ ...producto("SAFARI"), subject_key: `custom:${FOREIGN_FIELD}` }]))).rejects.toThrow("custom_condition_field_not_in_account");
    await expect(evaluateConditionNode(fakeDb(fresh()).db, run(), node("any", [{ subject: "tag", subject_key: FOREIGN_TAG, operator: "present" }]))).rejects.toThrow("condition_tag_not_in_account");
    await expect(evaluateConditionNode(fakeDb(fresh()).db, run({}, OTHER), node("any", [hasTag]))).rejects.toThrow(/compound_condition_capability_disabled/);
  });

  it("fails closed when the compound capability is off or the shape is ambiguous / unknown", async () => {
    const { db } = fakeDb(fresh());
    delete process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV];
    await expect(evaluateConditionNode(db, run(), node("all", [hasTag]))).rejects.toThrow("compound_condition_capability_disabled");
    process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV] = ACCOUNT;
    await expect(evaluateConditionNode(db, run(), { ...hasTag, match_mode: "all", conditions: [hasTag], true_next: "y", false_next: "n" } as never)).rejects.toThrow("condition_config_ambiguous_mixed_shapes");
    await expect(evaluateConditionNode(db, run(), node("all", []))).rejects.toThrow("condition_config_conditions_empty");
    await expect(evaluateConditionNode(db, run(), node("all", [{ subject: "customer_activity", subject_key: "m", operator: "replied_after_reference" }]))).rejects.toThrow("condition_config_rule_not_combinable");
  });

  it("a legacy node does not need the compound capability", async () => {
    delete process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV];
    const s = fresh(); s.contactTags.push(TAG);
    await expect(evaluateConditionNode(fakeDb(s).db, run(), { ...hasTag, true_next: "y", false_next: "n" } as never)).resolves.toBe(true);
  });

  it("only exact account ids enable the capability (no other module's variable is read)", () => {
    process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV] = `${ACCOUNT}, not-a-uuid`;
    expect(isCompoundConditionEnabledForAccount(ACCOUNT)).toBe(true);
    expect(isCompoundConditionEnabledForAccount(OTHER)).toBe(false);
    delete process.env[COMPOUND_CONDITION_ACCOUNT_IDS_ENV];
    expect(isCompoundConditionEnabledForAccount(ACCOUNT)).toBe(false);
  });

  it("repeating the same journey gives the same routes (pure read)", async () => {
    const s = fresh(); const { db } = fakeDb(s);
    const route = async () => ((await evaluateConditionNode(db, run(), node("any", [producto("safari", { case_sensitive: false }), hasTag]))) ? "omitir" : "presentar");
    expect(await route()).toBe("presentar");
    s.values.push({ custom_field_id: FIELD, value: "SAFARI" });
    expect(await route()).toBe("omitir"); expect(await route()).toBe("omitir");
  });
});

describe("compound condition — save / activate validation", () => {
  const flow = { name: "F", trigger_type: "keyword" as const, trigger_config: { keywords: ["safari"] }, entry_node_id: "start" };
  const nodesWith = (config: Record<string, unknown>) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "c" } },
    { node_key: "c", node_type: "condition", config: { true_next: "end", false_next: "end", ...config } },
    { node_key: "end", node_type: "end", config: {} },
  ];
  const errors = (config: Record<string, unknown>) => validateFlowForActivation(flow, nodesWith(config)).filter((i) => i.severity === "error");

  it("accepts a valid compound node and every legacy node", () => {
    expect(errors({ match_mode: "any", conditions: [producto("SAFARI"), hasTag] })).toEqual([]);
    expect(errors({ subject: "var", subject_key: "x", operator: "equals", value: "1" })).toEqual([]);
  });
  it("rejects empty, oversized, mixed, bad mode, bad operator and bad case option", () => {
    expect(errors({ match_mode: "all", conditions: [] }).map((i) => i.code)).toContain("condition_conditions_empty");
    expect(errors({ match_mode: "all", conditions: Array.from({ length: 11 }, () => hasTag) }).map((i) => i.code)).toContain("condition_conditions_too_many");
    expect(errors({ match_mode: "all", conditions: [hasTag], subject: "var" }).map((i) => i.code)).toContain("condition_ambiguous_mixed_shapes");
    expect(errors({ match_mode: "nope", conditions: [hasTag] }).map((i) => i.code)).toContain("condition_match_mode_invalid");
    expect(errors({ match_mode: "all", conditions: [hasTag, { ...hasTag, operator: "regex" }] }).find((i) => i.field === "conditions[1].operator")).toBeTruthy();
    expect(errors({ match_mode: "all", conditions: [{ ...hasTag, case_sensitive: "yes" }] }).map((i) => i.code)).toContain("condition_case_sensitive_invalid");
    expect(errors({ match_mode: "all", conditions: [{ ...hasTag, subject_key: "" }] }).map((i) => i.code)).toContain("condition_rule_subject_key");
  });
  it("customer_activity cannot be combined, and the legacy customer_activity node is untouched", () => {
    expect(errors({ match_mode: "all", conditions: [{ subject: "customer_activity", subject_key: "c", operator: "replied_after_reference" }] }).map((i) => i.code)).toContain("condition_rule_not_combinable");
    expect(errors({ subject: "customer_activity", subject_key: "", operator: "replied_after_reference" }).map((i) => i.code)).toContain("customer_activity_reference_missing");
  });
  it("still requires both exits", () => {
    const issues = validateFlowForActivation(flow, [
      { node_key: "start", node_type: "start", config: { next_node_key: "c" } },
      { node_key: "c", node_type: "condition", config: { match_mode: "all", conditions: [hasTag], true_next: "", false_next: "" } },
    ]);
    expect(issues.filter((i) => i.severity === "error" && (i.field === "true_next" || i.field === "false_next"))).toHaveLength(2);
  });
});

describe("compound condition — reference validation (every rule, account scoped)", () => {
  /** Returns only the rows of the caller's account, like the real filtered query. */
  function refDb(opts: { tags?: string[]; fields?: string[]; fail?: string }) {
    const seen: Array<{ table: string; account: unknown }> = [];
    return {
      db: { from: (table: string) => ({ select: () => ({ eq: (_c: string, account: unknown) => ({ in: async (_k: string, ids: string[]) => {
        seen.push({ table, account });
        if (opts.fail === table) return { data: null, error: { message: "x" } };
        const own = table === "tags" ? opts.tags : opts.fields;
        return { data: ids.filter((id) => (own ?? []).includes(id)).map((id) => ({ id })), error: null };
      } }) }) }) } as never,
      seen,
    };
  }
  const cond = (key: string, config: Rule) => [{ node_key: key, node_type: "condition", config }];

  it("flags a foreign tag or field on the exact rule index", async () => {
    const { db, seen } = refDb({ tags: [TAG], fields: [FIELD] });
    const issues = await validateConditionReferences(db, ACCOUNT, cond("c", { match_mode: "any", conditions: [hasTag, { subject: "tag", subject_key: FOREIGN_TAG, operator: "present" }, producto("x", { subject_key: `custom:${FOREIGN_FIELD}` })] }), true, true);
    expect(issues).toEqual([{ node_key: "c", rule_index: 1, issue: "reference_unavailable" }, { node_key: "c", rule_index: 2, issue: "reference_unavailable" }]);
    expect(seen.every((q) => q.account === ACCOUNT)).toBe(true);
  });
  it("accepts own references; native and var rules need no lookup", async () => {
    const { db, seen } = refDb({ tags: [TAG], fields: [FIELD] });
    expect(await validateConditionReferences(db, ACCOUNT, cond("c", { match_mode: "all", conditions: [hasTag, producto("x"), { subject: "contact_field", subject_key: "email", operator: "present" }, { subject: "var", subject_key: "v", operator: "present" }] }), true, true)).toEqual([]);
    expect(seen.map((q) => q.table).sort()).toEqual(["custom_fields", "tags"]);
  });
  it("blocks compound nodes without the compound capability and custom rules without the custom one", async () => {
    const { db } = refDb({ tags: [TAG], fields: [FIELD] });
    expect(await validateConditionReferences(db, ACCOUNT, cond("c", { match_mode: "all", conditions: [hasTag] }), true, false)).toEqual([{ node_key: "c", issue: "compound_condition_capability_disabled" }]);
    expect(await validateConditionReferences(db, ACCOUNT, cond("c", { match_mode: "all", conditions: [producto("x")] }), false, true)).toEqual([{ node_key: "c", rule_index: 0, issue: "custom_condition_capability_disabled" }]);
  });
  it("reports invalid shapes and surfaces infrastructure errors instead of passing", async () => {
    expect(await validateConditionReferences(refDb({}).db, ACCOUNT, cond("c", { match_mode: "all", conditions: [] }), true, true)).toEqual([{ node_key: "c", issue: "invalid_condition_config" }]);
    await expect(validateConditionReferences(refDb({ fail: "tags" }).db, ACCOUNT, cond("c", { match_mode: "all", conditions: [hasTag] }), true, true)).rejects.toThrow("Could not validate condition references");
  });
  it("legacy nodes validate exactly as before (default: compound off)", async () => {
    const { db } = refDb({ tags: [TAG] });
    expect(await validateConditionReferences(db, ACCOUNT, cond("c", { ...hasTag }), false)).toEqual([]);
    expect(await validateConditionReferences(db, ACCOUNT, cond("c", { subject: "tag", subject_key: FOREIGN_TAG, operator: "present" }), false)).toEqual([{ node_key: "c", issue: "reference_unavailable" }]);
  });
});

describe("compound condition — rollback guard and canvas summary", () => {
  it("a stored compound node blocks a rollback to an older build", () => {
    const result = (config: Rule) => inspectDowngradeCompatibility({ flows: [{ id: "f", status: "draft" }], nodes: [{ flow_id: "f", node_type: "condition", config }], runs: [] }).result;
    expect(result({ subject: "var", subject_key: "x", operator: "equals", value: "1" })).toBe("SAFE_TO_ROLLBACK");
    expect(result({ match_mode: "any", conditions: [hasTag] })).toBe("BLOCKED_BY_CUSTOM_CONDITIONS");
  });
  it("summary shows the mode and readable names; legacy summary is unchanged", () => {
    const names = new Map([[TAG, "SAFARI enviada"], [`custom:${FIELD}`, "Producto"]]);
    const compound = summarizeNode({ node_key: "c", node_type: "condition", config: { match_mode: "any", conditions: [producto("SAFARI"), hasTag] } } as never, undefined, names);
    expect(compound).toBe('Any of: field.Producto == "SAFARI" · has tag SAFARI enviada');
    expect(summarizeNode({ node_key: "c", node_type: "condition", config: { match_mode: "all", conditions: [hasTag] } } as never, undefined, names)).toMatch(/^All of: /);
    expect(summarizeNode({ node_key: "c", node_type: "condition", config: { subject: "var", subject_key: "x", operator: "equals", value: "1" } } as never)).toBe('var.x == "1"');
  });
});
