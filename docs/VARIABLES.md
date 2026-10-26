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

Missing value: renders the fallback, else empty (never the raw token). Unknown token: Flows leave it as written (so existing texts never change, e.g. the legacy `{{cuf_14160052}}` in Keyler flows is still sent literally until mapped); Automations render it empty as before. `{{1}}`-style Meta template placeholders are not touched.
Isolation: every query is filtered by the sending account; values are inserted in one pass (a value containing `{{...}}` is not expanded).
Picker: `GET /api/variables?flow_id=`; preview: `POST /api/variables/preview` (read-only). No migration required.
