# CALL-03B2 QA Graph and WebRTC peer simulator

This service is a QA-only substitute for the Meta Graph Calling endpoints. It is not part of the production application and must never be deployed to the production stack.

## Safety gates

The server refuses to start unless all of these are true:

- MOCK_ENVIRONMENT=qa
- MOCK_GRAPH_ENABLED=true
- The exact synthetic pilot phone-number ID, customer phone and WABA ID are configured.
- A fresh QA-only webhook signing secret and local control token are supplied.
- The webhook destination is loopback on the local WACRM app (127.0.0.1:3000 or localhost:3000).

The existing graph.facebook.com -> 127.0.0.1 override must remain in the QA app network namespace. The mock has no need for outbound internet access. It logs method and path only; never headers, query strings, bodies, access tokens or SDP.

## Simulated Graph endpoints

- GET /v27.0/{phone_number_id}/call_permissions: synthetic temporary permission, valid for seven days.
- POST /v27.0/{phone_number_id}/calls: connect, pre_accept, accept, reject, terminate.
- POST /v27.0/{phone_number_id}/messages: synthetic message ID only; no message is sent.
- Unsupported Graph paths fail closed with HTTP 400.

Every webhook is signed with the QA-only MOCK_META_APP_SECRET and delivered to the local WACRM webhook route. This exercises the real webhook signature check, durable inbox, processor and Calling persistence.

## Browser peer simulator

Open http://127.0.0.1:38090/peer in a second browser tab after opening the WACRM QA Inbox at http://127.0.0.1:38089.

1. Prepare the remote peer and grant microphone access.
2. For an outbound call, leave the peer page prepared and click Call in the WACRM tab. The peer page will answer the offer.
3. For an inbound call, click Simular llamada entrante, then accept it from the WACRM Inbox.
4. Use a headset. The peer and agent browser tabs both request microphone access.
5. Use Desconectar peer to test ICE disconnection and cleanup.

The peer UI is served on loopback only. It requires a local control token and does not expose an internet-facing admin endpoint.

## Compose integration

Use compose.qa-mock.override.yml as a reference overlay with the existing /opt/apps/call03b2-qa-stack/docker-compose.yml. Before applying it, confirm the existing mock-graph service name, TLS certificate filenames and network namespace. Keep the existing QA certificates and map their actual filenames to MOCK_TLS_CERT_FILE and MOCK_TLS_KEY_FILE if they differ.

Set two fresh random values in the QA stack's untracked .env:

- MOCK_META_APP_SECRET: also set as META_APP_SECRET in the QA app environment so the real webhook route can verify the synthetic HMAC.
- MOCK_CONTROL_TOKEN: used only by the loopback peer UI.

Do not copy values from production. Do not commit any secrets.

The peer server listens on 38090 inside the app's shared network namespace; publish it only as 127.0.0.1:38090:38090. The Graph TLS listener stays on loopback port 443 inside the shared namespace and is not published separately.

## Tests

Run the protocol tests with:

node --test scripts/qa/whatsapp-calling/mock-graph/server.test.mjs

The test suite uses Node built-ins and does not call Meta, WACRM or the network.

## CALL-03B2.6 fault injection — isolated QA ONLY

This is **OFF by default**. The fault route `POST /qa/faults` uses the existing local peer control token and requires `MOCK_FAULT_INJECTION_ENABLED=true` **only in the QA mock-graph service**. It must never be enabled in production and must not be added to the WACRM application image. The endpoint accepts a **known** `wacid.qa-<UUID>`, an action (`pre_accept`, `accept`, `reject`, `terminate`), and the only mode `after_effect_503`. Only one fault per call may be armed; it expires after 120 seconds and is consumed once.

### Operator workflow

1. Keep the existing app QA version, PostgreSQL QA, and Graph egress isolation unchanged. Review new mock PR, `node --test`, backup current QA mock image/config, then **separately authorize/recreate mock-graph** as appropriate for its shared app network namespace. Do not replace app or DB to run this test.
2. Set `MOCK_FAULT_INJECTION_ENABLED=true` **on mock-graph QA only**, with existing QA token. No real Meta calls.
3. In Peer QA (over SSH loopback), prepare the peer and start a **fresh synthetic incoming call**. Select the action and click **Armar fallo 503 de esta llamada** *before* taking that action in the WACRM Inbox.
4. For `pre_accept`, click Accept once. Expect WACRM HTTP 202 `success:false`, `signal_status=unknown`; do not retry. For `reject`, click Reject once; expect HTTP 202 `success:false`, `terminal_status=unknown`. `accept` and `terminate` similarly require their preconditions.
5. The mock **applies the action first** and then returns HTTP 503. This is a deterministic **ambiguous HTTP result**, not a real network timeout. In the QA Peer page, query the call's safe `graphActionCounts`; expect one for the armed action. The browser must not send another POST automatically. Record exact `call_id`, sanitized HTTP status/action counts, then use the corresponding *read-only* `unknown-signal` or `unknown-terminal` verification script from PR #148. Do not manually clear unknown states in shared QA.
6. Disable the QA fault flag after this test, reconcile ambiguous synthetic calls under a separate data-maintenance gate, and preserve evidence. Never merge #141 or this simulator increment into the production Calling integration PR.

The mock cannot prove delivery by real Meta, transport-layer timeouts, webhook order in production, or the full accept/terminate race. It only makes the application's fail-closed behavior reproducible without contacting Meta.
