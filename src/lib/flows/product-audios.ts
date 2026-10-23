/**
 * The `send_product_audios` Flow node: find the contact's Producto, look it up in the catalog and send its voice notes in order.
 *
 * It is a node of the EXISTING runner (no parallel engine): the runner calls `executeSendProductAudios` and acts on the result. All the
 * state of the sequence lives in `audio_guide_requests` / `audio_guide_sends` (migration 075), so what the node does is idempotent: the
 * request is keyed by the inbound message that started the run, a second execution for the same message sends nothing.
 *
 * Order of decisions, each one failing SAFE (nothing is sent):
 *   1. the node is configured (gate tag, four routes) and voice notes are enabled for the account;
 *   2. the contact belongs to the run's account;
 *   3. GATE: the contact carries the configured tag. Provisional technical condition; it is NOT claimed to reproduce ManyChat's
 *      "Switch - Audio Guía 1" (what that Switch is, who sets it and when it clears are still unknown).
 *   4. the `Producto` custom field of THIS account is found: exactly one field named Producto (or the configured one). None or several is a
 *      configuration error, never a guess;
 *   5. the catalog answers (`lookupProductAudios`, deterministic, no AI): no value / unknown / inactive -> the "unknown" route,
 *      no active audio -> the "no audios" route;
 *   6. the request is opened (snapshot of the active audios) and the sequence runs within the inline budget.
 * SELECTION. The node sends every active audio ("all", the original behaviour) or exactly ONE ("single": the audio of the product classified with
 * the node's purpose and identifier, migration 076). In single mode the request is keyed by `<inbound message>#<node key>` so two nodes of the same
 * Flow never collide, while a retry of the same node for the same message finds its request and sends nothing. Anything that prevents sending that
 * one audio (inactive/unknown purpose or identifier, no audio with that pair, audio switched off) is the "no audios" route, never "send them all".
 * The node reports success (`next`) only when EVERY audio was sent. Anything else is `failed`: the run is never marked complete while
 * audios are missing. Leftover audios (budget exhausted) stay pending for the resumer.
 */

import { lookupProductAudios, CatalogLookupError, type ProductAudioLookup } from "@/lib/audio-guide/lookup";
import { normalizeProductValue } from "@/lib/audio-guide/normalize";
import { sendVoiceNoteViaEngine } from "@/lib/audio-guide/sender";
import { INLINE_BUDGET_MS, makeHaltCheck, runAudioSequence, type SendContext, type SequencerDb, type SequencerDeps } from "@/lib/audio-guide/sequencer";
import type { CatalogDb } from "@/lib/audio-guide/catalog";
import { isVoiceNoteEnabledForAccount } from "./voice-note-capability";
import { gateModeOf, inspectProductAudiosConfig, productAudiosRouteKeys, productSourceOf, selectionOf } from "./product-audios-config";
import type { FlowRunRow, SendProductAudiosNodeConfig } from "./types";

type Db = SequencerDb & CatalogDb;

export type ProductAudiosResult =
  | { kind: "next"; nodeKey: string; detail: Record<string, unknown> }
  | { kind: "blocked" }
  | { kind: "paused"; reason: string }
  | { kind: "failed"; reason: string; detail?: Record<string, unknown> };

/** Answers of audio_guide_open_selected_request that mean "that one audio cannot be sent" (as opposed to a failure). */
const SELECTED_UNAVAILABLE: ReadonlySet<string> = new Set(["purpose_unavailable", "identifier_unavailable", "audio_not_found", "audio_disabled"]);


/** A usable node: its gate/product choices are coherent (see product-audios-config.ts) and every output it needs is set. */
export function isProductAudiosConfigValid(cfg: Partial<SendProductAudiosNodeConfig> | null | undefined): cfg is SendProductAudiosNodeConfig {
  if (!cfg || inspectProductAudiosConfig(cfg).length > 0) return false;
  const values = cfg as Record<string, unknown>;
  return productAudiosRouteKeys(cfg).every((k) => typeof values[k] === "string" && (values[k] as string).trim() !== "");
}

/** The custom field that holds the product, or why it cannot be chosen. Never picks one of several. */
export async function resolveProductField(db: Db, accountId: string, configuredId?: string): Promise<{ ok: true; fieldId: string } | { ok: false; reason: "product_field_missing" | "product_field_ambiguous" | "product_field_lookup_failed" }> {
  const { data, error } = await db.from("custom_fields").select("id, field_name").eq("account_id", accountId);
  if (error) return { ok: false, reason: "product_field_lookup_failed" };
  const fields = (data as Array<{ id: string; field_name: string }> | null) ?? [];
  if (configuredId) return fields.some((f) => f.id.toLowerCase() === configuredId.toLowerCase()) ? { ok: true, fieldId: configuredId } : { ok: false, reason: "product_field_missing" };
  const named = fields.filter((f) => { const n = normalizeProductValue(f.field_name); return n.ok && n.key === "producto"; });
  if (named.length === 0) return { ok: false, reason: "product_field_missing" };
  if (named.length > 1) return { ok: false, reason: "product_field_ambiguous" };
  return { ok: true, fieldId: named[0].id };
}

/** The key that makes the request unique per inbound message: Meta's/ManyChat's message id, or the run itself for a manual start. */
async function triggerKey(db: Db, run: FlowRunRow): Promise<string> {
  const { data } = await db.from("flow_run_events").select("payload").eq("flow_run_id", run.id).eq("event_type", "started").limit(1);
  const payload = (data as Array<{ payload?: { meta_message_id?: unknown } }> | null)?.[0]?.payload;
  const id = payload?.meta_message_id;
  return typeof id === "string" && id.trim() !== "" ? id : `run:${run.id}`;
}

export interface ProductAudiosDeps {
  sequencer?: Partial<SequencerDeps>;
  budgetMs?: number;
  now?: () => number;
}

export async function executeSendProductAudios(args: { db: Db; run: FlowRunRow; nodeKey: string; config: unknown; deps?: ProductAudiosDeps }): Promise<ProductAudiosResult> {
  const { db, run } = args;
  const cfg = args.config as Partial<SendProductAudiosNodeConfig> | null;
  if (!isProductAudiosConfigValid(cfg)) return { kind: "failed", reason: "node_config_invalid" };
  if (!isVoiceNoteEnabledForAccount(run.account_id)) return { kind: "failed", reason: "voice_notes_not_enabled" };
  if (!run.contact_id || !run.conversation_id) return { kind: "failed", reason: "run_without_contact" };
  const accountId = run.account_id;
  const contactId = run.contact_id;
  const conversationId = run.conversation_id;

  const { data: contact, error: contactError } = await db.from("contacts").select("id").eq("id", contactId).eq("account_id", accountId).maybeSingle();
  if (contactError) return { kind: "failed", reason: "contact_lookup_failed" };
  if (!contact) return { kind: "failed", reason: "contact_not_in_account" };

  const single = selectionOf(cfg) === "single";
  const purposeId = single ? String(cfg.purpose_id).toLowerCase() : null;
  const identifierId = single ? String(cfg.identifier_id).toLowerCase() : null;
  const inbound = await triggerKey(db, run);
  // One request per inbound message for "all"; one per inbound message AND node for "single" (the node key is appended, never replaces the message id).
  const trigger = single ? `${inbound}#${args.nodeKey}` : inbound;
  const skip = async (reason: string, productKey?: string | null) => {
    if (single) {
      await db.rpc("audio_guide_record_selected_skip", { p_account: accountId, p_contact: contactId, p_conversation: conversationId, p_run: run.id, p_trigger: trigger, p_product_key: productKey ?? null, p_reason: reason, p_purpose: purposeId, p_identifier: identifierId, p_node_key: args.nodeKey });
      return;
    }
    await db.rpc("audio_guide_record_skip", { p_account: accountId, p_contact: contactId, p_conversation: conversationId, p_run: run.id, p_trigger: trigger, p_product_key: productKey ?? null, p_reason: reason });
  };

  // ---- 3. the gate, only when the node asks for a tag (a node saved before `gate_mode` existed always does). Fails closed: a tag that is
  //         not this account's counts as an error, a missing tag on the contact closes the gate.
  const gateRequired = gateModeOf(cfg) !== "none";
  if (gateRequired) {
    const { data: tag, error: tagError } = await db.from("tags").select("id").eq("id", cfg.gate_tag_id).eq("account_id", accountId).maybeSingle();
    if (tagError) return { kind: "failed", reason: "gate_lookup_failed" };
    if (!tag) return { kind: "failed", reason: "gate_tag_not_in_account" };
    const { count: tagged, error: taggedError } = await db.from("contact_tags").select("contact_id", { count: "exact", head: true }).eq("contact_id", contactId).eq("tag_id", cfg.gate_tag_id);
    if (taggedError) return { kind: "failed", reason: "gate_lookup_failed" };
    if (!tagged) {
      await skip("gate_closed");
      return { kind: "next", nodeKey: cfg.gate_closed_node_key, detail: { route: "gate_closed" } };
    }
  }

  // ---- 4. which product: the contact's Producto field (automatic) or the catalog product chosen in the node (manual)
  const manual = productSourceOf(cfg) === "manual";
  let productValue: string | null = null;
  if (!manual) {
    const field = await resolveProductField(db, accountId, cfg.product_field_id || undefined);
    if (!field.ok) return { kind: "failed", reason: field.reason };
    const { data: valueRow, error: valueError } = await db.from("contact_custom_values").select("value").eq("contact_id", contactId).eq("custom_field_id", field.fieldId).maybeSingle();
    if (valueError) return { kind: "failed", reason: "product_value_lookup_failed" };
    productValue = (valueRow as { value?: string | null } | null)?.value ?? null;
  }

  // ---- 5. the catalog (one retry if the catalog changed between the lookup and the snapshot)
  let opened: { request_id: string; created: boolean; status: string } | null = null;
  for (let attempt = 0; attempt < 2 && !opened; attempt++) {
    let found: ProductAudioLookup;
    try {
      found = await lookupProductAudios(manual ? { db, accountId, productId: cfg.product_id } : { db, accountId, productValue });
    } catch (err) {
      return { kind: "failed", reason: err instanceof CatalogLookupError ? "catalog_lookup_failed" : "catalog_error" };
    }
    if (found.kind === "no_value" || found.kind === "unknown_product" || found.kind === "product_inactive") {
      await skip(found.kind, found.kind === "unknown_product" ? found.key : found.kind === "product_inactive" ? found.product.productKey : null);
      return { kind: "next", nodeKey: cfg.unknown_node_key, detail: { route: "unknown", lookup: found.kind } };
    }
    if (found.kind === "no_audios") {
      await skip("no_audios", found.product.productKey);
      return { kind: "next", nodeKey: cfg.no_audios_node_key, detail: { route: "no_audios", product_key: found.product.productKey } };
    }
    // ---- 6. open the request (idempotent per inbound message, and per node in single mode)
    const { data, error } = single
      ? await db.rpc("audio_guide_open_selected_request", {
        p_account: accountId, p_contact: contactId, p_conversation: conversationId, p_run: run.id, p_trigger: trigger,
        p_product_key: found.product.productKey, p_expected_revision: found.product.revision,
        p_purpose: purposeId, p_identifier: identifierId, p_node_key: args.nodeKey,
      })
      : await db.rpc("audio_guide_open_request", {
        p_account: accountId, p_contact: contactId, p_conversation: conversationId, p_run: run.id, p_trigger: trigger,
        p_product_key: found.product.productKey, p_expected_revision: found.product.revision,
      });
    const r = data as { ok?: boolean; reason?: string; request_id?: string; created?: boolean; status?: string } | null;
    if (error || !r) return { kind: "failed", reason: "request_open_failed" };
    if (r.ok === true && r.request_id) { opened = { request_id: r.request_id, created: r.created === true, status: String(r.status) }; break; }
    if (r.reason === "catalog_changed") continue;
    if (r.reason === "no_audios") { await skip("no_audios", found.product.productKey); return { kind: "next", nodeKey: cfg.no_audios_node_key, detail: { route: "no_audios" } }; }
    if (r.reason === "product_unavailable") { await skip("unknown_product", found.product.productKey); return { kind: "next", nodeKey: cfg.unknown_node_key, detail: { route: "unknown" } }; }
    // The one audio asked for cannot be sent: its purpose or identifier is off or gone, no audio carries that pair, or the audio is switched off.
    // Nothing is sent and the flow takes the "no audios" route; it is NEVER widened to the product's other audios.
    if (single && typeof r.reason === "string" && SELECTED_UNAVAILABLE.has(r.reason)) {
      await skip(r.reason, found.product.productKey);
      return { kind: "next", nodeKey: cfg.no_audios_node_key, detail: { route: "no_audios", selection: "single", why: r.reason, product_key: found.product.productKey } };
    }
    return { kind: "failed", reason: "request_open_failed" };
  }
  if (!opened) return { kind: "failed", reason: "catalog_changed" };

  if (!opened.created) {
    // This inbound message already has its request. Never send again from here: if it finished, this is the same event delivered twice.
    return opened.status === "completed"
      ? { kind: "next", nodeKey: cfg.next_node_key, detail: { route: "next", duplicate: true, request_id: opened.request_id } }
      : { kind: "failed", reason: "request_already_exists", detail: { request_id: opened.request_id, request_status: opened.status } };
  }

  // ---- 6b. run the sequence
  const context: SendContext = { accountId, userId: run.user_id, conversationId, contactId };
  const { data: created } = await db.from("audio_guide_requests").select("created_at").eq("id", opened.request_id).eq("account_id", accountId).maybeSingle();
  const createdAt = (created as { created_at?: string } | null)?.created_at ?? new Date().toISOString();
  const deps: SequencerDeps = {
    sendVoiceNote: sendVoiceNoteViaEngine,
    haltReason: makeHaltCheck({ db, accountId, contactId, conversationId, runId: run.id, requestCreatedAtIso: createdAt }),
    ...args.deps?.sequencer,
  };
  const outcome = await runAudioSequence({ db, context, requestId: opened.request_id, deps, budgetMs: args.deps?.budgetMs ?? INLINE_BUDGET_MS });
  const detail = { request_id: opened.request_id, sent: outcome.sent, ...(single ? { selection: "single" } : {}) };
  switch (outcome.kind) {
    case "completed":
      return { kind: "next", nodeKey: cfg.next_node_key, detail: { ...detail, route: "next" } };
    case "halted":
      if (outcome.reason === "contact_blocked") return { kind: "blocked" };
      if (outcome.reason === "run_not_active" || outcome.reason === "human_takeover") return { kind: "paused", reason: outcome.reason };
      return { kind: "failed", reason: `audio_sequence_halted:${outcome.reason}`, detail };
    case "deferred":
      return { kind: "failed", reason: "audio_sequence_incomplete", detail: { ...detail, why: "time_budget", resumable: true } };
    case "busy":
      return { kind: "failed", reason: "audio_sequence_busy", detail };
    default:
      return { kind: "failed", reason: "audio_sequence_incomplete", detail: { ...detail, request_status: outcome.requestStatus, why: outcome.reason } };
  }
}
