# LOG-00H synthetic QA harness

Functional QA of the LOG-00H candidate (`e3b6d478`) on a throwaway GitHub Actions runner. **Synthetic data only.**

- Runs on push to `qa/log00h-synthetic` (`.github/workflows/log00h-qa.yml`).
- The workflow appends `api.auto_expose_new_tables = true` to the runner's copy of `supabase/config.toml`: the live project grants the API roles on new
  objects of `public` by default and the migrations rely on it. Without it the app cannot read its own tables (`42501`).
- Starts a local Supabase, builds the app, then **cuts outbound network access** for the QA user and every container (`isolate.sh`),
  proving it with canaries before and after. Migrations, seed, app and tests run after that cut.
- Uses no repository secret and touches no remote database. The branch must be identical to the candidate outside this directory and the workflow.
- Evidence (report, per-row JSON, screenshots, logs) is uploaded for 7 days only if the secret scan passes. The repository is public: so is the evidence.

| File | Role |
|---|---|
| `seed.mjs`, `lib/world.mjs` | Two accounts, five users each, catalogue, orders, payments, chats |
| `lib/db.mjs` | Privileged preparation through the local postgres connection: parameterized, one transaction per operation |
| `lib/seed-checks.mjs` | Counts, roles, stages, payments and referential integrity read back after seeding |
| `faults.sql` | QA-only triggers that fail two sentinel payment amounts |
| `tests/` | Matrix QA01–QA06 |
| `verify-schema.mjs`, `schema-reference.json` | Schema and effective privileges vs reference values read from the live database (counts and digests only) |
| `db-suites.sh` | The repository's `*.qa.test.ts` suites; failures are re-run on the base commit |
| `collect.sh`, `teardown.sh` | Evidence copy, then stop everything and check nothing is left |
| `report.sh`, `report.mjs`, `scan.py` | Report with the closing criteria and secret scan; the job is green only if all are PASS |

These scripts refuse to run against anything but `127.0.0.1`; `isolate.sh` refuses to run outside GitHub Actions. Do not merge this branch.


## P0-01 candidate run

This harness copy targets the production-derived candidate `88c3c2b4dcc10452ef253f0d1bbc6c5719dee12d` with baseline `c52ed8d2b8486c06c11fa79f11a9a08007b4ec90`. It is an isolated GitHub Actions runner; all data are synthetic.
