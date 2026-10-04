import type {ProductSearchApiContent} from '@shopify/ui-extensions/point-of-sale';
export type ScanDisplay={shopifyProductId:number;shopifyVariantId:number;title:string;sku:string;imageUrl:string};
// Display enrichment only. Shopify IDs never become HotWax count-item IDs.
export function createScanProductLookup(api: ProductSearchApiContent | undefined, isCurrent:()=>boolean = () => true): (code:string)=>Promise<ScanDisplay|null> {
  const cache = new Map<string,{value:ScanDisplay|null;until:number}>(), inflight = new Map<string,Promise<ScanDisplay|null>>();
  const queue: {work:()=>Promise<ScanDisplay|null>;resolve:(value:ScanDisplay|null)=>void}[] = [];
  let active = 0;
  const drain = ():void => {
    while (active < 4 && queue.length) {
      const {work,resolve} = queue.shift()!; active++;
      Promise.resolve().then(work).catch(()=>null).then(resolve).finally(()=>{active--;drain();});
    }
  };
  return (code:string):Promise<ScanDisplay|null> => {
    const key = String(code).trim();
    if (!key || !api || !isCurrent()) return Promise.resolve(null);
    const saved = cache.get(key);
    if (saved && saved.until > Date.now()) return Promise.resolve(saved.value);
    if (inflight.has(key)) return inflight.get(key)!;
    if (queue.length>=25) return Promise.resolve(null);
    const deadline=Date.now()+2500;
    const work = async ():Promise<ScanDisplay|null> => {
      if (!isCurrent() || Date.now()>deadline) return null;
      const result = await api.searchProducts({queryString:key,first:50});
      // A fuzzy result or incomplete page is never evidence of a unique variant.
      if (!isCurrent() || result.hasNextPage) return null;
      const matches = new Map<number,ScanDisplay>(), products = result.items || [];
      const collect = (product: typeof products[number], variants: NonNullable<typeof products[number]['variants']>) => {
        for (const variant of variants) if (variant.barcode === key) {
          matches.set(variant.id, {shopifyProductId:product.id,shopifyVariantId:variant.id,
            title:[product.title,variant.title !== 'Default Title' ? variant.title : ''].filter(Boolean).join(' · '),
            sku:variant.sku || '',imageUrl:variant.image || product.featuredImage || ''});
        }
      };
      for (const product of products) if (product.variants) collect(product, product.variants);
      // Fetch the remaining variant lists together (four at a time) instead of one
      // after another; a second exact match already makes the barcode ambiguous.
      const missing = products.filter(product => !product.variants);
      for (let i = 0; i < missing.length && matches.size < 2; i += 4) {
        const batch = missing.slice(i, i + 4);
        const lists = await Promise.all(batch.map(product => api.fetchProductVariantsWithProductId(product.id)));
        if (!isCurrent()) return null;
        batch.forEach((product, index) => collect(product, lists[index]));
      }
      return matches.size === 1 ? [...matches.values()][0] : null;
    };
    // Slow/unavailable display data must not hold up OMS matching or the scanner.
    const task = new Promise<ScanDisplay|null>(resolve => {
      const timer = setTimeout(()=>resolve(null),2500);
      queue.push({work,resolve:value=>{clearTimeout(timer);resolve(value);}}); drain();
    }).then(value=>{
      if (!isCurrent()) return null;
      cache.delete(key); cache.set(key,{value,until:Date.now()+(value?300000:5000)});
      while(cache.size>256)cache.delete(cache.keys().next().value!);
      return value;
    }).finally(()=>inflight.delete(key));
    inflight.set(key,task); return task;
  };
}

type Variant={id:number;title?:string;displayName?:string;sku?:string;image?:string;productId?:number;product?:{title?:string;featuredImage?:string}};
const variantDisplay=(variant:Variant,product?:{title?:string;featuredImage?:string})=>{
  const parent=product||variant.product;
  return {title:parent?.title?[parent.title,variant.title!=='Default Title'?variant.title:''].filter(Boolean).join(' · '):variant.displayName||variant.title||'',
    sku:variant.sku||'',imageUrl:variant.image||parent?.featuredImage||''};
};
/** Display for up to 50 Shopify variants (one bulk call); missing variants are omitted. */
export async function fetchVariantDisplays(api: ProductSearchApiContent | undefined, ids: number[]) {
  const found=new Map<number,{title:string;sku:string;imageUrl:string}>();
  if(!api||!ids.length)return found;
  const result=await api.fetchProductVariantsWithIds(ids.slice(0,50));
  for(const variant of result.fetchedResources||[])found.set(variant.id,variantDisplay(variant as Variant));
  return found;
}
type Member={productId:string;variantId?:number};
/**
 * Search the shop's products through POS and keep only this session's products,
 * matched by Shopify variant ID, in Shopify's relevance order. Pages continue
 * until `needed` members are found or the results end (at most 20 pages per
 * query), so filtering out non-members never produces a false empty page.
 */
export function createMemberSearch(api: ProductSearchApiContent | undefined) {
  const cache=new Map<string,{ids:string[];seen:Set<string>;cursor?:string;done:boolean;pages:number;members:number}>();
  let generation=0;
  return async (query:string,needed:number,members:Member[],remember:(variantId:number,display:{title:string;sku:string;imageUrl:string})=>void,wanted:(productId:string)=>boolean=()=>true)=>{
    // Any newer call stops this walk; a call spends at most 4 s and the next call resumes.
    const gen=++generation;
    if(!api||!query)return null;
    const deadline=Date.now()+4000;
    const byVariant=new Map(members.filter(member=>member.variantId!=null).map(member=>[Number(member.variantId),member.productId]));
    let entry=cache.get(query);
    if(!entry||entry.members!==byVariant.size)entry={ids:[],seen:new Set(),done:false,pages:0,members:byVariant.size};
    cache.delete(query);cache.set(query,entry);
    while(cache.size>20)cache.delete(cache.keys().next().value!);
    // Count only hits the caller can show (its filter), so a filtered page is never falsely empty.
    while(!entry.done&&entry.ids.filter(wanted).length<needed&&entry.pages<20&&byVariant.size&&generation===gen&&Date.now()<deadline){
      const result=await api.searchProducts({queryString:query,first:50,...(entry.cursor?{afterCursor:entry.cursor}:{})});
      if(generation!==gen)return null;
      entry.pages++;entry.cursor=result.lastCursor;entry.done=!result.hasNextPage||!result.lastCursor;
      const products=result.items||[],bare=products.filter(product=>!product.variants?.length).map(product=>product.id);
      // Search results may omit variants; one bulk fetch fills them in.
      const full=bare.length?new Map((await api.fetchProductsWithIds(bare)).fetchedResources.map(product=>[product.id,product])):new Map();
      for(const product of products)for(const variant of (product.variants?.length?product.variants:full.get(product.id)?.variants)||[]){
        const productId=byVariant.get(variant.id);
        if(productId&&!entry.seen.has(productId)){entry.seen.add(productId);entry.ids.push(productId);remember(variant.id,variantDisplay(variant as Variant,product));}
      }
    }
    // A walk stopped by the page cap may have missed matches: it is not complete.
    return {ids:entry.ids,complete:entry.done||!byVariant.size,capped:entry.pages>=20};
  };
}
