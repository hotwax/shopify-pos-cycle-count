import {OmsConnection, OmsLookupError, rows, text, type OmsRow} from './oms-connection';

/** `shopId` is the HotWax ShopifyShop ID, used to read this shop's variant mapping. */
export type ProductPreferences = {barcode: string; primary: string; secondary: string; shopId?: string};
export const COUNTABLE_FILTERS = ['docType:PRODUCT','isVirtual:false','productTypeId:FINISHED_GOOD','-prodCatalogCategoryTypeIds:PCCT_DISCONTINUED'];
const fields = 'productId,productName,title,internalName,goodIdentifications,sku,upc,groupName,groupId,parentProductName,mainImageUrl,smallImageUrl,mediumImageUrl,primaryProductCategoryName';
const phrase = (value: string) => JSON.stringify(value);
const escapeTerm = (value: string) => value.replace(/([+\-!(){}\[\]^"~*?:\\/|&])/g,'\\$1');

export async function countingPreferences(store: string, oms: OmsConnection): Promise<ProductPreferences> {
  if (!store) throw new OmsLookupError('The POS facility needs an OMS product store to load its counting preferences.');
  const values=rows(await oms.get(`/rest/s1/admin/productStores/${encodeURIComponent(store)}/settings?${new URLSearchParams({settingTypeEnumId:'BARCODE_IDEN_PREF,PRDT_IDEN_PREF',settingTypeEnumId_op:'in',pageSize:'10'})}`));
  const barcode=text(values.find(r=>r.settingTypeEnumId==='BARCODE_IDEN_PREF')?.settingValue);
  let display: OmsRow = {};
  const raw=values.find(r=>r.settingTypeEnumId==='PRDT_IDEN_PREF')?.settingValue;
  if(raw)try{display=JSON.parse(text(raw));}catch{throw new OmsLookupError('The OMS product identifier preference is invalid.');}
  return {barcode,primary:text(display.primaryId)||'SKU',secondary:text(display.secondaryId)||'productId'};
}

export function identifications(product: OmsRow) {
  return (Array.isArray(product.goodIdentifications)?product.goodIdentifications:[]).map(value=>{
    if(typeof value==='string'){const at=value.indexOf('/');return {type:value.slice(0,at),value:value.slice(at+1)};}
    const row=value as OmsRow;return {type:text(row.goodIdentificationTypeId||row.type),value:text(row.idValue||row.value)};
  });
}
/** The Shopify variant HotWax maps this product to for the shop. Search
 * documents carry `ShopifyShopProduct/<shopId>/<shopifyProductId>`; only an
 * unambiguous mapping is returned. */
export function shopifyVariantOf(ids: {type:string;value:string}[], shopId?: string) {
  if(!shopId)return undefined;
  const found=[...new Set(ids.filter(i=>i.type==='ShopifyShopProduct'&&i.value.startsWith(`${shopId}/`)).map(i=>i.value.slice(shopId.length+1)))];
  const variant=Number(found[0]);
  return found.length===1&&Number.isSafeInteger(variant)&&variant>0?variant:undefined;
}
export function presentProduct(product: OmsRow, prefs: ProductPreferences) {
  const ids=identifications(product),id=text(product.productId),shopifyVariantId=shopifyVariantOf(ids,prefs.shopId);
  const resolve=(key: string)=>['SKU','SHOPIFY_PROD_SKU'].includes(key)?text(ids.find(i=>i.type==='SKU')?.value):
    ['parentProductName','groupName'].includes(key)?text(product.parentProductName||product.groupName):
    ['productId','internalName','title','primaryProductCategoryName'].includes(key)?text(product[key]):text(ids.find(i=>i.type===key)?.value);
  return {productId:id,title:text(product.productName||product.title||product.internalName||id),
    sku:text(ids.find(i=>i.type==='SKU')?.value||product.internalName||id),
    primary:resolve(prefs.primary)||resolve('SKU')||id,secondary:resolve(prefs.secondary)||id,
    imageUrl:text(product.smallImageUrl||product.mediumImageUrl||product.mainImageUrl),
    codes:ids.filter(i=>i.type===prefs.barcode).map(i=>i.value),...(shopifyVariantId?{shopifyVariantId}:{})};
}
async function search(oms: OmsConnection, query: OmsRow) {
  const result=await oms.postRead('/rest/s1/admin/search/query',{collection:'enterpriseSearch',...query});
  const outer=result.response as OmsRow|undefined;
  const response=(outer?.response||outer) as OmsRow|undefined;
  if(!response || !Array.isArray(response.docs) || !Number.isFinite(Number(response.numFound)))throw new OmsLookupError('OMS product search returned an incomplete result.');
  return {docs:rows(response.docs),total:Number(response.numFound),facets:(outer?.facets||result.facets) as OmsRow|undefined};
}
export async function catalogPage(payload: OmsRow, prefs: ProductPreferences, oms: OmsConnection) {
  const keyword=text(payload.search).trim().slice(0,150),page=Number(payload.pageIndex||0);
  if(!Number.isSafeInteger(page)||page<0||page>10000)throw new OmsLookupError('Invalid product page.',400);
  const tags=Array.isArray(payload.tags)?payload.tags.map(text):[];
  if(tags.length>50||tags.some(t=>!t||t.length>255))throw new OmsLookupError('Choose valid product tags.',400);
  const filter=[...COUNTABLE_FILTERS,...(payload.scope?['isVariant:true']:[]),...(tags.length?[`tags:(${tags.map(phrase).join(' OR ')})`]:[])];
  const query=keyword?keyword.split(/\s+/).map(t=>`*${escapeTerm(t)}*`).join(' AND '):'*:*';
  const result=await search(oms,{query,filter,fields,params:{rows:40,start:page*40,defType:'edismax',qf:'sku^100 upc^100 productName^50 internalName^40 productId groupName',sort:'productId asc'},
    ...(payload.facets?{facet:{tags:{type:'terms',field:'tags',limit:1000}}}:{})});
  const facets=result.facets?.tags as OmsRow|undefined;
  return {items:result.docs.map(p=>presentProduct(p,prefs)),total:result.total,pageIndex:page,nextPage:(page+1)*40<result.total?page+1:null,
    tags:rows(facets?.buckets).map(b=>({value:text(b.val),count:Number(b.count)}))};
}
export async function countableProducts(ids: string[], prefs: ProductPreferences, oms: OmsConnection, scope=false) {
  const result=new Map<string,ReturnType<typeof presentProduct>>();
  for(let offset=0;offset<ids.length;offset+=200){
    const batch=ids.slice(offset,offset+200);
    const found=await search(oms,{query:'*:*',filter:[...COUNTABLE_FILTERS,...(scope?['isVariant:true']:[]),`productId:(${batch.map(phrase).join(' OR ')})`],fields,params:{rows:batch.length}});
    for(const row of found.docs)result.set(text(row.productId),presentProduct(row,prefs));
  }
  if(ids.some(id=>!result.has(id)))throw new OmsLookupError('A selected OMS product is unavailable, discontinued, virtual or not countable. Refresh the product list.',409);
  return result;
}
export async function productSearchDetails(ids: string[], prefs: ProductPreferences, oms: OmsConnection) {
  const found=await search(oms,{query:'*:*',filter:['docType:PRODUCT',`productId:(${ids.map(phrase).join(' OR ')})`],fields,params:{rows:ids.length}});
  return new Map(found.docs.map(p=>[text(p.productId),presentProduct(p,prefs)]));
}
export async function matchCodes(codes: string[], prefs: ProductPreferences, oms: OmsConnection, identityOnly=false) {
  if(!prefs.barcode)throw new OmsLookupError('Choose the barcode identification type in the existing Ionic store settings before scanning. You can still find products by name or SKU.');
  if(!codes.length||codes.length>25||codes.some(c=>!c||c.length>255||/[\x00-\x1f]/.test(c)))throw new OmsLookupError('Scan a valid product barcode.',400);
  const result=await search(oms,{query:'*:*',filter:[...COUNTABLE_FILTERS,`goodIdentifications:(${codes.map(c=>phrase(`${prefs.barcode}/${c}`)).join(' OR ')})`],fields:identityOnly?'productId,goodIdentifications':fields,params:{rows:500}});
  if(result.total!==result.docs.length||result.total>=500)throw new OmsLookupError('Product lookup is incomplete. Find and select the OMS product.');
  const matches: OmsRow[]=[],errors: OmsRow[]=[];
  for(const code of codes){
    const found=result.docs.filter(p=>identifications(p).some(i=>i.type===prefs.barcode&&i.value.toLowerCase()===code.toLowerCase()));
    if(found.length!==1)errors.push({code,message:found.length?'This barcode matches more than one OMS product. Select the correct product.':'No countable OMS product matches this barcode. Find the product to match it.'});
    else {
      const shopifyVariantId=shopifyVariantOf(identifications(found[0]),prefs.shopId);
      matches.push(identityOnly?{code,productId:text(found[0].productId),codes:[code],...(shopifyVariantId?{shopifyVariantId}:{})}:{code,...presentProduct(found[0],prefs)});
    }
  }
  return {matches,errors};
}
