import type {
  Automation,
  AutomationLogStepResult,
  AutomationStep,
  AutomationStepType,
  AutomationTriggerType,
  ConditionStepConfig,
  KeywordMatchTriggerConfig,
  InteractiveReplyTriggerConfig,
  TagTriggerConfig,
  SendMessageStepConfig,
  SendButtonsStepConfig,
  SendListStepConfig,
  SendTemplateStepConfig,
  SendMediaStepConfig,
  SendWebhookStepConfig,
  TagStepConfig,
  UpdateContactFieldStepConfig,
  WaitStepConfig,
  CreateDealStepConfig,
  AssignConversationStepConfig,
} from '@/types'
import { supabaseAdmin } from './admin-client'
import { addContactTagIfAbsent } from '@/lib/contacts/tag-write'
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from '@/lib/contacts/tag-chain'
import { engineSendText, engineSendTemplate, engineSendInteractive, engineSendMedia } from './meta-send'
import { validateInteractivePayload } from '@/lib/whatsapp/interactive'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { classifyMetaSendError } from '@/lib/whatsapp/meta-error-classify'
import { MAX_META_RATE_LIMIT_RETRIES, metaRateLimitDelayMs } from './meta-retry-backoff'
import { resolveOutboundTransport } from '@/lib/whatsapp/send-message'

/**
 * The 5 step types that can ever reach Meta and thus ever throw a
 * MetaApiError worth classifying for retry (Meta 131056, Phase 3 — see
 * docs/META_131056_AUTOMATION_RETRY_AUDIT.md). Every other step type
 * (tag/field/deal/webhook/condition/wait/etc.) NEVER attempts a durable
 * retry even if it somehow throws something that happens to satisfy
 * `classifyMetaSendError` — retry is scoped to "this step is one of the
 * 5 outbound Meta sends", checked independently of what the error
 * itself looks like.
 */
const OUTBOUND_SEND_STEP_TYPES: ReadonlySet<AutomationStepType> = new Set([
  'send_message',
  'send_media',
  'send_buttons',
  'send_list',
  'send_template',
])

/**
 * Meta 131056 durable retry, PHASE 3.1 — crash/redeploy recovery.
 *
 * How long a claimed `automation_pending_executions` row (a `wait` OR a
 * retry — both use the SAME claim/lease mechanism, see below) is
 * considered legitimately "in progress" before ANOTHER worker is
 * allowed to reclaim it, assuming the original claimant died mid-flight
 * (crash, redeploy, OOM-kill) between claiming the row and calling
 * markPending.
 *
 * 15 minutes, chosen conservatively rather than derived from a real
 * upper bound, because none exists today: audited every `fetch()` call
 * in src/lib/whatsapp/meta-api.ts (every Meta Graph API call this
 * codebase makes) and NONE of them pass an AbortSignal/timeout — a
 * hung TCP connection or an unresponsive Meta endpoint has no
 * application-level ceiling. On any realistic serverless deployment
 * (Vercel included) the FUNCTION's own execution-time limit would kill
 * the invocation long before 15 minutes regardless (typical limits top
 * out in the tens of seconds to a few minutes even on generous plans),
 * so in practice this lease should almost never fire while a call is
 * still genuinely in flight — it exists to bound the OTHER case: the
 * process is simply gone and nothing will ever call markPending. This
 * is a documented, deliberately NOT-implemented follow-up — see the
 * audit doc's Phase 3.1 section for the recommendation to add an
 * explicit `AbortSignal.timeout()` to meta-api.ts's fetch calls in a
 * later, separate change (out of scope here: it touches every sender).
 */
export const AUTOMATION_PENDING_LEASE_MS = 15 * 60 * 1000

/**
 * Preventive Meta pacing (Phase 4 — see
 * docs/META_131056_AUTOMATION_RETRY_AUDIT.md section "Fase 4").
 *
 * Meta 131056 is a REACTIVE defense — it fires only after a pair
 * rate-limit already happened, then backs off and retries. This
 * constant is the PROACTIVE half: a minimum spacing between two
 * outbound Meta sends produced by the SAME automation execution, so a
 * burst of sends (e.g. 3 `send_message` steps with no delay between
 * them) doesn't hand Meta a reason to rate-limit the pair in the first
 * place. 1500ms, deterministic, no jitter — jitter belongs to the
 * REACTIVE backoff in meta-retry-backoff.ts, not to this preventive
 * spacing (see that module's own doc for why 131056 retries need
 * jitter and this doesn't: this delay is never retried/scheduled
 * durably, it's a single bounded wait inline in one execution, so
 * there's no "thundering herd of retries" for jitter to break up).
 */
export const AUTOMATION_META_OUTBOUND_PACING_MS = 1500

/**
 * Per-execution, in-memory, never-persisted pacing state. One instance
 * is created at each of the TWO true entry points —
 * `executeAutomation` (a fresh synchronous dispatch) and
 * `resumePendingExecution` (a cron-driven resume, whether a plain
 * `wait` or a Meta 131056 retry) — and the SAME object reference flows
 * through every recursive/ancestor call from there: a `condition`
 * branch's recursive `executeStepsFrom` call, and every scope
 * `resumeAndUnwind` climbs through. Nothing here ever gets copied by
 * value — every call site propagates it via `{...args, ...}` /
 * `{...base, ...}` without ever re-assigning the `runtime` key, so all
 * of them share the exact same mutable object.
 *
 * Deliberately NOT persisted (no new column, no migration 051, no
 * Redis, no module-level global Map keyed by execution/account/contact
 * — see section 16/17 of the Fase 4 spec): this is a best-effort,
 * SAME-invocation-only guard. It resets to a fresh `{}` at every
 * Pending-row boundary (a `wait` OR a retry resume both start a BRAND
 * NEW `resumePendingExecution` call, hence a brand new runtime) and
 * never survives a crash/redeploy — Meta 131056's durable, DB-backed
 * retry (Phase 3) remains the actual safety net; this is purely
 * preventive, reducing how often that reactive path needs to fire.
 */
export interface AutomationExecutionRuntime {
  /** `Date.now()` right after the most recent Meta-bound send in THIS
   *  execution/resume completed successfully. `undefined` means no
   *  Meta send has completed yet in this runtime — the very next
   *  Meta-bound send goes out immediately, no delay. */
  lastMetaSendCompletedAtMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Waits out whatever's left of `AUTOMATION_META_OUTBOUND_PACING_MS`
 * since `runtime.lastMetaSendCompletedAtMs`, if anything — NEVER the
 * full interval if part of it already elapsed doing other work (a
 * `condition` evaluation, a DB write, a non-Meta step). Returns the
 * actual number of milliseconds slept (0 if no wait was needed), so
 * the caller can tell whether real wall-clock time passed — see
 * section 10's ownership recheck, which only matters when it did.
 */
async function paceMetaOutbound(runtime: AutomationExecutionRuntime): Promise<number> {
  if (runtime.lastMetaSendCompletedAtMs == null) return 0
  const elapsed = Date.now() - runtime.lastMetaSendCompletedAtMs
  const remaining = AUTOMATION_META_OUTBOUND_PACING_MS - elapsed
  if (remaining > 0) {
    await sleep(remaining)
    return remaining
  }
  return 0
}

/**
 * Whether `stepType` is a step that will actually reach Meta's Cloud
 * API for THIS account, and therefore must participate in Meta
 * pacing. NOT the same question as `OUTBOUND_SEND_STEP_TYPES` above
 * (which asks "is this one of the 5 step types that can EVER reach
 * Meta" — relevant for 131056 retry classification, transport-blind):
 * `send_message`/`send_media` can ALSO go out via the temporary
 * ManyChat bridge (`resolveOutboundTransport`, reused verbatim from
 * `@/lib/whatsapp/send-message` — never duplicate
 * WHATSAPP_OUTBOUND_TRANSPORT/MANYCHAT_INGEST_ACCOUNT_ID resolution
 * here), and a ManyChat send has no Meta rate limit to pace against.
 * `send_buttons`/`send_list`/`send_template` have no ManyChat
 * equivalent today (ManyChat's Public API has no template-send or
 * interactive-send primitive to bridge to — see meta-send.ts's own
 * doc) — they stay Meta-bound regardless of the account's transport
 * setting, so a ManyChat-bridged account's `send_template` step still
 * paces against Meta.
 */
function isAutomationMetaOutboundStep(stepType: AutomationStepType, accountId: string): boolean {
  switch (stepType) {
    case 'send_buttons':
    case 'send_list':
    case 'send_template':
      return true
    case 'send_message':
    case 'send_media':
      return resolveOutboundTransport(accountId) === 'meta'
    default:
      return false
  }
}

type AdminClient = ReturnType<typeof supabaseAdmin>

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

export interface AutomationContext {
  /** Raw message text, for keyword_match + message_content conditions. */
  message_text?: string
  /** Conversation the event belongs to, if any. */
  conversation_id?: string
  /** Arbitrary variables accumulated during execution. */
  vars?: Record<string, unknown>
  /** The tag id that was added, for tag_added trigger. */
  tag_id?: string
  /** Agent the conversation was assigned to, for conversation_assigned. */
  agent_id?: string
  /** Button / list-row id the customer tapped, for interactive_reply. */
  interactive_reply_id?: string
}

export interface DispatchInput {
  /** Account-level tenancy key. Drives the lookup of which active
   *  automations to fire — `automations.account_id` is the tenant
   *  isolation after migration 017. Replaces the previous `userId`
   *  field; the per-automation user_id is read off each row when
   *  needed (sender identity for outbound messages, log audit). */
  accountId: string
  triggerType: AutomationTriggerType
  contactId?: string | null
  context?: AutomationContext
}

/**
 * Fire all active automations matching the given trigger for an
 * account.
 *
 * Must never throw — callers use fire-and-forget from the webhook.
 * All errors are caught and logged; per-automation failures are
 * recorded into automation_logs with status='failed'.
 */
export async function runAutomationsForTrigger(input: DispatchInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Tenant isolation. `contactId` can be caller-supplied (the manual
    // POST /api/automations/engine entrypoint reads it straight from the
    // request body), and every step below runs through the service-role
    // client, which bypasses RLS. So before any step can touch the
    // contact, verify it actually belongs to this account. A foreign or
    // forged id is refused silently — callers are fire-and-forget, and a
    // distinct error would leak whether a given contact UUID exists.
    if (input.contactId) {
      const { data: owned, error: ownErr } = await db
        .from('contacts')
        .select('id, blocked')
        .eq('id', input.contactId)
        .eq('account_id', input.accountId)
        .maybeSingle()
      if (ownErr) {
        console.error('[automations] contact ownership check failed:', ownErr)
        return
      }
      if (!owned) {
        console.warn('[automations] contact not in account, refusing dispatch', input.contactId)
        return
      }
      // Blocked contacts never trigger new automations — checked here,
      // before any automation lookup, so a blocked contact costs one
      // query and nothing else.
      if (owned.blocked) return
    }

    const { data: automations, error } = await db
      .from('automations')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('trigger_type', input.triggerType)
      .eq('is_active', true)

    if (error) {
      console.error('[automations] fetch failed:', error)
      return
    }
    if (!automations || automations.length === 0) return

    for (const automation of automations as Automation[]) {
      if (!triggerMatches(automation, input.context)) continue
      try {
        await executeAutomation(automation, input)
      } catch (err) {
        console.error('[automations] execute failed:', automation.id, err)
      }
    }
  } catch (err) {
    console.error('[automations] dispatch failed:', err)
  }
}

/**
 * Resume a run that was parked at a wait step. Called from the cron
 * endpoint after it grabs a due `automation_pending_executions` row.
 */
export async function resumePendingExecution(pending: {
  id: string
  automation_id: string
  /** Audit-only; the automation row carries account_id for tenancy. */
  user_id: string
  /** Account-scoped lookups read from the automation row, so this
   *  field is just here to mirror the row shape and keep the cron's
   *  pass-through self-documenting. */
  account_id: string
  contact_id: string | null
  log_id: string | null
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  next_step_position: number
  context: AutomationContext
  /** Meta 131056 durable retry, PHASE 3.1 — the token the CALLER (the
   *  cron route) minted at claim time. This is the caller's OWN claim
   *  on this specific execution attempt — everything below re-confirms
   *  it against a fresh read before trusting it, exactly like every
   *  other field on `pending`. See AUTOMATION_PENDING_LEASE_MS's doc
   *  comment for why a claim can expire and be handed to someone else
   *  entirely, and markPending/isPendingExecutionStillRunning for how
   *  that ownership is enforced at every subsequent step. */
  claim_token: string
}): Promise<void> {
  const db = supabaseAdmin()

  // Revalidate the pending row itself FIRST, before trusting anything
  // else about it. The `pending` object here is whatever the cron read
  // when it claimed this row (possibly some time ago, if the process
  // was slow or delayed) — a concurrent block_contact_internal call
  // may have already flipped it to 'done' since then. That flip is the
  // durable "this specific execution was cancelled" memory: unlike
  // contacts.blocked, it survives a LATER unblock, which is exactly
  // why we check the PENDING ROW's own status here rather than
  // re-deriving an answer from the contact's current blocked state.
  const { data: freshPending, error: freshPendingErr } = await db
    .from('automation_pending_executions')
    .select('id, status, automation_id, account_id, contact_id, retry_count, retry_reason, retry_step_id, claim_token')
    .eq('id', pending.id)
    .maybeSingle()
  if (freshPendingErr) {
    // Fail closed: can't confirm this execution is still valid, so
    // don't run it. Leave the row untouched — a transient read error
    // must not overwrite whatever its real status already is.
    console.error('[automations] resume: pending re-check failed', freshPendingErr)
    return
  }
  if (
    !freshPending ||
    freshPending.status !== 'running' ||
    freshPending.automation_id !== pending.automation_id ||
    freshPending.account_id !== pending.account_id ||
    freshPending.contact_id !== pending.contact_id ||
    // Meta 131056 durable retry, PHASE 3.1 — if this row's lease
    // expired and ANOTHER worker already reclaimed it (a fresh
    // claim_token was minted), this caller is no longer the owner even
    // though it still believes it is. Stopping here is what makes an
    // old, merely-slow-but-not-actually-dead worker back off the
    // moment a newer claim exists, rather than racing the new owner.
    freshPending.claim_token !== pending.claim_token
  ) {
    // Already done/failed, already reclaimed by someone else, or the
    // row/ids don't match what the caller thinks it claimed. Most
    // commonly: block_contact_internal already cancelled it, or a
    // stale worker's lease already expired and was reclaimed. Never
    // execute steps, never send, never re-derive "should this run?"
    // from the contact's CURRENT blocked state — that's precisely the
    // unblock-revives-an-old-run bug this closes (and the exact same
    // posture now closes the reclaimed-by-a-newer-worker case too).
    return
  }

  // Meta 131056 durable retry (Phase 3) — retry_count/retry_reason/
  // retry_step_id are read from THIS SAME fresh row, never from
  // whatever the cron passed in `pending` (that type doesn't even
  // carry them) — the exact same "don't trust the caller's copy of
  // anything semantically important" posture as status/automation_id/
  // account_id/contact_id just above. The DB CHECK constraint
  // (migration 050) already enforces this shape, but re-validating here
  // costs nothing and protects against a mocked/degraded read path in
  // tests, or a future direct write that bypasses the constraint.
  const retryCount = freshPending.retry_count as number
  const retryReason = freshPending.retry_reason as string | null
  const retryStepId = freshPending.retry_step_id as string | null
  const isRetryRow = retryCount > 0
  const retryMetadataConsistent = isRetryRow
    ? retryReason === 'meta_pair_rate_limit' && retryStepId !== null
    : retryReason === null && retryStepId === null
  if (!retryMetadataConsistent) {
    console.error('[automations] resume: inconsistent retry metadata on pending', pending.id, {
      retryCount, retryReason, retryStepId,
    })
    await markPending(pending.id, 'done', pending.claim_token)
    await finalizeLog(pending.log_id, 'failed', 'retry_metadata_inconsistent')
    return
  }

  const { data: automation, error } = await db
    .from('automations')
    .select('*')
    .eq('id', pending.automation_id)
    .single()

  if (error || !automation) {
    console.error('[automations] resume: missing automation', pending.automation_id, error)
    await markPending(pending.id, 'failed', pending.claim_token)
    return
  }

  // Meta 131056 durable retry (Phase 3) — EXACT-STEP VALIDATION.
  // retry_step_id alone isn't enough: the automation may have been
  // edited (step deleted/replaced/moved/reparented) WHILE this retry
  // was pending. Re-confirm, against the CURRENT automation_steps
  // state, that the step this retry claims to resume still exists at
  // exactly the same automation/position/parent/branch, and is still
  // one of the 5 outbound send types. If anything shifted, fail closed
  // — NEVER execute whatever step now happens to occupy that position;
  // that could be a completely different, unrelated step the user
  // added later. No ancestor continuation either — the whole run stops
  // here, log ends 'failed'.
  if (isRetryRow) {
    const matchesTarget = await isRetryTargetStillValid({
      db,
      automationId: pending.automation_id,
      retryStepId: retryStepId as string,
      nextStepPosition: pending.next_step_position,
      parentStepId: pending.parent_step_id,
      branch: pending.branch,
    })
    if (!matchesTarget) {
      await markPending(pending.id, 'done', pending.claim_token)
      await finalizeLog(pending.log_id, 'failed', 'retry_target_changed')
      return
    }
  }

  try {
    // resumeAndUnwind resumes the branch this pending row was parked in
    // and, once (if) it completes, walks back up through however many
    // condition scopes contain it — reconstructed from automation_steps,
    // no persisted stack — until it either reaches the automation's real
    // root (and finishes it) or hits a paused/failed outcome along the
    // way. See docs/META_131056_AUTOMATION_RETRY_AUDIT.md section C.
    const { outcome, failedBeforeRoot } = await resumeAndUnwind(
      {
        automation: automation as Automation,
        contactId: pending.contact_id,
        context: pending.context ?? {},
        logId: pending.log_id,
        triggerEvent: 'resumed_wait',
        // Carried unchanged through EVERY scope this unwind visits — a
        // concurrent block_contact_internal cancelling THIS SAME pending
        // row must be able to stop the unwind at any ancestor level, not
        // just within the branch it originally resumed. See engine.test.ts
        // CP-I.
        pendingExecutionId: pending.id,
        // Meta 131056 durable retry, Phase 3.1 — the claim token this
        // worker was granted when it claimed pending.id. Threaded through
        // the same way pendingExecutionId already is, and re-checked at
        // every single step throughout the WHOLE ancestor unwind (see
        // isPendingExecutionStillRunning): if a stale worker somehow
        // resumes after its lease expired and was reclaimed by a newer
        // worker, this token mismatches on the very next check and the
        // stale worker's unwind stops immediately.
        claimToken: pending.claim_token,
        // Preventive Meta pacing (Phase 4) — a FRESH runtime for this
        // resume. Deliberately does NOT carry anything over from
        // whatever the previous invocation's runtime looked like before
        // it paused on this pending row (a `wait` or a 131056 retry) —
        // the pacing constant guards against a BURST within one
        // execution, not across a boundary that already introduced a
        // real gap (minutes, by construction) on its own. The SAME
        // instance then flows through every ancestor scope this unwind
        // climbs, exactly like pendingExecutionId/claimToken above.
        runtime: {},
      },
      pending.parent_step_id,
      pending.branch,
      pending.next_step_position,
      // Meta 131056 durable retry (Phase 3) — seeds ONLY the very first
      // executeStepsFrom call in the unwind (the one that resumes
      // `retryStepId` itself). resumeAndUnwind resets this to 0 for
      // every scope it climbs into afterward — see that function's own
      // comment for why a step reached only because an earlier one
      // succeeded must never inherit a prior step's retry count.
      retryCount,
    )

    // Pending A's own lifecycle is independent of the unwind's outcome —
    // this specific queued resume was consumed either way: it completed
    // all the way up, it handed off to a brand-new Pending B (paused
    // again), or it failed. None of those leave Pending A itself
    // re-runnable, so it is always 'done' here.
    await markPending(pending.id, 'done', pending.claim_token)

    // A failure that happened BEFORE the unwind ever reached the true
    // root left automation_logs.status unwritten — executeStepsFrom's
    // nested-scope convention deliberately never decides global status
    // (appendResults with status: null), correct for a synchronous
    // dispatch where the real root's own loop is still running to make
    // that call eventually, but there is no such loop left running
    // during a resume. Without this, the log would stay stuck at
    // whatever it was before (typically 'partial' from the original
    // wait) forever — see engine.test.ts CP-C.
    if (failedBeforeRoot && outcome.kind === 'failed') {
      await finalizeLog(pending.log_id, 'failed', outcome.message)
    }
  } catch (err) {
    console.error('[automations] resume failed:', err)
    await markPending(pending.id, 'failed', pending.claim_token)
  }
}

/**
 * Meta 131056 durable retry (Phase 3) — the exact-step check
 * `resumePendingExecution` runs before ever resuming a retry row (never
 * for a plain wait, where `retry_count` is 0 and this is skipped
 * entirely). Confirms `retryStepId` still exists at exactly the
 * automation/position/parent/branch the retry pending recorded, and is
 * still one of the 5 outbound send types — a `null` parent_step_id/
 * branch needs `.is()`, a real UUID/string needs `.eq()`, so both are
 * built explicitly rather than trying to coerce one query builder call
 * to accept either.
 */
async function isRetryTargetStillValid(input: {
  db: AdminClient
  automationId: string
  retryStepId: string
  nextStepPosition: number
  parentStepId: string | null
  branch: 'yes' | 'no' | null
}): Promise<boolean> {
  const { db, automationId, retryStepId, nextStepPosition, parentStepId, branch } = input
  let query = db
    .from('automation_steps')
    .select('id, step_type')
    .eq('id', retryStepId)
    .eq('automation_id', automationId)
    .eq('position', nextStepPosition)
  query = parentStepId === null ? query.is('parent_step_id', null) : query.eq('parent_step_id', parentStepId)
  query = branch === null ? query.is('branch', null) : query.eq('branch', branch)

  const { data: step, error } = await query.maybeSingle()
  if (error || !step) return false
  return OUTBOUND_SEND_STEP_TYPES.has(step.step_type as AutomationStepType)
}

/**
 * Resume one paused branch and, if it completes, keep continuing
 * whatever scope contains it — reconstructed from automation_steps —
 * until either the automation's real root finishes or a
 * paused/failed outcome stops the climb. Used ONLY by
 * resumePendingExecution; the synchronous dispatch path
 * (executeAutomation) never needs this because its own call stack IS
 * the continuation (a condition's recursive call and its caller are
 * the same JS execution, see executeStepsFrom's `condition` case).
 *
 * No persisted stack: automation_steps.parent_step_id/branch/position
 * already encode the full ancestor chain, so each step up just needs
 * ONE more row lookup — cheap, and always reflects the CURRENT step
 * tree rather than a stack frozen at wait-schedule time.
 */
async function resumeAndUnwind(
  base: Pick<
    ExecuteArgs,
    'automation' | 'contactId' | 'context' | 'logId' | 'triggerEvent' | 'pendingExecutionId' | 'claimToken' | 'runtime'
  >,
  initialParentStepId: string | null,
  initialBranch: 'yes' | 'no' | null,
  initialStartPosition: number,
  /** Meta 131056 durable retry (Phase 3) — the retry count to seed ONLY
   *  the very first executeStepsFrom call below (the one resuming the
   *  actual retried step). 0 for a plain wait resume — identical to
   *  Phase 1's behavior. Reset to 0 immediately after that first call
   *  for every subsequent ancestor scope: a step reached only because
   *  an earlier one in the SAME unwind succeeded has never itself been
   *  retried, so it must start its own potential retry chain at 0, not
   *  inherit this run's. See engine.ts's per-step retry-count handling
   *  inside executeStepsFrom for the other half of this guarantee. */
  initialRetryCount = 0,
): Promise<{ outcome: ExecutionOutcome; failedBeforeRoot: boolean }> {
  const db = supabaseAdmin()
  let parentStepId = initialParentStepId
  let branch = initialBranch
  let startPosition = initialStartPosition
  let retrySeed = initialRetryCount

  for (;;) {
    const isRoot = parentStepId === null
    const outcome = await executeStepsFrom({ ...base, parentStepId, branch, startPosition, initialRetryCount: retrySeed })
    retrySeed = 0

    if (outcome.kind !== 'completed') {
      // paused: a new pending already exists and already wrote 'partial'
      // (if it turned out to be root) or nothing (if nested — an even
      // later unwind, once THAT pending resumes, will keep climbing).
      // failed: if this WAS root, executeStepsFrom already wrote
      // 'failed' itself; if not, the caller must do it explicitly.
      return { outcome, failedBeforeRoot: outcome.kind === 'failed' && !isRoot }
    }
    if (isRoot) {
      // Completed all the way to the automation's real root —
      // executeStepsFrom already finalized automation_logs as 'success'.
      return { outcome, failedBeforeRoot: false }
    }

    // This scope (the branch under `parentStepId`) completed. Resolve
    // the CONDITION step that owns it — scoped to THIS automation, and
    // required to actually be a `condition` — so we know where to
    // resume ITS containing scope from. Fail closed on anything else
    // (missing, belongs to a different automation, or not a condition
    // at all — automation_steps rows should never satisfy that, but a
    // corrupted/foreign parent_step_id must never silently no-op or
    // silently continue the wrong scope).
    const { data: step, error } = await db
      .from('automation_steps')
      .select('id, automation_id, step_type, position, parent_step_id, branch')
      .eq('id', parentStepId)
      .eq('automation_id', base.automation.id)
      .maybeSingle()

    if (error || !step || step.step_type !== 'condition') {
      return {
        outcome: { kind: 'failed', message: 'ancestor_step_lookup_failed' },
        failedBeforeRoot: true,
      }
    }

    // Continue the scope that CONTAINS this condition, starting right
    // AFTER it — never re-run the condition itself.
    parentStepId = step.parent_step_id as string | null
    branch = step.branch as 'yes' | 'no' | null
    startPosition = (step.position as number) + 1
  }
}

// ------------------------------------------------------------
// Internal execution
// ------------------------------------------------------------

async function executeAutomation(automation: Automation, input: DispatchInput) {
  const db = supabaseAdmin()

  const { data: log, error: logErr } = await db
    .from('automation_logs')
    .insert({
      automation_id: automation.id,
      // Tenancy: matches automation.account_id (NOT NULL post-017).
      account_id: automation.account_id,
      // Audit: keeps the historical "author of this automation"
      // pointer so logs still attribute to the right user even
      // after teammates join the account.
      user_id: automation.user_id,
      contact_id: input.contactId ?? null,
      trigger_event: input.triggerType,
      steps_executed: [],
      // Seeded pessimistically. The row is written BEFORE any step runs,
      // and every terminal path below overwrites it (`appendResults` at
      // the outermost scope, or `finalizeLog`). Seeding 'success' meant a
      // run that died mid-flight — the process frozen, the pod recycled —
      // left a permanent `status: 'success'` with `steps_executed: []`,
      // indistinguishable from an automation that genuinely had nothing
      // to do. 'failed' inverts that: the status only becomes success if
      // execution actually reached the end. See issue #409.
      status: 'failed',
    })
    .select()
    .single()

  if (logErr || !log) {
    console.error('[automations] cannot create log:', logErr)
    return
  }

  await executeStepsFrom({
    automation,
    contactId: input.contactId ?? null,
    context: input.context ?? {},
    parentStepId: null,
    branch: null,
    startPosition: 0,
    logId: log.id,
    triggerEvent: input.triggerType,
    // Preventive Meta pacing (Phase 4) — a fresh runtime per synchronous
    // dispatch; see AutomationExecutionRuntime's doc.
    runtime: {},
  })

  // Atomic counter update via the SQL function from migration 007.
  // Doing this with a client-side read-modify-write raced when the
  // same automation fired for two contacts simultaneously — both
  // would read N and both write N+1, losing one count permanently.
  const { error: rpcErr } = await db.rpc('increment_automation_execution_count', {
    p_automation_id: automation.id,
  })
  if (rpcErr) {
    console.error('[automations] increment counter failed:', rpcErr)
  }
}

interface ExecuteArgs {
  automation: Automation
  contactId: string | null
  context: AutomationContext
  parentStepId: string | null
  branch: 'yes' | 'no' | null
  startPosition: number
  logId: string | null
  triggerEvent: string
  /** Set only when this call originated from resumePendingExecution.
   *  Lets the per-step loop re-confirm, before EACH step, that
   *  block_contact_internal hasn't cancelled (status -> 'done') this
   *  SPECIFIC resumed execution since it started — the durable
   *  "was this cancelled" memory, independent of contacts.blocked. */
  pendingExecutionId?: string
  /**
   * Meta 131056 durable retry, Phase 3.1 — the claim token this worker
   * was granted when it claimed `pendingExecutionId`. Always set
   * together with `pendingExecutionId` (both come from the same pending
   * row) and checked at the SAME points, by the SAME
   * `isPendingExecutionStillRunning` call — a status of 'running' alone
   * is no longer enough proof of ownership once a stale lease can be
   * reclaimed by a different worker with a NEW token; the old worker's
   * copy of this field stops matching the row's current claim_token the
   * instant that happens, and every step-loop check after that returns
   * 'cancelled' for it. See AUTOMATION_PENDING_LEASE_MS's comment for
   * the lease design this backs.
   */
  claimToken?: string
  /**
   * Meta 131056 durable retry (Phase 3) — how many retries the step
   * THIS CALL RESUMES has already used, seeded ONLY when resuming a
   * genuine retry pending (never for a normal wait, and never
   * propagated by `resumeAndUnwind` past the first call in its chain —
   * see that function's own comment). PER-STEP, not per-run: applies
   * exclusively to the FIRST step this call's loop processes; any step
   * reached afterward (because the first one succeeded) starts its own
   * potential retry chain at 0, never inheriting this value. Omitted or
   * 0 means "no prior retries for this step" — the overwhelmingly
   * common case (a fresh dispatch, a normal wait resume, or any step
   * after the first in a call).
   */
  initialRetryCount?: number
  /**
   * Preventive Meta pacing (Phase 4) — the SAME shared, in-memory,
   * never-persisted runtime object for the entire execution/resume this
   * `ExecuteArgs` belongs to. See `AutomationExecutionRuntime`'s own
   * doc. Always present: `executeAutomation` and
   * `resumePendingExecution` each create exactly one fresh instance and
   * every downstream call (`condition` recursion, `resumeAndUnwind`'s
   * ancestor climb) propagates the SAME reference via `{...args, ...}`
   * / `{...base, ...}` — never re-created, never copied by value.
   */
  runtime: AutomationExecutionRuntime
}

/**
 * What one `executeStepsFrom` call (one scope — root, or one condition
 * branch) actually did, reported to whoever called it.
 *
 *   completed — every step in this scope's range ran (or there were
 *     none left). The ONLY outcome that lets a caller keep going past
 *     the step that led here (a `condition`, during a synchronous
 *     dispatch, or an ancestor scope during a cron resume unwind).
 *   paused    — this scope suspended on a `wait` (or was stopped by a
 *     P0 contact-blocking / pending-cancellation gate, which is the
 *     same "stop cleanly, nothing failed" shape). A caller must NEVER
 *     keep executing steps of its own scope after seeing this.
 *   failed    — a step threw, or a technical lookup this function
 *     depends on (steps query, blocked-check, pending re-check) errored.
 *     A caller must never keep going, and must never let this be
 *     mistaken for `completed` when deciding automation_logs.status.
 *
 * Before this type existed, `executeStepsFrom` returned `Promise<void>`
 * and the `condition` handler did `await executeStepsFrom(child); continue`
 * unconditionally — the root scope had no way to know a nested branch had
 * paused or failed rather than finished, so it kept running its own next
 * steps regardless (confirmed bug, see
 * docs/META_131056_AUTOMATION_RETRY_AUDIT.md section F). This type, plus
 * every exit point below returning it instead of void, is the fix.
 */
type ExecutionOutcome =
  | { kind: 'completed' }
  | { kind: 'paused' }
  | { kind: 'failed'; message: string }

/**
 * Re-reads `automation_pending_executions` fresh and confirms it's
 * still the SAME, still-running execution the caller thinks it is.
 * A resumed run's `pending.status` is its durable cancellation token:
 * block_contact_internal flips it to 'done' in one atomic transaction,
 * and that must survive a LATER unblock — this function's answer must
 * never flip back to "still running" just because contacts.blocked
 * reset to false in the meantime.
 */
async function isPendingExecutionStillRunning(
  db: AdminClient,
  expected: {
    id: string
    automation_id: string
    account_id: string
    contact_id: string | null
    /** Meta 131056 durable retry, Phase 3.1 — the claim token this
     *  worker was granted. `status === 'running'` is no longer, by
     *  itself, proof that THIS caller still owns the row: a lease can
     *  expire and be reclaimed by a different worker (a new
     *  claim_token), while the row stays 'running' throughout. A stale
     *  worker must see that mismatch and stop, exactly like it already
     *  stops on a cancelled/foreign row below. */
    claimToken?: string
  },
): Promise<'running' | 'cancelled' | 'error'> {
  const { data, error } = await db
    .from('automation_pending_executions')
    .select('status, automation_id, account_id, contact_id, claim_token')
    .eq('id', expected.id)
    .maybeSingle()
  if (error) return 'error'
  if (
    !data ||
    data.status !== 'running' ||
    data.automation_id !== expected.automation_id ||
    data.account_id !== expected.account_id ||
    data.contact_id !== expected.contact_id ||
    data.claim_token !== expected.claimToken
  ) {
    return 'cancelled'
  }
  return 'running'
}

/**
 * Persist THIS scope's own accumulated `results` — exactly once, at
 * whichever exit point the caller is returning from — and hand back the
 * outcome unchanged so callers can write `return finishScope(...)`.
 *
 * The root/nested split below is the ONLY place that decides
 * `automation_logs.status` during a scope's own natural execution:
 *
 *   - Root scope (`parentStepId === null`): this IS the outermost
 *     scope for whatever chain of calls led here — during a synchronous
 *     dispatch (executeAutomation), that's the true root; during a cron
 *     resume, `resumeAndUnwind` only ever calls this with
 *     `parentStepId: null` once the unwind has climbed all the way back
 *     to the automation's real root. Either way, "I am parentStepId
 *     null" means "nothing else will ever decide this run's final
 *     status" — so it writes the real one: completed->success,
 *     paused->partial, failed->failed.
 *   - Nested scope (a condition branch): NEVER decides global status —
 *     always appends with `status: null`. This used to be true only for
 *     the loop's normal end-of-scope write; the `wait` step's own
 *     append was a pre-existing exception that wrote 'partial'
 *     unconditionally regardless of nesting (see the audit doc's
 *     section F/C) — folding it through this same helper removes that
 *     inconsistency: a `wait` inside a branch now correctly defers to
 *     whatever scope above it is actually root, exactly like every
 *     other early-return in this function.
 */
async function finishScope(
  args: ExecuteArgs,
  results: AutomationLogStepResult[],
  outcome: ExecutionOutcome,
  /** Explicit audit-trail reason for an auditable STOP (contact
   *  blocked, pending cancelled, a technical lookup failing) — recorded
   *  as `error_message` even when `outcome.kind` is `paused`, not just
   *  `failed`. `stopExecution` always supplies this; the condition
   *  propagation path and a genuine step failure leave it undefined so
   *  the fallback below applies (null for paused/completed, the
   *  failure's own message for failed). Preserves the pre-existing
   *  behavior of recording WHY an auditable partial-stop happened, not
   *  just that it happened. */
  detail?: string,
): Promise<ExecutionOutcome> {
  const errorMessage = detail !== undefined ? detail : outcome.kind === 'failed' ? outcome.message : null
  if (args.parentStepId === null) {
    const status = outcome.kind === 'completed' ? 'success' : outcome.kind === 'paused' ? 'partial' : 'failed'
    await appendResults(args.logId, results, status, errorMessage)
  } else {
    await appendResults(args.logId, results, null, errorMessage)
  }
  return outcome
}

/**
 * Stop the whole executeStepsFrom scope from THIS step onward: log an
 * auditable result for the step that never ran, persist this scope's
 * results via finishScope (recording `detail` as the log's
 * error_message even for a `paused` outcome — this is specifically an
 * AUDITABLE stop, unlike a normal `wait`), and return the outcome.
 * Shared by every "must not continue" gate in the loop below
 * (pending-execution cancelled, contact blocked, either check's own
 * lookup failing) so they all produce the same shape of audit trail
 * instead of subtly different ones.
 */
async function stopExecution(
  args: ExecuteArgs,
  results: AutomationLogStepResult[],
  step: AutomationStep,
  detail: string,
  outcome: ExecutionOutcome,
  stepStatus: 'skipped' | 'failed' = 'skipped',
): Promise<ExecutionOutcome> {
  results.push({ step_id: step.id, step_type: step.step_type, status: stepStatus, detail })
  return finishScope(args, results, outcome, detail)
}

async function executeStepsFrom(args: ExecuteArgs): Promise<ExecutionOutcome> {
  const db = supabaseAdmin()

  const baseQuery = db
    .from('automation_steps')
    .select('*')
    .eq('automation_id', args.automation.id)
    .gte('position', args.startPosition)
    .order('position', { ascending: true })

  const scoped =
    args.parentStepId === null
      ? baseQuery.is('parent_step_id', null)
      : baseQuery.eq('parent_step_id', args.parentStepId).eq('branch', args.branch ?? 'yes')

  const { data: steps, error: stepsErr } = await scoped

  if (stepsErr) {
    return finishScope(args, [], { kind: 'failed', message: stepsErr.message })
  }
  if (!steps || steps.length === 0) {
    return finishScope(args, [], { kind: 'completed' })
  }

  const results: AutomationLogStepResult[] = []

  for (const [stepIndex, step] of (steps as AutomationStep[]).entries()) {
    // Meta 131056 durable retry (Phase 3) — PER-STEP, not per-run.
    // `args.initialRetryCount` only ever applies to the FIRST step this
    // call processes (index 0) — the exact step a retry pending resumes
    // (resumeAndUnwind seeds it there and nowhere else). Any step
    // reached afterward in THIS SAME call, because the first one
    // succeeded, starts its own potential retry chain at 0 — it has
    // never been retried before. Without this reset, a step that
    // succeeds after 2 retries would leak `retryCount=2` onto the NEXT
    // step's first failure, scheduling it as "retry 3" instead of
    // "retry 1" (see docs/META_131056_AUTOMATION_RETRY_AUDIT.md's
    // Phase 3 section on per-step retry semantics).
    const stepRetryCount = stepIndex === 0 ? (args.initialRetryCount ?? 0) : 0

    // A. Resumed-execution cancellation token. Checked FIRST, before
    // the contact-blocked check below: a resumed run whose pending row
    // was already cancelled (status -> 'done', by a concurrent
    // block_contact_internal) must stop on that fact ALONE — it must
    // never fall through to re-deriving "should this continue?" from
    // contacts.blocked, which a LATER unblock could have already reset
    // to false. That is precisely what would let an unblock revive an
    // execution that was already cancelled mid-flight. A lookup error
    // here fails CLOSED (same reasoning as B below).
    if (args.pendingExecutionId) {
      const pendingState = await isPendingExecutionStillRunning(db, {
        id: args.pendingExecutionId,
        automation_id: args.automation.id,
        account_id: args.automation.account_id,
        contact_id: args.contactId,
        claimToken: args.claimToken,
      })
      if (pendingState === 'error') {
        console.error('[automations] mid-run pending-execution recheck failed')
        return stopExecution(
          args, results, step, 'pending_state_check_failed',
          { kind: 'failed', message: 'pending_state_check_failed' }, 'failed',
        )
      }
      if (pendingState === 'cancelled') {
        return stopExecution(args, results, step, 'pending_execution_cancelled', { kind: 'paused' })
      }
    }

    // B. P0 contact blocking — re-checked before EVERY step, not just
    // once at dispatch. Closes the race where an automation was
    // already running when the contact got blocked: without this, it
    // could still reach a `wait` step and schedule a NEW
    // automation_pending_executions row that (a) shouldn't exist for a
    // blocked contact at all, and (b) would otherwise be able to fire
    // again after a future unblock. Checked account-scoped via the
    // automation's own account_id, never a caller-supplied one.
    //
    // FAIL CLOSED on a lookup error — an automation must NEVER keep
    // running (creating a wait, mutating tags/fields/deals, sending)
    // just because we couldn't confirm the contact isn't blocked. The
    // outbound guard (assertContactCanReceive) only covers sends; it
    // does nothing to stop a non-send side effect or a new wait.
    if (args.contactId) {
      const { data: contactRow, error: contactErr } = await db
        .from('contacts')
        .select('blocked')
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      if (contactErr) {
        console.error('[automations] mid-run contact blocked-check failed:', contactErr)
        return stopExecution(
          args, results, step, 'contact_state_check_failed',
          { kind: 'failed', message: 'contact_state_check_failed' }, 'failed',
        )
      }
      if (contactRow?.blocked) {
        return stopExecution(args, results, step, 'contact_blocked', { kind: 'paused' })
      }
    }

    // C. `wait` is the suspension point: enqueue and stop processing this
    // scope. The cron endpoint will pick it up later.
    if (step.step_type === 'wait') {
      const cfg = step.step_config as WaitStepConfig
      const ms = waitMs(cfg)
      const runAt = new Date(Date.now() + ms).toISOString()

      if (args.contactId) {
        // P0 contact blocking — TOCTOU close. Checks B above and this
        // INSERT used to be two independent calls: a concurrent
        // block_contact_internal could commit `blocked=true` (and its
        // pending/running -> done sweep) in the gap between them,
        // landing a pending row born AFTER the sweep already ran —
        // exactly the "unblock revives an Automation started before
        // the block" bug, just hiding in a NEW wait instead of an
        // existing one. schedule_automation_wait_if_contact_active
        // (migration 044) takes the SAME `SELECT ... FOR UPDATE` row
        // lock on `contacts` that block_contact_internal takes, so the
        // read-then-insert is indivisible with respect to a concurrent
        // block — see that function's own comment for the full
        // serialization argument.
        const { data: scheduled, error: scheduleErr } = await db.rpc(
          'schedule_automation_wait_if_contact_active',
          {
            p_automation_id: args.automation.id,
            p_account_id: args.automation.account_id,
            p_user_id: args.automation.user_id,
            p_contact_id: args.contactId,
            p_log_id: args.logId,
            p_parent_step_id: args.parentStepId,
            p_branch: args.branch,
            p_next_step_position: step.position + 1,
            p_context: args.context,
            p_run_at: runAt,
          },
        )
        if (scheduleErr) {
          // Fail CLOSED — same posture as the contact/pending checks
          // above: if we can't confirm the wait was safely scheduled,
          // it must not exist half-scheduled or silently retried.
          console.error(
            '[automations] schedule_automation_wait_if_contact_active failed:',
            scheduleErr,
          )
          return stopExecution(
            args, results, step, 'wait_schedule_failed',
            { kind: 'failed', message: 'wait_schedule_failed' }, 'failed',
          )
        }
        if (!scheduled) {
          // Contact not found in this account, or blocked — either
          // way, no row was inserted. Same audit shape as the
          // contact-blocked stop above.
          return stopExecution(args, results, step, 'contact_blocked', { kind: 'paused' })
        }
      } else {
        // No contact on this run at all — contact blocking doesn't
        // apply, so the plain insert (no row lock needed) is fine.
        await db.from('automation_pending_executions').insert({
          automation_id: args.automation.id,
          // Tenancy: account_id required NOT NULL post-017.
          account_id: args.automation.account_id,
          user_id: args.automation.user_id,
          contact_id: null,
          log_id: args.logId,
          parent_step_id: args.parentStepId,
          branch: args.branch,
          next_step_position: step.position + 1,
          context: args.context,
          run_at: runAt,
          status: 'pending',
        })
      }

      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail: `waiting ${cfg.amount} ${cfg.unit}`,
      })
      // finishScope decides whether this actually writes 'partial' to
      // automation_logs (only when THIS scope is root) or defers with
      // status=null (nested — an ancestor, sync or via resumeAndUnwind,
      // owns the real status). Previously this wrote 'partial'
      // unconditionally regardless of nesting — see finishScope's doc.
      return finishScope(args, results, { kind: 'paused' })
    }

    try {
      if (step.step_type === 'condition') {
        const cfg = step.step_config as ConditionStepConfig
        const taken = await evaluateCondition(cfg, args)
        results.push({
          step_id: step.id,
          step_type: 'condition',
          status: 'success',
          detail: `branch=${taken ? 'yes' : 'no'}`,
        })
        // Recurse into the chosen branch at position 0 (children use their
        // own ordering within the branch scope).
        const childOutcome = await executeStepsFrom({
          ...args,
          parentStepId: step.id,
          branch: taken ? 'yes' : 'no',
          startPosition: 0,
          logId: args.logId,
        })
        if (childOutcome.kind !== 'completed') {
          // The branch paused or failed — persist THIS scope's own
          // results (including the "condition -> branch=yes/no" entry
          // just pushed above) exactly once via finishScope, and stop.
          // The child already persisted its OWN results independently
          // when IT returned — nothing here duplicates or drops them.
          return finishScope(args, results, childOutcome)
        }
        continue
      }

      // Preventive Meta pacing (Phase 4). Only steps that will actually
      // reach Meta's Cloud API for THIS account participate — a
      // ManyChat-bridged send_message/send_media never waits and never
      // touches runtime.lastMetaSendCompletedAtMs (see
      // isAutomationMetaOutboundStep's own doc for why this can't just
      // be OUTBOUND_SEND_STEP_TYPES).
      const isMetaBoundStep = isAutomationMetaOutboundStep(step.step_type, args.automation.account_id)
      if (isMetaBoundStep) {
        const pacedMs = await paceMetaOutbound(args.runtime)
        // Section 10 of the Fase 4 spec: a NON-ZERO delay means real
        // wall-clock time just passed while this worker was asleep. If
        // this execution is a resumed pending, its lease could have
        // been reclaimed by another worker during that sleep — re-check
        // ownership with the EXACT SAME mechanism the per-step
        // cancellation gate above already uses (never a second
        // ownership system) before actually sending. A delay of 0 means
        // no time was spent sleeping, so there's nothing new to
        // re-check beyond what gate A already confirmed at the top of
        // this iteration.
        if (pacedMs > 0 && args.pendingExecutionId) {
          const pendingState = await isPendingExecutionStillRunning(db, {
            id: args.pendingExecutionId,
            automation_id: args.automation.id,
            account_id: args.automation.account_id,
            contact_id: args.contactId,
            claimToken: args.claimToken,
          })
          if (pendingState === 'error') {
            return stopExecution(
              args, results, step, 'pending_state_check_failed',
              { kind: 'failed', message: 'pending_state_check_failed' }, 'failed',
            )
          }
          if (pendingState === 'cancelled') {
            return stopExecution(args, results, step, 'pending_execution_cancelled', { kind: 'paused' })
          }
        }
      }

      const detail = await runStep(step, args)
      if (isMetaBoundStep) {
        // Only after runStep returns WITHOUT throwing — never before the
        // POST, and never for a 131056 retry-scheduled outcome (that
        // path returns early via scheduleMetaRateLimitRetry below and
        // never reaches this line), any other Meta non-2xx, a ManyChat
        // error, a validation error, or a contact-blocked stop. All of
        // those leave lastMetaSendCompletedAtMs untouched. The one
        // special case — Meta accepts the send but the SUBSEQUENT DB
        // persistence throws — also never reaches here (runStep itself
        // throws in that case), but doesn't need to: that throw fails
        // this whole scope, so no LATER send in this same run will ever
        // exist to pace against.
        args.runtime.lastMetaSendCompletedAtMs = Date.now()
      }
      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'success',
        detail,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)

      // Meta 131056 durable retry (Phase 3) — ONLY for the 5 outbound
      // Meta send step types, and ONLY when there's a contact to retry
      // against (always true for a real outbound send in practice, but
      // checked explicitly rather than assumed). classifyMetaSendError
      // is the SAME classifier used everywhere else — its own contract
      // (docs/META_131056_AUTOMATION_RETRY_AUDIT.md Phase 2) already
      // guarantees anything that isn't a real Meta 131056 comes back
      // non-retryable, so no additional text/regex check is needed
      // here: a ManyChat error, a DB-persistence-after-success error, a
      // plain 429, a 131030, etc. all fall straight through to the
      // existing terminal-failure path below exactly as before this
      // phase existed. `scheduleMetaRateLimitRetry` always calls
      // finishScope exactly once itself and returns that outcome — it
      // is never called AND then followed by the plain failure path
      // below, which would double-persist `results`.
      if (OUTBOUND_SEND_STEP_TYPES.has(step.step_type) && args.contactId) {
        const classification = classifyMetaSendError(err)
        if (classification.retryable && stepRetryCount < MAX_META_RATE_LIMIT_RETRIES) {
          return scheduleMetaRateLimitRetry({
            args,
            step,
            results,
            nextRetryCount: stepRetryCount + 1,
            retryAfterSeconds: classification.retryAfterSeconds,
            fallbackMessage: msg,
          })
        }
      }

      results.push({
        step_id: step.id,
        step_type: step.step_type,
        status: 'failed',
        detail: msg,
      })
      return finishScope(args, results, { kind: 'failed', message: msg })
    }
  }

  return finishScope(args, results, { kind: 'completed' })
}

/**
 * Meta 131056 durable retry (Phase 3) — schedule a retry pending for
 * `step` (an outbound send that just threw a retryable MetaApiError)
 * and produce the ExecutionOutcome this scope reports for it. Always
 * calls `finishScope` exactly once and returns its result — callers
 * must `return` this directly, never call it and then ALSO run the
 * plain terminal-failure path (that would double-persist `results`).
 *
 * `next_step_position` is set to `step.position` — NOT `step.position +
 * 1` like the `wait` step uses — because a retry must repeat the EXACT
 * SAME step, never advance past it. `retry_step_id: step.id` is what
 * lets the resume path (see `resumePendingExecution`'s exact-step
 * validation) later confirm the automation wasn't edited out from under
 * this retry before blindly re-running whatever now sits at that
 * position.
 */
async function scheduleMetaRateLimitRetry(input: {
  args: ExecuteArgs
  step: AutomationStep
  results: AutomationLogStepResult[]
  /** 1-indexed — this is the retry about to be scheduled, always
   *  `stepRetryCount + 1` at the call site. */
  nextRetryCount: number
  retryAfterSeconds?: number
  /** The original error's message — used as the log's error_message
   *  ONLY if the retry scheduling RPC itself fails technically (a
   *  distinct, rarer failure from the Meta error that triggered this
   *  in the first place). */
  fallbackMessage: string
}): Promise<ExecutionOutcome> {
  const { args, step, results, nextRetryCount, retryAfterSeconds, fallbackMessage } = input
  const db = supabaseAdmin()

  // Deterministic per (automation, contact, step, retry number) — see
  // meta-retry-backoff.ts's own doc for why this must never use
  // Math.random(): the same logical retry must always back off by the
  // same amount, and tests must never flake.
  const seed = `${args.automation.id}:${args.contactId}:${step.id}:${nextRetryCount}`
  const delayMs = metaRateLimitDelayMs({ retryNumber: nextRetryCount, retryAfterSeconds, seed })
  const runAt = new Date(Date.now() + delayMs).toISOString()

  const { data: scheduled, error: scheduleErr } = await db.rpc(
    'schedule_automation_retry_if_contact_active',
    {
      p_automation_id: args.automation.id,
      p_account_id: args.automation.account_id,
      p_user_id: args.automation.user_id,
      p_contact_id: args.contactId,
      p_log_id: args.logId,
      p_parent_step_id: args.parentStepId,
      p_branch: args.branch,
      // The SAME step, never +1 — a retry repeats it exactly.
      p_next_step_position: step.position,
      p_context: args.context,
      p_run_at: runAt,
      p_retry_count: nextRetryCount,
      p_retry_reason: 'meta_pair_rate_limit',
      p_retry_step_id: step.id,
    },
  )

  if (scheduleErr) {
    // Fail CLOSED, same posture as every other RPC-error branch in this
    // file — a technical scheduling failure is terminal, NOT another
    // retry attempt (retrying the retry-scheduler itself risks an
    // unbounded loop with no backoff of its own).
    console.error('[automations] schedule_automation_retry_if_contact_active failed:', scheduleErr)
    results.push({ step_id: step.id, step_type: step.step_type, status: 'failed', detail: fallbackMessage })
    return finishScope(args, results, { kind: 'failed', message: fallbackMessage })
  }

  if (!scheduled) {
    // Contact not found in this account, or blocked — same audit shape
    // as the wait step's own !scheduled branch: stop, don't send, no
    // ancestor continuation. Never falls back to treating the ORIGINAL
    // Meta error as a plain failure — the correct read of "blocked" is
    // "stopped for that reason", not "the send technically failed".
    return stopExecution(args, results, step, 'contact_blocked', { kind: 'paused' })
  }

  results.push({
    step_id: step.id,
    step_type: step.step_type,
    status: 'retry_scheduled',
    detail: `Meta rate limit (131056) — retry ${nextRetryCount}/${MAX_META_RATE_LIMIT_RETRIES} scheduled for ${runAt}`,
  })
  // finishScope maps `paused` to automation_logs.status='partial' when
  // this is the root scope (or defers with status=null when nested) —
  // exactly like a normal `wait`. A retry IS a wait, from the log's
  // point of view.
  return finishScope(args, results, { kind: 'paused' })
}

async function runStep(step: AutomationStep, args: ExecuteArgs): Promise<string> {
  const db = supabaseAdmin()

  switch (step.step_type) {
    case 'send_message': {
      const cfg = step.step_config as SendMessageStepConfig
      if (!args.contactId) throw new Error('send_message needs a contact')
      const text = interpolate(cfg.text, args)
      if (!text.trim()) throw new Error('send_message has empty text')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendText({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        text,
      })
      return `sent (${whatsapp_message_id})`
    }

    case 'send_buttons':
    case 'send_list': {
      const payload = step.step_config as SendButtonsStepConfig | SendListStepConfig
      if (!args.contactId) throw new Error(`${step.step_type} needs a contact`)
      // Validate against Meta's limits before the network call so a bad
      // payload surfaces as a clear failed-step detail rather than a raw
      // Meta 400 mid-conversation.
      const check = validateInteractivePayload(payload)
      if (!check.ok) throw new Error(check.error)
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendInteractive({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        payload,
      })
      return `interactive sent via Meta (${whatsapp_message_id})`
    }

    case 'send_template': {
      const cfg = step.step_config as SendTemplateStepConfig
      if (!args.contactId) throw new Error('send_template needs a contact')
      if (!cfg.template_name) throw new Error('send_template needs template_name')
      const conversationId = await resolveConversationId(args)
      // Meta templates use positional {{1}}, {{2}}, … placeholders, so
      // we MUST emit params in strict numeric order. Lexicographic sort
      // of "1", "2", …, "10" yields "1", "10", "2", … which silently
      // scrambles every template with ≥10 variables.
      const params = cfg.variables
        ? Object.keys(cfg.variables)
            .sort((a, b) => {
              const na = Number(a)
              const nb = Number(b)
              const aNum = Number.isFinite(na)
              const bNum = Number.isFinite(nb)
              if (aNum && bNum) return na - nb
              if (aNum) return -1
              if (bNum) return 1
              return a.localeCompare(b)
            })
            .map((k) => String(cfg.variables![k]))
        : []
      const { whatsapp_message_id } = await engineSendTemplate({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        templateName: cfg.template_name,
        language: cfg.language,
        params,
      })
      return `template sent via Meta (${whatsapp_message_id})`
    }

    case 'send_media': {
      const cfg = step.step_config as SendMediaStepConfig
      if (!args.contactId) throw new Error('send_media needs a contact')
      if (!cfg.media_url) throw new Error('send_media needs media_url')
      const conversationId = await resolveConversationId(args)
      const { whatsapp_message_id } = await engineSendMedia({
        accountId: args.automation.account_id,
        userId: args.automation.user_id,
        conversationId,
        contactId: args.contactId,
        kind: cfg.media_type,
        link: cfg.media_url,
        caption: cfg.caption,
        filename: cfg.filename,
        manychatBridgeFlowNs: cfg.manychat_bridge_flow_ns,
      })
      return `media sent (${whatsapp_message_id})`
    }

    case 'add_tag': {
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('add_tag needs contact + tag_id')
      const added = await addContactTagIfAbsent(db, {
        accountId: args.automation.account_id,
        contactId: args.contactId,
        tagId: cfg.tag_id,
      })
      if (!added) return `tag ${cfg.tag_id} already present`

      const depth = getTagChainDepth(args.context)
      if (depth >= MAX_TAG_CHAIN_DEPTH) {
        console.warn('[automations] tag_added chain depth limit reached', {
          automationId: args.automation.id,
          contactId: args.contactId,
          tagId: cfg.tag_id,
          depth,
        })
        return `tag ${cfg.tag_id} added; tag_added dispatch skipped at depth ${depth}`
      }

      await runAutomationsForTrigger({
        accountId: args.automation.account_id,
        triggerType: 'tag_added',
        contactId: args.contactId,
        context: {
          ...args.context,
          tag_id: cfg.tag_id,
          vars: {
            ...(args.context.vars ?? {}),
            _tag_chain_depth: depth + 1,
          },
        },
      })
      return `tag ${cfg.tag_id} added and tag_added dispatched`
    }

    case 'remove_tag': {
      // See add_tag: tenant scoping relies on the runAutomationsForTrigger
      // ownership guard, since contact_tags carries no account_id.
      const cfg = step.step_config as TagStepConfig
      if (!args.contactId || !cfg.tag_id) throw new Error('remove_tag needs contact + tag_id')
      await db
        .from('contact_tags')
        .delete()
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.tag_id)
      return `tag ${cfg.tag_id} removed`
    }

    case 'assign_conversation': {
      const cfg = step.step_config as AssignConversationStepConfig
      if (!args.contactId) throw new Error('assign_conversation needs a contact')
      let agentId = cfg.agent_id
      if (cfg.mode === 'round_robin') {
        // Pick any member of the account. The existing implementation
        // only ever returned the automation's author; preserving that
        // shape until a real round-robin algorithm replaces it.
        const { data: profiles } = await db
          .from('profiles')
          .select('user_id')
          .eq('account_id', args.automation.account_id)
          .limit(1)
        agentId = profiles?.[0]?.user_id
      }
      if (!agentId) return 'no agent resolved'
      await db
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return `assigned to ${agentId}`
    }

    case 'update_contact_field': {
      const cfg = step.step_config as UpdateContactFieldStepConfig
      if (!args.contactId) throw new Error('update_contact_field needs a contact')
      // Resolve workflow variables ({{ vars.* }}, {{ message.text }}) so custom
      // values can be populated dynamically from the triggering context.
      const value = interpolate(cfg.value, args)

      // Custom fields are encoded as `custom:<custom_field_id>`; anything else
      // is a built-in contact column.
      if (cfg.field.startsWith('custom:')) {
        const customFieldId = cfg.field.slice('custom:'.length)
        if (!customFieldId) {
          return `field ${cfg.field} not writable from automations`
        }
        // Defense in depth: the service-role client bypasses RLS, so confirm
        // the field definition belongs to this account before writing.
        const { data: field } = await db
          .from('custom_fields')
          .select('id')
          .eq('id', customFieldId)
          .eq('account_id', args.automation.account_id)
          .maybeSingle()
        if (!field) {
          return `field ${cfg.field} not writable from automations`
        }
        // Upsert on the table's UNIQUE(contact_id, custom_field_id) so repeated
        // runs overwrite rather than duplicate. Tenancy is enforced above and,
        // for the contact side, by the entry-point ownership guard.
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: args.contactId, custom_field_id: customFieldId, value },
            { onConflict: 'contact_id,custom_field_id' },
          )
        return `custom field updated`
      }

      const allowed = new Set(['name', 'email', 'company'])
      if (!allowed.has(cfg.field)) {
        return `field ${cfg.field} not writable from automations`
      }
      // Defense in depth: scope the service-role write to the account so
      // a future caller that skips the entry-point ownership guard still
      // cannot write across tenants.
      await db
        .from('contacts')
        .update({ [cfg.field]: value, updated_at: new Date().toISOString() })
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
      return `${cfg.field} updated`
    }

    case 'create_deal': {
      const cfg = step.step_config as CreateDealStepConfig
      if (!cfg.pipeline_id || !cfg.stage_id) throw new Error('create_deal needs pipeline + stage')
      // Match the account's configured default currency rather than
      // the static `deals.currency` DB default — keeps automation-
      // created deals consistent with the one-currency-per-account
      // rule (issue #218). Fall back to USD if the row is somehow
      // missing the value (pre-021 forks).
      const { data: acct } = await db
        .from('accounts')
        .select('default_currency')
        .eq('id', args.automation.account_id)
        .maybeSingle()
      await db.from('deals').insert({
        // Tenancy + audit, same split as automation_logs above.
        account_id: args.automation.account_id,
        user_id: args.automation.user_id,
        pipeline_id: cfg.pipeline_id,
        stage_id: cfg.stage_id,
        contact_id: args.contactId,
        title: interpolate(cfg.title, args),
        value: cfg.value ?? 0,
        currency: acct?.default_currency ?? 'USD',
        status: 'open',
      })
      return 'deal created'
    }

    case 'send_webhook': {
      const cfg = step.step_config as SendWebhookStepConfig
      if (!cfg.url) throw new Error('send_webhook needs url')
      // SSRF guard: the URL and headers are account-controlled and the
      // server makes the request, so refuse any destination that resolves
      // to a private / loopback / link-local / reserved address. Mirrors
      // the webhook_endpoints delivery path (see lib/webhooks/deliver.ts).
      if (!(await isDeliverableUrl(cfg.url))) {
        throw new Error('send_webhook: destination not allowed')
      }
      const body = cfg.body_template ? interpolate(cfg.body_template, args) : JSON.stringify(args.context)
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
        body,
        // Do NOT follow redirects — a public URL could 3xx-bounce to an
        // internal address, defeating the guard above. Bound the request
        // so a hung/slow internal host can't tie up the runner.
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`webhook returned ${res.status}`)
      return `webhook ${res.status}`
    }

    case 'close_conversation': {
      if (!args.contactId) throw new Error('close_conversation needs a contact')
      await db
        .from('conversations')
        .update({ status: 'closed', updated_at: new Date().toISOString() })
        .eq('account_id', args.automation.account_id)
        .eq('contact_id', args.contactId)
      return 'conversation closed'
    }

    default:
      return `unknown step: ${step.step_type}`
  }
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

/**
 * Pick the conversation a send-type step should use. Prefer the id the
 * webhook handed us (it's the one that just got the inbound message);
 * fall back to the contact's conversation for resumed/wait paths and
 * manual engine POSTs. Throws if none exists — send steps have
 * no meaningful target without a conversation.
 */
async function resolveConversationId(args: ExecuteArgs): Promise<string> {
  const fromCtx = args.context.conversation_id
  if (fromCtx) return fromCtx
  if (!args.contactId) throw new Error('cannot resolve conversation: no contact')
  const { data, error } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('account_id', args.automation.account_id)
    .eq('contact_id', args.contactId)
    .maybeSingle()
  if (error) throw new Error(`conversation lookup failed: ${error.message}`)
  if (!data?.id) {
    const prefix = args.triggerEvent === 'tag_added'
      ? 'tag_added automation cannot send'
      : 'cannot send'
    throw new Error(`${prefix}: contact has no existing conversation`)
  }
  return data.id as string
}

/** Letter, digit or underscore in any script — the "inside a word" test. */
const WORD_CHAR = '[\\p{L}\\p{N}_]'

/**
 * Whole-word keyword test, behind `match_type: 'word'` (issue #409 — a
 * one-letter keyword under `contains` fires on every message containing
 * that letter, e.g. "k" on "thanks").
 *
 * Deliberately NOT `\b`, which is defined against `[A-Za-z0-9_]` and so
 * breaks two cases that matter for WhatsApp traffic:
 *
 *   - A keyword carrying punctuation: `/\bhi!\b/` demands a word character
 *     after the "!", so it never matches "say hi!".
 *   - Any non-Latin script: every character of "안녕" is a non-word
 *     character to `\b`, so `/\b안녕\b/` matches nothing at all.
 *
 * Unicode-aware lookarounds handle both. Note this really is word-based:
 * it won't find "안녕" inside "안녕하세요", because a language that doesn't
 * delimit words with spaces has no word edge there. That's what `contains`
 * is for, and it stays the default.
 *
 * Exported for direct unit testing of the escaping / boundary edges.
 */
export function matchesWholeWord(
  text: string,
  keyword: string,
  caseSensitive = false,
): boolean {
  if (!keyword) return false
  // The keyword is account-supplied free text, so metacharacters have to
  // be literal — otherwise "(" is an unterminated group and RegExp throws.
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?<!${WORD_CHAR})${escaped}(?!${WORD_CHAR})`,
    caseSensitive ? 'u' : 'iu',
  )
  return pattern.test(text)
}

export function triggerMatches(automation: Automation, ctx: AutomationContext | undefined): boolean {
  if (automation.trigger_type === 'keyword_match') {
    const cfg = automation.trigger_config as KeywordMatchTriggerConfig
    if (!cfg?.keywords || cfg.keywords.length === 0) return false
    const text = (ctx?.message_text ?? '').toString()
    if (!text) return false
    if (cfg.match_type === 'word') {
      return cfg.keywords.some((raw) =>
        matchesWholeWord(text, raw, cfg.case_sensitive),
      )
    }
    const haystack = cfg.case_sensitive ? text : text.toLowerCase()
    return cfg.keywords.some((raw) => {
      const k = cfg.case_sensitive ? raw : raw.toLowerCase()
      return cfg.match_type === 'exact' ? haystack === k : haystack.includes(k)
    })
  }

  // Match on the tapped button / list-row id (exact). Lets multi-step
  // menus be chained: automation A sends buttons, automation B fires on
  // the reply id and sends the next step.
  if (automation.trigger_type === 'interactive_reply') {
    const cfg = automation.trigger_config as InteractiveReplyTriggerConfig
    const replyId = ctx?.interactive_reply_id
    if (!replyId || !Array.isArray(cfg?.reply_ids) || cfg.reply_ids.length === 0) {
      return false
    }
    return cfg.reply_ids.includes(replyId)
  }

  if (automation.trigger_type === 'tag_added') {
    const cfg = automation.trigger_config as TagTriggerConfig
    const tagId = ctx?.tag_id
    return Boolean(tagId && cfg?.tag_id && cfg.tag_id === tagId)
  }

  return true
}

async function evaluateCondition(cfg: ConditionStepConfig, args: ExecuteArgs): Promise<boolean> {
  const db = supabaseAdmin()
  switch (cfg.subject) {
    case 'tag_presence': {
      if (!args.contactId || !cfg.operand) return false
      // contact_tags has no account_id column (its RLS keys off the parent
      // contact), so tenant scoping here relies on the contact-ownership
      // guard in runAutomationsForTrigger.
      const { count } = await db
        .from('contact_tags')
        .select('id', { count: 'exact', head: true })
        .eq('contact_id', args.contactId)
        .eq('tag_id', cfg.operand)
      return (count ?? 0) > 0
    }
    case 'contact_field': {
      if (!args.contactId || !cfg.operand) return false
      // Scope to the account so the condition can't be turned into a
      // cross-tenant read oracle via the service-role client.
      const { data } = await db
        .from('contacts')
        .select(cfg.operand)
        .eq('id', args.contactId)
        .eq('account_id', args.automation.account_id)
        .maybeSingle()
      const v = (data as Record<string, unknown> | null)?.[cfg.operand]
      return v != null && String(v) === String(cfg.value ?? '')
    }
    case 'message_content': {
      const text = (args.context.message_text ?? '').toString()
      return text.toLowerCase().includes((cfg.value ?? '').toLowerCase())
    }
    case 'time_of_day': {
      // operand form "HH:mm-HH:mm" — true if now is within that window
      // (supports over-midnight ranges like "18:00-09:00").
      const [from, to] = (cfg.operand ?? '').split('-')
      if (!from || !to) return false
      const now = new Date()
      const mins = now.getHours() * 60 + now.getMinutes()
      const parse = (s: string) => {
        const [h, m] = s.split(':').map(Number)
        return (h || 0) * 60 + (m || 0)
      }
      const f = parse(from)
      const t = parse(to)
      return f <= t ? mins >= f && mins < t : mins >= f || mins < t
    }
    default:
      return false
  }
}

function waitMs(cfg: WaitStepConfig): number {
  const unitMs = cfg.unit === 'days' ? 86_400_000 : cfg.unit === 'hours' ? 3_600_000 : 60_000
  return Math.max(1_000, cfg.amount * unitMs)
}

function interpolate(s: string, args: ExecuteArgs): string {
  return s.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const [ns, prop] = String(key).split('.')
    if (ns === 'message' && prop === 'text') return String(args.context.message_text ?? '')
    if (ns === 'vars' && prop) return String(args.context.vars?.[prop] ?? '')
    return ''
  })
}

async function appendResults(
  logId: string | null,
  newItems: AutomationLogStepResult[],
  status: 'success' | 'partial' | 'failed' | null,
  errorMessage: string | null,
) {
  if (!logId) return
  const db = supabaseAdmin()
  const { data: existing } = await db
    .from('automation_logs')
    .select('steps_executed, status')
    .eq('id', logId)
    .single()
  const merged = [
    ...((existing?.steps_executed as AutomationLogStepResult[] | undefined) ?? []),
    ...newItems,
  ]
  const update: Record<string, unknown> = { steps_executed: merged }
  // Only overwrite status on the outermost scope — nested branches pass null.
  if (status !== null) {
    update.status = status
  }
  if (errorMessage) update.error_message = errorMessage
  await db.from('automation_logs').update(update).eq('id', logId)
}

async function finalizeLog(
  logId: string | null,
  status: 'success' | 'partial' | 'failed',
  errorMessage: string | null,
) {
  if (!logId) return
  await supabaseAdmin()
    .from('automation_logs')
    .update({ status, error_message: errorMessage })
    .eq('id', logId)
}

/**
 * Meta 131056 durable retry, Phase 3.1 — ownership-aware. Before this,
 * any caller holding a `pending.id` could mark the row done/failed
 * unconditionally; once a lease can expire and be reclaimed, that's
 * exactly the "stale worker stomps the new owner's in-flight state"
 * bug this closes. The UPDATE's WHERE clause requires BOTH
 * `status = 'running'` AND `claim_token = expectedClaimToken` — if the
 * row was already reclaimed by a newer worker (new token) or already
 * moved on (done/failed/pending again), this is a no-op: 0 rows match,
 * nothing is overwritten, and the stale caller has no way to tell the
 * difference from here (it doesn't need to — its own next
 * isPendingExecutionStillRunning check will already have stopped it).
 * Clearing claim_token/lease_expires_at on success matches the CHECK
 * constraint added in migration 050 (`status IN ('done','failed')`
 * doesn't require it, but a real worker completing normally should
 * still leave a clean row rather than a dangling token).
 */
async function markPending(id: string, status: 'done' | 'failed', expectedClaimToken: string) {
  await supabaseAdmin()
    .from('automation_pending_executions')
    .update({ status, claim_token: null, lease_expires_at: null })
    .eq('id', id)
    .eq('status', 'running')
    .eq('claim_token', expectedClaimToken)
}
