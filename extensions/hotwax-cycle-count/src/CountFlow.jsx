import {useEffect,useMemo,useRef,useState} from 'preact/hooks';
import {countStatus,countTypeName,workStatus} from './count-api';
import {ProductList,CompactPager} from './ProductList.jsx';
import {ActionRow,BackButton,amount} from './FlowParts.jsx';
const operationId=()=>Array.from({length:15},()=>Math.floor(Math.random()*16).toString(16)).join('');

export function CountFlow({workEffortId,openSession,back,storage,owner,request,setHeader}) {
  const [info,setInfo]=useState(null),[progress,setProgress]=useState(null),[view,setView]=useState('summary');
  const [error,setError]=useState(''),[busy,setBusy]=useState(true),[area,setArea]=useState('register'),[page,setPage]=useState(0);
  const [selected,setSelected]=useState(new Set()),[decision,setDecision]=useState(''),[product,setProduct]=useState(null),[contributions,setContributions]=useState(null);
  const [contribution,setContribution]=useState(null),[contributionQuantity,setContributionQuantity]=useState(''),[decisionProgress,setDecisionProgress]=useState('');
  const [completionMessage,setCompletionMessage]=useState('');
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
      if(active.current&&sequence===progressRequest.current){setInfo(result);setProgress(result);}
    } catch(failure) {
      if(active.current&&sequence===progressRequest.current)setProgressError(failure instanceof Error?failure.message:'Could not load the product summary.');
    } finally {if(active.current&&sequence===progressRequest.current)setProgressBusy(false);}
  }
  async function refresh(withProducts=false) {
    if(withProducts){await loadProducts();return;}
    const result=await request('overview',{workEffortId});
    if(!active.current)return;
    setInfo(result);
    setLockRefresh(value=>value+1);
    // The overview unlocks session navigation before large product scopes finish.
    if(result.canPreview)void loadProducts();
    else {progressRequest.current++;setProgress(null);setProgressBusy(false);setProgressError('');}
  }
  useEffect(()=>{active.current=true;run(async()=>{await refresh();const pending=await storage.get(`hotwax-count:${owner}:decision:${workEffortId}`);if(pending&&active.current){setSelected(new Set(pending.productIds));setDecision(pending.action);setView('confirm');}});return()=>{active.current=false;progressRequest.current++;};},[workEffortId]);
  const lockIds=info?.statusId==='CYCLE_CNT_IN_PRGS'?info.sessions.slice(sessionPage*20,(sessionPage+1)*20).filter(session=>['SESSION_CREATED','SESSION_ASSIGNED'].includes(session.statusId)).map(session=>session.sessionId).join(','):'';
  useEffect(()=>{
    let stopped=false,timer=0;
    setLocks({});setLockError('');
    if(view!=='summary'||!lockIds)return;
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
    if(lock.available||(lock.expiresAt!=null&&lock.expiresAt<=Date.now()))return {notice:'No active lock',noticeTone:'neutral'};
    return {notice:lock.owned?'Locked to this terminal':`Locked by ${lock.operator||'another user'}${lock.deviceId?` · ${lock.deviceId}`:''}`,noticeTone:lock.owned?'success':'critical'};
  }
  const heading=({summary:info?.name||'Count summary',create:'Start a new session',product:product?.title||product?.sku||'Product details',editContribution:'Session contribution',zero:'Mark as out of stock',extras:'Extra products',confirm:decision==='completeCount'?'Send count for approval':'Review selected products'})[view];
  useEffect(()=>{setHeader?.({heading,subheading:view==='summary'?'Count summary':info?.name||'Count summary'});},[heading,view,info?.name,setHeader]);
  async function create() {
    const key=`hotwax-count:${owner}:create-session:${workEffortId}`;
    let pending=await storage.get(key);
    if(!pending){pending={workEffortId,operationId:operationId(),name:name.current.trim(),area};if(!pending.name)throw new Error('Enter a session name.');await storage.set(key,pending);}
    for(let attempt=0;attempt<6;attempt++) {
      const result=await request('createSession',pending);
      if(!result.preparing){await storage.delete(key);if(active.current)await openSession(result.session.sessionId,result.session);return;}
      setError(`Preparing your list · ${result.remaining} products remaining.`);
    }
    throw new Error('Your session is saved. Choose Start counting again to finish loading its product list.');
  }
  async function confirm() {
    if(decision==='completeCount'){await request(decision,{workEffortId});await refresh(true);setView('summary');return;}
    const key=`hotwax-count:${owner}:decision:${workEffortId}`;
    let pending=await storage.get(key);
    if(!pending){pending={action:decision,workEffortId,operationId:operationId(),productIds:[...selected]};await storage.set(key,pending);}
    if(pending.action!==decision||[...pending.productIds].sort().join(',')!==[...selected].sort().join(','))throw new Error('Finish the saved decision with the same products before making another.');
    const batches=Math.ceil(pending.productIds.length/25);
    pending.completed=pending.completed||0;
    for(let index=pending.completed;index<batches;index++){
      setDecisionProgress(`Saving batch ${index+1} of ${batches}`);
      const batchId=pending.operationId.slice(0,10)+index.toString(16).padStart(5,'0');
      // Zero-count session identity belongs to the whole confirmation, including retries.
      await request(pending.action,{...pending,operationId:pending.action==='confirmZero'?pending.operationId:batchId,productIds:pending.productIds.slice(index*25,(index+1)*25)});
      pending.completed=index+1;await storage.set(key,pending);
    }
    await storage.delete(key);setDecisionProgress('');await refresh(true);
    setCompletionMessage(decision==='confirmZero'?`${amount(selected.size,'product')} marked as out of stock. Zero quantities have been recorded.`:`${amount(selected.size,'extra product')} discarded.`);
    setSelected(new Set());setView('summary');
  }
  async function showProduct(item) {
    setProduct(item);setContributions(null);setPage(0);setView('product');
    await run(async()=>{const result=await request('contributions',{workEffortId,productId:item.productId});if(active.current)setContributions(result.items);});
  }
  function toggle(item) {setSelected(old=>{const next=new Set(old);if(next.has(item.productId))next.delete(item.productId);else next.add(item.productId);return next;});}
  const canManage=info?.canComplete&&info.statusId==='CYCLE_CNT_IN_PRGS';
  const canEditContribution=canManage&&contribution?.editable;
  const zeroItems=progress?.items.filter(item=>item.isRequested&&item.quantity===null)||[];
  const extras=progress?.items.filter(item=>!item.isRequested&&item.quantity!==null&&item.decision!=='SKIPPED')||[];
  const reviewItems=useMemo(()=>progress?.items.filter(item=>selected.has(item.productId))||[],[progress,selected]);
  const summaryItems=useMemo(()=>progress?.items.filter(item=>item.decision!=='SKIPPED')||[],[progress]);
  const countedProducts=summaryItems.filter(item=>item.quantity!=null).length;
  const countingSessions=info?.sessions.filter(session=>['SESSION_CREATED','SESSION_ASSIGNED'].includes(session.statusId)).length||0;
  const returnTo=()=>{setError('');setView(view==='editContribution'?'product':view==='confirm'&&decision!=='completeCount'?(decision==='confirmZero'?'zero':'extras'):'summary');};
  const backLabel=view==='summary'?'All counts':view==='editContribution'?'Product details':view==='confirm'&&decision!=='completeCount'?(decision==='confirmZero'?'Uncounted products':'Extra products'):'Count summary';
  return <s-scroll-box key={`${workEffortId}:${view}`}><s-box padding="large"><s-stack direction="block" gap="large">
    <BackButton loading={busy} disabled={busy} onClick={view==='summary'?back:returnTo}>{backLabel}</BackButton>
    <s-heading>{heading}</s-heading>
    {error&&<s-banner tone="critical" heading={error}/>}{decisionProgress&&<s-text>{decisionProgress}</s-text>}
    {!info&&error&&<s-button variant="primary" onClick={()=>run(()=>refresh())}>Try again</s-button>}
    {info&&view==='summary'&&<>
      {completionMessage&&<s-banner tone="success" heading={completionMessage}/>}
      <s-stack direction="block" gap="small">
        <s-text color="subdued">{countTypeName(info.type)} · {workStatus(info.statusId)}</s-text>
        {(info.startDate||info.dueDate)&&<s-text color="subdued">{[info.startDate&&`Starts ${new Date(Number(info.startDate)).toLocaleDateString()}`,info.dueDate&&`Due ${new Date(Number(info.dueDate)).toLocaleDateString()}`].filter(Boolean).join(' · ')}</s-text>}
        {info.canStart&&<s-button variant="primary" disabled={busy} onClick={()=>run(async()=>{setInfo(await request('startCount',{workEffortId}));await refresh();})}>Start this count</s-button>}
        {info.type==='DYNAMIC_COUNT'&&<s-text color="subdued">Your scans define the product list. Count every unit of those products across the store, including back stock.</s-text>}
      </s-stack>
      {info.canPreview&&<s-section heading="Progress"><s-box slot="secondary-actions" inlineSize="24px" blockSize="24px">{progressBusy&&<s-spinner accessibilityLabel="Updating count progress"/>}</s-box><s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="large" justifyContent="space-between">
          <s-stack direction="block" gap="small"><s-heading>{progress?countedProducts:'—'}</s-heading><s-text color="subdued">Products counted</s-text></s-stack>
          <s-stack direction="block" gap="small"><s-heading>{progress?progress.uncounted:'—'}</s-heading><s-text color="subdued">Uncounted</s-text></s-stack>
          <s-stack direction="block" gap="small"><s-heading>{progress?summaryItems.reduce((units,item)=>units+(item.quantity??0),0):'—'}</s-heading><s-text color="subdued">Units counted</s-text></s-stack>
        </s-stack>
      </s-stack></s-section>}
      {info.statusId==='CYCLE_CNT_CMPLTD'&&<s-banner tone="success" heading="Sent to HotWax for approval"/>}
      <s-section><s-stack direction="block" gap="base">
        {info.canCreateSession&&<s-button variant="primary" disabled={busy} onClick={()=>setView('create')}>Start a new session</s-button>}
        <s-heading>Sessions · {countingSessions} still counting</s-heading>
        <s-stack direction="block" gap="none">
          {!info.sessions.length&&<s-text color="subdued">No sessions yet. Start a new session.</s-text>}
          {info.sessions.slice(sessionPage*20,(sessionPage+1)*20).map(session=><ActionRow key={session.sessionId} title={session.name||session.sessionId}
            detail={`${info.areas.find(a=>a.id===session.area)?.name||session.area} · ${session.mine?'You':session.operator}`}
            {...lockStatus(session.sessionId)}
            meta={countStatus(session)} metaTone={session.statusId==='SESSION_SUBMITTED'||session.statusId==='SESSION_APPROVED'?'success':session.statusId==='SESSION_ASSIGNED'?'warning':'neutral'} disabled={busy} onClick={()=>openSession(session.sessionId,undefined,session.name)}/>)}
          <CompactPager page={sessionPage} pages={Math.max(1,Math.ceil(info.sessions.length/20))} total={info.sessions.length} label="sessions" onPage={setSessionPage} disabled={busy}/>
        </s-stack>
        {lockError&&<s-text tone="critical">{lockError}</s-text>}
      </s-stack></s-section>
      {canManage&&progress&&<s-section heading="Send for review"><s-stack direction="block" gap="base">
        <s-text color="subdued">{progress.openSessions?`Submit ${amount(progress.openSessions,'open session')} before sending this count for approval.`:progress.canFinish?'All sessions are submitted and every required product has been checked.':!info.sessions.length?'Start a session and count your products first.':'Check the remaining products before sending this count for approval.'}</s-text>
        <s-button variant={progress.canFinish?'primary':'secondary'} disabled={busy||progressBusy||!!progressError||!progress.canFinish} onClick={()=>{setDecision('completeCount');setView('confirm');}}>Send count for approval</s-button>
      </s-stack></s-section>}
      <s-section heading="Products">
        {progressError&&<s-banner tone="critical" heading={progressError}/>}
        {info.canPreview?<s-stack direction="block" gap="base">
          {progress?<ProductList items={summaryItems} countExtras directed={info.type==='DIRECTED_COUNT'} disabled={busy} memory={listMemory.current} onSelect={showProduct}
            renderViewActions={tab=>canManage&&((tab==='uncounted'&&zeroItems.length>0)?<s-stack direction="block" gap="small">
              <s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>{setSelected(new Set());setCompletionMessage('');setView('zero');}}>Mark as out of stock</s-button>
              {!progress.allSubmitted&&<s-text color="subdued">Submit all sessions before marking remaining products as out of stock.</s-text>}
            </s-stack>:tab==='undirected'&&extras.length>0&&<s-button disabled={busy||progressBusy||!progress.allSubmitted} onClick={()=>{setSelected(new Set());setCompletionMessage('');setView('extras');}}>Select products to discard</s-button>)}/>:<s-text color="subdued">{progressBusy?'Loading products…':'Products could not be loaded.'}</s-text>}
          <s-button disabled={busy||progressBusy} onClick={()=>run(()=>refresh())}>{progressError?'Retry product summary':'Refresh summary'}</s-button>
        </s-stack>:<s-text color="subdued">Product preview is available when the count starts and your account has access.</s-text>}
      </s-section>
    </>}
    {info&&view==='create'&&<>
      <s-section><s-stack direction="block" gap="base">
        <s-text>Each person counts in a separate session. HotWax adds the sessions together.</s-text>
        <s-text-field label="Session name" placeholder="For example, Front display" disabled={busy} onInput={e=>{name.current=e.currentTarget.value;}}/>
        <s-text type="strong">Session location</s-text><s-choice-list values={[area]} onChange={e=>setArea(e.currentTarget.values[0])}>{info.areas.map(a=><s-choice key={a.id} value={a.id} disabled={busy}>{a.name}</s-choice>)}</s-choice-list>
        {info.type==='DIRECTED_COUNT'&&<s-text color="subdued">Your requested product list loads automatically.</s-text>}
        {info.type==='DYNAMIC_COUNT'&&<s-text color="subdued">Start with an empty list and count products in this session. HotWax adds your quantities to the other sessions for the same products.</s-text>}
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
      <s-section heading={decision==='completeCount'?'Send the whole count for approval?':decision==='confirmZero'?'Mark these products as out of stock?':'Discard these extra products?'}><s-stack direction="block" gap="base">
        <s-text>{decision==='completeCount'?'All sessions are submitted and every required product has been checked. HotWax will receive the combined count for approval.':`${selected.size} products selected. This decision is recorded in HotWax.`}</s-text>
        {decision==='confirmZero'&&<s-text>Each selected product will receive a count of zero and move from Uncounted to Counted.</s-text>}
        <s-text color="subdued">Inventory changes are applied only after approval in HotWax.</s-text>
        {decision==='completeCount'&&info?.type==='DYNAMIC_COUNT'&&<s-text type="strong">Confirm that these totals include every unit of each listed product in the store, including the sales floor and back stock. Products outside this list will be left unchanged.</s-text>}
      </s-stack></s-section>
      <s-button variant="primary" disabled={busy||(decision!=='completeCount'&&!selected.size)} onClick={()=>run(confirm)}>{decision==='completeCount'?'Send for approval':decision==='confirmZero'?'Confirm out of stock':'Discard selected products'}</s-button>
      {decision!=='completeCount'&&<ProductList items={reviewItems} filters={false}/>}
    </>}
    {view==='product'&&product&&<s-section><s-stack direction="block" gap="base">
      <s-text>{product.sku} · {product.quantity==null?'Not counted':`${product.quantity} counted in total`}</s-text>
      {product.onHand!=null&&<s-text color="subdued">On hand {product.onHand} · Difference {product.delta??'—'}</s-text>}
      <s-text type="strong">Session contributions</s-text>
      {contributions?.slice(page*20,(page+1)*20).map(session=><ActionRow key={session.sessionId} title={session.name||session.sessionId} detail={`${session.operator} · ${countStatus(session)}`} meta={session.quantity==null?'Uncounted':String(session.quantity)} disabled={busy} onClick={()=>{setContribution(session);setContributionQuantity(session.quantity==null?'':String(session.quantity));setView('editContribution');}}/>)}
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
      <s-button disabled={busy} onClick={()=>openSession(contribution.sessionId,undefined,contribution.name)}>View session</s-button>
    </>}
  </s-stack></s-box></s-scroll-box>;
}
