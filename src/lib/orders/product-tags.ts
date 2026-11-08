// Strict commercial product selection for manual order confirmation.
// The caller supplies tag IDs, never trusted product names. Names are
// snapshotted from account-scoped, admin-curated tags by the API.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommercialTag { id: string; name: string }

export type ProductTagSelection =
  | { ok: true; ids: string[]; field: 'product' | 'items' }
  | { ok: false; field: 'product' | 'items' };

export function collectProductTagIds(body: Record<string, unknown>): ProductTagSelection {
  const multi = Object.prototype.hasOwnProperty.call(body, 'items');
  const field = multi ? 'items' : 'product';
  const lines = multi ? body.items : [body];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 20) return { ok: false, field };
  const ids: string[] = [];
  for (const item of lines) {
    if (typeof item !== 'object' || !item || Array.isArray(item)) return { ok: false, field };
    const id = (item as Record<string, unknown>).product_tag_id;
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, field };
    ids.push(id.toLowerCase());
  }
  return { ok: true, ids: [...new Set(ids)], field };
}

export function snapshotOrderProducts(
  body: Record<string, unknown>,
  tags: readonly CommercialTag[],
): { ok: true; value: Record<string, unknown> } | { ok: false; field: 'product' | 'items' } {
  const selection = collectProductTagIds(body);
  if (!selection.ok) return selection;
  const tagById = new Map(tags.map((tag) => [tag.id.toLowerCase(), tag.name.trim()]));
  if (selection.ids.some((id) => !tagById.get(id))) return { ok: false, field: selection.field };
  if (selection.field === 'product') {
    const id = (body.product_tag_id as string).toLowerCase();
    return { ok: true, value: { ...body, product: tagById.get(id) } };
  }
  const items = (body.items as Record<string, unknown>[]).map((item) => ({
    ...item,
    product_name: tagById.get((item.product_tag_id as string).toLowerCase()),
    // Audio-guide IDs belong to another catalogue; never confuse them with tag IDs.
    catalog_product_id: null,
  }));
  return { ok: true, value: { ...body, items } };
}
