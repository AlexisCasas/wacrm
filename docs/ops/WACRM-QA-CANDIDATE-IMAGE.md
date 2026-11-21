# WACRM — CALL-03B2.5 QA image artifact workflow

**Status: workflow infrastructure reviewed separately from Calling PR #144. Manual image builds, database changes and deployments require separate authorization.** This workflow is independent of the production-only `.github/workflows/wacrm-candidate-image.yml`.

## Safety contract

- `pull_request`: checks the workflow contract only. **No Docker build, no QA secrets, no VM access**.
- `workflow_dispatch`: gated build **only after this workflow is approved into `main`** and a protected GitHub Environment `qa-call03b2` is configured.
- The dispatch takes an exact 40-character SHA which **must equal the current HEAD** of either the PR #144 branch (`fix/whatsapp-calling-call03b2-5-terminal-reservation-20261121`) or the PR #146 branch (`fix/whatsapp-calling-call03b2-6-signal-fencing-20261121`), both explicitly enumerated. It cannot build arbitrary branches or unreviewed SHA values outside that branch.
- The job requires `github.ref == refs/heads/main`, and checks out that SHA directly. Build code at that SHA is still unmerged/under review: enable required environment reviewers, inspect the Dockerfile and branch commits before approving the job.
- No production `WACRM_NEXT_PUBLIC_*`, service-role key, Meta credentials, SSH, Supabase Cloud, registry push, VPS access, Docker load/compose, migrations or production deployment.
- `docker save | gzip` produces `image.tar.gz`; `manifest.json` includes full commit SHA, source tree, Docker image ID, tag, platform, QA config hashes, locale and `deployed=false`. `SHA256SUMS` covers both files; artifact retention 3 days.

## GitHub QA Environment setup — configured, runtime fingerprint verification pending

The repository administrator confirmed in screenshots on 21-Nov-2026 that **`qa-call03b2`** exists with **Required reviewers = AlexisCasas**, self-review restriction disabled for the single-reviewer setup, administrator bypass disabled, and **Selected branches and tags = `main` only**. The three QA environment variables and one environment secret are displayed as configured. **The secret value itself is not visible or verified yet**: the first separately authorized build must validate its SHA256 fingerprint; it must not be copied into chat or logs. Required reviewers is a one-person manual gate, not independent two-person approval.

Within **that Environment only**, add these values:

| Type | Name | Expected QA semantics |
|---|---|---|
| Variable | `WACRM_QA_NEXT_PUBLIC_SUPABASE_URL` | `http://127.0.0.1:38089` |
| Variable | `WACRM_QA_NEXT_PUBLIC_SITE_URL` | `http://127.0.0.1:38089` |
| Variable | `WACRM_QA_NEXT_PUBLIC_APP_LOCALE` | `en` |
| Secret | `WACRM_QA_NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Only the QA anon/publishable key** from the QA app.env; do not paste it in issues, chats, logs or repository files |

The workflow verifies the QA key's full SHA256 fingerprint:
`5f9a3ca08fa5dce7de6d6687647689c7fa2b8ffff33b6c99f98cf09cace8b00f`.
The fingerprint is a verification value, not a substitute for a secret. `NEXT_PUBLIC_*` values become part of the browser bundle by design; never put service-role or server secrets here.

The production workflow and its repo-level vars/secrets are left **unchanged**.

## Dispatch procedure (future separate approval)

1. Confirm the intended SHA is **exactly** HEAD of PR #144 at the time of dispatch; verify the code review and CI/Migrations checks.
2. Confirm QA environment protection is effective and QA build variables are correct. Approve the environment gate only for this run.
3. In **Actions → WACRM QA candidate image (manual, artifact only)**, select `main` and supply the exact `release_sha`.
4. Verify logs: `CALL03B25_QA_SOURCE_GATE=PASS`, `CALL03B25_QA_CONFIG_GATE=PASS`, `CALL03B25_QA_IMAGE_BUILD=PASS`, `CALL03B25_QA_ARTIFACT=PASS`.
5. Download `call03b2-qa-<sha40>` within 3 days. Only *after separate QA deployment authorization*, compare `SHA256SUMS`, OCI `org.opencontainers.image.revision`, `io.wacrm.source-tree`, image ID/platform and QA fingerprint before `docker load` on VPS.
6. The upload is **not a deployment**. QA database restore rehearsal, fresh backup and migration `20261201000000` are separate gates; migrate QA before starting any app querying the new columns.

## Browser and tunneling

The historical Firefox QA used SSH forwarding to `127.0.0.1:38089` (WACRM/Auth/REST) and `127.0.0.1:38090` (peer mock). A GitHub runner **can build** with literal loopback origins without connecting to QA. In a tester's browser the loopback points to the tester's own machine: **verify that SSH forwarding is active** and Auth redirects/cookies match before QA. Keep VPS ports bound to loopback and Meta real calls disabled.

## Known limitations

- This workflow will **not** be callable manually while it exists only in a Draft PR branch; GitHub must have the workflow on the default branch. Separately approve merging this **workflow infrastructure PR only** (not Calling PR #144) after its review, QA Environment setup and protections.
- The exact PR #144 branch head may change as code is hardened. Use the current HEAD SHA of the selected authorized branch at dispatch, not a stale SHA.
- The remaining `pre_accept`/`accept` in-flight versus terminal reservation race, and same-agent multi-tab claim ownership, remain blockers for functional Calling merge and real Meta pilot.
- ROOT A2 used `docker run --rm --network none ... grep` to inspect the old QA image. This created and removed one ephemeral, network-disabled container: **a documented exception** to the literal 'no Docker modification' rule. No persistent Docker change or DB mutation was reported, but the run was not strictly read-only.

## CALL-03B2.6 extension — reviewed independently

The SHA gate now also permits the exact current HEAD of PR #146, stacked on #144, for isolated QA of the `accept`/`terminate` fix. This does **not** permit arbitrary branches or any repository-level production secrets, and does not run a build automatically. For the final integrated QA, prefer the SHA of #146 once CI and Migrations pass; the #144 image lacks the signaling fencing fix.

This infrastructure-only extension requires its own approved PR merge into `main` before manual dispatch. The Environment `qa-call03b2` remains restricted to `main` and requires human review.
