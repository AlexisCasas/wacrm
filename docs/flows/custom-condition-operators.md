# Flow conditions: new operators and the SAFARI pilot

Branch `feat/flow-custom-condition-operators`, based on the deployed commit `6525112b`. Nothing here is deployed.

## Operators and semantics

| Operator | Meaning | Unknown subject |
|---|---|---|
| `equals` | text equals value | false |
| `not_equals` | known value differs | **false** |
| `contains` | value is a substring | false |
| `not_contains` | known value lacks substring | **false** |
| `starts_with` | value is a prefix | false |
| `present` | any non-empty value | false |
| `absent` | unknown (never set, null or empty) | true |

- **Unknown is not "different".** An unset or empty field answers false to every value operator, negatives included. Route unknown values with `absent`, or leave them on the false branch of a positive test.
- `case_sensitive`: absent or `true` is exact match (what every existing flow does); only an explicit `false` ignores case. New nodes created in the builder default to `false`; the checkbox is "Match upper/lower case".
- `equals` with an empty comparison value still matches an empty `var` subject, exactly as before.
- Evaluation is a pure read of `contact_custom_values` for the run's contact. The field is checked against the run's `account_id` first. Errors surface as fixed codes (for example `custom_condition_value_lookup_failed`) and never include field values.

## Audit of the VPS (read only, 2026-10-24)

- Deployed image `wacrm-app:audio-selection-6525112b` = `origin/main` `6525112b`. The `/opt/apps/wacrm` checkout is 18 commits behind it.
- `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS` is **not set** in the container, so `customConditions` is `false` for every account, Keyler included. Keyler (`4d04a2e0-62b8-4508-a046-4b125aa2e8db`) is in the other flow flags, not this one.
- Keyler has the custom field `Producto` (`fd8af7e4-e70a-4735-9c20-ce703471a701`, type `text`, compatible). No contact has a value for it yet. It also has `Precio` and `Destino`.
- No Keyler flow uses a custom-field condition yet. Every condition node in the database belongs to a draft.
- Existing flows are untouched by this change: the new option is optional and the old four operators run the same code path.

## Is enabling the existing capability enough?

For `equals`, `contains`, `present`, `absent` against `Producto`: yes. Setting `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS=4d04a2e0-62b8-4508-a046-4b125aa2e8db` and recreating the container is enough, with no code change. The builder would not offer "not equal", "not contain", "starts with" or case control, so this branch adds them.

## SAFARI flow proposal (do not alter the current draft in place; duplicate it)

The current draft "Prensa de banco SAFARI" runs `set_contact_field Producto = "prensa de banco SAFARI"` as its **second step**, before the presentation. With a check at the top that would always say "already presented". Proposed order:

1. `start` → `condition`: subject contact field `Producto`, operator `contains`, value `SAFARI`, case-insensitive.
   - true → short message ("Ya le compartimos la información de la SAFARI…") then the existing question/handoff nodes.
   - false (unset or any other product) → the current presentation, unchanged.
2. Move `set_contact_field Producto` to **after** the last presentation message (before the closing question), so it is written only once the presentation has actually been sent.
3. Keep the value `prensa de banco SAFARI`, or change it to `SAFARI`. `contains SAFARI` covers both.

Caveat: `Producto` holds one value per contact, so asking about another product overwrites it and SAFARI would be presented again afterwards. If "presented once, ever" is needed, add a separate field (for example `SAFARI presentada`) or a tag.

## Deployment plan (needs separate authorization)

1. Merge the branch, build the image tagged with the commit, deploy with the same compose overlay as today.
2. Set `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS` to the Keyler account id only, recreate `wacrm-app-1`, check `/api/flows/capabilities` returns `customConditions: true` for Keyler and `false` for the others.
3. Duplicate the SAFARI flow, edit the copy, run it with the test phone, then activate only the copy.

## Rollback

1. Call `/api/flows/downgrade-compatibility`. It now also reports flows using the new operators or case option. It must say `SAFE_TO_ROLLBACK`; otherwise deactivate those flows first, because an older build answers false to operators it does not know.
2. Redeploy image `wacrm-app:audio-selection-6525112b` with the same compose overlay and unset the env variable.
3. No database migration is involved, so there is nothing to revert in the data.
