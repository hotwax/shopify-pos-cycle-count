import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {availableTarget, commitInventoryReview, INVENTORY_OMS, inventoryScope, sameInventoryScope} from '../../../shared/store-inventory';
import type {InventoryDetail, InventoryEffect, InventoryOperation, InventoryProduct, InventoryReview, InventoryScope} from '../../../shared/store-inventory';
import {getShopOmsUrl} from '../../../shared/oms-shop-config';

type Access = {accessToken: string; locationName: string; timeZone?: string; canPush: boolean; canSet: boolean};
type ProductPage = {items: InventoryProduct[]; cursor?: string | null};
type Screen = 'list' | 'detail' | 'edit' | 'review' | 'status';
type Responses = {
  signIn: Access; queue: ProductPage; search: ProductPage; detail: InventoryDetail;
  preview: InventoryReview; commit: InventoryOperation; status: InventoryOperation; retry: InventoryOperation;
};

const endpoint = INVENTORY_OMS + '/rest/s1/pos-store-inventory';
const reasons = [['count','Count discrepancy'],['damage','Damaged or missing units'],['other','Other']];
const effectStates = {queued:'Queued',produced:'Ready to send',sending:'Sending',needsAttention:'Needs attention',confirmed:'Confirmed',discarded:'Discarded'};
const operationStates = {
  review:'Review still open',expired:'Review expired',queued:'Queued for Shopify',saved:'Saved in HotWax',
  sending:'Sending to Shopify',needsAttention:'Shopify needs attention',confirmed:'Shopify confirmed',unknown:'Checking update status',
};

function currentScope() {
  return inventoryScope({...shopify.session.currentSession, staffId: shopify.session.staffMember.value?.id});
}
function scopeKey() {
  try {return JSON.stringify(currentScope());} catch {return '';}
}
const units = (value: number | null) => value == null ? 'Unavailable' : String(value);
const signed = (value: number) => (value > 0 ? '+' : '') + value;
const titleFor = (item: InventoryProduct) => [item.variant, item.sku].filter(Boolean).join(' · ');
const timeAt = (value?: string, zone?: string) => {
  if (!value) return '';
  const time = new Date(value);
  if (!Number.isFinite(time.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(undefined, {timeZone:zone, hour:'numeric', minute:'2-digit', timeZoneName:'short'}).format(time);
  } catch {
    return time.toISOString();
  }
};
const timingFor = (product: InventoryProduct, zone?: string) => product.estimatedFrom && product.estimatedTo
  ? 'Estimated ' + timeAt(product.estimatedFrom, zone) + ' – ' + timeAt(product.estimatedTo, zone)
  : product.timing;

export default () => render(<Extension/>, document.body);

function Extension() {
  const [owner,setOwner] = useState(scopeKey);
  useEffect(() => {
    const check = () => setOwner(scopeKey());
    const unsubscribe = shopify.session.staffMember.subscribe(check);
    const timer = setInterval(check, 1500);
    return () => {unsubscribe();clearInterval(timer);};
  }, []);
  return <s-page heading="Store inventory">
    {owner ? <Workspace key={owner} scope={JSON.parse(owner)}/> :
      <s-section><s-banner tone="warning" heading="Open the Gorjana sandbox and pin in to view store inventory."/></s-section>}
  </s-page>;
}

function Workspace({scope}: {scope: InventoryScope}) {
  const [session,setSession] = useState<Access | null>(null);
  const [showAccessDetails,setShowAccessDetails] = useState(false);
  const [connected,setConnected] = useState(shopify.connectivity.current.value.internetConnected === 'Connected');
  const [screen,setScreen] = useState<Screen>('list');
  const [items,setItems] = useState<InventoryProduct[]>([]);
  const [detail,setDetail] = useState<InventoryDetail | null>(null);
  const [review,setReview] = useState<InventoryReview | null>(null);
  const [operation,setOperation] = useState<InventoryOperation | null>(null);
  const [input,setInput] = useState('');
  const [search,setSearch] = useState('');
  const [cursor,setCursor] = useState<string | null>(null);
  const [quantity,setQuantity] = useState('');
  const [reason,setReason] = useState('');
  const [note,setNote] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(false);
  const [error,setError] = useState('');
  const [listError,setListError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  const configured = useRef(false);
  const [refresh,setRefresh] = useState(0);
  const ownerKey = 'store-inventory:last-operation:' + [scope.shopId,scope.locationId,scope.userId,scope.staffId].join(':');

  useEffect(() => () => {alive.current=false;}, []);
  useEffect(() => shopify.connectivity.current.subscribe(state => setConnected(state.internetConnected === 'Connected')), []);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 260);
    return () => clearTimeout(timer);
  }, [input]);

  function assertScope() {
    if (!alive.current || !sameInventoryScope(scope, currentScope())) {
      throw new Error('POS staff or location changed. Reopen Store inventory.');
    }
    if (shopify.connectivity.current.value.internetConnected !== 'Connected') {
      throw new Error('Connect to the internet and try again.');
    }
  }

  async function request<Action extends keyof Responses>(
    action: Action, payload: Record<string, unknown> = {}, signal?: AbortSignal, access = session?.accessToken,
  ): Promise<Responses[Action]> {
    assertScope();
    const timeout = AbortSignal.timeout(22000);
    const requestSignal = signal ? AbortSignal.any([signal,timeout]) : timeout;
    if (!configured.current) {
      const origin = await getShopOmsUrl(requestSignal);
      if (origin !== INVENTORY_OMS) throw new Error('Set the app connection to Gorjana Maarg UAT.');
      configured.current = true;
    }
    const shopifySessionToken = await shopify.session.getSessionToken();
    if (!shopifySessionToken) throw new Error('Shopify could not authorize this app. Reopen Store inventory.');
    assertScope();
    const response = await fetch(endpoint, {
      method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},redirect:'error',
      body:JSON.stringify({action,locationId:scope.locationId,staffId:scope.staffId,shopifySessionToken,accessToken:access,payload}),
      signal:requestSignal,
    });
    if (!response.ok) throw new Error('HotWax could not complete the request. Check the connection and try again.');
    const result = await response.json() as {error?: string; message?: string; inventoryResponse?: Responses[Action]};
    assertScope();
    if (result.error) {
      if (result.error === 'ACCESS_EXPIRED') setSession(null);
      throw new Error(result.message || 'HotWax could not complete the request.');
    }
    if (!result.inventoryResponse) throw new Error('HotWax returned an incomplete inventory response.');
    return result.inventoryResponse;
  }

  function signIn() {
    shopify.pinPad.showPinPad(async digits => {
      try {
        const access = await request('signIn',{code:digits.join('')});
        setError('');
        setSession(access);
        const operationId = await shopify.storage.get(ownerKey).catch(() => null);
        if (typeof operationId === 'string' && alive.current) {
          request('status',{operationId},undefined,access.accessToken)
            .then(result=>{if(alive.current)setOperation(result);})
            .catch(()=>{if(alive.current)setOperation({operationId,state:'unknown'});});
        }
        return {result:'accept'};
      } catch (cause) {
        return {result:'reject',errorMessage:cause instanceof Error ? cause.message : 'Could not verify access.'};
      }
    }, {title:'Store inventory access',label:'Enter your HotWax inventory access code',minPinLength:8,maxPinLength:10,masked:true});
  }

  useEffect(() => {
    if (!session || !connected || screen !== 'list') return;
    const controller = new AbortController();
    setLoading(true);
    setListError('');
    setItems([]);
    setCursor(null);
    request(search ? 'search' : 'queue',{search},controller.signal)
      .then(result=>{if(!controller.signal.aborted){setItems(result.items);setCursor(result.cursor ?? null);}})
      .catch(cause=>{if(!controller.signal.aborted)setListError(cause.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return () => controller.abort();
  }, [session,connected,screen,search,refresh]);

  async function run(task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current=true;
    setBusy(true);
    setError('');
    try {await task();}
    catch(cause) {if(alive.current)setError(cause instanceof Error ? cause.message : 'Could not complete the request.');}
    finally {inFlight.current=false;if(alive.current)setBusy(false);}
  }

  function openProduct(itemId: string) {
    return run(async () => {
      setDetail(await request('detail',{itemId}));
      setQuantity('');
      setReason('');
      setNote('');
      setReview(null);
      setScreen('detail');
    });
  }

  function scanCode(code: string) {
    if (screen !== 'list' || !session || inFlight.current) return;
    return run(async () => {
      const result = await request('search',{search:code,barcode:true});
      if (result.items.length === 1 && !result.cursor) {
        setDetail(await request('detail',{itemId:result.items[0].itemId}));
        setQuantity('');setReason('');setNote('');setReview(null);setScreen('detail');
      } else {
        setInput(code);
        setSearch(code);
        setRefresh(value=>value+1);
      }
    });
  }

  useEffect(() => {
    if (!session || screen !== 'list') return;
    let previous = shopify.scanner.scannerData.current.value;
    let lastCode = '';
    let lastAt = 0;
    const unsubscribe = shopify.scanner.scannerData.current.subscribe(scan => {
      if (!scan?.data || scan === previous) return;
      previous=scan;
      const code=scan.data.trim();
      if (!code || (code === lastCode && Date.now()-lastAt < 250)) return;
      lastCode=code;lastAt=Date.now();
      if (scan.source === 'camera') shopify.scanner.hideCameraScanner();
      scanCode(code);
    });
    return () => {unsubscribe();shopify.scanner.hideCameraScanner();};
  }, [session,screen]);

  function preview(action: 'push' | 'set') {
    return run(async () => {
      if (!detail) return;
      const payload: Record<string, unknown> = {itemId:detail.itemId,mode:action};
      if (action === 'set') {
        payload.target = availableTarget(quantity);
        if (!reason) throw new Error('Choose a reason.');
        if (reason === 'other' && !note.trim()) throw new Error('Enter a note for Other.');
        Object.assign(payload,{reason,note:note.trim()});
      }
      setReview(await request('preview',payload));
      setScreen('review');
    });
  }

  function status(id: string) {
    return request('status',{operationId:id});
  }

  function confirm() {
    return run(async () => {
      if (!review) return;
      const result = await commitInventoryReview(review.operationId, {
        remember:id=>shopify.storage.set(ownerKey,id),
        commit:operationId=>request('commit',{operationId}),
        status,
      });
      setOperation(result);
      if (result.state === 'expired') {
        setError(result.message || 'The inventory review expired. Review the current values.');
        setScreen(review.action === 'set' ? 'edit' : 'detail');
      } else {
        setScreen('status');
      }
    });
  }

  async function reloadOperation() {
    return run(async () => {
      if (!operation) return;
      setOperation(await status(operation.operationId));
      setScreen('status');
    });
  }

  useEffect(() => {
    if (screen !== 'status' || !session || !connected || !operation || !['queued','saved','sending','unknown'].includes(operation.state)) return;
    const controller=new AbortController();
    const timer=setTimeout(()=>{
      request('status',{operationId:operation.operationId},controller.signal)
        .then(result=>{if(!controller.signal.aborted)setOperation(result);})
        .catch(()=>{if(!controller.signal.aborted)setOperation({...operation,state:'unknown'});});
    }, 2500);
    return ()=>{controller.abort();clearTimeout(timer);};
  }, [screen,operation,session,connected]);

  if (!session) return <s-section heading="Sign in to Store inventory">
    <s-stack direction="block" gap="base">
      <s-text>Use your HotWax inventory access code for this location.</s-text>
      {!connected && <s-banner tone="warning" heading="POS is offline"/>}
      <s-button variant="primary" disabled={!connected} onClick={signIn}>Enter access code</s-button>
      <s-button variant="secondary" onClick={()=>setShowAccessDetails(shown=>!shown)}>
        {showAccessDetails ? 'Hide access details' : 'Access details'}
      </s-button>
      {showAccessDetails && <s-stack direction="block" gap="small">
        <s-text color="subdued">Share these references with the HotWax administrator who issues your access code.</s-text>
        <s-text>Shopify location {scope.locationId}</s-text>
        <s-text>Shopify account {scope.userId}</s-text>
        <s-text>POS staff {scope.staffId}</s-text>
      </s-stack>}
    </s-stack>
  </s-section>;

  return <s-scroll-box><s-stack direction="block" gap="base">
    <s-section><s-stack direction="inline" gap="base" alignItems="center">
      <s-text type="strong">{session.locationName}</s-text>
      {!session.canPush && !session.canSet && <s-badge>View only</s-badge>}
    </s-stack></s-section>
    {!connected && <s-banner tone="warning" heading="POS is offline">Reconnect for current quantities and actions.</s-banner>}
    {error && <s-banner tone="critical" heading={error}/>}
    {screen === 'list' && <>
      <s-section heading="Find a product"><s-stack direction="block" gap="base">
        <s-text-field label="Search the catalog" placeholder="Name, SKU or barcode" value={input} onInput={e=>setInput(e.currentTarget.value ?? '')}/>
        <s-text color="subdued">Use a connected barcode scanner or search the catalog.</s-text>
        <s-stack direction="inline" gap="base">
          <s-button disabled={!connected || busy} onClick={()=>shopify.scanner.showCameraScanner()}>Scan with camera</s-button>
          <s-button disabled={!connected || busy} onClick={()=>setRefresh(value=>value+1)}>Refresh</s-button>
        </s-stack>
      </s-stack></s-section>
      {operation && <s-section heading="Recent update">
        <s-button disabled={busy} onClick={()=>setScreen('status')}>{operationStates[operation.state]} · {operation.operationId}</s-button>
      </s-section>}
      <s-section heading={search ? 'Catalog results' : 'Inventory queue'}>
        <s-stack direction="block" gap="base">
          {listError && <s-banner tone="warning" heading={listError}/>}
          {loading && <s-spinner accessibilityLabel={search ? 'Finding products' : 'Loading inventory queue'}/>}
          {!loading && !listError && connected && items.length === 0 &&
            <s-text color="subdued">{search ? 'No products match this search.' : 'No events are waiting to reach Shopify at this location.'}</s-text>}
          {items.map(item=><s-clickable key={item.itemId} disabled={busy || !connected} onClick={()=>openProduct(item.itemId)}>
            <s-box padding="base" minBlockSize="64px"><s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base">
              <s-stack direction="block" gap="small"><s-text type="strong">{item.title}</s-text><s-text color="subdued">{titleFor(item)}</s-text>
                <s-text>Shopify available {units(item.available)} · After queue {units(item.projectedAvailable)}</s-text>
                <s-text color="subdued">{timingFor(item,session.timeZone)}</s-text>
                {item.checkedAt && <s-text color="subdued">Checked {timeAt(item.checkedAt,session.timeZone)}</s-text>}
              </s-stack><s-icon type="chevron-right"/>
            </s-stack></s-box>
          </s-clickable>)}
          {cursor && <s-button disabled={busy || loading || !connected} onClick={()=>run(async()=>{
            const result=await request(search?'search':'queue',{search,cursor});
            setItems(previous=>[...previous,...result.items.filter(item=>!previous.some(p=>p.itemId===item.itemId))]);
            setCursor(result.cursor??null);
          })}>Load more</s-button>}
        </s-stack>
      </s-section>
    </>}
    {screen === 'detail' && detail && <>
      <s-section><s-button disabled={busy} onClick={()=>setScreen('list')}>Back to inventory</s-button></s-section>
      <s-section heading={detail.title}><s-stack direction="block" gap="base">
        <s-text color="subdued">{titleFor(detail)}</s-text>
        <s-text type="strong">Shopify available {units(detail.available)} · After queue {units(detail.projectedAvailable)}</s-text>
        {detail.checkedAt && <s-text color="subdued">Checked {timeAt(detail.checkedAt,session.timeZone)}</s-text>}
        <s-text>{timingFor(detail,session.timeZone)}</s-text>
        <s-text>On hand {units(detail.onHand)} · Committed {units(detail.committed)} · Other unavailable {units(detail.unavailable)}</s-text>
        <s-text>HotWax facility ATP {units(detail.atp)}</s-text>
      </s-stack></s-section>
      <s-section heading="Pending events">
        {detail.events.length ? <Events rows={detail.events} zone={session.timeZone}/> : <s-text>No pending events for this variant at this location.</s-text>}
      </s-section>
      <s-section heading="Inventory actions"><s-stack direction="block" gap="base">
        {detail.pushBlocked && <s-text color="subdued">{detail.pushBlocked}</s-text>}
        <s-button variant="primary" disabled={busy || !connected || !session.canPush || Boolean(detail.pushBlocked)} onClick={()=>preview('push')}>Review push now</s-button>
        {detail.setBlocked && <s-text color="subdued">{detail.setBlocked}</s-text>}
        <s-button disabled={busy || !connected || !session.canSet || Boolean(detail.setBlocked)} onClick={()=>setScreen('edit')}>
          {detail.events.length ? 'Discard and set' : 'Set available'}
        </s-button>
      </s-stack></s-section>
    </>}
    {screen === 'edit' && detail && <s-section heading={'Set Shopify available · '+detail.title}>
      <s-stack direction="block" gap="base">
        <s-number-field label="New Shopify available" min={0} max={2147483647} controls="none" inputMode="numeric" value={quantity} onInput={e=>setQuantity(e.currentTarget.value ?? '')}/>
        <s-text>Reason</s-text>
        <s-choice-list values={reason?[reason]:[]} onChange={e=>setReason(e.currentTarget.values?.[0] ?? '')}>
          {reasons.map(([key,label])=><s-choice key={key} value={key}>{label}</s-choice>)}
        </s-choice-list>
        <s-text-field label={reason==='other'?'Note (required)':'Note (optional)'} maxLength={300} value={note} onInput={e=>setNote(e.currentTarget.value ?? '')}/>
        <s-stack direction="inline" gap="base">
          <s-button disabled={busy} onClick={()=>setScreen('detail')}>Back</s-button>
          <s-button variant="primary" disabled={busy || !connected} onClick={()=>preview('set')}>Review change</s-button>
        </s-stack>
      </s-stack>
    </s-section>}
    {screen === 'review' && review && detail && <s-section heading={review.action==='push'?'Review push now':'Review inventory change'}>
      <s-stack direction="block" gap="base">
        <s-text type="strong">{detail.title} · {titleFor(detail)}</s-text>
        <s-text>Shopify available {review.currentAvailable} → {review.targetAvailable}</s-text>
        <s-text>Shopify committed {review.committed}</s-text>
        {review.action==='set' && <>
          <s-text>HotWax facility ATP {review.currentAtp} → {review.targetAvailable}</s-text>
          <s-text type="strong">HotWax variance {signed(review.variance)} units</s-text>
          {review.onHandVariance!=null && <s-text>HotWax on-hand variance {signed(review.onHandVariance)} units</s-text>}
          <s-text>HotWax saves the variance and requests one Shopify reset for this item.</s-text>
        </>}
        {review.effects.length > 0 && <>
          <s-text type="strong">{review.action==='push'?'Effects to send':'Pending effects to discard'}</s-text>
          <Events rows={review.effects} zone={session.timeZone}/>
        </>}
        <s-stack direction="inline" gap="base">
          <s-button disabled={busy} onClick={()=>setScreen(review.action==='set'?'edit':'detail')}>Back</s-button>
          <s-button variant="primary" disabled={busy || !connected} onClick={confirm}>{review.action==='push'?'Push now':'Set Shopify available to '+review.targetAvailable}</s-button>
        </s-stack>
      </s-stack>
    </s-section>}
    {screen === 'status' && operation && <s-section heading={operationStates[operation.state]}>
      <s-stack direction="block" gap="base">
        <s-text>Reference {operation.operationId}</s-text>
        {operation.action==='set' && ['saved','sending','needsAttention','confirmed'].includes(operation.state) &&
          <s-text>Saved in HotWax</s-text>}
        {operation.state==='confirmed' && <s-text>{operation.targetAvailable} available · Confirmed {timeAt(operation.confirmedAt,session.timeZone)}</s-text>}
        {operation.message && <s-text>{operation.message}</s-text>}
        <s-stack direction="inline" gap="base">
          <s-button disabled={busy} onClick={()=>setScreen('list')}>Back to inventory</s-button>
          <s-button disabled={busy || !connected} onClick={reloadOperation}>Check status</s-button>
          {operation.canRetry && <s-button disabled={busy || !connected} onClick={()=>run(async()=>{
            setOperation(await request('retry',{operationId:operation.operationId}));
          })}>Retry Shopify delivery</s-button>}
        </s-stack>
      </s-stack>
    </s-section>}
  </s-stack></s-scroll-box>;
}

function Events({rows,zone}: {rows: InventoryEffect[]; zone?: string}) {
  return <s-stack direction="block" gap="base">{rows.map(row=><s-box key={row.id} padding="small">
    <s-stack direction="inline" gap="base" justifyContent="space-between">
      <s-stack direction="block" gap="small"><s-text type="strong">{row.source}</s-text><s-text color="subdued">{row.reference} · {timeAt(row.at,zone)}</s-text>
        {row.detail && <s-text color="subdued">{row.detail}</s-text>}
      </s-stack>
      <s-stack direction="block" gap="small"><s-text type="strong">{signed(row.delta)}</s-text><s-badge>{row.eligible?'Discard eligible':effectStates[row.state]}</s-badge></s-stack>
    </s-stack>
  </s-box>)}</s-stack>;
}
