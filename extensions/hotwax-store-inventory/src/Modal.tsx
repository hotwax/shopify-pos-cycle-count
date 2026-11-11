import '@shopify/ui-extensions/preact';
import {render} from 'preact';
import {useEffect, useRef, useState} from 'preact/hooks';
import {availableTarget, commitInventoryReview, INVENTORY_OMS, inventoryScope, mustRecoverInventoryOperation, sameInventoryScope} from '../../../shared/store-inventory';
import type {InventoryDetail, InventoryEffect, InventoryOperation, InventoryProduct, InventoryReview, InventoryScope} from '../../../shared/store-inventory';

type Access = {locationName: string; timeZone?: string; canPush: boolean; canSet: boolean};
type ProductPage = {items: InventoryProduct[]; cursor?: string | null};
type Screen = 'list' | 'detail' | 'edit' | 'review' | 'status';
type Responses = {
  access: Access; queue: ProductPage; search: ProductPage; detail: InventoryDetail;
  preview: InventoryReview; commit: InventoryOperation; status: InventoryOperation; retry: InventoryOperation;
};

const endpoint = INVENTORY_OMS + '/rest/s1/pos-store-inventory';
const reasons = [['count','Count discrepancy'],['damage','Damaged or missing units'],['other','Other']];
const effectStates = {queued:'Queued',produced:'Ready to send',sending:'Sending',needsAttention:'Needs attention',confirmed:'Confirmed',discarded:'Discarded'};
const operationStates = {
  review:'Review still open',expired:'Review expired',queued:'Queued for Shopify',saved:'Saved in HotWax',
  sending:'Sending to Shopify',needsAttention:'Shopify needs attention',confirmed:'Shopify confirmed',unknown:'Checking update status',
};

class InventoryRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

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
  if (owner) return <Workspace key={owner} scope={JSON.parse(owner)}/>;
  return <s-page heading="Store inventory">
    <s-box padding="large">
      <s-banner tone="warning" heading="Open the Gorjana sandbox in Shopify POS and pin in to continue."/>
    </s-box>
  </s-page>;
}

function Workspace({scope}: {scope: InventoryScope}) {
  const [session,setSession] = useState<Access | null>(null);
  const [accessError,setAccessError] = useState('');
  const [accessAttempt,setAccessAttempt] = useState(0);
  const [connected,setConnected] = useState(shopify.connectivity.current.value.internetConnected === 'Connected');
  const [screen,setScreen] = useState<Screen>('list');
  const [items,setItems] = useState<InventoryProduct[]>([]);
  const [detail,setDetail] = useState<InventoryDetail | null>(null);
  const [review,setReview] = useState<InventoryReview | null>(null);
  const [operation,setOperation] = useState<InventoryOperation | null>(null);
  const [input,setInput] = useState('');
  const [search,setSearch] = useState('');
  const [scannedBarcode,setScannedBarcode] = useState<string | null>(null);
  const [cursor,setCursor] = useState<string | null>(null);
  const [quantity,setQuantity] = useState('');
  const [reason,setReason] = useState('');
  const [note,setNote] = useState('');
  const [busy,setBusy] = useState(false);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [listError,setListError] = useState('');
  const inFlight = useRef(false);
  const alive = useRef(true);
  const [refresh,setRefresh] = useState(0);
  const ownerKey = 'store-inventory:last-operation:' + [scope.shopId,scope.locationId,scope.userId,scope.staffId].join(':');
  const catalogSearch = scannedBarcode ?? search;
  const recoverOperation = mustRecoverInventoryOperation(operation);
  const operationNote = operation?.lastConfirmed ? operation.outcomeNote : operation?.message;

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
    action: Action, payload: Record<string, unknown> = {}, signal?: AbortSignal,
  ): Promise<Responses[Action]> {
    assertScope();
    const timeout = AbortSignal.timeout(22000);
    const requestSignal = signal ? AbortSignal.any([signal,timeout]) : timeout;
    // This extension is sandbox-only. The UAT endpoint also verifies the app and shop on every request.
    const shopifySessionToken = await shopify.session.getSessionToken();
    if (!shopifySessionToken) throw new Error('Shopify could not authorize this app. Reopen Store inventory.');
    assertScope();
    const response = await fetch(endpoint, {
      method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},redirect:'error',
      body:JSON.stringify({action,locationId:scope.locationId,staffId:scope.staffId,shopifySessionToken,payload}),
      signal:requestSignal,
    });
    if (!response.ok) throw new Error('HotWax could not complete the request. Check the connection and try again.');
    const result = await response.json() as {error?: string; message?: string; inventoryResponse?: Responses[Action]};
    assertScope();
    if (result.error) {
      throw new InventoryRequestError(result.error, result.message || 'HotWax could not complete the request.');
    }
    if (!result.inventoryResponse) throw new Error('HotWax returned an incomplete inventory response.');
    return result.inventoryResponse;
  }

  useEffect(() => {
    if (!connected || session) return;
    const controller = new AbortController();
    setAccessError('');

    async function openWorkspace() {
      try {
        const access = await request('access',{},controller.signal);
        const rememberedId = await shopify.storage.get(ownerKey);
        if (controller.signal.aborted) return;

        setOperation(typeof rememberedId === 'string' ? {operationId:rememberedId,state:'unknown'} : null);
        setSession(access);
        if (typeof rememberedId === 'string') {
          status(rememberedId,controller.signal)
            .then(result=>{if (!controller.signal.aborted && alive.current) setOperation(result);})
            .catch(()=>{});
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setAccessError(cause instanceof Error ? cause.message : 'Could not open Store inventory.');
        }
      }
    }

    void openWorkspace();
    return () => controller.abort();
  }, [connected,accessAttempt]);

  useEffect(() => {
    if (!session || !connected || screen !== 'list') return;
    const controller = new AbortController();
    setLoading(true);
    setListError('');
    setItems([]);
    setCursor(null);
    request(catalogSearch ? 'search' : 'queue',{search:catalogSearch,barcode:scannedBarcode !== null},controller.signal)
      .then(result=>{if(!controller.signal.aborted){setItems(result.items);setCursor(result.cursor ?? null);}})
      .catch(cause=>{if(!controller.signal.aborted)setListError(cause.message);})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return () => controller.abort();
  }, [session,connected,screen,catalogSearch,scannedBarcode,refresh]);

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
        setScannedBarcode(code);
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
      if (recoverOperation) throw new Error('Check the previous update before starting a new review.');
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

  async function status(id: string, signal?: AbortSignal): Promise<InventoryOperation> {
    try {
      return await request('status',{operationId:id},signal);
    } catch (cause) {
      if (cause instanceof InventoryRequestError && cause.code === 'OPERATION_UNAVAILABLE') {
        return {operationId:id,state:'expired',message:cause.message};
      }
      throw cause;
    }
  }

  function saveReview(operationId: string) {
    return run(async () => {
      const result = await commitInventoryReview(operationId, {
        remember:id=>shopify.storage.set(ownerKey,id),
        commit:operationId=>request('commit',{operationId}),
        status,
      });
      setOperation(result);
      if (result.state === 'expired' && review?.operationId === operationId) {
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
      status(operation.operationId,controller.signal)
        .then(result=>{if(!controller.signal.aborted)setOperation(result);})
        .catch(()=>{if(!controller.signal.aborted)setOperation({...operation,state:'unknown'});});
    }, 2500);
    return ()=>{controller.abort();clearTimeout(timer);};
  }, [screen,operation,session,connected]);

  function goTo(next: Screen) {
    setError('');
    setScreen(next);
  }

  if (!session) return <s-page heading="Store inventory">
    <s-box padding="large">
      {!connected ? <s-banner tone="warning" heading="POS is offline">Connect to the internet to view inventory.</s-banner> :
        accessError ? <s-stack direction="block" gap="base">
          <s-banner tone="critical" heading="Store inventory unavailable">{accessError}</s-banner>
          <s-stack direction="inline">
            <s-button variant="secondary" onClick={()=>setAccessAttempt(attempt=>attempt+1)}>Try again</s-button>
          </s-stack>
        </s-stack> :
        <s-stack direction="inline" alignItems="center" gap="small">
          <s-spinner accessibilityLabel="Opening Store inventory"/>
          <s-text color="subdued">Opening Store inventory…</s-text>
        </s-stack>}
    </s-box>
  </s-page>;

  const viewOnly = !session.canPush && !session.canSet;
  const pushEnabled = session.canPush && !detail?.pushBlocked && !recoverOperation;
  const setEnabled = session.canSet && !detail?.setBlocked && !recoverOperation;
  const resultHeading = scannedBarcode ? 'Barcode matches' : catalogSearch ? 'Catalog results' : 'Inventory queue';
  const recentVisible = operation && (!catalogSearch || recoverOperation);

  return <s-page heading="Store inventory" subheading={session.locationName}>
    <s-scroll-box key={screen}>
      <s-box padding="large">
        <s-stack direction="block" gap="large">
          {!connected && <s-banner tone="warning" heading="POS is offline">Reconnect for current quantities and actions.</s-banner>}
          {error && <s-banner tone="critical" heading="Unable to complete action">{error}</s-banner>}
          {screen === 'list' && <>
            <s-stack direction="inline" alignItems="center" gap="base">
              <s-box inlineSize="100%">
                <s-search-field id="inventory-search" placeholder="Search by name, SKU or barcode" value={input} onInput={e=>{
                  setScannedBarcode(null);
                  setInput(e.currentTarget.value ?? '');
                }}/>
              </s-box>
              <s-button variant="secondary" disabled={!connected || busy} onClick={()=>shopify.scanner.showCameraScanner()}>Scan</s-button>
            </s-stack>
            <s-section heading={resultHeading}>
              <s-button slot="secondary-actions" variant="secondary" disabled={!connected || busy || loading} onClick={()=>setRefresh(value=>value+1)}>Refresh</s-button>
              <s-stack direction="block" gap="small">
                {viewOnly && <s-box paddingBlock="small"><s-badge>View only</s-badge></s-box>}
                {listError && <s-banner tone="warning" heading="Inventory could not be loaded">{listError}</s-banner>}
                {loading && connected && <s-stack direction="inline" gap="small" alignItems="center" paddingBlock="base">
                  <s-spinner accessibilityLabel={catalogSearch ? 'Finding products' : 'Loading inventory queue'}/>
                  <s-text color="subdued">{catalogSearch ? 'Finding products…' : 'Loading inventory queue…'}</s-text>
                </s-stack>}
                {!loading && !listError && connected && items.length === 0 && <s-box paddingBlock="base">
                  <s-stack direction="inline" gap="base" alignItems="center">
                    <s-icon type={catalogSearch ? 'search' : 'inventory-list'} color="subdued"/>
                    <s-stack direction="block" gap="small-300">
                      <s-text type="strong">{catalogSearch ? 'No matching products' : 'No pending inventory updates'}</s-text>
                      <s-text color="subdued">{catalogSearch ? 'Try another name, SKU or barcode.' : 'Search the catalog to check a product at this location.'}</s-text>
                    </s-stack>
                  </s-stack>
                </s-box>}
                {items.map(item=><s-stack direction="block" key={item.itemId}>
                  <s-divider/>
                  <s-clickable disabled={busy || !connected} onClick={()=>openProduct(item.itemId)}>
                    <s-stack direction="inline" alignItems="center" justifyContent="space-between" gap="base" paddingBlock="base" paddingInline="small">
                      <s-stack direction="block" gap="small-300">
                        <s-text type="strong">{item.title}</s-text>
                        {titleFor(item) && <s-text type="small" color="subdued">{titleFor(item)}</s-text>}
                        <s-text type="small">Shopify available {units(item.available)} · After queue {units(item.projectedAvailable)}</s-text>
                        <s-text type="small" color="subdued">{timingFor(item,session.timeZone)}</s-text>
                        {item.checkedAt && <s-text type="small" color="subdued">Checked {timeAt(item.checkedAt,session.timeZone)}</s-text>}
                      </s-stack>
                      <s-icon type="chevron-right" color="subdued"/>
                    </s-stack>
                  </s-clickable>
                </s-stack>)}
                {cursor && <s-stack direction="inline">
                  <s-button variant="secondary" disabled={busy || loading || !connected} onClick={()=>run(async()=>{
                    const result=await request(catalogSearch?'search':'queue',{search:catalogSearch,barcode:scannedBarcode !== null,cursor});
                    setItems(previous=>[...previous,...result.items.filter(item=>!previous.some(p=>p.itemId===item.itemId))]);
                    setCursor(result.cursor??null);
                  })}>Load more</s-button>
                </s-stack>}
              </s-stack>
            </s-section>
            {recentVisible && operation && <s-section heading={recoverOperation ? 'Update needs review' : 'Recent update'}>
              <s-divider/>
              <s-clickable disabled={busy} onClick={()=>goTo('status')}>
                <s-stack direction="inline" justifyContent="space-between" alignItems="center" paddingBlock="base" paddingInline="small" gap="base">
                  <s-stack direction="block" gap="small-300">
                    <s-text type="strong">{operationStates[operation.state]}</s-text>
                    {operation.state==='confirmed' && <s-text type="small" color="subdued">
                      {operation.targetAvailable} available · {timeAt(operation.confirmedAt,session.timeZone)}
                    </s-text>}
                  </s-stack>
                  <s-icon type="chevron-right" color="subdued"/>
                </s-stack>
              </s-clickable>
            </s-section>}
          </>}
          {screen === 'detail' && detail && <>
            <BackLink disabled={busy} label={catalogSearch ? 'Catalog results' : 'Inventory queue'} onClick={()=>goTo('list')}/>
            <ProductHeading item={detail}/>
            <s-section heading="Shopify available">
              <s-stack direction="block" gap="small">
                <s-divider/>
                <s-stack direction="inline" gap="large" paddingBlock="small">
                  <Quantity label="Now" value={detail.available}/>
                  <Quantity label="After queue" value={detail.projectedAvailable}/>
                </s-stack>
                <s-text type="small" color="subdued">{[
                  detail.checkedAt ? 'Checked '+timeAt(detail.checkedAt,session.timeZone) : '',
                  timingFor(detail,session.timeZone),
                ].filter(Boolean).join(' · ')}</s-text>
                <s-divider/>
                <s-text type="small">
                  On hand {units(detail.onHand)} · Committed {units(detail.committed)} · Other unavailable {units(detail.unavailable)} · HotWax ATP {units(detail.atp)}
                </s-text>
              </s-stack>
            </s-section>
            <s-section heading="Pending events">
              {detail.events.length ? <Events rows={detail.events} zone={session.timeZone}/> :
                <s-box paddingBlock="small"><s-text color="subdued">No pending events for this variant.</s-text></s-box>}
            </s-section>
            <s-section heading="Inventory actions">
              <s-stack direction="block" gap="small">
                {viewOnly && <s-badge>View only</s-badge>}
                {recoverOperation && <s-stack direction="inline">
                  <s-button variant="secondary" disabled={busy} onClick={()=>goTo('status')}>Check previous update</s-button>
                </s-stack>}
                <s-stack direction="inline" gap="base">
                  <s-button variant={pushEnabled ? 'primary' : 'secondary'} disabled={busy || !connected || !pushEnabled} onClick={()=>preview('push')}>Review push now</s-button>
                  <s-button variant={!pushEnabled && setEnabled ? 'primary' : 'secondary'} disabled={busy || !connected || !setEnabled} onClick={()=>goTo('edit')}>
                    {detail.events.length ? 'Discard and set' : 'Set available'}
                  </s-button>
                </s-stack>
                {session.canPush && detail.pushBlocked && <s-text type="small" color="subdued">{detail.pushBlocked}</s-text>}
                {session.canSet && detail.setBlocked && detail.setBlocked !== detail.pushBlocked && <s-text type="small" color="subdued">{detail.setBlocked}</s-text>}
              </s-stack>
            </s-section>
          </>}
          {screen === 'edit' && detail && <>
            <BackLink disabled={busy} label="Product details" onClick={()=>goTo('detail')}/>
            <ProductHeading item={detail}/>
            <s-section heading="Set Shopify available">
              <s-stack direction="block" gap="base" maxInlineSize="640px">
                <s-text color="subdued">Current Shopify available {units(detail.available)}</s-text>
                <s-box maxInlineSize="240px">
                  <s-number-field label="New Shopify available" min={0} max={2147483647} controls="none" inputMode="numeric" value={quantity} onInput={e=>setQuantity(e.currentTarget.value ?? '')}/>
                </s-box>
                <s-stack direction="block" gap="small">
                  <s-text type="strong">Reason</s-text>
                  <s-choice-list values={reason?[reason]:[]} onChange={e=>setReason(e.currentTarget.values?.[0] ?? '')}>
                    {reasons.map(([key,label])=><s-choice key={key} value={key}>{label}</s-choice>)}
                  </s-choice-list>
                </s-stack>
                <s-text-field label={reason==='other'?'Note (required)':'Note (optional)'} maxLength={300} value={note} onInput={e=>setNote(e.currentTarget.value ?? '')}/>
                <s-stack direction="inline">
                  <s-button variant="primary" disabled={busy || !connected || !quantity.trim() || !reason || (reason==='other' && !note.trim())} onClick={()=>preview('set')}>Review change</s-button>
                </s-stack>
              </s-stack>
            </s-section>
          </>}
          {screen === 'review' && review && detail && <>
            <BackLink disabled={busy} label={review.action==='set'?'Edit quantity':'Product details'} onClick={()=>goTo(review.action==='set'?'edit':'detail')}/>
            <ProductHeading item={detail}/>
            <s-section heading={review.action==='push'?'Review push now':'Review inventory change'}>
              <s-stack direction="block" gap="small">
                <s-divider/>
                <s-stack direction="inline" gap="large" paddingBlock="small">
                  <Quantity label="Shopify available now" value={review.currentAvailable}/>
                  <Quantity label="After update" value={review.targetAvailable}/>
                </s-stack>
                <s-text type="small" color="subdued">Committed {units(review.committed)} · Other unavailable {units(review.unavailable ?? null)}</s-text>
                {review.action==='set' && <>
                  <s-divider/>
                  <s-text>HotWax ATP {review.currentAtp} → {review.targetAvailable}</s-text>
                  <s-text>HotWax variance {signed(review.variance)} units</s-text>
                  {review.onHandVariance!=null && <s-text>HotWax on-hand variance {signed(review.onHandVariance)} units</s-text>}
                  <s-text type="small" color="subdued">{review.variance === 0 ? 'HotWax requests one Shopify reset for this item.' : 'HotWax saves the variance and requests one Shopify reset for this item.'}</s-text>
                </>}
              </s-stack>
            </s-section>
            {review.effects.length > 0 && <s-section heading={review.action==='push'?'Effects to send':'Pending effects to discard'}>
              <Events rows={review.effects} zone={session.timeZone}/>
            </s-section>}
            <s-stack direction="inline">
              <s-button variant="primary" disabled={busy || !connected || recoverOperation} onClick={()=>saveReview(review.operationId)}>{review.action==='push'?'Push now':'Set Shopify available to '+review.targetAvailable}</s-button>
            </s-stack>
          </>}
          {screen === 'status' && operation && <>
            <BackLink disabled={busy} label="Inventory queue" onClick={()=>goTo('list')}/>
            <s-banner tone={operation.state==='confirmed'?'success':operation.state==='needsAttention'||operation.state==='expired'?'warning':'info'} heading={operationStates[operation.state]}>
              {operation.state==='confirmed' && <s-text>{operation.targetAvailable} available · Confirmed {timeAt(operation.confirmedAt,session.timeZone)}</s-text>}
              {operation.state!=='confirmed' && operationNote && <s-text>{operationNote}</s-text>}
            </s-banner>
            <s-stack direction="block" gap="small">
              {operation.action==='set' && ['sending','needsAttention','confirmed'].includes(operation.state) &&
                <s-text type="strong">Saved in HotWax</s-text>}
              {operation.state!=='confirmed' && operation.lastConfirmed && <s-text>Last confirmed Shopify available {operation.lastConfirmed.available}
                {operation.lastConfirmed.checkedAt && ' · Checked '+timeAt(operation.lastConfirmed.checkedAt,session.timeZone)}</s-text>}
              {operation.state==='confirmed' && operationNote && <s-text>{operationNote}</s-text>}
              <s-text type="small" color="subdued">Reference {operation.operationId}</s-text>
            </s-stack>
            <s-stack direction="inline" gap="base">
              <s-button variant="secondary" disabled={busy || !connected} onClick={reloadOperation}>Check status</s-button>
              {operation.state==='review' && ((operation.action==='set' && session.canSet) || (operation.action==='push' && session.canPush)) &&
                <s-button variant="primary" disabled={busy || !connected} onClick={()=>saveReview(operation.operationId)}>Retry save</s-button>}
              {operation.canRetry && <s-button variant="primary" disabled={busy || !connected} onClick={()=>run(async()=>{
                setOperation(await request('retry',{operationId:operation.operationId}));
              })}>Retry Shopify delivery</s-button>}
            </s-stack>
          </>}
        </s-stack>
      </s-box>
    </s-scroll-box>
  </s-page>;
}

function BackLink({label,disabled,onClick}: {label: string; disabled: boolean; onClick: () => void}) {
  return <s-stack direction="inline">
    <s-clickable disabled={disabled} onClick={onClick}>
      <s-stack direction="inline" alignItems="center" gap="small" minBlockSize="44px">
        <s-icon type="chevron-left"/>
        <s-text type="strong">{label}</s-text>
      </s-stack>
    </s-clickable>
  </s-stack>;
}

function ProductHeading({item}: {item: InventoryProduct}) {
  return <s-stack direction="block" gap="small-300">
    <s-heading>{item.title}</s-heading>
    {titleFor(item) && <s-text color="subdued">{titleFor(item)}</s-text>}
  </s-stack>;
}

function Quantity({label,value}: {label: string; value: number | null}) {
  return <s-stack direction="block" gap="small-300">
    <s-text type="small" color="subdued">{label}</s-text>
    <s-heading>{units(value)}</s-heading>
  </s-stack>;
}

function Events({rows,zone}: {rows: InventoryEffect[]; zone?: string}) {
  return <s-stack direction="block">{rows.map(row=><s-stack key={row.id} direction="block">
    <s-divider/>
    <s-stack direction="inline" gap="base" justifyContent="space-between" paddingBlock="base">
      <s-stack direction="block" gap="small-300">
        <s-text type="strong">{row.source}</s-text>
        <s-text type="small" color="subdued">{[row.reference,timeAt(row.at,zone)].filter(Boolean).join(' · ')}</s-text>
        {row.detail && <s-text type="small" color="subdued">{row.detail}</s-text>}
      </s-stack>
      <s-stack direction="block" gap="small-300" alignItems="end">
        <s-text type="strong">{signed(row.delta)}</s-text>
        <s-badge tone={row.state==='confirmed'?'success':row.state==='needsAttention'?'warning':'neutral'}>{row.eligible?'Discard eligible':effectStates[row.state]}</s-badge>
      </s-stack>
    </s-stack>
  </s-stack>)}</s-stack>;
}
