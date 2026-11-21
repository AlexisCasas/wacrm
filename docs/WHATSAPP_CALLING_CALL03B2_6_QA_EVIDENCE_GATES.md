# CALL-03B2.6 — Evidence gates for shared QA

**Scope:** PR #146 (HEAD `17c4c86189bac64a351ebfb86b36466e0e50a418`). This QA-only addition is stacked on #146. **Do not merge to main, re-deploy QA or enable Meta calls because of this document.** Production remains outside scope.

## Recorded baseline (operator report, 21 Nov 2026)

- PostgreSQL QA: 24 sessions: 6 outgoing terminated; 15 incoming terminated; 3 incoming rejected.
- Most recent incoming session created at `2026-11-21 18:18:48.714064+00` is terminated, signal acknowledged, terminal acknowledged.
- Active calls, active claims, retained SDP and reserved/unknown signal or terminal outcomes: zero.
- UI accept/terminate was reported PASS. **A new, independent reject-before-answer was not proved**. The three rejected sessions are old.
- CI and Migrations for #146 PASS. A DB race proven on the CI instance is **not** a second-agent browser race proved on the VPS.
- A previous restore-test was explicitly waived. SHA256 and pg_restore list do not establish restorability.

## Gate R — independent reject-before-answer

1. Keep the browser on WACRM QA via SSH tunnel (127.0.0.1:38089) and Peer QA (127.0.0.1:38090/peer). Confirm mock-only networking and disable any real-Meta path.
2. From Peer QA create a **new** incoming synthetic call, capture its exact `wacid.*` identifier and UTC creation time. Do not reuse an accepted/terminated call.
3. Before touching Accept, press **Reject once** in the Inbox. Verify the Peer QA shows termination/rejection. Do not press Accept or retry automatically.
4. On the VPS, run the shell verifier below with that newly recorded call_id. It checks the exact call rather than inferring success from historical totals.
5. If result is BLOCKED or FAIL, capture sanitized app and mock events for that call; do not mark PASS or retry a possibly ambiguous Meta request.

```bash
bash scripts/qa/whatsapp-calling/verify-call03b2-6-live-qa.sh reject 'wacid.REPLACE_WITH_NEW_QA_CALL_ID'
```

Expected: `CALL03B26_QA_REJECT=PASS|sessions=25|rejected=4|active=0|claims=0|sdp=0|reserved=0|unknown=0` **if no other calls have occurred**. Counts may rise, so the script tests strict increase over 24 and 3 instead of exact totals. A PASS additionally requires an attributed rejection, no acceptance, terminal action reject acknowledged, no prior signaling, no retained SDP/claim, and timestamp later than the baseline. It does not prove the peer response by itself—retain peer observation.

The verifier is read-only: validates the Compose project, uses `PGOPTIONS=default_transaction_read_only`, `BEGIN READ ONLY`, a parameterized call_id and `ROLLBACK`; prints only aggregates, never agent IDs, SDP or customer details. Run it only on the designated QA host. **This script does not generate synthetic calls.**

## Gate C — distinct-agent concurrency

Use two separately authenticated QA agents A and C in two independent browser profiles, the *same* conversation and one *new* incoming synthetic call.

- Both press Accept nearly simultaneously. Only one may claim the call (HTTP 200); the losing agent should get 409 **before requesting a microphone** and must not send pre_accept/accept.
- Winning agent alone sends pre_accept then accept; it may end the call. Peer mock must see a single accepted call, no duplicated external actions.
- Obtain authorized sanitized server logs for both agents and call_id. Read PostgreSQL after termination: exactly one call row, `accepted_by_user_id` equals the winner, `ended_by_user_id` the real closer, no active claim, SDP or reserved action.
- Repeat with deliberately staggered accept and terminate requests if the mock exposes deterministic delays; otherwise label **RACE_NOT_EXECUTED**, not PASS. Do not use `verify-signal-terminal-concurrency.sh` on shared QA: that script writes and deletes CI fixtures.

## Gate U — outcome unknown (separate synthetic call)

This gate requires a **controlled mock-only fault** and explicit QA authorization because it writes a new call and produces an uncertain state. Never inject faults into real Meta or a production tenant. Target only the new `wacid.*` fixture:

- Drop/delay a `pre_accept` or `accept` Graph response after it is dispatched. Confirm HTTP 202 with `success:false`, `signal_status:'unknown'`; no automatic retry, no extra Graph POST, and no audio enabled.
- For a *different* new call, drop/delay a reject/terminate Graph response. Confirm HTTP 202 with `success:false`, `terminal_status:'unknown'`; no automatic repeat or agent attribution falsely recorded as confirmed.
- Run the appropriate verifier below. It checks the durable reservation exists but cannot infer whether Meta acted; treat `unknown` as requiring manual reconciliation.
- Do not clear `unknown` with UPDATE, cron, rollback of shared QA data or re-send requests to make the test green.

```bash
bash scripts/qa/whatsapp-calling/verify-call03b2-6-live-qa.sh unknown-signal 'wacid.NEW_QA_SIGNAL_CALL'
bash scripts/qa/whatsapp-calling/verify-call03b2-6-live-qa.sh unknown-terminal 'wacid.NEW_QA_TERMINAL_CALL'
```

If unknown fixtures remain, the overall QA state is **PENDING_RECONCILIATION**, even if the individual durability checks pass. Reserve a controlled cleanup gate with evidence of the external mock result; a no-data-loss QA policy takes priority over forcing zero unknowns.

## Release criteria

Only consider CALL-03B2.6 ready for review after R, C, race A/B, U, history projection and smoke have independent evidence. Include browser/peer observation, sanitized API status codes, SQL aggregates, CI results and SHA of running QA image. The current PR chain #142 → #143 → #144 → #146 is stacked, and mock tooling #141 must remain excluded from production.

**No automatic merge, production deployment, Supabase Cloud changes, or enabling the real Meta calls webhook.**
