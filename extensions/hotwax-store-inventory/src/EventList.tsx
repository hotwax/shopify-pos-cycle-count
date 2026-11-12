import '@shopify/ui-extensions/preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import type {InventoryScope} from '../../../shared/store-inventory';
import {
  DEFAULT_FILTER, deliveryErrors, inventoryEventSources, inventorySyncSummary, proposedVariances, pushInventoryBatches,
  queuedInventoryBatches, recentInventoryEvents,
  type BatchProgress, type EventFilter, type InventoryEvent, type InventorySyncSummary, type Location, type ProposedVariance, type Variant,
} from './Inventory';
import {eventSourceKey, type EventSource} from './InventoryEventSources';
import type {StoreSales} from './InventoryProjection';
import {scopeKey, type HistoryTab, type Store} from './store';
import {
  ROWS_PER_PAGE, STATE_LABELS, LoadMore, Loading, Row, Warning, ago, duration, errorText, productLabel, signed, stateTone, useNow,
} from './ui';

type ListFilter = {id?: string; loading: boolean; error?: string};
export type SalesRead = {data?: StoreSales; error?: string; loading: boolean};
export type VarianceRead = {data?: ProposedVariance[]; error?: string; loading: boolean};
type OpenProduct = (product: Variant, tab: HistoryTab) => void;
type Within = 'any' | 'hour' | 'day' | 'week';
const WITHIN: Record<Within,number> = {any:0,hour:60*60*1000,day:24*60*60*1000,week:7*24*60*60*1000};

export function InventoryHistory({store,onSearch,openProduct,initialTab='events',itemFilter,productFilter,productImageUrl,pushScope,sales,varianceRead}: {
  store: Store; openProduct?: OpenProduct; onSearch?: () => void;
  initialTab?: HistoryTab; itemFilter?: ListFilter; productFilter?: ListFilter; productImageUrl?: string;
  pushScope?: InventoryScope; sales?: SalesRead; varianceRead?: VarianceRead;
}) {
  const [tab,setTab] = useState(initialTab);
  return <s-section heading={onSearch ? undefined : 'Inventory changes'}>
    {onSearch && <s-stack direction="inline" alignItems="center" justifyContent="space-between" paddingBlockEnd="base" gap="base">
      <s-heading>Inventory changes</s-heading>
      <s-button variant="secondary" onClick={onSearch}>Search products</s-button>
    </s-stack>}
    {!itemFilter && store.location && store.connected && <SyncSummary location={store.location}/>}
    <s-tabs value={tab} onChange={event=>{
      const value = event.currentTarget.value;
      if (value==='events' || value==='proposals' || (value==='sales' && sales)) setTab(value);
    }}>
      <s-tab-list>
        <s-tab controls="events">Events</s-tab>
        <s-tab controls="proposals">Counts awaiting approval</s-tab>
        {sales && <s-tab controls="sales">POS sales</s-tab>}
      </s-tab-list>
      <s-tab-panel id="events">
        {tab==='events' && <InventoryEventList store={store} filter={itemFilter} openProduct={openProduct}
          productImageUrl={productImageUrl} pushScope={pushScope}/>}
      </s-tab-panel>
      <s-tab-panel id="proposals">
        {tab==='proposals' && <ProposedVarianceList store={store} filter={productFilter} openProduct={openProduct}
          productImageUrl={productImageUrl} varianceRead={varianceRead}/>}
      </s-tab-panel>
      {sales && <s-tab-panel id="sales">
        {tab==='sales' && <PosSales sales={sales} connected={store.connected}/>}
      </s-tab-panel>}
    </s-tabs>
  </s-section>;
}

function eventTiming(event: InventoryEvent, now: number) {
  if (!Number.isFinite(event.at) || event.at<=0) return 'Creation time unavailable';
  const age = 'Created '+ago(event.at,now);
  if (event.state!=='Sent') return age;
  return event.syncedAt!=null && event.syncedAt>=event.at ? age+' · Sent in '+duration(event.syncedAt-event.at) : age;
}

function failureDetail(event: InventoryEvent, errors: Map<string,string>, now: number) {
  if (event.state==='Missing') return 'Its delivery record was removed after 30 days. Check this change in HotWax.';
  if (event.state!=='Error') return undefined;
  const tries = event.failCount ? 'Failed '+event.failCount+(event.failCount===1?' time':' times') : 'Failed';
  const last = event.lastAttemptAt ? ', last tried '+ago(event.lastAttemptAt,now) : '';
  const reason = errors.get(event.messageId);
  return tries+last+(reason ? ': '+reason : '');
}

function SyncSummary({location}: {location: Location}) {
  const now = useNow();
  const [result,setResult] = useState<{location: Location; data?: InventorySyncSummary; error?: string}>();
  useEffect(()=>{
    const controller = new AbortController();
    inventorySyncSummary(location,controller.signal)
      .then(data=>{if (!controller.signal.aborted) setResult({location,data});})
      .catch(cause=>{if (!controller.signal.aborted) setResult({location,error:errorText(cause,'Sync status is unavailable.')});});
    return ()=>controller.abort();
  },[location]);

  if (result?.location!==location) return <Loading label="Checking Shopify sync…"/>;
  const data = result.data;
  if (!data) return <Warning reason={result.error || 'Sync status is unavailable. Refresh to try again.'}/>;
  return <s-stack direction="block" gap="base" paddingBlockEnd="base">
    {data.attentionCount>0 && <Warning reason={data.attentionCount+(data.attentionCount===1?' change failed':' changes failed')+
      ' or lost its delivery record. Filter by Needs attention to see '+(data.attentionCount===1?'it':'them')+'.'}/>}
    <s-banner tone={data.pendingCount ? 'warning' : 'success'} heading={data.pendingCount
      ? data.pendingCount+(data.pendingCount===1?' change':' changes')+' not sent to Shopify yet'
        +(data.oldestPendingAt ? ' · oldest created '+ago(data.oldestPendingAt,now) : '')
      : 'Every change is sent to Shopify'}/>
    <s-stack direction="inline" gap="base">
      <s-stack direction="block" gap="small-300" inlineSize="48%">
        <s-text type="small" color="subdued">Sent in the last hour</s-text>
        <s-heading>{data.syncedCount}</s-heading>
      </s-stack>
      <s-stack direction="block" gap="small-300" inlineSize="48%">
        <s-text type="small" color="subdued">Typically reaches Shopify in</s-text>
        <s-heading>{data.averageSyncMs===null ? '—' : duration(data.averageSyncMs)}</s-heading>
      </s-stack>
    </s-stack>
    {data.byType.map(type=><s-stack key={type.eventType} direction="inline" alignItems="center" justifyContent="space-between" gap="base">
      <s-text>{type.label} · {type.count} sent</s-text>
      <s-text color="subdued">+{type.added} / −{type.removed}</s-text>
    </s-stack>)}
    {data.hasResets && <s-text type="small" color="subdued">Unit totals leave out inventory resets.</s-text>}
    <s-text type="small" color="subdued">Checked {ago(data.checkedAt,now)}</s-text>
  </s-stack>;
}

function EventFilters({id,filter,within,types,onChange}: {
  id: string; filter: EventFilter; within: Within; types: Map<string,string>;
  onChange: (filter: EventFilter, within: Within) => void;
}) {
  const pick = (event: {currentTarget: {values?: string[]}}) => event.currentTarget.values?.[0] ?? '';
  return <s-modal id={id} heading="Filter events">
    <s-stack direction="block" gap="base">
      <s-heading>Status</s-heading>
      <s-choice-list values={[filter.status]} onChange={event=>{
        const status = pick(event);
        if (status==='unsent' || status==='attention' || status==='all') onChange({...filter,status},within);
      }}>
        <s-choice value="unsent">Not sent yet</s-choice>
        <s-choice value="attention">Needs attention</s-choice>
        <s-choice value="all">All, including sent in the last 5 days</s-choice>
      </s-choice-list>
      <s-heading>Event type</s-heading>
      <s-choice-list values={[filter.eventType ?? 'all']} onChange={event=>{
        const type = pick(event);
        onChange({...filter,eventType:type && type!=='all' ? type : undefined},within);
      }}>
        <s-choice value="all">All types</s-choice>
        {[...types].map(([type,label])=><s-choice key={type} value={type}>{label}</s-choice>)}
      </s-choice-list>
      <s-heading>Created</s-heading>
      <s-choice-list values={[within]} onChange={event=>{
        const value = pick(event);
        if (value in WITHIN) onChange(filter,value as Within);
      }}>
        <s-choice value="any">Any time</s-choice>
        <s-choice value="hour">In the last hour</s-choice>
        <s-choice value="day">In the last day</s-choice>
        <s-choice value="week">In the last week</s-choice>
      </s-choice-list>
      <s-heading>Order</s-heading>
      <s-choice-list values={[filter.oldestFirst ? 'oldest' : 'newest']} onChange={event=>{
        onChange({...filter,oldestFirst:pick(event)==='oldest'},within);
      }}>
        <s-choice value="newest">Newest first</s-choice>
        <s-choice value="oldest">Oldest first</s-choice>
      </s-choice-list>
    </s-stack>
    <s-button slot="primary-action" variant="primary" command="--hide" commandFor={id}>Done</s-button>
  </s-modal>;
}

function InventoryEventList({store,filter: itemFilter,openProduct,productImageUrl,pushScope}: {
  store: Store; filter?: ListFilter; openProduct?: OpenProduct; productImageUrl?: string; pushScope?: InventoryScope;
}) {
  const {connected,location,locationError} = store;
  const itemId = itemFilter?.id;
  const canRead = !itemFilter || Boolean(itemId);
  const filtersId = itemFilter ? 'product-event-filters' : 'event-filters';
  const [filter,setFilter] = useState<EventFilter>(DEFAULT_FILTER);
  const [within,setWithin] = useState<Within>('any');
  const [types,setTypes] = useState(new Map<string,string>());
  const [events,setEvents] = useState<InventoryEvent[]>([]);
  const [more,setMore] = useState(false);
  const [sources,setSources] = useState(new Map<string,EventSource>());
  const [errors,setErrors] = useState(new Map<string,string>());
  const now = useNow();
  const [visibleCount,setVisibleCount] = useState(ROWS_PER_PAGE);
  const [reading,setReading] = useState(true);
  const [listError,setListError] = useState('');
  const [pushing,setPushing] = useState(false);
  const [pushResult,setPushResult] = useState<{sent: number; error: string}>();
  const [activeBatchIds,setActiveBatchIds] = useState(new Set<string>());
  const [batchProgress,setBatchProgress] = useState(new Map<string,BatchProgress>());
  const [dimmingSent,setDimmingSent] = useState(false);
  const [reload,setReload] = useState(0);
  const pushRequest = useRef<AbortController>();
  const completionTimer = useRef<ReturnType<typeof setTimeout>>();
  const eventRows = events.map(event=>{
    const progress = batchProgress.get(event.messageId);
    return progress ? {...event,state:progress.state,syncedAt:progress.syncedAt} : event;
  });
  const visibleEvents = eventRows.filter(event=>filter.status==='all' || event.state!=='Sent' || activeBatchIds.has(event.messageId));
  const canPush = Boolean(pushScope && location?.canPush);
  const batchIds = canPush ? queuedInventoryBatches(eventRows) : [];
  const changedFilters = (filter.status!=='unsent' ? 1 : 0)+(filter.eventType ? 1 : 0)+
    (within!=='any' ? 1 : 0)+(filter.oldestFirst ? 1 : 0);

  useEffect(()=>()=>{
    pushRequest.current?.abort();
    clearTimeout(completionTimer.current);
  },[]);

  async function pushNow() {
    if (!pushScope || !itemId || !location || !connected || !batchIds.length || pushRequest.current) return;
    const inScope = () => scopeKey()===JSON.stringify(pushScope);
    if (!inScope()) return;
    const request = new AbortController();
    pushRequest.current = request;
    setPushing(true);
    setPushResult(undefined);
    setActiveBatchIds(new Set(batchIds));
    let allSent = false;
    try {
      const result = await pushInventoryBatches(location,itemId,batchIds,inScope,request.signal,progress=>{
        if (!request.signal.aborted && inScope()) setBatchProgress(previous=>new Map(previous).set(progress.messageId,progress));
      });
      if (request.signal.aborted || !inScope()) return;
      setPushResult(result);
      allSent = !result.error && result.sent===batchIds.length;
      if (allSent) {
        setDimmingSent(true);
        completionTimer.current = setTimeout(()=>{
          setActiveBatchIds(new Set());
          setDimmingSent(false);
          setReload(value=>value+1);
        },800);
      }
    } catch (cause) {
      if (!request.signal.aborted && inScope()) setPushResult({sent:0,error:errorText(cause,'HotWax could not check the queue.')});
    } finally {
      pushRequest.current = undefined;
      if (!request.signal.aborted && inScope()) {
        setPushing(false);
        if (!allSent) {
          setActiveBatchIds(new Set());
          setBatchProgress(previous=>new Map([...previous].filter(([,progress])=>progress.state==='Sent')));
          setReload(value=>value+1);
        }
      }
    }
  }

  useEffect(()=>{
    if (!connected || !location || !canRead) return;
    const controller = new AbortController();
    setReading(true);
    setListError('');
    const since = within==='any' ? undefined : Date.now()-WITHIN[within];
    recentInventoryEvents(location,controller.signal,{...filter,since},itemId)
      .then(result=>{
        if (controller.signal.aborted) return;
        setEvents(result.events);
        setMore(result.more);
        setSources(new Map());
        setVisibleCount(ROWS_PER_PAGE);
        setTypes(previous=>{
          const next = new Map(previous);
          for (const event of result.events) if (!next.has(event.eventType)) next.set(event.eventType,event.source);
          return next.size===previous.size ? previous : next;
        });
      })
      .catch(cause=>{
        if (!controller.signal.aborted) setListError(errorText(cause,'HotWax could not load the inventory ledger.'));
      })
      .finally(()=>{if (!controller.signal.aborted) setReading(false);});
    return ()=>controller.abort();
  },[connected,location,canRead,itemId,filter,within,reload]);

  useEffect(()=>{
    if (!connected || !location) return;
    const missing = visibleEvents.slice(0,visibleCount).filter(event=>event.reference && !sources.has(eventSourceKey(event)));
    if (!missing.length) return;
    const controller = new AbortController();
    inventoryEventSources(location,missing,controller.signal).then(result=>{
      if (!controller.signal.aborted) setSources(previous=>new Map([...previous,...result]));
    }).catch(()=>{});
    return ()=>controller.abort();
  },[connected,location,events,visibleCount]);

  // A failed batch's reason, for the few failed rows on a product's page.
  useEffect(()=>{
    if (!itemId || !connected || !location) return;
    const failed = [...new Set(events.filter(event=>event.state==='Error' && !errors.has(event.messageId)).map(event=>event.messageId))].slice(0,5);
    if (!failed.length) return;
    const controller = new AbortController();
    Promise.all(failed.map(id=>deliveryErrors(location,id,controller.signal)
      .then(found=>[id,found[0]?.text ?? ''] as const).catch(()=>[id,''] as const)))
      .then(found=>{if (!controller.signal.aborted) setErrors(previous=>new Map([...previous,...found]));});
    return ()=>controller.abort();
  },[itemId,connected,location,events]);

  const error = locationError || itemFilter?.error || listError;
  const loading = connected && !error && (!location || itemFilter?.loading || (canRead && reading));
  const empty = filter.status==='attention' ? 'No failed changes.' : filter.status==='unsent' ? 'Nothing waiting to be sent.' : 'No inventory changes in the last 5 days.';
  return <s-stack direction="block" gap="small" paddingBlock="base">
    <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
      <s-button variant="secondary" command="--show" commandFor={filtersId}>{changedFilters ? 'Filters · '+changedFilters : 'Filters'}</s-button>
      {canPush && <s-button variant="secondary" loading={pushing}
        disabled={!connected || loading || Boolean(error) || !batchIds.length || pushing || dimmingSent} onClick={pushNow}>Send now</s-button>}
    </s-stack>
    <EventFilters id={filtersId} filter={filter} within={within} types={types} onChange={(next,nextWithin)=>{
      setFilter(next);setWithin(nextWithin);
    }}/>
    {canPush && connected && !loading && !error && !pushResult && !pushing && <s-text type="small" color="subdued">
      {batchIds.length ? 'Send now delivers this product’s waiting batches. A batch carries its whole event, so other products in it are sent too.'
        : 'Nothing waiting to be sent for this product.'}
    </s-text>}
    {pushResult && <s-banner tone={pushResult.error?'warning':'success'}
      heading={pushResult.error || 'Waiting changes sent to Shopify'}/>}
    {error && <Warning reason={error}/>}
    {loading && <Loading label="Loading inventory events…"/>}
    {!loading && connected && !error && !visibleEvents.length && !pushResult && <s-text color="subdued">{empty}</s-text>}
    {visibleEvents.slice(0,visibleCount).map(event=>{
      const source = sources.get(eventSourceKey(event));
      const record = source?.name || [event.source,event.reference].filter(Boolean).join(' ');
      const product = event.product ?? {itemId:event.itemId,title:'Item not in the Shopify catalog'};
      const failure = failureDetail(event,errors,now);
      return <Row key={event.id}
        title={itemFilter ? record : product.title}
        subtitle={itemFilter ? source?.actor : productLabel(product)}
        detail={itemFilter ? failure : [record,source?.actor,failure].filter(Boolean).join(' · ')}
        timing={eventTiming(event,now)} imageUrl={productImageUrl ?? product.imageUrl ?? ''} value={signed(event.delta)}
        stateLabel={STATE_LABELS[event.state]} tone={stateTone(event.state)}
        dimmed={dimmingSent && activeBatchIds.has(event.messageId)}
        onClick={openProduct ? ()=>openProduct(product,'events') : undefined}/>;
    })}
    {visibleCount < visibleEvents.length && <LoadMore onClick={()=>setVisibleCount(count=>count+ROWS_PER_PAGE)}/>}
    {more && visibleCount >= visibleEvents.length && <s-text type="small" color="subdued">
      Showing the first 500 matching events. Narrow the filters to see the rest.
    </s-text>}
  </s-stack>;
}

export function useProposedVarianceRead(store: Store, productId: string | undefined, enabled: boolean): VarianceRead {
  const {connected,location,locationError} = store;
  const [result,setResult] = useState<{location: Location; productId?: string; data?: ProposedVariance[]; error?: string}>();
  useEffect(()=>{
    if (!connected || !location || !enabled) return;
    const controller = new AbortController();
    setResult(undefined);
    proposedVariances(location,controller.signal,productId)
      .then(data=>{if (!controller.signal.aborted) setResult({location,productId,data});})
      .catch(cause=>{
        if (!controller.signal.aborted) setResult({location,productId,error:errorText(cause,'HotWax could not load counts awaiting approval.')});
      });
    return ()=>controller.abort();
  },[connected,location,enabled,productId]);

  const current = enabled && result && result.location===location && result.productId===productId ? result : undefined;
  return {data:current?.data,error:locationError || current?.error,loading:enabled && connected && !locationError && !current};
}

type ProductGroup = {product: ProposedVariance['product']; proposals: ProposedVariance[]; lastUpdatedAt: number | null};

function ProposedVarianceList({store,filter,openProduct,productImageUrl,varianceRead}: {
  store: Store; filter?: ListFilter; openProduct?: OpenProduct; productImageUrl?: string; varianceRead?: VarianceRead;
}) {
  const {connected,location} = store;
  const homeRead = useProposedVarianceRead(store,undefined,!varianceRead);
  const read = varianceRead ?? homeRead;
  const proposals = read.data ?? [];
  const [visibleCount,setVisibleCount] = useState(ROWS_PER_PAGE);
  const now = useNow();
  useEffect(()=>setVisibleCount(ROWS_PER_PAGE),[read.data]);
  const waiting = (at: number | null) => at && at<=now ? 'Waiting '+duration(now-at) : 'Wait time unavailable';

  const groups = new Map<string,ProductGroup>();
  for (const proposal of proposals) {
    const group = groups.get(proposal.product.hotWaxProductId) ?? {product:proposal.product,proposals:[],lastUpdatedAt:null};
    group.proposals.push(proposal);
    if (proposal.lastUpdatedAt!==null) group.lastUpdatedAt = Math.min(group.lastUpdatedAt ?? proposal.lastUpdatedAt,proposal.lastUpdatedAt);
    groups.set(proposal.product.hotWaxProductId,group);
  }

  const error = filter?.error || read.error;
  const loading = connected && !error && (!location || filter?.loading || read.loading);
  return <s-stack direction="block" gap="small" paddingBlock="base">
    {error && <Warning reason={error}/>}
    {loading && <Loading label="Loading counts awaiting approval…"/>}
    {!loading && connected && !error && !proposals.length && <s-text color="subdued">No count changes awaiting approval.</s-text>}
    {filter && proposals.length>1 && <Warning reason={proposals.length+' counts of this product are awaiting approval. Each approval applies its own difference, so approve one and discard the others in HotWax.'}/>}
    {filter ? proposals.slice(0,visibleCount).map(({id,countName,counted,delta,lastUpdatedAt})=>
      <Row key={id} title={countName} detail={'Counted '+counted+' · HotWax had '+(counted-delta)}
        timing={waiting(lastUpdatedAt)} imageUrl={productImageUrl ?? ''} value={signed(delta)}/>)
    : [...groups.values()].slice(0,visibleCount).map(({product,proposals:counts,lastUpdatedAt})=>{
      const single = counts.length===1 ? counts[0] : undefined;
      return <Row key={product.hotWaxProductId} title={product.title}
        subtitle={[productLabel(product),product.inShopify ? '' : 'Not in this Shopify shop'].filter(Boolean).join(' · ')}
        detail={single ? single.countName+' · counted '+single.counted : counts.length+' counts: '+counts.map(count=>count.countName+' ('+count.counted+')').join(', ')}
        timing={waiting(lastUpdatedAt)} imageUrl={product.imageUrl ?? ''}
        value={single ? signed(single.delta) : undefined}
        stateLabel={single ? undefined : 'Counts overlap'} tone={single ? undefined : 'warning'}
        onClick={openProduct ? ()=>openProduct(product,'proposals') : undefined}/>;
    })}
    {visibleCount < (filter ? proposals.length : groups.size) && <LoadMore onClick={()=>setVisibleCount(count=>count+ROWS_PER_PAGE)}/>}
  </s-stack>;
}

function PosSales({sales,connected}: {sales: SalesRead; connected: boolean}) {
  const now = useNow();
  const [visibleCount,setVisibleCount] = useState(ROWS_PER_PAGE);
  const [showImported,setShowImported] = useState(false);
  const data = sales.data;
  const orders = data?.orders ?? [];
  const visibleOrders = showImported ? orders : orders.filter(order=>!order.synced);
  const window = data && data.windowMs>=24*60*60*1000 ? 'the last day' : 'the last hour';
  return <s-stack direction="block" gap="small" paddingBlock="base">
    <s-switch label="Show imported orders" checked={showImported} onChange={event=>{
      setShowImported(Boolean(event.currentTarget.checked));setVisibleCount(ROWS_PER_PAGE);
    }}/>
    {connected && sales.loading && <Loading label="Checking POS orders…"/>}
    {sales.error && <Warning reason={sales.error}/>}
    {data && <>
      <s-text type="strong">{data.pendingCount
        ? data.pendingCount+(data.pendingCount===1?' POS order':' POS orders')+' waiting for HotWax'
        : 'No POS orders waiting for HotWax'}</s-text>
      <s-text type="small" color="subdued">POS orders with this product from {window} · Checked {ago(data.checkedAt,now)}</s-text>
      {visibleOrders.slice(0,visibleCount).map(order=>{
        const impact = order.impact;
        const change = impact && (impact.atp || impact.onHand)
          ? 'Available −'+impact.atp+' · On hand −'+impact.onHand : 'No change for this product';
        const state = order.synced ? 'Imported' : order.cancelled ? 'Cancelled' : 'Waiting';
        return <Row key={order.id} title={order.name} stateLabel={state} tone={order.synced ? 'success' : 'neutral'}
          detail={order.synced || order.cancelled ? undefined : impact ? change : 'Product quantity unavailable'}
          timing={'Created '+ago(order.createdAt,now)}/>;
      })}
      {visibleCount < visibleOrders.length && <LoadMore onClick={()=>setVisibleCount(count=>count+ROWS_PER_PAGE)}/>}
    </>}
  </s-stack>;
}
