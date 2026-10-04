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
      const matches = new Map<number,ScanDisplay>();
      for (const product of result.items || []) {
        const variants = product.variants || await api.fetchProductVariantsWithProductId(product.id);
        for (const variant of variants) if (variant.barcode === key) {
          matches.set(variant.id, {shopifyProductId:product.id,shopifyVariantId:variant.id,
            title:[product.title,variant.title !== 'Default Title' ? variant.title : ''].filter(Boolean).join(' · '),
            sku:variant.sku || '',imageUrl:variant.image || product.featuredImage || ''});
        }
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
