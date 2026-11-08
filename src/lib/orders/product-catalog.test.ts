import { describe, expect, it } from 'vitest';
import { collectCatalogProductIds, snapshotCatalogProducts } from './product-catalog';

const a='11111111-1111-4111-8111-111111111111';
const b='22222222-2222-4222-8222-222222222222';
const products=[
  {id:a,display_name:'Adaptador para Sierra para taladro',active:true},
  {id:b,display_name:'Amoladora 710W',active:true},
];

describe('strict orders use the existing audio-guide product catalogue', () => {
  it('rejects free-text and malformed or tag-only identifiers', () => {
    expect(collectCatalogProductIds({product:'Adaptador sierra'})).toEqual({ok:false,field:'product'});
    expect(collectCatalogProductIds({items:[{product_name:'Amoladora'}]})).toEqual({ok:false,field:'items'});
    expect(collectCatalogProductIds({product_tag_id:a})).toEqual({ok:false,field:'product'});
    expect(collectCatalogProductIds({catalog_product_id:'invalid'})).toEqual({ok:false,field:'product'});
  });
  it('uses canonical names even if submitted product text is invented', () => {
    const value={catalog_product_id:a,product:'producto falso'};
    expect(snapshotCatalogProducts(value,products)).toEqual({ok:true,value:{
      catalog_product_id:a,product:'Adaptador para Sierra para taladro',
    }});
  });
  it('requires each multiproduct line and keeps actual audio-guide IDs', () => {
    const item={catalog_product_id:b,product_name:'inventado',quantity:2,unit_price:'100.00'};
    expect(snapshotCatalogProducts({items:[item]},products)).toEqual({
      ok:true,value:{items:[{...item,product_name:'Amoladora 710W'}]},
    });
    expect(snapshotCatalogProducts({items:[item,{product_name:'manual'}]},products))
      .toEqual({ok:false,field:'items'});
  });
  it('refuses inactive, missing and other-account IDs', () => {
    expect(snapshotCatalogProducts({catalog_product_id:b},[products[0]]))
      .toEqual({ok:false,field:'product'});
    expect(snapshotCatalogProducts({catalog_product_id:a},[{...products[0],active:false}]))
      .toEqual({ok:false,field:'product'});
  });
  it('does not modify the old payload unless the strict feature is enabled', () => {
    const legacy={product:'libre',quantity:1,price:'100.00'};
    expect({...legacy}).toEqual(legacy);
  });
});
