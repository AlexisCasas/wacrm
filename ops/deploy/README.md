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
4. Candidate gets the public alias `wacrm-app`: Docker DNS may return both IPs. This is **not** load balancing, nor does it guarantee that Caddy retries webhook POSTs.
5. Dual-serve window (`DRAIN_SECONDS`), candidate re-checked.
6. Names are swapped while BOTH containers are running (`old -> wacrm-app-1-prev-<ts>`, `candidate -> wacrm-app-1`). The candidate is checked again for readiness under its final live name; on failure the running previous name is restored. A failed candidate rename restores the running old container to `wacrm-app-1`. Persistent Docker failures stop with a CRITICAL operator incident and preserve both instances for inspection.
7. Only AFTER successful name swap and readiness, `docker stop -t 40` gracefully stops the old container; Next receives SIGTERM and a bounded drain interval. The stopped previous image is then forcibly disconnected from the edge network and reconnected under a private-only alias for rollback. The isolated Docker preflight must verify this behavior before the cutover.

The old container is deliberately **not** disconnected from the network first: that severs its in-flight connections.
`lab-alias-flip.sh` shows it (isolated throwaway network, 12 slow requests in flight when the old one is stopped, ~50 req/s of keep-alive traffic):

| variant | requests | failed | slow requests in flight that completed |
|---|---|---|---|
| `sigterm-first` (this procedure) | 727 | 0 | **12 / 12** |
| `disconnect-first` (rejected)    | 775 | 0 | **3 / 12** (the other 9 hung) |

## Usage
```bash
# 1. image already built OFF the VPS and loaded (docker load), checksum verified (existing validate-loaded-image.sh pattern)
ops/deploy/deploy.sh wacrm-app:<tag>              # DRY-RUN: preflight + plan; no container mutation
# Only AFTER verifying nobody depends on the old host-published port:
ALLOW_DROP_HOST_PORTS=1 ops/deploy/deploy.sh wacrm-app:<tag>              # protected dry-run
ALLOW_DROP_HOST_PORTS=1 ops/deploy/deploy.sh --execute wacrm-app:<tag>    # separate explicit production approval required
ops/deploy/verify-no-502.sh --since 15m           # read-only proof
ops/deploy/rollback.sh --execute                  # if needed
```
**First rollout:** keep the default `READY_PATH=/api/health/ready` for `deploy.sh`. The **candidate** is the new image from this PR and already has the endpoint; the old live container is not checked for readiness during deployment. Do **not** set `READY_PATH=/` on deploy: WACRM's `/` redirects to `/dashboard` (and may redirect again to login), so HTTP 200 would not prove DB readiness.

**First rollback compatibility:** older images do not implement `/api/health/ready`. The deploy preflight and rollback can instead issue a *read-only* `accounts?select=id&limit=1` request to the Supabase REST API **from inside the old container**, using its existing service-role environment variables. Credentials and query data are not printed. It must return HTTP 200; redirects to dashboard/login are never accepted as readiness. If neither the new health endpoint nor the DB-backed fallback works, deployment/rollback is blocked. Check this behavior on the actual old image before the first production cutover.

## Mandatory preflight — first production cutover (NO-GO until approved)
- The current `docker-compose.yml` publishes `HOST_PORT:3000` on the VPS. The candidate **must omit this binding** while the old container owns it; after cutover the new container will not expose that host port. Before setting `ALLOW_DROP_HOST_PORTS=1`, inventory *all* host-port consumers (local probes, other containers, cron scripts, external integrations and monitoring) and either migrate them to `edge_proxy` or choose a different deployment architecture. Do not assume Caddy is the only client.
- Validate `docker compose version` (**>=2.24.4** for `!override`) and `docker compose ... config` against the *actual* live overlays and environment. `deploy.sh` enforces the Compose configuration check before mutations.
- Verify `edge_proxy`, shared Caddy reverse proxy, available memory/disk, live Compose project labels, candidate image checksum, all host/cron dependencies and the DB-backed rollback probe; take and verify a backup before the execute window.
- Rehearse dual-service window with synthetic/test traffic and the **actual Caddy** before an execute approval. The isolated lab has sometimes shown a dropped keep-alive socket, so a successful isolated trial alone is not sufficient. Do not retry non-idempotent POST webhooks unless delivery/idempotency can be proven. Stop on any 502 or lost webhook acknowledgement.
- The deployed state file `last.env` is published **only after the name swap**. If the old image could not be parked privately, the cutover is marked `ROLLBACK_DISABLED=1`, the script fails loudly, and automated rollback refuses to start. Such an incident requires manual correction before another deploy.
- **No production command, Caddy edit, shared Dentalpin change, restart or migration is authorized by merging this PR.** Run `--execute` only under a separate explicit approval.

## Rollback
**Deployment guard:** `--execute` first runs `lab-private-rollback.sh` on the actual Docker Engine using a disposable Docker network, then continues only if the stopped-backup can be reconnected with a private alias. That test does not replace the read-only Caddy/port/cron preflight or separate production authorization.

`rollback.sh` **refuses** to restart a previous image that still has the public alias. The backup must be parked privately by `deploy.sh`; it starts without the public alias, passes DB-backed readiness (including legacy REST fallback), and **only then** receives the public alias. Any failed pre-cutover rollback stops and re-parks the backup. The failed release is retained stopped after a successful rollback. A persistent Docker rename failure requires manual repair. State: `/opt/backups/wacrm/deploy-state/last.env`.

## Confirming the 502s are gone
`verify-no-502.sh` counts error lines for `/api/whatsapp/webhook` in the Caddy log **only if the log is readable** and requires a successful DB-backed readiness probe. Zero error lines alone is *not proof* that no requests failed: absence of access logs or a logging gap could hide failures. Independently verify Meta delivery statuses and webhook retry counts. Expected: `PASS` for a window that contains a deploy done with this procedure. Compare with the
same command over `--since 2026-11-10T18:00:00Z --until 2026-11-10T18:40:00Z`, which reports the 91 from the old procedure.
For stronger evidence also watch Meta's webhook delivery dashboard (no retries around the deploy minute).

## Compatibility and limits
- **Shared Caddy / Dentalpin: untouched.** Only the Caddy *log* is read. The candidate attaches to `edge_proxy` under WACRM's own aliases.
  Throwaway DNS probes run on `edge_proxy` as short-lived containers (`docker run --rm`).
- **Caddy is untouched by this PR**, but the lab has observed an intermittent keep-alive socket error (1/784 requests in one run, 12/12 slow requests completed). Therefore `zero 502` is **NOT guaranteed by alias rotation alone**. Review the WACRM-only `keepalive off` option in `caddy-hardening.proposed.md`; any Caddy change is a separate decision requiring approval and regression checks for Dentalpin.
- **Compose project label.** After the first run the live container belongs to project `wacrm-cand-<lowercase-ts>`, not `wacrm`. From then on deploy only
  with this script; do not run `docker compose -p wacrm up` for releases (it would try to create a second `wacrm-app-1`).
- **Crons:** between the two `docker rename`s, `docker exec wacrm-app-1` can briefly fail because the name is not yet assigned; however, a successful name lookup must never resolve to the stopped previous container. The scripts recover when the previous name can be restored. Persistent Docker rename failure remains an explicit manual-repair gate; do not claim zero missed cron ticks.
  Do not deploy inside the first 5 s of a minute if you want zero skipped ticks.
- **Two app instances briefly run (seconds):** both can receive webhooks/cron calls. Webhook inbound inserts are idempotent
  (`ON CONFLICT (conversation_id, message_id) DO NOTHING`), flow wait claims use leases/compare-and-set, and cron endpoints are idempotent
  claims; the in-process state is per-request. Confirm in staging before the first production run.
- **Memory:** measure actual free RAM, swap, image size and peak usage of *two* containers in the mandatory VPS preflight; do not rely on historic ~5 GB availability.
- **Builds stay off the VPS** (see `docs/ops` build instructions); this script never builds.
