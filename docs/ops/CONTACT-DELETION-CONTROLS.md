# Contact deletion controls (FIX 04)

Contacts are deleted **only** through `POST /api/contacts/bulk-delete` → `bulk_delete_contacts_internal(...)` (5 arguments). Nothing else can delete them:
the `contacts_delete` RLS policy, `DELETE`/`TRUNCATE` privileges (anon, authenticated **and** service_role) and public `EXECUTE` on
`merge_duplicate_contacts()` / `merge_duplicate_conversations()` were removed by `20261127000000_contact_deletion_controls.sql`.

## Who may delete what
| Case | Minimum role |
|---|---|
| 1 contact | agent |
| 2+ contacts (typed word `ELIMINAR`) | admin / owner |
| Contacts with orders | admin / owner (+ acknowledgement) |
| Contacts with a conversation in the last 30 days, or blocked | acknowledgement (`acknowledge_protected`) |

The role is checked in the route **and again inside the database function** against `profiles`; the actor id comes from the verified session and the
function is executable only by `service_role`.

## Limits (database, under a per-company advisory lock; values in `contact_delete_limits()`)
100 per operation · 1,000 per company per rolling 24 h · agents: 10 per hour each. Repeating requests cannot get around them: the windows are summed from the
audit table after the lock is taken. A larger clean-up needs several days or an operator-run exception approved in writing.

## Audit
`contact_deletion_operations` (who, company, role, when, counts) and `contact_deletion_items` (contact id, creation date, **last 3 digits of the phone**, BSUID/blocked flags,
counts). No names, emails, full phones or BSUID values: to recover a contact, use its id against a backup. The rows are written in the same transaction as the
delete (audit failure = nothing deleted), nobody on the API can insert/update/delete them, and a trigger makes them append-only. Admin/owner can read their own company.

## Retention (proposal, **not scheduled**)
Items: 180 days. Operations: 24 months. `purge_contact_deletion_audit()` (service_role only, refuses < 30 days / < 6 months) implements it. Propose a monthly cron
that calls it through the application container, installed only after separate approval and logged.

## Rollback and restores
* Older application images call the retired 3-argument function, which **fails closed** (`ACTOR_REQUIRED`): they cannot delete without controls.
* The migration is not reverted automatically. Re-opening any path is an emergency action requiring explicit approval.
* After ANY database restore (a backup taken before this migration brings the policy and grants back) run `supabase/ci/verify-contact-delete-controls.sql`
  (read-only) before reopening traffic. CI runs it on every migration replay.

## Known neighbouring risk (not changed here)
`contacts.user_id` is `ON DELETE CASCADE` to `auth.users` and all contacts of a company are attributed to one creator user: deleting that auth user would delete
the company's contacts. The application never does it; keep it that way until a dedicated fix.
