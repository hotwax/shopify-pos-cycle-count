import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {inventoryScope, sameInventoryScope, type InventoryScope} from '../../../shared/store-inventory';
import {
  hotWaxInventoryLevel, hotWaxProductForVariant, inventoryEventSources, inventoryLevel, inventoryLocation,
  proposedVariances, recentInventoryEvents, searchInventory, shopifyVariantForHotWaxProduct,
  type HotWaxLevel, type InventoryEvent, type ProposedVariance, type Variant,
} from './Inventory';
import {eventSourceKey, type EventSource} from './InventoryEventSources';

type Location = Awaited<ReturnType<typeof inventoryLocation>>;
type HistoryTab = 'events' | 'proposals';
type ProductPage = {owner: string; product: Variant; tab?: HistoryTab};
const SEARCH_SCREEN = 'StoreInventorySearch';
const PRODUCT_SCREEN = 'StoreInventoryProduct';
const EVENT_ROWS_PER_PAGE = 50;
const units = (value: number | null) => value == null ? 'Unavailable' : String(value);
const signed = (value: number) => value > 0 ? '+'+value : String(value);
const labelFor = (product: Variant) => [product.option,product.sku].filter(Boolean).join(' · ');

function currentScope() {
  return inventoryScope({...shopify.session.currentSession,staffId:shopify.session.staffMember.value?.id});
}

function scopeKey() {
  try {return JSON.stringify(currentScope());} catch {return '';}
}

function timeAt(value: number, timeZone?: string) {
  if (!Number.isFinite(value) || value<=0) return '';
  const options: Intl.DateTimeFormatOptions = {month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'};
  try {return new Intl.DateTimeFormat(undefined,{...options,timeZone}).format(value);}
  catch {return new Intl.DateTimeFormat(undefined,options).format(value);}
}

function duration(milliseconds: number) {
  const seconds = Math.max(0,Math.floor(milliseconds/1000));
  const minutes = Math.floor(seconds/60);
  const hours = Math.floor(minutes/60);
  const days = Math.floor(hours/24);
  if (days) return days+'d'+(hours%24 ? ' '+hours%24+'h' : '');
  if (hours) return hours+'h'+(minutes%60 ? ' '+minutes%60+'m' : '');
  if (minutes) return minutes+'m'+(seconds%60 ? ' '+seconds%60+'s' : '');
  return seconds+'s';
}

function eventTiming(event: InventoryEvent, now: number) {
  const hasCreatedAt = Number.isFinite(event.at) && event.at>0;
  const age = hasCreatedAt ? 'Created '+duration(now-event.at)+' ago' : 'Creation time unavailable';
  if (event.state!=='Synced') return age;
  const syncedAt = event.syncedAt;
  const syncTime = hasCreatedAt && syncedAt!=null && Number.isFinite(syncedAt) && syncedAt>=event.at
    ? 'Synced in '+duration(syncedAt-event.at) : 'Sync time unavailable';
  return age+' · '+syncTime;
}

export default () => {
  const entry = navigation.currentEntry;
  const url = entry?.url;
  const screen = url?.includes(PRODUCT_SCREEN) ? PRODUCT_SCREEN : url?.includes(SEARCH_SCREEN) ? SEARCH_SCREEN : undefined;
  render(<Extension screen={screen} state={entry?.getState()}/>, document.body);
};

function Extension({screen,state}: {screen?: string; state: unknown}) {
  const [owner,setOwner] = useState(scopeKey);
  useEffect(()=>{
    const check = () => setOwner(scopeKey());
    const unsubscribe = shopify.session.staffMember.subscribe(check);
    const timer = setInterval(check,1500);
    return () => {unsubscribe();clearInterval(timer);};
  },[]);

  const scope = owner ? JSON.parse(owner) as InventoryScope : null;
  if (!scope || scope.staffId!==scope.userId) return <s-page heading="Store inventory"><s-box padding="large">
    <s-banner tone="warning" heading="Shopify POS sign-in required">
      Open the Gorjana sandbox with your own Shopify account and pin in to continue.
    </s-banner>
  </s-box></s-page>;

  if (screen===PRODUCT_SCREEN) {
    const selection = state as ProductPage | undefined;
    if (selection?.owner===owner && (selection.product?.itemId || selection.product?.variantId || selection.product?.hotWaxProductId)) {
      const product = selection.product;
      return <ProductDetail key={owner+':'+(product.itemId || product.variantId || product.hotWaxProductId)}
        scope={scope} selected={product} initialTab={selection.tab}/>;
    }
    return <s-page heading="Product details"><s-box padding="large">
      <s-banner tone="warning" heading="Product unavailable">Go back and select a product for this location.</s-banner>
    </s-box></s-page>;
  }
  if (screen===SEARCH_SCREEN) return <ProductSearch key={owner} scope={scope} owner={owner}/>;
  return <InventoryHome key={owner} scope={scope} owner={owner}/>;
}

function useStoreLocation(scope: InventoryScope) {
  const [connected,setConnected] = useState(shopify.connectivity.current.value.internetConnected==='Connected');
  const [location,setLocation] = useState<Location>();
  const [locationError,setLocationError] = useState('');
  const [refresh,setRefresh] = useState(0);

  useEffect(()=>shopify.connectivity.current.subscribe(state=>setConnected(state.internetConnected==='Connected')),[]);
  useEffect(()=>{
    if (!connected) return;
    const controller = new AbortController();
    setLocationError('');
    inventoryLocation(scope,()=>shopify.session.getSessionToken(),controller.signal)
      .then(result=>{
        if (!controller.signal.aborted && sameInventoryScope(scope,currentScope())) setLocation(result);
      })
      .catch(cause=>{
        if (!controller.signal.aborted) {
          setLocation(undefined);
          setLocationError(errorText(cause,'HotWax could not open inventory for this Shopify location.'));
        }
      });
    return ()=>controller.abort();
  },[connected,refresh]);

  return {connected,location,locationError,refreshLocation:()=>setRefresh(value=>value+1)};
}

function useScreenNavigation(owner: string) {
  const pending = useRef(false);
  const [navigationError,setNavigationError] = useState('');

  async function open(screen: string, product?: Variant, tab?: HistoryTab) {
    if (pending.current) return;
    pending.current = true;
    setNavigationError('');
    try {
      await navigation.navigate(screen, product ? {state:{owner,product,tab}} : undefined);
    } catch {
      setNavigationError('Shopify POS could not open the page. Try again.');
    } finally {
      pending.current = false;
    }
  }

  return {open,navigationError};
}

function InventoryHome({scope,owner}: {scope: InventoryScope; owner: string}) {
  const store = useStoreLocation(scope);
  const {open,navigationError} = useScreenNavigation(owner);
  return <s-page heading="Store inventory" subheading={store.location?.name}>
    <s-button slot="secondary-actions" variant="secondary" onClick={()=>open(SEARCH_SCREEN)}>Search</s-button>
    <s-scroll-box>
      <s-box padding="large">
        <s-stack direction="block" gap="base">
          {!store.connected && <OfflineBanner/>}
          {navigationError && <s-banner tone="warning" heading={navigationError}/>}
          <InventoryHistory store={store} openProduct={(product,tab)=>open(PRODUCT_SCREEN,product,tab)}/>
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}

type Store = ReturnType<typeof useStoreLocation>;
type ListFilter = {id?: string; loading: boolean; error?: string};

function InventoryHistory({store,openProduct,initialTab='events',itemFilter,productFilter}: {
  store: Store; openProduct?: (product: Variant,tab: HistoryTab) => void;
  initialTab?: HistoryTab; itemFilter?: ListFilter; productFilter?: ListFilter;
}) {
  const [tab,setTab] = useState(initialTab);
  return <s-section heading="Inventory changes">
    <s-button slot="secondary-actions" variant="secondary" disabled={!store.connected} onClick={store.refreshLocation}>Refresh</s-button>
    <s-tabs value={tab} onChange={event=>{
      const value = event.currentTarget.value;
      if (value==='events' || value==='proposals') setTab(value);
    }}>
      <s-tab-list>
        <s-tab controls="events">Events</s-tab>
        <s-tab controls="proposals">Proposed variances</s-tab>
      </s-tab-list>
      <s-tab-panel id="events">
        {tab==='events' && <InventoryEventList store={store} filter={itemFilter} openProduct={openProduct}/>}
      </s-tab-panel>
      <s-tab-panel id="proposals">
        {tab==='proposals' && <ProposedVarianceList store={store} filter={productFilter} openProduct={openProduct}/>}
      </s-tab-panel>
    </s-tabs>
  </s-section>;
}

function InventoryEventList({store,filter,openProduct}: {
  store: Store; filter?: ListFilter; openProduct?: (product: Variant,tab: HistoryTab) => void;
}) {
  const {connected,location,locationError} = store;
  const itemId = filter?.id;
  const canRead = !filter || Boolean(itemId);
  const [events,setEvents] = useState<InventoryEvent[]>([]);
  const [sources,setSources] = useState(new Map<string,EventSource>());
  const [showSynced,setShowSynced] = useState(false);
  const [now,setNow] = useState(Date.now);
  const [visibleCount,setVisibleCount] = useState(EVENT_ROWS_PER_PAGE);
  const [reading,setReading] = useState(true);
  const [listError,setListError] = useState('');
  const visibleEvents = showSynced ? events : events.filter(event=>event.state!=='Synced');

  useEffect(()=>{
    const timer = setInterval(()=>setNow(Date.now()),15000);
    return ()=>clearInterval(timer);
  },[]);

  useEffect(()=>{
    if (!connected || !location || !canRead) return;
    const controller = new AbortController();
    setReading(true);
    setListError('');
    recentInventoryEvents(location,controller.signal,itemId)
      .then(result=>{
        if (!controller.signal.aborted) {
          setEvents(result);
          setSources(new Map());
          setVisibleCount(EVENT_ROWS_PER_PAGE);
        }
      })
      .catch(cause=>{
        if (!controller.signal.aborted) setListError(errorText(cause,'HotWax could not load the inventory ledger.'));
      })
      .finally(()=>{if (!controller.signal.aborted) setReading(false);});
    return ()=>controller.abort();
  },[connected,location,canRead,itemId]);

  useEffect(()=>{
    if (!connected || !location) return;
    const missing = visibleEvents.slice(0,visibleCount).filter(event=>event.reference && !sources.has(eventSourceKey(event)));
    if (!missing.length) return;
    const controller = new AbortController();
    inventoryEventSources(location,missing,controller.signal).then(result=>{
      if (!controller.signal.aborted) setSources(previous=>new Map([...previous,...result]));
    }).catch(()=>{});
    return ()=>controller.abort();
  },[connected,location,events,showSynced,visibleCount]);

  const error = locationError || filter?.error || listError;
  const loading = connected && !error && (!location || filter?.loading || (canRead && reading));
  return <s-stack direction="block" gap="small" paddingBlock="base">
    <s-switch label="Show synced" checked={showSynced} onChange={event=>{
      setShowSynced(Boolean(event.currentTarget.checked));setVisibleCount(EVENT_ROWS_PER_PAGE);
    }}/>
    {error && <s-banner tone="warning" heading="Inventory ledger unavailable">{error}</s-banner>}
    {loading && <Loading label="Loading inventory events…"/>}
    {!loading && connected && !error && !visibleEvents.length &&
      <s-text color="subdued">{showSynced?'No recent inventory changes.':'No unsent changes in recent inventory events.'}</s-text>}
    {visibleEvents.slice(0,visibleCount).map(event=>{
      const source = sources.get(eventSourceKey(event));
      const record = source?.name || [event.source,event.reference].filter(Boolean).join(' ');
      const product = event.product ?? {itemId:event.itemId,title:'Inventory item '+event.itemId};
      return <Row key={event.id}
        title={filter ? record : product.title}
        subtitle={filter ? source?.actor : labelFor(product)}
        detail={filter ? undefined : [record,source?.actor].filter(Boolean).join(' · ')}
        timing={eventTiming(event,now)} imageUrl={product.imageUrl} value={signed(event.delta)} state={event.state}
        onClick={openProduct ? ()=>openProduct(product,'events') : undefined}/>;
    })}
    {visibleCount < visibleEvents.length && <s-stack direction="inline">
      <s-button variant="secondary" onClick={()=>setVisibleCount(count=>count+EVENT_ROWS_PER_PAGE)}>Load more</s-button>
    </s-stack>}
  </s-stack>;
}

function ProposedVarianceList({store,filter,openProduct}: {
  store: Store; filter?: ListFilter; openProduct?: (product: Variant,tab: HistoryTab) => void;
}) {
  const {connected,location,locationError} = store;
  const productId = filter?.id;
  const canRead = !filter || Boolean(productId);
  const [proposals,setProposals] = useState<ProposedVariance[]>([]);
  const [reading,setReading] = useState(true);
  const [listError,setListError] = useState('');
  const [visibleCount,setVisibleCount] = useState(EVENT_ROWS_PER_PAGE);

  useEffect(()=>{
    if (!connected || !location || !canRead) return;
    const controller = new AbortController();
    setReading(true);
    setListError('');
    proposedVariances(location,controller.signal,productId)
      .then(result=>{
        if (controller.signal.aborted) return;
        setProposals(result);
        setVisibleCount(EVENT_ROWS_PER_PAGE);
      })
      .catch(cause=>{
        if (controller.signal.aborted) return;
        setProposals([]);
        setListError(errorText(cause,'HotWax could not load cycle count variances.'));
      })
      .finally(()=>{if (!controller.signal.aborted) setReading(false);});
    return ()=>controller.abort();
  },[connected,location,canRead,productId]);

  const error = locationError || filter?.error || listError;
  const loading = connected && !error && (!location || filter?.loading || (canRead && reading));
  return <s-stack direction="block" gap="small" paddingBlock="base">
    {error && <s-banner tone="warning" heading="Proposed variances unavailable">{error}</s-banner>}
    {loading && <Loading label="Loading proposed variances…"/>}
    {!loading && connected && !error && !proposals.length &&
      <s-text color="subdued">No cycle count changes awaiting approval.</s-text>}
    {canRead && proposals.slice(0,visibleCount).map(({id,product,countName,counted,delta})=>
      <Row key={id} title={filter ? countName : product.title}
        subtitle={filter ? undefined : countName} detail={'Counted '+counted}
        imageUrl={filter ? undefined : product.imageUrl} value={signed(delta)} state="Awaiting approval"
        onClick={openProduct ? ()=>openProduct(product,'proposals') : undefined}/>)}
    {canRead && visibleCount < proposals.length && <s-stack direction="inline">
      <s-button variant="secondary" onClick={()=>setVisibleCount(count=>count+EVENT_ROWS_PER_PAGE)}>Load more</s-button>
    </s-stack>}
  </s-stack>;
}

function ProductSearch({scope,owner}: {scope: InventoryScope; owner: string}) {
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
      previous=result;
      if (navigation.currentEntry?.key!==screenKey) return;
      if (result.source==='camera') shopify.scanner.hideCameraScanner();
      const value=result.data.trim();
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
          {navigationError && <s-banner tone="warning" heading={navigationError}/>}
          <s-search-field placeholder="Search by name, SKU or barcode" value={input} onInput={event=>{
            setScan('');setInput(event.currentTarget.value ?? '');
          }}/>
          {search && <s-section heading={scan?'Barcode matches':'Catalog results'}>
            <s-stack direction="block" gap="small">
              {listError && <s-banner tone="warning" heading="Search unavailable">{listError}</s-banner>}
              {loading && !products.length && <Loading label="Finding products…"/>}
              {!loading && !listError && !products.length && <s-text color="subdued">No matching products.</s-text>}
              {products.map(product=><Row key={product.variantId} title={product.title} subtitle={labelFor(product)}
                imageUrl={product.imageUrl} value={product.available==null?'—':String(product.available)} valueLabel="Available"
                onClick={()=>open(PRODUCT_SCREEN,product)}/>)}
              {cursor && <s-stack direction="inline">
                <s-button variant="secondary" disabled={loading} onClick={loadMore}>Load more</s-button>
              </s-stack>}
            </s-stack>
          </s-section>}
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}

function ProductDetail({scope,selected,initialTab}: {scope: InventoryScope; selected: Variant; initialTab?: HistoryTab}) {
  const store = useStoreLocation(scope);
  const {connected,location,locationError} = store;
  const [snapshot,setSnapshot] = useState<Awaited<ReturnType<typeof inventoryLevel>>>();
  const [reading,setReading] = useState(true);
  const [detailError,setDetailError] = useState('');
  const [mappedProductId,setMappedProductId] = useState<string>();
  const [readingMapping,setReadingMapping] = useState(Boolean(selected.variantId && !selected.hotWaxProductId));
  const [mappingError,setMappingError] = useState('');
  const [hotWax,setHotWax] = useState<HotWaxLevel>();
  const [readingHotWax,setReadingHotWax] = useState(false);
  const [hotWaxError,setHotWaxError] = useState('');
  const product = snapshot?.product ?? selected;
  const level = snapshot?.level;
  const variantId = selected.variantId ?? snapshot?.product.variantId;
  const itemId = selected.itemId ?? snapshot?.product.itemId;
  const productId = selected.hotWaxProductId ?? mappedProductId;

  useEffect(()=>{
    if (!location || !connected) return;
    const controller = new AbortController();
    setReading(true);
    setDetailError('');
    async function loadShopify(storeLocation: Location) {
      const selection = selected.variantId || selected.itemId
        ? selected : await shopifyVariantForHotWaxProduct(storeLocation,selected,controller.signal);
      return selection && await inventoryLevel(storeLocation,selection,controller.signal);
    }
    loadShopify(location)
      .then(result=>{
        if (controller.signal.aborted) return;
        setSnapshot(result);
        if (!result) setDetailError('This product has no Shopify mapping for this shop.');
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
      .catch(cause=>{
        if (!controller.signal.aborted) setHotWaxError(errorText(cause,'HotWax quantities could not be loaded.'));
      })
      .finally(()=>{if (!controller.signal.aborted) setReadingHotWax(false);});
    return ()=>controller.abort();
  },[productId,location,connected]);

  const waitingForProduct = !productId && (readingMapping || (!variantId && reading));
  const productError = mappingError || (!productId && !variantId && !reading ? 'HotWax needs a confirmed product for this item.' : '');
  const loadingHotWax = connected && !locationError && (readingHotWax || waitingForProduct || !location);
  const unavailableHotWax = hotWaxError || locationError || productError;

  return <s-page heading="Product details" subheading={location?.name}>
    <s-scroll-box>
      <s-box padding="large">
        <s-stack direction="block" gap="large">
          {!connected && <OfflineBanner/>}
          <s-stack direction="block" gap="small-300">
            <s-heading>{product.title}</s-heading>
            {labelFor(product) && <s-text color="subdued">{labelFor(product)}</s-text>}
          </s-stack>
          {product.imageUrl && <s-box inlineSize="256px" maxInlineSize="100%" blockSize="256px">
            <s-image src={product.imageUrl} objectFit="contain" borderRadius="base"/>
          </s-box>}
          <s-section heading="Shopify quantities">
            <s-stack direction="block" gap="base">
              <s-divider/>
              {connected && reading && !locationError && <Loading label="Checking Shopify quantities…"/>}
              {(detailError || locationError) && <s-banner tone="warning" heading="Quantities unavailable">
                {detailError || locationError}
              </s-banner>}
              {level && <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="large" paddingBlock="small">
                  <Quantity label="Available" value={level.available}/>
                  <Quantity label="On hand" value={level.onHand}/>
                  <Quantity label="Committed" value={level.committed}/>
                </s-stack>
                <s-text type="small" color="subdued">Checked {timeAt(level.checkedAt,location?.timeZone)}</s-text>
              </s-stack>}
            </s-stack>
          </s-section>
          <s-section heading="HotWax quantities">
            <s-stack direction="block" gap="base">
              <s-divider/>
              {loadingHotWax && <Loading label="Checking HotWax quantities…"/>}
              {unavailableHotWax && <s-banner tone="warning" heading="HotWax quantities unavailable">{unavailableHotWax}</s-banner>}
              {hotWax && <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="large" paddingBlock="small">
                  <Quantity label="ATP" value={hotWax.atp}/>
                  <Quantity label="Reservations" value={hotWax.reservations}/>
                  <Quantity label="On hand (QOH)" value={hotWax.onHand}/>
                </s-stack>
                <s-text type="small" color="subdued">Checked {timeAt(hotWax.checkedAt,location?.timeZone)}</s-text>
              </s-stack>}
            </s-stack>
          </s-section>
          <InventoryHistory store={store} initialTab={initialTab}
            itemFilter={{id:itemId,loading:!itemId && reading,error:itemId ? undefined : detailError}}
            productFilter={{id:productId,loading:waitingForProduct,error:productError}}/>
          <s-section heading="Inventory actions">
            <s-stack direction="block" gap="small">
              <s-stack direction="inline" gap="base">
                <s-button variant="secondary" disabled>Push now</s-button>
                <s-button variant="secondary" disabled>Set available</s-button>
              </s-stack>
              <s-text type="small" color="subdued">Inventory changes are unavailable in this version.</s-text>
            </s-stack>
          </s-section>
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}

function errorText(cause: unknown, fallback: string) {
  const status = cause instanceof Error ? /HTTP (\d{3})/.exec(cause.message)?.[1] : undefined;
  return status ? fallback+' (HTTP '+status+')' : fallback;
}

function OfflineBanner() {
  return <s-banner tone="warning" heading="POS is offline">Connect to see current inventory.</s-banner>;
}

function Loading({label}: {label: string}) {
  return <s-stack direction="inline" alignItems="center" gap="small" paddingBlock="small">
    <s-spinner accessibilityLabel={label}/>
    <s-text color="subdued">{label}</s-text>
  </s-stack>;
}

function Quantity({label,value}: {label: string; value: number | null}) {
  return <s-stack direction="block" gap="small-300">
    <s-text type="small" color="subdued">{label}</s-text>
    <s-heading>{units(value)}</s-heading>
  </s-stack>;
}

function Row({title,subtitle,detail,timing,imageUrl,state,value,valueLabel,onClick}: {
  title: string; subtitle?: string; detail?: string; timing?: string; imageUrl?: string;
  state?: string; value?: string; valueLabel?: string; onClick?: () => void;
}) {
  const content = <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" paddingBlock="base" paddingInline="small">
    <s-stack direction="inline" alignItems="center" gap="base">
      {imageUrl && <s-box inlineSize="48px" minInlineSize="48px" blockSize="48px">
        <s-image src={imageUrl} objectFit="contain"/>
      </s-box>}
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{title}</s-text>
        {subtitle && <s-text type="small" color="subdued">{subtitle}</s-text>}
        {detail && <s-text type="small" color="subdued">{detail}</s-text>}
        {timing && <s-text type="small" color="subdued">{timing}</s-text>}
      </s-stack>
    </s-stack>
    <s-stack direction="inline" alignItems="center" gap="small">
      {state && <s-badge tone={state==='Synced'?'success':state==='Needs attention'?'warning':'neutral'}>{state}</s-badge>}
      {value && <s-box minInlineSize={valueLabel?'64px':'48px'}>
        <s-stack direction="block" alignItems="end" gap="small-300">
          {valueLabel && <s-text type="small" color="subdued">{valueLabel}</s-text>}
          <s-text type="strong">{value}</s-text>
        </s-stack>
      </s-box>}
      {onClick && <s-icon type="chevron-right" color="subdued"/>}
    </s-stack>
  </s-stack>;
  return <s-stack direction="block">
    <s-divider/>
    {onClick ? <s-clickable onClick={onClick}>{content}</s-clickable> : content}
  </s-stack>;
}
