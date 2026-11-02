# Whole-word keyword matching for regional flows (`match_type: "word"`)

Status: **proposal + implementation, NOT merged, NOT deployed, no production data changed.** Opt-in per flow; every existing flow keeps its behaviour.

## 1. Problem

A keyword flow starts when the customer's message *contains* one of its keywords (case-insensitive substring) and, when several flows match, the earliest created wins.
That is right for long advertising texts and wrong for short place names, which is what regional flows (one per city or department) use:

- "Ica" also matches inside "eléctrica", "práctica", "pública".
- "jaen" never matches "Jaén" (accents are not folded).
- A generic word ("para", "provincia", "nueva") fires a regional flow on unrelated messages.
- Two flows claiming the same name are resolved by creation order, i.e. arbitrarily.

## 2. What changes

| File | Change |
|---|---|
| `src/lib/flows/keyword-match.ts` (new) | `normalizeForWordMatch`, `wordMatchSpecificity`, `isWordFlow`, `pickEntryFlow` (pure functions). |
| `src/lib/flows/engine.ts` | `matchesKeywordTrigger` understands `word`; `findEntryFlow` delegates the choice to `pickEntryFlow`. |
| `src/lib/flows/types.ts` | `match_type` gains `"word"`; new optional `word_priority`. |
| `src/lib/flows/validate.ts` | Validates `match_type`, `word` keywords and `word_priority` (activation-time checks only). |
| tests | `keyword-match.test.ts`, `dispatch-word.test.ts`, additions to `engine.test.ts` and `validate.test.ts`. |

No migration, no new table, no new environment variable, no UI change (the flow editor spreads `trigger_config`, so `match_type`/`word_priority` set in the database survive an edit).

## 3. Behaviour

`trigger_config.match_type = "word"` (per flow):

1. **Whole words, folded.** Text and keyword are lower-cased, stripped of accents and diacritics, and every run of non-letters/digits becomes one space. The keyword must appear as a run of whole words. "ICA." matches "Ica"; "eléctrica" does not; "san martin" matches "San Martín"; a multi-word keyword needs all its words, contiguous and in order. `case_sensitive` is ignored (validation warns).
2. **Tiers.** All flows that are not `word` are evaluated first, in creation order, with exactly the previous logic (`contains`, `exact`, `first_inbound_message`). Only if none matches do `word` flows compete. A commercial/advertising flow can therefore never be pre-empted by a regional one, whatever their creation order.
3. **Most specific wins, one flow only.** Among `word` flows the winner has the keyword with the most words ("nuevo chimbote" beats "chimbote"), then the highest `word_priority` (explicit non-negative integer in the flow, default 0; e.g. department = 1, city = 2).
4. **Ties are not decided.** If two *different* flows are equally specific, nothing starts, a `[flows] ambiguous word match` warning is logged with the flow ids, and the message stays in the Inbox for a person. Creation order is never used to break a tie.
5. `restrictToFlowIds`, manual-trigger flows, active-run handling and button taps (title and reply id are both offered) are unchanged.

`match_type: "word"` is **off by default**: nothing changes until a flow's `trigger_config` is edited to use it.

## 4. Compatibility with the existing flows and accounts

- `contains` is still the default, `exact` is untouched, `first_inbound_message` and `manual` are untouched.
- Regression tests compare `pickEntryFlow` with a verbatim copy of the previous entry loop on 3000 random scenarios without `word` flows (identical result in every one), and on 3000 more with `word` flows interleaved at random positions: whenever a non-`word` flow matches, the result is identical.
- Mutation checks: making word flows win, picking the first of a tie, using substring matching, ignoring priority or not folding accents each make the new tests fail.
- Production data check (read-only, before this PR): no flow of any account has `match_type` other than `exact` (1 flow) or none, so the stricter validation of unknown values affects nothing that exists.
- Automations (`src/lib/automations`) have their own keyword matcher and are not touched.

## 4b. Test coverage

- Default suite: 237 files, 3464 tests pass; ESLint reports 0 errors (the 48 warnings are pre-existing and none is in a changed file); `tsc` has no errors under `src`.
- Six test files are skipped without a database. Three of them drive the real flow engine (`dispatchInboundToFlows`) against a disposable PostgreSQL + PostgREST and are relevant to this change; they were run in isolation on this branch: subflow execution 32/32, durable waits 9/9, customer-reply condition 18/19. The one failure (R09) fails identically on unmodified `main` (a database trigger added by migration `20261031034834` rejects a fixture update that predates it), so it is not caused by this PR; the fixture needs updating separately.
- Not run, not related to this change: `audio-guide` sequencer and voice-note storage QA, and the orders end-to-end integration test.

## 5. Same-data comparison of the engines

One case set of 718 cases (552 + 48 + 95 + 15 + 8, counted from the evaluated data), built from the production flows of the pilot account (regional keywords, product advertising texts, 48 distinct real inbound messages, negative and hierarchy cases), evaluated four ways:

1. production today (62 active flows, regionals in draft);
2. today's engine with all 234 regionals active (what activating them as-is would do);
3. the `word` engine with regional keywords as they are;
4. **proposed**: `word` engine + cleaned keywords + `word_priority`.

Cells are right / wrong flow / ambiguous (nothing starts) / no reply.

| Case set | n | 1 today | 2 today's engine, 234 active | 3 word, uncleaned | 4 proposed |
|---|---|---|---|---|---|
| A. each regional keyword → its own flow | 552 | 0/0/0/552 | 487/**65**/0/0 | 540/0/**12**/0 | **552/0/0/0** |
| B. real inbound messages | 48 | 42/0/0/6 | 46/**2**/0/0 | 47/**1**/0/0 | **48/0/0/0** |
| C. product advertising texts | 95 | 94/1/0/0 | 85/**10**/0/0 | 94/1/0/0 | 94/1/0/0 |
| D. negatives ("eléctrica", "práctica", greetings…) | 15 | 14/1/0/0 | 3/**12**/0/0 | 9/5/1/0 | 14/1/0/0 |
| E. variants and hierarchy ("Jaén, Cajamarca", "Nuevo Chimbote") | 8 | 0/0/0/8 | 3/4/0/1 | 5/0/3/0 | **8/0/0/0** |

Reading it: activating the regionals with today's engine sends 65 regional keywords, 10 advertising texts and 12 of 15 negatives to the wrong flow. The two remaining "wrong" cells in column 4 are not caused by `word`: they are existing commercial flows (a draft copy sharing an advertising text with its original, and a commercial keyword "cocina eléctrica") and are identical in column 1.
Column 3 shows why the data cleanup is part of the change: with the engine alone, identical keywords owned by several flows end up ambiguous (safe, but unanswered).

## 6. Data contract and cleanup (applied by SQL after approval, not by this PR)

A regional flow is switched on by setting `trigger_config.match_type = "word"` and `word_priority` (1 = department, 2 = city, deeper = more specific). Before that, keywords that make activations ambiguous are removed **only by removal** (a guarded script refuses any new keyword, any other changed key, any non-draft flow, a wrong list checksum or a changed trigger):

- generic words ("para", "provincia", "bella", "vista", "nuevo", "madre", "santa", "mala", "chao"…);
- a keyword equal to the department name is kept only by the department flow, not by its cities;
- a keyword claimed by several flows is kept only by the flow whose name ends with it (e.g. a misspelling of a city belongs to that city's main flow, not to a district flow);
- a flow left without keywords stays draft until its owner chooses one.

Flows that fail activation validation are not touched and stay draft.

## 7. Destination context ("waiting for the destination")

Today the commercial flow asks "¿PARA DÓNDE…?" and ends; the customer's next message goes through entry-trigger matching like any other. Nothing records that a destination is awaited.

**Without a context condition** (what this PR delivers): a message that contains a place as a whole word and matches no commercial flow starts that place's flow, whether or not a destination was asked. In the evaluation set, 0 of 48 real messages and 14 of 15 negatives started a wrong regional flow; the remaining case is a commercial flow. Cost of the gap: a customer who mentions a city in a general question gets that city's agency information.

**Option A — existing fields and operators only.** A contact field "State" set to "awaiting destination" by a new `set_contact_field` node placed before the destination question in every commercial flow, a `contact_field equals` guard at the start of every regional flow, and a node at the end of every regional flow that clears it. It works with existing node types, but: (1) it edits all the commercial flows, which are live; (2) there is no expiry (no time operator), so the state lasts until a regional flow clears it; (3) an expiry built with a delay node does not work, because a run parked in a delay is an *active run*: the customer's reply is routed to that run and entry triggers are not evaluated at all; (4) it re-opens the same constraint when follow-ups are fixed later. Not recommended.

**Option B — derive the context from the conversation (recommended follow-up, not implemented here).** An optional `trigger_config.after_bot_message: { contains: "para donde", within_minutes: N }` evaluated in `findEntryFlow` with the existing `conversationId`: the flow is a candidate only if a recent outbound message of the conversation contains the prompt (accent/case-folded, same normalizer). No commercial flow changes (all share one prompt text). Behaviour: expiry is explicit (`N`); it clears itself when a person or another flow writes after the prompt only if "most recent outbound" is used (variant: look at the last few outbound messages so a follow-up message does not erase it); a new product sends a new prompt, which restarts the window; an answer after `N` minutes starts nothing and a person answers. Cost: one indexed query per candidate message, only when a `word` flow with this option matches. It needs its own tests and review; it should be decided after the pilot shows whether the gap matters.

## 8. Risks

| Risk | Mitigation |
|---|---|
| A bug in the shared entry selection affects every account | Tiering keeps the old loop untouched for non-`word` flows; 6000 randomized equivalence scenarios; the feature is inert until a flow opts in. |
| Ambiguous ties leave a customer unanswered | By design (a person answers); logged with flow ids; ties are removed by the data cleanup and by `word_priority`. |
| Regional flows answer a general question that merely names a city | Option B (above), measured in the pilot first. |
| A future follow-up fix parks the commercial run in a delay and swallows the destination reply | Documented; Option B is independent of it, Option A is not. |
| Editing a regional flow in the UI | The editor spreads `trigger_config`; `match_type` and `word_priority` are preserved. |

## 9. Rollback

- Engine: redeploy the previous image (kept as a tarball before deployment). Flows with `match_type: "word"` would then behave as `contains` again, so **first** put the regional flows back to draft.
- Data: the restore script writes back the original `trigger_config` of exactly the flows that were changed (original values saved before the change).
- Operationally: pause the regional flows with the existing guarded status script (same list, active → draft).

## 10. Pilot and go/no-go

Pilot: five localities that appear in real destination replies (one department and four cities of two departments), activated only after the engine is deployed and the cleanup applied to those five, with a person watching the Inbox. Observe at least 24 h or 10 real destination replies.

| Gate | Required |
|---|---|
| Unit, integration and regression suites | All green; full test run and lint/typecheck clean |
| Engine deployed with the 62 active flows unchanged | `status.sh` shows the same 62 active; flow runs for commercial ads identical |
| Pilot: right flow for each destination reply | 100 % |
| Pilot: no regional flow on a non-destination message, or each one reviewed and accepted | 0 unreviewed |
| Duplicated or failed messages | 0 |
| Lorteg / Alexis Test / orders cron | Unchanged / OK |
| Rollback rehearsed | Yes |

NO-GO: any commercial flow starting differently, any wrong-city reply, any duplicate, or an ambiguity that is not understood.
