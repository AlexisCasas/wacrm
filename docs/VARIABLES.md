# Message variables (unified contract)

Placeholders are `{{ token }}` or `{{ token | fallback }}` and are resolved **at send time** for the account and contact that originate the send
(Flows: `send_message`, `send_media` caption, `collect_input` prompt, `set_contact_field` value; Automations: message, field, notification, webhook body).
Code: `src/lib/variables`. Stored texts are never rewritten.

| Reference | Meaning |
|---|---|
| `{{first_name}} {{last_name}} {{full_name}} {{name}} {{phone}} {{email}} {{company}}` | Standard contact fields (reserved names). `phone` is empty for a hidden-number contact; the BSUID is never exposed. |
| `{{vars.key}}`, `{{vars.contact_name}}` | Variables captured by the flow (compatible with every existing flow). |
| `{{custom:<field uuid>}}` | Custom field by its stable id (what the picker inserts; survives renaming the field). |
| `{{custom.<slug>}}`, `{{<slug>}}` | Custom field by the slug of its name ("Ciudad de envío" → `ciudad_de_envio`). Breaks if renamed; ambiguous slugs render as missing. |
| `{{message.text}}` | Automations only. |

Missing value: renders the fallback (`{{first_name | estimado}}`), else nothing — never the raw token — and the gap it would leave is closed ("Hola estimado {{first_name}} 🤗" with no name → "Hola estimado 🤗"; "Hola {{first_name}}, …" → "Hola, …"). A first word with no letters (symbols/digits only) is not used as a first name.
Unknown token (names no field/variable): renders nothing, with a warning in the preview. Never touched: Meta positional `{{1}}`, and legacy import references `cuf_<digits>`, which stay as written until mapped (below).
Aliases (legacy references): a field may list extra references in `custom_fields.field_options.aliases` (data, no migration; nothing in the app edits that column). Example, once the owner confirms which field `{{cuf_14160052}}` stands for:
`update custom_fields set field_options = coalesce(field_options,'{}'::jsonb) || '{"aliases":["cuf_14160052"]}' where id = '<field uuid>' and account_id = '<account uuid>';` — after that the 70 flows that carry it render the field's value. Aliases never shadow standard fields; two fields with the same alias are ambiguous (render empty).
`{{cuf_14160052}}` is the id a ManyChat import left in 70 Keyler flows (11 active); WACRM never had such a variable, so it has always been sent literally (2 messages seen, 24-25/10). Which Keyler field it meant is NOT knowable from the data: it is not mapped by this release.
Isolation: every query is filtered by the sending account; values are inserted in one pass (a value containing `{{...}}` is not expanded).
Picker: `GET /api/variables?flow_id=`; preview: `POST /api/variables/preview` (read-only). No migration required.
