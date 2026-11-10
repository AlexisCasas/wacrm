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
                }
        }
        encode gzip
}
```
Notes: `lb_try_duration` only retries when the connection could not be established or the request was not sent, so a webhook POST is not duplicated.
Apply with `caddy validate` then a graceful `caddy reload` (does not drop connections of any site), after a staging check. Rollback: restore the
previous block and reload. Requires explicit authorization because the file also serves Dentalpin.
