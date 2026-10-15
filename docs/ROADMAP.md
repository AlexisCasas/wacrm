# WACRM roadmap and backlog (flows engine, P4 – P12)

Single source of truth for what has been built on the flows engine, what runs in production, and what is next.
Keep it short: details live in the design documents under `qa/` (see the last section). Nothing here names a customer.

_Last update: 2026-10-15 (P14: general availability)._

## 1. Where production stands

| Item | State |
|---|---|
| Application image | P9 build (includes everything up to the P9 stage-B preparation). P10–P14 added only SQL, scripts, configuration and docs. |
| Database migrations | Applied up to **072**. |
| Flow authoring | **Global** (`FLOW_AUTHORING_SCOPE=all`). |
| Flow execution of P6–P8 features | **Generally available (P14)** for every current and future company: `FLOW_EXECUTION_SCOPE=all` and `flow_execution_defaults` = on/on. A company row in `flow_execution_enablement` still overrides the default in both directions (explicit exceptions). |
| Cron | 5-minute legacy sweep (untouched), plus two 1-minute jobs (durable waits, recovery) that now serve every company. |
| Monitoring | Read-only monitor of alerts A1–A6 every 10 minutes (local log, rotation, lock, rate limit). Nothing is sent outside the server; review it by hand (`qa/subflow-exec/ops/REVISION-MANUAL-ALERTAS.md`). |

## 2. What is done

### P4 – P8: flows engine capabilities
- **Flow search and filter/sort in the list; folders; tag and custom-field conditions; atomic draft save** (migration 067).
- **Sub-flow authoring and searcher**: "Run another flow" node with a searchable picker, cycle and depth validation, authoring guards in the database (migrations 068, 069).
- **Durable waits** (migration 069): a Delay survives restarts; a scheduler resumes due waits exactly once.
- **Customer-reply condition**: "Did the customer write since reference message X?", with a persisted reference, cheap check and fail-closed behaviour.
- **Call and return between flows** (migration 070): persistent call stack (A → B → A → C → A), `End` node scope (`run` ends the whole execution, `subflow` returns), depth ≤ 3, ≤ 8 calls per run, graph hashes pinned at call time, "stop/continue on customer reply" policy.
- **Send-intent journal and conservative recovery**: before each send of a P6–P8 flow an intent event is stored; after a crash the engine never re-sends an ambiguous message (`send_outcome_unknown`, `recovery_not_safe`).
- **Execution verified end to end with real WhatsApp**: two supervised runs on a pilot company, both passed (full A → B → A → C → A path with four messages; early reply detected during the wait, follow-up and sub-flow C skipped).

### P9 – global authoring
- Authoring of all of the above is available to every company (no per-company allow-list for the editor); execution stays gated.
- Per-company/global execution defaults and gate functions (migration 071), activation guards in the database, capability endpoint, validation messages in es/en/ko.

### P14 – general availability (2026-10-15)
- Execution of sub-flows, call/return, durable waits, the customer-activity condition, inherited references and End scopes enabled for **all companies**, with no company list to maintain. No flow was activated, edited or run by the change; existing drafts stay drafts.
- Enabled in two steps (environment first with the database still off, then the database default), rehearsed rollback on a restored copy of production data: `qa/subflow-exec/p14/` (enable and rollback scripts, runbook).
- User guide: `docs/CONNECTED-FLOWS.md`.

### P10 – P12 – pilot close and operations
- Migration **071** (execution defaults, all off) and **072** (call stack is archived into the run's own event log and removed when a run leaves `active`; fixes the leftover frame found in the pilot). Rollback scripts exist for both.
- Pilot closed: its three flows were returned to draft, its enablement row removed, zero companies enabled.
- **Read-only alert monitor A1–A6** installed (every 10 minutes): `send_outcome_unknown`, `recovery_not_safe`, overdue waits not resumed, frames of ended runs, stranded runs, runs standing in a flow that is no longer active. A known historic frame is excused in A4 only.

## 3. Deferred (prepared, NOT done)

### P12.2 – e-mail notifications — **DEFERRED**
- Prepared and tested with a simulated provider: incident journal, reviews at **12:00 and 18:00 America/Lima** (17:00 and 23:00 UTC), one consolidated mail **only when there are incidents**, never an empty report; resolved incidents reported once; failed sends are retried at the next review; a failed check or a stopped monitor counts as an incident. 22/22 tests pass.
- **Not installed, not sent.** No SMTP/API provider is configured and none will be contracted for now. The recipients are kept in a private operational note, not in this repository.
- The code stays in the repository (`qa/subflow-exec/ops/`) to be resumed later (item 10 below).

## 4. Backlog (prioritised)

Items P13 (second-company pilot) and P14 (general execution) were merged: P14 shipped directly after two real WhatsApp scenarios passed.

**High priority**

| # | Item | Done when |
|---|---|---|
| 1 | **Visual check of the editor as a normal company** (the capability banner shows execution as available) | One look in the flow editor of a company that never had a list entry. |
| 2 | **Legacy runs under the recovery job**: a legacy run stranded on an automatic node is now resumed after 5 minutes instead of waiting for the 24 h timeout | Decide to keep, or restrict recovery to graphs that use the new features (small engine change). |
| 3 | **Scheduler throughput**: 25 due waits per minute per pass | Raise the pass limit (cron parameter, max 200) when the volume of waits needs it; alert A3 shows when it is behind. |
| 4 | **`messages_status_check` violations** (code 23514) logged when a delivery status is stored; present before P14 (about a dozen per day) | Find which provider status violates the constraint and accept it or extend the constraint. |
| 5 | Follow-up of ambiguous send outcomes and recovery | Runbook for `send_outcome_unknown` / `recovery_not_safe` and a periodic review (see the manual alert review). |

**Security and operations**

| # | Item | Done when |
|---|---|---|
| 6 | Controlled rotation of the previously exposed third-party (ManyChat) credentials | New credentials in place, old ones revoked, integrations re-verified. |
| 7 | Load measurement with several companies running connected flows | Measured throughput and thresholds adjusted. |
| 8 | Remove the stale per-feature authoring lists from the environment (`FLOW_*_AUTHORING_ACCOUNT_IDS`, ignored under `all`) | Next planned app recreation. |

**Deferred**

| # | Item | Done when |
|---|---|---|
| 9 | **"Test flow" simulator (no WhatsApp)** | A flow can be dry-run from the editor with simulated sends and waits. |
| 10 | **P12.2** connect an SMTP/API provider, install the notifier, test a real send | Provider verified (SPF/DKIM), first real incident mail received, silence confirmed with zero incidents. |
| 11 | External heartbeat to detect that the monitor itself stopped | Each good monitor run pings an external service that alerts when pings stop. |

## 5. Publication rules (public repository)

- Public history is **sanitised**: no real company identifiers, personal e-mails, phone numbers, customer names, internal paths or host names, private operations documents or credentials.
- Branches are published as fast-forward descendants of the previous public branch; `main` and open pull requests are never touched; no force-push.
- A private commit map (original ↔ sanitised ↔ deployed image) is kept off the repository.

## 6. Where the details are

- `docs/CONNECTED-FLOWS.md` – user guide (sub-flows, End scopes, durable waits, limits).
- `qa/subflow-exec/p14/` – P14 enable / rollback scripts and runbook.
- `qa/subflow-exec/DESIGN-P8.md`, `DESIGN-GLOBAL.md` – design of call/return and of global enablement.
- `qa/subflow-exec/ops/` – monitor, alerts, cron/logrotate examples and the (deferred) notification layer.
- `qa/customer-reply/`, `qa/durable-wait/`, `qa/flows-safe-save/` – earlier stages.
- `CHANGELOG.md` – user-visible changes.
