/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { durableWaitSeconds, isDurableWaitConfig } from "./durable-wait";
import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";
import { parseVoiceNoteUrl } from "@/lib/media/voice-note-path";
import { gateModeOf, inspectProductAudiosConfig, productAudiosRouteKeys } from "./product-audios-config";

export interface ValidationIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
  /** Stable code the editor translates (es / en / ko); `message` is the English fallback. */
  code?: string;
  /** Values for the translated text. */
  params?: Record<string, string | number>;
}

interface FlowInput {
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export interface ValidateFlowOptions {
  /**
   * The account that owns the flow. When given (server side), a voice-note node must reference a file stored under THIS
   * account; the browser does not know it and only checks the shape.
   */
  accountId?: string;
  /**
   * Voice notes (send_media audio) are enabled for the account. The server passes the real answer; `false` makes every audio
   * node an error. Left undefined (the browser, which asks the server separately) it is not checked here.
   */
  voiceNoteEnabled?: boolean;
  /**
   * Multimedia (`send_media`) audio is enabled for the account. When given it decides the Multimedia audio check; when left
   * undefined that check falls back to `voiceNoteEnabled`. "Audios por producto" always uses `voiceNoteEnabled`.
   */
  mediaAudioEnabled?: boolean;
  /**
   * F06 versioned execution. Off by default: the legacy runner cannot execute `execute_flow`, so the
   * default validator keeps rejecting it and no existing activation path can publish such a flow.
   */
  versionedExecution?: boolean;
  /**
   * Durable waits (migration 069) may be ACTIVATED only for accounts whose execution is enabled. Off by default: a flow with
   * a durable wait stays a draft, so nothing can run it (and the database refuses it too).
   */
  durableWaitExecution?: boolean;
  /**
   * P8: the account may activate flows that RUN other flows (migration 070 + FLOW_SUBFLOW_EXECUTION_ACCOUNT_IDS). Off by default:
   * the legacy runner then keeps refusing execute_flow exactly as before.
   */
  subflowExecution?: boolean;
  /** The editor has not heard from the server yet: do not claim that running is (not) enabled. */
  executionStatusUnknown?: boolean;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
  options: ValidateFlowOptions = {},
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "name",
      message: "Flow name is required.",
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: "Pick an entry node before activating.",
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: "error",
      scope: "flow",
      message: "A flow needs at least one node before activation.",
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: `Entry node "${flow.entry_node_id}" doesn't exist.`,
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: "error",
        scope: "node",
        node_key: n.node_key,
        message: `Duplicate node_key "${n.node_key}".`,
      });
    }
    seen.add(n.node_key);
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  for (const n of nodes) {
    issues.push(...validateNode(n, keys, options, nodes));
  }

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          message: `Node "${n.node_key}" is unreachable from the entry node.`,
        });
      }
    }
  }

  return issues;
}

// ============================================================
// Trigger
// ============================================================

function validateTrigger(
  trigger_type: FlowInput["trigger_type"],
  trigger_config: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (trigger_type === "keyword") {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: "trigger_config.keywords",
        message: "Keyword triggers need at least one keyword.",
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== "string" || !k.trim(),
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: "warning",
          scope: "trigger",
          field: "trigger_config.keywords",
          message: `${blanks} keyword${blanks === 1 ? " is" : "s are"} blank — they won't match anything.`,
        });
      }
    }
  }
  // first_inbound_message / manual have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>,
  options: ValidateFlowOptions = {},
  allNodes: NodeInput[] = [],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case "start": {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Start node must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Start points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_message": {
      const cfg = node.config as { text?: string; next_node_key?: string };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "Send-message node needs a text body.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Send-message node must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Send-message points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_media": {
      const cfg = node.config as {
        media_type?: "image" | "video" | "document" | "audio";
        media_url?: string;
        media_sha256?: string;
        filename?: string;
        caption?: string;
        manychat_bridge_flow_ns?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !["image", "video", "document", "audio"].includes(cfg.media_type)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_type",
          message: "Send-media node needs a media type (image, video, document, or audio).",
        });
      }
      if (cfg.media_type === "audio") {
        if ((options.mediaAudioEnabled ?? options.voiceNoteEnabled) === false) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "media_type",
            message: "Voice notes are not enabled for this account.",
          });
        }
        // A voice note is only ever a verified, hash-addressed file of THIS
        // account (POST /api/flows/voice-notes); see media/voice-note-path.ts.
        if (cfg.media_url?.trim()) {
          const parsed = parseVoiceNoteUrl(cfg.media_url);
          const ownedHere =
            !options.accountId || parsed?.accountId === options.accountId.toLowerCase();
          if (!parsed || cfg.media_sha256 !== parsed.sha256 || !ownedHere) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: "media_url",
              message:
                "Audio must be a verified voice note (OGG/Opus, mono) uploaded from this account's editor; upload it again.",
            });
          }
        }
        if (cfg.caption?.trim() || cfg.filename?.trim() || cfg.manychat_bridge_flow_ns?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "caption",
            message: "A voice note takes no caption, filename or ManyChat bridge; clear them.",
          });
        }
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_url",
          message: "Send-media node needs a file (upload one before activating).",
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (cfg.caption && cfg.caption.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "caption",
          message: `Caption exceeds ${INTERACTIVE_LIMITS.bodyMaxLength} chars (WhatsApp limit).`,
        });
      }
      // TEMPORARY ManyChat coexistence bridge (PENDIENTE 02.1B) — NOT
      // required globally: a Flow authored for direct Meta sending has
      // no reason to carry one, and must not be blocked from saving/
      // activating for lacking it. Whether it's ACTUALLY needed is a
      // runtime, fail-closed decision (see engineSendMedia in
      // meta-send.ts) that depends on the account's live outbound
      // transport, which this save-time validator has no business
      // deciding. Only format is checked here, and only when a value
      // was actually entered.
      if (
        cfg.manychat_bridge_flow_ns !== undefined &&
        cfg.manychat_bridge_flow_ns !== "" &&
        !/^content[A-Za-z0-9_]+$/.test(cfg.manychat_bridge_flow_ns)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "manychat_bridge_flow_ns",
          message: `ManyChat bridge flow ns must look like "content..." — got "${cfg.manychat_bridge_flow_ns}".`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Send-media node must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Send-media points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_buttons": {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "Send-buttons node needs a text body.",
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: "Send-buttons needs at least one button.",
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: `WhatsApp allows at most ${INTERACTIVE_LIMITS.maxButtons} buttons per message.`,
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Button ${i + 1} needs a reply id.`,
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Duplicate button reply id "${b.reply_id}".`,
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `Button ${i + 1} needs a title.`,
          });
        } else if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `Button ${i + 1} title is over ${INTERACTIVE_LIMITS.buttonTitleMaxLength} chars (WhatsApp limit).`,
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `Button ${i + 1} needs a next node.`,
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `Button ${i + 1} points to non-existent node "${b.next_node_key}".`,
          });
        }
      });
      break;
    }

    case "send_list": {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "Send-list node needs a text body.",
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_label",
          message: "Send-list needs a button label (the tap-to-expand text).",
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0,
      );
      if (totalRows < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: "Send-list needs at least one row.",
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: `Send-list allows at most ${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across sections.`,
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `Row ${ri + 1} in section ${si + 1} needs a reply id.`,
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `Duplicate list row id "${row.reply_id}".`,
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `Row ${ri + 1} needs a title.`,
            });
          } else if (
            row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `Row ${ri + 1} title exceeds ${INTERACTIVE_LIMITS.listRowTitleMaxLength} chars.`,
            });
          }
          if (
            row.description &&
            row.description.length >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.description`,
              message: `Row ${ri + 1} description exceeds ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} chars.`,
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `Row ${ri + 1} needs a next node.`,
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `Row ${ri + 1} points to non-existent node "${row.next_node_key}".`,
            });
          }
        });
      });
      break;
    }

    case "collect_input": {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "prompt_text",
          message: "Collect-input needs a prompt to send the customer.",
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: "Collect-input needs a var_key to store the answer under.",
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: `var_key "${cfg.var_key}" must be alphanumeric+underscore and start with a letter or underscore.`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Collect-input must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Collect-input points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "condition": {
      const cfg = node.config as {
        subject?: "var" | "tag" | "contact_field" | "customer_activity";
        subject_key?: string;
        operator?: "equals" | "contains" | "present" | "absent" | "replied_after_reference";
        value?: string;
        true_next?: string;
        false_next?: string;
      };
      if (!cfg.subject || !["var", "tag", "contact_field", "customer_activity"].includes(cfg.subject)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject",
          message: "Condition needs a subject (var / tag / contact_field / customer_activity).",
        });
      }
      if (cfg.subject === "customer_activity") {
        // P7: "the customer replied after the reference message". The reference is an explicit send node of THIS flow.
        const inherited = cfg.subject_key === "$inherited";
        const referenceNode = allNodes.find((candidate) => candidate.node_key === cfg.subject_key);
        if (cfg.operator !== "replied_after_reference") {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "operator", code: "customer_activity_operator", message: "A customer-activity condition must use the operator replied_after_reference." });
        }
        if (inherited) {
          // Handed down by the calling flow (execute_flow.reference_node_key). Nothing to check here: without a caller it fails closed.
        } else if (!cfg.subject_key?.trim() || !referenceNode) {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "subject_key", code: "customer_activity_reference_missing", message: "Pick the message that marks the start (the reference message) from this flow." });
        } else if (referenceNode.node_type !== "send_message" && referenceNode.node_type !== "send_media") {
          issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "subject_key", code: "customer_activity_reference_type", message: "The reference must be a Send message or Send media step." });
        }
        if (!options.durableWaitExecution && !options.executionStatusUnknown) {
          issues.push({
            severity: "error", scope: "node", node_key: node.node_key, field: "subject", code: "customer_activity_not_enabled",
            message: "The customer-activity condition can be saved in a draft, but running it is not enabled for this account yet, so this flow cannot be activated.",
          });
        }
      } else if (!cfg.subject_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject_key",
          message: "Condition needs a subject_key (var name, tag id, or field name).",
        });
      }
      if (cfg.subject === "customer_activity") {
        // operator already validated above
      } else if (
        !cfg.operator ||
        !["equals", "contains", "present", "absent"].includes(cfg.operator)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "operator",
          message: "Condition needs an operator.",
        });
      } else if (
        (cfg.operator === "equals" || cfg.operator === "contains") &&
        (cfg.value === undefined || cfg.value === "")
      ) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "value",
          message: `Operator "${cfg.operator}" usually expects a comparison value — empty value will only match empty subjects.`,
        });
      }
      for (const branch of ["true_next", "false_next"] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `Condition needs a node for the "${branch === "true_next" ? "true" : "false"}" branch.`,
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `Condition's "${branch}" points to non-existent node "${key}".`,
          });
        }
      }
      break;
    }

    case "set_tag": {
      const cfg = node.config as {
        mode?: "add" | "remove";
        tag_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !["add", "remove"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: "Set-tag needs a mode (add or remove).",
        });
      }
      if (!cfg.tag_id) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "tag_id",
          message: "Set-tag needs a tag to apply.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Set-tag must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Set-tag points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "delay": {
      const cfg = node.config as { seconds?: number; next_node_key?: string };
      if (isDurableWaitConfig(node.config)) {
        const wait = durableWaitSeconds(node.config as { amount?: unknown; unit?: unknown });
        if (!wait.ok) {
          issues.push({
            severity: "error", scope: "node", node_key: node.node_key, field: "amount",
            message: wait.reason === "too_long" ? "A wait can last at most 30 days." : wait.reason === "invalid_unit" ? "Wait unit must be seconds, minutes, hours or days." : "Wait amount must be a whole number of at least 1.",
          });
        }
        if (!options.durableWaitExecution && !options.executionStatusUnknown) {
          issues.push({
            severity: "error", scope: "node", node_key: node.node_key, field: "unit", code: "durable_wait_not_enabled",
            message: "Durable waits can be saved in a draft, but running them is not enabled for this account yet, so this flow cannot be activated.",
          });
        }
      } else if (
        typeof cfg.seconds !== "number" ||
        !Number.isFinite(cfg.seconds) ||
        cfg.seconds < 1 ||
        cfg.seconds > 30
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "seconds",
          message: "Delay must be between 1 and 30 seconds (v1 supports short delays only).",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Delay node must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Delay points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "set_contact_field": {
      const cfg = node.config as {
        field?: string;
        value?: string;
        next_node_key?: string;
      };
      if (!cfg.field?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "field",
          message: "Set-contact-field needs a field to write.",
        });
      } else if (
        !cfg.field.startsWith("custom:") ||
        cfg.field.slice("custom:".length).length === 0
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "field",
          message: `Only custom fields are supported ("custom:<id>") — got "${cfg.field}".`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "Set-contact-field node must point to a next node.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `Set-contact-field points to non-existent node "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "handoff":
    case "end": {
      // Terminal nodes have no outgoing edges. The only setting is P8's scope: end the whole execution (default) or return to the caller.
      const scope = (node.config as { scope?: unknown }).scope;
      if (scope !== undefined && scope !== "run" && scope !== "subflow") {
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field: "scope", code: "end_scope_invalid", message: "End scope must be \"run\" or \"subflow\"." });
      }
      break;
    }

    case "execute_flow": {
      const cfg = node.config as { target_flow_id?: unknown; next_node_key?: unknown; reference_node_key?: unknown; on_customer_reply?: unknown };
      const err = (field: string, code: string, message: string, params?: Record<string, string | number>) =>
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, code, message, ...(params ? { params } : {}) });
      // What the author controls is checked first and ALWAYS, so a missing destination is reported whether or not running connected
      // flows is enabled for the account.
      if (typeof cfg.target_flow_id !== "string" || !UUID_RE.test(cfg.target_flow_id)) {
        err("target_flow_id", "execute_flow_target_missing", "Choose the flow to run.");
      }
      if (typeof cfg.next_node_key !== "string" || !cfg.next_node_key) {
        err("next_node_key", "execute_flow_return_missing", "Choose the step this flow continues at when the called flow ends.");
      } else if (!knownKeys.has(cfg.next_node_key)) {
        err("next_node_key", "execute_flow_return_unknown", `The step this flow continues at ("${cfg.next_node_key}") does not exist.`, { key: cfg.next_node_key });
      }
      if (cfg.reference_node_key !== undefined) {
        const refNode = typeof cfg.reference_node_key === "string" ? allNodes.find((candidate) => candidate.node_key === cfg.reference_node_key) : undefined;
        if (!refNode || (refNode.node_type !== "send_message" && refNode.node_type !== "send_media")) {
          err("reference_node_key", "execute_flow_reference_invalid", "The reference message must be a Send message or Send media step of this flow.");
        }
      }
      if (cfg.on_customer_reply !== undefined && cfg.on_customer_reply !== "stop" && cfg.on_customer_reply !== "continue") {
        err("on_customer_reply", "execute_flow_policy_invalid", "On customer reply must be \"stop\" or \"continue\".");
      }
      // The real state of things, without blaming F06: running connected flows is a per-account capability.
      if (!options.versionedExecution && !options.subflowExecution && !options.executionStatusUnknown) {
        err("target_flow_id", "execute_flow_not_enabled", "Running connected flows is not enabled for this account yet. You can keep building and saving this flow, but it cannot be activated until it is.");
      }
      break;
    }

    case "send_product_audios": {
      const cfg = node.config as Record<string, unknown>;
      const err = (field: string, code: string, message: string) =>
        issues.push({ severity: "error", scope: "node", node_key: node.node_key, field, code, message });
      if (options.voiceNoteEnabled === false) {
        err("media_type", "product_audios_not_enabled", "Voice notes are not enabled for this account.");
      }
      // Gate and product choices, in one place (product-audios-config.ts). A node saved before `gate_mode` existed still requires its tag.
      for (const problem of inspectProductAudiosConfig(cfg)) err(problem.field, problem.code, problem.message);
      // The "gate closed" output exists only when a tag is required.
      const routes: Array<[string, string]> = [["next_node_key", "when every audio was sent"], ["unknown_node_key", "when the product is missing, unknown or inactive"], ["no_audios_node_key", "when the product has no active audio"]];
      if (gateModeOf(cfg) !== "none") routes.push(["gate_closed_node_key", "when the required tag is missing"]);
      for (const [field, label] of routes) {
        const target = cfg[field];
        if (typeof target !== "string" || !target) err(field, "product_audios_route_missing", `Choose the step to continue at ${label}.`);
        else if (!knownKeys.has(target)) err(field, "product_audios_route_unknown", `The step chosen ${label} ("${target}") does not exist.`);
      }
      break;
    }

    default:
      issues.push({
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        message: `Unknown node type "${node.node_type}".`,
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[],
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "delay":
    case "set_contact_field":
    case "execute_flow": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "send_product_audios": {
      const cfg = node.config as Record<string, unknown>;
      return productAudiosRouteKeys(cfg).map((key) => cfg[key]).filter((k): k is string => typeof k === "string" && !!k);
    }
    case "condition": {
      const cfg = node.config as {
        true_next?: string;
        false_next?: string;
      };
      const out: string[] = [];
      if (cfg.true_next) out.push(cfg.true_next);
      if (cfg.false_next) out.push(cfg.false_next);
      return out;
    }
    case "send_buttons": {
      const cfg = node.config as {
        buttons?: Array<{ next_node_key?: string }>;
      };
      return (cfg.buttons ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case "send_list": {
      const cfg = node.config as {
        sections?: Array<{ rows?: Array<{ next_node_key?: string }> }>;
      };
      const out: string[] = [];
      for (const s of cfg.sections ?? []) {
        for (const r of s.rows ?? []) {
          if (r.next_node_key) out.push(r.next_node_key);
        }
      }
      return out;
    }
    case "handoff":
    case "end":
    default:
      return [];
  }
}
