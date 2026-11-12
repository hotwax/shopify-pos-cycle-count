import '@shopify/ui-extensions/preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import type {InventoryScope} from '../../../shared/store-inventory';
import {searchInventory, type Variant} from './Inventory';
import {PRODUCT_SCREEN, useScreenNavigation, useStoreLocation} from './store';
import {LoadMore, Loading, OfflineBanner, Row, Warning, errorText, productLabel} from './ui';

export function ProductSearch({scope,owner}: {scope: InventoryScope; owner: string}) {
  const {connected,location} = useStoreLocation(scope);
  const {open,navigationError} = useScreenNavigation(owner);
  const [input,setInput] = useState('');
  const [search,setSearch] = useState('');
  const [scan,setScan] = useState('');
  const [products,setProducts] = useState<Variant[]>([]);
  const [cursor,setCursor] = useState<string>();
  const [loading,setLoading] = useState(false);
  const [listError,setListError] = useState('');
  const pageRequest = useRef<AbortController>();

  useEffect(()=>{
    const timer = setTimeout(()=>setSearch(input.trim()),260);
    return ()=>clearTimeout(timer);
  },[input]);

  async function searchProducts(query: string, signal: AbortSignal, afterCursor?: string) {
    if (connected && location) return searchInventory(location,query,scan,signal,afterCursor);
    // Offline or before HotWax answers: POS's own catalog, without store quantities.
    const result = await shopify.productSearch.searchProducts({queryString:query,first:15,afterCursor});
    const found = result.items.flatMap(product=>product.variants.map(variant=>({
      title:product.title,option:product.hasOnlyDefaultVariant?undefined:variant.title,
      sku:variant.sku,barcode:variant.barcode,variantId:String(variant.id),
      imageUrl:variant.image || product.featuredImage,available:null,
    })));
    const exact = found.filter(product=>product.sku?.toLowerCase()===query.toLowerCase() || product.barcode===query);
    return {items:scan ? found.filter(product=>product.barcode===scan) : exact.length ? exact : found,
      cursor:result.hasNextPage ? result.lastCursor : undefined};
  }

  useEffect(()=>{
    const controller = new AbortController();
    setProducts([]);
    setCursor(undefined);
    setListError('');
    setLoading(Boolean(search));
    if (search) {
      searchProducts(search,controller.signal)
        .then(result=>{
          if (!controller.signal.aborted) {setProducts(result.items);setCursor(result.cursor);}
        })
        .catch(cause=>{if (!controller.signal.aborted) setListError(errorText(cause,'Shopify could not search products.'));})
        .finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    }
    return ()=>{
      controller.abort();
      pageRequest.current?.abort();
    };
  },[search,scan,connected,location]);

  useEffect(()=>{
    const screenKey = navigation.currentEntry?.key;
    let previous = shopify.scanner.scannerData.current.value;
    const unsubscribe = shopify.scanner.scannerData.current.subscribe(result=>{
      if (!result?.data || result===previous) return;
      previous = result;
      if (navigation.currentEntry?.key!==screenKey) return;
      if (result.source==='camera') shopify.scanner.hideCameraScanner();
      const value = result.data.trim();
      if (value) {setScan(value);setInput(value);setSearch(value);}
    });
    return ()=>{unsubscribe();shopify.scanner.hideCameraScanner();};
  },[]);

  async function loadMore() {
    if (!cursor || loading) return;
    pageRequest.current?.abort();
    const request = new AbortController();
    pageRequest.current = request;
    setLoading(true);
    setListError('');
    try {
      const result = await searchProducts(search,request.signal,cursor);
      if (request.signal.aborted) return;
      setProducts(previous=>[...previous,...result.items.filter(item=>!previous.some(loaded=>loaded.variantId===item.variantId))]);
      setCursor(result.cursor);
    } catch (cause) {
      if (!request.signal.aborted) setListError(errorText(cause,'More results could not be loaded.'));
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  }

  return <s-page heading="Search products" subheading={location?.name}>
    <s-button slot="secondary-actions" variant="secondary" onClick={()=>shopify.scanner.showCameraScanner()}>Scan</s-button>
    <s-scroll-box>
      <s-box padding="large">
        <s-stack direction="block" gap="base">
          {!connected && <OfflineBanner/>}
          {navigationError && <Warning reason={navigationError}/>}
          <s-search-field placeholder="Search by name, SKU or barcode" value={input} onInput={event=>{
            setScan('');setInput(event.currentTarget.value ?? '');
          }}/>
          {search && <s-section heading={scan?'Barcode matches':'Catalog results'}>
            <s-stack direction="block" gap="small">
              {listError && <Warning reason={listError}/>}
              {loading && !products.length && <Loading label="Finding products…"/>}
              {!loading && !listError && !products.length && <s-text color="subdued">No matching products.</s-text>}
              {products.map(product=><Row key={product.variantId} title={product.title} subtitle={productLabel(product)}
                imageUrl={product.imageUrl ?? ''} value={product.available==null?'—':String(product.available)} valueLabel="Available"
                onClick={()=>open(PRODUCT_SCREEN,product)}/>)}
              {cursor && <LoadMore disabled={loading} onClick={loadMore}/>}
            </s-stack>
          </s-section>}
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}
