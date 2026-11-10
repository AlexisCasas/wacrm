# Zero-downtime WACRM deploy (runbook)

**Status: proposal. Nothing here has been run against production.** Evidence it addresses (2026-11-10): the current procedure
(`docker compose up -d` recreating `wacrm-app-1`) leaves the app down for 5-6 s per deploy. Caddy answered **91 webhook POSTs with 502**
in two such windows (13:04:18-13:04:23 and 13:32:45-13:32:51 Lima: 72 + 19, `connection refused` / Docker DNS `server misbehaving`),
plus 5 isolated `connection reset`. Meta retries a non-2xx webhook, but late; and the old container is killed after Docker's default 10 s,
shorter than the drain Next.js recommends for `after()` work.

## What it does
`deploy.sh` runs a **candidate** next to the live container, proves it is ready, lets both serve, then stops the old one gracefully:

1. Start the candidate from the **live container's own compose files** (read from its labels; only the image changes), with a private alias.
2. Readiness gate: `GET /api/health/ready` (needs the DB) must return 200 `READY_PASSES` times in a row, from inside the container.
3. DNS check from a throwaway container on `edge_proxy`: private alias -> candidate only; `wacrm-app` -> old only.
4. Candidate gets the public alias `wacrm-app`: Docker DNS now returns both IPs (Caddy dials them in turn: a refused connect falls through to the next).
5. Dual-serve window (`DRAIN_SECONDS`), candidate re-checked.
6. `docker stop -t 40` on the old container: SIGTERM, Next stops accepting, finishes in-flight requests **and pending `after()` callbacks**
   (documented in `node_modules/next/dist/docs/01-app/02-guides/self-hosting.md`), exits; Docker DNS drops it. It is **kept stopped** for rollback.
7. Names swapped (`old -> wacrm-app-1-prev-<ts>`, `candidate -> wacrm-app-1`) because the host crons run `docker exec wacrm-app-1 ...`.

The old container is deliberately **not** disconnected from the network first: that severs its in-flight connections.
`lab-alias-flip.sh` shows it (isolated throwaway network, 12 slow requests in flight when the old one is stopped, ~50 req/s of keep-alive traffic):

| variant | requests | failed | slow requests in flight that completed |
|---|---|---|---|
| `sigterm-first` (this procedure) | 727 | 0 | **12 / 12** |
| `disconnect-first` (rejected)    | 775 | 0 | **3 / 12** (the other 9 hung) |

## Usage
```bash
# 1. image already built OFF the VPS and loaded (docker load), checksum verified (existing validate-loaded-image.sh pattern)
ops/deploy/deploy.sh wacrm-app:<tag>              # DRY-RUN: preflight + plan, mutates nothing
ops/deploy/deploy.sh --execute wacrm-app:<tag>    # deploy
ops/deploy/verify-no-502.sh --since 15m           # read-only proof
ops/deploy/rollback.sh --execute                  # if needed
```
**First rollout:** keep the default `READY_PATH=/api/health/ready` for `deploy.sh`. The **candidate** is the new image from this PR and already has the endpoint; the old live container is not checked for readiness during deployment. Do **not** set `READY_PATH=/` on deploy: WACRM's `/` redirects to `/dashboard` (and may redirect again to login), so HTTP 200 would not prove DB readiness.

**First rollback compatibility:** the previous, pre-OPS image does not have `/api/health/ready`, but `rollback.sh` checks readiness on the previous container. Before attempting the first rollback, explicitly verify old-image DB connectivity and its authenticated request path in a controlled preflight. A rollback-only `READY_PATH=/` fallback is a *degraded HTTP-liveness check*, not a DB readiness check; it must never be presented as proof of database health. For later deployments both images include `/api/health/ready` and the default applies.

## Rollback
`rollback.sh` starts the stopped previous container (it rejoins `edge_proxy` with its aliases), waits for readiness, lets both serve,
then stops the failed release (kept as `wacrm-app-1-failed-<ts>`). Any failure **before** step 6 of deploy leaves the old container serving
and removes the candidate. State of the last deploy: `/opt/backups/wacrm/deploy-state/last.env`.

## Confirming the 502s are gone
`verify-no-502.sh` counts error lines for `/api/whatsapp/webhook` in the Caddy log (Caddy logs **errors only**, so zero lines = no failed
upstream request) and probes readiness. Expected: `PASS` for a window that contains a deploy done with this procedure. Compare with the
same command over `--since 2026-11-10T18:00:00Z --until 2026-11-10T18:40:00Z`, which reports the 91 from the old procedure.
For stronger evidence also watch Meta's webhook delivery dashboard (no retries around the deploy minute).

## Compatibility and limits
- **Shared Caddy / Dentalpin: untouched.** Only the Caddy *log* is read. The candidate attaches to `edge_proxy` under WACRM's own aliases.
  Throwaway DNS probes run on `edge_proxy` as short-lived containers (`docker run --rm`).
- **No Caddy change is required.** An optional hardening (`caddy-hardening.proposed.md`) is a separate decision and is not applied.
- **Compose project label.** After the first run the live container belongs to project `wacrm-cand-<ts>`, not `wacrm`. From then on deploy only
  with this script; do not run `docker compose -p wacrm up` for releases (it would try to create a second `wacrm-app-1`).
- **Crons:** between the two `docker rename`s (~100 ms) `docker exec wacrm-app-1` can fail once; the flock'd per-minute scripts retry next tick.
  Do not deploy inside the first 5 s of a minute if you want zero skipped ticks.
- **Two app instances briefly run (seconds):** both can receive webhooks/cron calls. Webhook inbound inserts are idempotent
  (`ON CONFLICT (conversation_id, message_id) DO NOTHING`), flow wait claims use leases/compare-and-set, and cron endpoints are idempotent
  claims; the in-process state is per-request. Confirm in staging before the first production run.
- **Memory:** two Next containers (~160 MB each) for a few seconds; the host has ~5 GB available.
- **Builds stay off the VPS** (see `docs/ops` build instructions); this script never builds.
