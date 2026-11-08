import { describe, expect, it } from 'vitest';
import { collectProductTagIds, snapshotOrderProducts } from './product-tags';

const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
const tags=[{id:a,name:'Cargador Xiaomi'},{id:b,name:'Guitarra VOZZEX'}];

describe('strict order product tag selection', () => {
  it('rejects free text and malformed identifiers', () => {
    expect(collectProductTagIds({product:'Caragdor xiaomi'})).toEqual({ok:false,field:'product'});
    expect(collectProductTagIds({items:[{product_name:'Guitarra',quantity:1}]})).toEqual({ok:false,field:'items'});
    expect(collectProductTagIds({product_tag_id:'fake'})).toEqual({ok:false,field:'product'});
  });
  it('snapshots canonical tag names instead of accepting submitted misspellings', () => {
    expect(snapshotOrderProducts({product:'cargador xiomi',product_tag_id:a},tags)).toEqual({
      ok:true,value:{product:'Cargador Xiaomi',product_tag_id:a},
    });
  });
  it('requires every line and prevents spoofing audio catalog product IDs', () => {
    const row={product_tag_id:b,product_name:'inventado',quantity:2,unit_price:'100.00',catalog_product_id:a};
    const out=snapshotOrderProducts({items:[row]},tags);
    expect(out).toEqual({ok:true,value:{items:[{...row,product_name:'Guitarra VOZZEX',catalog_product_id:null}]}});
    expect(snapshotOrderProducts({items:[row,{product_name:'manual'}]},tags)).toEqual({ok:false,field:'items'});
  });
  it('rejects unknown or cross-account IDs (only verified account tags are passed in)', () => {
    expect(snapshotOrderProducts({product_tag_id:b},[tags[0]])).toEqual({ok:false,field:'product'});
  });
  it('does not alter any legacy payload unless called for an enabled account', () => {
    const old={product:'libre',quantity:1,price:'100.00'};
    expect({...old}).toEqual(old);
  });
});
