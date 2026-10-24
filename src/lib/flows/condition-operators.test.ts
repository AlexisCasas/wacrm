import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateConditionNode, evaluateConditionPredicate } from "./engine";
import { CUSTOM_CONDITION_ACCOUNT_IDS_ENV } from "./custom-condition-capability";
import { validateFlowForActivation } from "./validate";
import { inspectDowngradeCompatibility } from "./downgrade-compatibility";

type Op = Parameters<typeof evaluateConditionPredicate>[0]["operator"];
const p = (operator: Op, subjectValue: string | undefined, configValue?: string, caseSensitive?: boolean) =>
  evaluateConditionPredicate({ operator, subjectValue, configValue, caseSensitive });

describe("condition operators — pure predicate", () => {
  it("equals: unchanged legacy behaviour when case_sensitive is not configured", () => {
    expect(p("equals", "SAFARI", "SAFARI")).toBe(true);
    expect(p("equals", "safari", "SAFARI")).toBe(false);
    expect(p("equals", "", "")).toBe(true); // legacy quirk preserved
    expect(p("contains", "Prensa SAFARI", "SAFARI")).toBe(true);
    expect(p("contains", "Prensa safari", "SAFARI")).toBe(false);
  });

  it("case_sensitive=false ignores case for every text operator; true keeps it exact", () => {
    expect(p("equals", "safari", "SAFARI", false)).toBe(true);
    expect(p("equals", "safari", "SAFARI", true)).toBe(false);
    expect(p("not_equals", "safari", "SAFARI", false)).toBe(false);
    expect(p("not_equals", "safari", "SAFARI", true)).toBe(true);
    expect(p("contains", "Prensa safari", "SAFARI", false)).toBe(true);
    expect(p("not_contains", "Prensa safari", "SAFARI", false)).toBe(false);
    expect(p("starts_with", "safari 2", "SAFARI", false)).toBe(true);
    expect(p("starts_with", "safari 2", "SAFARI", true)).toBe(false);
  });

  it("negative operators and starts_with on a known value", () => {
    expect(p("not_equals", "OTRO", "SAFARI")).toBe(true);
    expect(p("not_equals", "SAFARI", "SAFARI")).toBe(false);
    expect(p("not_contains", "Prensa", "SAFARI")).toBe(true);
    expect(p("not_contains", "Prensa SAFARI", "SAFARI")).toBe(false);
    expect(p("starts_with", "SAFARI X", "SAFARI")).toBe(true);
    expect(p("starts_with", "X SAFARI", "SAFARI")).toBe(false);
  });

  it("an unknown (undefined or empty) subject is never 'different': every value operator answers false", () => {
    for (const subject of [undefined, ""]) {
      for (const op of ["not_equals", "not_contains", "starts_with"] as Op[]) expect(p(op, subject, "SAFARI")).toBe(false);
    }
    expect(p("equals", undefined, "SAFARI")).toBe(false);
    expect(p("contains", undefined, "SAFARI")).toBe(false);
    expect(p("absent", undefined)).toBe(true);
    expect(p("absent", "")).toBe(true);
    expect(p("present", undefined)).toBe(false);
    expect(p("present", "SAFARI")).toBe(true);
  });
});

describe("condition operators — custom field node (stored contact value)", () => {
  const accountId = "11111111-1111-4111-8111-111111111111";
  const otherAccountId = "99999999-9999-4999-8999-999999999999";
  const fieldId = "22222222-2222-4222-8222-222222222222";
  const previous = process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV];

  type Filters = Record<string, unknown>;
  /** Stateful fake: field definitions are per-account, values are per-contact, and every read records its filters. */
  function fakeDb(state: { fields: Array<{ id: string; account_id: string }>; values: Array<{ contact_id: string; custom_field_id: string; value: string | null }>; failValues?: boolean }) {
    const reads: Array<{ table: string; filters: Filters }> = [];
    const db = {
      from(table: string) {
        const filters: Filters = {};
        const query = {
          eq(column: string, value: unknown) { filters[column] = value; return query; },
          async maybeSingle() {
            reads.push({ table, filters: { ...filters } });
            if (table === "contacts") return { data: filters.account_id === accountId ? { id: filters.id } : null, error: null };
            if (table === "custom_fields") {
              const row = state.fields.find((f) => f.id === filters.id && f.account_id === filters.account_id);
              return { data: row ? { id: row.id } : null, error: null };
            }
            if (state.failValues) return { data: null, error: { message: "secret customer value leaked here" } };
            const row = state.values.find((v) => v.contact_id === filters.contact_id && v.custom_field_id === filters.custom_field_id);
            return { data: row ? { value: row.value } : null, error: null };
          },
        };
        return { select: () => query };
      },
    };
    return { db: db as never, reads };
  }

  const run = (account = accountId) => ({ account_id: account, contact_id: "contact-1", vars: {} } as never);
  const cfg = (operator: Op, value?: string, case_sensitive?: boolean, key = `custom:${fieldId}`) =>
    ({ subject: "contact_field", subject_key: key, operator, value, case_sensitive, true_next: "yes", false_next: "no" } as never);
  const base = () => ({ fields: [{ id: fieldId, account_id: accountId }], values: [] as Array<{ contact_id: string; custom_field_id: string; value: string | null }>, failValues: false });

  beforeEach(() => { process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = accountId; });
  afterEach(() => { if (previous === undefined) delete process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV]; else process.env[CUSTOM_CONDITION_ACCOUNT_IDS_ENV] = previous; });

  it("field with no stored value (unknown): equals/not_equals both false, absent true", async () => {
    const { db } = fakeDb(base());
    await expect(evaluateConditionNode(db, run(), cfg("equals", "SAFARI"))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), cfg("not_equals", "SAFARI"))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), cfg("absent"))).resolves.toBe(true);
  });

  it("empty or null stored value is unknown", async () => {
    for (const value of ["", null]) {
      const s = base(); s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value });
      const { db } = fakeDb(s);
      await expect(evaluateConditionNode(db, run(), cfg("not_equals", "SAFARI"))).resolves.toBe(false);
      await expect(evaluateConditionNode(db, run(), cfg("absent"))).resolves.toBe(true);
    }
  });

  it("expected value, other value, and case differences", async () => {
    const s = base(); s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "SAFARI" });
    const { db } = fakeDb(s);
    await expect(evaluateConditionNode(db, run(), cfg("equals", "SAFARI"))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), cfg("equals", "safari"))).resolves.toBe(false); // legacy: unset = sensitive
    await expect(evaluateConditionNode(db, run(), cfg("equals", "safari", true))).resolves.toBe(false);
    await expect(evaluateConditionNode(db, run(), cfg("equals", "safari", false))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), cfg("not_equals", "OTRO"))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), cfg("not_contains", "XYZ"))).resolves.toBe(true);
    await expect(evaluateConditionNode(db, run(), cfg("starts_with", "saf", false))).resolves.toBe(true);
  });

  it("only reads the field and value of the run's own account and contact", async () => {
    const s = base(); s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "SAFARI" });
    const { db, reads } = fakeDb(s);
    await evaluateConditionNode(db, run(), cfg("equals", "SAFARI"));
    expect(reads.find((r) => r.table === "custom_fields")?.filters).toMatchObject({ id: fieldId, account_id: accountId });
    expect(reads.find((r) => r.table === "contact_custom_values")?.filters).toMatchObject({ contact_id: "contact-1", custom_field_id: fieldId });
  });

  it("a field id that belongs to another account is rejected, not read", async () => {
    const s = base(); s.fields = [{ id: fieldId, account_id: otherAccountId }];
    s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "SAFARI" });
    const { db, reads } = fakeDb(s);
    await expect(evaluateConditionNode(db, run(), cfg("not_equals", "X"))).rejects.toThrow("custom_condition_field_not_in_account");
    expect(reads.some((r) => r.table === "contact_custom_values")).toBe(false);
  });

  it("a database read error fails the node with a code that carries no customer data", async () => {
    const s = base(); s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "Maria Perez 999" });
    s.failValues = true;
    const { db } = fakeDb(s);
    const error = await evaluateConditionNode(db, run(), cfg("not_equals", "SAFARI")).catch((e: Error) => e);
    expect((error as Error).message).toBe("custom_condition_value_lookup_failed");
    expect((error as Error).message).not.toMatch(/leaked|Maria|999/);
  });

  it("is a pure read: concurrent evaluations agree and do not write", async () => {
    const s = base(); s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "SAFARI" });
    const { db, reads } = fakeDb(s);
    const results = await Promise.all(Array.from({ length: 20 }, () => evaluateConditionNode(db, run(), cfg("equals", "SAFARI", false))));
    expect(new Set(results)).toEqual(new Set([true]));
    expect(reads.length).toBe(60); // 3 reads each, no mutation API even exposed by the fake
  });

  it("SAFARI journey: first request takes the normal route, registering the field makes the repeat skip the presentation", async () => {
    const s = base();
    const { db } = fakeDb(s);
    const route = async () => ((await evaluateConditionNode(db, run(), cfg("equals", "SAFARI", false))) ? "ya_presentado" : "presentacion_normal");
    expect(await route()).toBe("presentacion_normal");
    // set_contact_field upserts on UNIQUE(contact_id, custom_field_id): repeated writes keep one row.
    const upsert = () => {
      const row = s.values.find((v) => v.contact_id === "contact-1" && v.custom_field_id === fieldId);
      if (row) row.value = "SAFARI"; else s.values.push({ contact_id: "contact-1", custom_field_id: fieldId, value: "SAFARI" });
    };
    upsert(); upsert();
    expect(s.values).toHaveLength(1);
    expect(await route()).toBe("ya_presentado");
    expect(await route()).toBe("ya_presentado");
    // a different product or an unset value still takes the normal route
    s.values[0].value = "OTRO"; expect(await route()).toBe("presentacion_normal");
    s.values.length = 0; expect(await route()).toBe("presentacion_normal");
  });
});

describe("condition operators — validation and compatibility", () => {
  const flow = { name: "F", trigger_type: "keyword" as const, trigger_config: { keywords: ["safari"] }, entry_node_id: "start" };
  const nodesWith = (condition: Record<string, unknown>) => [
    { node_key: "start", node_type: "start", config: { next_node_key: "c" } },
    { node_key: "c", node_type: "condition", config: { subject: "var", subject_key: "x", true_next: "end", false_next: "end", ...condition } },
    { node_key: "end", node_type: "end", config: {} },
  ];

  it("accepts every new operator and the case option", () => {
    for (const operator of ["equals", "not_equals", "contains", "not_contains", "starts_with", "present", "absent"]) {
      const issues = validateFlowForActivation(flow, nodesWith({ operator, value: "SAFARI", case_sensitive: false }));
      expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    }
  });

  it("a flow saved before the option existed (no case_sensitive) still validates", () => {
    expect(validateFlowForActivation(flow, nodesWith({ operator: "equals", value: "x" })).filter((i) => i.severity === "error")).toEqual([]);
  });

  it("rejects unknown operators and a non-boolean case_sensitive; warns on an empty comparison value", () => {
    expect(validateFlowForActivation(flow, nodesWith({ operator: "regex", value: "x" })).some((i) => i.field === "operator" && i.severity === "error")).toBe(true);
    expect(validateFlowForActivation(flow, nodesWith({ operator: "equals", value: "x", case_sensitive: "no" })).some((i) => i.code === "condition_case_sensitive_invalid")).toBe(true);
    expect(validateFlowForActivation(flow, nodesWith({ operator: "not_equals", value: "" })).some((i) => i.field === "value" && i.severity === "warning")).toBe(true);
  });

  it("blocks a rollback while a flow uses the new operators on any subject", () => {
    const result = (config: Record<string, unknown>) => inspectDowngradeCompatibility({ flows: [{ id: "f", status: "active" }], nodes: [{ flow_id: "f", node_type: "condition", config }], runs: [] }).result;
    expect(result({ subject: "var", operator: "equals", value: "x" })).toBe("SAFE_TO_ROLLBACK");
    expect(result({ subject: "var", operator: "not_equals", value: "x" })).toBe("BLOCKED_BY_CUSTOM_CONDITIONS");
    expect(result({ subject: "var", operator: "equals", value: "x", case_sensitive: false })).toBe("BLOCKED_BY_CUSTOM_CONDITIONS");
  });
});
