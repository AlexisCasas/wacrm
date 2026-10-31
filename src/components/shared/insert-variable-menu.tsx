"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import type { VariableCatalogEntry } from "@/lib/variables";

/**
 * "Insert variable" picker. Offers the contact's fields, the account's custom fields and (inside a flow) the variables the flow captures,
 * from GET /api/variables, and hands the chosen reference (already wrapped in braces) to `onInsert`. It inserts text into a DRAFT only:
 * nothing is sent from here.
 */
export function InsertVariableMenu({ flowId, onInsert }: { flowId?: string; onInsert: (token: string) => void }) {
  const t = useTranslations("variables");
  const [entries, setEntries] = useState<VariableCatalogEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/variables${flowId ? `?flow_id=${encodeURIComponent(flowId)}` : ""}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { variables?: VariableCatalogEntry[] } | null) => {
        if (!cancelled) setEntries(j?.variables ?? []);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [flowId]);

  const groups: Array<[VariableCatalogEntry["group"], string]> = [
    ["contact", t("groupContact")],
    ["custom", t("groupCustom")],
    ["flow", t("groupFlow")],
  ];

  return (
    <select
      aria-label={t("insert")}
      className="h-7 rounded-md border border-border bg-muted px-2 text-xs text-muted-foreground"
      value=""
      disabled={!entries || entries.length === 0}
      onChange={(e) => {
        if (e.target.value) onInsert(e.target.value);
      }}
    >
      <option value="">{t("insert")}</option>
      {groups.map(([group, label]) => {
        const items = (entries ?? []).filter((x) => x.group === group);
        if (items.length === 0) return null;
        return (
          <optgroup key={group} label={label}>
            {items.map((x) => (
              <option key={x.token} value={x.token}>
                {x.label}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
