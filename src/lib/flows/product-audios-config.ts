/**
 * The configuration contract of the `send_product_audios` ("Audios por producto") node, in ONE place shared by the validator, the
 * runtime, the editor and the canvas edges.
 *
 * Two explicit choices, both backward compatible:
 *   - GATE: `gate_mode` = "required" (the contact must carry `gate_tag_id`) or "none" (no extra tag). A node saved before this field existed
 *     has no `gate_mode` and keeps meaning "required": an old node never loses its tag condition silently.
 *   - PRODUCT: `product_source` = "auto" (read the contact's Producto field and match it, normalised, against the catalog; the original
 *     behaviour, `product_field_id` optionally names the field) or "manual" (a catalog product of the same account chosen with `product_id`,
 *     independent of what the contact stores). A node without `product_source` means "auto".
 * Anything else in either field is invalid, never guessed.
 *   - SELECTION: `audio_selection` absent or "all" sends every active audio of the product (the original behaviour). "single" sends exactly the ONE
 *     audio of the product that carries the node's `purpose_id` + `identifier_id` (migration 076; both are UUIDs of the node's account). Any other
 *     value - or a purpose/identifier on a node that sends "all" - is refused (fail closed): it must never turn into "send everything".
 */

export type GateMode = "required" | "none";
export type ProductSource = "auto" | "manual";
export type AudioSelection = "all" | "single";

export interface ProductAudiosProblem {
  field: string;
  code: string;
  message: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The gate a node asks for; a node without the field is a legacy node and keeps its required tag. */
export function gateModeOf(cfg: object | null | undefined): GateMode | "invalid" {
  const value = (cfg as Record<string, unknown> | null | undefined)?.gate_mode;
  if (value === undefined || value === null) return "required";
  return value === "required" || value === "none" ? value : "invalid";
}

/** Where the product comes from; a node without the field reads the contact's Producto field, as it always did. */
export function productSourceOf(cfg: object | null | undefined): ProductSource | "invalid" {
  const value = (cfg as Record<string, unknown> | null | undefined)?.product_source;
  if (value === undefined || value === null) return "auto";
  return value === "auto" || value === "manual" ? value : "invalid";
}

/** Config keys of the outputs this node needs: "gate closed" exists only when a tag is required. */
export function productAudiosRouteKeys(cfg: object | null | undefined): string[] {
  const keys = ["next_node_key", "unknown_node_key", "no_audios_node_key"];
  if (gateModeOf(cfg) !== "none") keys.push("gate_closed_node_key");
  return keys;
}

/** Why a configuration cannot be used (empty = usable). Does not check that route targets exist in the graph: the validator does. */
export function inspectProductAudiosConfig(input: object | null | undefined): ProductAudiosProblem[] {
  const cfg = input as Record<string, unknown> | null | undefined;
  const problems: ProductAudiosProblem[] = [];
  const add = (field: string, code: string, message: string) => problems.push({ field, code, message });
  if (!cfg || typeof cfg !== "object") return [{ field: "gate_tag_id", code: "product_audios_config_invalid", message: "The node has no configuration." }];

  const gate = gateModeOf(cfg);
  if (gate === "invalid") add("gate_mode", "product_audios_gate_mode_invalid", "Choose whether a tag is required before sending.");
  else if (gate === "required") {
    // A required gate has no default: an unconfigured node must never be able to send.
    if (!UUID.test(text(cfg.gate_tag_id))) add("gate_tag_id", "product_audios_gate_missing", "Choose the tag a contact must have for the audios to be sent. Without it the node cannot be activated.");
  } else if (text(cfg.gate_tag_id) !== "") {
    add("gate_tag_id", "product_audios_gate_conflict", "A tag is chosen but the node is set to send without one. Remove the tag or choose to require it.");
  }

  const source = productSourceOf(cfg);
  const field = text(cfg.product_field_id);
  const product = text(cfg.product_id);
  if (source === "invalid") add("product_source", "product_audios_source_invalid", "Choose where the product comes from.");
  else if (source === "manual") {
    if (!UUID.test(product)) add("product_id", "product_audios_product_missing", "Choose the catalog product this node sends.");
    if (field !== "") add("product_field_id", "product_audios_source_conflict", "A contact field is chosen but the product is picked by hand. Clear the field or read the product from the contact.");
  } else {
    if (field !== "" && !UUID.test(field)) add("product_field_id", "product_audios_field_invalid", "The Producto field must be left empty or be a valid custom field.");
    if (product !== "") add("product_id", "product_audios_source_conflict", "A catalog product is chosen but the product is read from the contact. Clear it or pick the product by hand.");
  }

  // SELECTION. Fail closed: a value this version does not know, or a purpose/identifier that the chosen mode ignores, would silently send more (or
  // less) than the person meant, so it blocks activation and the runtime refuses to send.
  const selection = selectionOf(cfg);
  const purpose = text(cfg.purpose_id), identifier = text(cfg.identifier_id);
  if (selection === "unsupported") {
    add("audio_selection", "product_audios_selection_unsupported", "This step selects audios in a way this version cannot run. It will not send anything until it is changed.");
  } else if (selection === "all") {
    if (purpose !== "" || identifier !== "") add("audio_selection", "product_audios_selection_conflict", "A purpose or identifier is chosen but the step is set to send every audio. Clear them or choose to send one specific audio.");
  } else {
    if (!UUID.test(purpose)) add("purpose_id", "product_audios_purpose_missing", "Choose the purpose of the audio to send.");
    if (!UUID.test(identifier)) add("identifier_id", "product_audios_identifier_missing", "Choose the identifier of the audio to send.");
  }
  return problems;
}

/** Which audios the node asks for: the original "all" (field absent or "all"), exactly "single", or something this version does not understand. */
export function selectionOf(cfg: object | null | undefined): AudioSelection | "unsupported" {
  const value = (cfg as Record<string, unknown> | null | undefined)?.audio_selection;
  if (value === undefined || value === null || value === "all") return "all";
  return value === "single" ? "single" : "unsupported";
}
