'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
  Search,
  X,
  Folder,
} from 'lucide-react';

import { useTranslations } from 'next-intl';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import {
  listFlows,
  type FlowSort,
  type FlowStatusFilter,
} from '@/lib/flows/listing';

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'archived';
  trigger_type: 'keyword' | 'first_inbound_message' | 'manual';
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
  folder_id: string | null;
}

interface FolderSummary {
  id: string;
  name: string;
  flow_count: number;
  created_at: string;
  updated_at: string;
}

type FolderSelection = 'all' | 'unfiled' | string;

const STATUS_LABELS = (
  t: ReturnType<typeof useTranslations>
): Record<FlowRow['status'], string> => ({
  draft: t('statusDraft'),
  active: t('statusActive'),
  archived: t('statusArchived'),
});

const STATUS_COLORS: Record<FlowRow['status'], string> = {
  draft: 'border-border bg-muted text-muted-foreground',
  active: 'border-emerald-600/40 bg-emerald-500/10 text-emerald-300',
  archived: 'border-border bg-muted/50 text-muted-foreground',
};

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: 'MessageSquare' | 'HelpCircle' | 'UserPlus';
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan('send-messages');
  const t = useTranslations('Flows.list');
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection>('all');
  const [folderDialog, setFolderDialog] = useState<{
    mode: 'create' | 'rename';
    folder?: FolderSummary;
  } | null>(null);
  const [folderName, setFolderName] = useState('');
  const [savingFolder, setSavingFolder] = useState(false);
  const [moveFlow, setMoveFlow] = useState<FlowRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>('unfiled');
  const [moving, setMoving] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<FlowStatusFilter>('all');
  const [sort, setSort] = useState<FlowSort>('newest');

  const folderFlows =
    selectedFolder === 'all'
      ? flows
      : selectedFolder === 'unfiled'
        ? flows.filter((flow) => !flow.folder_id)
        : flows.filter((flow) => flow.folder_id === selectedFolder);
  const listedFlows = listFlows(folderFlows, {
    query: search,
    status: statusFilter,
    sort,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes, foldersRes] = await Promise.all([
          fetch('/api/flows'),
          fetch('/api/flows/templates'),
          fetch('/api/flows/folders'),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
        }
        if (!foldersRes.ok)
          throw new Error(`Failed to load folders: ${foldersRes.status}`);
        const foldersJson = (await foldersRes.json()) as {
          folders: FolderSummary[];
        };
        if (!cancelled) setFolders(foldersJson.folders ?? []);
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t('loadError'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: 'keyword',
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName('');
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t('createError'));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `Clone failed: ${res.status}`);
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('cloneError');
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(t('deleteConfirm', { name: flow.name }));
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      toast.success(t('deleteSuccess'));
    } catch (err) {
      console.error(err);
      toast.error(t('deleteError'));
    }
  }

  async function saveFolder() {
    const name = folderName.trim();
    if (!name || !folderDialog) return;
    setSavingFolder(true);
    try {
      const isRename = folderDialog.mode === 'rename';
      const response = await fetch(
        isRename
          ? `/api/flows/folders/${folderDialog.folder?.id}`
          : '/api/flows/folders',
        {
          method: isRename ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }
      );
      if (!response.ok) throw new Error('Folder save failed');
      const { folder } = (await response.json()) as { folder: FolderSummary };
      setFolders((previous) =>
        isRename
          ? previous.map((item) =>
              item.id === folder.id ? { ...item, ...folder } : item
            )
          : [...previous, folder].sort((left, right) =>
              left.name.localeCompare(right.name)
            )
      );
      setFolderDialog(null);
      setFolderName('');
    } catch (error) {
      console.error(error);
      toast.error(
        folderDialog.mode === 'rename'
          ? t('folderRenameError')
          : t('folderCreateError')
      );
    } finally {
      setSavingFolder(false);
    }
  }

  async function deleteFolder(folder: FolderSummary) {
    if (!window.confirm(t('folderDeleteConfirm', { name: folder.name })))
      return;
    try {
      const response = await fetch(`/api/flows/folders/${folder.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error('Folder delete failed');
      setFolders((previous) =>
        previous.filter((item) => item.id !== folder.id)
      );
      setFlows((previous) =>
        previous.map((flow) =>
          flow.folder_id === folder.id ? { ...flow, folder_id: null } : flow
        )
      );
      if (selectedFolder === folder.id) setSelectedFolder('unfiled');
      toast.success(t('folderDeleted'));
    } catch (error) {
      console.error(error);
      toast.error(t('folderDeleteError'));
    }
  }

  async function saveMove() {
    if (!moveFlow) return;
    setMoving(true);
    try {
      const folder_id = moveTarget === 'unfiled' ? null : moveTarget;
      const response = await fetch(`/api/flows/${moveFlow.id}/folder`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id }),
      });
      if (!response.ok) throw new Error('Flow move failed');
      setFlows((previous) =>
        previous.map((flow) =>
          flow.id === moveFlow.id ? { ...flow, folder_id } : flow
        )
      );
      setFolders((previous) =>
        previous.map((folder) => ({
          ...folder,
          flow_count:
            folder.flow_count +
            (moveFlow.folder_id === folder.id ? -1 : 0) +
            (folder_id === folder.id ? 1 : 0),
        }))
      );
      setMoveFlow(null);
      toast.success(t('moveSuccess'));
    } catch (error) {
      console.error(error);
      toast.error(t('moveError'));
    } finally {
      setMoving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-foreground text-2xl font-semibold">
              {t('title')}
            </h1>
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-amber-300 uppercase">
              {t('beta')}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <GatedButton
          canAct={canCreate}
          gateReason="create flows"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          {t('newFlow')}
        </GatedButton>
      </header>

      <section
        aria-label={t('folders')}
        className="border-border bg-card rounded-lg border p-3"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-foreground flex items-center gap-2 text-sm font-medium">
            <Folder className="text-primary size-4" />
            {t('folders')}
          </h2>
          <GatedButton
            size="sm"
            canAct={canCreate}
            gateReason="manage flow folders"
            onClick={() => {
              setFolderName('');
              setFolderDialog({ mode: 'create' });
            }}
          >
            <Plus className="size-3.5" />
            {t('newFolder')}
          </GatedButton>
        </div>
        <div className="flex flex-wrap gap-2" role="list">
          <FolderFilterButton
            active={selectedFolder === 'all'}
            onClick={() => setSelectedFolder('all')}
          >
            {t('allFolders')} ({flows.length})
          </FolderFilterButton>
          <FolderFilterButton
            active={selectedFolder === 'unfiled'}
            onClick={() => setSelectedFolder('unfiled')}
          >
            {t('unfiled')} ({flows.filter((flow) => !flow.folder_id).length})
          </FolderFilterButton>
          {folders.map((folder) => (
            <div key={folder.id} className="flex items-center gap-1">
              <FolderFilterButton
                active={selectedFolder === folder.id}
                onClick={() => setSelectedFolder(folder.id)}
              >
                {folder.name} ({folder.flow_count})
              </FolderFilterButton>
              {canCreate && (
                <>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={t('renameFolder')}
                    title={t('renameFolder')}
                    onClick={() => {
                      setFolderName(folder.name);
                      setFolderDialog({ mode: 'rename', folder });
                    }}
                  >
                    <Pencil className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7 text-red-400"
                    aria-label={t('deleteFolder')}
                    title={t('deleteFolder')}
                    onClick={() => deleteFolder(folder)}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>
      </section>

      {flows.length === 0 ? (
        <EmptyState
          onCreate={() => setCreateOpen(true)}
          canCreate={canCreate}
          t={t}
        />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div className="grid w-full gap-3 sm:grid-cols-3 lg:max-w-3xl">
              <div className="sm:col-span-3 lg:col-span-1">
                <label
                  htmlFor="flow-search"
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  {t('searchLabel')}
                </label>
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
                  <Input
                    id="flow-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t('searchPlaceholder')}
                    className="bg-card pr-8 pl-8"
                  />
                  {search && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute top-1/2 right-1 size-7 -translate-y-1/2"
                      onClick={() => setSearch('')}
                      aria-label={t('clearSearch')}
                      title={t('clearSearch')}
                    >
                      <X className="size-4" />
                    </Button>
                  )}
                </div>
              </div>

              <div>
                <label
                  htmlFor="flow-status-filter"
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  {t('filterByStatus')}
                </label>
                <Select
                  value={statusFilter}
                  onValueChange={(value) =>
                    setStatusFilter(value as FlowStatusFilter)
                  }
                >
                  <SelectTrigger
                    id="flow-status-filter"
                    className="bg-card w-full"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('filterAll')}</SelectItem>
                    <SelectItem value="active">{t('statusActive')}</SelectItem>
                    <SelectItem value="draft">{t('statusDraft')}</SelectItem>
                    <SelectItem value="archived">
                      {t('statusArchived')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label
                  htmlFor="flow-sort"
                  className="text-muted-foreground mb-1 block text-xs"
                >
                  {t('sortBy')}
                </label>
                <Select
                  value={sort}
                  onValueChange={(value) => setSort(value as FlowSort)}
                >
                  <SelectTrigger id="flow-sort" className="bg-card w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">{t('sortNewest')}</SelectItem>
                    <SelectItem value="most-used">
                      {t('sortMostUsed')}
                    </SelectItem>
                    <SelectItem value="least-used">
                      {t('sortLeastUsed')}
                    </SelectItem>
                    <SelectItem value="last-executed">
                      {t('sortLastExecuted')}
                    </SelectItem>
                    <SelectItem value="last-modified">
                      {t('sortLastModified')}
                    </SelectItem>
                    <SelectItem value="name-asc">{t('sortNameAsc')}</SelectItem>
                    <SelectItem value="name-desc">
                      {t('sortNameDesc')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <p
              className="text-muted-foreground shrink-0 text-xs"
              aria-live="polite"
            >
              {t('showingCount', {
                shown: listedFlows.length,
                total: folderFlows.length,
              })}
            </p>
          </div>

          {listedFlows.length === 0 ? (
            <div className="border-border bg-card/50 rounded-lg border border-dashed px-6 py-12 text-center">
              <p className="text-muted-foreground text-sm">{t('noResults')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {listedFlows.map((flow) => (
                <FlowCard
                  key={flow.id}
                  flow={flow}
                  canAct={canCreate}
                  onEdit={() => router.push(`/flows/${flow.id}`)}
                  onDelete={() => handleDelete(flow)}
                  onMove={() => {
                    setMoveTarget(flow.folder_id ?? 'unfiled');
                    setMoveFlow(flow);
                  }}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-4xl` not `max-w-4xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('createDesc')}
            </DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-3">
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {t('startTemplate')}
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="border-border bg-background hover:border-primary/40 hover:bg-muted flex flex-col gap-2.5 rounded-lg border p-4 text-left transition-colors disabled:opacity-50"
                    >
                      <Icon className="text-primary h-5 w-5" />
                      <span className="text-popover-foreground text-sm font-semibold">
                        {template.name}
                      </span>
                      <span className="text-muted-foreground text-xs leading-relaxed">
                        {template.description}
                      </span>
                      <span className="border-border text-muted-foreground mt-auto border-t pt-2 text-[11px]">
                        {t('nodeCount', { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border-border space-y-2 border-t pt-4">
            <p className="text-muted-foreground text-xs tracking-wide uppercase">
              {t('startBlank')}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('placeholderName')}
              className="bg-muted"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName.trim() || creating}
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('createBlank')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(folderDialog)}
        onOpenChange={(open) => !open && setFolderDialog(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === 'rename'
                ? t('renameFolder')
                : t('createFolder')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="flow-folder-name" className="text-sm font-medium">
              {t('folderName')}
            </label>
            <Input
              id="flow-folder-name"
              value={folderName}
              maxLength={80}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder={t('folderNamePlaceholder')}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveFolder();
              }}
            />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setFolderDialog(null)}
              disabled={savingFolder}
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={saveFolder}
              disabled={!folderName.trim() || savingFolder}
            >
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(moveFlow)}
        onOpenChange={(open) => !open && setMoveFlow(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('moveFlow')}</DialogTitle>
            <DialogDescription>{t('moveFlowDescription')}</DialogDescription>
          </DialogHeader>
          <Select
            value={moveTarget}
            onValueChange={(value) => setMoveTarget(value ?? 'unfiled')}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unfiled">{t('unfiled')}</SelectItem>
              {folders.map((folder) => (
                <SelectItem key={folder.id} value={folder.id}>
                  {folder.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setMoveFlow(null)}
              disabled={moving}
            >
              {t('cancel')}
            </Button>
            <Button onClick={saveMove} disabled={moving}>
              {t('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FolderFilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={active ? 'secondary' : 'ghost'}
      size="sm"
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function EmptyState({
  onCreate,
  canCreate,
  t,
}: {
  onCreate: () => void;
  canCreate: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <div className="border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center">
      <div className="bg-muted flex h-14 w-14 items-center justify-center rounded-full">
        <Workflow className="text-muted-foreground h-6 w-6" />
      </div>
      <h2 className="text-foreground mt-4 text-base font-medium">
        {t('emptyTitle')}
      </h2>
      <p className="text-muted-foreground mt-1 max-w-md text-sm">
        {t('emptyDesc')}
      </p>
      <GatedButton
        canAct={canCreate}
        gateReason="create flows"
        onClick={onCreate}
        className="mt-5"
      >
        <Plus className="h-4 w-4" />
        {t('createFirst')}
      </GatedButton>
    </div>
  );
}

function FlowCard({
  flow,
  canAct,
  onEdit,
  onDelete,
  onMove,
  t,
}: {
  flow: FlowRow;
  canAct: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMove: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const triggerSummary = describeTrigger(flow, t);
  const StatusIcon =
    flow.status === 'active'
      ? PlayCircle
      : flow.status === 'archived'
        ? Archive
        : PauseCircle;
  return (
    <div className="border-border bg-card hover:border-border flex flex-col rounded-lg border p-4 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="text-primary h-4 w-4 shrink-0" />
          <h3 className="text-foreground truncate text-sm font-semibold">
            {flow.name}
          </h3>
        </div>
        <Badge
          variant="outline"
          className={cn(
            'shrink-0 gap-1 text-[10px]',
            STATUS_COLORS[flow.status]
          )}
        >
          <StatusIcon className="h-3 w-3" />
          {STATUS_LABELS(t)[flow.status]}
        </Badge>
      </div>

      <p className="text-muted-foreground mt-2 line-clamp-2 text-xs">
        {flow.description || triggerSummary}
      </p>

      <div className="text-muted-foreground mt-4 flex items-center gap-3 text-[11px]">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {t('runCount', { count: flow.execution_count })}
        </span>
      </div>

      {canAct && (
        <div className="border-border mt-4 flex items-center justify-end gap-2 border-t pt-3">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            {t('edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onMove}>
            <Folder className="h-3.5 w-3.5" />
            {t('moveTo')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        </div>
      )}
    </div>
  );
}

function describeTrigger(
  flow: FlowRow,
  t: ReturnType<typeof useTranslations>
): string {
  if (flow.trigger_type === 'keyword') {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t('triggerKeywordNone');
    return t('triggerKeyword', { keywords: keywords.join(', ') });
  }
  if (flow.trigger_type === 'first_inbound_message') {
    return t('triggerFirstInbound');
  }
  return t('triggerManual');
}
