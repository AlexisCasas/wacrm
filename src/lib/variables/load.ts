import {
  hasPlaceholders,
  renderWithData,
  templateNeeds,
  type ContactData,
  type CustomFieldDef,
  type RenderOptions,
  type RenderResult,
  type VariableData,
} from "./template";

/**
 * Loads the data a template needs and renders it. Works with either the service-role client (engines) or a user-scoped client (preview
 * route): EVERY query is filtered by `accountId`, so a wrong contact id can never reach another account's data even under service_role.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any };

export interface RenderScope {
  accountId: string;
  contactId: string | null;
  /** Flow variables (`flow_runs.vars`). */
  vars?: Record<string, unknown>;
  /** Extra read-only namespaces, e.g. { "message.text": "..." } for automations. */
  extra?: Record<string, string | null | undefined>;
}

export async function loadVariableData(db: Db, scope: RenderScope, needs: { contact: boolean; custom: boolean }): Promise<VariableData> {
  let contact: ContactData | null = null;
  let fields: CustomFieldDef[] = [];
  const customValues: Record<string, string | null> = {};

  if (scope.contactId && needs.contact) {
    const { data } = await db
      .from("contacts")
      .select("name, email, company, phone")
      .eq("id", scope.contactId)
      .eq("account_id", scope.accountId)
      .maybeSingle();
    contact = (data as ContactData | null) ?? null;
  }
  if (needs.custom) {
    const { data: defs } = await db
      .from("custom_fields")
      .select("id, field_name, field_type")
      .eq("account_id", scope.accountId)
      .order("created_at", { ascending: true });
    fields = ((defs as CustomFieldDef[] | null) ?? []).filter((f) => f && f.id && typeof f.field_name === "string");
    if (scope.contactId && fields.length > 0) {
      // The contact must belong to the account before any of its values are read.
      const { data: owned } = await db
        .from("contacts")
        .select("id")
        .eq("id", scope.contactId)
        .eq("account_id", scope.accountId)
        .maybeSingle();
      if (owned) {
        const { data: values } = await db
          .from("contact_custom_values")
          .select("custom_field_id, value")
          .eq("contact_id", scope.contactId)
          .in("custom_field_id", fields.map((f) => f.id));
        for (const v of (values as { custom_field_id: string; value: string | null }[] | null) ?? []) {
          customValues[v.custom_field_id] = v.value;
        }
      }
    }
  }
  return { contact, fields, customValues, vars: scope.vars ?? {}, extra: scope.extra };
}

/** Fast path: a text without placeholders is returned untouched and costs no query. */
export async function renderTemplate(db: Db, template: string, scope: RenderScope, options: RenderOptions = {}): Promise<RenderResult> {
  if (!template || !hasPlaceholders(template)) return { text: template ?? "", warnings: [] };
  const needs = templateNeeds(template);
  const data = await loadVariableData(db, scope, needs);
  return renderWithData(template, data, options);
}
