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

## Fix (configuration — not in this repository): Brevo SMTP
Preflight from the VPS (2026-10-31): DNS and TCP to `smtp-relay.brevo.com` work on 587, 2525 and 465, both from the host and from
the Auth container's Docker network; 587 offers STARTTLS and then `AUTH PLAIN LOGIN CRAM-MD5`, which GoTrue supports.
Compose passes `SMTP_*` from the stack `.env` to `GOTRUE_SMTP_*` of the `auth` service only.

| `.env` key | Value |
|---|---|
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the Brevo SMTP login (not the account email) |
| `SMTP_PASS` | the Brevo **SMTP key** (not an API key) |
| `SMTP_ADMIN_EMAIL` | a sender verified in Brevo, on a domain you control |
| `SMTP_SENDER_NAME` | `WhatsCRM` |

Keep `ENABLE_EMAIL_AUTOCONFIRM=false`. Never commit these values.

Apply (needs explicit authorization), on the server:
```bash
scripts/ops/auth-smtp-apply.sh            # dry run: shows the plan, writes nothing
scripts/ops/auth-smtp-apply.sh --apply    # prompts (key not echoed), backs up .env (mode 600), edits only the six SMTP_* keys,
                                          # recreates ONLY the auth service, waits for healthy, auto-rolls back if it does not
```
It refuses to run if `ENABLE_EMAIL_AUTOCONFIRM` is not `false`, prints only key names and masked lengths, and reports whether any
other container changed. Tested on a dummy stack (special characters in the key, other service untouched, rollback, unhealthy → automatic rollback).

Brevo side: if "authorised IPs" is enabled in the Brevo account, add the VPS egress IP (check with `curl -4 https://api.ipify.org`) before applying.
Domain: the Brevo domain code, `brevo1/brevo2._domainkey` DKIM CNAMEs and a DMARC record already exist for `globaltechup.com`; SPF only lists
Hostinger — DMARC passes through DKIM, and adding `include:spf.brevo.com` to the SPF record is recommended (done at the DNS provider).

Smoke test with ONE controlled address you own: signup → mail arrives → link opens `/join/<token>` → accept → member list.
Redirects: verified in an isolated GoTrue with `SITE_URL=https://crm.globaltechup.com` and an empty allow list — `https://crm.globaltechup.com/join/<token>` is
preserved in the mail link, a foreign host falls back to `SITE_URL`. No `ADDITIONAL_REDIRECT_URLS` change is needed.

Do not use `ENABLE_EMAIL_AUTOCONFIRM=true` as a shortcut: it lets anyone register with an address they do not own.

## Rollback
`scripts/ops/auth-smtp-rollback.sh` restores the backup that `--apply` recorded and recreates only `auth`. No migration is involved.

## Incomplete records
A failed signup leaves nothing behind (the transaction rolls back). Read-only check:
```sql
SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = u.id);
SELECT count(*) FROM public.profiles p WHERE NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = p.account_id);
SELECT count(*) FROM auth.users WHERE email_confirmed_at IS NULL;
```
All three were 0 at diagnosis time. Pending invitations are untouched and remain valid until `expires_at`.

## What the app change does
`mapAuthError` shows the specific "verification email could not be sent" message only for a signup 5xx whose Auth message is
`Error sending … email`; any other 5xx keeps the generic signup message. It logs only `code`, `status` and a fixed `reason` tag
(`email_delivery`) — never the raw message.

## QA
Isolated stack (Postgres + GoTrue v2.189 + Mailpit + this repo's migrations, synthetic addresses only):
broken SMTP reproduces the identical 500 with no orphan rows; with SMTP → Mailpit the whole invitation flow
passes (signup, mail keeps `/join/<token>`, verify, login, redeem, role kept, isolation, expired/used/revoked,
pre-existing user accepting an invite).
