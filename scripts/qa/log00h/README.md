# LOG-00H synthetic QA harness

Functional QA of the LOG-00H candidate (`e3b6d478`) on a throwaway GitHub Actions runner. **Synthetic data only.**

- Runs on push to `qa/log00h-synthetic` (`.github/workflows/log00h-qa.yml`).
- Starts a local Supabase, builds the app, then **cuts outbound network access** for the QA user and every container (`isolate.sh`),
  proving it with canaries before and after. Migrations, seed, app and tests run after that cut.
- Uses no repository secret and touches no remote database. The branch must be identical to the candidate outside this directory and the workflow.
- Evidence (report, per-row JSON, screenshots, logs) is uploaded for 7 days only if the secret scan passes. The repository is public: so is the evidence.

| File | Role |
|---|---|
| `seed.mjs`, `lib/world.mjs` | Two accounts, four roles each, catalogue, orders, payments, chats |
| `faults.sql` | QA-only triggers that fail two sentinel payment amounts |
| `tests/` | Matrix QA01–QA06 |
| `verify-schema.mjs`, `schema-reference.json` | Schema built from migrations vs reference values |
| `db-suites.sh` | The repository's `*.qa.test.ts` suites; failures are re-run on the base commit |
| `report.mjs`, `scan.py` | Report and secret scan |

These scripts refuse to run against anything but `127.0.0.1`; `isolate.sh` refuses to run outside GitHub Actions. Do not merge this branch.
