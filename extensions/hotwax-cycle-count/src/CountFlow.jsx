import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {countStatus,countTypeName,workStatus} from './count-api';
import {ProductList,CompactPager} from './ProductList.jsx';
import {ActionRow,BackButton,DividedRows,amount} from './FlowParts.jsx';
import {recoverSubmission,countSubmitted} from './count-submission';
import {controlFor} from './count-control';
const operationId=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');
const sameProducts=(a,b)=>[...a].sort().join(',')===[...b].sort().join(',');
// The last product summary per count, shown at once while a fresh one loads.
const progressCache=new Map();

export function CountFlow({workEffortId,openSession,storage,owner,request,setHeader,navigationError,refreshVersion}) {
  const [info,setInfo]=useState(null),[progress,setProgress]=useState(null),[view,setView]=useState('summary');
  const [error,setError]=useState(''),[busy,setBusy]=useState(true),[area,setArea]=useState('register'),[page,setPage]=useState(0);
  const [selected,setSelected]=useState(new Set()),[decision,setDecision]=useState(''),[product,setProduct]=useState(null),[contributions,setContributions]=useState(null);
  const [contribution,setContribution]=useState(null),[contributionQuantity,setContributionQuantity]=useState(''),[decisionProgress,setDecisionProgress]=useState('');
  const [approval,setApproval]=useState(null);
  const [completionMessage,setCompletionMessage]=useState(''),[savedDecision,setSavedDecision]=useState(false);
  const [sessionName,setSessionName]=useState(''),[pendingCreate,setPendingCreate]=useState(null);
  const cacheKey=`${owner}:${workEffortId}`,control=controlFor(storage.native||storage,owner);
  // Pending decisions and session creations live in the operator's control record;
  // a value an earlier release kept under its own key is moved there on first use.
  const loadDecision=()=>control.adopt('decisions',workEffortId,'decision'),setDecisionRecord=value=>control.setEntry('decisions',workEffortId,value);
  const loadCreate=()=>control.adopt('creates',workEffortId,'create-session'),setCreateRecord=value=>control.setEntry('creates',workEffortId,value);
  const name=useRef(''),active=useRef(true),running=useRef(false),progressRequest=useRef(0);
  const [progressBusy,setProgressBusy]=useState(false),[progressError,setProgressError]=useState(''),[sessionPage,setSessionPage]=useState(0);
  const [locks,setLocks]=useState({}),[lockError,setLockError]=useState(''),[lockRefresh,setLockRefresh]=useState(0);
  const listMemory=useRef({search:'',view:'all',page:0});
  async function run(fn) {
    if(running.current)return;
    running.current=true;setBusy(true);setError('');
    try {await fn();}catch(failure){if(active.current)setError(failure instanceof Error?failure.message:'Could not complete this operation.');}
    finally{running.current=false;if(active.current)setBusy(false);}
  }
  async function loadProducts() {
    const sequence=++progressRequest.current;
    setProgressBusy(true);setProgressError('');
    try {
      const result=await request('progress',{workEffortId});
      if(!active.current||sequence!==progressRequest.current)return;
      progressCache.delete(cacheKey);progressCache.set(cacheKey,result);
      while(progressCache.size>10)progressCache.delete(progressCache.keys().next().value);
      if(active.current&&sequence===progressRequest.current){setInfo(result);setProgress(result);}
    } catch(failure) {
      if(active.current&&sequence===progressRequest.current)setProgressError(failure instanceof Error?failure.message:'Could not load the product summary.');
    } finally {if(active.current&&sequence===progressRequest.current)setProgressBusy(false);}
  }
  async function refresh(withProducts=false) {
    if(withProducts){await loadProducts();return;}
    progressRequest.current++;setProgressBusy(false);setProgressError('');
    const result=await request('overview',{workEffortId});
    if(!active.current)return;
    setInfo(result);
    setLockRefresh(value=>value+1);
  }
  useEffect(()=>{
    active.current=true;
    const cached=progressCache.get(cacheKey);
    if(cached){setInfo(cached);setProgress(cached);}
    run(async()=>{await refresh();const pending=await loadDecision();if(pending&&active.current){setSelected(new Set(pending.productIds));setDecision(pending.action);setSavedDecision(true);setView('confirm');await loadProducts();}});
    return()=>{active.current=false;progressRequest.current++;};
  },[workEffortId]);
  useEffect(()=>{
    if(!refreshVersion)return;
    if(view==='create')setView('summary');
    void run(()=>refresh());
  },[refreshVersion]);
  const openSessions=info?.sessions.filter(session=>session.editable)||[];
  const pastSessions=info?.sessions.filter(session=>!session.editable)||[];
  const visibleSessions=view==='completed'?pastSessions:openSessions;
  const visiblePage=Math.min(sessionPage,Math.max(0,Math.ceil(visibleSessions.length/20)-1));
  const pageSessions=visibleSessions.slice(visiblePage*20,(visiblePage+1)*20);
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
  const heading=({
    summary:info?.name||'Count summary', completed:'Session history', create:'Start a new session',
    products:'Products', product:product?.title||product?.sku||'Product details', editContribution:'Session contribution',
    discard:'Discard cycle count', zero:'Mark as out of stock', extras:'Extra products',
    confirm:decision==='completeCount'?'Submit for approval':'Review selected products',
  })[view];
  useEffect(()=>{
    const subheading=view==='summary'&&info?`${countTypeName(info.type)} · ${workStatus(info.statusId)}`:info?.name||'';
    setHeader?.({heading,subheading,action:view==='summary'&&info?.canPreview
      ?{label:'Products',disabled:busy,onClick:showProducts}:null});
  },[heading,view,info?.name,info?.statusId,info?.canPreview,busy,setHeader]);
  function showProducts() {
    setError('');setView('products');void loadProducts();
  }
  async function showCreate() {
    // An unfinished earlier attempt is offered for retry with its own name and location.
    let pending=null;
    try {pending=await loadCreate();} catch { /* Start a fresh session below. */ }
    if(!active.current)return;
    setPendingCreate(pending||null);name.current=pending?.name||'';setSessionName(pending?.name||'');if(pending?.area)setArea(pending.area);
    setView('create');
  }
  async function create() {
    let pending=await loadCreate();
    const typed=name.current.trim();
    // A changed name or location is a new session. The saved operation ID only
    // makes a retry of the same session idempotent.
    if(pending&&((typed&&typed!==pending.name)||area!==pending.area)){await setCreateRecord(null);pending=null;setPendingCreate(null);}
    if(!pending){pending={workEffortId,operationId:operationId(),name:typed,area};if(!pending.name)throw new Error('Enter a session name.');await setCreateRecord(pending);}
    for(let attempt=0;attempt<6;attempt++) {
      const result=await request('createSession',pending);
      if(!result.preparing){await setCreateRecord(null);setPendingCreate(null);if(active.current)await openSession(result.session.sessionId,result.session.name);return;}
      setError(`Preparing your list · ${result.remaining} products remaining.`);
    }
    throw new Error('Your session is saved. Choose Start counting again to finish loading its product list.');
  }
  async function cancelDecision() {
    await setDecisionRecord(null);
    if(!active.current)return;
    setSavedDecision(false);setDecisionProgress('');setSelected(new Set());setView('products');await refresh(true);
  }
  async function confirm() {
    if(decision==='completeCount'){
      try {await recoverSubmission({read:()=>request('countSubmissionStatus',{workEffortId}),write:()=>request(decision,{workEffortId}),done:countSubmitted,current:()=>active.current,checking:()=>setDecisionProgress('Checking submission…')});await refresh();setView('summary');}
      finally {if(active.current)setDecisionProgress('');}return;
    }
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
        if(active.current)setView(pending.action==='confirmZero'?'zero':'extras');
        await refresh(true);
        throw new Error(`${failure instanceof Error?failure.message:'HotWax rejected this selection.'} The saved selection was cleared; review the products again.`);
      }
      pending={...pending,completed:index+1};await setDecisionRecord(pending);
    }
    await setDecisionRecord(null);setSavedDecision(false);setDecisionProgress('');await refresh(true);
    setCompletionMessage(decision==='confirmZero'?`${amount(selected.size,'product')} marked as out of stock. Zero quantities have been recorded.`:`${amount(selected.size,'extra product')} discarded.`);
    setSelected(new Set());setView('products');
  }
  async function showProduct(item) {
    setProduct(item);setContributions(null);setPage(0);setView('product');
    await run(async()=>{const result=await request('contributions',{workEffortId,productId:item.productId});if(active.current)setContributions(result.items);});
  }
  function toggle(item) {setSelected(old=>{const next=new Set(old);if(next.has(item.productId))next.delete(item.productId);else next.add(item.productId);return next;});}
  async function startCounting() {
    const started=await request('startCount',{workEffortId});
    if(active.current){setInfo(started);setLockRefresh(value=>value+1);}
  }
  async function reviewApproval() {
    if(openSessions.length)throw new Error('Complete all open sessions before submitting this count.');
    const result=await request('progress',{workEffortId,compact:true});
    if(!active.current)return;
    if(!result.canFinish)throw new Error(result.uncounted
      ?'Open Products to count or confirm zero for the remaining items.'
      :'Complete at least one session before submitting this count.');
    const counted=result.items.filter(item=>item.quantity!=null&&item.decision!=='SKIPPED');
    setApproval({products:counted.length,units:counted.reduce((total,item)=>total+item.quantity,0)});
    setDecision('completeCount');setView('confirm');
  }
  async function discardCount() {
    const cancelled=await request('discardCount',{workEffortId});
    if(!active.current)return;
    setInfo(cancelled);setProgress(null);setCompletionMessage('Cycle count discarded');setView('summary');
  }
  const canManage=info?.canComplete&&info.statusId==='CYCLE_CNT_IN_PRGS';
  const dynamic=info?.type==='DYNAMIC_COUNT';
  const canEditContribution=canManage&&contribution?.editable;
  const zeroItems=progress?.items.filter(item=>item.isRequested&&item.quantity===null)||[];
  const extras=progress?.items.filter(item=>!item.isRequested&&item.quantity!==null&&item.decision!=='SKIPPED')||[];
  const reviewItems=useMemo(()=>progress?.items.filter(item=>selected.has(item.productId))||[],[progress,selected]);
  const summaryItems=useMemo(()=>progress?.items.filter(item=>item.decision!=='SKIPPED')||[],[progress]);
  const backView=view==='editContribution'?'product'
    :view==='confirm'&&decision!=='completeCount'?(decision==='confirmZero'?'zero':'extras')
    :['product','zero','extras'].includes(view)?'products':'summary';
  const backLabel={product:'Product details',products:'Products',zero:'Uncounted products',extras:'Extra products',summary:'Count summary'}[backView];
  function returnTo() {
    setError('');setView(backView);
    if(view==='completed')setSessionPage(0);
    if(view==='create')void run(()=>refresh());
  }
  const sessionsList=info&&<>
    <DividedRows>{pageSessions.map(session=><ActionRow key={session.sessionId} title={session.name||session.sessionId}
      detail={[info.areas.find(area=>area.id===session.area)?.name||session.area,session.mine?'You':session.operator].filter(Boolean).join(' · ')}
      {...lockStatus(session.sessionId)} meta={countStatus(session)} disabled={busy} onClick={()=>openSession(session.sessionId,session.name)}/>)}</DividedRows>
    <CompactPager page={visiblePage} pages={Math.max(1,Math.ceil(visibleSessions.length/20))} total={visibleSessions.length} label="sessions" onPage={setSessionPage} disabled={busy}/>
  </>;
  return <s-scroll-box key={`${workEffortId}:${view}:${info?.statusId||'loading'}`}><s-box padding="large"><s-stack direction="block" gap="large">
    {view!=='summary'&&<BackButton loading={busy} disabled={busy} onClick={returnTo}>{backLabel}</BackButton>}
    {!info&&busy&&<s-spinner accessibilityLabel="Loading count summary"/>}
    {navigationError&&<s-banner tone="warning" heading={navigationError}/>}
    {error&&<s-banner tone="critical" heading={error}/>}{decisionProgress&&<s-text>{decisionProgress}</s-text>}
    {!info&&error&&<s-button variant="primary" onClick={()=>run(()=>refresh())}>Try again</s-button>}
    {info&&view==='summary'&&<>
      <s-stack direction="block" gap="base">
        {canManage&&<s-button variant="primary" disabled={busy} onClick={()=>run(reviewApproval)}>Submit for approval</s-button>}
        {info.canStart&&<s-button variant="primary" disabled={busy} onClick={()=>run(startCounting)}>Start count</s-button>}
      </s-stack>
      {completionMessage&&<s-banner tone="success" heading={completionMessage}/>}
      {info.statusId==='CYCLE_CNT_CMPLTD'&&<s-banner tone="success" heading="Sent to HotWax for approval"/>}
      {(info.startDate||info.dueDate)&&<s-text color="subdued">{[info.startDate&&`Starts ${new Date(Number(info.startDate)).toLocaleDateString()}`,info.dueDate&&`Due ${new Date(Number(info.dueDate)).toLocaleDateString()}`].filter(Boolean).join(' · ')}</s-text>}
      <s-section heading="Open sessions"><s-stack direction="block" gap="base">
        {sessionsList}
        {!openSessions.length&&<s-text color="subdued">No open sessions.</s-text>}
        {lockError&&<s-text tone="critical">{lockError}</s-text>}
        <s-stack direction="inline" gap="base">
          {info.canCreateSession&&<s-button disabled={busy} onClick={()=>run(showCreate)}>Add session</s-button>}
          {!!pastSessions.length&&<s-button disabled={busy} onClick={()=>{setSessionPage(0);setView('completed');}}>Session history</s-button>}
        </s-stack>
      </s-stack></s-section>
      {/* Destructive, so kept apart from Submit at the end of the summary. It opens a confirmation view. */}
      {info.canDiscard&&<s-stack direction="inline"><s-button variant="tertiary" tone="critical" disabled={busy} onClick={()=>{setError('');setView('discard');}}>Discard cycle count</s-button></s-stack>}
    </>}
    {info&&view==='discard'&&<>
      <s-text>Discard {info.name} and all of its sessions? The counted quantities will be excluded from approval.</s-text>
      <s-button tone="critical" variant="primary" loading={busy} onClick={()=>run(discardCount)}>Discard cycle count</s-button>
    </>}
    {info&&view==='completed'&&sessionsList}
    {info&&view==='products'&&
      <s-stack direction="block" gap="base">
        {completionMessage&&<s-banner tone="success" heading={completionMessage}/>}
        {progressError&&<s-banner tone="critical" heading={progressError}/>}
        {info.canPreview?<s-stack direction="block" gap="base">
          {progress?<ProductList items={summaryItems} filters={!dynamic} countExtras directed={info.type==='DIRECTED_COUNT'} disabled={busy} memory={listMemory.current} onSelect={showProduct}
            renderViewActions={tab=>canManage&&((tab==='uncounted'&&zeroItems.length>0)?<s-stack direction="block" gap="small">
              <s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>{setSelected(new Set());setCompletionMessage('');setView('zero');}}>Mark as out of stock</s-button>
              {!progress.allSubmitted&&<s-text color="subdued">Submit all sessions before marking remaining products as out of stock.</s-text>}
            </s-stack>:tab==='undirected'&&extras.length>0&&<s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>{setSelected(new Set());setCompletionMessage('');setView('extras');}}>Select products to discard</s-button>)}/>:<s-text color="subdued">{progressBusy?'Loading products…':'Products could not be loaded.'}</s-text>}
          <s-button disabled={busy||progressBusy} onClick={loadProducts}>{progressError?'Retry products':'Refresh products'}</s-button>
        </s-stack>:<s-text color="subdued">Product preview is available when the count starts and your account has access.</s-text>}
      </s-stack>}
    {info&&view==='create'&&<>
      <s-section><s-stack direction="block" gap="base">
        <s-text>Use a separate session for each person or area.</s-text>
        {pendingCreate&&<s-text color="subdued">An earlier attempt to start “{pendingCreate.name}” did not finish. Start counting to finish it, or change the name or location to start a different session.</s-text>}
        <s-text-field label="Session name" placeholder="For example, Front display" value={sessionName} disabled={busy} onInput={e=>{name.current=e.currentTarget.value;setSessionName(e.currentTarget.value);}}/>
        {/* POS does not draw a choice list's label, so the heading is visible text. */}
        <s-text type="strong">Session location</s-text><s-choice-list values={[area]} onChange={e=>setArea(e.currentTarget.values[0])}>{info.areas.map(a=><s-choice key={a.id} value={a.id} disabled={busy}>{a.name}</s-choice>)}</s-choice-list>
      </s-stack></s-section>
      <s-button variant="primary" disabled={busy} onClick={()=>run(create)}>Start counting</s-button>
    </>}
    {progress&&['zero','extras'].includes(view)&&<>
      <s-section heading={view==='zero'?'Select uncounted products':'Discard extra products'}><s-stack direction="block" gap="base">
        <s-text>{view==='zero'?'Select products you checked across the store and did not find. Confirming records a count of zero for each selected product.':'Selected products will be excluded from this count’s review.'}</s-text>
        <s-text color="subdued">{selected.size} selected</s-text>
        <s-button disabled={busy} onClick={()=>setSelected(new Set((view==='zero'?zeroItems:extras).map(item=>item.productId)))}>{view==='zero'?'Select all uncounted':'Select all extra products'}</s-button>
        <s-button variant="primary" disabled={busy||!selected.size} onClick={()=>{setDecision(view==='zero'?'confirmZero':'discardUndirected');setView('confirm');}}>Review {selected.size} selected</s-button>
      </s-stack></s-section>
      <ProductList items={view==='zero'?zeroItems:extras} disabled={busy} selected={selected} filters={false} onSelect={toggle}/>
    </>}
    {view==='confirm'&&<>
      <s-section heading={decision==='completeCount'?'Ready for approval':decision==='confirmZero'?'Mark these products as out of stock?':'Discard these extra products?'}><s-stack direction="block" gap="base">
        <s-text>{decision==='completeCount'?`${amount(approval?.products||0,'product')} · ${amount(approval?.units||0,'unit')}`:`${selected.size} products selected. This decision is recorded in HotWax.`}</s-text>
        {decision==='confirmZero'&&<s-text>Each selected product will receive a count of zero and move from Uncounted to Counted.</s-text>}
        <s-text color="subdued">Inventory changes only after approval.</s-text>
        {decision==='completeCount'&&info?.type==='DYNAMIC_COUNT'&&<s-text type="strong">Include all units of each listed product, including back stock.</s-text>}
      </s-stack></s-section>
      <s-button variant="primary" disabled={busy||(decision!=='completeCount'&&!selected.size)} onClick={()=>run(confirm)}>{decision==='completeCount'?'Submit for approval':decision==='confirmZero'?'Confirm out of stock':'Discard selected products'}</s-button>
      {savedDecision&&decision!=='completeCount'&&<s-button disabled={busy} onClick={()=>run(cancelDecision)}>Cancel saved decision</s-button>}
      {decision!=='completeCount'&&<ProductList items={reviewItems} filters={false}/>}
    </>}
    {view==='product'&&product&&<s-section><s-stack direction="block" gap="base">
      <s-text>{product.sku} · {product.quantity==null?'Not counted':`${product.quantity} counted in total`}</s-text>
      {product.onHand!=null&&<s-text color="subdued">On hand {product.onHand} · Difference {product.delta??'—'}</s-text>}
      <s-text type="strong">Session contributions</s-text>
      <DividedRows>{contributions?.slice(page*20,(page+1)*20).map(session=><ActionRow key={session.sessionId} title={session.name||session.sessionId} detail={`${session.operator} · ${countStatus(session)}`} meta={session.quantity==null?'Uncounted':String(session.quantity)} disabled={busy} onClick={()=>{setContribution(session);setContributionQuantity(session.quantity==null?'':String(session.quantity));setView('editContribution');}}/>)}</DividedRows>
      {contributions?.length===0&&<s-text color="subdued">No session has counted this product yet.</s-text>}
      {!contributions&&(busy?<s-text color="subdued">Loading session contributions…</s-text>:<s-button onClick={()=>showProduct(product)}>Retry contributions</s-button>)}
      {contributions&&<CompactPager page={page} pages={Math.max(1,Math.ceil(contributions.length/20))} total={contributions.length} onPage={setPage} label="sessions"/>}
    </s-stack></s-section>}
    {view==='editContribution'&&contribution&&<>
      <s-section><s-stack direction="block" gap="base">
        <s-text type="strong">{product.title||product.sku}</s-text>
        <s-text>{contribution.name||contribution.sessionId} · {contribution.operator}</s-text>
        <s-text color="subdued">{countStatus(contribution)}</s-text>
        {canEditContribution?<>
          <s-number-field label="Total in this session" value={contributionQuantity} min={0} max={1000000} disabled={busy} onInput={e=>setContributionQuantity(e.currentTarget.value)}/>
          <s-text color="subdued">Team total after this change: {(product.quantity||0)-(contribution.quantity||0)+(Number(contributionQuantity)||0)}</s-text>
        </>:<>
          <s-text type="strong">{contribution.quantity==null?'Not counted in this session':`${contribution.quantity} counted in this session`}</s-text>
          <s-text color="subdued">{info.statusId!=='CYCLE_CNT_IN_PRGS'?'This count is no longer open for changes.':!info.canComplete?'Your account can view this contribution. A count manager can change it.':'This session is no longer open for changes.'}</s-text>
        </>}
      </s-stack></s-section>
      {canEditContribution&&<s-button variant="primary" loading={busy} disabled={busy} onClick={()=>run(async()=>{
        if(!canEditContribution)throw new Error('This contribution is no longer editable.');
        if(contributionQuantity==='')throw new Error('Enter a total quantity.');
        await request('editContribution',{workEffortId,sessionId:contribution.sessionId,productId:product.productId,quantity:Number(contributionQuantity),expectedQuantity:contribution.quantity});
        const updated=await request('progress',{workEffortId});setInfo(updated);setProgress(updated);setProduct(updated.items.find(i=>i.productId===product.productId));
        const result=await request('contributions',{workEffortId,productId:product.productId});setContributions(result.items);setView('product');
      })}>Save contribution</s-button>}
      <s-button disabled={busy} onClick={()=>openSession(contribution.sessionId,contribution.name)}>View session</s-button>
    </>}
  </s-stack></s-box></s-scroll-box>;
}
