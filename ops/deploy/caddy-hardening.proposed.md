# Optional Caddy hardening for crm.globaltechup.com: PROPOSAL, NOT APPLIED

The Caddyfile (`/opt/apps/dentalpin/Caddyfile`) is shared with Dentalpin and other sites, so it is out of scope for the deploy PR.
Change only the WACRM block; leave every other block byte-identical.

```caddyfile
crm.globaltechup.com {
        reverse_proxy wacrm-app:3000 {
                # a dial that fails (container restarting) is retried for up to 10 s instead of answering 502
                lb_try_duration 10s
                lb_try_interval 250ms
                # take an upstream that fails its readiness out of rotation
                health_uri /api/health/ready
                health_interval 5s
                health_timeout 3s
                transport http {
                        dial_timeout 3s
                        # Evaluate disabling upstream keep-alive for webhook POST safety:
                        # stale pooled connections to a draining Node server
                        # can fail with "connection reset by peer" -> 502.
                        keepalive off
                }
        }
        encode gzip
}
```
Notes: `lb_try_duration` only retries when the connection could not be established or the request was not sent, so a webhook POST is not duplicated.
Apply with `caddy validate` then a graceful `caddy reload` (does not drop connections of any site), after a staging check. Rollback: restore the
previous block and reload. Requires explicit authorization because the file also serves Dentalpin.

## Outstanding validation before proposing any Caddy change
The isolated Docker lab has shown intermittent `UND_ERR_SOCKET` even when 12/12 in-flight slow requests finish. This is a real warning for non-idempotent WhatsApp webhook POSTs; **do not** hide it by retrying a POST after the body may have reached the server. Caddy's HTTP transport defaults to upstream keep-alive; its documentation warns that reused idle connections can produce 502 for non-idempotent requests when the upstream closes first. `keepalive off` is a *candidate mitigation*, not an approved fix. It trades additional connection setup for avoiding pooled stale sockets and requires a separate real-Caddy rehearsal under load. Validate Caddy configuration with `caddy validate`, check webhook response codes and Meta delivery/retries, and preserve the complete pre-change Caddyfile for rollback. The DNS alias transition may still have other failure modes. No change to shared Caddy or Dentalpin is authorized by this PR.
