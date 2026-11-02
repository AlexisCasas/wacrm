import type { FlowRow, KeywordTriggerConfig } from "./types";

/**
 * Whole-word keyword matching for flow entry triggers (`match_type: "word"`).
 *
 * Why it exists: the default `contains` matcher is a plain substring test, so a short place name such as "Ica" also fires inside "eléctrica", and
 * "jaen" never matches "Jaén". `word` compares WHOLE WORDS after folding case, accents and punctuation, so "ICA." matches "Ica" and "eléctrica" does not.
 *
 * It is opt-in per flow (`trigger_config.match_type === "word"`); every flow without it keeps the exact behaviour it had before this module existed.
 */

/** Lower-case, strip accents/diacritics, turn every run of non-letters/digits into one space. "¿Jaén, Cajamarca?" -> "jaen cajamarca". */
export function normalizeForWordMatch(input: string): string {
  return input
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** True when `keyword` appears in `text` as a run of WHOLE words (both already normalized). */
function containsWholeWords(normalizedText: string, normalizedKeyword: string): boolean {
  if (!normalizedKeyword) return false;
  return ` ${normalizedText} `.includes(` ${normalizedKeyword} `);
}

/**
 * How specific the best matching keyword of `cfg` is for `text`: the number of words it has ("nuevo chimbote" = 2 beats "chimbote" = 1).
 * `null` when no keyword matches.
 */
export function wordMatchSpecificity(text: string, cfg: KeywordTriggerConfig): number | null {
  if (!text || !cfg.keywords?.length) return null;
  const haystack = normalizeForWordMatch(text);
  if (!haystack) return null;
  let best: number | null = null;
  for (const raw of cfg.keywords) {
    if (typeof raw !== "string") continue;
    const needle = normalizeForWordMatch(raw);
    if (!needle || !containsWholeWords(haystack, needle)) continue;
    const words = needle.split(" ").length;
    if (best === null || words > best) best = words;
  }
  return best;
}

export function isWordFlow(flow: Pick<FlowRow, "trigger_type" | "trigger_config">): boolean {
  return flow.trigger_type === "keyword" && (flow.trigger_config as KeywordTriggerConfig | undefined)?.match_type === "word";
}

function priorityOf(flow: Pick<FlowRow, "trigger_config">): number {
  const p = (flow.trigger_config as KeywordTriggerConfig | undefined)?.word_priority;
  return typeof p === "number" && Number.isInteger(p) && p >= 0 ? p : 0;
}

export type EntryPick =
  | { kind: "flow"; flow: FlowRow }
  | { kind: "ambiguous"; flow_ids: string[] }
  | { kind: "none" };

/**
 * Chooses the flow an inbound message starts, from the ACTIVE flows of an account (already in creation order).
 *
 *  1. Every flow that is NOT `word` is evaluated first, in creation order, exactly as the engine always did (keyword `contains`/`exact`, and
 *     `first_inbound_message`). If one matches it wins: a commercial/ad flow can never be pre-empted by a `word` flow.
 *  2. Only when none matched, the `word` flows compete. The winner has the most specific keyword (most words), then the highest `word_priority`
 *     (an explicit integer in the flow, default 0, so "Jaén" can beat "Cajamarca" without guessing). A tie between DIFFERENT flows is
 *     `ambiguous`: nothing starts and the message stays in the Inbox for a person. It never picks one at random or by creation order.
 *
 * At most one flow is ever returned for one message.
 */
export function pickEntryFlow(
  flows: FlowRow[],
  candidates: string[],
  isFirstInbound: boolean,
  legacyMatches: (text: string, cfg: KeywordTriggerConfig) => boolean,
): EntryPick {
  for (const flow of flows) {
    if (isWordFlow(flow)) continue;
    if (flow.trigger_type === "keyword") {
      const cfg = flow.trigger_config as KeywordTriggerConfig;
      if (candidates.some((text) => legacyMatches(text, cfg))) return { kind: "flow", flow };
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return { kind: "flow", flow };
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }

  let best: { rank: [number, number]; flows: FlowRow[] } | null = null;
  for (const flow of flows) {
    if (!isWordFlow(flow)) continue;
    const cfg = flow.trigger_config as KeywordTriggerConfig;
    let words: number | null = null;
    for (const text of candidates) {
      const w = wordMatchSpecificity(text, cfg);
      if (w !== null && (words === null || w > words)) words = w;
    }
    if (words === null) continue;
    const rank: [number, number] = [words, priorityOf(flow)];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { rank, flows: [flow] };
    else if (rank[0] === best.rank[0] && rank[1] === best.rank[1]) best.flows.push(flow);
  }
  if (!best) return { kind: "none" };
  if (best.flows.length > 1) return { kind: "ambiguous", flow_ids: best.flows.map((f) => f.id) };
  return { kind: "flow", flow: best.flows[0] };
}
