"use client";

/**
 * "Audios por producto": the catalog admin. Left, the account's products with a search box; right, the selected product's audio
 * sequence (add a verified .ogg, preview it, reorder, set the pause before each audio, switch audios and the product on or off).
 *
 * Every write sends the `revision` the screen loaded; if someone else changed the product meanwhile, the server answers 409 and the
 * screen reloads instead of overwriting. Only administrators see the controls; the API enforces the role again.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, GripVertical, Loader2, Mic, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { useAudioSelectionNames, type SelectionNames } from "@/hooks/use-audio-selection-names";
import { useAudioGuideEnabled } from "@/hooks/use-audio-guide-enabled";
import { canEditSettings } from "@/lib/auth/roles";
import { stageVoiceNote, type VoiceNoteProblem } from "@/lib/audio-guide/stage-client";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { api, type ApiResult } from "./api-client";
import { SelectionCatalogs } from "./selection-catalogs";

interface Item { id: string; position: number; sha256: string; url: string; label: string | null; bytes: number; duration_ms: number; pre_delay_seconds: number; status: "active" | "disabled"; purpose_id?: string | null; identifier_id?: string | null }
interface Summary { id: string; product_key: string; display_name: string; active: boolean; revision: number; item_count: number; active_item_count: number }
interface Detail extends Omit<Summary, "item_count" | "active_item_count"> { items: Item[] }

const MAX_ITEMS = 6;

export function AudioGuideAdmin() {
  const t = useTranslations("AudioGuide");
  const enabled = useAudioGuideEnabled();
  const { accountRole } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const names = useAudioSelectionNames(enabled === true);

  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Summary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createKey, setCreateKey] = useState(0);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const errorText = useCallback((r: ApiResult): string => {
    const code = String(r.body.error ?? "");
    // Three different refusals: no session (401), the module is off for this account (403 voice_notes_disabled) and a real lack of role (403).
    if (r.status === 401) return t("errorUnauthenticated");
    if (r.status === 403) return code === "voice_notes_disabled" ? t("errorModuleDisabled") : t("errorForbidden");
    if (code === "duplicate_key") return t("errorDuplicateKey");
    if (code === "duplicate_audio") return t("errorDuplicateAudio");
    if (code === "display_name_required" || code === "display_name_too_long") return t("errorInvalidName");
    if (code === "invalid_value" || code === "product_value_invalid") return t("errorInvalidValue");
    if (code === "pause_out_of_range") return t("errorPause");
    if (code === "duplicate_name") return t("errorDuplicateName");
    if (code === "in_use") return t("errorInUse");
    if (code === "duplicate_classification") return t("errorDuplicateClassification");
    if (code === "purpose_inactive") return t("errorPurposeInactive");
    if (code === "identifier_inactive") return t("errorIdentifierInactive");
    if (code === "purpose_not_found") return t("errorPurposeMissing");
    if (code === "identifier_not_found") return t("errorIdentifierMissing");
    if (code === "limit_reached") return t("limitReached");
    if (code === "file_not_stored") return t("errorFileNotStored");
    if (code === "file_rejected") {
      const reason = String(r.body.reason ?? "");
      return reason === "not_mono" ? t("errorNotMono") : reason === "too_large" ? t("errorTooLarge") : ["not_ogg", "not_opus", "opus_version_unsupported", "bad_channel_mapping"].includes(reason) ? t("errorNotOgg") : t("errorCorrupt");
    }
    return t("errorGeneric");
  }, [t]);

  /** Errors of the purpose / identifier lists: the generic ones are shared, but 422/invalid_value here is about the NAME, not a product. */
  const catalogErrorText = useCallback((r: ApiResult): string => {
    const code = String(r.body.error ?? "");
    if (code === "invalid_value" || code === "name_required") return t("errorCatalogName");
    if (code === "limit_reached") return t("errorCatalogLimit");
    return errorText(r);
  }, [errorText, t]);

  const loadList = useCallback(async (q: string) => {
    const r = await api("GET", `/api/audio-guide/products${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`);
    if (r.status === 200) setProducts(r.body.products as Summary[]);
    else { setProducts((cur) => cur ?? []); toast.error(errorText(r)); }
  }, [errorText]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    const r = await api("GET", `/api/audio-guide/products/${id}`);
    setDetailLoading(false);
    if (r.status === 200) setDetail(r.body.product as Detail);
    else { setDetail(null); setSelectedId(null); toast.error(errorText(r)); }
  }, [errorText]);

  // search (debounced) and first load
  useEffect(() => {
    if (enabled !== true) return;
    const handle = setTimeout(() => { void loadList(query); }, query ? 250 : 0);
    return () => clearTimeout(handle);
  }, [enabled, query, loadList]);

  const select = useCallback((id: string) => { setSelectedId(id); void loadDetail(id); }, [loadDetail]);
  const shown = selectedId && detail?.id === selectedId ? detail : null;

  /** One write: sends the loaded revision, applies the answer, and reloads on a conflict. */
  const write = useCallback(async (key: string, run: (revision: number) => Promise<ApiResult>, success?: string, onFail?: (r: ApiResult) => void) => {
    if (!detail) return false;
    setBusy(key);
    const r = await run(detail.revision);
    setBusy(null);
    if (r.status === 200 || r.status === 201) {
      if (r.body.product) setDetail(r.body.product as Detail);
      if (success) toast.success(success);
      void loadList(query);
      return true;
    }
    onFail?.(r);
    if (r.status === 409 && r.body.error === "revision_conflict") {
      toast.error(t("conflict"));
      void loadDetail(detail.id);
      void loadList(query);
    } else if (r.status === 409 && r.body.error === "duplicate_audio") {
      // Already there (a retry that had in fact worked, or the same file twice): show the sequence as it is now, add nothing.
      toast.info(t("errorDuplicateAudio"));
      void loadDetail(detail.id);
      void loadList(query);
    } else toast.error(errorText(r));
    return false;
  }, [detail, errorText, loadDetail, loadList, query, t]);

  if (enabled === null) return <div className="flex h-64 items-center justify-center text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("loading")}</div>;
  if (enabled === false) {
    return (
      <div className="mx-auto max-w-xl px-6 py-16 text-center" data-testid="audio-guide-disabled">
        <Mic className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t("notEnabledTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("notEnabledBody")}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 px-4 py-6 md:px-6" data-testid="audio-guide">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("title")}</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {canEdit && <Button data-testid="new-product" onClick={() => { setCreateKey((k) => k + 1); setCreateOpen(true); }}><Plus className="mr-1 h-4 w-4" />{t("newProduct")}</Button>}
      </div>
      {accountRole && !canEdit && <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="read-only-notice">{t("readOnlyNotice")}</p>}

      <SelectionCatalogs names={names} canEdit={canEdit} errorText={catalogErrorText} />

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        {/* ------------------------------------------------ product list */}
        <aside className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("searchPlaceholder")} className="pl-8" aria-label={t("searchPlaceholder")} />
          </div>
          <ul className="space-y-1" data-testid="product-list">
            {products === null && <li className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("loading")}</li>}
            {products?.length === 0 && <li className="px-2 py-3 text-sm text-muted-foreground">{query.trim() ? t("emptySearch") : t("emptyList")}</li>}
            {products?.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => select(p.id)} data-testid={`product-${p.product_key}`}
                  className={cn("w-full rounded-md border px-3 py-2 text-left transition-colors hover:bg-muted", selectedId === p.id ? "border-primary bg-primary/10" : "border-border bg-card")}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{p.display_name}</span>
                    <Badge variant={p.active ? "default" : "secondary"}>{p.active ? t("active") : t("inactive")}</Badge>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{p.product_key}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{t("audiosCount", { active: p.active_item_count, total: p.item_count })}</div>
                </button>
              </li>
            ))}
          </ul>
          <LookupCard />
        </aside>

        {/* ------------------------------------------------ editor */}
        <section className="min-w-0 rounded-lg border border-border bg-card p-4" data-testid="product-editor">
          {!selectedId && <p className="py-12 text-center text-sm text-muted-foreground">{t("noProductSelected")}</p>}
          {selectedId && detailLoading && !shown && <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" />{t("loading")}</div>}
          {shown && (
            <ProductEditor key={`${shown.id}:${shown.revision}`} detail={shown} canEdit={canEdit} busy={busy} write={write} names={names} errorText={errorText}
              onDelete={() => setDeleteOpen(true)} />
          )}
        </section>
      </div>

      <RecentRequests />

      <CreateDialog key={createKey} open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => { setCreateOpen(false); toast.success(t("created")); void loadList(query); select(id); }} errorText={errorText} />

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="bg-popover text-popover-foreground">
          <DialogHeader>
            <DialogTitle>{t("deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirmBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>{t("cancel")}</Button>
            <Button variant="destructive" disabled={busy === "delete"} data-testid="confirm-delete-product" onClick={async () => {
              if (!detail) return;
              setBusy("delete");
              const r = await api("DELETE", `/api/audio-guide/products/${detail.id}?expected_revision=${detail.revision}`);
              setBusy(null);
              if (r.status === 200) { setDeleteOpen(false); setSelectedId(null); toast.success(t("deleted")); void loadList(query); }
              else if (r.status === 409) { setDeleteOpen(false); toast.error(t("conflict")); void loadDetail(detail.id); }
              else toast.error(errorText(r));
            }}>{busy === "delete" && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t("delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ====================================================================================================== recent sends (operator view)
interface RecentRow {
  id: string; created_at: string; status: string; reason: string | null; product_key: string | null;
  sends: Array<{ position: number; status: string; error_code: string | null; finished_at: string | null }>;
  run: { id: string; flow_id: string; status: string; end_reason: string | null } | null;
}

const SEND_TONE: Record<string, string> = {
  sent: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  failed: "border-red-500/40 bg-red-500/10 text-red-300",
  uncertain: "border-amber-500/50 bg-amber-500/15 text-amber-300",
  pending: "border-border bg-muted text-muted-foreground",
  sending: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  skipped: "border-border bg-muted text-muted-foreground",
};

function RecentRequests() {
  const t = useTranslations("AudioGuide");
  const [rows, setRows] = useState<RecentRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const r = await api("GET", "/api/audio-guide/requests?limit=20");
    setLoading(false);
    setRows(r.status === 200 ? (r.body.requests as RecentRow[]) : []);
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await api("GET", "/api/audio-guide/requests?limit=20");
      if (!cancelled) setRows(r.status === 200 ? (r.body.requests as RecentRow[]) : []);
    })();
    return () => { cancelled = true; };
  }, []);
  const label = (prefix: string, key: string) => { try { return t(`${prefix}_${key}`); } catch { return key; } };
  return (
    <section className="rounded-lg border border-border bg-card p-4" data-testid="recent-requests">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("recentTitle")}</h2>
          <p className="text-xs text-muted-foreground">{t("recentHint")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} data-testid="recent-refresh">
          {loading ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}{t("recentRefresh")}
        </Button>
      </div>
      {rows === null && <p className="mt-3 text-sm text-muted-foreground">{t("loading")}</p>}
      {rows?.length === 0 && <p className="mt-3 text-sm text-muted-foreground" data-testid="recent-empty">{t("recentEmpty")}</p>}
      {rows && rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr><th className="py-1 pr-3 font-medium">{t("colTime")}</th><th className="py-1 pr-3 font-medium">{t("colProduct")}</th><th className="py-1 pr-3 font-medium">{t("colStatus")}</th><th className="py-1 pr-3 font-medium">{t("colAudios")}</th><th className="py-1 font-medium">{t("colRun")}</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border align-top" data-testid="recent-row" data-status={r.status}>
                  <td className="py-2 pr-3 whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</td>
                  <td className="py-2 pr-3 font-mono">{r.product_key ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <div>{label("reqStatus", r.status)}</div>
                    {r.reason && <div className="font-mono text-[10px] text-muted-foreground">{r.reason}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex flex-wrap gap-1">
                      {r.sends.map((s) => (
                        <span key={s.position} title={s.error_code ?? undefined} data-send-status={s.status} className={cn("rounded border px-1.5 py-0.5", SEND_TONE[s.status] ?? SEND_TONE.pending)}>
                          {s.position} · {label("sendState", s.status)}{s.error_code ? ` (${s.error_code})` : ""}
                        </span>
                      ))}
                      {r.sends.length === 0 && <span className="text-muted-foreground">—</span>}
                    </div>
                    {r.sends.some((s) => s.status === "uncertain") && <div className="mt-1 text-[10px] text-amber-300" data-testid="uncertain-help">{t("uncertainHelp")}</div>}
                  </td>
                  <td className="py-2">
                    {r.run ? (
                      <div>
                        <Link href={`/flows/${r.run.flow_id}/runs`} className="text-primary hover:underline">{t("openRun")}</Link>
                        <div className="font-mono text-[10px] text-muted-foreground">{r.run.status}{r.run.end_reason ? ` · ${r.run.end_reason}` : ""}</div>
                        {r.status !== "completed" || r.run.status !== "completed" ? <div className="text-[10px] text-muted-foreground">{t("runStatusNote")}</div> : null}
                      </div>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ====================================================================================================== create dialog
function CreateDialog({ open, onOpenChange, onCreated, errorText }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void; errorText: (r: ApiResult) => string }) {
  const t = useTranslations("AudioGuide");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover text-popover-foreground">
        <DialogHeader><DialogTitle>{t("createTitle")}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <label className="block text-sm">{t("createNameLabel")}
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("createNamePlaceholder")} className="mt-1" data-testid="create-name" />
          </label>
          <label className="block text-sm">{t("createValueLabel")}
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={name || t("createNamePlaceholder")} className="mt-1" data-testid="create-value" />
            <span className="mt-1 block text-xs text-muted-foreground">{t("createValueHint")}</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button disabled={saving || !name.trim()} data-testid="create-submit" onClick={async () => {
            setSaving(true);
            const r = await api("POST", "/api/audio-guide/products", { display_name: name, ...(value.trim() ? { product_value: value } : {}) });
            setSaving(false);
            if (r.status === 201) onCreated(((r.body.product as Detail).id));
            else toast.error(errorText(r));
          }}>{saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}{t("create")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ====================================================================================================== lookup card
function LookupCard() {
  const t = useTranslations("AudioGuide");
  const [value, setValue] = useState("");
  const [state, setState] = useState<{ loading: boolean; kind?: string; count?: number }>({ loading: false });
  return (
    <div className="rounded-lg border border-border bg-card p-3" data-testid="lookup-card">
      <h2 className="text-sm font-medium">{t("lookupTitle")}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">{t("lookupHint")}</p>
      <div className="mt-2 flex gap-2">
        <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("lookupPlaceholder")} aria-label={t("lookupPlaceholder")} onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget.nextElementSibling as HTMLButtonElement | null)?.click(); }} />
        <Button variant="outline" disabled={state.loading} onClick={async () => {
          setState({ loading: true });
          const r = await api("GET", `/api/audio-guide/lookup?value=${encodeURIComponent(value)}`);
          setState({ loading: false, kind: r.status === 200 ? String(r.body.kind) : "error", count: Array.isArray(r.body.items) ? r.body.items.length : 0 });
        }}>{state.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("lookupButton")}</Button>
      </div>
      {state.kind && (
        <p className="mt-2 text-xs" data-testid="lookup-result" data-kind={state.kind}>
          {state.kind === "ready" ? t("lookupReady", { count: state.count ?? 0 })
            : state.kind === "no_value" ? t("lookupNoValue")
            : state.kind === "unknown_product" ? t("lookupUnknown")
            : state.kind === "product_inactive" ? t("lookupInactive")
            : state.kind === "no_audios" ? t("lookupNoAudios")
            : t("errorGeneric")}
        </p>
      )}
    </div>
  );
}

// ====================================================================================================== product editor
type Write = (key: string, run: (revision: number) => Promise<ApiResult>, success?: string, onFail?: (r: ApiResult) => void) => Promise<boolean>;

function ProductEditor({ detail, canEdit, busy, write, names, errorText, onDelete }: { detail: Detail; canEdit: boolean; busy: string | null; write: Write; names: SelectionNames; errorText: (r: ApiResult) => string; onDelete: () => void }) {
  const t = useTranslations("AudioGuide");
  const [name, setName] = useState(detail.display_name);
  const [value, setValue] = useState(detail.product_key);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  // (A reloaded product, after a save or a conflict, remounts this editor with the server's values: see the key where it is rendered.)

  const items = detail.items;
  const activeCount = items.filter((i) => i.status === "active").length;
  const reorder = (ids: string[]) => write("order", (rev) => api("PUT", `/api/audio-guide/products/${detail.id}/order`, { expected_revision: rev, item_ids: ids }), t("orderSaved"));
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    void reorder(arrayMove(items, index, target).map((i) => i.id));
  };
  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = items.findIndex((i) => i.id === active.id), to = items.findIndex((i) => i.id === over.id);
    if (from >= 0 && to >= 0) void reorder(arrayMove(items, from, to).map((i) => i.id));
  };

  const onFile = async (file: File) => {
    setUploading(true);
    const staged = await stageVoiceNote(file);
    if (!staged.ok) { setUploading(false); toast.error(problemText(staged.problem, t)); return; }
    const added = await write("add", (rev) => api("POST", `/api/audio-guide/products/${detail.id}/items`, { expected_revision: rev, path: staged.path, label: file.name.replace(/\.ogg$/i, "").slice(0, 120) || undefined }), t("audioAdded"));
    // Say it when the file was completed automatically, with the length it declares, so the person can compare it with what they expect.
    if (added && staged.repaired) toast.warning(t("audioRepaired", { seconds: (staged.durationMs / 1000).toFixed(1) }));
    setUploading(false);
  };

  return (
    <div className="space-y-5">
      {/* header: name, value, active */}
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="product-name">{t("productNameLabel")}</label>
          <div className="mt-1 flex gap-2">
            <Input id="product-name" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
            {canEdit && <Button variant="outline" disabled={busy !== null || !name.trim() || name.trim() === detail.display_name} data-testid="save-name"
              onClick={() => void write("name", (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}`, { expected_revision: rev, display_name: name }), t("saved"))}>{t("saveName")}</Button>}
          </div>
        </div>
        <div>
          <label className="text-xs text-muted-foreground" htmlFor="product-value">{t("productValueLabel")}</label>
          <div className="mt-1 flex gap-2">
            <Input id="product-value" value={value} disabled={!canEdit} onChange={(e) => setValue(e.target.value)} className="font-mono" />
            {canEdit && <Button variant="outline" disabled={busy !== null || !value.trim() || value === detail.product_key} data-testid="save-value"
              onClick={() => void write("value", (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}`, { expected_revision: rev, product_value: value }), t("saved"))}>{t("saveValue")}</Button>}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t("productValueHint")}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={detail.active} disabled={!canEdit || busy !== null} data-testid="product-active" aria-label={t("activeLabel")}
            onCheckedChange={(checked) => void write("active", (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}`, { expected_revision: rev, active: checked }), t("saved"))} />
          {t("activeLabel")}
        </label>
        {canEdit && <Button variant="outline" onClick={onDelete} data-testid="delete-product"><Trash2 className="mr-1 h-4 w-4" />{t("deleteProduct")}</Button>}
      </div>

      {/* sequence */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{t("sequenceTitle")}</h2>
            <p className="text-xs text-muted-foreground">{t("sequenceHint")}</p>
          </div>
          {canEdit && (
            <div className="text-right">
              <input ref={fileRef} type="file" accept=".ogg,audio/ogg,application/ogg" className="hidden" data-testid="audio-file-input"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void onFile(f); }} />
              <Button variant="outline" disabled={uploading || busy !== null || items.length >= MAX_ITEMS} data-testid="add-audio" onClick={() => fileRef.current?.click()}>
                {uploading ? <><Loader2 className="mr-1 h-4 w-4 animate-spin" />{t("verifying")}</> : <><Upload className="mr-1 h-4 w-4" />{t("addAudio")}</>}
              </Button>
              <p className="mt-1 text-xs text-muted-foreground">{items.length >= MAX_ITEMS ? t("limitReached") : t("addAudioHint")}</p>
            </div>
          )}
        </div>

        {items.length === 0 && <p className="mt-3 rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground" data-testid="no-audios">{t("noAudios")}</p>}
        {items.length > 0 && activeCount === 0 && <p className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300" data-testid="no-active-audios">{t("noAudiosWarning")}</p>}
        {items.length > 0 && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
              <ol className="mt-3 space-y-2" data-testid="audio-list">
                {items.map((item, index) => (
                  <AudioRow key={`${item.id}:${item.pre_delay_seconds}:${item.label ?? ""}:${item.purpose_id ?? ""}:${item.identifier_id ?? ""}`} item={item} index={index} last={index === items.length - 1} canEdit={canEdit} busy={busy !== null} names={names}
                    onClassify={(purposeId, identifierId, onFail) => write(`class-${item.id}`, (rev) => api("PUT", `/api/audio-guide/products/${detail.id}/items/${item.id}/classification`, { expected_revision: rev, purpose_id: purposeId, identifier_id: identifierId }), purposeId ? t("classifySaved") : t("classifyCleared"), (r) => onFail(errorText(r)))}
                    onMove={(d) => move(index, d)}
                    onToggle={(checked) => void write(`status-${item.id}`, (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}/items/${item.id}`, { expected_revision: rev, status: checked ? "active" : "disabled" }), t("saved"))}
                    onPause={(seconds) => write(`pause-${item.id}`, (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}/items/${item.id}`, { expected_revision: rev, pre_delay_seconds: seconds }), t("saved"))}
                    onLabel={(label) => write(`label-${item.id}`, (rev) => api("PATCH", `/api/audio-guide/products/${detail.id}/items/${item.id}`, { expected_revision: rev, label: label || null }), t("saved"))}
                    onRemove={() => void write(`remove-${item.id}`, (rev) => api("DELETE", `/api/audio-guide/products/${detail.id}/items/${item.id}?expected_revision=${rev}`), t("audioRemoved"))} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  );
}

function problemText(problem: VoiceNoteProblem, t: ReturnType<typeof useTranslations>): string {
  switch (problem) {
    case "needs_ogg": return t("errorNeedsOgg");
    case "too_large": return t("errorTooLarge");
    case "not_ogg": return t("errorNotOgg");
    case "not_mono": return t("errorNotMono");
    case "corrupt": return t("errorCorrupt");
    default: return t("errorUpload");
  }
}

function AudioRow({ item, index, last, canEdit, busy, names, onClassify, onMove, onToggle, onPause, onLabel, onRemove }: {
  item: Item; index: number; last: boolean; canEdit: boolean; busy: boolean; names: SelectionNames;
  onClassify: (purposeId: string | null, identifierId: string | null, onFail: (message: string) => void) => Promise<boolean>;
  onMove: (delta: -1 | 1) => void; onToggle: (checked: boolean) => void; onPause: (seconds: number) => Promise<boolean>; onLabel: (label: string) => Promise<boolean>; onRemove: () => void;
}) {
  const t = useTranslations("AudioGuide");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: !canEdit });
  const [pause, setPause] = useState(String(item.pre_delay_seconds));
  const [label, setLabel] = useState(item.label ?? "");
  const pauseNumber = Number(pause);
  const pauseValid = Number.isInteger(pauseNumber) && pauseNumber >= 5 && pauseNumber <= 30;
  // Classification: a purpose AND an identifier (both or neither). Saved as soon as both are chosen, cleared when both are emptied.
  const [purposeSel, setPurposeSel] = useState(item.purpose_id ?? "");
  const [identifierSel, setIdentifierSel] = useState(item.identifier_id ?? "");
  const [classError, setClassError] = useState<string | null>(null);
  const [classBusy, setClassBusy] = useState(false);
  const classified = Boolean(item.purpose_id && item.identifier_id);
  const half = (purposeSel === "") !== (identifierSel === "");
  const classify = async (purposeId: string, identifierId: string) => {
    setClassBusy(true); setClassError(null);
    const ok = await onClassify(purposeId || null, identifierId || null, (message) => setClassError(message));
    setClassBusy(false);
    if (!ok) { setPurposeSel(item.purpose_id ?? ""); setIdentifierSel(item.identifier_id ?? ""); }
  };
  const choose = (which: "purpose" | "identifier", value: string) => {
    const p = which === "purpose" ? value : purposeSel, i = which === "identifier" ? value : identifierSel;
    setPurposeSel(p); setIdentifierSel(i); setClassError(null);
    if ((p && i) || (!p && !i && classified)) void classify(p, i);
  };

  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} data-testid={`audio-${index + 1}`} data-item-id={item.id} data-status={item.status}
      className={cn("rounded-md border border-border bg-background p-3", isDragging && "z-10 opacity-80 shadow-lg", item.status === "disabled" && "opacity-70")}>
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && <button type="button" className="cursor-grab rounded p-1 text-muted-foreground hover:bg-muted" aria-label={t("dragHandle")} {...attributes} {...listeners}><GripVertical className="h-4 w-4" /></button>}
        <span className="w-6 text-center text-sm font-semibold text-muted-foreground">{index + 1}</span>
        <Input value={label} disabled={!canEdit} onChange={(e) => setLabel(e.target.value)} placeholder={t("labelPlaceholder")} aria-label={t("labelPlaceholder")} className="h-8 min-w-40 flex-1"
          onBlur={() => { if (label.trim() !== (item.label ?? "")) void onLabel(label.trim()); }} />
        <span className="text-xs text-muted-foreground">{t("seconds", { count: Math.round(item.duration_ms / 1000) })}</span>
        {canEdit && (
          <>
            <Button variant="ghost" size="icon" disabled={busy || index === 0} onClick={() => onMove(-1)} aria-label={t("moveUp")} data-testid={`up-${index + 1}`}><ArrowUp className="h-4 w-4" /></Button>
            <Button variant="ghost" size="icon" disabled={busy || last} onClick={() => onMove(1)} aria-label={t("moveDown")} data-testid={`down-${index + 1}`}><ArrowDown className="h-4 w-4" /></Button>
          </>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <audio controls preload="none" src={item.url} className="h-8 max-w-full" data-testid={`player-${index + 1}`} />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">{t("pauseLabel")}
          <Input type="number" min={5} max={30} step={1} value={pause} disabled={!canEdit} onChange={(e) => setPause(e.target.value)} aria-label={t("pauseLabel")} data-testid={`pause-${index + 1}`}
            aria-invalid={!pauseValid} className={cn("h-8 w-16", !pauseValid && "border-destructive")}
            onBlur={async () => {
              if (!pauseValid) { toast.error(t("errorPause")); setPause(String(item.pre_delay_seconds)); return; }
              if (pauseNumber !== item.pre_delay_seconds) await onPause(pauseNumber);
            }} />
        </label>
        <label className="flex items-center gap-1.5 text-xs">
          <Switch checked={item.status === "active"} disabled={!canEdit || busy} onCheckedChange={onToggle} aria-label={t("audioActive")} data-testid={`toggle-${index + 1}`} />
          {t("audioActive")}
        </label>
        {canEdit && <Button variant="ghost" size="sm" disabled={busy} onClick={onRemove} data-testid={`remove-${index + 1}`}><Trash2 className="mr-1 h-4 w-4" />{t("removeAudio")}</Button>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3" data-testid={`classification-${index + 1}`} data-classified={classified}>
        <ClassSelect label={t("classifyPurposeLabel")} value={purposeSel} savedId={item.purpose_id ?? null} options={names.purposes} disabled={!canEdit || busy || classBusy || names.state !== "ready"} testId={`purpose-${index + 1}`} onChange={(v) => choose("purpose", v)} />
        <ClassSelect label={t("classifyIdentifierLabel")} value={identifierSel} savedId={item.identifier_id ?? null} options={names.identifiers} disabled={!canEdit || busy || classBusy || names.state !== "ready"} testId={`identifier-${index + 1}`} onChange={(v) => choose("identifier", v)} />
        {classBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        {canEdit && classified && <Button variant="ghost" size="sm" disabled={busy || classBusy} data-testid={`clear-classification-${index + 1}`} onClick={() => { setPurposeSel(""); setIdentifierSel(""); void classify("", ""); }}>{t("classifyClear")}</Button>}
        {!classified && !half && <Badge variant="secondary" data-testid={`unclassified-${index + 1}`}>{t("classifyUnclassified")}</Badge>}
      </div>
      {names.state === "loading" && <p className="mt-1 text-xs text-muted-foreground">{t("classifyLoading")}</p>}
      {names.state === "ready" && canEdit && (names.purposes.length === 0 || names.identifiers.length === 0) && !classified && <p className="mt-1 text-xs text-muted-foreground" data-testid={`no-catalog-${index + 1}`}>{t("classifyNoCatalog")}</p>}
      {half && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400" data-testid={`half-${index + 1}`}>{t("classifyNeedBoth")}</p>}
      {classError && <p className="mt-1 text-xs text-destructive" role="alert" data-testid={`classification-error-${index + 1}`}>{classError}</p>}
    </li>
  );
}

/** A native select (keyboard and screen-reader friendly): "Sin clasificar", the active values, and - if the saved value is inactive or gone - that value, labelled as such. */
function ClassSelect({ label, value, savedId, options, disabled, testId, onChange }: {
  label: string; value: string; savedId: string | null; options: SelectionNames["purposes"]; disabled: boolean; testId: string; onChange: (value: string) => void;
}) {
  const t = useTranslations("AudioGuide");
  const saved = savedId ? options.find((o) => o.id === savedId) : undefined;
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">{label}
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} data-testid={testId}
        className="h-8 max-w-48 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:cursor-not-allowed disabled:opacity-60">
        <option value="">{t("classifyUnclassified")}</option>
        {savedId && !saved && <option value={savedId}>{t("classifyMissingValue")}</option>}
        {options.filter((o) => o.active || o.id === savedId).map((o) => <option key={o.id} value={o.id}>{o.active ? o.name : `${o.name} ${t("classifyInactiveSuffix")}`}</option>)}
      </select>
    </label>
  );
}
