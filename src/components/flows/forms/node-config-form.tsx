"use client";

/**
 * Per-node configuration form, dispatched by node_type.
 *
 * One component, ten branches. Each branch renders the inputs that
 * map onto the node's `config` JSONB shape (text + buttons for
 * send_buttons, prompt + var_key for collect_input, etc.) and forwards
 * edits up via `onUpdateConfig`.
 *
 * Why this lives in src/components/flows/forms/ instead of next to
 * the list editor: PR 2 (canvas editing) needs to mount the same
 * form in a side panel when a user clicks a node on the canvas.
 * Keeping the per-node forms here means there's exactly one place
 * where each form's behaviour and validation lives — drift between
 * "what the list editor shows" and "what the canvas side panel
 * shows" becomes impossible.
 *
 * `showAdvanced` is the disclosure that surfaces internal
 * identifiers (node_key, button reply_id, list row reply_id) — owned
 * by the host (NodeCard / SideSheet) so the toggle is rendered
 * outside this form alongside whatever delete/cancel buttons that
 * host wants. The form just reads the boolean and conditionally
 * renders the advanced rows.
 */

import { useEffect, useMemo, useState } from "react";
import { Info, Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { MediaPicker, type MediaPickerValue } from "@/components/shared/media-picker";
import { slugify, type BuilderNode } from "../shared";
import { gateModeOf, productSourceOf, selectionOf } from "@/lib/flows/product-audios-config";
import { useAudioSelectionNames, type SelectionName } from "@/hooks/use-audio-selection-names";
import { useFlowEditor } from "../flow-editor-state";
import { useCustomerReplyConditionCapability, useDurableWaitAuthoringCapability, useSubflowAuthoringCapability } from "../use-subflow-authoring";
import { WAIT_UNITS, isDurableWaitConfig, maxAmountFor, type WaitUnit } from "@/lib/flows/durable-wait";
import { NextNodeRow, NodeKeySelect, TextRow } from "./fields";
import { FlowPicker } from "./flow-picker";

interface NodeConfigFormProps {
  node: BuilderNode;
  allNodes: BuilderNode[];
  showAdvanced: boolean;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

export function NodeConfigForm({
  node,
  allNodes,
  showAdvanced,
  onUpdateConfig,
}: NodeConfigFormProps) {
  const t = useTranslations("Flows.builder.form");
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
      return (
        <NextNodeRow
          value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={t("advancesTo")}
        />
      );

    case "send_message":
      return (
        <>
          <TextRow
            label={t("textToCustomer")}
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
            rows={6}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label={t("advancesTo")}
          />
        </>
      );

    case "send_buttons":
      return (
        <SendButtonsForm
          cfg={cfg as SendButtonsCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
          t={t}
        />
      );

    case "send_list":
      return (
        <SendListForm
          cfg={cfg as SendListCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
          t={t}
        />
      );

    case "send_media":
      return (
        <SendMediaForm
          cfg={cfg as SendMediaCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "send_product_audios":
      return (
        <SendProductAudiosForm
          cfg={cfg as unknown as ProductAudiosCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "collect_input":
      return (
        <>
          <TextRow
            label={t("promptToCustomer")}
            value={(cfg as { prompt_text?: string }).prompt_text ?? ""}
            onChange={(v) => onUpdateConfig({ prompt_text: v })}
            rows={2}
          />
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              {t("varKeyLabel")}
            </label>
            <Input
              value={(cfg as { var_key?: string }).var_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({
                  var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
              placeholder={t("varKeyPlaceholder")}
              className="bg-muted font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              {t("varKeyHelp")}{" "}
              <code className="rounded bg-muted px-1">
                {"{{vars."}
                {(cfg as { var_key?: string }).var_key || "name"}
                {"}}"}
              </code>
              .
            </p>
          </div>
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label={t("advanceAfterCapture")}
          />
        </>
      );

    case "condition":
      return (
        <ConditionForm
          cfg={cfg as ConditionCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "set_tag":
      return (
        <SetTagForm
          cfg={cfg as SetTagCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "delay":
      return (
        <DelayForm
          cfg={cfg as DelayCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "set_contact_field":
      return (
        <SetContactFieldForm
          cfg={cfg as SetContactFieldCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "execute_flow":
      return (
        <ExecuteFlowForm
          cfg={cfg as ExecuteFlowCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          t={t}
        />
      );

    case "handoff":
      return (
        <TextRow
          label={t("internalNote")}
          value={(cfg as { note?: string }).note ?? ""}
          onChange={(v) => onUpdateConfig({ note: v })}
          rows={2}
        />
      );

    case "end":
      return <EndForm scope={(cfg as { scope?: string }).scope} onUpdateConfig={onUpdateConfig} t={t} />;
  }
}

// ============================================================
// send_buttons
// ============================================================

interface SendButtonsCfg {
  text?: string;
  footer_text?: string;
  buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
}

function SendButtonsForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
  t,
}: {
  cfg: SendButtonsCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const buttons = cfg.buttons ?? [];
  const updateButton = (
    idx: number,
    patch: Partial<NonNullable<SendButtonsCfg["buttons"]>[number]>,
  ) => {
    onUpdateConfig({
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addButton = () =>
    onUpdateConfig({
      buttons: [
        ...buttons,
        {
          reply_id: `btn_${buttons.length + 1}`,
          title: "Option",
          next_node_key: "",
        },
      ],
    });
  const removeButton = (idx: number) =>
    onUpdateConfig({ buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <>
      <TextRow
        label={t("bodyText")}
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <TextRow
        label={t("footerText")}
        value={cfg.footer_text ?? ""}
        onChange={(v) => onUpdateConfig({ footer_text: v })}
      />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs text-muted-foreground">
            {t("buttonsHelp")}
          </label>
        </div>
        <div className="flex flex-col gap-3">
          {buttons.map((b, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3",
                showAdvanced
                  ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                  : "md:grid-cols-[2fr_2fr_auto]",
              )}
            >
              {showAdvanced && (
                <Input
                  value={b.reply_id}
                  onChange={(e) =>
                    updateButton(i, {
                      reply_id: slugify(e.target.value, `btn_${i + 1}`),
                    })
                  }
                  placeholder="reply_id"
                  className="bg-muted font-mono text-xs"
                />
              )}
              <Input
                value={b.title}
                onChange={(e) => updateButton(i, { title: e.target.value })}
                placeholder={t("optionTitlePlaceholder")}
                className="bg-muted"
                maxLength={20}
              />
              <NodeKeySelect
                value={b.next_node_key || null}
                nodes={allNodes}
                excludeKey={currentKey}
                onChange={(v) => updateButton(i, { next_node_key: v ?? "" })}
                placeholder={t("nextNodePlaceholder")}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeButton(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {buttons.length < 3 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={addButton}
            className="mt-2"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("addButton")}
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================
// send_list
// ============================================================

interface SendListCfg {
  text?: string;
  button_label?: string;
  footer_text?: string;
  sections?: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

function SendListForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
  t,
}: {
  cfg: SendListCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const sections = cfg.sections ?? [];
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);

  const updateSection = (
    sIdx: number,
    patch: Partial<NonNullable<SendListCfg["sections"]>[number]>,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, ...patch } : s,
      ),
    });
  };
  const addSection = () =>
    onUpdateConfig({
      sections: [
        ...sections,
        {
          title: "",
          rows: [
            {
              reply_id: `row_${totalRows + 1}`,
              title: `Option ${totalRows + 1}`,
              next_node_key: "",
            },
          ],
        },
      ],
    });
  const removeSection = (sIdx: number) =>
    onUpdateConfig({ sections: sections.filter((_, i) => i !== sIdx) });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<
      NonNullable<SendListCfg["sections"]>[number]["rows"][number]
    >,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s,
      ),
    });
  };
  const addRow = (sIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [
                ...s.rows,
                {
                  reply_id: `row_${totalRows + 1}`,
                  title: `Option ${totalRows + 1}`,
                  next_node_key: "",
                },
              ],
            }
          : s,
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s,
      ),
    });

  return (
    <>
      <TextRow
        label="Body text"
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label={t("buttonLabel")}
          value={cfg.button_label ?? ""}
          onChange={(v) => onUpdateConfig({ button_label: v })}
        />
        <TextRow
          label={t("footerText")}
          value={cfg.footer_text ?? ""}
          onChange={(v) => onUpdateConfig({ footer_text: v })}
        />
      </div>

      <div className="mt-2">
        <label className="mb-2 block text-xs text-muted-foreground">
          {t("rowsHelp")}
        </label>
        {sections.map((section, sIdx) => (
          <div
            key={sIdx}
            className="mb-3 rounded-md border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={section.title ?? ""}
                onChange={(e) =>
                  updateSection(sIdx, { title: e.target.value })
                }
                placeholder={t("sectionTitlePlaceholder", { count: sIdx + 1 })}
                className="bg-muted text-xs"
              />
              {sections.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSection(sIdx)}
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label={t("removeSection")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className={cn(
                  "mb-2 grid grid-cols-1 gap-2",
                  showAdvanced
                    ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                    : "md:grid-cols-[2fr_2fr_auto]",
                )}
              >
                {showAdvanced && (
                  <Input
                    value={row.reply_id}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, {
                        reply_id: slugify(
                          e.target.value,
                          `row_${rIdx + 1}`,
                        ),
                      })
                    }
                    placeholder="reply_id"
                    className="bg-muted font-mono text-xs"
                  />
                )}
                <Input
                  value={row.title}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { title: e.target.value })
                  }
                  placeholder={t("rowTitlePlaceholder")}
                  className="bg-muted"
                  maxLength={24}
                />
                <NodeKeySelect
                  value={row.next_node_key || null}
                  nodes={allNodes}
                  excludeKey={currentKey}
                  onChange={(v) =>
                    updateRow(sIdx, rIdx, { next_node_key: v ?? "" })
                  }
                  placeholder={t("nextNodePlaceholder")}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(sIdx, rIdx)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {totalRows < 10 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addRow(sIdx)}
                className="mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("addRow")}
              </Button>
            )}
          </div>
        ))}
        {/* WhatsApp's interactive-list spec caps sections at 10. Group rows
            by category (Billing / Support / Sales etc.) to give customers a
            scannable menu. */}
        {sections.length < 10 && (
          <Button variant="outline" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            {t("addSection")}
          </Button>
        )}
      </div>
    </>
  );
}

// ============================================================
// condition
// ============================================================

const VALUE_OPERATORS = ["equals", "not_equals", "contains", "not_contains", "starts_with"];

interface ConditionCfg {
  subject?: "var" | "tag" | "contact_field" | "customer_activity";
  subject_key?: string;
  operator?: "equals" | "not_equals" | "contains" | "not_contains" | "starts_with" | "present" | "absent" | "replied_after_reference";
  value?: string;
  case_sensitive?: boolean;
  true_next?: string;
  false_next?: string;
}

interface UserTag {
  id: string;
  name: string;
  color?: string;
}

type CatalogState = "loading" | "ready" | "empty" | "error";
interface TagCatalog { tags: UserTag[]; state: CatalogState }

/** RLS-scoped catalog: never use the administrative client in the browser. */
export function useAccountTags(): TagCatalog {
  const [catalog, setCatalog] = useState<TagCatalog>({ tags: [], state: "loading" });
  const { accountId } = useAuth();
  useEffect(() => {
    let cancelled = false;
    setCatalog({ tags: [], state: "loading" });
    (async () => {
      try {
        const { data, error } = await createClient().from("tags").select("id, name, color").order("name");
        if (error) throw error;
        const tags = (data as UserTag[] | null) ?? [];
        if (!cancelled) setCatalog({ tags, state: tags.length ? "ready" : "empty" });
      } catch {
        if (!cancelled) setCatalog({ tags: [], state: "error" });
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);
  return catalog;
}

function TagSelect({ value, catalog, onChange, t }: { value: string; catalog: TagCatalog; onChange: (value: string) => void; t: ReturnType<typeof useTranslations> }) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => catalog.tags.filter((tag) => tag.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [catalog.tags, query]);
  const selectedMissing = Boolean(value) && !catalog.tags.some((tag) => tag.id === value);
  if (catalog.state === "loading") return <p className="text-xs text-muted-foreground">{t("loadingTags")}</p>;
  if (catalog.state === "error") return <p className="text-xs text-destructive">{t("tagsLoadError")}</p>;
  if (catalog.state === "empty") return <p className="text-xs text-muted-foreground">{t("noTags")}</p>;
  return <div className="space-y-1">
    {selectedMissing && <p className="text-xs text-amber-600 dark:text-amber-400">{t("tagUnavailable")}</p>}
    <Select value={selectedMissing ? "" : value} onValueChange={(next) => { if (next !== null) onChange(next); }}>
      <SelectTrigger className="bg-muted"><SelectValue placeholder={t("pickTag")} /></SelectTrigger>
      <SelectContent>
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("searchTags")} className="m-1 w-[calc(100%-0.5rem)]" aria-label={t("searchTags")} />
        {visible.length ? visible.map((tag) => <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>) : <p className="px-2 py-1 text-xs text-muted-foreground">{t("noTags")}</p>}
      </SelectContent>
    </Select>
  </div>;
}

function ConditionForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: ConditionCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tagCatalog = useAccountTags();
  const fields = useAccountCustomFields();
  const customConditionsEnabled = useCustomConditionCapability();
  const customerReplyEnabled = useCustomerReplyConditionCapability();

  const subject = cfg.subject ?? "var";
  const isActivity = subject === "customer_activity";
  const referenceCandidates = allNodes.filter((n) => n.node_type === "send_message" || n.node_type === "send_media");
  const operator = cfg.operator ?? "equals";
  const showValue = VALUE_OPERATORS.includes(operator);

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("ifLabel")}</label>
          <Select
            value={subject}
            onValueChange={(v) =>
              onUpdateConfig(
                v === "customer_activity"
                  ? { subject: v, operator: "replied_after_reference", subject_key: "", value: undefined }
                  : subject === "customer_activity"
                    ? { subject: v as ConditionCfg["subject"], operator: "present", subject_key: "" }
                    : { subject: v as ConditionCfg["subject"] },
              )
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="var">{t("capturedVariable")}</SelectItem>
              <SelectItem value="tag">{t("contactHasTag")}</SelectItem>
              <SelectItem value="contact_field">{t("contactField")}</SelectItem>
              {(customerReplyEnabled || isActivity) && <SelectItem value="customer_activity">{t("customerActivity")}</SelectItem>}
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs text-muted-foreground">
            {subject === "var"
              ? t("varName")
              : subject === "tag"
                ? t("tagLabel")
                : isActivity
                  ? t("referenceMessageLabel")
                  : t("fieldLabel")}
          </label>
          {isActivity ? (
            <div className="space-y-1">
              {!customerReplyEnabled && <p className="text-xs text-amber-600 dark:text-amber-400">{t("customerReplyDisabled")}</p>}
              <Select value={cfg.subject_key === "$inherited" ? "inherited" : "own"} onValueChange={(v) => { if (v) onUpdateConfig({ subject_key: v === "inherited" ? "$inherited" : "", operator: "replied_after_reference" }); }}>
                <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="own">{t("referenceSourceOwn")}</SelectItem>
                  <SelectItem value="inherited">{t("referenceSourceInherited")}</SelectItem>
                </SelectContent>
              </Select>
              {cfg.subject_key === "$inherited" ? (
                <p className="text-xs text-muted-foreground">{t("referenceInheritedHelp")}</p>
              ) : referenceCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("noReferenceCandidates")}</p>
              ) : (
                <NodeKeySelect
                  value={cfg.subject_key || null}
                  nodes={referenceCandidates}
                  excludeKey={currentKey}
                  onChange={(v) => onUpdateConfig({ subject_key: v ?? "", operator: "replied_after_reference" })}
                  placeholder={t("pickReference")}
                />
              )}
              <p className="text-xs text-muted-foreground">{t("referenceHelp")}</p>
            </div>
          ) : subject === "tag" ? (
            <TagSelect value={cfg.subject_key ?? ""} catalog={tagCatalog} onChange={(v) => onUpdateConfig({ subject_key: v })} t={t} />
          ) : subject === "contact_field" ? (
            <>
            <Select
              value={cfg.subject_key ?? ""}
              onValueChange={(v) => onUpdateConfig({ subject_key: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder={t("pickField")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">name</SelectItem>
                <SelectItem value="email">email</SelectItem>
                <SelectItem value="phone">phone</SelectItem>
                <SelectItem value="company">company</SelectItem>
                {customConditionsEnabled && fields.map((field) => <SelectItem key={field.id} value={`custom:${field.id}`}>{field.field_name}</SelectItem>)}
              </SelectContent>
            </Select>
            {typeof cfg.subject_key === "string" && cfg.subject_key.startsWith("custom:") && !fields.some((field) => `custom:${field.id}` === cfg.subject_key) && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("customFieldUnavailable")}</p>}
            {!customConditionsEnabled && <p className="mt-1 text-xs text-muted-foreground">{t("customConditionCapabilityDisabled")}</p>}
            </>
          ) : (
            <Input
              value={cfg.subject_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({ subject_key: e.target.value })
              }
              placeholder={subject === "var" ? t("varKeyPlaceholder") : t("tagUuidPlaceholder")}
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>

      {!isActivity && <div
        className={cn(
          "grid grid-cols-1 gap-3",
          showValue ? "md:grid-cols-2" : "",
        )}
      >
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("operatorLabel")}</label>
          <Select
            value={operator}
            onValueChange={(v) =>
              onUpdateConfig({ operator: v as ConditionCfg["operator"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="present">{t("isPresent")}</SelectItem>
              <SelectItem value="absent">{t("isAbsent")}</SelectItem>
              <SelectItem value="equals">{t("equals")}</SelectItem>
              <SelectItem value="not_equals">{t("notEquals")}</SelectItem>
              <SelectItem value="contains">{t("contains")}</SelectItem>
              <SelectItem value="not_contains">{t("notContains")}</SelectItem>
              <SelectItem value="starts_with">{t("startsWith")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {showValue && (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("valueLabel")}</label>
            <Input
              value={cfg.value ?? ""}
              onChange={(e) => onUpdateConfig({ value: e.target.value })}
              className="bg-muted"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={cfg.case_sensitive !== false}
                onChange={(e) => onUpdateConfig({ case_sensitive: e.target.checked })}
              />
              {t("caseSensitive")}
            </label>
            {(operator === "not_equals" || operator === "not_contains") && (
              <p className="mt-1 text-xs text-muted-foreground">{t("unknownNotMatched")}</p>
            )}
          </div>
        )}
      </div>}
      {isActivity && <p className="text-sm">{t("repliedAfterReference")}</p>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.true_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ true_next: v })}
          label={isActivity ? t("ifRepliedAdvance") : t("ifTrueAdvance")}
        />
        <NextNodeRow
          value={cfg.false_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ false_next: v })}
          label={isActivity ? t("ifNotRepliedAdvance") : t("ifFalseAdvance")}
        />
      </div>
    </>
  );
}

// ============================================================
// set_tag
// ============================================================

interface SetTagCfg {
  mode?: "add" | "remove";
  tag_id?: string;
  next_node_key?: string;
}

function SetTagForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SetTagCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tagCatalog = useAccountTags();

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("actionLabel")}</label>
          <Select
            value={cfg.mode ?? "add"}
            onValueChange={(v) =>
              onUpdateConfig({ mode: v as SetTagCfg["mode"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">{t("addTag")}</SelectItem>
              <SelectItem value="remove">{t("removeTag")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("tagLabel")}</label>
          <TagSelect value={cfg.tag_id ?? ""} catalog={tagCatalog} onChange={(v) => onUpdateConfig({ tag_id: v })} t={t} />
        </div>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

/** Whether the server enabled voice notes for this account (GET /api/flows/voice-notes). Fail-closed. */
function useVoiceNoteCapability(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/flows/voice-notes");
        if (!response.ok) return;
        const data = (await response.json()) as { enabled?: boolean };
        if (!cancelled) setEnabled(data.enabled === true);
      } catch {
        // Remain fail-closed; every write path checks again on the server.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

function useCustomConditionCapability(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/flows/capabilities");
        if (!response.ok) return;
        const data = (await response.json()) as { customConditions?: boolean };
        if (!cancelled) setEnabled(data.customConditions === true);
      } catch {
        // Remain fail-closed; the server enforces this independently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

// ============================================================
// send_product_audios ("Audios por producto")
// ============================================================

interface ProductAudiosCfg {
  audio_selection?: string;
  purpose_id?: string;
  identifier_id?: string;
  gate_mode?: string;
  gate_tag_id?: string;
  product_source?: string;
  product_id?: string;
  product_field_id?: string;
  next_node_key?: string;
  unknown_node_key?: string;
  no_audios_node_key?: string;
  gate_closed_node_key?: string;
}

const AUTO_FIELD = "__auto__";

interface CatalogProductOption { id: string; display_name: string; product_key: string; active: boolean }
type CatalogProducts = { state: "loading" | "ready" | "empty" | "error" | "disabled"; products: CatalogProductOption[] };

/** The account's catalog products, from the same API the Audios por producto screen uses (account from the session, module-gated). */
function useCatalogProducts(): CatalogProducts {
  const { accountId } = useAuth();
  // The answer is remembered WITH the account it was fetched for, so a different account never sees it and "loading" needs no reset.
  const [answer, setAnswer] = useState<{ accountId: string | null; value: CatalogProducts } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const done = (value: CatalogProducts) => { if (!cancelled) setAnswer({ accountId, value }); };
    (async () => {
      try {
        const response = await fetch("/api/audio-guide/products");
        const body = (await response.json().catch(() => ({}))) as { products?: CatalogProductOption[]; error?: string };
        if (response.status === 403 && body.error === "voice_notes_disabled") return done({ state: "disabled", products: [] });
        if (!response.ok) return done({ state: "error", products: [] });
        const products = body.products ?? [];
        done({ state: products.length ? "ready" : "empty", products });
      } catch {
        done({ state: "error", products: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [accountId]);
  return answer && answer.accountId === accountId ? answer.value : { state: "loading", products: [] };
}

/** A small information icon (native tooltip, also read by screen readers). The same text is usually shown below the field as well. */
function HelpHint({ text, t }: { text: string; t: ReturnType<typeof useTranslations> }) {
  return (
    <span className="ml-1 inline-flex cursor-help align-middle text-muted-foreground" title={text} aria-label={`${t("productAudiosInfo")}: ${text}`} role="img">
      <Info className="h-3 w-3" />
    </span>
  );
}

function ChoiceRow({ value, current, label, help, example, onSelect, testId, t }: {
  value: string; current: string; label: string; help?: string; example: string; onSelect: (value: string) => void; testId: string; t: ReturnType<typeof useTranslations>;
}) {
  const selected = current === value;
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs", selected ? "border-primary bg-muted" : "border-border")} data-testid={testId}>
      <input type="radio" className="mt-0.5" checked={selected} onChange={() => onSelect(value)} aria-label={label} />
      <span className="space-y-0.5">
        <span className="block font-medium text-foreground">{label}{help && <HelpHint text={help} t={t} />}</span>
        {help && <span className="block text-muted-foreground">{help}</span>}
        <span className="block text-[11px] text-muted-foreground">{example}</span>
      </span>
    </label>
  );
}

function RouteField({ label, example, value, allNodes, currentKey, onChange, t }: {
  label: string; example: string; value: string; allNodes: BuilderNode[]; currentKey: string; onChange: (value: string) => void; t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div>
      <NextNodeRow value={value} allNodes={allNodes} currentKey={currentKey} onChange={onChange} label={label} />
      <p className="mt-1 text-[11px] text-muted-foreground"><HelpHint text={example} t={t} />{example}</p>
    </div>
  );
}

/** One purpose / identifier picker: shows the VISIBLE name, stores the UUID, and says plainly when the saved value is gone or inactive. */
function SelectionNameField({ label, placeholder, value, options, ready, missingText, unavailableText, onChange, testId, t }: {
  label: string; placeholder: string; value: string; options: SelectionName[]; ready: boolean; missingText: string; unavailableText: string;
  onChange: (id: string) => void; testId: string; t: ReturnType<typeof useTranslations>;
}) {
  const chosen = value ? options.find((o) => o.id === value) : undefined;
  const gone = Boolean(value) && ready && !chosen;
  return (
    <div data-testid={testId}>
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      {ready && (
        <Select value={gone ? "" : value} onValueChange={(v) => { if (v !== null) onChange(v); }}>
          <SelectTrigger className="bg-muted" aria-label={label}><SelectValue placeholder={placeholder} /></SelectTrigger>
          <SelectContent>
            {options.filter((o) => o.active || o.id === value).map((o) => <SelectItem key={o.id} value={o.id}>{o.name}{o.active ? "" : ` ${t("productAudiosNameInactive")}`}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      {chosen && <p className="mt-1 text-xs text-foreground" data-testid={`${testId}-name`}>{chosen.name}{chosen.active ? "" : ` ${t("productAudiosNameInactive")}`}</p>}
      {chosen && !chosen.active && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid={`${testId}-inactive`}>{t("productAudiosNameInactiveWarning")}</p>}
      {gone && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid={`${testId}-gone`}>{unavailableText}</p>}
      {!value && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid={`${testId}-missing`}>{missingText}</p>}
    </div>
  );
}

type AudioMatch = "checking" | "found" | "missing" | "disabled" | "unknown";
/** For a product chosen by hand: does one of its audios carry this purpose and identifier? (Read-only; the server decides again when sending.) */
function useAudioMatch(productId: string, purposeId: string, identifierId: string): AudioMatch {
  const { accountId } = useAuth();
  const wanted = productId && purposeId && identifierId ? `${accountId}|${productId}|${purposeId}|${identifierId}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: AudioMatch } | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    (async () => {
      let value: AudioMatch = "unknown";
      try {
        const response = await fetch(`/api/audio-guide/products/${productId}`);
        const body = (await response.json().catch(() => ({}))) as { product?: { items?: Array<{ purpose_id?: string | null; identifier_id?: string | null; status?: string }> } };
        const items = body.product?.items;
        if (response.ok && Array.isArray(items)) {
          const hit = items.find((i) => i.purpose_id?.toLowerCase() === purposeId.toLowerCase() && i.identifier_id?.toLowerCase() === identifierId.toLowerCase());
          value = !hit ? "missing" : hit.status === "disabled" ? "disabled" : "found";
        }
      } catch { /* leave "unknown": the server decides when sending */ }
      if (!cancelled) setAnswer({ key: wanted, value });
    })();
    return () => { cancelled = true; };
  }, [wanted, productId, purposeId, identifierId]);
  if (!wanted) return "unknown";
  return answer && answer.key === wanted ? answer.value : "checking";
}

function SendProductAudiosForm({ cfg, allNodes, currentKey, onUpdateConfig, t }: {
  cfg: ProductAudiosCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const tagCatalog = useAccountTags();
  const fields = useAccountCustomFields();
  const catalog = useCatalogProducts();
  // What the runtime does with this config (product-audios-config.ts): a node saved before these choices existed still requires its tag
  // and reads the contact's Producto. Nothing is written until the person changes a choice.
  const gate = gateModeOf(cfg) === "none" ? "none" : "required";
  const source = productSourceOf(cfg) === "manual" ? "manual" : "auto";
  const tagName = cfg.gate_tag_id ? tagCatalog.tags.find((tag) => tag.id === cfg.gate_tag_id)?.name : undefined;
  const chosenProduct = cfg.product_id ? catalog.products.find((product) => product.id === cfg.product_id) : undefined;
  const productMissing = Boolean(cfg.product_id) && catalog.state === "ready" && !chosenProduct;
  // Which audios: a node without `audio_selection` sends all of them, exactly as it always did. A value this version does not know is shown as
  // neither choice (never as "all"), and the validator blocks activation until the person picks one.
  const selectionKind = selectionOf(cfg);
  const selection = selectionKind === "unsupported" ? "unsupported" : selectionKind;
  const names = useAudioSelectionNames(selection === "single");
  const namesReady = names.state === "ready";
  const match = useAudioMatch(source === "manual" && selection === "single" ? (cfg.product_id ?? "") : "", cfg.purpose_id ?? "", cfg.identifier_id ?? "");
  return (
    <>
      <p className="text-xs text-muted-foreground">{t("productAudiosHelp")}</p>

      <fieldset className="space-y-1.5" data-testid="gate-choice">
        <legend className="mb-1 text-xs text-muted-foreground">{t("productAudiosGateTitle")}<HelpHint text={t("productAudiosGateTitleHelp")} t={t} /></legend>
        <ChoiceRow t={t} testId="gate-none" value="none" current={gate} label={t("productAudiosGateNone")} example={t("productAudiosGateNoneExample")}
          onSelect={() => onUpdateConfig({ gate_mode: "none", gate_tag_id: "", gate_closed_node_key: "" })} />
        <ChoiceRow t={t} testId="gate-required" value="required" current={gate} label={t("productAudiosGateRequired")} example={t("productAudiosGateRequiredExample")}
          onSelect={() => onUpdateConfig({ gate_mode: "required" })} />
        {gate === "required" && (
          <div className="pl-6">
            <TagSelect value={cfg.gate_tag_id ?? ""} catalog={tagCatalog} onChange={(v) => onUpdateConfig({ gate_tag_id: v })} t={t} />
            {tagName && <p className="mt-1 text-xs text-foreground" data-testid="gate-tag-name">{tagName}</p>}
            {!cfg.gate_tag_id && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("productAudiosGateMissing")}</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-1.5" data-testid="source-choice">
        <legend className="mb-1 text-xs text-muted-foreground">{t("productAudiosSourceTitle")}<HelpHint text={t("productAudiosSourceTitleHelp")} t={t} /></legend>
        <ChoiceRow t={t} testId="source-auto" value="auto" current={source} label={t("productAudiosSourceAuto")} help={t("productAudiosSourceAutoHelp")} example={t("productAudiosSourceAutoExample")}
          onSelect={() => onUpdateConfig({ product_source: "auto", product_id: "" })} />
        {source === "auto" && (
          <div className="pl-6">
            <label className="mb-1 block text-xs text-muted-foreground">{t("productAudiosFieldLabel")}</label>
            <Select value={cfg.product_field_id ? cfg.product_field_id : AUTO_FIELD} onValueChange={(v) => { if (v !== null) onUpdateConfig({ product_field_id: v === AUTO_FIELD ? "" : v }); }}>
              <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={AUTO_FIELD}>{t("productAudiosFieldAuto")}</SelectItem>
                {fields.map((field) => <SelectItem key={field.id} value={field.id}>{field.field_name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-foreground" data-testid="field-name">{cfg.product_field_id ? (fields.find((field) => field.id === cfg.product_field_id)?.field_name ?? "") : t("productAudiosFieldAuto")}</p>
          </div>
        )}
        <ChoiceRow t={t} testId="source-manual" value="manual" current={source} label={t("productAudiosSourceManual")} help={t("productAudiosSourceManualHelp")} example={t("productAudiosSourceManualExample")}
          onSelect={() => onUpdateConfig({ product_source: "manual", product_field_id: "" })} />
        {source === "manual" && (
          <div className="pl-6" data-testid="manual-product">
            <label className="mb-1 block text-xs text-muted-foreground">{t("productAudiosProductLabel")}</label>
            {catalog.state === "loading" && <p className="text-xs text-muted-foreground">{t("productAudiosProductsLoading")}</p>}
            {catalog.state === "error" && <p className="text-xs text-destructive">{t("productAudiosProductsError")}</p>}
            {catalog.state === "disabled" && <p className="text-xs text-amber-600 dark:text-amber-400">{t("productAudiosProductsDisabled")}</p>}
            {catalog.state === "empty" && <p className="text-xs text-muted-foreground">{t("productAudiosProductsEmpty")}</p>}
            {catalog.state === "ready" && (
              <Select value={productMissing ? "" : (cfg.product_id ?? "")} onValueChange={(v) => { if (v !== null) onUpdateConfig({ product_id: v }); }}>
                <SelectTrigger className="bg-muted"><SelectValue placeholder={t("productAudiosProductPlaceholder")} /></SelectTrigger>
                <SelectContent>
                  {catalog.products.map((product) => <SelectItem key={product.id} value={product.id}>{product.display_name}{product.active ? "" : ` ${t("productAudiosProductInactive")}`}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {chosenProduct && <p className="mt-1 text-xs text-foreground" data-testid="product-name">{chosenProduct.display_name}{chosenProduct.active ? "" : ` ${t("productAudiosProductInactive")}`}</p>}
            {productMissing && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("productAudiosProductUnavailable")}</p>}
            {!cfg.product_id && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{t("productAudiosProductMissing")}</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-1.5" data-testid="selection-choice">
        <legend className="mb-1 text-xs text-muted-foreground">{t("productAudiosSelectionTitle")}<HelpHint text={t("productAudiosSelectionTitleHelp")} t={t} /></legend>
        <ChoiceRow t={t} testId="selection-all" value="all" current={selection} label={t("productAudiosSelectionAll")} example={t("productAudiosSelectionAllExample")}
          onSelect={() => onUpdateConfig({ audio_selection: "all", purpose_id: "", identifier_id: "" })} />
        <ChoiceRow t={t} testId="selection-single" value="single" current={selection} label={t("productAudiosSelectionSingle")} help={t("productAudiosSelectionSingleHelp")} example={t("productAudiosSelectionSingleExample")}
          onSelect={() => onUpdateConfig({ audio_selection: "single" })} />
        {selection === "single" && (
          <div className="space-y-2 pl-6" data-testid="single-audio">
            {names.state === "loading" && <p className="text-xs text-muted-foreground">{t("productAudiosNamesLoading")}</p>}
            {names.state === "error" && <p className="text-xs text-destructive" role="alert">{t("productAudiosNamesError")}</p>}
            {names.state === "disabled" && <p className="text-xs text-amber-600 dark:text-amber-400">{t("productAudiosNamesDisabled")}</p>}
            {namesReady && names.purposes.length === 0 && names.identifiers.length === 0 && <p className="text-xs text-muted-foreground" data-testid="names-empty">{t("productAudiosNamesEmpty")}</p>}
            {(namesReady || !cfg.purpose_id) && (
              <SelectionNameField t={t} testId="purpose-field" label={t("productAudiosPurposeLabel")} placeholder={t("productAudiosPurposePlaceholder")} value={cfg.purpose_id ?? ""} options={names.purposes} ready={namesReady}
                missingText={t("productAudiosPurposeMissing")} unavailableText={t("productAudiosPurposeUnavailable")} onChange={(v) => onUpdateConfig({ purpose_id: v })} />
            )}
            {(namesReady || !cfg.identifier_id) && (
              <SelectionNameField t={t} testId="identifier-field" label={t("productAudiosIdentifierLabel")} placeholder={t("productAudiosIdentifierPlaceholder")} value={cfg.identifier_id ?? ""} options={names.identifiers} ready={namesReady}
                missingText={t("productAudiosIdentifierMissing")} unavailableText={t("productAudiosIdentifierUnavailable")} onChange={(v) => onUpdateConfig({ identifier_id: v })} />
            )}
            {cfg.purpose_id && cfg.identifier_id && (
              source === "manual" ? (
                <p className={cn("text-xs", match === "found" ? "text-emerald-600 dark:text-emerald-400" : match === "checking" || match === "unknown" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")} data-testid="audio-match" data-match={match}>
                  {match === "found" ? t("productAudiosMatchFound") : match === "missing" ? t("productAudiosMatchMissing") : match === "disabled" ? t("productAudiosMatchDisabled") : match === "checking" ? t("productAudiosMatchChecking") : ""}
                </p>
              ) : <p className="text-xs text-muted-foreground" data-testid="audio-match" data-match="auto">{t("productAudiosMatchAuto")}</p>
            )}
          </div>
        )}
      </fieldset>

      <RouteField label={t("productAudiosRouteNext")} example={t("productAudiosRouteNextExample")} value={cfg.next_node_key ?? ""} allNodes={allNodes} currentKey={currentKey} onChange={(v) => onUpdateConfig({ next_node_key: v })} t={t} />
      <RouteField label={t("productAudiosRouteUnknown")} example={t("productAudiosRouteUnknownExample")} value={cfg.unknown_node_key ?? ""} allNodes={allNodes} currentKey={currentKey} onChange={(v) => onUpdateConfig({ unknown_node_key: v })} t={t} />
      <RouteField label={t("productAudiosRouteNoAudios")} example={t("productAudiosRouteNoAudiosExample")} value={cfg.no_audios_node_key ?? ""} allNodes={allNodes} currentKey={currentKey} onChange={(v) => onUpdateConfig({ no_audios_node_key: v })} t={t} />
      {gate === "required" && (
        <RouteField label={t("productAudiosRouteGateClosed")} example={t("productAudiosRouteGateClosedExample")} value={cfg.gate_closed_node_key ?? ""} allNodes={allNodes} currentKey={currentKey} onChange={(v) => onUpdateConfig({ gate_closed_node_key: v })} t={t} />
      )}
    </>
  );
}

// ============================================================
// delay
// ============================================================

interface DelayCfg {
  seconds?: number;
  next_node_key?: string;
  /** Durable wait (migration 069): present only when the node is a durable wait. */
  amount?: number;
  unit?: WaitUnit;
}

const DELAY_MIN_SECONDS = 1;
const DELAY_MAX_SECONDS = 30;

function DelayForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: DelayCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const durableEnabled = useDurableWaitAuthoringCapability();
  const durable = isDurableWaitConfig(cfg);
  const unitLabel = (unit: WaitUnit) => t(`delayUnit_${unit}`);
  // Accounts without the pilot (and flows that never used it) keep exactly the original short-delay form.
  if (durableEnabled || durable) {
    const unit: WaitUnit = (WAIT_UNITS as readonly string[]).includes(cfg.unit ?? "") ? (cfg.unit as WaitUnit) : "minutes";
    const amount = typeof cfg.amount === "number" ? cfg.amount : 13;
    return (
      <>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("delayKind")}</label>
          <Select
            value={durable ? "durable" : "short"}
            disabled={!durableEnabled}
            onValueChange={(v) => v === "durable"
              ? onUpdateConfig({ amount: 13, unit: "minutes", seconds: undefined })
              : onUpdateConfig({ seconds: 5, amount: undefined, unit: undefined })}
          >
            <SelectTrigger className="bg-muted" aria-label={t("delayKind")}>
              <span>{durable ? t("delayKindDurable") : t("delayKindShort")}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="short">{t("delayKindShort")}</SelectItem>
              <SelectItem value="durable">{t("delayKindDurable")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {durable ? (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("delayAmountLabel")}</label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={maxAmountFor(unit)}
                value={amount}
                disabled={!durableEnabled}
                aria-label={t("delayAmountLabel")}
                onChange={(e) => {
                  const raw = Math.round(Number(e.target.value));
                  onUpdateConfig({ amount: Number.isFinite(raw) ? Math.min(maxAmountFor(unit), Math.max(1, raw)) : 1 });
                }}
                className="bg-muted"
              />
              <Select
                value={unit}
                disabled={!durableEnabled}
                onValueChange={(v) => { const next = v as WaitUnit; onUpdateConfig({ unit: next, amount: Math.min(amount, maxAmountFor(next)) }); }}
              >
                <SelectTrigger className="bg-muted" aria-label={t("delayUnitLabel")}>
                  <span>{unitLabel(unit)}</span>
                </SelectTrigger>
                <SelectContent>
                  {WAIT_UNITS.map((u) => <SelectItem key={u} value={u}>{unitLabel(u)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <p className="mt-1 text-[10px] text-muted-foreground">{durableEnabled ? t("delayDurableHelp") : t("delayDurableDisabled")}</p>
          </div>
        ) : (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">{t("delaySecondsLabel")}</label>
            <Input
              type="number"
              min={DELAY_MIN_SECONDS}
              max={DELAY_MAX_SECONDS}
              value={cfg.seconds ?? 5}
              onChange={(e) => {
                const raw = Math.round(Number(e.target.value));
                onUpdateConfig({ seconds: Number.isFinite(raw) ? Math.min(DELAY_MAX_SECONDS, Math.max(DELAY_MIN_SECONDS, raw)) : DELAY_MIN_SECONDS });
              }}
              className="bg-muted"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">{t("delayHelp", { min: DELAY_MIN_SECONDS, max: DELAY_MAX_SECONDS })}</p>
          </div>
        )}
        <NextNodeRow
          value={cfg.next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label={t("advancesTo")}
        />
      </>
    );
  }
  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          {t("delaySecondsLabel")}
        </label>
        <Input
          type="number"
          min={DELAY_MIN_SECONDS}
          max={DELAY_MAX_SECONDS}
          value={cfg.seconds ?? 5}
          onChange={(e) => {
            const raw = Math.round(Number(e.target.value));
            const clamped = Number.isFinite(raw)
              ? Math.min(DELAY_MAX_SECONDS, Math.max(DELAY_MIN_SECONDS, raw))
              : DELAY_MIN_SECONDS;
            onUpdateConfig({ seconds: clamped });
          }}
          className="bg-muted"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t("delayHelp", { min: DELAY_MIN_SECONDS, max: DELAY_MAX_SECONDS })}
        </p>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advancesTo")}
      />
    </>
  );
}

// ============================================================
// set_contact_field
// ============================================================

interface SetContactFieldCfg {
  field?: string;
  value?: string;
  next_node_key?: string;
}

interface AccountCustomField {
  id: string;
  field_name: string;
}

/**
 * Loads the account's custom fields via a direct RLS-scoped Supabase
 * query — the SAME working pattern `automation-builder.tsx` uses for
 * its own custom-field picker (`supabase.from("custom_fields")...`).
 * Deliberately NOT `useUserTags`'s `fetch("/api/tags")` pattern above:
 * that endpoint doesn't exist in this repo, so `useUserTags` silently
 * falls back to a raw-UUID input in practice. Falls back the same way
 * here if the query returns nothing, so the node is still authorable.
 */
function useAccountCustomFields(): AccountCustomField[] {
  const [fields, setFields] = useState<AccountCustomField[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("custom_fields")
          .select("id, field_name")
          .order("field_name");
        if (!cancelled) setFields((data as AccountCustomField[] | null) ?? []);
      } catch {
        // RLS / network hiccup — caller falls back to raw input.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return fields;
}

function SetContactFieldForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SetContactFieldCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const fields = useAccountCustomFields();
  const currentValue = cfg.field?.startsWith("custom:") ? cfg.field : "";

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          {t("customFieldLabel")}
        </label>
        {fields.length > 0 ? (
          <Select
            value={currentValue}
            onValueChange={(v) => onUpdateConfig({ field: v })}
          >
            <SelectTrigger className="bg-muted">
              <SelectValue placeholder={t("customFieldPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {fields.map((f) => (
                <SelectItem key={f.id} value={`custom:${f.id}`}>
                  {f.field_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={cfg.field ?? ""}
            onChange={(e) => onUpdateConfig({ field: e.target.value })}
            placeholder="custom:<uuid>"
            className="bg-muted font-mono text-xs"
          />
        )}
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          {t("customFieldValueLabel")}
        </label>
        <Input
          value={cfg.value ?? ""}
          onChange={(e) => onUpdateConfig({ value: e.target.value })}
          placeholder={t("customFieldValuePlaceholder")}
          className="bg-muted"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          {t("customFieldValueHelp")}{" "}
          <code className="rounded bg-muted px-1">{"{{vars.contact_name}}"}</code>.
        </p>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("thenAdvanceTo")}
      />
    </>
  );
}

// ============================================================
// send_media
// ============================================================

interface SendMediaCfg extends MediaPickerValue {
  next_node_key?: string;
}

function SendMediaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: SendMediaCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const voiceNotesEnabled = useVoiceNoteCapability();
  return (
    <>
      <MediaPicker
        kinds={voiceNotesEnabled || cfg.media_type === "audio" ? ["image", "video", "document", "audio"] : ["image", "video", "document"]}
        value={cfg}
        onChange={onUpdateConfig}
        labels={{
          mediaTypeLabel: t("mediaTypeLabel"),
          imageLabel: t("imageLabel"),
          videoLabel: t("videoLabel"),
          documentLabel: t("documentLabel"),
          fileLabel: t("fileLabel"),
          removeFile: t("removeFile"),
          uploading: t("uploading"),
          clickToUpload: t("clickToUpload"),
          uploadSuccess: t("uploadSuccess"),
          fileTooLarge: t("fileTooLarge"),
          uploadFailed: t("uploadFailed"),
          captionLabel: t("captionLabel"),
          filenameLabel: t("filenameLabel"),
          filenamePlaceholder: t("filenamePlaceholder"),
          manychatBridgeFlowNsLabel: t("manychatBridgeFlowNsLabel"),
          manychatBridgeFlowNsHelp: t("manychatBridgeFlowNsHelp"),
          audioLabel: t("audioLabel"),
          voiceNoteHelp: t("voiceNoteHelp"),
          voiceNoteVerifying: t("voiceNoteVerifying"),
          voiceNoteNeedsOgg: t("voiceNoteNeedsOgg"),
          voiceNoteNotOgg: t("voiceNoteNotOgg"),
          voiceNoteNotMono: t("voiceNoteNotMono"),
          voiceNoteCorrupt: t("voiceNoteCorrupt"),
          voiceNoteRepaired: t("voiceNoteRepaired"),
          voiceNoteRejectedByServer: t("voiceNoteRejectedByServer"),
        }}
      />

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("advanceAfterSending")}
      />
    </>
  );
}

// ============================================================
// execute_flow (pilot: authoring only, nothing runs)
// ============================================================

interface ExecuteFlowCfg {
  target_flow_id?: string;
  next_node_key?: string;
  reference_node_key?: string;
  on_customer_reply?: "stop" | "continue";
}

interface AccountFlowOption {
  id: string;
  name: string;
  status: string;
}

/** The account's own flows, through the RLS-scoped client: another account's flows are never returned. */
function useAccountFlows(): { flows: AccountFlowOption[]; loaded: boolean } {
  const [state, setState] = useState<{ flows: AccountFlowOption[]; loaded: boolean }>({ flows: [], loaded: false });
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const supabase = createClient();
        const { data } = await supabase.from("flows").select("id, name, status").order("name").limit(1000);
        if (!cancelled) setState({ flows: (data as AccountFlowOption[] | null) ?? [], loaded: data !== null });
      } catch {
        if (!cancelled) setState({ flows: [], loaded: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function ExecuteFlowForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  t,
}: {
  cfg: ExecuteFlowCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { flow } = useFlowEditor();
  const enabled = useSubflowAuthoringCapability();
  const { flows, loaded } = useAccountFlows();
  const options = flows.filter((f) => f.id !== flow.id);
  const target = cfg.target_flow_id ?? "";
  const selected = options.find((f) => f.id === target);
  const statusLabel = (status: string) => (status === "active" ? t("flowStatusActive") : status === "archived" ? t("flowStatusArchived") : t("flowStatusDraft"));
  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("targetFlow")}</label>
        <FlowPicker
          options={options}
          value={target}
          onChange={(id) => onUpdateConfig({ target_flow_id: id })}
          disabled={!enabled}
          ariaLabel={t("targetFlow")}
          placeholder={t("pickTargetFlow")}
          unavailableLabel={t("targetFlowUnavailable")}
          searchPlaceholder={t("searchFlows")}
          emptyLabel={t("noFlowsMatch")}
          cappedLabel={(shown, total) => t("flowSearchCapped", { shown, total })}
          statusLabel={statusLabel}
        />
        {loaded && target && !selected && (
          <p role="alert" className="mt-1 text-xs text-destructive">{t("targetFlowMissing")}</p>
        )}
        {loaded && options.length === 0 && <p className="mt-1 text-xs text-muted-foreground">{t("noOtherFlows")}</p>}
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label={t("continuesAfterFlow")}
      />
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("callReferenceLabel")}</label>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <NodeKeySelect
              value={cfg.reference_node_key || null}
              nodes={allNodes.filter((n) => n.node_type === "send_message" || n.node_type === "send_media")}
              excludeKey={currentKey}
              onChange={(v) => onUpdateConfig({ reference_node_key: v ?? undefined })}
              placeholder={t("callReferenceNone")}
            />
          </div>
          {cfg.reference_node_key && (
            <Button type="button" variant="ghost" size="sm" onClick={() => onUpdateConfig({ reference_node_key: undefined })}>{t("callReferenceClear")}</Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("callReferenceHelp")}</p>
      </div>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">{t("onCustomerReplyLabel")}</label>
        <Select value={cfg.on_customer_reply ?? "stop"} onValueChange={(v) => { if (v) onUpdateConfig({ on_customer_reply: v }); }}>
          <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="stop">{t("onCustomerReplyStop")}</SelectItem>
            <SelectItem value="continue">{t("onCustomerReplyContinue")}</SelectItem>
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">{t("onCustomerReplyHelp")}</p>
      </div>
      <p className="text-xs text-muted-foreground">{enabled ? t("subflowDraftOnly") : t("subflowAuthoringDisabled")}</p>
    </>
  );
}

// ============================================================
// end (P8: scope). The choice is only offered where subflows can be authored; everyone else sees the historic form, and a saved
// "return" choice is always shown so it can never be silently hidden or changed.
// ============================================================

function EndForm({ scope, onUpdateConfig, t }: { scope?: string; onUpdateConfig: (patch: Record<string, unknown>) => void; t: ReturnType<typeof useTranslations> }) {
  const subflowAuthoring = useSubflowAuthoringCapability();
  return (
    <>
      <p className="text-xs text-muted-foreground">{t("endNodeHelp")}</p>
      {(subflowAuthoring || scope === "subflow") && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">{t("endScopeLabel")}</label>
          <Select value={scope ?? "run"} disabled={!subflowAuthoring} onValueChange={(v) => { if (v) onUpdateConfig({ scope: v === "run" ? undefined : v }); }}>
            <SelectTrigger className="bg-muted"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="run">{t("endScopeRun")}</SelectItem>
              <SelectItem value="subflow">{t("endScopeSubflow")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="mt-1 text-xs text-muted-foreground">{t("endScopeHelp")}</p>
        </div>
      )}
    </>
  );
}
