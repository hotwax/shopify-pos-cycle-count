import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {countStatus,countTypeName,workStatus} from './count-api';
import {ProductList,CompactPager} from './ProductList.jsx';
import {ActionRow,DividedRows,amount} from './FlowParts.jsx';
import {recoverSubmission,countSubmitted} from './count-submission';
import {controlFor} from './count-control';
import {progressTotals,submitReadiness} from './count-totals';
// Totals for the Progress section plus whether Submit for approval can be used, from one progress result.
const summarize=result=>({...progressTotals(result),...submitReadiness(result)});
const operationId=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');
const sameProducts=(a,b)=>[...a].sort().join(',')===[...b].sort().join(',');
// The last product summary per count, shown at once while a fresh one loads.
const progressCache=new Map();
const toast=message=>{try{shopify.toast?.show?.(message);}catch{/* A missing toast is not an error. */}};
const message=failure=>failure instanceof Error?failure.message:'Could not complete this operation.';
// A count's start and due moments with their time, in this register's own time zone and locale.
const dateTime=value=>new Date(Number(value)).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});
const HEADINGS={products:'Products',zero:'Mark as out of stock',extras:'Extra products'};

/**
 * One count, shown as native POS screens: the summary, Products, a product's details
 * and the out-of-stock / extra-product selections. Each is its own entry on the POS
 * navigation stack (openScreen / closeScreen); confirmations are POS sheets.
 */
export function CountFlow({workEffortId,screen='summary',product:initialProduct,contribution:initialContribution,openScreen,closeScreen,openSession,storage,owner,request,setHeader,navigationError,refreshVersion}) {
  const view=screen;
  const [info,setInfo]=useState(null),[progress,setProgress]=useState(null);
  const [error,setError]=useState(''),[sheetError,setSheetError]=useState(''),[busy,setBusy]=useState(true),[area,setArea]=useState('register');
  const [selected,setSelected]=useState(new Set()),[product,setProduct]=useState(initialProduct||null),[contributions,setContributions]=useState(null),[page,setPage]=useState(0);
  const [contribution]=useState(initialContribution||null),[contributionQuantity,setContributionQuantity]=useState(initialContribution?.quantity==null?'':String(initialContribution.quantity)),[decisionProgress,setDecisionProgress]=useState('');
  const [approval,setApproval]=useState(null);
  const [savedDecision,setSavedDecision]=useState(false),[pendingDecision,setPendingDecision]=useState(null);
  const [sessionName,setSessionName]=useState(''),[pendingCreate,setPendingCreate]=useState(null);
  const cacheKey=`${owner}:${workEffortId}`,control=controlFor(storage.native||storage,owner);
  // Pending decisions and session creations live in the operator's control record;
  // a value an earlier release kept under its own key is moved there on first use.
  const loadDecision=()=>control.adopt('decisions',workEffortId,'decision'),setDecisionRecord=value=>control.setEntry('decisions',workEffortId,value);
  const loadCreate=()=>control.adopt('creates',workEffortId,'create-session'),setCreateRecord=value=>control.setEntry('creates',workEffortId,value);
  const name=useRef(''),active=useRef(true),running=useRef(false),progressRequest=useRef(0);
  const [progressBusy,setProgressBusy]=useState(false),[progressError,setProgressError]=useState(''),[sessionPage,setSessionPage]=useState(0),[pastPage,setPastPage]=useState(0);
  const [locks,setLocks]=useState({}),[lockError,setLockError]=useState(''),[lockRefresh,setLockRefresh]=useState(0);
  const listMemory=useRef({search:'',view:'all',page:0});
  const [totals,setTotals]=useState(()=>{const cached=progressCache.get(cacheKey);return cached?summarize(cached):null;});
  const [totalsError,setTotalsError]=useState(''),totalsRequest=useRef(0);
  const decision=view==='zero'?'confirmZero':'discardUndirected';
  async function run(fn) {
    if(running.current)return false;
    running.current=true;setBusy(true);setError('');
    try {await fn();return true;}
    catch(failure){if(active.current)setError(message(failure));return false;}
    finally{running.current=false;if(active.current)setBusy(false);}
  }
  // The summary's totals load in the background (compact: no product names), so
  // the summary and its actions show at once.
  async function loadTotals() {
    const sequence=++totalsRequest.current;setTotalsError('');
    try {
      const result=await request('progress',{workEffortId,compact:true});
      if(active.current&&sequence===totalsRequest.current)setTotals(summarize(result));
    } catch {
      if(active.current&&sequence===totalsRequest.current)setTotalsError('Progress could not be loaded.');
    }
  }
  async function loadProducts() {
    const sequence=++progressRequest.current;
    setProgressBusy(true);setProgressError('');
    try {
      const result=await request('progress',{workEffortId});
      if(!active.current||sequence!==progressRequest.current)return;
      progressCache.delete(cacheKey);progressCache.set(cacheKey,result);
      while(progressCache.size>10)progressCache.delete(progressCache.keys().next().value);
      setInfo(result);setProgress(result);setTotals(summarize(result));
    } catch(failure) {
      if(active.current&&sequence===progressRequest.current)setProgressError(failure instanceof Error?failure.message:'Could not load the product summary.');
    } finally {if(active.current&&sequence===progressRequest.current)setProgressBusy(false);}
  }
  async function refresh() {
    const result=await request('overview',{workEffortId});
    if(!active.current)return;
    setInfo(result);
    setLockRefresh(value=>value+1);
  }
  async function loadContributions() {
    const result=await request('contributions',{workEffortId,productId:product.productId});
    if(active.current)setContributions(result.items);
  }
  // What each screen loads when it opens, and again when the screen above it closes.
  async function load() {
    if(view==='summary'){
      await refresh();
      const pending=await loadDecision().catch(()=>null);
      if(active.current)setPendingDecision(pending||null);
    } else if(view==='product') {
      await Promise.all([refresh(),loadContributions()]);
    } else if(view==='contribution') {
      await refresh();
    } else {
      await loadProducts();
      if(view!=='products'){
        const pending=await loadDecision().catch(()=>null);
        if(active.current&&pending?.action===decision){setSelected(new Set(pending.productIds));setSavedDecision(true);}
      }
    }
  }
  useEffect(()=>{
    active.current=true;
    const cached=progressCache.get(cacheKey);
    if(cached){setInfo(cached);setProgress(cached);}
    void run(load);
    return()=>{active.current=false;progressRequest.current++;totalsRequest.current++;};
  },[workEffortId,view]);
  useEffect(()=>{if(refreshVersion)void run(load);},[refreshVersion]);
  // Refresh totals on the summary, including after returning from a session.
  const showTotals=!!info?.canPreview&&info.statusId!=='CYCLE_CNT_CREATED';
  useEffect(()=>{
    if(view==='summary'&&showTotals)void loadTotals();
  },[workEffortId,showTotals,info?.statusId,refreshVersion,view]);
  const openSessions=info?.sessions.filter(session=>session.editable)||[];
  const pastSessions=info?.sessions.filter(session=>!session.editable)||[];
  const openPageIndex=Math.min(sessionPage,Math.max(0,Math.ceil(openSessions.length/20)-1));
  const pageSessions=openSessions.slice(openPageIndex*20,(openPageIndex+1)*20);
  const pastPageIndex=Math.min(pastPage,Math.max(0,Math.ceil(pastSessions.length/20)-1));
  const pagePast=pastSessions.slice(pastPageIndex*20,(pastPageIndex+1)*20);
  const lockIds=view==='summary'?pageSessions.map(session=>session.sessionId).join(','):'';
  useEffect(()=>{
    let stopped=false,timer=0;
    setLocks({});setLockError('');
    if(!lockIds)return;
    async function refreshLocks(){
      try {
        const result=await request('sessionLocks',{workEffortId,sessionIds:lockIds.split(',')});
        if(!stopped){setLocks(Object.fromEntries(result.items.map(lock=>[lock.sessionId,lock])));setLockError('');}
      } catch {if(!stopped){setLocks({});setLockError('Session locks could not be refreshed. Opening a session rechecks access.');}}
      finally {if(!stopped)timer=setTimeout(refreshLocks,30000);}
    }
    void refreshLocks();
    return()=>{stopped=true;clearTimeout(timer);};
  },[view,lockIds,workEffortId,owner,lockRefresh]);
  function lockStatus(sessionId){
    const lock=locks[sessionId];
    if(!lock)return {};
    if(lock.available||lock.owned||(lock.expiresAt!=null&&lock.expiresAt<=Date.now()))return {};
    return {notice:`Open on another register · ${lock.operator||'another user'}`,noticeTone:lock.owned?'success':'critical'};
  }
  const heading=view==='summary'?info?.name||'Count summary':view==='product'?product?.title||product?.sku||'Product details':view==='contribution'?contribution?.name||'Session contribution':HEADINGS[view];
  useEffect(()=>{
    const subheading=view==='summary'&&info?`${countTypeName(info.type)} · ${workStatus(info.statusId)}`:info?.name||'';
    setHeader?.({heading,subheading,action:view==='summary'&&info?.canPreview
      ?{label:'Products',disabled:busy,onClick:()=>openScreen('products')}:null});
  },[heading,view,info?.name,info?.statusId,info?.canPreview,busy,setHeader]);
  async function prepareCreate() {
    // An unfinished earlier attempt is offered for retry with its own name and location.
    let pending=null;
    try {pending=await loadCreate();} catch { /* Start a fresh session below. */ }
    if(!active.current)return;
    setSheetError('');setPendingCreate(pending||null);name.current=pending?.name||'';setSessionName(pending?.name||'');if(pending?.area)setArea(pending.area);
  }
  async function create() {
    let pending=await loadCreate();
    const typed=name.current.trim();
    // A changed name or location is a new session. The saved operation ID only
    // makes a retry of the same session idempotent.
    if(pending&&((typed&&typed!==pending.name)||area!==pending.area)){await setCreateRecord(null);pending=null;setPendingCreate(null);}
    if(!pending){pending={workEffortId,operationId:operationId(),name:typed,area};if(!pending.name)throw new Error('Enter a session name.');await setCreateRecord(pending);}
    try {for(let attempt=0;attempt<6;attempt++) {
      const result=await request('createSession',pending);
      if(!result.preparing){
        await setCreateRecord(null);setPendingCreate(null);
        if(active.current)await openSession(result.session.sessionId,result.session.name);
        return;
      }
      setDecisionProgress(`Preparing your list · ${result.remaining} products remaining.`);
    }} finally {if(active.current)setDecisionProgress('');}
    throw new Error('Your session is saved. Choose Add session again to finish loading its product list.');
  }
  async function cancelDecision() {
    await setDecisionRecord(null);
    if(!active.current)return;
    setSavedDecision(false);setDecisionProgress('');setSelected(new Set());await loadProducts();
  }
  async function submitCount() {
    try {
      await recoverSubmission({read:()=>request('countSubmissionStatus',{workEffortId}),write:()=>request('completeCount',{workEffortId}),done:countSubmitted,current:()=>active.current,checking:()=>setDecisionProgress('Checking submission…')});
      toast('Sent to HotWax for approval');await refresh();void loadTotals();
    } finally {if(active.current)setDecisionProgress('');}
  }
  async function confirmDecision() {
    let pending=await loadDecision();
    if(pending&&!(pending.action===decision&&sameProducts(pending.productIds,selected))){
      // An unsent decision is simply replaced; part of a sent one must be finished or cancelled.
      if(pending.completed)throw new Error('Part of an earlier decision is already saved in HotWax. Finish it with the same products, or cancel it.');
      await setDecisionRecord(null);pending=null;
    }
    if(!pending){pending={action:decision,workEffortId,operationId:operationId(),productIds:[...selected]};await setDecisionRecord(pending);setSavedDecision(true);}
    const batches=Math.ceil(pending.productIds.length/25);
    pending={...pending,completed:pending.completed||0};
    for(let index=pending.completed;index<batches;index++){
      setDecisionProgress(`Saving batch ${index+1} of ${batches}`);
      const batchId=pending.operationId.slice(0,10)+index.toString(16).padStart(5,'0');
      // Zero-count session identity belongs to the whole confirmation, including retries.
      try {await request(pending.action,{...pending,operationId:pending.action==='confirmZero'?pending.operationId:batchId,productIds:pending.productIds.slice(index*25,(index+1)*25)});}
      catch(failure){
        // HotWax rejected the selection itself (for example, a product was counted
        // meanwhile). Retrying cannot succeed, so clear it and show the current list.
        const status=failure instanceof Error&&'status' in failure?failure.status:undefined;
        if(status!==409)throw failure;
        await setDecisionRecord(null);setSavedDecision(false);setDecisionProgress('');setSelected(new Set());
        await loadProducts();
        throw new Error(`${failure instanceof Error?failure.message:'HotWax rejected this selection.'} The saved selection was cleared; review the products again.`);
      }
      pending={...pending,completed:index+1};await setDecisionRecord(pending);
    }
    const count=pending.productIds.length;
    await setDecisionRecord(null);setSavedDecision(false);setDecisionProgress('');
    toast(decision==='confirmZero'?`${amount(count,'product')} marked as out of stock`:`${amount(count,'extra product')} discarded`);
    closeScreen();
  }
  function toggle(item) {setSelected(old=>{const next=new Set(old);if(next.has(item.productId))next.delete(item.productId);else next.add(item.productId);return next;});}
  async function startCounting() {
    const started=await request('startCount',{workEffortId});
    if(active.current){setInfo(started);setLockRefresh(value=>value+1);}
  }
  // Runs as the submit sheet opens: the sheet explains what is missing, or shows the totals to send.
  async function prepareSubmission() {
    setApproval(null);setSheetError('');
    if(openSessions.length){setSheetError('Complete all open sessions before submitting this count.');return;}
    try {
      const result=await request('progress',{workEffortId,compact:true});
      if(!active.current)return;
      setTotals(summarize(result));
      if(!result.canFinish){setSheetError(result.uncounted
        ?'Open Products to count or confirm zero for the remaining products.'
        :'Complete at least one session before submitting this count.');return;}
      const counted=result.items.filter(item=>item.quantity!=null&&item.decision!=='SKIPPED');
      setApproval({products:counted.length,units:counted.reduce((total,item)=>total+item.quantity,0)});
    } catch(failure) {if(active.current)setSheetError(message(failure));}
  }
  async function discardCount() {
    const cancelled=await request('discardCount',{workEffortId});
    if(!active.current)return;
    setInfo(cancelled);setProgress(null);toast('Cycle count discarded');
  }
  function openProduct(item) {
    openScreen('product',{product:{productId:item.productId,title:item.title||'',sku:item.sku||'',quantity:item.quantity??null,onHand:item.onHand??null,delta:item.delta??null}});
  }
  async function saveContribution() {
    if(!canEditContribution)throw new Error('This contribution is no longer editable.');
    if(contributionQuantity==='')throw new Error('Enter a total quantity.');
    await request('editContribution',{workEffortId,sessionId:contribution.sessionId,productId:product.productId,quantity:Number(contributionQuantity),expectedQuantity:contribution.quantity});
    toast('Contribution saved');closeScreen();
  }
  const canManage=info?.canComplete&&info.statusId==='CYCLE_CNT_IN_PRGS';
  const dynamic=info?.type==='DYNAMIC_COUNT';
  const canEditContribution=canManage&&contribution?.editable;
  const zeroItems=progress?.items.filter(item=>item.isRequested&&item.quantity===null)||[];
  const extras=progress?.items.filter(item=>!item.isRequested&&item.quantity!==null&&item.decision!=='SKIPPED')||[];
  const summaryItems=useMemo(()=>progress?.items.filter(item=>item.decision!=='SKIPPED')||[],[progress]);
  // Each session says what its button does: continue your own open session, open someone
  // else's, or view a finished one. The whole row was tappable, but nothing showed it.
  const sessionRow=session=>{
    const lock=lockStatus(session.sessionId),continuing=session.editable&&session.mine&&!lock.notice;
    return <s-box key={session.sessionId} paddingBlock="base" minBlockSize="64px">
      <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
        <s-stack direction="block" gap="small">
          <s-text type="strong">{session.name||session.sessionId}</s-text>
          <s-text color="subdued">{[info.areas.find(area=>area.id===session.area)?.name||session.area,session.mine?'You':session.operator,countStatus(session)].filter(Boolean).join(' · ')}</s-text>
          {lock.notice&&<s-text tone="critical">{lock.notice}</s-text>}
        </s-stack>
        <s-button variant={continuing?'primary':'secondary'} disabled={busy} onClick={()=>openSession(session.sessionId,session.name)}>{continuing?'Continue counting':session.editable?'Open':'View'}</s-button>
      </s-stack>
    </s-box>;
  };
  return <s-scroll-box key={`${workEffortId}:${view}:${info?.statusId||'loading'}`}><s-box padding="large"><s-stack direction="block" gap="large">
    {!info&&busy&&<s-spinner accessibilityLabel="Loading count"/>}
    {navigationError&&<s-banner tone="warning" heading={navigationError}/>}
    {error&&<s-banner tone="critical" heading={error}/>}
    {decisionProgress&&<s-banner tone="info" heading={decisionProgress}/>}
    {!info&&error&&<s-button variant="primary" onClick={()=>run(load)}>Try again</s-button>}

    {info&&view==='summary'&&<>
      {pendingDecision&&<s-banner tone="warning" heading={pendingDecision.action==='confirmZero'?'An out-of-stock decision is not finished':'An extra-product decision is not finished'}>
        <s-button slot="primary-action" onClick={()=>openScreen(pendingDecision.action==='confirmZero'?'zero':'extras')}>Continue</s-button>
      </s-banner>}
      <s-stack direction="block" gap="base">
        {/* Disabled until the count can be sent; the Progress and Open sessions sections below
            show what is left. If the check cannot load, the button stays usable and the sheet
            checks again on tap. */}
        {canManage&&<s-button variant="primary" disabled={busy||(!totals&&!totalsError)||!!totals&&!totals.ready} command="--show" commandFor="count-submit" onClick={()=>void prepareSubmission()}>{!totals&&!totalsError?'Checking…':'Submit for approval'}</s-button>}
        {info.canStart&&<s-button variant="primary" disabled={busy} onClick={()=>run(startCounting)}>Start count</s-button>}
      </s-stack>
      {info.statusId==='CYCLE_CNT_CMPLTD'&&<s-banner tone="success" heading="Sent to HotWax for approval"/>}
      {info.statusId==='CYCLE_CNT_CNCL'&&<s-banner tone="warning" heading="This cycle count was discarded"/>}
      {(info.startDate||info.dueDate)&&<s-text color="subdued">{[info.startDate&&`Starts ${dateTime(info.startDate)}`,info.dueDate&&`Due ${dateTime(info.dueDate)}`].filter(Boolean).join(' · ')}</s-text>}
      {/* Progress opens Products, where each product's count and sessions are listed. */}
      {showTotals&&<s-section heading="Progress"><s-stack direction="block" gap="small">
        {totals?<s-clickable onClick={()=>openScreen('products')}>
          <s-stack direction="inline" justifyContent="space-between" alignItems="center" gap="base">
            <s-stack direction="block" gap="small">
              <s-text type="strong">{totals.dynamic?`${amount(totals.counted,'product')} counted`:`${totals.requestedCounted} of ${amount(totals.requested,'product')} counted`} · {amount(totals.units,'unit')}</s-text>
              {!totals.dynamic&&<s-text>{totals.requested>totals.requestedCounted?`${amount(totals.requested-totals.requestedCounted,'product')} left to count`:'Every requested product is counted'}{totals.extras?` · ${amount(totals.extras,'extra product')}`:''}</s-text>}
              <s-text color="subdued">From quantities saved in all sessions. Tap to see products.</s-text>
            </s-stack>
            <s-icon type="chevron-right"/>
          </s-stack>
        </s-clickable>:totalsError?<s-stack direction="inline" gap="base" alignItems="center">
          <s-text color="subdued">{totalsError}</s-text>
          <s-button variant="tertiary" onClick={()=>void loadTotals()}>Try again</s-button>
        </s-stack>:<s-text color="subdued">Loading progress…</s-text>}
      </s-stack></s-section>}
      <s-section heading="Open sessions"><s-stack direction="block" gap="base">
        <DividedRows>{pageSessions.map(sessionRow)}</DividedRows>
        <CompactPager page={openPageIndex} pages={Math.max(1,Math.ceil(openSessions.length/20))} total={openSessions.length} label="sessions" onPage={setSessionPage} disabled={busy}/>
        {!openSessions.length&&<s-text color="subdued">No open sessions.</s-text>}
        {lockError&&<s-text tone="critical">{lockError}</s-text>}
        {info.canCreateSession&&<s-stack direction="inline"><s-button disabled={busy} command="--show" commandFor="count-create" onClick={()=>void prepareCreate()}>Add session</s-button></s-stack>}
      </s-stack></s-section>
      {/* Finished sessions sit on the summary itself, not on a page of their own. */}
      {!!pastSessions.length&&<s-section heading="Completed sessions"><s-stack direction="block" gap="base">
        <DividedRows>{pagePast.map(sessionRow)}</DividedRows>
        <CompactPager page={pastPageIndex} pages={Math.max(1,Math.ceil(pastSessions.length/20))} total={pastSessions.length} label="sessions" onPage={setPastPage} disabled={busy}/>
      </s-stack></s-section>}
      {/* Destructive, so kept apart from Submit at the end of the summary. */}
      {info.canDiscard&&<s-stack direction="inline"><s-button variant="tertiary" tone="critical" disabled={busy} command="--show" commandFor="count-discard" >Discard cycle count</s-button></s-stack>}

      <s-modal id="count-submit" heading="Submit for approval">
        <s-stack direction="block" gap="base">
          {sheetError?<s-text>{sheetError}</s-text>:approval?<>
            <s-text type="strong">{amount(approval.products,'product')} · {amount(approval.units,'unit')}</s-text>
            {dynamic&&<s-text>Include all units of each listed product, including back stock.</s-text>}
            <s-text color="subdued">Inventory changes only after approval.</s-text>
          </>:<s-text color="subdued">Checking the count…</s-text>}
        </s-stack>
        <s-button slot="primary-action" variant="primary" disabled={busy||!approval} command="--hide" commandFor="count-submit" onClick={()=>run(submitCount)}>Submit for approval</s-button>
        <s-button slot="secondary-actions" command="--hide" commandFor="count-submit">Cancel</s-button>
      </s-modal>
      <s-modal id="count-discard" heading="Discard cycle count">
        <s-stack direction="block" gap="base">
          <s-text>Discard {info.name} and all of its sessions? The counted quantities will be left out of approval.</s-text>
        </s-stack>
        <s-button slot="primary-action" variant="primary" tone="critical" disabled={busy} command="--hide" commandFor="count-discard" onClick={()=>run(discardCount)}>Discard cycle count</s-button>
        <s-button slot="secondary-actions" command="--hide" commandFor="count-discard">Cancel</s-button>
      </s-modal>
      <s-modal id="count-create" heading="Add session">
        <s-stack direction="block" gap="base">
          <s-text>Use a separate session for each person or area.</s-text>
          {pendingCreate&&<s-text color="subdued">An earlier attempt to start “{pendingCreate.name}” did not finish. Start counting to finish it, or change the name or location to start a different session.</s-text>}
          <s-text-field label="Session name" placeholder="For example, Front display" value={sessionName} disabled={busy} onInput={e=>{name.current=e.currentTarget.value;setSessionName(e.currentTarget.value);}}/>
          {/* POS does not draw a choice list's label, so the heading is visible text. */}
          <s-text type="strong">Session location</s-text>
          <s-choice-list values={[area]} onChange={e=>setArea(e.currentTarget.values[0])}>{info.areas.map(a=><s-choice key={a.id} value={a.id} disabled={busy}>{a.name}</s-choice>)}</s-choice-list>
        </s-stack>
        <s-button slot="primary-action" variant="primary" disabled={busy||!sessionName.trim()} command="--hide" commandFor="count-create" onClick={()=>run(create)}>Start counting</s-button>
        <s-button slot="secondary-actions" command="--hide" commandFor="count-create">Cancel</s-button>
      </s-modal>
    </>}

    {info&&view==='products'&&<s-stack direction="block" gap="base">
      {progressError&&<s-banner tone="critical" heading={progressError}/>}
      {info.canPreview?<s-stack direction="block" gap="base">
        {progress?<ProductList items={summaryItems} filters={!dynamic} countExtras directed={info.type==='DIRECTED_COUNT'} disabled={busy} memory={listMemory.current} onSelect={openProduct}
          renderViewActions={tab=>canManage&&((tab==='uncounted'&&zeroItems.length>0)?<s-stack direction="block" gap="small">
            <s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>openScreen('zero')}>Mark as out of stock</s-button>
            {!progress.allSubmitted&&<s-text color="subdued">Submit all sessions before marking remaining products as out of stock.</s-text>}
          </s-stack>:tab==='undirected'&&extras.length>0&&<s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>openScreen('extras')}>Select products to discard</s-button>)}/>:<s-text color="subdued">{progressBusy?'Loading products…':'Products could not be loaded.'}</s-text>}
        <s-button disabled={busy||progressBusy} onClick={loadProducts}>{progressError?'Retry products':'Refresh products'}</s-button>
      </s-stack>:<s-text color="subdued">Product preview is available when the count starts and your account has access.</s-text>}
    </s-stack>}

    {['zero','extras'].includes(view)&&<>
      {progressError&&<s-banner tone="critical" heading={progressError}/>}
      {progress?<>
        <s-section heading={view==='zero'?'Select uncounted products':'Discard extra products'}><s-stack direction="block" gap="base">
          <s-text>{view==='zero'?'Select products you checked across the store and did not find. Confirming records a count of zero for each selected product.':'Selected products will be left out of this count’s review.'}</s-text>
          <s-text color="subdued">{selected.size} selected</s-text>
          <s-stack direction="inline" gap="base">
            <s-button disabled={busy} onClick={()=>setSelected(new Set((view==='zero'?zeroItems:extras).map(item=>item.productId)))}>{view==='zero'?'Select all uncounted':'Select all extra products'}</s-button>
            <s-button variant="primary" disabled={busy||!selected.size} command="--show" commandFor="count-confirm" >Review {selected.size} selected</s-button>
          </s-stack>
        </s-stack></s-section>
        <ProductList items={view==='zero'?zeroItems:extras} disabled={busy} selected={selected} filters={false} onSelect={toggle}/>
      </>:<s-text color="subdued">{progressBusy?'Loading products…':'Products could not be loaded.'}</s-text>}
      <s-modal id="count-confirm" heading={view==='zero'?'Mark as out of stock?':'Discard extra products?'}>
        <s-stack direction="block" gap="base">
          <s-text type="strong">{amount(selected.size,'product')} selected</s-text>
          <s-text>{view==='zero'?'Each selected product gets a count of zero and moves from Uncounted to Counted.':'The selected products are left out of this count’s review.'}</s-text>
          <s-text color="subdued">This decision is recorded in HotWax. Inventory changes only after approval.</s-text>
        </s-stack>
        <s-button slot="primary-action" variant="primary" disabled={busy||!selected.size} command="--hide" commandFor="count-confirm" onClick={()=>run(confirmDecision)}>{view==='zero'?'Confirm out of stock':'Discard selected products'}</s-button>
        <s-button slot="secondary-actions" command="--hide" commandFor="count-confirm">Cancel</s-button>
        {savedDecision&&<s-button slot="secondary-actions" command="--hide" commandFor="count-confirm" onClick={()=>run(cancelDecision)}>Cancel saved decision</s-button>}
      </s-modal>
    </>}

    {view==='product'&&product&&<s-section><s-stack direction="block" gap="base">
      <s-text>{product.sku} · {product.quantity==null?'Not counted':`${product.quantity} counted in total`}</s-text>
      {product.onHand!=null&&<s-text color="subdued">On hand {product.onHand} · Difference {product.delta??'—'}</s-text>}
      <s-text type="strong">Session contributions</s-text>
      <DividedRows>{contributions?.slice(page*20,(page+1)*20).map(session=><ActionRow key={session.sessionId} title={session.name||session.sessionId}
        detail={[session.operator,countStatus(session)].filter(Boolean).join(' · ')} meta={session.quantity==null?'Uncounted':String(session.quantity)} disabled={busy}
        onClick={()=>openScreen('contribution',{product,contribution:{sessionId:session.sessionId,name:session.name||'',operator:session.operator||'',statusId:session.statusId||'',
          countStatusId:session.countStatusId||'',quantity:session.quantity??null,editable:session.editable===true}})}/>)}</DividedRows>
      {contributions?.length===0&&<s-text color="subdued">No session has counted this product yet.</s-text>}
      {!contributions&&(busy?<s-text color="subdued">Loading session contributions…</s-text>:<s-button onClick={()=>run(loadContributions)}>Retry contributions</s-button>)}
      {contributions&&<CompactPager page={page} pages={Math.max(1,Math.ceil(contributions.length/20))} total={contributions.length} onPage={setPage} label="sessions"/>}
    </s-stack></s-section>}

    {view==='contribution'&&contribution&&info&&<>
      <s-section heading={product?.title||product?.sku}><s-stack direction="block" gap="base">
        <s-text>{[contribution.operator,countStatus(contribution)].filter(Boolean).join(' · ')}</s-text>
        {canEditContribution?<>
          <s-number-field label="Total in this session" value={contributionQuantity} min={0} max={1000000} disabled={busy} onInput={e=>setContributionQuantity(e.currentTarget.value)}/>
          <s-text color="subdued">Team total after this change: {(product.quantity||0)-(contribution.quantity||0)+(Number(contributionQuantity)||0)}</s-text>
        </>:<>
          <s-text type="strong">{contribution.quantity==null?'Not counted in this session':`${contribution.quantity} counted in this session`}</s-text>
          <s-text color="subdued">{info.statusId!=='CYCLE_CNT_IN_PRGS'?'This count is no longer open for changes.':!info.canComplete?'Your account can view this contribution. A count manager can change it.':'This session is no longer open for changes.'}</s-text>
        </>}
      </s-stack></s-section>
      {canEditContribution&&<s-button variant="primary" loading={busy} disabled={busy} onClick={()=>run(saveContribution)}>Save contribution</s-button>}
      <s-button disabled={busy} onClick={()=>void openSession(contribution.sessionId,contribution.name)}>View session</s-button>
    </>}
  </s-stack></s-box></s-scroll-box>;
}
