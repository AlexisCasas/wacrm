# WACRM roadmap and backlog (flows engine, P4 – P12)

Single source of truth for what has been built on the flows engine, what runs in production, and what is next.
Keep it short: details live in the design documents under `qa/` (see the last section). Nothing here names a customer.

_Last update: 2026-10-15 (closure of P12)._

## 1. Where production stands

| Item | State |
|---|---|
| Application image | P9 build (includes everything up to the P9 stage-B preparation). P10–P12 added only SQL, scripts and docs. |
| Database migrations | Applied up to **072**. |
| Flow authoring | **Global** (`FLOW_AUTHORING_SCOPE=all`): every current and future company can author the P4–P8 nodes. |
| Flow execution of P6–P8 features | **Off globally.** Two keys are required per company (environment list + database row in `flow_execution_enablement`). **No company is enabled.** |
| Cron | 5-minute legacy sweep (untouched), plus two 1-minute jobs (durable waits, recovery), idle while nobody is enabled. |
| Monitoring | Read-only monitor of alerts A1–A6 every 10 minutes (local log, rotation, lock, rate limit). Nothing is sent outside the server. |

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

**High priority**

| # | Item | Depends on | Done when |
|---|---|---|---|
| 1 | **P13 – controlled execution for a second company** | #4, #7, #8 | One further company enabled (both keys), own line and consenting contact, two supervised real runs pass, alerts A1–A6 stay at 0, one-line rollback (delete its row) tested. |
| 2 | **P14 – general execution with multitenant isolation** | #1, #9 | Global default on + `FLOW_EXECUTION_SCOPE=all` after an impact review; cross-company isolation tests pass; one to two weeks of observation with clean alerts. |
| 3 | **"Test flow" simulator (no WhatsApp)** | – | A flow can be dry-run from the editor with simulated sends and waits, with no real messages, no side effects on conversations. |
| 4 | **WhatsApp channel integrity check after the accidental ~21 s PostgreSQL stop** | – | Webhooks rejected in that window are reconciled (Meta retry or manual check of the delivery log); no inbound message lost; result recorded. |
| 5 | **Sanitised publication of the pending code** | – | P7 – P12 branches published as fast-forward descendants of the already public P6 branch, with the sanitisation checks of section 5. |

**Security and operations**

| # | Item | Done when |
|---|---|---|
| 6 | Controlled rotation of the previously exposed third-party (ManyChat) credentials | New credentials in place, old ones revoked, integrations re-verified. |
| 7 | Follow-up of ambiguous send outcomes and recovery | Runbook for `send_outcome_unknown` / `recovery_not_safe` (how to verify with the provider, how to close the run) and a periodic review. |
| 8 | Document End-node scope and return behaviour for customers | The default End ("end the whole execution") and the "return to caller" option are explained in the editor help and user docs; the "no exactly-once guarantee" caveat is stated. |
| 9 | Load and behaviour measurement with several companies running flows | Measured throughput of the 1-minute scheduler and recovery with N companies; limits and alert thresholds adjusted. |

**Deferred**

| # | Item | Done when |
|---|---|---|
| 10 | **P12.2** connect an SMTP/API provider, install the notifier, test a real send | Provider chosen and verified (SPF/DKIM), installer reviewed, first real incident mail received, silence confirmed with zero incidents. |
| 11 | External heartbeat to detect that the monitor itself stopped | Each good monitor run pings an external service; a missed ping alerts through a channel independent of the server. |

## 5. Publication rules (public repository)

- Public history is **sanitised**: no real company identifiers, personal e-mails, phone numbers, customer names, internal paths or host names, private operations documents or credentials.
- Branches are published as fast-forward descendants of the previous public branch; `main` and open pull requests are never touched; no force-push.
- A private commit map (original ↔ sanitised ↔ deployed image) is kept off the repository.

## 6. Where the details are

- `qa/subflow-exec/DESIGN-P8.md`, `DESIGN-GLOBAL.md` – design of call/return and of global enablement.
- `qa/subflow-exec/ops/` – monitor, alerts, cron/logrotate examples and the (deferred) notification layer.
- `qa/customer-reply/`, `qa/durable-wait/`, `qa/flows-safe-save/` – earlier stages.
- `CHANGELOG.md` – user-visible changes.
