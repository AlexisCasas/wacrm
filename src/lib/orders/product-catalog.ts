// Strict product selection uses the existing "Audios por producto" catalogue
// (audio_guide_products). This catalogue is account-scoped and independent of
// the actual audio files or the contact tags. Prices and order notes stay free.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrderCatalogProduct {
  id: string;
  display_name: string;
  active: boolean;
}

export type CatalogSelection =
  | { ok: true; ids: string[]; field: 'product' | 'items' }
  | { ok: false; field: 'product' | 'items' };

/** Require an actual catalog UUID for every product, including single orders. */
export function collectCatalogProductIds(body: Record<string, unknown>): CatalogSelection {
  const multi = Object.prototype.hasOwnProperty.call(body, 'items');
  const field = multi ? 'items' : 'product';
  const lines = multi ? body.items : [body];
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 20) return { ok: false, field };
  const ids: string[] = [];
  for (const line of lines) {
    if (!line || typeof line !== 'object' || Array.isArray(line)) return { ok: false, field };
    const id = (line as Record<string, unknown>).catalog_product_id;
    if (typeof id !== 'string' || !UUID.test(id)) return { ok: false, field };
    ids.push(id.toLowerCase());
  }
  return { ok: true, ids: [...new Set(ids)], field };
}

/** Trust only account-scoped *active* products queried by the authenticated API.
 * Names from the browser are never authoritative and cannot introduce new
 * catalog entries. A name is snapshotted at confirmation time. */
export function snapshotCatalogProducts(
  body: Record<string, unknown>,
  products: readonly OrderCatalogProduct[],
): { ok: true; value: Record<string, unknown> } | { ok: false; field: 'product' | 'items' } {
  const selection = collectCatalogProductIds(body);
  if (!selection.ok) return selection;

  const byId = new Map(products
    .filter((product) => product.active === true && product.display_name.trim())
    .map((product) => [product.id.toLowerCase(), product.display_name.trim()]));
  if (selection.ids.some((id) => !byId.get(id))) return { ok: false, field: selection.field };

  if (selection.field === 'product') {
    const id = (body.catalog_product_id as string).toLowerCase();
    return { ok: true, value: { ...body, catalog_product_id: id, product: byId.get(id) } };
  }

  const items = (body.items as Record<string, unknown>[]).map((item) => {
    const id = (item.catalog_product_id as string).toLowerCase();
    return { ...item, catalog_product_id: id, product_name: byId.get(id) };
  });
  return { ok: true, value: { ...body, items } };
}
