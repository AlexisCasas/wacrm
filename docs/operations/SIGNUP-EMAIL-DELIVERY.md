# Signup fails with HTTP 500 — verification email cannot be sent

## Symptom
"Crear cuenta y unirte" shows *No se pudo crear la cuenta*; the browser console shows an HTTP 500 from
`POST /auth/v1/signup`. Invitations are created fine, but nobody can register, so nobody can accept one.

## Root cause (evidence)
Supabase Auth (GoTrue) creates the user, then sends the verification email **inside the same transaction**.
When the send fails GoTrue answers `500 unexpected_failure` and rolls the user back. The self-hosted Auth
container is still on the stock template SMTP values:

| Parameter (`.env` of the Supabase stack) | Current value |
|---|---|
| `SMTP_HOST` | `supabase-mail` (a container that does not exist) |
| `SMTP_PORT` | `2500` |
| `SMTP_ADMIN_EMAIL` / `SMTP_SENDER_NAME` | `admin@example.com` / `fake_sender` |

GoTrue log line for every failure: `dial tcp: lookup supabase-mail ...: server misbehaving`
(`msg: "500: Error sending confirmation email"`, path `/signup`). The `on_auth_user_created` trigger,
`handle_new_user()` and the invitation RPCs are not involved: PostgreSQL logged no errors, and
the same flow passes end to end once SMTP is reachable (see QA below).

Affected: every flow that needs email — signup, password recovery, email change, Auth-sent invitations.
Existing users keep working (login does not send mail).

## Fix (configuration — not in this repository)
1. Pick an SMTP provider and a sender address on a domain you control (SPF/DKIM configured there).
2. In the Supabase stack `.env` set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
   `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME`. Keep `ENABLE_EMAIL_AUTOCONFIRM=false` (email verification stays on).
   Never commit these values.
3. Back up the file first, then recreate only the Auth container (`docker compose up -d --force-recreate auth`).
4. Smoke test with ONE controlled address you own: signup → mail arrives → link opens `/join/<token>` for an
   invited address. Confirm the link host is `crm.globaltechup.com` / `supabase.globaltechup.com`.
   If Auth rejects the redirect, add `https://crm.globaltechup.com/**` to `ADDITIONAL_REDIRECT_URLS`.

Do not use `ENABLE_EMAIL_AUTOCONFIRM=true` as a shortcut: it lets anyone register with an address they do not own.

## Rollback
Restore the backed-up `.env` and recreate `auth` again. Nothing else changes; no migration is involved.

## Incomplete records
A failed signup leaves nothing behind (the transaction rolls back). Read-only check:
```sql
SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id);
SELECT count(*) FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p.account_id);
SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL;
```
All three were 0 at diagnosis time. Pending invitations are untouched and remain valid until `expires_at`.

## What the app change does
`mapAuthError` now shows a specific message for a signup 5xx (the account was not created because the email
could not be sent) instead of "try again", and logs only the stable `code` and HTTP `status` — never the raw message.

## QA
Isolated stack (Postgres + GoTrue v2.189 + Mailpit + this repo's migrations, synthetic addresses only):
broken SMTP reproduces the identical 500 with no orphan rows; with SMTP → Mailpit the whole invitation flow
passes (signup, mail keeps `/join/<token>`, verify, login, redeem, role kept, isolation, expired/used/revoked,
pre-existing user accepting an invite).
