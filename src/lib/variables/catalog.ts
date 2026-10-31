import { fieldSlug, type CustomFieldDef } from "./template";

/** Entry offered by the "Insert variable" picker. `token` is the exact text to insert (already wrapped in braces). */
export interface VariableCatalogEntry {
  group: "contact" | "custom" | "flow";
  label: string;
  token: string;
  /** Friendly alternative, shown as a hint; the inserted `token` is the stable one. */
  alias?: string;
}

const STANDARD_LABELS: [string, string][] = [
  ["first_name", "Primer nombre"],
  ["last_name", "Apellidos"],
  ["full_name", "Nombre completo"],
  ["email", "Correo"],
  ["company", "Empresa"],
  ["phone", "Teléfono (solo si existe)"],
];

export function buildCatalog(fields: CustomFieldDef[], flowVarKeys: string[] = []): VariableCatalogEntry[] {
  const out: VariableCatalogEntry[] = STANDARD_LABELS.map(([k, label]) => ({ group: "contact", label, token: `{{${k}}}` }));
  const slugCount = new Map<string, number>();
  for (const f of fields) slugCount.set(fieldSlug(f.field_name), (slugCount.get(fieldSlug(f.field_name)) ?? 0) + 1);
  for (const f of fields) {
    const slug = fieldSlug(f.field_name);
    out.push({
      group: "custom",
      label: f.field_name,
      token: `{{custom:${f.id}}}`,
      alias: slug && slugCount.get(slug) === 1 ? `{{custom.${slug}}}` : undefined,
    });
  }
  for (const key of [...new Set(flowVarKeys)].filter((k) => /^[a-zA-Z0-9_]+$/.test(k))) {
    out.push({ group: "flow", label: key, token: `{{vars.${key}}}` });
  }
  return out;
}

/** var_keys captured by collect_input nodes of a flow (for the picker's "Flow" group). */
export function flowVarKeys(nodes: { node_type: string; config: unknown }[]): string[] {
  const keys = ["contact_name"];
  for (const n of nodes) {
    const k = n.node_type === "collect_input" ? (n.config as { var_key?: string } | null)?.var_key : undefined;
    if (typeof k === "string" && k) keys.push(k);
  }
  return keys;
}
