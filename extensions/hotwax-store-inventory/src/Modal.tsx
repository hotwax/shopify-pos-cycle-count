import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {inventoryScope, sameInventoryScope, type InventoryScope} from '../../../shared/store-inventory';
import {inventoryEvents, inventoryLevel, inventoryLocation, searchInventory, type InventoryEvent, type Variant} from './Inventory';

type Location = Awaited<ReturnType<typeof inventoryLocation>>;
type Tab = 'queue' | 'recent';
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

export default () => render(<Extension/>, document.body);

function Extension() {
  const [owner,setOwner] = useState(scopeKey);
  useEffect(()=>{
    const check = () => setOwner(scopeKey());
    const unsubscribe = shopify.session.staffMember.subscribe(check);
    const timer = setInterval(check,1500);
    return () => {unsubscribe();clearInterval(timer);};
  },[]);
  const scope = owner ? JSON.parse(owner) as InventoryScope : null;
  if (scope && scope.staffId===scope.userId) return <Workspace key={owner} scope={scope}/>;
  return <s-page heading="Store inventory"><s-box padding="large">
    <s-banner tone="warning" heading="Shopify POS sign-in required">
      Open the Gorjana sandbox with your own Shopify account and pin in to continue.
    </s-banner>
  </s-box></s-page>;
}

function Workspace({scope}: {scope: InventoryScope}) {
  const [connected,setConnected] = useState(shopify.connectivity.current.value.internetConnected==='Connected');
  const [location,setLocation] = useState<Location>();
  const [locationError,setLocationError] = useState('');
  const [tab,setTab] = useState<Tab>('queue');
  const [input,setInput] = useState('');
  const [search,setSearch] = useState('');
  const [scan,setScan] = useState('');
  const [products,setProducts] = useState<Variant[]>([]);
  const [cursor,setCursor] = useState<string>();
  const [events,setEvents] = useState<InventoryEvent[]>([]);
  const [page,setPage] = useState(0);
  const [moreEvents,setMoreEvents] = useState(false);
  const [selected,setSelected] = useState<Variant>();
  const [snapshot,setSnapshot] = useState<Awaited<ReturnType<typeof inventoryLevel>>>();
  const pageRequest = useRef<AbortController>();
  const product = snapshot?.product ?? selected;
  const level = snapshot?.level;
  const [loading,setLoading] = useState(true);
  const [readingLevel,setReadingLevel] = useState(false);
  const [listError,setListError] = useState('');
  const [detailError,setDetailError] = useState('');
  const [refresh,setRefresh] = useState(0);

  useEffect(()=>shopify.connectivity.current.subscribe(state=>setConnected(state.internetConnected==='Connected')),[]);
  useEffect(()=>{
    const timer = setTimeout(()=>setSearch(input.trim()),260);
    return ()=>clearTimeout(timer);
  },[input]);

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

  async function searchProducts(query: string, signal: AbortSignal, afterCursor?: string) {
    if (connected && location) return searchInventory(location,query,scan,signal,afterCursor);
    const result = await shopify.productSearch.searchProducts({queryString:query,first:15,afterCursor});
    const found = result.items.flatMap(product=>product.variants.map(variant=>({
      title:product.title,option:product.hasOnlyDefaultVariant?undefined:variant.title,
      sku:variant.sku,barcode:variant.barcode,variantId:String(variant.id),
      imageUrl:variant.image || product.featuredImage,
    })));
    const exact = found.filter(product=>product.sku?.toLowerCase()===query.toLowerCase() || product.barcode===query);
    return {items:scan ? found.filter(product=>product.barcode===scan) : exact.length ? exact : found,
      cursor:result.hasNextPage ? result.lastCursor : undefined};
  }

  useEffect(()=>{
    pageRequest.current?.abort();
    if (selected) return;
    const controller = new AbortController();
    setProducts([]);
    setCursor(undefined);
    setEvents([]);
    setPage(0);
    setMoreEvents(false);
    setListError('');
    if (search) {
      setLoading(true);
      searchProducts(search,controller.signal)
        .then(result=>{
          if (!controller.signal.aborted) {setProducts(result.items);setCursor(result.cursor);}
        })
        .catch(cause=>{if (!controller.signal.aborted) setListError(errorText(cause,'Shopify could not search products.'));})
        .finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    } else if (connected && location) {
      setLoading(true);
      inventoryEvents(location,tab==='queue'?'UNASSIGNED_NONZERO':'RECENT',0,controller.signal)
        .then(result=>{
          if (!controller.signal.aborted) {setEvents(result.events);setMoreEvents(result.hasMore);}
        })
        .catch(cause=>{if (!controller.signal.aborted) setListError(errorText(cause,'HotWax could not load the inventory ledger.'));})
        .finally(()=>{if (!controller.signal.aborted) setLoading(false);});
    } else {
      setLoading(connected && !locationError);
    }
    return ()=>{
      controller.abort();
      pageRequest.current?.abort();
    };
  },[search,scan,tab,connected,location,locationError,selected]);

  useEffect(()=>{
    if (selected) return;
    let previous = shopify.scanner.scannerData.current.value;
    const unsubscribe = shopify.scanner.scannerData.current.subscribe(result=>{
      if (!result?.data || result===previous) return;
      previous=result;
      if (result.source==='camera') shopify.scanner.hideCameraScanner();
      const value=result.data.trim();
      if (value) {setScan(value);setInput(value);setSearch(value);}
    });
    return ()=>{unsubscribe();shopify.scanner.hideCameraScanner();};
  },[Boolean(selected)]);

  useEffect(()=>{
    if (!selected || !location || !connected) return;
    const controller = new AbortController();
    setReadingLevel(true);
    setDetailError('');
    inventoryLevel(location,selected,controller.signal)
      .then(result=>{if (!controller.signal.aborted) setSnapshot(result);})
      .catch(cause=>{if (!controller.signal.aborted) setDetailError(errorText(cause,'Shopify quantities could not be loaded.'));})
      .finally(()=>{if (!controller.signal.aborted) setReadingLevel(false);});
    return ()=>controller.abort();
  },[selected,location,connected]);

  function select(product: Variant) {
    setSnapshot(undefined);
    setDetailError('');
    setSelected(product);
  }

  async function loadMore() {
    pageRequest.current?.abort();
    const request = new AbortController();
    pageRequest.current = request;
    setLoading(true);
    setListError('');
    try {
      if (search && cursor) {
        const result = await searchProducts(search,request.signal,cursor);
        if (request.signal.aborted) return;
        setProducts(previous=>[...previous,...result.items.filter(item=>!previous.some(loaded=>loaded.variantId===item.variantId))]);
        setCursor(result.cursor);
      } else if (location && moreEvents) {
        const result = await inventoryEvents(location,tab==='queue'?'UNASSIGNED_NONZERO':'RECENT',page+1,request.signal);
        if (request.signal.aborted) return;
        setEvents(previous=>[...previous,...result.events.filter(item=>!previous.some(loaded=>loaded.id===item.id))]);
        setPage(page+1);
        setMoreEvents(result.hasMore);
      }
    } catch (cause) {
      if (!request.signal.aborted) setListError(errorText(cause,'More results could not be loaded.'));
    } finally {if (!request.signal.aborted) setLoading(false);}
  }

  return <s-page heading="Store inventory" subheading={location?.name}>
    {!selected && <s-button slot="secondary-actions" variant="secondary" onClick={()=>shopify.scanner.showCameraScanner()}>Scan</s-button>}
    <s-scroll-box key={selected?'detail':'inventory'}>
      <s-box padding="large">
        <s-stack direction="block" gap="large">
          {!connected && <s-banner tone="warning" heading="POS is offline">Connect to see current inventory.</s-banner>}
          {product ? <>
            <s-stack direction="inline">
              <s-clickable onClick={()=>{setSnapshot(undefined);setSelected(undefined);}}>
                <s-stack direction="inline" alignItems="center" minBlockSize="44px" gap="small">
                  <s-icon type="chevron-left"/>
                  <s-text type="strong">{search?'Catalog results':'Inventory'}</s-text>
                </s-stack>
              </s-clickable>
            </s-stack>
            <s-stack direction="block" gap="small-300">
              <s-heading>{product.title}</s-heading>
              {labelFor(product) && <s-text color="subdued">{labelFor(product)}</s-text>}
            </s-stack>
            <s-section heading="Shopify quantities">
              <s-stack direction="block" gap="base">
                <s-divider/>
                {readingLevel && <Loading label="Checking Shopify quantities…"/>}
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
            <s-section heading="Inventory actions">
              <s-stack direction="block" gap="small">
                <s-stack direction="inline" gap="base">
                  <s-button variant="secondary" disabled>Push now</s-button>
                  <s-button variant="secondary" disabled>Set available</s-button>
                </s-stack>
                <s-text type="small" color="subdued">Inventory changes are unavailable in this version.</s-text>
              </s-stack>
            </s-section>
          </> : <>
            <s-search-field placeholder="Search by name, SKU or barcode" value={input} onInput={event=>{
              setScan('');setInput(event.currentTarget.value ?? '');
            }}/>
            {!search && <s-stack direction="inline" gap="small">
              <s-button variant={tab==='queue'?'primary':'secondary'} onClick={()=>setTab('queue')}>Inventory queue</s-button>
              <s-button variant={tab==='recent'?'primary':'secondary'} onClick={()=>setTab('recent')}>Recent activity</s-button>
            </s-stack>}
            <s-section heading={search ? (scan?'Barcode matches':'Catalog results') : tab==='queue'?'Awaiting publication':'Recent Shopify inventory events'}>
              {!search && <s-button slot="secondary-actions" variant="secondary" disabled={!connected || loading} onClick={()=>setRefresh(value=>value+1)}>Refresh</s-button>}
              <s-stack direction="block" gap="small">
                {(listError || (!search && locationError)) && <s-banner tone="warning" heading={search?'Search unavailable':'Inventory ledger unavailable'}>
                  {listError || locationError}
                </s-banner>}
                {loading && <Loading label={search?'Finding products…':'Loading inventory…'}/>}
                {!loading && !listError && (search ? !products.length : connected && !!location && !events.length) &&
                  <s-stack direction="inline" gap="base" alignItems="center" paddingBlock="base">
                    <s-icon type={search?'search':'inventory-list'} color="subdued"/>
                    <s-text color="subdued">{search?'No matching products.':tab==='queue'?'No updates are waiting to be published.':'No recent events at this location.'}</s-text>
                  </s-stack>}
                {search ? products.map(product=><Row key={product.variantId} title={product.title} subtitle={labelFor(product)} imageUrl={product.imageUrl}
                  onClick={()=>select(product)}/>) : events.map(event=><Row key={event.id} title={event.product?.title ?? event.source}
                  subtitle={[event.product && labelFor(event.product),event.reference,timeAt(event.at,location?.timeZone)].filter(Boolean).join(' · ')}
                  value={signed(event.delta)} state={event.state}
                  onClick={()=>select(event.product ?? {itemId:event.itemId,title:'Inventory item '+event.itemId})}/>)}
                {(search ? cursor : moreEvents) && <s-stack direction="inline">
                  <s-button variant="secondary" disabled={loading || (!search && !connected)} onClick={loadMore}>Load more</s-button>
                </s-stack>}
              </s-stack>
            </s-section>
          </>}
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}

function errorText(cause: unknown, fallback: string) {
  const status = cause instanceof Error ? /HTTP (\d{3})/.exec(cause.message)?.[1] : undefined;
  return status ? fallback+' (HTTP '+status+')' : fallback;
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

function Row({title,subtitle,imageUrl,state,value,onClick}: {
  title: string; subtitle: string; imageUrl?: string; state?: string; value?: string; onClick: () => void;
}) {
  return <s-stack direction="block">
    <s-divider/>
    <s-clickable onClick={onClick}>
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base" paddingBlock="base" paddingInline="small">
        <s-stack direction="inline" alignItems="center" gap="base">
          {imageUrl && <s-box inlineSize="48px" minInlineSize="48px" blockSize="48px">
            <s-image src={imageUrl} objectFit="contain"/>
          </s-box>}
          <s-stack direction="block" gap="small-300">
            <s-text type="strong">{title}</s-text>
            {subtitle && <s-text type="small" color="subdued">{subtitle}</s-text>}
          </s-stack>
        </s-stack>
        <s-stack direction="inline" alignItems="center" gap="small">
          {value && <s-text type="strong">{value}</s-text>}
          {state && <s-badge tone={state==='Sent'?'success':state==='Needs attention'?'warning':'neutral'}>{state}</s-badge>}
          <s-icon type="chevron-right" color="subdued"/>
        </s-stack>
      </s-stack>
    </s-clickable>
  </s-stack>;
}
