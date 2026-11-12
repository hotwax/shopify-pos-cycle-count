import '@shopify/ui-extensions/preact';
import {useEffect, useState} from 'preact/hooks';
import type {InventoryScope} from '../../../shared/store-inventory';
import {
  hotWaxInventoryLevel, hotWaxProductForVariant, inventoryLevel, productSyncEvents, shopifyVariantForHotWaxProduct,
  type HotWaxLevel, type Location, type Variant,
} from './Inventory';
import {projectShopify, recentStoreSales} from './InventoryProjection';
import {InventoryHistory, useProposedVarianceRead, type SalesRead} from './EventList';
import {type HistoryTab, useStoreLocation} from './store';
import {Loading, OfflineBanner, Quantity, Warning, ago, errorText, productLabel, useNow} from './ui';

export function RefreshAction({store}: {store: {connected: boolean; refreshLocation: () => void}}) {
  return <s-button slot="secondary-actions" variant="secondary" aria-label="Refresh inventory"
    disabled={!store.connected} onClick={store.refreshLocation}>↻</s-button>;
}

export function ProductDetail({scope,selected,initialTab}: {scope: InventoryScope; selected: Variant; initialTab?: HistoryTab}) {
  const store = useStoreLocation(scope);
  const {connected,location,locationError} = store;
  const [isTablet,setIsTablet] = useState(false);
  const [snapshot,setSnapshot] = useState<Awaited<ReturnType<typeof inventoryLevel>>>();
  const [notInShopify,setNotInShopify] = useState(false);
  const [reading,setReading] = useState(true);
  const [detailError,setDetailError] = useState('');
  const [mappedProductId,setMappedProductId] = useState<string>();
  const [readingMapping,setReadingMapping] = useState(Boolean(selected.variantId && !selected.hotWaxProductId));
  const [mappingError,setMappingError] = useState('');
  const [hotWax,setHotWax] = useState<HotWaxLevel>();
  const [readingHotWax,setReadingHotWax] = useState(false);
  const [hotWaxError,setHotWaxError] = useState('');
  const [shopifyProjection,setShopifyProjection] = useState<ReturnType<typeof projectShopify>>();
  const [shopifyProjectionError,setShopifyProjectionError] = useState('');
  const [sales,setSales] = useState<SalesRead>({loading:true});
  const product = snapshot?.product ?? selected;
  const level = snapshot?.level;
  const variantId = selected.variantId ?? snapshot?.product.variantId;
  const itemId = selected.itemId ?? snapshot?.product.itemId;
  const productId = selected.hotWaxProductId ?? mappedProductId;
  const sku = product.sku;

  useEffect(()=>{
    let active = true;
    shopify.device.isTablet().then(tablet=>{if (active) setIsTablet(tablet);}).catch(()=>{});
    return ()=>{active = false;};
  },[]);

  useEffect(()=>{
    if (!location || !connected) return;
    const controller = new AbortController();
    setReading(true);
    setDetailError('');
    setNotInShopify(false);
    async function loadShopify(storeLocation: Location) {
      const selection = selected.variantId || selected.itemId
        ? selected : await shopifyVariantForHotWaxProduct(storeLocation,selected,controller.signal);
      return selection && await inventoryLevel(storeLocation,selection,controller.signal);
    }
    loadShopify(location)
      .then(result=>{
        if (controller.signal.aborted) return;
        setSnapshot(result);
        if (!result) setNotInShopify(true);
      })
      .catch(cause=>{if (!controller.signal.aborted) setDetailError(errorText(cause,'Shopify quantities could not be loaded.'));})
      .finally(()=>{if (!controller.signal.aborted) setReading(false);});
    return ()=>controller.abort();
  },[selected,location,connected]);

  useEffect(()=>{
    if (selected.hotWaxProductId || !variantId || !location || !connected) return;
    const controller = new AbortController();
    setReadingMapping(true);
    setMappingError('');
    hotWaxProductForVariant(location,variantId,selected.itemId,controller.signal)
      .then(result=>{if (!controller.signal.aborted) setMappedProductId(result);})
      .catch(cause=>{
        if (controller.signal.aborted) return;
        setMappedProductId(undefined);
        setMappingError(errorText(cause,'The Shopify variant could not be matched to a HotWax product.'));
      })
      .finally(()=>{if (!controller.signal.aborted) setReadingMapping(false);});
    return ()=>controller.abort();
  },[variantId,selected.itemId,selected.hotWaxProductId,location,connected]);

  useEffect(()=>{
    if (!productId || !location || !connected) return;
    const controller = new AbortController();
    setReadingHotWax(true);
    setHotWaxError('');
    hotWaxInventoryLevel(location,productId,controller.signal)
      .then(result=>{if (!controller.signal.aborted) setHotWax(result);})
      .catch(cause=>{if (!controller.signal.aborted) setHotWaxError(errorText(cause,'HotWax quantities could not be loaded.'));})
      .finally(()=>{if (!controller.signal.aborted) setReadingHotWax(false);});
    return ()=>controller.abort();
  },[productId,location,connected]);

  useEffect(()=>{
    setShopifyProjection(undefined);
    setShopifyProjectionError('');
    if (!location || !connected || !itemId || !level || reading) return;
    const controller = new AbortController();
    productSyncEvents(location,itemId,controller.signal)
      .then(events=>{if (!controller.signal.aborted) setShopifyProjection(projectShopify(level,events));})
      .catch(cause=>{
        if (!controller.signal.aborted) setShopifyProjectionError(errorText(cause,'The result after sync is unavailable while waiting changes cannot be checked.'));
      });
    return ()=>controller.abort();
  },[location,connected,itemId,level,reading]);

  useEffect(()=>{
    if (!location || !connected || reading) return;
    const controller = new AbortController();
    setSales({loading:true});
    recentStoreSales(location,variantId,controller.signal,Date.now(),sku)
      .then(data=>{if (!controller.signal.aborted) setSales({data,loading:false});})
      .catch(cause=>{
        if (!controller.signal.aborted) setSales({loading:false,error:errorText(cause,'Could not check Shopify POS orders against HotWax.')});
      });
    return ()=>controller.abort();
  },[location,connected,variantId,sku,reading]);

  const waitingForProduct = !productId && (readingMapping || (!variantId && reading));
  const productError = mappingError || (!productId && !variantId && !reading && !notInShopify ? 'HotWax needs a confirmed product for this item.' : '');
  const loadingHotWax = connected && !locationError && (readingHotWax || waitingForProduct || !location);
  const unavailableHotWax = hotWaxError || locationError || productError;
  const afterSales = sales.data?.impact;
  const checkingShopifyProjection = connected && Boolean(itemId) && !shopifyProjection && !shopifyProjectionError;
  // Read open approvals after the balances and queue. An approval already
  // reflected in either read should have left the open list by this point.
  const waitingForBaselines = reading || (Boolean(level) && checkingShopifyProjection) ||
    (Boolean(productId) && (readingHotWax || (!hotWax && !hotWaxError)));
  const varianceRead = useProposedVarianceRead(store,productId,Boolean(productId) && !waitingForBaselines);
  const openCounts = varianceRead.data?.length ?? 0;
  // Each approval applies its own difference, so overlapping counts have no single result to show.
  const proposedDelta = !varianceRead.data || openCounts>1 ? null : openCounts ? varianceRead.data[0].delta : 0;
  const afterApproval = (quantity: number | null | undefined) =>
    quantity==null || proposedDelta===null ? null : quantity+proposedDelta;
  const projectedAtp = afterApproval(hotWax?.atp!=null && afterSales ? hotWax.atp-afterSales.atp : null);
  const projectedQoh = afterApproval(hotWax?.onHand!=null && afterSales ? hotWax.onHand-afterSales.onHand : null);
  const checkingVariances = connected && !locationError && !productError &&
    (waitingForProduct || waitingForBaselines || varianceRead.loading);
  const now = useNow();

  return <s-page heading="Product details" subheading={location?.name}>
    <RefreshAction store={store}/>
    <s-scroll-box>
      <s-box padding="large">
        <s-stack direction="block" gap="large">
          {!connected && <OfflineBanner/>}
          <s-stack direction={isTablet?'inline':'block'} alignItems={isTablet?'start':'stretch'} gap="base">
            <s-stack direction="block" gap="base" inlineSize={isTablet?'33%':'100%'}>
              <s-stack direction="block" gap="small-300">
                {product.title && <s-heading>{product.title}</s-heading>}
                {productLabel(product) && <s-text color="subdued">{productLabel(product)}</s-text>}
              </s-stack>
              {product.imageUrl && <s-box inlineSize="256px" maxInlineSize="100%" blockSize="256px">
                <s-image src={product.imageUrl} objectFit="contain" borderRadius="base"/>
              </s-box>}
            </s-stack>
            <s-box inlineSize={isTablet?'63%':'100%'}>
              <s-section heading="Quantities at this store">
                <s-stack direction="block" gap="base">
                  <s-stack direction="block" gap="small">
                    <s-heading>Shopify</s-heading>
                    {connected && reading && !locationError && <Loading label="Checking Shopify quantities…"/>}
                    {notInShopify && <s-text color="subdued">This product isn’t in this Shopify shop, so it has no Shopify quantities.</s-text>}
                    {(detailError || locationError) && <Warning reason={detailError || locationError}/>}
                    {level && <>
                      <s-stack direction="inline">
                        <Quantity label="Available" value={level.available} projected={afterApproval(shopifyProjection?.available)}
                          projecting={checkingShopifyProjection || checkingVariances} projectedLabel="After sync"/>
                        <Quantity label="On hand" value={level.onHand} projected={afterApproval(shopifyProjection?.onHand)}
                          projecting={checkingShopifyProjection || checkingVariances} projectedLabel="After sync"/>
                        <Quantity label="Committed" value={level.committed}/>
                      </s-stack>
                      {shopifyProjectionError && <s-text type="small" color="subdued">{shopifyProjectionError}</s-text>}
                      {Boolean(shopifyProjection?.unknown) && <s-text type="small" color="subdued">
                        {shopifyProjection!.unknown} older {shopifyProjection!.unknown===1?'change has':'changes have'} no delivery record and {shopifyProjection!.unknown===1?'is':'are'} left out.
                      </s-text>}
                      <s-text type="small" color="subdued">Checked {ago(level.checkedAt,now)} · “After sync” includes waiting changes and a count awaiting approval</s-text>
                    </>}
                  </s-stack>
                  <s-divider/>
                  <s-stack direction="block" gap="small">
                    <s-heading>HotWax</s-heading>
                    {loadingHotWax && <Loading label="Checking HotWax quantities…"/>}
                    {unavailableHotWax && <Warning reason={unavailableHotWax}/>}
                    {hotWax && <>
                      <s-stack direction="inline">
                        <Quantity label="Available to sell" value={hotWax.atp} projected={projectedAtp}
                          projecting={(sales.loading && connected) || checkingVariances} projectedLabel="After import"/>
                        <Quantity label="On hand" value={hotWax.onHand} projected={projectedQoh}
                          projecting={(sales.loading && connected) || checkingVariances} projectedLabel="After import"/>
                        <Quantity label="Reserved" value={hotWax.reservations}/>
                      </s-stack>
                      <s-text type="small" color="subdued">Checked {ago(hotWax.checkedAt,now)} · “After import” includes POS sales not in HotWax yet and a count awaiting approval</s-text>
                      {!sales.loading && !afterSales && <s-text type="small" color="subdued">See POS sales for why the result after import is unavailable.</s-text>}
                    </>}
                  </s-stack>
                  {openCounts>1 && <s-text type="small" color="subdued">
                    {openCounts} counts of this product are awaiting approval, so the result after approval isn’t shown.
                  </s-text>}
                  {(varianceRead.error || productError) && !locationError &&
                    <s-text type="small" color="subdued">The result after approval needs this product’s counts awaiting approval.</s-text>}
                </s-stack>
              </s-section>
            </s-box>
          </s-stack>
          <InventoryHistory store={store} initialTab={initialTab} productImageUrl={product.imageUrl} pushScope={scope}
            sales={locationError ? {loading:false,error:locationError} : sales} varianceRead={varianceRead}
            itemFilter={{id:itemId,loading:!itemId && reading,
              error:itemId ? undefined : notInShopify ? 'This product isn’t in this Shopify shop, so it has no Shopify events.' : detailError}}
            productFilter={{id:productId,loading:waitingForProduct || waitingForBaselines,error:productError}}/>
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}
