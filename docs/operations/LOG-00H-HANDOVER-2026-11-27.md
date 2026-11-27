# WACRM — LOG-00H Handover and execution plan

**Updated:** 2026-11-27  
**Purpose:** Handover to a new engineering team. This document is the current index for LOG-00R / LOG-00H, synthetic QA, payment idempotency and the next release gates.

## 1. Executive status

- Production has **not** been modified by this workstream: no deploy, merge, production migration, production DB write or customer message.
- Production provenance was re-audited on 2026-11-27: active `wacrm-app-1` is built from commit `68c5362e20b3e3e2ecd948a949cfe1429073acc1` (`wacrm-app:inbox-height-68c5362e`). This commit exists in GitHub and is now additionally anchored by `release/prod-baseline-68c5362e-20261127`.
- `origin/main` is **not** the production lineage and must not be used as a deployment source for this release. It is hundreds of commits behind the deployed lineage.
- LOG-00H candidate is published in PR [#175](https://github.com/AlexisCasas/wacrm/pull/175), HEAD `e3b6d4780f3212ba0b3cd34a266c2e58e5c58f2e`, Draft, not merged.
- CI and migration checks for the LOG-00H candidate passed in run [#46010951268](https://github.com/AlexisCasas/wacrm/actions/runs/46010951268) and the corresponding migration checks from the same candidate cycle.
- Synthetic QA infrastructure now runs in GitHub Actions rather than on the production VPS. The QA run completed the matrix but correctly returned FAIL due to three payment retry defects and one test-selector defect; later selector correction is in the QA branch but a full run against the payment fix is still required.
- Payment retry remediation is in PR [#181](https://github.com/AlexisCasas/wacrm/pull/181), Draft, not merged. Current head `ce07368f4d774ac3b348be08f4d19decc48fbe2b`; its functional tree is the PAY candidate stacked on LOG-00H `e3b6d478`.
- PR #181 CI is **not fully green**: Migrations succeeded, one CI run succeeded, but a later CI run failed one unrelated inbox unit test. Do not treat the PR as CI-green until the failing test is resolved or explicitly classified with baseline evidence.
- The PR #179 QA harness is Draft and based on #175. Current head `f169057f1657bca523930c6e44f7df2c18c2b54d`. It has the corrected accessible selectors for the confirmed-orders UI test. It has not yet been rerun against the PAY remediation in #181.

## 2. PR register

| PR | Purpose | Current state | Base / head |
|---|---|---|---|
| [#173](https://github.com/AlexisCasas/wacrm/pull/173) | LOG-00R preservation of five VPS-only commits | Draft; preservation/reference branch; do not merge casually | base Calling branch / head `68c5362e` |
| [#174](https://github.com/AlexisCasas/wacrm/pull/174) | Register existing migration `20261206000001` in release manifest | Draft; its manifest change is already included in #175 | base `68c5362e` / head `3a98a68d` |
| [#175](https://github.com/AlexisCasas/wacrm/pull/175) | LOG-00H: derive to Commercial, safe changed-fields save, restore Edit Order | Draft; functional candidate; no merge | base `68c5362e` / head `e3b6d478` |
| [#179](https://github.com/AlexisCasas/wacrm/pull/179) | Synthetic isolated QA harness | Draft; harness only; no merge | base #175 head `e3b6d478` / head `f169057f` |
| [#181](https://github.com/AlexisCasas/wacrm/pull/181) | PAY-01–PAY-04 payment retry idempotency candidate | Draft; not merged; CI needs final review | base #175 head `e3b6d478` / head `027a3665` |

PR #180 was closed after discovering its base was unsuitable; PR #181 is the current payment remediation PR. PRs #176–#178 were superseded during QA-harness iteration; do not use them as current candidates.

## 3. LOG-00R / LOG-00H functional scope

### LOG-00R
- Production provenance audit identified five commits present on the VPS but not initially on GitHub.
- Those commits were preserved on GitHub in #173; images were exported on the VPS to `/opt/backups/wacrm/log00r-preserve-20261127T052059Z`.
- The backup is on the same disk and is not an off-server disaster-recovery copy.
- Historical rollback script was not updated/validated by this workstream.

### LOG-00H in #175
- Restore “Derivar a Comercial” in Logistics, with server-side authorization.
- Save only changed order fields; avoid rewriting legacy order lines/totals when unchanged.
- Restore “Editar pedido” for agency/department and preserve catalogue links on untouched lines.
- Provide recovery guidance for inactive catalogue products.
- CI general and migration checks passed for the candidate.
- Functional QA found a payment retry defect present in the candidate baseline as well as the observed production code provenance; it has not been reproduced by writing to production.

## 4. Synthetic QA and GitHub Actions history

All synthetic QA runs use fictitious data in ephemeral GitHub Actions runners; they do not use production DB or VPS resources. Workflow artifacts have limited retention and are visible because the repository is public. Do not publish real customer data, secrets, production function bodies or sensitive metadata.

| Run | Commit | Result / learning |
|---|---|---|
| [45954005404](https://github.com/AlexisCasas/wacrm/actions/runs/45954005404) | Initial QA harness | Failed before service tests: Playwright 1.59.1 did not support runner's Ubuntu 26.04 target. |
| [45954181977](https://github.com/AlexisCasas/wacrm/actions/runs/45954181977) | Runner pinned to Ubuntu 24.04 | Chromium/Supabase and 139 migrations passed; REST readiness probe returned 403 because it queried a restricted application table. |
| [45955110688](https://github.com/AlexisCasas/wacrm/actions/runs/45955110688) | REST probe correction | Progressed through migrations/schema; synthetic seed failed on restricted `profiles` access. |
| [45956113465](https://github.com/AlexisCasas/wacrm/actions/runs/45956113465) | Seed profile correction | Seed advanced; `accounts` metadata write still used PostgREST and failed due to restricted grants. |
| [45956954343](https://github.com/AlexisCasas/wacrm/actions/runs/45956954343) | Seed accounts correction | Failed on restricted `contacts` access; confirmed need for privileged seed path only inside disposable local DB. |
| [45957833201](https://github.com/AlexisCasas/wacrm/actions/runs/45957833201) | Contacts/conversations/messages seed correction | Failed because `execFileSync` import was missing. |
| [45958583492](https://github.com/AlexisCasas/wacrm/actions/runs/45958583492) | Intermediate | Cancelled; do not count as validation. |
| [45958589891](https://github.com/AlexisCasas/wacrm/actions/runs/45958589891) | Import correction | Harness still required subsequent end-to-end correction. |
| [46010941835](https://github.com/AlexisCasas/wacrm/actions/runs/46010941835) | `21f07779` | Full 74-row matrix executed: 69 PASS, 4 FAIL, 1 NA. Payment retry duplication reproduced in 03.8a/b/c; 05.2 was a harness selector mismatch. Teardown PASS. |
| [46010951268](https://github.com/AlexisCasas/wacrm/actions/runs/46010951268) | `21f07779` | General CI SUCCESS. |
| [46014206494](https://github.com/AlexisCasas/wacrm/actions/runs/46014206494) | `f169057f` | QA rerun after selector correction; still FAIL. Review exact job logs before interpreting. |
| [46014218975](https://github.com/AlexisCasas/wacrm/actions/runs/46014218975) | `f169057f` | Harness branch CI SUCCESS; this is not the functional QA result. |
| [46014113646](https://github.com/AlexisCasas/wacrm/actions/runs/46014113646) | Payment PR CI cycle | Migrations SUCCESS. |
| [46014113647](https://github.com/AlexisCasas/wacrm/actions/runs/46014113647) | Payment PR CI cycle | CI SUCCESS. |
| [46014142794](https://github.com/AlexisCasas/wacrm/actions/runs/46014142794) | Payment PR CI cycle | CI FAILURE: one unit test in `src/components/inbox/conversation-list.test.tsx`, test “tagCatalogVersion invalidation … preserves selectedTagIds / OR-filter behavior across a catalog refresh”; unable to find menuitemcheckbox “Favoritos”. The test file blob is identical between #175 and #181, so this failure is not introduced by the PAY diff; keep it classified separately from PAY. |
| [46017665725](https://github.com/AlexisCasas/wacrm/actions/runs/46017665725) | Combined PAY candidate + synthetic harness | Candidate integrity PASS; build, migrations, schema, SQL suites, DB suites, seed, app start, **functional matrix**, isolation, collection and artifact publication all PASS. Final workflow conclusion is FAILURE only because the final `Verdict` step failed. Evidence artifact `log00h-qa-evidence` was published. Do not promote until the Verdict cause is read and classified. |

The workflow history includes repeated runs triggered by pushes and PR events. Always verify each run's exact `head_sha`; never infer success from a run on an older commit.

## 5. Payment defect — reproduced in isolated QA

The LOG-00H synthetic QA run reproduced three retry cases:
- 03.8a: confirmation failure followed by retry creates a second recorded payment.
- 03.8b: lost response from register followed by retry creates a second payment.
- 03.8c: lost response from confirm followed by retry creates a second confirmed payment; the synthetic example's confirmed total increased from 20 to 40.
- 03.8d: failure before request reaches server did not create a duplicate.

Cause identified in candidate UI:
- `PaymentsSection` creates a new `request_key` for each newly opened registration form.
- After a failed/uncertain POST, the UI showed an error but did not reconcile the server state before the next attempt.
- The database RPC already supports replay for the same `(account_id, request_key)` and rejects conflicting payloads.

### PAY-01–PAY-04 candidate in #181
- Persist logical registration key and original draft in tab-scoped `sessionStorage` before sending.
- Reuse same key and payload after uncertain response/form reopen.
- Expose `request_key` in payment panel read model to reconcile whether the payment was already created.
- Reload panel after failed action.
- Rotate/clear key only after success / a new logical operation.
- Added a UI regression test for uncertain response, close/reopen, and same-key/same-payload retry.
- No SQL/RPC or production schema changes were made in #181.

**Important review item:** #181 needs a thorough code review before accepting the approach. Confirm stale session attempts cannot be silently discarded, payload changes cannot reuse an old key with changed amount, and the server remains the ultimate idempotency authority. The current implementation is a candidate, not yet proven correct.

## 6. Remaining QA gaps and findings

- Payment QA must be rerun against #175 + #181 and prove one payment / one confirmed amount for all uncertain outcomes.
- The 05.2 selector was corrected to use actual accessible labels `/openOrder/` and `loadMore`; the pagination behavior still needs runtime proof.
- One existing database test `customer-message.qa.test.ts` failed on both baseline and candidate (expected claimed=1/failed=1, got 0/0); classify as pre-existing only after keeping its baseline evidence. Do not change it within LOG-00H without separate scope.
- Five DB tests were skipped because the full Shalom simulator/server is unavailable; they remain NOT_RUN.
- Schema privilege fingerprint showed two function-grant differences in local QA vs production, while table/column privileges matched. Investigate separately; do not loosen grants.
- The migration `20261206000001` is recorded as `pending` in the release manifest but its column/default/constraint/comment/function body/grants were verified present in production in read-only audit. **Do not re-run it in production** based only on manifest status.

## 7. Security and infrastructure notes from LOG-00H.2R

- Existing `parity-qa` contains real customer data. Do not use it for tests or modify/delete it without its owner's approval.
- Eight DB dump files were reported world-readable (two WACRM, six Denplant). A separate read-only inventory and controlled remediation plan is required; do not change permissions blindly.
- Squid proxy port 3128 was reported exposed in firewall but authentication is required. Verify actual bind/interface/ACL and business need before any firewall change.
- Production VPS has no swap; prefer GitHub ephemeral runners for QA/build to avoid resource pressure.
- No production data restore was approved or executed.

## 8. Next execution plan

### Phase A — finish PAY-01–PAY-04
1. Review #181 diff and the payment UI test; inspect all request-key lifecycle transitions.
2. Fix the unrelated failing inbox test only if it reproduces on the correct baseline; otherwise document baseline evidence and keep it separate.
3. Get CI and Migrations green on the latest #181 HEAD.
4. Ensure #179 harness uses #181 candidate as its code under test (not just #175). Keep harness-only and application changes separated; do not merge #179.
5. Run payment tests first: 03.8a, 03.8b, 03.8c, 03.8d, same-key API replay, conflicting-key payload, double-click, and legitimate new payment.
6. Require assertions: exactly one payment row, correct status, paid_confirmed counted once, balance correct, and audit events consistent.

### Phase B — complete regression matrix
7. Run full 74-row matrix against exact combined candidate (#175 + #181 + corrected harness).
8. Verify 05.2 list and pagination at runtime.
9. Report every row as PASS / FAIL / NOT_RUN / NA; no inferred PASS.
10. Preserve artifacts only if synthetic and secret-scanned; note their public visibility and expiry.

### Phase C — release readiness
11. Keep #173/#174/#175/#179/#181 as Draft until the release stack is reviewed and CI/QA gates pass.
12. Resolve the dependency/base-branch strategy before merging: #175 is based on #173's preserved code; #181 is stacked on #175's head; #179 is a test harness and should not be merged into production.
13. Only after formal QA approval prepare a separate production deployment plan with Claude Code.
14. No production deployment, migration, payment test, or customer message without explicit approval.

## 8A. Production lineage audit — 2026-11-27

Read-only VPS audit confirmed:
- Active production commit: `68c5362e20b3e3e2ecd948a949cfe1429073acc1`.
- Active image: `wacrm-app:inbox-height-68c5362e`.
- The production code commit exists on GitHub and is the exact base of PR #175.
- PR #175 is 2 commits ahead of production and 0 behind.
- PR #181 is stacked on #175 and is 8 commits ahead of production and 0 behind.
- The application code running in production is preserved in GitHub. Operational scripts and Compose overrides on the VPS are not fully represented in Git and must be preserved independently during any future deployment.
- `origin/main` is not safe as a release source for this stack. Future release preparation must start from production commit `68c5362e` or a verified descendant.
- Stable GitHub anchor created: `release/prod-baseline-68c5362e-20261127` -> exact production commit.

**Production remains untouched.** This audit and GitHub anchoring do not authorize deployment.

## 9. Responsibilities for the incoming team

- **GPT + GitHub MCP:** inspect repo/PRs/workflows, review diffs, implement code on independent branches, write tests/docs, run/inspect CI and QA workflows, maintain this handover document.
- **Claude Code + VPS:** read-only production provenance/health/schema inspection; backup and deployment preflights; production DB checks only when explicitly authorized; controlled deployment/rollback only after approval.
- **Human owner:** approve production changes, migration execution, security remediation, merge and deployment gates.
- Do not ask Claude to implement changes already being developed by GPT on GitHub. Coordinate one active branch owner at a time.

## 10. First steps for the next team

1. Read this handover document.
2. Read PRs #175, #179 and #181, including all review comments.
3. Check the latest workflow runs and compare their `head_sha` with each PR HEAD.
4. Start with reviewing #181; do not assume the current retry implementation is complete.
5. Continue with PAY tests, then the full 74-row matrix.
6. Use Claude Code only for VPS work and production read-only verification unless the owner authorizes more.

**Current release gate: NO-GO.** Production remains unchanged.