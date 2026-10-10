// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import FlowsPage from './page';

const messages: Record<string, string> = {
  title: 'Flows',
  beta: 'Beta',
  description: 'Description',
  newFlow: 'New flow',
  searchLabel: 'Search flows',
  searchPlaceholder: 'Search flow by name...',
  clearSearch: 'Clear search',
  filterByStatus: 'Filter by status',
  filterAll: 'All',
  sortBy: 'Sort by',
  sortNewest: 'Most recent',
  sortMostUsed: 'Most used',
  sortLeastUsed: 'Least used',
  sortLastExecuted: 'Last execution',
  sortLastModified: 'Last modified',
  sortNameAsc: 'Name A-Z',
  sortNameDesc: 'Name Z-A',
  showingCount: 'Showing {shown} of {total} flows',
  noResults: 'No flows found with these criteria.',
  statusDraft: 'Draft',
  statusActive: 'Active',
  statusArchived: 'Archived',
  edit: 'Edit',
  delete: 'Delete',
  runCount: '{count} runs',
  triggerKeyword: 'Triggers on: {keywords}',
  triggerKeywordNone: 'Triggers on keyword',
  triggerFirstInbound: 'Triggers on first inbound',
  triggerManual: 'Manual trigger',
  folders: 'Folders',
  allFolders: 'All flows',
  unfiled: 'Unfiled',
  newFolder: 'New folder',
  renameFolder: 'Rename folder',
  deleteFolder: 'Delete folder',
  moveTo: 'Move to…',
};

const routerPush = vi.fn();
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const canAct = vi.hoisted(() => ({ value: true }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    let value = messages[key] ?? key;
    for (const [name, replacement] of Object.entries(params ?? {})) {
      value = value.replace(`{${name}}`, String(replacement));
    }
    return value;
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => canAct.value }));
vi.mock('sonner', () => ({ toast: toastMock }));

const flows = [
  {
    id: 'active-drill',
    name: 'Taladro activo',
    description: null,
    status: 'active',
    trigger_type: 'keyword',
    trigger_config: { keywords: ['taladro'] },
    execution_count: 3,
    last_executed_at: null,
    created_at: '2026-10-02T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
  },
  {
    id: 'draft-menu',
    name: 'Menú de bienvenida',
    description: null,
    status: 'draft',
    trigger_type: 'manual',
    trigger_config: {},
    execution_count: 0,
    last_executed_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  canAct.value = true;
  routerPush.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/flows')
        return { ok: true, json: async () => ({ flows }) } as Response;
      return { ok: true, json: async () => ({ templates: [] }) } as Response;
    })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FlowsPage E1 controls', () => {
  it('filters immediately and preserves edit, delete, and create actions', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<FlowsPage />);

    await screen.findByText('Taladro activo');
    expect(screen.getByText('Showing 2 of 2 flows')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New flow' })).toBeEnabled();

    fireEvent.change(screen.getByPlaceholderText('Search flow by name...'), {
      target: { value: 'TALADRO' },
    });

    expect(screen.getByText('Taladro activo')).toBeInTheDocument();
    expect(screen.queryByText('Menú de bienvenida')).not.toBeInTheDocument();
    expect(screen.getByText('Showing 1 of 2 flows')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(routerPush).toHaveBeenCalledWith('/flows/active-drill');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('Menú de bienvenida')).toBeInTheDocument();
  });
});

describe('FlowsPage E3 folder permissions', () => {
  it('does not expose folder or flow write actions to a viewer', async () => {
    canAct.value = false;
    render(<FlowsPage />);

    await screen.findByText('Taladro activo');
    expect(screen.getByRole('button', { name: 'New folder' })).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Move to…' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Delete' })
    ).not.toBeInTheDocument();
  });
});
