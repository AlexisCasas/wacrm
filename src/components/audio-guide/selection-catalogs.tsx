"use client";

/**
 * Purposes ("finalidades") and identifiers ("identificadores") of the account, on the Audios por producto screen. Everyone who can see the screen
 * can read them; only an admin (`canEdit`) creates, renames, activates, deactivates or deletes. All changes go through /api/audio-guide, which
 * applies the rules of migration 076 (unique normalised names, limits of 50 and 100, no deleting a name an audio uses); this component only
 * explains the answers.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Loader2, Pencil, Plus, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { SelectionName, SelectionNames } from "@/hooks/use-audio-selection-names";
import { cn } from "@/lib/utils";
import { api, type ApiResult } from "./api-client";

type Kind = "purpose" | "identifier";
const PATH: Record<Kind, string> = { purpose: "/api/audio-guide/purposes", identifier: "/api/audio-guide/identifiers" };
const NAME_MAX = 60;

export function SelectionCatalogs({ names, canEdit, errorText }: { names: SelectionNames; canEdit: boolean; errorText: (r: ApiResult) => string }) {
  const t = useTranslations("AudioGuide");
  const [open, setOpen] = useState(false);
  const total = names.purposes.length + names.identifiers.length;

  return (
    <section className="rounded-lg border border-border bg-card" data-testid="selection-catalogs">
      <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left" aria-expanded={open} onClick={() => setOpen((v) => !v)} data-testid="selection-catalogs-toggle">
        <span>
          <span className="block text-sm font-semibold">{t("catalogsTitle")}</span>
          <span className="block text-xs text-muted-foreground">{t("catalogsSubtitle")}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {names.state === "ready" && <Badge variant="secondary">{names.purposes.length} · {names.identifiers.length}</Badge>}
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="sr-only">{open ? t("catalogsToggleHide") : t("catalogsToggleShow")}</span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border px-4 py-4" data-testid="selection-catalogs-body" data-total={total}>
          {names.state === "loading" && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</p>}
          {names.state === "error" && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-destructive" role="alert" data-testid="catalogs-error">{t("catalogLoadError")}
              <Button variant="outline" size="sm" onClick={names.reload}>{t("catalogRetry")}</Button></p>
          )}
          {names.state === "ready" && (
            <div className="grid gap-6 md:grid-cols-2">
              <NameColumn kind="purpose" items={names.purposes} canEdit={canEdit} onChanged={names.reload} errorText={errorText} />
              <NameColumn kind="identifier" items={names.identifiers} canEdit={canEdit} onChanged={names.reload} errorText={errorText} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NameColumn({ kind, items, canEdit, onChanged, errorText }: { kind: Kind; items: SelectionName[]; canEdit: boolean; onChanged: () => void; errorText: (r: ApiResult) => string }) {
  const t = useTranslations("AudioGuide");
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<SelectionName | null>(null);
  const [deleting, setDeleting] = useState(false);
  const limit = kind === "purpose" ? 50 : 100;
  const title = kind === "purpose" ? t("purposesTitle") : t("identifiersTitle");

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    setCreating(true); setCreateError(null);
    const r = await api("POST", PATH[kind], { name });
    setCreating(false);
    if (r.status === 201) { setDraft(""); toast.success(t("catalogCreated")); onChanged(); return; }
    setCreateError(errorText(r));
  };

  return (
    <div data-testid={`${kind}-column`}>
      <h3 className="text-sm font-semibold">{title}<span className="ml-2 text-xs font-normal text-muted-foreground">{items.length}/{limit}</span></h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{kind === "purpose" ? t("purposesHelp") : t("identifiersHelp")}</p>

      {canEdit && (
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input value={draft} maxLength={NAME_MAX} onChange={(e) => { setDraft(e.target.value); setCreateError(null); }} disabled={creating}
            placeholder={kind === "purpose" ? t("newPurposePlaceholder") : t("newIdentifierPlaceholder")} aria-label={kind === "purpose" ? t("newPurposePlaceholder") : t("newIdentifierPlaceholder")}
            aria-invalid={createError !== null} data-testid={`new-${kind}-name`} />
          <Button type="submit" variant="outline" disabled={creating || !draft.trim()} data-testid={`add-${kind}`}>
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}{t("catalogAdd")}
          </Button>
        </form>
      )}
      {createError && <p className="mt-1 text-xs text-destructive" role="alert" data-testid={`${kind}-create-error`}>{createError}</p>}

      <ul className="mt-3 space-y-2" data-testid={`${kind}-list`}>
        {items.length === 0 && <li className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{kind === "purpose" ? t("catalogEmptyPurposes") : t("catalogEmptyIdentifiers")}</li>}
        {items.map((item) => <NameRow key={`${item.id}:${item.name}:${item.active}`} kind={kind} item={item} canEdit={canEdit} onChanged={onChanged} onDelete={() => setToDelete(item)} errorText={errorText} />)}
      </ul>

      <Dialog open={toDelete !== null} onOpenChange={(o) => { if (!o) setToDelete(null); }}>
        <DialogContent className="bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("catalogDeleteTitle", { name: toDelete?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("catalogDeleteBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setToDelete(null)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={deleting} data-testid={`confirm-delete-${kind}`} onClick={async () => {
              if (!toDelete) return;
              setDeleting(true);
              const r = await api("DELETE", `${PATH[kind]}/${toDelete.id}`);
              setDeleting(false);
              if (r.status === 200) { toast.success(t("catalogDeleted")); setToDelete(null); onChanged(); }
              else { toast.error(errorText(r)); setToDelete(null); onChanged(); }
            }}>{deleting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t("catalogDelete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NameRow({ kind, item, canEdit, onChanged, onDelete, errorText }: { kind: Kind; item: SelectionName; canEdit: boolean; onChanged: () => void; onDelete: () => void; errorText: (r: ApiResult) => string }) {
  const t = useTranslations("AudioGuide");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: Record<string, unknown>, success: string) => {
    setBusy(true); setError(null);
    const r = await api("PATCH", `${PATH[kind]}/${item.id}`, body);
    setBusy(false);
    if (r.status === 200) { toast.success(success); setEditing(false); onChanged(); return; }
    setError(errorText(r));
  };

  return (
    <li className={cn("rounded-md border border-border bg-background p-2", !item.active && "opacity-80")} data-testid={`${kind}-${item.id}`} data-active={item.active}>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Input value={name} maxLength={NAME_MAX} onChange={(e) => { setName(e.target.value); setError(null); }} className="h-8 min-w-32 flex-1" aria-label={t("catalogRename")} aria-invalid={error !== null} data-testid={`rename-input-${item.id}`} />
            <Button size="sm" disabled={busy || !name.trim() || name.trim() === item.name} data-testid={`rename-save-${item.id}`} onClick={() => void patch({ name }, t("catalogRenamed"))}>{busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}{t("catalogSave")}</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(false); setName(item.name); setError(null); }}>{t("cancel")}</Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-medium" title={item.name}>{item.name}</span>
            <Badge variant={item.active ? "default" : "secondary"}>{item.active ? t("active") : t("inactive")}</Badge>
            <span className="text-xs text-muted-foreground" data-testid={`usage-${item.id}`}>{item.in_use > 0 ? t("catalogUsedBy", { count: item.in_use }) : t("catalogUnused")}</span>
            {canEdit && (
              <>
                <Button variant="ghost" size="icon" aria-label={t("catalogRename")} disabled={busy} onClick={() => setEditing(true)} data-testid={`rename-${item.id}`}><Pencil className="h-4 w-4" /></Button>
                <label className="flex items-center gap-1.5 text-xs">
                  <Switch checked={item.active} disabled={busy} aria-label={`${t("catalogActiveLabel")}: ${item.name}`} data-testid={`active-${item.id}`} onCheckedChange={(checked) => void patch({ active: checked }, t("saved"))} />
                </label>
                <Button variant="ghost" size="icon" aria-label={`${t("catalogDelete")}: ${item.name}`} disabled={busy || item.in_use > 0} title={item.in_use > 0 ? t("catalogDeleteBlocked", { count: item.in_use }) : t("catalogDelete")} onClick={onDelete} data-testid={`delete-${item.id}`}><Trash2 className="h-4 w-4" /></Button>
              </>
            )}
          </>
        )}
      </div>
      {!item.active && !editing && <p className="mt-1 text-[11px] text-muted-foreground">{t("catalogInactiveHint")}</p>}
      {canEdit && item.in_use > 0 && !editing && <p className="mt-1 text-[11px] text-muted-foreground" data-testid={`blocked-${item.id}`}>{t("catalogDeleteBlocked", { count: item.in_use })}</p>}
      {error && <p className="mt-1 text-xs text-destructive" role="alert" data-testid={`error-${item.id}`}>{error}</p>}
    </li>
  );
}
