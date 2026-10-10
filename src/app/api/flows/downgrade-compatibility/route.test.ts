import { beforeEach, describe, expect, it, vi } from 'vitest';

const ACCOUNT = 'account-a';
const OTHER_ACCOUNT = 'account-b';

type Flow = { id: string; status: string; account_id: string };
type Node = {
  id: string;
  flow_id: string;
  node_type: string;
  config: Record<string, unknown>;
};
type Run = { id: string; flow_id: string; status: string };

let flows: Flow[] = [];
let nodes: Node[] = [];
let runs: Run[] = [];
let failPage: { table: string; from: number } | null = null;
let incompletePage: { table: string; from: number } | null = null;
const queries: Array<{
  table: string;
  accountId?: string;
  ids?: string[];
  status?: string;
  orderedBy?: string;
}> = [];

function createSupabaseMock() {
  return {
    from(table: string) {
      const query: {
        accountId?: string;
        ids?: string[];
        status?: string;
        orderedBy?: string;
      } = {};
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((column: string, value: string) => {
          if (column === 'account_id') query.accountId = value;
          if (column === 'status') query.status = value;
          return builder;
        }),
        in: vi.fn((_column: string, ids: string[]) => {
          query.ids = ids;
          return builder;
        }),
        order: vi.fn((column: string) => {
          query.orderedBy = column;
          return builder;
        }),
        range: vi.fn(async (from: number, to: number) => {
          queries.push({ table, ...query });
          if (failPage?.table === table && failPage.from === from) {
            return {
              data: null,
              error: { message: 'page failed' },
              count: null,
            };
          }

          let source: Array<Flow | Node | Run>;
          if (table === 'flows')
            source = flows.filter(
              (flow) => flow.account_id === query.accountId
            );
          else if (table === 'flow_nodes')
            source = nodes.filter((node) => query.ids?.includes(node.flow_id));
          else
            source = runs.filter(
              (run) =>
                query.ids?.includes(run.flow_id) && run.status === query.status
            );
          const ordered = [...source].sort((a, b) => a.id.localeCompare(b.id));
          const data = ordered.slice(from, to + 1);
          const count =
            incompletePage?.table === table && incompletePage.from === from
              ? ordered.length + 1
              : ordered.length;
          return { data, error: null, count };
        }),
      };
      return builder;
    },
  };
}

let supabase = createSupabaseMock();

vi.mock('@/lib/auth/account', () => ({
  requireRole: vi.fn(async () => ({ accountId: ACCOUNT, supabase })),
  toErrorResponse: vi.fn(() => new Response('unexpected', { status: 500 })),
}));
vi.mock('@/lib/flows/custom-condition-capability', () => ({
  isCustomConditionEnabledForAccount: vi.fn(() => false),
}));

import { GET } from './route';

const id = (prefix: string, index: number) =>
  `${prefix}-${String(index).padStart(5, '0')}`;
const condition = (flow_id: string, index: number): Node => ({
  id: id('node', index),
  flow_id,
  node_type: 'condition',
  config: { subject: 'contact_field', subject_key: 'custom:field' },
});

beforeEach(() => {
  flows = [];
  nodes = [];
  runs = [];
  failPage = null;
  incompletePage = null;
  queries.length = 0;
  supabase = createSupabaseMock();
});

describe('GET /api/flows/downgrade-compatibility', () => {
  it('paginates more than 1000 nodes and finds a custom condition after the first page', async () => {
    flows = [{ id: 'flow-1', status: 'active', account_id: ACCOUNT }];
    nodes = Array.from({ length: 1001 }, (_, index) => ({
      id: id('node', index),
      flow_id: 'flow-1',
      node_type: 'send_message',
      config: {},
    }));
    nodes[1000] = condition('flow-1', 1000);

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBe('BLOCKED_BY_CUSTOM_CONDITIONS');
    expect(
      queries.filter((query) => query.table === 'flow_nodes')
    ).toHaveLength(6);
  });

  it('paginates all flows with deterministic id ordering', async () => {
    flows = Array.from({ length: 1001 }, (_, index) => ({
      id: id('flow', index),
      status: 'draft',
      account_id: ACCOUNT,
    }));

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBe('SAFE_TO_ROLLBACK');
    const flowQueries = queries.filter((query) => query.table === 'flows');
    expect(flowQueries).toHaveLength(6);
    expect(
      flowQueries.every(
        (query) => query.orderedBy === 'id' && query.accountId === ACCOUNT
      )
    ).toBe(true);
  });

  it('paginates more than 1000 active runs for a custom-condition flow', async () => {
    flows = [{ id: 'flow-1', status: 'active', account_id: ACCOUNT }];
    nodes = [condition('flow-1', 1)];
    runs = Array.from({ length: 1001 }, (_, index) => ({
      id: id('run', index),
      flow_id: 'flow-1',
      status: 'active',
    }));

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.active_run_flow_ids).toEqual(['flow-1']);
    expect(queries.filter((query) => query.table === 'flow_runs')).toHaveLength(
      6
    );
    expect(
      queries
        .filter((query) => query.table === 'flow_runs')
        .every((query) => query.status === 'active' && query.orderedBy === 'id')
    ).toBe(true);
  });

  it('rejects an intermediate page error instead of declaring rollback safe', async () => {
    flows = [{ id: 'flow-1', status: 'draft', account_id: ACCOUNT }];
    nodes = Array.from({ length: 201 }, (_, index) => ({
      id: id('node', index),
      flow_id: 'flow-1',
      node_type: 'send_message',
      config: {},
    }));
    failPage = { table: 'flow_nodes', from: 200 };

    const response = await GET();
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe(
      'Could not inspect downgrade compatibility'
    );
  });

  it('rejects a page whose exact count proves the response is incomplete', async () => {
    flows = [{ id: 'flow-1', status: 'draft', account_id: ACCOUNT }];
    nodes = Array.from({ length: 201 }, (_, index) => ({
      id: id('node', index),
      flow_id: 'flow-1',
      node_type: 'send_message',
      config: {},
    }));
    incompletePage = { table: 'flow_nodes', from: 200 };

    const response = await GET();
    expect(response.status).toBe(503);
  });

  it('reports safe only after a complete account-scoped inspection without custom conditions', async () => {
    flows = [{ id: 'flow-1', status: 'active', account_id: ACCOUNT }];
    nodes = [
      {
        id: 'node-1',
        flow_id: 'flow-1',
        node_type: 'condition',
        config: { subject: 'contact_field', subject_key: 'standard' },
      },
    ];

    const response = await GET();
    expect(response.status).toBe(200);
    expect((await response.json()).result).toBe('SAFE_TO_ROLLBACK');
  });

  it('blocks a complete inspection with a custom condition and its active run', async () => {
    flows = [{ id: 'flow-1', status: 'active', account_id: ACCOUNT }];
    nodes = [condition('flow-1', 1)];
    runs = [{ id: 'run-1', flow_id: 'flow-1', status: 'active' }];

    const response = await GET();
    const body = await response.json();
    expect(body.result).toBe('BLOCKED_BY_CUSTOM_CONDITIONS');
    expect(body.active_run_flow_ids).toEqual(['flow-1']);
  });

  it("never includes another account's flows in the inspection", async () => {
    flows = [
      { id: 'flow-ours', status: 'draft', account_id: ACCOUNT },
      { id: 'flow-other', status: 'active', account_id: OTHER_ACCOUNT },
    ];
    nodes = [condition('flow-other', 1)];

    const response = await GET();
    const body = await response.json();
    expect(body.result).toBe('SAFE_TO_ROLLBACK');
    expect(queries.find((query) => query.table === 'flows')?.accountId).toBe(
      ACCOUNT
    );
    expect(
      queries
        .filter((query) => query.table === 'flow_nodes')
        .flatMap((query) => query.ids ?? [])
    ).not.toContain('flow-other');
  });
});
