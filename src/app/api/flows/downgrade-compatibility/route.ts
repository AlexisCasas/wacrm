import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isCustomConditionEnabledForAccount } from '@/lib/flows/custom-condition-capability';
import { inspectDowngradeCompatibility } from '@/lib/flows/downgrade-compatibility';

// Keep every query comfortably below PostgREST/Supabase's default maximum
// response size.  A rollback approval is a safety decision: if a count or a
// page cannot be verified, the caller must not receive SAFE_TO_ROLLBACK.
const PAGE_SIZE = 200;
const FLOW_ID_BATCH_SIZE = 100;

type Page<T> = {
  data: T[] | null;
  error: unknown;
  count: number | null;
};

async function collectCompletePages<T>(
  getPage: (from: number, to: number) => PromiseLike<Page<T>>
): Promise<T[] | null> {
  const all: T[] = [];
  let expectedCount: number | null = null;

  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await getPage(from, from + PAGE_SIZE - 1);
    if (page.error || page.count === null || page.count < 0) return null;

    // `count: "exact"` is deliberately requested on every page. It detects
    // both a truncated response and rows changing while this safety check runs.
    if (expectedCount === null) expectedCount = page.count;
    if (page.count !== expectedCount) return null;

    const rows = page.data ?? [];
    all.push(...rows);
    if (all.length > expectedCount) return null;
    if (all.length === expectedCount) return all;

    // A short (or empty) page before the exact total is reached is incomplete.
    if (rows.length !== PAGE_SIZE) return null;
  }
}

function inBatches<T>(items: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    batches.push(items.slice(start, start + size));
  }
  return batches;
}

/**
 * Read-only, account-scoped pre-downgrade inspection. It intentionally
 * returns ids and counts only; it never returns node configuration, values,
 * variables, contacts, or changes any flow/run state.
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const flows = await collectCompletePages<{ id: string; status: string }>(
      (from, to) =>
        ctx.supabase
          .from('flows')
          .select('id, status', { count: 'exact' })
          .eq('account_id', ctx.accountId)
          .order('id', { ascending: true })
          .range(from, to)
    );
    if (!flows)
      return NextResponse.json(
        { error: 'Could not inspect downgrade compatibility' },
        { status: 503 }
      );

    const flowIds = flows.map((flow) => flow.id);
    const nodes: Array<{
      flow_id: string;
      node_type: string;
      config: Record<string, unknown>;
    }> = [];
    for (const ids of inBatches(flowIds, FLOW_ID_BATCH_SIZE)) {
      const batch = await collectCompletePages<{
        flow_id: string;
        node_type: string;
        config: Record<string, unknown>;
      }>((from, to) =>
        ctx.supabase
          .from('flow_nodes')
          .select('flow_id, node_type, config', { count: 'exact' })
          .in('flow_id', ids)
          .order('id', { ascending: true })
          .range(from, to)
      );
      if (!batch)
        return NextResponse.json(
          { error: 'Could not inspect downgrade compatibility' },
          { status: 503 }
        );
      nodes.push(...batch);
    }

    const customFlowIds = [
      ...new Set(
        nodes
          .filter(
            (node) =>
              node.node_type === 'condition' &&
              node.config.subject === 'contact_field' &&
              typeof node.config.subject_key === 'string' &&
              node.config.subject_key.startsWith('custom:')
          )
          .map((node) => node.flow_id)
      ),
    ];
    const runs: Array<{ flow_id: string; status: string }> = [];
    // Historical, completed runs cannot make an E1 rollback operationally
    // unsafe. Limit the scan to active runs of flows already found incompatible.
    for (const ids of inBatches(customFlowIds, FLOW_ID_BATCH_SIZE)) {
      const batch = await collectCompletePages<{
        flow_id: string;
        status: string;
      }>((from, to) =>
        ctx.supabase
          .from('flow_runs')
          .select('flow_id, status', { count: 'exact' })
          .in('flow_id', ids)
          .eq('status', 'active')
          .order('id', { ascending: true })
          .range(from, to)
      );
      if (!batch)
        return NextResponse.json(
          { error: 'Could not inspect downgrade compatibility' },
          { status: 503 }
        );
      runs.push(...batch);
    }

    return NextResponse.json({
      customConditionsEnabled: isCustomConditionEnabledForAccount(
        ctx.accountId
      ),
      ...inspectDowngradeCompatibility({ flows, nodes, runs }),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
