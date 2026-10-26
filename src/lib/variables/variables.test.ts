import { describe, expect, it } from "vitest";
import { LEGACY_IMPORT_TOKEN, buildCatalog, flowVarKeys, fieldSlug, hasPlaceholders, renderTemplate, renderWithData, type VariableData } from "./index";
import { createInMemoryDb } from "@/test/in-memory-db";

const F_PROD = "11111111-1111-4111-8111-111111111111";
const F_PRICE = "22222222-2222-4222-8222-222222222222";
const F_CITY = "33333333-3333-4333-8333-333333333333";
const F_DATE = "44444444-4444-4444-8444-444444444444";

const data = (over: Partial<VariableData> = {}): VariableData => ({
  contact: { name: "Angelo Reynaga Zavala", email: "a@x.test", company: "Keyler", phone: "" },
  fields: [
    { id: F_PROD, field_name: "Producto", field_type: "text" },
    { id: F_PRICE, field_name: "Precio", field_type: "number" },
    { id: F_CITY, field_name: "Ciudad de envío", field_type: "text" },
    { id: F_DATE, field_name: "Fecha de entrega", field_type: "date" },
  ],
  customValues: { [F_PROD]: "Prensa de banco SAFARI", [F_PRICE]: "110", [F_CITY]: "Lima", [F_DATE]: "2026-11-03" },
  vars: { contact_name: "Angelo Reynaga Zavala", interes: "alto" },
  ...over,
});

describe("the user's example", () => {
  it("renders first name, product, price and city from the contact", () => {
    const r = renderWithData("Hola {{first_name}}, el producto {{producto}} tiene un precio de S/ {{precio}}. Podemos coordinar tu pedido en {{ciudad_de_envio}}.", data());
    expect(r.text).toBe("Hola Angelo, el producto Prensa de banco SAFARI tiene un precio de S/ 110. Podemos coordinar tu pedido en Lima.");
    expect(r.warnings).toEqual([]);
  });
});

describe("standard fields", () => {
  it("full name, first name, last names, aliases and spacing", () => {
    const d = data({ contact: { name: "  Angelo   Reynaga Zavala ", email: null, company: null, phone: null } });
    expect(renderWithData("{{full_name}}|{{name}}|{{first_name}}|{{last_name}}", d).text).toBe("Angelo Reynaga Zavala|Angelo Reynaga Zavala|Angelo|Reynaga Zavala");
  });
  it("a single-word name has no last name; no name falls back to vars.contact_name", () => {
    expect(renderWithData("{{first_name}}/{{last_name}}", data({ contact: { name: "Rosa" } })).text).toBe("Rosa/");
    expect(renderWithData("{{first_name}}", data({ contact: null })).text).toBe("Angelo");
  });
  it("phone is empty for a hidden-number contact; the technical id is not part of the contract", () => {
    const r = renderWithData("[{{phone}}] [{{bsuid}}] [{{wa_username}}]", data(), { unknown: "keep" });
    expect(r.text).toBe("[] [{{bsuid}}] [{{wa_username}}]");
  });
});

describe("custom fields", () => {
  it("friendly forms: bare slug, custom.slug, accents and spaces folded", () => {
    expect(renderWithData("{{producto}}|{{custom.producto}}|{{ciudad_de_envio}}|{{custom.ciudad_de_envio}}", data()).text).toBe("Prensa de banco SAFARI|Prensa de banco SAFARI|Lima|Lima");
    expect(fieldSlug("Ciudad de envío")).toBe("ciudad_de_envio");
  });
  it("the stable id survives renaming the field; the friendly name stops matching", () => {
    const renamed = data({ fields: data().fields.map((f) => (f.id === F_PROD ? { ...f, field_name: "Equipo" } : f)) });
    expect(renderWithData(`{{custom:${F_PROD}}}|{{custom.${F_PROD}}}|{{equipo}}`, renamed).text).toBe("Prensa de banco SAFARI|Prensa de banco SAFARI|Prensa de banco SAFARI");
    expect(renderWithData("{{producto}}", renamed, { unknown: "keep" }).text).toBe("{{producto}}");
  });
  it("a deleted field: id and name render as unknown, with a warning and no crash", () => {
    const gone = data({ fields: data().fields.filter((f) => f.id !== F_PROD) });
    const r = renderWithData(`{{custom:${F_PROD}}}|{{producto|n/a}}`, gone);
    expect(r.text).toBe("|n/a");
    expect(r.warnings.map((w) => w.reason)).toEqual(["unknown_variable", "unknown_variable"]);
  });
  it("a standard name wins over a custom field called the same; the custom one stays reachable by id and custom.", () => {
    const d = data({ fields: [...data().fields, { id: "55555555-5555-4555-8555-555555555555", field_name: "Email" }], customValues: { ...data().customValues, "55555555-5555-4555-8555-555555555555": "otro@x.test" } });
    expect(renderWithData("{{email}}|{{custom.email}}|{{custom:55555555-5555-4555-8555-555555555555}}", d).text).toBe("a@x.test|otro@x.test|otro@x.test");
  });
  it("two fields with the same slug are ambiguous: never guessed; the id form works", () => {
    const d = data({ fields: [...data().fields, { id: "66666666-6666-4666-8666-666666666666", field_name: "producto" }], customValues: { ...data().customValues, "66666666-6666-4666-8666-666666666666": "Otro" } });
    const r = renderWithData(`{{producto|?}}|{{custom:${F_PROD}}}`, d);
    expect(r.text).toBe("?|Prensa de banco SAFARI");
    expect(r.warnings[0].reason).toBe("ambiguous_field");
  });
  it("numbers and text are kept as stored; ISO dates of date fields read dd/mm/yyyy; long values are capped", () => {
    expect(renderWithData("S/ {{precio}} el {{fecha_de_entrega}}", data()).text).toBe("S/ 110 el 03/11/2026");
    expect(renderWithData("{{producto}}", data({ customValues: { [F_PROD]: "x".repeat(5000) } })).text).toHaveLength(1000);
  });
});

describe("missing values, defaults and unknown tokens", () => {
  it("a known field without a value renders its fallback or empty — never the raw token — and warns", () => {
    const d = data({ customValues: {} });
    const r = renderWithData("Producto: {{producto | nuestro producto}}. Precio: [{{precio}}]", d);
    expect(r.text).toBe("Producto: nuestro producto. Precio: []");
    expect(r.warnings).toEqual([{ token: "producto", reason: "missing_value" }, { token: "precio", reason: "missing_value" }]);
  });
  it("unknown tokens: `keep` leaves them as written (flows), `empty` removes them (automations)", () => {
    expect(renderWithData("a {{cuf_14160052}} b", data(), { unknown: "keep" }).text).toBe("a {{cuf_14160052}} b");
    expect(renderWithData("a {{cuf_14160052}} b", data(), { unknown: "empty" }).text).toBe("a b");
  });
  it("Meta positional placeholders and non-token braces are never touched, even when unknown tokens render empty", () => {
    const t = "Pedido {{1}} {{ 2 }} {{no valido}} {x}";
    expect(renderWithData(t, data(), { unknown: "keep" }).text).toBe("Pedido {{1}} {{ 2 }} {{no valido}} {x}");
    expect(renderWithData(t, data(), { unknown: "empty" }).text).toBe("Pedido {{1}} {{ 2 }} {{no valido}} {x}");
  });
  it("keepUnknown: only the legacy import shape survives as written; any other unknown token renders nothing", () => {
    const r = renderWithData("a {{cuf_14160052}} b {{otra_cosa}} c", data(), { unknown: "empty", keepUnknown: LEGACY_IMPORT_TOKEN });
    expect(r.text).toBe("a {{cuf_14160052}} b c");
  });
  it("a value containing a placeholder is not expanded again (single pass)", () => {
    const d = data({ contact: { name: "{{email}} X" } });
    expect(renderWithData("{{first_name}}", d).text).toBe("{{email}}");
  });
});

describe("flow variables and old syntax", () => {
  it("{{vars.x}} and {{vars.contact_name}} keep working; a missing var is empty (as before)", () => {
    expect(renderWithData("{{vars.interes}}|{{vars.contact_name}}|[{{vars.nada}}]|{{ vars.interes }}", data()).text).toBe("alto|Angelo Reynaga Zavala|[]|alto");
  });
  it("vars of the run are not confused with custom fields of the same name", () => {
    expect(renderWithData("{{vars.producto}}|{{producto}}", data({ vars: { producto: "variable del flow" } })).text).toBe("variable del flow|Prensa de banco SAFARI");
  });
  it("extra namespaces (automations: message.text)", () => {
    expect(renderWithData("dijo: {{message.text}}", data({ extra: { "message.text": "hola" } })).text).toBe("dijo: hola");
  });
});

describe("loading (account isolation, no query without placeholders)", () => {
  const seed = () => createInMemoryDb({
    contacts: [
      { id: "c1", account_id: "A", name: "Ana Pérez", email: "ana@a.test", phone: "" },
      { id: "c2", account_id: "B", name: "Beto Otro", email: "beto@b.test", phone: "51999" },
    ],
    custom_fields: [{ id: F_PROD, account_id: "A", field_name: "Producto" }, { id: F_CITY, account_id: "B", field_name: "Ciudad" }],
    contact_custom_values: [{ contact_id: "c1", custom_field_id: F_PROD, value: "Taladro" }, { contact_id: "c2", custom_field_id: F_CITY, value: "Cusco" }],
  });
  it("resolves the right contact and its fields for its own account", async () => {
    const mem = seed();
    const r = await renderTemplate(mem.client as never, "{{first_name}} compra {{producto}}", { accountId: "A", contactId: "c1" });
    expect(r.text).toBe("Ana compra Taladro");
  });
  it("a contact of another account yields nothing, and another account's fields/values are not visible", async () => {
    const mem = seed();
    const r = await renderTemplate(mem.client as never, "[{{first_name}}] [{{email}}] [{{ciudad}}] [{{producto}}]", { accountId: "A", contactId: "c2" });
    expect(r.text).toBe("[] [] [] []");
  });
  it("custom fields of account B never resolve under account A even for the right contact id of A", async () => {
    const mem = seed();
    const r = await renderTemplate(mem.client as never, "{{ciudad|sin ciudad}}", { accountId: "A", contactId: "c1" });
    expect(r.text).toBe("sin ciudad");
  });
  it("a text with no placeholder is returned as is without touching the database", async () => {
    const mem = seed();
    mem.failReads.add("contacts"); mem.failReads.add("custom_fields");
    expect((await renderTemplate(mem.client as never, "Hola, sin variables {1}", { accountId: "A", contactId: "c1" })).text).toBe("Hola, sin variables {1}");
    expect(hasPlaceholders("{{1}}")).toBe(true);
    expect(hasPlaceholders("{1}")).toBe(false);
  });
  it("no contact (e.g. an automation without one): standard fields are empty, vars still work", async () => {
    const r = await renderTemplate(seed().client as never, "[{{first_name}}] {{vars.k}}", { accountId: "A", contactId: null, vars: { k: "v" } });
    expect(r.text).toBe("[] v");
  });
});

describe("catalog for the picker", () => {
  it("lists contact fields, custom fields with their STABLE token (and a friendly alias when unambiguous) and the flow's captured variables", () => {
    const c = buildCatalog(data().fields, flowVarKeys([{ node_type: "collect_input", config: { var_key: "interes" } }, { node_type: "send_message", config: {} }]));
    expect(c.filter((e) => e.group === "contact").map((e) => e.token)).toContain("{{first_name}}");
    const prod = c.find((e) => e.label === "Producto")!;
    expect(prod.token).toBe(`{{custom:${F_PROD}}}`);
    expect(prod.alias).toBe("{{custom.producto}}");
    expect(c.filter((e) => e.group === "flow").map((e) => e.token)).toEqual(["{{vars.contact_name}}", "{{vars.interes}}"]);
  });
  it("an ambiguous slug offers no alias; the inserted token is always the stable one", () => {
    const f = [...data().fields, { id: "77777777-7777-4777-8777-777777777777", field_name: "PRODUCTO" }];
    expect(buildCatalog(f).filter((e) => e.group === "custom" && /producto/i.test(e.label)).every((e) => e.alias === undefined)).toBe(true);
  });
});

describe("empty values never leave gaps or raw tokens", () => {
  const noName = data({ contact: { name: "", email: null, company: null, phone: "" }, vars: {} });
  it("a contact without a name: the greeting closes up instead of 'Hola estimado  🤗'", () => {
    expect(renderWithData("Hola estimado {{first_name}} 🤗", noName).text).toBe("Hola estimado 🤗");
    expect(renderWithData("Hola {{first_name}}, ¿en qué te ayudo?", noName).text).toBe("Hola, ¿en qué te ayudo?");
    expect(renderWithData("{{first_name}} te saluda", noName).text).toBe("te saluda");
    expect(renderWithData("Línea 1\n{{first_name}} línea 2", noName).text).toBe("Línea 1\nlínea 2");
    expect(renderWithData("Hola {{first_name}}!", noName).text).toBe("Hola!");
  });
  it("an explicit fallback is used instead: {{first_name | estimado cliente}}", () => {
    expect(renderWithData("Hola {{first_name | estimado cliente}} 🤗", noName).text).toBe("Hola estimado cliente 🤗");
  });
  it("a first word that is only symbols or digits is not used as a first name", () => {
    expect(renderWithData("Hola {{first_name}} 🤗", data({ contact: { name: "🎨🔧 Luis" } })).text).toBe("Hola 🤗");
    expect(renderWithData("Hola {{first_name}} 🤗", data({ contact: { name: "Luismi...🎨" } })).text).toBe("Hola Luismi...🎨 🤗");
    expect(renderWithData("{{full_name}}", data({ contact: { name: "🎨🔧 Luis" } })).text).toBe("🎨🔧 Luis");
  });
  it("several empty values in a row do not stack spaces; text without variables is never touched", () => {
    expect(renderWithData("A {{first_name}} {{email}} {{company}} B", noName).text).toBe("A B");
    expect(renderWithData("Texto  con  dos  espacios {1}", noName).text).toBe("Texto  con  dos  espacios {1}");
    expect(renderWithData("Hola  {{first_name}}  fin", data()).text).toBe("Hola  Angelo  fin");
  });
  it("no raw {{token}} survives for a known variable, in any of its forms", () => {
    const out = renderWithData("{{first_name}}|{{vars.nada}}|{{custom:" + F_PROD + "}}|{{producto}}|{{precio}}", { ...noName, customValues: {} }).text;
    expect(out).not.toMatch(/\{\{/);
  });
});

describe("aliases: legacy references mapped to a field by data (no field name in code)", () => {
  const withAlias = (aliases: unknown) => data({ fields: data().fields.map((f) => (f.id === F_CITY ? { ...f, field_options: { aliases } } : f)) });
  it("{{cuf_14160052}} renders the field that lists it as an alias, whatever the field is called", () => {
    expect(renderWithData("Ya le indico {{cuf_14160052}} 😊", withAlias(["cuf_14160052"])).text).toBe("Ya le indico Lima 😊");
    expect(renderWithData("{{CUF_14160052}}", withAlias(["cuf_14160052"])).text).toBe("Lima");
  });
  it("without a mapping the legacy reference stays as written in flows (stored text unchanged) and is reported", () => {
    const r = renderWithData("Ya le indico {{cuf_14160052}} 😊", data(), { unknown: "keep" });
    expect(r.text).toBe("Ya le indico {{cuf_14160052}} 😊");
    expect(r.warnings).toEqual([{ token: "cuf_14160052", reason: "unknown_variable" }]);
  });
  it("an alias cannot shadow a standard field; the same alias on two fields is ambiguous; malformed alias data is ignored", () => {
    expect(renderWithData("{{email}}", withAlias(["email"])).text).toBe("a@x.test");
    const two = data({ fields: data().fields.map((f) => ({ ...f, field_options: { aliases: ["dup"] } })) });
    expect(renderWithData("[{{dup|?}}]", two).text).toBe("[?]");
    expect(renderWithData("{{cuf_1|x}}", withAlias("cuf_1")).text).toBe("x");
    expect(renderWithData("{{cuf_1|x}}", withAlias([1, null, {}])).text).toBe("x");
  });
  it("an alias works through the loader (field_options is read from the account's own field definitions)", async () => {
    const mem = createInMemoryDb({
      contacts: [{ id: "c1", account_id: "A", name: "Ana Pérez" }],
      custom_fields: [{ id: F_CITY, account_id: "A", field_name: "Destino", field_options: { aliases: ["cuf_14160052"] } }],
      contact_custom_values: [{ contact_id: "c1", custom_field_id: F_CITY, value: "Tarapoto" }],
    });
    expect((await renderTemplate(mem.client as never, "Ya le indico {{cuf_14160052}}", { accountId: "A", contactId: "c1" })).text).toBe("Ya le indico Tarapoto");
    expect((await renderTemplate(mem.client as never, "Ya le indico {{cuf_14160052|-}}", { accountId: "B", contactId: "c1" })).text).toBe("Ya le indico -");
  });
});

describe("common messages with an empty name (punctuation and spacing)", () => {
  const none = data({ contact: { name: "", email: null, company: null, phone: "" }, vars: {} });
  const cases: [string, string][] = [
    ["Hola {{first_name}} 🤗", "Hola 🤗"],
    ["Hola estimado {{first_name}} 🤗", "Hola estimado 🤗"],
    ["Hola {{first_name}}, bienvenido a Keyler", "Hola, bienvenido a Keyler"],
    ["Hola {{first_name}}. ¿En qué le puedo ayudar?", "Hola. ¿En qué le puedo ayudar?"],
    ["¡Hola {{first_name}}!", "¡Hola!"],
    ["Buenos días {{first_name}}:\nTenemos stock", "Buenos días:\nTenemos stock"],
    ["Estimado(a) {{first_name}}:", "Estimado(a):"],
    ["¿{{first_name}}, aún está interesado?", "¿aún está interesado?"],
    ["({{first_name}}, cliente)", "(cliente)"],
    ["Hola {{first_name}} {{last_name}}, gracias", "Hola, gracias"],
    ["*{{first_name}}*, gracias por escribir", "gracias por escribir"],
    ["Gracias, {{first_name}}", "Gracias,"],
    ["{{first_name}}", ""],
    ["Hola {{first_name | amigo}}, bienvenido", "Hola amigo, bienvenido"],
  ];
  for (const [input, expected] of cases) {
    it(JSON.stringify(input), () => {
      const out = renderWithData(input, none).text;
      expect(out).toBe(expected);
      expect(out).not.toMatch(/ {2}| ,| \.|\{\{/);
    });
  }
  it("with a name the same messages are exactly the plain substitution", () => {
    expect(renderWithData("¡Hola {{first_name}}! ¿{{first_name}}, aún interesado?", data()).text).toBe("¡Hola Angelo! ¿Angelo, aún interesado?");
  });
});
