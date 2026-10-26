/**
 * Unified message-variable contract (pure part: no I/O).
 *
 * A placeholder is `{{ token }}` or `{{ token | fallback text }}`. The token grammar is [A-Za-z0-9_.:-]+, so Meta's positional template
 * placeholders (`{{1}}`) and anything with spaces are never touched by this module unless the caller asks for it.
 *
 *   Standard contact fields (reserved names)   first_name  last_name  full_name (alias: name)  phone  email  company
 *   Flow variables (what a flow captured)       vars.<key>            (`vars.contact_name` is seeded at run start; kept for compatibility)
 *   Custom fields, STABLE reference             custom:<field uuid>   (also accepted: custom.<uuid>); survives renaming the field
 *   Custom fields, friendly reference           custom.<slug>         slug of the field name: "Producto" -> producto, "Ciudad de envío" -> ciudad_de_envio
 *   Bare name                                   <slug>                same as custom.<slug>, only when it is not a reserved standard name
 *   Alias                                       <alias>               any string in the field's `field_options.aliases` (legacy references from imports); checked before the slug
 *
 * Reserved standard names always win; a custom field called "Email" is reached with `custom.email` or its id. Two fields with the same slug are
 * ambiguous: the friendly form renders as missing (never as a guess) and the id form must be used.
 */
export const STANDARD_FIELDS = ["first_name", "last_name", "full_name", "name", "phone", "email", "company"] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];

export const TOKEN_RE = /\{\{\s*([A-Za-z0-9_.:-]+)\s*(?:\|([^{}]*))?\}\}/g;
const MAX_VALUE_LENGTH = 1000;

export interface ContactData {
  name?: string | null;
  email?: string | null;
  company?: string | null;
  /** Real phone number only. A hidden-number contact has none; the BSUID is never exposed here. */
  phone?: string | null;
}

export interface CustomFieldDef {
  id: string;
  field_name: string;
  field_type?: string | null;
  /**
   * `field_options.aliases`: extra references that resolve to this field (e.g. an id carried over from an import such as `cuf_14160052`).
   * Data, not code: an owner maps a legacy reference to a field by editing the field, no field name is known to the engine.
   */
  field_options?: { aliases?: unknown } | null;
}

export interface VariableData {
  contact: ContactData | null;
  fields: CustomFieldDef[];
  /** custom field id -> stored value */
  customValues: Record<string, string | null | undefined>;
  vars: Record<string, unknown>;
  /** Extra read-only namespaces, e.g. `message.text` for automations. */
  extra?: Record<string, string | null | undefined>;
}

export type Unresolved = "empty" | "keep";
/** Reference format carried over from an import (ManyChat custom user fields): `cuf_<digits>`. Not a field name; just the shape of the old id. */
export const LEGACY_IMPORT_TOKEN = /^cuf_\d+$/i;
export interface RenderOptions {
  /** What to do with a token that does not name any known variable: `empty` renders nothing (default), `keep` leaves it as written. */
  unknown?: Unresolved;
  /** Unknown tokens matching this are left as written even when `unknown` is `empty`: stored legacy references stay visible until an owner maps them. */
  keepUnknown?: RegExp;
}
export interface RenderWarning {
  token: string;
  reason: "missing_value" | "unknown_variable" | "ambiguous_field";
}
export interface RenderResult {
  text: string;
  warnings: RenderWarning[];
}

/** "Ciudad de envío" -> "ciudad_de_envio". Empty when nothing usable is left. */
export function fieldSlug(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function hasPlaceholders(template: string): boolean {
  TOKEN_RE.lastIndex = 0;
  const found = TOKEN_RE.test(template);
  TOKEN_RE.lastIndex = 0;
  return found;
}

/** Which data sources a template needs, so callers only query what is used. */
export function templateNeeds(template: string): { contact: boolean; custom: boolean } {
  const needs = { contact: false, custom: false };
  for (const m of template.matchAll(TOKEN_RE)) {
    const token = m[1];
    if ((STANDARD_FIELDS as readonly string[]).includes(token)) needs.contact = true;
    else if (token.startsWith("vars.") || token.startsWith("message.")) needs.contact = needs.contact || token === "vars.contact_name";
    else needs.custom = true;
  }
  return needs;
}

function aliasesOf(f: CustomFieldDef): string[] {
  const a = f.field_options?.aliases;
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").map((x) => x.trim().toLowerCase()) : [];
}

function cleanValue(raw: unknown, fieldType?: string | null): string {
  if (raw === undefined || raw === null) return "";
  let s = String(raw).trim();
  if (fieldType === "date" && /^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, mo, d] = s.slice(0, 10).split("-");
    s = `${d}/${mo}/${y}`;
  }
  return s.length > MAX_VALUE_LENGTH ? s.slice(0, MAX_VALUE_LENGTH) : s;
}

function standardValue(field: StandardField, contact: ContactData | null, vars: Record<string, unknown>): string {
  const full = (contact?.name ?? (vars.contact_name as string | undefined) ?? "").toString().trim().replace(/\s+/g, " ");
  switch (field) {
    case "full_name":
    case "name":
      return full;
    case "first_name": {
      // A profile name can start with symbols or digits only ("🎨🔧", "..."): not something to greet by.
      const first = full.split(" ")[0] ?? "";
      return /\p{L}/u.test(first) ? first : "";
    }
    case "last_name":
      return full.includes(" ") ? full.slice(full.indexOf(" ") + 1) : "";
    case "phone":
      return (contact?.phone ?? "").toString().trim();
    case "email":
      return (contact?.email ?? "").toString().trim();
    case "company":
      return (contact?.company ?? "").toString().trim();
  }
}

type Lookup = { found: false; reason: "unknown_variable" | "ambiguous_field" } | { found: true; value: string };

function resolveToken(token: string, data: VariableData): Lookup {
  if ((STANDARD_FIELDS as readonly string[]).includes(token)) {
    return { found: true, value: cleanValue(standardValue(token as StandardField, data.contact, data.vars)) };
  }
  if (token.startsWith("vars.")) {
    const key = token.slice(5);
    if (key === "contact_name" && data.contact?.name) return { found: true, value: cleanValue(data.contact.name) };
    return { found: true, value: cleanValue(data.vars[key]) };
  }
  const extraKey = data.extra && Object.prototype.hasOwnProperty.call(data.extra, token) ? token : null;
  if (extraKey) return { found: true, value: cleanValue(data.extra?.[extraKey]) };
  if (token.startsWith("message.")) return { found: false, reason: "unknown_variable" };

  const byId = /^custom[:.]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(token);
  if (byId) {
    const def = data.fields.find((f) => f.id.toLowerCase() === byId[1].toLowerCase());
    if (!def) return { found: false, reason: "unknown_variable" };
    return { found: true, value: cleanValue(data.customValues[def.id], def.field_type) };
  }
  const aliased = data.fields.filter((f) => aliasesOf(f).includes(token.toLowerCase()));
  if (aliased.length === 1) return { found: true, value: cleanValue(data.customValues[aliased[0].id], aliased[0].field_type) };
  if (aliased.length > 1) return { found: false, reason: "ambiguous_field" };
  const slug = token.startsWith("custom.") ? token.slice(7) : token;
  if (!slug || slug.includes(".") || slug.includes(":")) return { found: false, reason: "unknown_variable" };
  const matches = data.fields.filter((f) => fieldSlug(f.field_name) === slug.toLowerCase());
  if (matches.length === 0) return { found: false, reason: "unknown_variable" };
  if (matches.length > 1) return { found: false, reason: "ambiguous_field" };
  return { found: true, value: cleanValue(data.customValues[matches[0].id], matches[0].field_type) };
}

/**
 * Single left-to-right pass: values are never re-scanned, so a value that itself contains `{{...}}` cannot expand into anything.
 * A known variable without a value renders as its fallback (`{{producto | nuestro producto}}`) or as an empty string, never as the raw token.
 */
export function renderWithData(template: string, data: VariableData, options: RenderOptions = {}): RenderResult {
  if (!template) return { text: "", warnings: [] };
  const warnings: RenderWarning[] = [];
  const unknown = options.unknown ?? "empty";
  let out = "";
  let cursor = 0;
  for (const m of template.matchAll(TOKEN_RE)) {
    const whole = m[0];
    const token = m[1];
    const fb = m[2] === undefined ? undefined : m[2].trim();
    const start = m.index ?? 0;
    out += template.slice(cursor, start);
    cursor = start + whole.length;
    const r = resolveToken(token, data);
    let value: string;
    if (!r.found) {
      warnings.push({ token, reason: r.reason });
      // `{{1}}`-style tokens are Meta template positions, never ours: always left as written.
      const kept = unknown === "keep" || /^\d+$/.test(token) || (options.keepUnknown?.test(token) ?? false);
      value = fb !== undefined ? fb : r.reason === "ambiguous_field" || !kept ? "" : whole;
    } else if (r.value === "") {
      warnings.push({ token, reason: "missing_value" });
      value = fb ?? "";
    } else {
      value = r.value;
    }
    if (value === "") {
      // Nothing is rendered here: do not leave the gap it would make ("Hola estimado  🤗", "Hola , bienvenido", "¿, aún…", "**").
      let next = template.slice(cursor);
      const mark = /[*_~]$/.exec(out)?.[0];
      if (mark && next.startsWith(mark)) {          // "*{{first_name}}*" with no name: drop the empty bold/italic pair
        out = out.slice(0, -1);
        cursor += 1;
        next = template.slice(cursor);
      }
      const atLineStart = out === "" || out.endsWith("\n");
      if ((atLineStart || /[¿¡(\[]$/.test(out)) && /^[,;:]/.test(next)) cursor += /^[,;:][ \t]*/.exec(next)![0].length;
      else if ((/[ \t]$/.test(out) || atLineStart) && /^[ \t]/.test(next)) cursor += 1;
      else if (/[ \t]$/.test(out) && (/^[,.;:!?)\]¡¿]/.test(next) || next === "" || next.startsWith("\n"))) out = out.replace(/[ \t]+$/, "");
    }
    out += value;
  }
  out += template.slice(cursor);
  return { text: out, warnings };
}
