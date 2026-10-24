# Several conditions (all / any) in the SI / SI NO node

Branch `feat/flow-multi-conditions`, on top of the deployed commit `9e469989` (image `wacrm-app:flow-conditions-9e469989`). Nothing here is deployed.

## What changed

The existing `condition` node accepts a second, optional shape next to the old one. No new node type, no migration, no change to the two exits.

| | Legacy (unchanged) | Compound (new) |
|---|---|---|
| Rules | one, at the top level (`subject`, `subject_key`, `operator`, `value`, `case_sensitive`) | `conditions`: 1 to 10 rules, each with the same five keys |
| Mode | n/a | `match_mode`: `all` or `any` |
| Exits | `true_next`, `false_next` | the same two, shared by every rule |

- **One reader for both.** `src/lib/flows/condition-rules.ts` returns `legacy`, `compound` or `invalid`. The engine, the reference validation, the activation validation, the rollback check and the canvas summary all go through it.
- **No ambiguous nodes.** A node that has `conditions` together with any top-level rule key, or `match_mode` without `conditions`, or an empty or oversized list, or an unknown mode, is `invalid`: the validators reject it and the runner fails the run instead of choosing one reading.
- **Evaluation.** Rules run in order and stop as soon as the answer is known. `all` is false at the first false rule; `any` is true at the first true rule. A rule that cannot be evaluated (database error, field or tag of another account, capability off) throws and the run ends as failed with a fixed code; it is never turned into "false". The per-rule logic is the one already deployed (operators, case option, unknown values never count as "different").
- **Conversion in the editor.** A legacy node stays legacy while you edit its single rule. "+ Add condition" converts it: its rule is copied as rule 1 with every key intact and the top-level keys are removed, so the shapes never mix. Removing rules is allowed down to one.
- **`customer_activity` stays stand-alone.** It arms the reply guard on its false branch and its reference is read from the top level by the send tracking and durable waits. Combining it would change what both mean, so it is not offered inside a list and is rejected if saved there. Legacy customer-activity nodes are untouched.
- **Readable names.** The closed pickers now show the field's name, the operator and the kind instead of the raw value (`custom:<uuid>`), and the canvas summary shows the mode and the field and tag names: `Any of: field.Producto == "SAFARI" · has tag info de banco SAFARI`.

## Per-account switch

New server-side variable `FLOW_COMPOUND_CONDITIONS_ACCOUNT_IDS` (comma-separated account ids). It is independent of `FLOW_CUSTOM_CONDITIONS_ACCOUNT_IDS`: a rule that reads a custom field needs both. It is checked when saving, when activating and on every execution, and `/api/flows/capabilities` reports it as `compoundConditions`. No existing variable changes. A compound node already stored in a flow can still be saved while the switch is off (so other edits are not blocked), but a new one cannot, and it fails closed when it runs.

## Rollback guard

`/api/flows/downgrade-compatibility` now also reports any flow holding a compound node. An older build would read such a node as a rule with no subject, so deactivate and move those flows before going back to an older image.

## QA results

- `tsc --noEmit`: clean.
- `eslint`: 0 errors; the only warnings in changed files were already there.
- `vitest run`: 203 files passed, 5 skipped; 2788 tests passed, 121 skipped (the skipped ones are the suites that need the disposable-database harness, which is not part of the deployed commit).
- New tests (42): `compound-conditions.test.ts` (27), `compound-condition-form.test.tsx` (10), `compound-condition-roundtrip.test.tsx` (5). They cover the matrix from the brief: one legacy rule, two rules with both true / one true / both false under `all` and `any`, three or more rules, native and custom fields, tags and variables, negative operators, case sensitivity per rule, absent and unknown values, references of another account, infrastructure errors (including an error before a true rule under `any`), short-circuit, save and reopen through the real PUT body, cloning the saved JSON, adding / editing / removing rules, the 10-rule limit, activation validation, capability off, the rollback guard and the canvas summary. Breaking the `any` or `all` logic on purpose made 5 and 4 of them fail.
- Not run here: the disposable-database engine suites for customer activity and durable waits (`R01`-`R14`), because their harness is not in this commit. Their in-tree unit suites pass unchanged, and the only runner change is that the node is read through the new reader, which returns the legacy rule untouched.
- `npm run build` runs inside the image build (see the deployment plan).

## SAFARI test copies (files only, no database change)

In `/opt/backups/wacrm/flow-multi-conditions/` (outside Git because they contain the business copy): `safari-copy-any.*` and `safari-copy-all.*`, built from a read-only export of the draft by `make_safari_copy.py`.

- Start: one condition node, rule 1 `Producto contains "SAFARI"` (ignoring case), rule 2 tag `info de banco SAFARI` present; mode `any` in one copy, `all` in the other.
- True: a short message ("Ya le compartimos la información…") and end. False: the original presentation.
- The `Producto` write moved from the start to after the last presentation message, followed by adding the tag, so both marks exist only once the presentation was sent. The final customer-activity follow-up is unchanged.
- The trigger is a test keyword (`prueba safari any` / `prueba safari all`), the status is draft and the original flow is not touched.
- Both pass the activation validator, and both `.sql` files were applied to an isolated restore of the 05:51 backup (28 nodes each, mode as expected). They have not been applied to production.

Check before using them: that `info de banco SAFARI` really is the tag that means "already received the presentation" (it exists, but nothing in these flows applies it today besides the new `mark_tag` step).

## Deployment plan (needs separate authorization)

1. Candidate image `wacrm-app:flow-multi-conditions-<commit>` is built from the committed tree (done before any approval; it does not touch the running container).
2. In a quiet hour run `deploy.sh` from `/opt/backups/wacrm/flow-multi-conditions/`: it saves the current image name and `.env.local`, adds only `FLOW_COMPOUND_CONDITIONS_ACCOUNT_IDS=<Keyler id>`, recreates the `app` service and waits for healthy.
3. Check `/api/flows/capabilities` as Keyler (`compoundConditions: true`) and as another account (`false`).
4. Insert one copy (`safari-copy-any.sql`), test with the keyword from the test phone, then `safari-copy-all.sql`. Activate a copy only after checking it in the editor.

## Rollback

`rollback.sh` refuses to run while any stored node has `conditions` (it lists the flows). Convert or delete those nodes (or the test copies), then it removes the variable and restores `wacrm-app:flow-conditions-9e469989`. No database migration is involved. Test copies, if inserted, are plain draft rows and can be deleted with the id the insert printed.

## User guide

1. Open the flow and click the SI / SI NO node. A node with one condition looks as before.
2. Click **+ Añadir condición**. The first condition stays and a second one appears.
3. Choose **Todas las siguientes condiciones** (all must be true) or **Cualquiera de las siguientes condiciones** (one is enough).
4. For each condition choose what to check (variable, tag, contact field), the field by its name, the operator, the value and, for text, whether upper and lower case must match.
5. Pick where the flow goes when the result is true and when it is false. These two exits are shared by all conditions.
6. **Eliminar condición** removes one condition. A node always keeps at least one.
7. Save, reopen to check, then activate. A field that has no value yet is "unknown": it does not satisfy "no es igual a" or "no contiene"; use "está ausente" to catch it.
8. "Cliente respondió después del mensaje" cannot be combined; keep it in its own node.
